/**
 * 打包产物里的「通道泄漏」端到端冒烟脚本（由 EASYSSH_SMOKE_JS 指定）。
 * 会被包进 `return await (<本文件内容>)`，所以必须是一个表达式：不能有前置分号、不能有顶层 import。
 *
 * 复现用户报的现象：用几分钟后，文件 / 终端 / Docker 一起报
 *   `(SSH) Channel open failure: open failed`
 *
 * 这里走的是渲染层「真实的那条路」：window.api.files.list → IPC → 主进程 → ssh2。
 * 连刷 40 次目录列表 + 25 次面板导航，然后**用终端面板自己那条 shell 通道**发一个回车，
 * 看它还活不活 —— 修复前第 11 次左右通道就打满，文件与终端一起报错。
 * 通道计数由外面的 scripts/check-channels-ui.cjs 去 Mock 的统计端口核对。
 */
(async () => {
  const api = window.api
  const store = window.__easyssh.store
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const port = Number(window.__mockPort || 2222)

  /* ------------------------- 先把终端通道的收发订阅上（面板会自己开这条通道） */

  let profileIdRef = ''
  const id0 = () => profileIdRef
  const termData = { n: 0, bytes: 0 }
  let termExit = null
  const offData = api.term.onData((p) => {
    if (p.termId !== id0()) return
    termData.n += 1
    termData.bytes += (p.data || '').length
  })
  const offExit = api.term.onExit((p) => {
    if (p.termId !== id0()) return
    termExit = p.reason || `code=${p.code}`
  })

  /* ---------------------------------------------------- 连上 Mock */

  const saved = await api.connections.save(
    {
      name: '通道泄漏验证',
      host: '127.0.0.1',
      port,
      username: 'root',
      authType: 'password',
      group: '验证'
    },
    { password: 'mock' }
  )
  if (!saved.ok) return { fatal: 'save failed: ' + saved.error }
  const id = saved.data.id
  profileIdRef = id
  out.profileId = id

  await store.getState().refreshProfiles()
  store.getState().setActive(id)
  store.getState().setTab('terminal')
  for (let i = 0; i < 60; i++) {
    if (store.getState().statuses[id] === 'connected') break
    await sleep(200)
  }
  out.status = store.getState().statuses[id]

  /* ---------------------- ① 连刷 40 次目录列表（走完整 IPC + 真实 SFTP 通道） */

  let listErr = null
  let lastLen = -1
  for (let i = 0; i < 40; i++) {
    const r = await api.files.list(id, '/var')
    if (!r.ok) {
      listErr = `第 ${i + 1} 次 files.list 失败：${r.error}`
      break
    }
    lastLen = (r.data || []).length
  }
  out.listRounds = 40
  out.listErr = listErr
  out.lastListLen = lastLen

  /* ---------------------- ② 文件面板反复导航（它就是主要的泄漏来源） */

  let navErr = null
  const navCounts = {}
  try {
    for (const p of ['/var', '/var/log', '/etc', '/root', '/tmp', '/']) {
      for (let i = 0; i < 5; i++) {
        const r = await api.files.list(id, p)
        if (!r.ok) throw new Error(`${p}: ${r.error}`)
        navCounts[p] = (r.data || []).length
      }
    }
  } catch (e) {
    navErr = String(e.message || e)
  }
  out.navErr = navErr
  out.navCounts = navCounts

  /* ---------- ③ 此时终端面板那条 shell 通道还活不活（用户看到的现象就是这个） ---------- */

  const bytesBefore = termData.bytes
  await api.term.write(id, '\r')
  for (let i = 0; i < 30 && termData.bytes === bytesBefore; i++) await sleep(150)
  out.termAlive = termData.bytes > bytesBefore
  out.termBytes = termData.bytes
  out.termExit = termExit
  offData()
  offExit()

  /* ---------------------------------- ④ 补全的动态数据源也还能用 */

  const dyn = await api.complete.dynamic(id, 'container')
  out.dynamicContainers = dyn.ok ? (dyn.data || []).length : `ERR: ${dyn.error}`
  const dynSvc = await api.complete.dynamic(id, 'service')
  out.dynamicServices = dynSvc.ok ? (dynSvc.data || []).length : `ERR: ${dynSvc.error}`

  out.finalStatus = store.getState().statuses[id]
  return out
})()
