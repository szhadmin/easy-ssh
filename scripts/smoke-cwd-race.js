/**
 * 在渲染进程里跑的冒烟脚本：复现「目录跟随被 Agent 抢跑打断」。
 *
 * 场景：shell 通道一建立就立刻往终端注入一条命令（这正是 Agent 执行工具调用时的动作
 * —— store.injectTerm -> api.term.write -> 主进程 writeTerminal）。
 *
 * 如果 writeTerminal 把「程序注入」误当成「用户手敲键盘」，ShellIntegration 就会
 * 永久放弃注入 OSC 7 钩子，之后整条会话的 termCwd 都拿不到值，文件面板再也不跟随。
 *
 * 注意：整体会被包进 `return await (<本文件内容>)`，必须是一个「表达式」。
 */
(async () => {
  const api = window.api
  const store = window.__easyssh.store
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const port = Number(window.__mockPort || 2222)

  const saved = await api.connections.save(
    {
      name: 'Mock 服务器',
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
  out.profileId = id

  await store.getState().refreshProfiles()
  store.getState().setActive(id)

  // ★ 关键动作：抢在目录钩子注入之前，往终端写一条命令。
  // 监听器必须在 setTab 之前挂上 —— 终端一挂载就会打开 shell，第一段远端输出
  // 到达即代表 shell 通道已建立，此时立刻注入才能命中「钩子还没装」的窗口（约 700ms）。
  //
  // 注意第三个参数为 true：这正是 Agent 执行工具调用时的写法
  // （store.injectTerm -> applyInject -> writeProgram），表示「程序注入」。
  // 若主进程把它误当成用户手敲键盘，目录钩子就会被放弃、整条会话不再上报目录。
  let injected = false
  let injectedAt = 0
  const off = api.term.onData((p) => {
    if (p.termId !== id || injected) return
    injected = true
    injectedAt = Date.now()
    void api.term.write(id, ' echo RACE\r', true)
  })

  store.getState().setTab('terminal')

  for (let i = 0; i < 60; i++) {
    if (store.getState().statuses[id] === 'connected') break
    await sleep(200)
  }
  out.statusAfterConnect = store.getState().statuses[id]

  for (let i = 0; i < 40; i++) {
    if (injected) break
    await sleep(100)
  }
  out.shellOpened = injected
  out.injectedAt = injectedAt

  // 给钩子足够的窗口：注入状态机最多 6s 兜底 + 一轮重试
  await sleep(9000)

  out.termCwdAfterRace = store.getState().termCwd[id] || ''

  // 再手工 cd 一次，看后续还能不能拿到目录
  await api.term.write(id, ' cd /etc\r')
  await sleep(2000)
  out.termCwdAfterCd = store.getState().termCwd[id] || ''
  out.breadcrumb = [...document.querySelectorAll('.crumb')].map((b) => b.textContent).join('/')

  off()
  out.finalStatus = store.getState().statuses[id]
  return out
})()
