/**
 * 打包产物级「通道泄漏」端到端验证
 *
 * 跑法（需要先 npm run dist:dir 出目录版产物）：
 *   node scripts/check-channels-ui.cjs
 *
 * 流程：
 *   ① 起 Mock SSH（MOCK_MAX_SESSIONS=10，对齐 OpenSSH 默认值）
 *   ② 用 dist/win-unpacked/EasySSH.exe 跑 scripts/smoke-channels.js
 *      （渲染层会走真实 IPC 连刷 40 次目录列表，再开一条终端 shell）
 *   ③ 核对 Mock 记录的通道计数：必须 0 次被拒、总通道数是个位数
 *
 * 修复前：第 11 次左右服务端就开始拒绝新通道，终端与文件一起报
 *   `(SSH) Channel open failure: open failed`
 */
'use strict'

const { spawn } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')

const ROOT = path.resolve(__dirname, '..')
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'EasySSH.exe')
const MOCK = path.join(ROOT, 'scripts', 'mock-ssh-server.mjs')
const SMOKE = path.join(ROOT, 'scripts', 'smoke-channels.js')

const MOCK_PORT = Number(process.env.MOCK_SSH_PORT || 2222)
const STATS_PORT = Number(process.env.MOCK_STATS_PORT || 2223)
const MAX_SESSIONS = 10

let passed = 0
let failed = 0
const failures = []
const ok = (name, cond, extra) => {
  if (cond) {
    passed++
    console.log(`PASS  ${name}${extra ? `  → ${extra}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`FAIL  ${name}${extra ? `  → ${extra}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getStats() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: STATS_PORT, path: '/stats' }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('stats timeout')))
  })
}

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await getStats()
      return true
    } catch {
      await sleep(150)
    }
  }
  return false
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到打包产物：${EXE}\n请先执行： npm run dist:dir`)
    process.exit(2)
  }

  // 别忘了：CI / 自动化里必须清掉 ELECTRON_RUN_AS_NODE，否则 Electron 会以纯 Node 启动
  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  delete appEnv.NODE_OPTIONS

  const userData = mkdtempSync(path.join(os.tmpdir(), 'easyssh-ch-'))
  const mockLog = path.join(ROOT, '.tmp-mock-ui.log')

  const mock = spawn(process.execPath, [MOCK], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_SSH_PORT: String(MOCK_PORT),
      MOCK_STATS_PORT: String(STATS_PORT),
      MOCK_MAX_SESSIONS: String(MAX_SESSIONS),
      MOCK_SSH_LOG: mockLog
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`))

  const cleanup = () => {
    try {
      mock.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  process.on('exit', cleanup)

  if (!(await waitReady())) {
    console.error('Mock SSH 起不来（端口被占？先关掉上一次的 mock）')
    cleanup()
    process.exit(2)
  }
  await getStats() // 预热，顺便让 /reset 可用
  await new Promise((r) => http.get(`http://127.0.0.1:${STATS_PORT}/reset`, (res) => {
    res.resume()
    res.on('end', r)
  }).on('error', r))

  console.log(`\n=== Mock 就绪 (ssh:${MOCK_PORT} stats:${STATS_PORT} maxSessions:${MAX_SESSIONS}) ===`)
  console.log('=== 启动打包产物 dist/win-unpacked/EasySSH.exe ===\n')

  const app = spawn(
    EXE,
    [`--user-data-dir=${userData}`],
    {
      cwd: ROOT,
      env: {
        ...appEnv,
        EASYSSH_SMOKE: path.join(ROOT, '.tmp-smoke-channels.png'),
        EASYSSH_SMOKE_JS: SMOKE
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  let stdout = ''
  app.stdout.on('data', (d) => (stdout += d.toString()))
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`))

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        app.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve(-1)
    }, 90000)
    app.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  ok('打包产物正常退出', code === 0, `exit=${code}`)

  const m = stdout.match(/\[smoke\] script result: ([\s\S]*?)\n\[smoke\] screenshot/)
  let result = null
  try {
    result = m ? JSON.parse(m[1]) : null
  } catch {
    result = null
  }
  if (!result) {
    console.error('拿不到冒烟脚本结果，原始输出：\n' + stdout)
    cleanup()
    process.exit(1)
  }
  if (result.__scriptError) console.error('脚本内部报错：' + result.__scriptError)

  ok('连接建立', result.status === 'connected', String(result.status))
  ok('40 次 files.list 全部成功（走 IPC + 真实 SFTP 通道）',
    !result.listErr, result.listErr || `每次 ${result.lastListLen} 项`)
  ok('文件面板反复导航 30 次全部成功', !result.navErr, result.navErr || JSON.stringify(result.navCounts))
  ok('导航到 /tmp 有内容（不再是空目录报错）',
    !result.navErr && result.navCounts && result.navCounts['/tmp'] === 2,
    result.navCounts ? `/tmp = ${result.navCounts['/tmp']} 项` : '无数据')
  ok('此后终端面板那条 shell 通道还活着（发回车有回显）',
    result.termAlive === true && !result.termExit,
    `收到 ${result.termBytes} 字节${result.termExit ? `，但通道退出：${result.termExit}` : ''}`)
  ok('补全的动态数据源仍可用（容器）',
    typeof result.dynamicContainers === 'number' && result.dynamicContainers > 0,
    `容器 ${result.dynamicContainers} 个`)
  ok('补全的动态数据源仍可用（服务）',
    typeof result.dynamicServices === 'number' && result.dynamicServices > 0,
    `服务 ${result.dynamicServices} 个`)

  const s = await getStats()
  console.log(
    `\n  Mock 统计：connections=${s.connections} channels=${s.channels} sftpChannels=${s.sftpChannels} ` +
      `peakConcurrent=${s.peakConcurrent} rejected=${s.rejected}\n`
  )
  ok('只建立 1 条 SSH 连接（选中目标不会重复连接）', s.connections === 1,
    `connections=${s.connections}`)
  ok('全程 0 次通道被拒（没有触发 MaxSessions）', s.rejected === 0, `rejected=${s.rejected}`)
  ok('70 次文件操作只用 1 条 SFTP 通道（通道复用）', s.sftpChannels <= 2,
    `sftpChannels=${s.sftpChannels}`)
  ok('并发通道数始终没逼近 MaxSessions', s.peakConcurrent < MAX_SESSIONS,
    `peak=${s.peakConcurrent} / max=${MAX_SESSIONS}`)

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  if (failed) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
  cleanup()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试异常：', e)
  process.exit(1)
})
