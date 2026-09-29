/**
 * SSH 通道泄漏回归测试（不需要 Electron）
 *
 * 复现的问题：使用几分钟后，终端 / 文件 / Docker 一起报
 *   `(SSH) Channel open failure: open failed`
 *
 * 根因：`Client.sftp()` 每调用一次就新开一条 SSH 通道，而 OpenSSH 的 MaxSessions
 * （默认 10）限制的是「单条连接上同时打开的通道数」。旧代码里 listDir / home /
 * stat / chmod / upload 每次都新开一条且从不关闭，浏览十几个目录就把通道打满，
 * 之后服务端拒绝所有新通道 —— 终端要开 shell 通道、docker 要开 exec 通道，全被拒。
 *
 * 这个脚本把 Mock SSH 的 MaxSessions 也设成 10，然后：
 *   ① 连上后猛刷文件类操作，再开一条终端通道 → 断言全程 0 次被拒
 *   ② 比对 Mock 记录的通道数 → 断言走缓存后总通道数是个位数
 *   ③ 断开 → 断言 Mock 侧并发通道归零（说明没有漏关）
 *   ④ 灵敏度自检：故意用旧写法裸开 12 条通道 → 断言 Mock 确实会拒绝
 *      （证明「0 次被拒」不是因为这个测试压根测不出来）
 *
 * 用法：
 *   npx tsc -p scripts/tsconfig.ssh.json && node scripts/check-channels.cjs
 */
'use strict'

const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.resolve(__dirname, '..')
const COMPILED = path.join(ROOT, '.tmp-ssh-cjs', 'src', 'main', 'ssh-manager.js')
const MOCK = path.join(ROOT, 'scripts', 'mock-ssh-server.mjs')
const NODE = process.execPath

const MOCK_PORT = Number(process.env.MOCK_SSH_PORT || 2222)
const STATS_PORT = Number(process.env.MOCK_STATS_PORT || 2223)
const MAX_SESSIONS = 10

/* --------------------------------------------------------------- 小工具 */

let passed = 0
let failed = 0
const failures = []

function ok(name, cond, extra) {
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

function hit(pathName) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: STATS_PORT, path: pathName }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error(`${pathName} timeout`)))
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

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  if (!existsSync(COMPILED)) {
    console.error(`缺少编译产物：${COMPILED}\n请先执行： npx tsc -p scripts/tsconfig.ssh.json`)
    process.exit(2)
  }

  const mockLog = path.join(ROOT, '.tmp-mock-channels.log')
  const mock = spawn(NODE, [MOCK], {
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
  mock.stdout.on('data', () => {})
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`))

  const cleanup = () => {
    try {
      mock.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  process.on('exit', cleanup)

  const ready = await waitReady()
  if (!ready) {
    console.error('Mock SSH 起不来（端口被占？先关掉上一次的 mock）')
    cleanup()
    process.exit(2)
  }
  await getStats().then(() => {})

  const { SshManager, translateSshError } = require(COMPILED)
  const mgr = new SshManager()

  const exits = []
  mgr.onExit = (e) => exits.push(e)

  const reconnects = []
  mgr.onReconnect = (e) => reconnects.push(e)

  /* ------------------------------------------ ⓪ 报错文案（纯函数，不用连服务器） */

  // 用户看到的 `(SSH) Channel open failure: open failed` 就是 OpenSSH 在
  // MaxSessions 超限时回的 description，必须翻成能看懂、能照做的中文
  const chMsg = translateSshError('(SSH) Channel open failure: open failed', 'h', 22)
  ok('通道打满 → 中文提示含「通道数已达服务器上限」',
    /通道数已达服务器上限/.test(chMsg), chMsg)
  const chMsg2 = translateSshError('(SSH) Channel open failure: ', 'h', 22)
  ok('描述为空的同类报错也能命中', /通道数已达服务器上限/.test(chMsg2), chMsg2)

  const ka = translateSshError('Keepalive timeout', 'h', 22)
  ok('心跳超时不会被误判成普通「连接超时」', /心跳超时/.test(ka), ka)

  const et = translateSshError('connect ETIMEDOUT 10.0.0.1:22', '10.0.0.1', 22)
  ok('ETIMEDOUT → 连接超时', /连接超时/.test(et), et)

  ok('认证失败文案', /认证失败/.test(translateSshError('All configured authentication methods failed', 'h', 22)))
  ok('握手失败文案', /握手失败/.test(translateSshError('Handshake failed', 'h', 22)))
  ok('连接被拒文案', /连接被拒绝/.test(translateSshError('connect ECONNREFUSED 1.2.3.4:22', '1.2.3.4', 22)))
  ok('未知报错原样返回', translateSshError('something odd', 'h', 22) === 'something odd')

  const profile = {
    id: 'chan-test',
    name: '通道回归测试',
    host: '127.0.0.1',
    port: MOCK_PORT,
    username: 'root',
    authType: 'password',
    createdAt: 0,
    updatedAt: 0
  }

  console.log(`\n=== Mock 已就绪 (ssh:${MOCK_PORT} stats:${STATS_PORT} maxSessions:${MAX_SESSIONS}) ===\n`)

  /* ---------------------------------------------------- ① 连接 + 猛刷文件操作 */

  await mgr.connect(profile, { password: 'mock' })
  ok('连接建立', mgr.isConnected(profile.id))

  const home = await mgr.home(profile.id)
  ok('home 解析', home === '/root', home)

  // 旧的写法在这里会新开 40 条 SFTP 通道，第 11 次左右开始报 Channel open failure
  let listErr = null
  let lastCount = -1
  for (let i = 0; i < 40; i++) {
    try {
      const items = await mgr.listDir(profile.id, '/var')
      lastCount = items.length
    } catch (e) {
      listErr = `第 ${i + 1} 次 listDir 失败：${e.message}`
      break
    }
  }
  ok('连续 40 次 listDir 全部成功', listErr === null, listErr || `每次 ${lastCount} 项`)
  ok('/var 内容正确', lastCount === 6, `${lastCount} 项`)

  // 其他会开通道的文件操作，一样刷
  let otherErr = null
  try {
    for (let i = 0; i < 10; i++) {
      await mgr.stat(profile.id, '/root/deploy.sh')
    }
    for (let i = 0; i < 5; i++) {
      await mgr.mkdir(profile.id, '/tmp/chan-a')
      await mgr.mkdirp(profile.id, '/tmp/chan-b/c')
      await mgr.chmod(profile.id, '/root/deploy.sh', 0o755)
      await mgr.rename(profile.id, '/tmp/chan-a', '/tmp/chan-b')
      await mgr.remove(profile.id, '/tmp/chan-b', true, false)
    }
  } catch (e) {
    otherErr = e.message
  }
  ok('50 次 stat/mkdir/chmod/rename/remove 全部成功', otherErr === null, otherErr || '')

  /* ---------------------------------------------------- ② 终端通道还能开（用户看到的现象） */

  exits.length = 0
  mgr.openTerminal({
    termId: `${profile.id}:term`,
    profileId: profile.id,
    kind: 'host',
    cols: 80,
    rows: 24
  })
  await sleep(800)
  const termExit = exits.find((e) => e.termId === `${profile.id}:term`)
  ok('文件操作刷完之后仍能打开终端', !termExit, termExit ? `被拒：${termExit.reason}` : '通道已建立')

  /* ---------------------------------------------------- ③ 通道计数 */

  const s1 = await getStats()
  console.log(
    `\n  Mock 统计：connections=${s1.connections} channels=${s1.channels} sftpChannels=${s1.sftpChannels} ` +
      `peakConcurrent=${s1.peakConcurrent} rejected=${s1.rejected}\n`
  )
  ok('全程 0 次通道被拒', s1.rejected === 0, `rejected=${s1.rejected}`)
  ok('45 次文件操作只用 1 条 SFTP 通道（通道复用）', s1.sftpChannels <= 1,
    `sftpChannels=${s1.sftpChannels}`)
  ok('复用通道：总通道数是个位数', s1.channels <= 8, `channels=${s1.channels}`)
  ok('并发通道数不超过 3', s1.peakConcurrent <= 3, `peak=${s1.peakConcurrent}`)

  /* ---------------------------------------------------- ④ 断开后没有残留通道 */

  mgr.closeTerminal(`${profile.id}:term`)
  await mgr.disconnect(profile.id)
  await sleep(500)
  const s2 = await getStats()
  ok('断开后 Mock 侧并发通道归零（没有漏关）', s2.concurrent === 0, `concurrent=${s2.concurrent}`)

  /* ---------------------------------------------------- ⑤ 灵敏度自检 */

  // 用旧写法（每次 client.sftp() 新开一条且不关）应该能把通道打满。
  // 这保证「0 次被拒」是真的干净，而不是测试没测到。
  await mgr.connect(profile, { password: 'mock' })
  const session = mgr.get(profile.id)
  const raw = []
  for (let i = 0; i < 12; i++) {
    raw.push(
      new Promise((resolve) => {
        session.client.sftp((err, sftp) => resolve({ err, sftp }))
      })
    )
  }
  const results = await Promise.all(raw)
  const rawFail = results.filter((r) => r.err)
  const s3 = await getStats()
  ok('灵敏度自检：旧写法确实会被服务端拒绝', rawFail.length > 0 && s3.rejected > 0,
    `裸开 12 条，被拒 ${rawFail.length} 条（${rawFail[0] ? rawFail[0].err.message : ''}）`)
  ok('被拒时的报错文案与用户看到的一致',
    rawFail.length === 0 || /Channel open failure/.test(rawFail[0].err.message),
    rawFail[0] ? rawFail[0].err.message : '(无)')

  results.forEach((r) => {
    try {
      r.sftp && r.sftp.end()
    } catch {
      /* ignore */
    }
  })
  await mgr.disconnect(profile.id)

  /* ---------------------------------------------------- ⑥ 意外掉线 → 自动重连 */

  reconnects.length = 0
  exits.length = 0
  await mgr.connect(profile, { password: 'mock' })
  const epochBefore = mgr.get(profile.id).epoch

  // 从 Mock 侧把 TCP 连接掐断，模拟「网络抖动 / NAT 空闲回收 / 笔记本休眠唤醒」
  await hit('/kill')
  ok('掐断后立刻变成不可用', !mgr.isConnected(profile.id))

  const deadline = Date.now() + 15000
  let okPhase = null
  while (Date.now() < deadline) {
    okPhase = reconnects.find((e) => e.phase === 'ok')
    if (okPhase) break
    await sleep(200)
  }
  ok('意外掉线后自动重连成功', !!okPhase, okPhase ? `第 ${okPhase.attempt || 0} 次尝试后恢复` : JSON.stringify(reconnects))
  ok('重连后连接可用', mgr.isConnected(profile.id))
  ok('epoch 自增（渲染层据此重开终端）',
    mgr.get(profile.id).epoch > epochBefore,
    `${epochBefore} → ${mgr.get(profile.id).epoch}`)

  // 重连之后文件与终端都要能继续用
  const after = await mgr.listDir(profile.id, '/var')
  ok('重连后文件列表可用', after.length === 6, `${after.length} 项`)
  exits.length = 0
  mgr.openTerminal({
    termId: `${profile.id}:term2`,
    profileId: profile.id,
    kind: 'host',
    cols: 80,
    rows: 24
  })
  await sleep(800)
  const termExit2 = exits.find((e) => e.termId === `${profile.id}:term2`)
  ok('重连后终端可用', !termExit2, termExit2 ? `失败：${termExit2.reason}` : '通道已建立')

  /* ---------------------------------------------------- ⑦ 主动断开不该触发重连 */

  reconnects.length = 0
  await mgr.disconnect(profile.id)
  await sleep(2500)
  ok('主动断开不触发自动重连', reconnects.length === 0,
    reconnects.length ? JSON.stringify(reconnects) : '安静地断开')

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  if (failed) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
  cleanup()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试异常：', e)
  process.exit(1)
})
