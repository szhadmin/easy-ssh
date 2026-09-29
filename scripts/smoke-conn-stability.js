/**
 * 连接稳定性冒烟脚本（由 EASYSSH_SMOKE_JS 指定）。
 *
 * 针对的问题：界面上反复「已连接 → 连接已断开」，看起来像连接不断掉线。
 * 真实原因有两个，这里都验：
 *   ① 握手成功但会话其实不可用（探测全空），却照报「已连接」；
 *   ② 重复连接时旧会话被顶掉，它的 close 事件晚于新连接的成功回包到达，
 *      把刚连上的状态又按回「连接已断开」。
 *
 * 断言：连接后探测数据必须是**真实**的（内核非空、命令数远超内建兜底 31 条）；
 * 已经连着时再点一次「连接」不得产生 CONN_CLOSED / 重连事件，状态必须仍是 connected。
 *
 * 会被包进 `return await (<本文件内容>)`，所以必须是表达式：无前置分号、无顶层 import。
 */
(async () => {
  const api = window.api
  const store = window.__easyssh.store
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const sshPort = Number(window.__mockPort || 2222)
  /** 纯内建兜底表的条数（monitor.ts BUILTIN_COMMANDS）。真连上时命令数一定比它多。 */
  const BUILTIN_ONLY = 31

  // 订阅连接类事件，用来抓「误报断开」
  let closedEvents = 0
  let reconnectEvents = []
  const offClosed = api.files.onClosed(() => {
    closedEvents++
  })
  const offReconnect = api.ssh.onReconnect((p) => {
    reconnectEvents.push(`${p.phase}#${p.attempt}`)
  })

  const saved = await api.connections.save(
    {
      name: '连接稳定性验证',
      host: '127.0.0.1',
      port: sshPort,
      username: 'root',
      authType: 'password',
      group: '验证'
    },
    { password: 'mock' }
  )
  if (!saved.ok) return { fatal: 'save failed: ' + saved.error }
  const id = saved.data.id
  await store.getState().refreshProfiles()

  /* ------------------------------- ① 首次连接：必须是真连上 */

  await store.getState().connect(id)
  for (let i = 0; i < 100; i++) {
    if (store.getState().statuses[id] === 'connected') break
    await sleep(100)
  }
  out.status = store.getState().statuses[id]
  const info = store.getState().infos[id]
  out.infoKernel = info ? info.kernel : null
  out.infoHost = info ? info.hostname : null
  // 可用命令是连接成功后才异步拉的，这里给它一点时间落进 store
  let cmds = store.getState().remoteCommands[id] || []
  for (let i = 0; i < 40 && cmds.length <= BUILTIN_ONLY; i++) {
    await sleep(100)
    cmds = store.getState().remoteCommands[id] || []
  }
  out.commandCount = cmds.length
  out.commandsExceedBuiltin = cmds.length > BUILTIN_ONLY
  // 命中一条只有远端才可能有的命令，证明这批候选确实来自服务器而不是内建兜底表
  out.hasRemoteOnlyCommand = cmds.includes('journalctl') || cmds.includes('systemctl')
  out.closedAfterFirstConnect = closedEvents

  /* ------------------------------- ② 已经连着再点「连接」：不得误报断开 */

  await store.getState().connect(id)
  await sleep(1500)
  out.statusAfterRepeat = store.getState().statuses[id]
  out.closedAfterRepeat = closedEvents
  out.reconnectAfterRepeat = reconnectEvents.slice()

  /* ------------------------------- ③ 顶掉旧会话的路径：仍不得误报断开 */

  // 直接再发一次底层连接请求，模拟「旧会话确实要被替换」的场景
  const raw = await api.ssh.connect(id)
  out.rawConnectOk = raw.ok === true
  await sleep(1200)
  out.statusAfterRaw = store.getState().statuses[id]
  out.closedAfterRaw = closedEvents
  out.reconnectAfterRaw = reconnectEvents.slice()

  /* ------------------------------- ④ 替换后的会话必须仍然能干活 */

  const metrics = store.getState()
  await metrics.pollMetrics(id)
  const m = store.getState().metrics[id]
  out.metricsOk = !!m
  out.memTotalKb = m ? m.memTotalKb : null

  /* ------------------------------- ⑤ 主动断开：状态到位且不报「远端断开」 */

  await store.getState().disconnect(id)
  await sleep(600)
  out.statusAfterDisconnect = store.getState().statuses[id]
  out.closedAfterDisconnect = closedEvents

  const err = store.getState().errors[id]
  out.disconnectErrorText = err || ''

  offClosed()
  offReconnect()
  return out
})()
