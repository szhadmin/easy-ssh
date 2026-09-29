/**
 * 打包产物级「连接稳定性」验证
 *
 * 跑法（需要先出目录版产物）：
 *   node scripts/check-conn-stability.cjs
 *
 * 复现并回归的问题：界面反复「已连接 → 连接已断开」。
 * 关键断言（都会在修复前失败）：
 *   - 连接后的探测数据必须是真实的（内核非空、命令数 > 内建兜底 31 条）
 *   - 已连着时再点连接，不得产生 CONN_CLOSED / 重连事件，状态仍是 connected
 *   - 底层重复连接（替换旧会话）后，也不得误报断开
 *   - 主动断开只反映为用户断开，不应提示「远端关闭了 SSH 会话」
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
const SMOKE = path.join(ROOT, 'scripts', 'smoke-conn-stability.js')

const MOCK_PORT = Number(process.env.MOCK_SSH_PORT || 2222)
const STATS_PORT = Number(process.env.MOCK_STATS_PORT || 2223)

let passed = 0
let failed = 0
const failures = []
const ok = (name, cond, extra) => {
  if (cond) {
    passed++
    console.log(`PASS  ${name}${extra !== undefined ? `  → ${extra}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`FAIL  ${name}${extra !== undefined ? `  → ${extra}` : ''}`)
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

  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  delete appEnv.NODE_OPTIONS

  const userData = mkdtempSync(path.join(os.tmpdir(), 'easyssh-conn-'))

  const mock = spawn(process.execPath, [MOCK], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_SSH_PORT: String(MOCK_PORT),
      MOCK_STATS_PORT: String(STATS_PORT),
      MOCK_MAX_SESSIONS: '10',
      MOCK_SSH_LOG: path.join(ROOT, '.tmp-mock-conn.log')
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

  console.log(`\n=== Mock SSH:${MOCK_PORT} 就绪 ===`)
  console.log('=== 启动打包产物 dist/win-unpacked/EasySSH.exe ===\n')

  const app = spawn(EXE, [`--user-data-dir=${userData}`], {
    cwd: ROOT,
    env: {
      ...appEnv,
      EASYSSH_SMOKE: path.join(ROOT, '.tmp-smoke-conn.png'),
      EASYSSH_SMOKE_JS: SMOKE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

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
    }, 120000)
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
  if (result.fatal) {
    console.error('致命错误：' + result.fatal)
    cleanup()
    process.exit(1)
  }

  /* ------------------------- ① 首次连接必须是「真连上」 */

  ok('首次连接状态为 connected', result.status === 'connected', String(result.status))
  ok('探测到真实内核版本（不是空探测）', !!result.infoKernel, String(result.infoKernel))
  ok('探测到真实主机名', !!result.infoHost && result.infoHost !== 'unknown', String(result.infoHost))
  ok(
    '远端可用命令数超过内建兜底 31 条',
    result.commandsExceedBuiltin === true,
    `${result.commandCount} 条`
  )
  ok('命令候选里含有只有远端才会有的命令', result.hasRemoteOnlyCommand === true, String(result.hasRemoteOnlyCommand))
  ok('首次连接期间没有误报断开', result.closedAfterFirstConnect === 0, `${result.closedAfterFirstConnect} 次`)

  /* ------------------------- ② 已连着再点连接：不得误报断开 */

  ok('重复连接后状态仍是 connected', result.statusAfterRepeat === 'connected', String(result.statusAfterRepeat))
  ok('重复连接没有产生 CONN_CLOSED', result.closedAfterRepeat === 0, `${result.closedAfterRepeat} 次`)
  ok(
    '重复连接没有触发自动重连',
    Array.isArray(result.reconnectAfterRepeat) && result.reconnectAfterRepeat.length === 0,
    JSON.stringify(result.reconnectAfterRepeat)
  )

  /* ------------------------- ③ 替换旧会话（幂等复用）：不得误报断开 */

  ok('底层重复连接调用成功', result.rawConnectOk === true, String(result.rawConnectOk))
  ok('替换路径后状态仍是 connected', result.statusAfterRaw === 'connected', String(result.statusAfterRaw))
  ok('替换路径没有产生 CONN_CLOSED', result.closedAfterRaw === 0, `${result.closedAfterRaw} 次`)
  ok(
    '替换路径没有触发自动重连',
    Array.isArray(result.reconnectAfterRaw) && result.reconnectAfterRaw.length === 0,
    JSON.stringify(result.reconnectAfterRaw)
  )

  /* ------------------------- ④ 替换后的会话仍然可用 */

  ok('连接仍可采集指标', result.metricsOk === true, String(result.metricsOk))
  ok('指标里内存总量非 0（探测真实生效）', Number(result.memTotalKb) > 0, String(result.memTotalKb))

  /* ------------------------- ⑤ 主动断开：不报「远端断开」 */

  ok('主动断开后状态为 disconnected', result.statusAfterDisconnect === 'disconnected', String(result.statusAfterDisconnect))
  ok('主动断开不产生 CONN_CLOSED', result.closedAfterDisconnect === 0, `${result.closedAfterDisconnect} 次`)
  ok(
    '主动断开不提示「远端关闭了 SSH 会话」',
    !/远端关闭/.test(String(result.disconnectErrorText || '')),
    JSON.stringify(result.disconnectErrorText)
  )

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  if (failed) console.log('失败项：\n  - ' + failures.join('\n  - '))
  if (existsSync(path.join(ROOT, '.tmp-smoke-conn.png'))) {
    console.log('截图：.tmp-smoke-conn.png')
  }
  cleanup()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
