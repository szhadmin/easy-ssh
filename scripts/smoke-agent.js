/**
 * 打包产物里的「AI 助手」端到端冒烟脚本（由 EASYSSH_SMOKE_JS 指定）。
 * 会被包进 `return await (<本文件内容>)`，所以必须是一个表达式：不能有前置分号、不能有顶层 import。
 *
 * 走的是渲染层真实的那条路：
 *   面板点击 → store.agentSend → IPC → 主进程 agent.chat → fetch 假 LLM
 *   → SSE 增量 → IPC 事件 → store 累积 → 界面上出现回复
 * 顺带验证「模型配置」弹窗能打开、以及回答里的命令能插进终端。
 *
 * 假 LLM 的地址与 scripts/check-agent-ui.cjs 里的默认端口保持一致。
 */
(async () => {
  const api = window.api
  const store = window.__easyssh.store
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const sshPort = Number(window.__mockPort || 2222)
  const llmBase = `http://127.0.0.1:${Number(window.__fakeLlmPort || 2500)}/v1`
  const KEY = 'sk-ui-smoke-0123456789'
  const AUTO_EXEC_CMD = 'du -xhd1 / | sort -h | tail -20'

  const clickByText = (sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').includes(text))
    if (!el) return false
    el.click()
    return true
  }

  /* ------------------------------------------------- 连上 Mock SSH */

  const saved = await api.connections.save(
    {
      name: 'AI 助手验证',
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
  store.getState().setActive(id)
  for (let i = 0; i < 60; i++) {
    if (store.getState().statuses[id] === 'connected') break
    await sleep(200)
  }
  out.status = store.getState().statuses[id]

  /* ------------------------------- ① 在终端工具栏打开右侧 AI 助手 */

  store.getState().setTab('terminal')
  await sleep(500)
  out.tab = store.getState().tab
  out.agentToggleFound = clickByText('.term-bar .btn', 'AI 助手')
  await sleep(200)
  out.agentPanelExists = !!document.querySelector('.agent-panel')
  out.agentEmbedded = !!document.querySelector('.agent-sidepane .agent-panel')
  await sleep(150)
  const intro = document.querySelector('.agent-intro h3')
  out.introRole = intro ? intro.textContent : null
  out.starterCount = document.querySelectorAll('.agent-starter').length

  /* ------------------------------- ② 「模型配置」弹窗能打开、内容正确 */

  out.settingsClicked = clickByText('.agent-bar .btn', '模型配置')
  await sleep(250)
  const modal = document.querySelector('.modal')
  out.modalOpened = !!modal
  out.modalHasBaseURL = modal ? /Base URL/.test(modal.textContent || '') : false
  out.modalPresetCount = modal ? modal.querySelectorAll('.agent-preset').length : 0
  out.promptPreviewHidden = modal ? !/查看完整系统提示词|收起完整系统提示词/.test(modal.textContent || '') : false
  out.hasGetModelsButton = modal ? [...modal.querySelectorAll('button')].some((b) => (b.textContent || '').includes('获取模型')) : false
  // 关掉它（Modal 监听 window 上的 Escape）
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await sleep(200)
  out.modalClosed = !document.querySelector('.modal')

  /* ------------------------------- ③ 写配置 → 探测 → 一次真实流式对话 */

  const cfgRes = await api.agent.setConfig(
    { baseURL: llmBase, model: 'deepseek-chat', temperature: 0.2, roleId: 'linux' },
    KEY
  )
  out.cfgOk = cfgRes.ok === true
  out.cfgHasKey = cfgRes.ok ? cfgRes.data.hasKey : false
  await store.getState().loadAgentConfig()

  const probe = await api.agent.test({ baseURL: llmBase, model: 'deepseek-chat', apiKey: KEY })
  out.probeOk = probe.ok === true
  out.probeModel = probe.ok ? probe.data.model : null

  await store.getState().agentSend(id, '磁盘快满了，帮我定位')

  // 等流式结束（最多 12 秒）
  let conv = null
  for (let i = 0; i < 120; i++) {
    conv = store.getState().agentConvos[id]
    if (conv && !conv.streaming) break
    await sleep(100)
  }
  conv = store.getState().agentConvos[id]
  const msgs = (conv && conv.messages) || []
  out.msgCount = msgs.length
  out.streamingAfter = conv ? conv.streaming : null
  out.userText = msgs[0] ? msgs[0].content : null
  out.assistantText = msgs[1] ? msgs[1].content : null
  out.assistantError = msgs[1] ? msgs[1].error || null : null
  out.usageTotal = conv && conv.usage ? conv.usage.totalTokens : null

  // 界面上真的渲染出了回复
  await sleep(200)
  out.renderedBubbles = document.querySelectorAll('.agent-bubble').length
  out.renderedCommandBlocks = document.querySelectorAll('.agent-codeblock').length
  out.hasInsertButton = [...document.querySelectorAll('button')].some((b) =>
    (b.textContent || '').includes('插入终端')
  )
  out.hasExecuteButton = [...document.querySelectorAll('button')].some((b) =>
    (b.textContent || '').includes('在终端执行')
  )
  out.hasReasoning = !!document.querySelector('.agent-reasoning')

  /* ------------------------------- ④ 回答里的命令能插进终端 */

  await store.getState().injectTerm(id, 'df -h')
  store.getState().setTab('terminal')
  await sleep(120)
  out.injectText = store.getState().termInject ? store.getState().termInject.text : null
  out.tabAfterInject = store.getState().tab

  // 终端面板挂载后 shell 通道仍然活着（说明插入没有把通道搞坏）
  const term = { bytes: 0 }
  const off = api.term.onData((p) => {
    if (p.termId !== id) return
    term.bytes += (p.data || '').length
  })
  await sleep(900)
  const before = term.bytes
  await api.term.write(id, '\r')
  for (let i = 0; i < 30 && term.bytes === before; i++) await sleep(150)
  out.termAliveAfterInject = term.bytes > before

  // execute=true 仍走同一终端 PTY：验证命令回显/输出可由 TERM_DATA 看到，而非后台 ssh.exec。
  let executedOutput = ''
  const offExec = api.term.onData((p) => {
    if (p.termId === id) executedOutput += p.data || ''
  })
  store.getState().injectTerm(id, 'echo __AI_EXEC_VISIBLE__', true)
  await sleep(1200)
  out.aiExecuteVisible = executedOutput.includes('__AI_EXEC_VISIBLE__')

  // 真正的终端 Agent：模型一轮只请求 df -h，PTY 返回结果后才发起第二轮并产出 final。
  store.getState().setAgentExecutionMode('trusted')
  await store.getState().agentRun(id, '单步 Agent 验证：排查根分区磁盘使用情况')
  for (let i = 0; i < 180; i++) {
    const run = store.getState().agentRuns[id]
    if (run && (run.state === 'done' || run.state === 'error' || run.state === 'aborted')) break
    await sleep(100)
  }
  const run = store.getState().agentRuns[id]
  out.agentRunState = run ? run.state : null
  out.agentRunStepCount = run ? run.steps.length : 0
  out.agentRunFirstCommand = run && run.steps[0] ? run.steps[0].command : null
  out.agentRunFirstOutput = run && run.steps[0] ? run.steps[0].output : null
  out.agentRunConclusion = run ? run.conclusion : null
  out.agentRunVisible = executedOutput.includes('df -h')
  offExec()
  off()

  out.finalStatus = store.getState().statuses[id]
  return out
})()
