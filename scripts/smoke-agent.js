/**
 * 打包产物里的「终端 Agent」端到端冒烟脚本（由 EASYSSH_SMOKE_JS 指定）。
 * 会被包进 `return await (<本文件内容>)`，所以必须是一个表达式：不能有前置分号、不能有顶层 import。
 *
 * 走的是渲染层真实的那条路：
 *   面板点击 → store.agentRun → IPC(agent:run) → 主进程 AI SDK（原生 tool calling）
 *   → EV.AGENT_TOOL_EXEC 反向请求渲染层 → 在**当前可见 PTY** 里注入带哨兵的命令
 *   → 扫描终端流切出输出/退出码 → CH.AGENT_TOOL_RESULT 回灌
 *   → 第二轮模型产出结论 → 时间线渲染
 *
 * 断言重点（对应本轮修的两个问题）：
 *   ① 多轮时间线：跑两轮后 `agentRuns[id]` 必须是长度 2 的数组，第一轮**不能**被第二轮覆盖
 *   ② 结果即时回灌：终端命令一跑完哨兵就打印，整轮耗时应远小于旧的 90 秒假等待
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

  const clickByText = (sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').includes(text))
    if (!el) return false
    el.click()
    return true
  }

  /** 等某一轮跑到终态 */
  const waitRun = async (profileId, runId, timeoutMs = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const r = (store.getState().agentRuns[profileId] || []).find((x) => x.id === runId)
      if (r && (r.state === 'done' || r.state === 'error' || r.state === 'aborted')) return r
      await sleep(100)
    }
    const r = (store.getState().agentRuns[profileId] || []).find((x) => x.id === runId)
    return r || null
  }

  /** 取时间线上最新一轮的 id（agentRun 内部自己生成，外部拿不到） */
  const latestRun = (profileId) => {
    const list = store.getState().agentRuns[profileId] || []
    return list.length ? list[list.length - 1] : null
  }

  /* ------------------------------------------------- 连上 Mock SSH */

  const saved = await api.connections.save(
    {
      name: 'Agent 验证',
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
  out.agentComposerExists = !!document.querySelector('.agent-composer')
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
  out.hasGetModelsButton = modal
    ? [...modal.querySelectorAll('button')].some((b) => (b.textContent || '').includes('获取模型'))
    : false
  // 关掉它（Modal 监听 window 上的 Escape）
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await sleep(200)
  out.modalClosed = !document.querySelector('.modal')

  /* ------------------------------- ③ 写配置 → 探测 */

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

  // 收集终端流，用来验证「Agent 的命令确实跑在用户眼前那个 PTY 里」
  let termStream = ''
  const offTerm = api.term.onData((p) => {
    if (p.termId === id) termStream += p.data || ''
  })

  /* ------------------------------- ④ 第一轮：工具调用 → 结果回灌 → 结论 */

  store.getState().setAgentExecutionMode('trusted')

  const t1 = Date.now()
  await store.getState().agentRun(id, '单步 Agent 验证：排查根分区磁盘使用情况')
  const run1 = latestRun(id)
  out.runId1 = run1 ? run1.id : null
  const done1 = run1 ? await waitRun(id, run1.id) : null
  out.runRound1ElapsedMs = Date.now() - t1

  out.run1State = done1 ? done1.state : null
  out.run1StepCount = done1 ? done1.steps.length : 0
  out.run1FirstIntent = done1 && done1.steps[0] ? done1.steps[0].intent : null
  out.run1FirstCommand = done1 && done1.steps[0] ? done1.steps[0].command : null
  out.run1FirstStatus = done1 && done1.steps[0] ? done1.steps[0].status : null
  out.run1FirstExitCode = done1 && done1.steps[0] ? done1.steps[0].exitCode : null
  out.run1FirstOutput = done1 && done1.steps[0] ? done1.steps[0].output : null
  out.run1Conclusion = done1 ? done1.conclusion : null
  out.run1Error = done1 ? done1.error || null : null
  out.run1StepAnswer = done1 && done1.steps[0] ? done1.steps[0].thinking || null : null

  // Agent 的命令与输出必须出现在当前终端流里（而不是走隐藏 exec）
  out.agentRunVisible = termStream.includes('df -h')

  await sleep(200)
  out.renderedTurns1 = document.querySelectorAll('.agent-turn').length
  out.renderedSteps1 = document.querySelectorAll('.agent-step').length
  out.renderedToolOutputs1 = document.querySelectorAll('.agent-tool-output').length
  out.renderedFinal1 = document.querySelector('.agent-final') ? document.querySelector('.agent-final').textContent : null
  out.renderedErrorText = document.querySelector('.agent-msg-error')
    ? document.querySelector('.agent-msg-error').textContent
    : null

  /* ------------------------------- ⑤ 第二轮：多轮时间线不能被覆盖 */

  const t2 = Date.now()
  await store.getState().agentRun(id, '多轮时间线验证：再看看内存使用')
  const listAfterSecond = store.getState().agentRuns[id] || []
  const run2 = listAfterSecond[listAfterSecond.length - 1]
  out.runId2 = run2 ? run2.id : null
  out.runCountAfterFirstRender = listAfterSecond.length
  const done2 = run2 ? await waitRun(id, run2.id) : null
  out.runRound2ElapsedMs = Date.now() - t2

  out.run2State = done2 ? done2.state : null
  out.run2FirstCommand = done2 && done2.steps[0] ? done2.steps[0].command : null
  out.run2Conclusion = done2 ? done2.conclusion : null

  const finalList = store.getState().agentRuns[id] || []
  out.finalRunCount = finalList.length
  out.firstRunStillThere = finalList.some((r) => r.id === out.runId1)
  out.firstRunStillDone = finalList.some((r) => r.id === out.runId1 && r.state === 'done')
  out.firstRunConclusionIntact = finalList.some((r) => r.id === out.runId1 && /87%/.test(r.conclusion || ''))

  await sleep(200)
  out.renderedTurns2 = document.querySelectorAll('.agent-turn').length
  out.renderedRunCards2 = document.querySelectorAll('.agent-run-card').length
  out.renderedSteps2 = document.querySelectorAll('.agent-step').length

  /* ------------------------------- ⑥ 时间线可清空 */

  store.getState().agentClear(id)
  await sleep(150)
  out.runsAfterClear = (store.getState().agentRuns[id] || []).length
  out.renderedTurnsAfterClear = document.querySelectorAll('.agent-turn').length

  /* ------------------------------- ⑦ 再跑一轮，让截图里留有真实时间线 */

  await store.getState().agentRun(id, '单步 Agent 验证：排查根分区磁盘使用情况')
  const run3 = latestRun(id)
  const done3 = run3 ? await waitRun(id, run3.id) : null
  out.run3State = done3 ? done3.state : null
  await sleep(250)
  out.renderedTurnsFinal = document.querySelectorAll('.agent-turn').length
  out.renderedRunCardsFinal = document.querySelectorAll('.agent-run-card').length

  /* --------- ⑧ 一步两条命令：必须串行进终端，谁都不能被覆盖 ---------
     模型在同一 step 里一次给出两条命令时，AI SDK 会并发调用 execute。
     终端只有一个、输出扫描器是单槽的，并发注入会让后一条把前一条的扫描器覆盖掉，
     前一条就永远等不到结果（用户看到的「命令跑完了，Agent 一直在等」）。
     这一节验证两条命令都拿到了各自的输出与退出码，且没有超时字样。 */

  const t4 = Date.now()
  await store.getState().agentRun(id, '多命令验证：看看容器和镜像占用')
  const run4 = latestRun(id)
  const done4 = run4 ? await waitRun(id, run4.id, 40000) : null
  out.parElapsedMs = Date.now() - t4
  out.parState = done4 ? done4.state : null

  const parSteps = done4 ? done4.steps : []
  out.parStepCount = parSteps.length
  out.parCommands = parSteps.map((s) => s.command)
  out.parStatuses = parSteps.map((s) => s.status)
  out.parExitCodes = parSteps.map((s) => s.exitCode)
  out.parOutputs = parSteps.map((s) => (s.output || '').slice(0, 60))
  out.parAnyTimeout = parSteps.some((s) => /没有结束|已按超时/.test(s.output || ''))
  out.parConclusion = done4 ? done4.conclusion : null
  out.parTokenDuplicated = parSteps.some((s) => !s.output)
  // 真机 docker 默认带色，回灌前必须剥掉 ANSI
  out.parAnsiStripped = !parSteps.some((s) => /\u001b\[/.test(s.output || ''))
  out.parTerminalSawBoth = termStream.includes('docker ps -a') && termStream.includes('docker system df -v')

  await sleep(250)
  out.renderedTurns4 = document.querySelectorAll('.agent-turn').length
  out.renderedSteps4 = document.querySelectorAll('.agent-step').length

  offTerm()

  out.finalStatus = store.getState().statuses[id]
  return out
})()
