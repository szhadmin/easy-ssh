/**
 * 第二个启动会话的冒烟脚本：验证「关掉应用重开，长期记忆还在」。
 *
 * 由 check-agent-ui.cjs 用**同一个 user-data-dir** 再启动一次打包产物后注入。
 * 必须是一个表达式（会被包进 `return await (...)`），不能有前置分号、不能有顶层 import。
 *
 * 关键点：这里刻意**不新建连接**，而是复用上一次启动留下的那条连接配置 ——
 * 长期记忆按 profileId 分组，profileId 是保存连接时生成的，新建就会换一个 id，
 * 那样测的就不是「跨会话」而是「另一台机器」了。
 */
(async () => {
  const api = window.api
  const store = window.__easyssh.store
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const listed = await api.connections.list()
  if (!listed.ok || !listed.data.length) return { fatal: '上一次启动没有留下连接配置' }
  const id = listed.data[0].id
  out.profileId = id
  out.reusedProfile = true

  await store.getState().refreshProfiles()
  store.getState().setActive(id)
  for (let i = 0; i < 60; i++) {
    if (store.getState().statuses[id] === 'connected') break
    await sleep(200)
  }
  out.status = store.getState().statuses[id]

  // ① 直接问主进程（与界面走的是同一条 IPC）：记忆必须从磁盘读回来了
  const fromMain = await api.agent.listMemory(id)
  out.fromMainOk = fromMain.ok === true
  out.fromMain = fromMain.ok ? fromMain.data.map((f) => f.text) : null

  // ② 灌进 store：面板挂载时走的就是这条路
  await store.getState().loadAgentMemory(id)
  await sleep(200)
  out.inStore = (store.getState().agentMemory[id] || []).map((f) => f.text)

  // ③ 真实渲染路径：终端工具栏 → AI 助手 → 模型配置 → 记忆区块里应当看到上次记的事实
  store.getState().setTab('terminal')
  await sleep(400)
  const toggle = [...document.querySelectorAll('.term-bar .btn')].find((x) =>
    (x.textContent || '').includes('AI 助手')
  )
  if (toggle) toggle.click()
  await sleep(300)
  const cfgBtn = [...document.querySelectorAll('.agent-bar .btn')].find((x) =>
    (x.textContent || '').includes('模型配置')
  )
  if (cfgBtn) cfgBtn.click()
  await sleep(400)

  out.renderedItems = document.querySelectorAll('.agent-memory-item').length
  out.renderedDeleteButtons = document.querySelectorAll('.agent-memory-del').length
  const box = document.querySelector('.agent-memory')
  out.renderedText = box ? (box.textContent || '').slice(0, 120) : null
  const label = document.querySelector('.modal')
  out.sectionLabelFound = label ? /长期记忆/.test(label.textContent || '') : false

  return out
})()
