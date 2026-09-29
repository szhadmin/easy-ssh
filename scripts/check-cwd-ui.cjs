/**
 * 打包产物级「目录跟随」端到端验证
 *
 * 跑法（需要先 npm run dist:dir 出目录版产物）：
 *   node scripts/check-cwd-ui.cjs
 *
 * 链路：远端 shell 的提示符钩子上报 OSC 7 -> 主进程 emitData -> 渲染层解析 ->
 *       store.termCwd 更新 -> 文件面板跟着切目录。
 *
 * 两个场景（各起一套 Mock + 打包产物，互不干扰）：
 *   A 正常：连上后静静等钩子注入，再 cd —— 验证基本链路
 *   B 抢跑：shell 一起来就注入一条命令（Agent 执行工具调用的动作），
 *          验证程序注入 **不会** 打断目录钩子的注入
 *
 * B 场景的判据除了 termCwd，还看 Mock 侧日志里有没有 `HOOK installed` ——
 * 那是「钩子真的装上了」最直接的证据。
 */
'use strict'

const { spawn } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')

const ROOT = path.resolve(__dirname, '..')
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'EasySSH.exe')
const MOCK = path.join(ROOT, 'scripts', 'mock-ssh-server.mjs')

const SMOKE_NORMAL = path.join(ROOT, 'scripts', 'smoke-cwd-sync.js')
const SMOKE_RACE = path.join(ROOT, 'scripts', 'smoke-cwd-race.js')

let passed = 0
let failed = 0
const ok = (name, cond, extra) => {
  if (cond) {
    passed++
    console.log(`PASS  ${name}${extra ? `  → ${extra}` : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${extra ? `  → ${extra}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stats(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stats' }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('stats timeout')))
  })
}

async function waitReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stats(port)
      return true
    } catch {
      await sleep(150)
    }
  }
  return false
}

/** 起一套 Mock + 打包产物，跑一个冒烟脚本，返回脚本结果与 Mock 日志 */
async function runScenario({ label, smoke, shot, ports }) {
  const mockPort = ports.mock
  const statsPort = ports.stats
  const userData = mkdtempSync(path.join(os.tmpdir(), 'easyssh-cwd-'))
  const mockLog = path.join(ROOT, `.tmp-mock-cwd-${label}.log`)
  // 日志是追加写的：先清掉上一次的，否则 `HOOK installed` 会串场造成假阳性
  try {
    rmSync(mockLog, { force: true })
  } catch {
    /* ignore */
  }

  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  delete appEnv.NODE_OPTIONS

  const mock = spawn(process.execPath, [MOCK], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_SSH_PORT: String(mockPort),
      MOCK_STATS_PORT: String(statsPort),
      MOCK_SSH_LOG: mockLog
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stderr.on('data', (d) => process.stderr.write(`[mock:${label}] ${d}`))

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

  try {
    if (!(await waitReady(statsPort))) {
      throw new Error(`场景 ${label}：Mock SSH 起不来（端口 ${mockPort} 被占？）`)
    }

    const app = spawn(EXE, [`--user-data-dir=${userData}`], {
      cwd: ROOT,
      env: { ...appEnv, EASYSSH_SMOKE: path.join(ROOT, shot), EASYSSH_SMOKE_JS: smoke },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    app.stdout.on('data', (d) => (stdout += d.toString()))
    app.stderr.on('data', (d) => process.stderr.write(`[app:${label}] ${d}`))

    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          app.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve(-1)
      }, 150000)
      app.on('exit', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })

    const m = stdout.match(/\[smoke\] script result: ([\s\S]*?)\n\[smoke\] screenshot/)
    let result = null
    try {
      result = m ? JSON.parse(m[1]) : null
    } catch {
      result = null
    }
    let log = ''
    try {
      log = readFileSync(mockLog, 'utf8')
    } catch {
      /* 没有日志就当空 */
    }
    return { code, result, log }
  } finally {
    cleanup()
  }
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到打包产物：${EXE}\n请先执行： npm run dist:dir`)
    process.exit(2)
  }

  // `--only=A|B` 只跑单个场景，调试时省一半时间
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toUpperCase()
  const wantA = only !== 'B'
  const wantB = only !== 'A'

  /* ============================ 场景 A：正常跟随 ============================ */

  if (wantA) {
  console.log('\n=== 场景 A：连上后等钩子注入，再 cd ===\n')
  const A = await runScenario({
    label: 'normal',
    smoke: SMOKE_NORMAL,
    shot: '.tmp-smoke-cwd.png',
    ports: { mock: 2222, stats: 2223 }
  })
  if (!A.result) {
    console.error('场景 A 拿不到冒烟脚本结果')
    process.exit(1)
  }
  const a = A.result
  if (a.__scriptError) console.error('场景 A 脚本内部报错：' + a.__scriptError)

  ok('A 连接建立', a.statusAfterConnect === 'connected', String(a.statusAfterConnect))
  ok('A 终端上报的目录被解析进 store（OSC 7 链路通）', !!a.termCwd, JSON.stringify(a.termCwd))
  ok('A cd /var/log/nginx 后 termCwd 更新', a.cwdAfterFirstCd === '/var/log/nginx',
    String(a.cwdAfterFirstCd))
  ok('A 文件面板面包屑跟着切过去',
    typeof a.breadcrumb === 'string' && a.breadcrumb.includes('nginx'), String(a.breadcrumb))
  ok('A 文件面板列出了新目录的内容',
    Array.isArray(a.fileNames) && a.fileNames.length > 0,
    Array.isArray(a.fileNames) ? a.fileNames.join(', ') : '无')
  ok('A 文件面板没有报错横幅', !a.filesPaneError, String(a.filesPaneError || '无'))
  ok('A 再 cd /etc 仍持续跟随', a.cwdAfterSecondCd === '/etc', String(a.cwdAfterSecondCd))
  ok('A 第二次的面包屑同步',
    typeof a.breadcrumb2 === 'string' && a.breadcrumb2.includes('/etc'), String(a.breadcrumb2))
  ok('A 分栏比例可调', a.splitRatio && a.splitRatio.after === 62, JSON.stringify(a.splitRatio))
  ok('A 跟随开关处于开启态', a.followCwd === true, String(a.followCwd))
  ok('A 没有横向溢出', a.dom && a.dom.mainOverflowPx === 0,
    a.dom ? `${a.dom.mainOverflowPx}px` : '无')
  ok('A Mock 侧确认钩子已装上', A.log.includes('HOOK installed'),
    A.log.includes('HOOK installed') ? 'ok' : '日志里没有 HOOK installed')
  }

  /* ==================== 场景 B：shell 一起来就注入命令（Agent 抢跑） ==================== */

  if (wantB) {
  // 端口必须和场景 A 一致：冒烟脚本里连的是 `window.__mockPort || 2222`，
  // 而主进程并不会把自定义端口注入进去。两个场景串行跑，A 的 Mock 已经收掉，不冲突。
  console.log('\n=== 场景 B：shell 一起来就注入命令，验证不打乱钩子注入 ===\n')
  const B = await runScenario({
    label: 'race',
    smoke: SMOKE_RACE,
    shot: '.tmp-smoke-cwd-race.png',
    ports: { mock: 2222, stats: 2223 }
  })
  if (!B.result) {
    console.error('场景 B 拿不到冒烟脚本结果')
    process.exit(1)
  }
  const b = B.result
  if (b.__scriptError) console.error('场景 B 脚本内部报错：' + b.__scriptError)

  ok('B 连接建立', b.statusAfterConnect === 'connected', String(b.statusAfterConnect))
  ok('B shell 通道确实起来后才注入（注入打在真通道上）', b.shellOpened === true,
    String(b.shellOpened))
  ok('B 程序注入不会让钩子被放弃（Mock 里出现 HOOK installed）',
    B.log.includes('HOOK installed'),
    B.log.includes('HOOK installed') ? 'ok' : '日志里没有 HOOK installed —— 钩子被放弃了')
  ok('B 抢跑之后照样能拿到终端目录', !!b.termCwdAfterRace, JSON.stringify(b.termCwdAfterRace))
  ok('B 抢跑后再 cd 依然跟随', b.termCwdAfterCd === '/etc', String(b.termCwdAfterCd))
  ok('B 面包屑同步',
    typeof b.breadcrumb === 'string' && b.breadcrumb.includes('/etc'), String(b.breadcrumb))
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
