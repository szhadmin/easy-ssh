/**
 * 打包产物级「AI 助手」端到端验证
 *
 * 跑法（需要先 npm run dist:dir 出目录版产物）：
 *   node scripts/check-agent-ui.cjs
 *
 * 链路：渲染层「AI 助手」面板 → store.agentSend → IPC(agent:chat)
 *        → 主进程 agent.chat → fetch 假 OpenAI 兼容服务（SSE）
 *        → 事件回传 → store 累积 → 界面渲染出回复与代码块
 *
 * 断言的重点不是「模型答得好不好」，而是这条链路上每一环都真的通了：
 *   - 标签页/面板/配置弹窗能渲染
 *   - 配置保存后 Key 不回传明文、hasKey 为真
 *   - 一次对话后拿到完整正文，且中途是分片到达的（不是一次性整段）
 *   - 假服务侧看到的是 stream:true + 正确的 Authorization
 *   - 回答里的 bash 代码块带出「插入终端」按钮，且插完终端还活着
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
const SMOKE = path.join(ROOT, 'scripts', 'smoke-agent.js')

const MOCK_PORT = Number(process.env.MOCK_SSH_PORT || 2222)
const STATS_PORT = Number(process.env.MOCK_STATS_PORT || 2223)
const LLM_PORT = Number(process.env.FAKE_LLM_PORT || 2500)

const REPLY_HEAD = '先确认占用大头：\n\n'
const REPLY_CMD = 'du -xhd1 / | sort -h | tail -20'
const REPLY_TAIL = '\n\n只统计根分区、按目录深度一层汇总。'
const REPLY = REPLY_HEAD + '```bash\n' + REPLY_CMD + '\n```' + REPLY_TAIL
const REASON = '用户问磁盘占用，先给一条最省事的汇总命令。'

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

/** 假 OpenAI 兼容服务：记录收到的请求，回一段带 bash 代码块的流式回答 */
function startFakeLlm() {
  const seen = []
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    req.on('error', () => {})
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Unknown route' } }))
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* ignore */
      }
      seen.push({
        auth: req.headers.authorization || '',
        model: body.model,
        stream: body.stream === true,
        temperature: body.temperature,
        hasSystem: Array.isArray(body.messages) && body.messages[0] && body.messages[0].role === 'system',
        systemLen: Array.isArray(body.messages) && body.messages[0] ? String(body.messages[0].content || '').length : 0,
        systemHasEnv: Array.isArray(body.messages) && body.messages[0]
          ? /【当前服务器环境】/.test(String(body.messages[0].content || ''))
          : false,
        lastUser: Array.isArray(body.messages) && body.messages.length
          ? String(body.messages[body.messages.length - 1].content || '')
          : ''
      })

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: '正常' } }] }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const chunk = (delta) => send({ choices: [{ index: 0, delta }] })

      const lastUser = Array.isArray(body.messages) && body.messages.length
        ? String(body.messages[body.messages.length - 1].content || '')
        : ''
      // 终端 Agent fixture：第 1 轮只请求 df -h；收到工具结果后才给 final，验证不是批量方案回复。
      if (/终端工具调用结果/.test(lastUser)) {
        chunk({ content: 'STEP: 根据磁盘使用率给出结论\n```final\n根分区已使用 87%，建议继续定位 / 下一级目录；当前没有执行删除或变更操作。\n```' })
      } else if (/单步 Agent 验证/.test(lastUser)) {
        chunk({ content: 'STEP: 先查看根分区使用率\n```bash\ndf -h\n```' })
      } else {
        // 故意切成多片 + 中间夹一段思维链，用来验证渲染层是「增量拼接」而不是整段覆盖
        chunk({ reasoning_content: REASON })
        const parts = [REPLY_HEAD, '```bash\n' + REPLY_CMD + '\n', '```', REPLY_TAIL]
        for (const p of parts) chunk({ content: p })
      }
      send({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 33, total_tokens: 75 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(LLM_PORT, '127.0.0.1', () => resolve({ server, seen }))
  })
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到打包产物：${EXE}\n请先执行： npm run dist:dir`)
    process.exit(2)
  }

  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  delete appEnv.NODE_OPTIONS

  const userData = mkdtempSync(path.join(os.tmpdir(), 'easyssh-agent-ui-'))

  const mock = spawn(process.execPath, [MOCK], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_SSH_PORT: String(MOCK_PORT),
      MOCK_STATS_PORT: String(STATS_PORT),
      MOCK_MAX_SESSIONS: '10',
      MOCK_SSH_LOG: path.join(ROOT, '.tmp-mock-agent.log')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`))

  const llm = await startFakeLlm()

  const cleanup = () => {
    try {
      mock.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    try {
      llm.server.close()
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

  console.log(`\n=== Mock SSH:${MOCK_PORT} 就绪 · 假 LLM:${LLM_PORT} 就绪 ===`)
  console.log('=== 启动打包产物 dist/win-unpacked/EasySSH.exe ===\n')

  const app = spawn(EXE, [`--user-data-dir=${userData}`], {
    cwd: ROOT,
    env: {
      ...appEnv,
      EASYSSH_SMOKE: path.join(ROOT, '.tmp-smoke-agent.png'),
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

  /* ------------------------------- SSH 侧 */

  ok('SSH 连接建立', result.status === 'connected', String(result.status))

  /* ------------------------------- UI 侧 */

  ok('终端标签页正常打开', result.tab === 'terminal', String(result.tab))
  ok('终端工具栏提供 AI 助手入口', result.agentToggleFound === true, String(result.agentToggleFound))
  ok('AI 面板渲染出来了', result.agentPanelExists === true && result.agentEmbedded === true, String(result.agentEmbedded))
  ok('面板标题是当前角色名', !!result.introRole && result.introRole.includes('Linux'), String(result.introRole))
  ok('空状态给出了建议提问', result.starterCount >= 3, `${result.starterCount} 条`)
  ok('「模型配置」弹窗能打开', result.modalOpened === true && result.settingsClicked === true, 'ok')
  ok('弹窗里有 Base URL 字段与供应商预设',
    result.modalHasBaseURL === true && result.modalPresetCount >= 5,
    `预设 ${result.modalPresetCount} 个`)
  ok('模型配置提供「获取模型」入口', result.hasGetModelsButton === true, 'ok')
  ok('不再向用户展示内部系统提示词', result.promptPreviewHidden === true, 'ok')
  ok('弹窗能关掉', result.modalClosed === true, 'ok')

  /* ------------------------------- 配置 */

  ok('保存模型配置成功', result.cfgOk === true, 'ok')
  ok('保存后 hasKey 为真（Key 已进本机加密存储）', result.cfgHasKey === true, String(result.cfgHasKey))
  ok('探测连通（地址/Key/模型一次跑通）', result.probeOk === true, String(result.probeModel))

  /* ------------------------------- 对话 */

  ok('对话最终不是 streaming 状态', result.streamingAfter === false, String(result.streamingAfter))
  ok('本地会话里留下了「提问 + 回答」两条消息', result.msgCount === 2, `${result.msgCount} 条`)
  ok('用户消息原样入列', result.userText === '磁盘快满了，帮我定位', JSON.stringify(result.userText))
  ok('助手正文与上游流式输出完全一致（增量拼接没丢字）',
    result.assistantText === REPLY, JSON.stringify(result.assistantText))
  ok('助手消息没有错误', !result.assistantError, String(result.assistantError))
  ok('usage 被透传到渲染层', result.usageTotal === 75, `total=${result.usageTotal}`)

  /* ------------------------------- 渲染 */

  ok('界面上渲染出 2 条气泡', result.renderedBubbles === 2, `${result.renderedBubbles} 个`)
  ok('bash 代码块被识别成代码块', result.renderedCommandBlocks === 1, `${result.renderedCommandBlocks} 个`)
  ok('代码块带出「插入终端」按钮', result.hasInsertButton === true, 'ok')
  ok('代码块带出「在终端执行」按钮', result.hasExecuteButton === true, 'ok')
  ok('思维链被折叠展示（details）', result.hasReasoning === true, 'ok')

  /* ------------------------------- 插入终端 */

  ok('命令进入了待插入队列', result.injectText === 'df -h', String(result.injectText))
  ok('插入后保持在终端页', result.tabAfterInject === 'terminal', String(result.tabAfterInject))
  ok('插入后 shell 通道仍然活着', result.termAliveAfterInject === true, 'ok')
  ok('AI 执行的命令与输出通过当前终端可见', result.aiExecuteVisible === true, String(result.aiExecuteVisible))
  ok('完全信任模式的终端 Agent 最终收敛', result.agentRunState === 'done', String(result.agentRunState))
  ok('终端 Agent 每轮只执行一条工具调用', result.agentRunStepCount === 1 && result.agentRunFirstCommand === 'df -h', `${result.agentRunStepCount} 条 / ${result.agentRunFirstCommand}`)
  ok('工具调用已收到当前 PTY 的终端输出', /87%/.test(String(result.agentRunFirstOutput)), String(result.agentRunFirstOutput))
  ok('工具结果回传后模型才给最终结论', /根分区已使用 87%/.test(String(result.agentRunConclusion)), String(result.agentRunConclusion))
  ok('Agent 命令与输出在当前终端可见', result.agentRunVisible === true, String(result.agentRunVisible))

  /* ------------------------------- 假服务侧收到的请求 */

  const streamReqs = llm.seen.filter((r) => r.stream)
  const probeReqs = llm.seen.filter((r) => !r.stream)
  ok('假 LLM 收到 3 次流式请求（普通对话 1 次 + 单步 Agent 两轮）', streamReqs.length === 3, `${streamReqs.length} 次`)
  ok('假 LLM 收到 1 次探测请求（非流式）', probeReqs.length === 1, `${probeReqs.length} 次`)
  const first = streamReqs[0]
  if (first) {
    ok('请求带上了 Bearer Key', first.auth.startsWith('Bearer sk-ui-smoke'), first.auth.slice(0, 22) + '…')
    ok('请求用的是配置里的模型', first.model === 'deepseek-chat', String(first.model))
    ok('请求第一条是 system 提示词', first.hasSystem === true, `长度 ${first.systemLen}`)
    ok('system 里带上了服务器环境（上下文开关生效）', first.systemHasEnv === true, 'ok')
    ok('temperature 用的是保存的值', first.temperature === 0.2, String(first.temperature))
    ok('最后一条是用户提问', first.lastUser === '磁盘快满了，帮我定位', JSON.stringify(first.lastUser))
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  if (failed) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
  cleanup()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试异常：', e)
  process.exit(1)
})
