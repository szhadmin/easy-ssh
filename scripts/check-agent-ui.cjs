/**
 * 打包产物级「终端 Agent」端到端验证
 *
 * 跑法（需要先 npm run dist:dir 出目录版产物）：
 *   node scripts/check-agent-ui.cjs
 *
 * 链路：渲染层「AI 助手」面板 → store.agentRun → IPC(agent:run)
 *        → 主进程 Vercel AI SDK（原生 tool calling + stopWhen）
 *        → EV.AGENT_TOOL_EXEC 反向请求渲染层 → 注入可见 PTY（纯 ASCII 哨兵）
 *        → 扫描终端流切出输出/退出码 → CH.AGENT_TOOL_RESULT 回灌模型
 *        → 第二轮产出结论 → 时间线累积渲染
 *
 * 断言的重点不是「模型答得好不好」，而是这条链路上每一环都真的通了：
 *   - 标签页 / 面板 / 配置弹窗能渲染，且配置保存后 Key 不回传明文
 *   - 模型用**原生 tool calling**请求命令（tools 字段里出现 run_command）
 *   - 命令确实跑在用户可见的 PTY 里：Mock 的入站日志能看到带哨兵的整行命令
 *   - 哨兵是纯 ASCII 标记（旧 OSC 500 写法已被 readline 吞掉，是本轮修的根因）
 *   - 终端结果一跑完就回灌（整轮耗时远小于旧的 90 秒假等待）
 *   - **多轮时间线**：跑两轮后第一轮的展示必须还在（不再被覆盖）
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
const SMOKE = path.join(ROOT, 'scripts', 'smoke-agent.js')
const MOCK_LOG = path.join(ROOT, '.tmp-mock-agent.log')

const MOCK_PORT = Number(process.env.MOCK_SSH_PORT || 2222)
const STATS_PORT = Number(process.env.MOCK_STATS_PORT || 2223)
const LLM_PORT = Number(process.env.FAKE_LLM_PORT || 2500)

const DF_OUT = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        50G   43G  7G  87% /\n'
const FREE_OUT = '              total        used        free      shared  buff/cache   available\nMem:           3936        1500        2100          12         336        2100\n'
const DF_FINAL = '根分区已使用 87%，建议继续清理 /var/log。'
const FREE_FINAL = '内存充足，可用约 2.1G，暂时不需要处理。'
const DOCKER_FINAL = '容器只有 nginx 一个，镜像占用 187MB，空间不是问题。'
/** 结构化工具轮：模型用 read_file 读配置，期望的本地拼命令 */
const STRUCT_CMD = "head -n 20 -- '/etc/nginx/nginx.conf'"
const STRUCT_FINAL = 'nginx 主配置里 worker_processes 是 auto，client_max_body_size 64m。'
/** 记忆轮：模型用 remember 记下的长期事实 */
const MEM_FACT = '这台机器用 apt 管理软件包，不是 yum'
const MEM_FINAL = '已经记住了：这台机器用 apt 管理软件包。'
/** 主进程应当注册的全部工具（1 个通用 + 7 个结构化 + 1 个记忆） */
const ALL_TOOLS = [
  'run_command',
  'read_file',
  'list_dir',
  'write_file',
  'docker_ps',
  'docker_logs',
  'service_status',
  'process_list',
  'remember'
]

/** 第二个冒烟脚本：验证「关掉应用重开，长期记忆还在」 */
const SMOKE_MEMORY = path.join(ROOT, 'scripts', 'smoke-agent-memory.js')
/** 并行轮里模型一次给出的两条命令（顺序即预期执行顺序） */
const DOCKER_CMDS = ['docker ps -a', 'docker system df -v']

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

/**
 * 假 OpenAI 兼容服务：记录收到的请求，按目标文案回「原生 tool calling」或收尾结论。
 * 第一轮请求命令，收到工具结果（role: 'tool'）后才给最终结论 —— 用来证明
 * 「模型不是一次把方案全吐出来，而是等真实终端证据」。
 */
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
      const messages = Array.isArray(body.messages) ? body.messages : []
      const first = messages[0] || {}
      const last = messages.length ? messages[messages.length - 1] : {}
      const toolMsg = [...messages].reverse().find((m) => m.role === 'tool')
      const lastToolCall = [...messages]
        .reverse()
        .find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length)
      let lastToolCmd = ''
      if (lastToolCall) {
        try {
          lastToolCmd = JSON.parse(lastToolCall.tool_calls[0].function.arguments || '{}').command || ''
        } catch {
          /* ignore */
        }
      }

      const toolDecls = Array.isArray(body.tools) ? body.tools : []
      seen.push({
        auth: req.headers.authorization || '',
        model: body.model,
        stream: body.stream === true,
        temperature: body.temperature,
        toolChoice: body.tool_choice,
        toolNames: toolDecls.map((t) => t.function?.name).filter(Boolean),
        hasSystem: first.role === 'system',
        systemLen: String(first.content || '').length,
        systemHasEnv: /【当前服务器环境】/.test(String(first.content || '')),
        systemHasProtocol: /【终端执行协议】/.test(String(first.content || '')),
        lastUser: last.role === 'user' ? String(last.content || '') : '',
        hasToolResult: !!toolMsg
      })

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: '正常' } }] }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (o) => {
        if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`)
      }
      const text = (t) => send({ choices: [{ index: 0, delta: { content: t } }] })
      const stop = (r) => send({ choices: [{ index: 0, delta: {}, finish_reason: r }] })
      const done = () => {
        if (!res.destroyed && !res.writableEnded) {
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }
      const usage = () =>
        send({
          choices: [{ index: 0, delta: {} }],
          usage: { prompt_tokens: 42, completion_tokens: 33, total_tokens: 75 }
        })
      const toolCall = (id, args, idx = 0, name = 'run_command') =>
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: idx, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
                ]
              }
            }
          ]
        })

      const goal = (() => {
        const u = [...messages].reverse().find((m) => m.role === 'user')
        return typeof u?.content === 'string' ? u.content : ''
      })()

      // 已经拿到工具结果：给最终结论
      if (toolMsg) {
        const lastToolName = lastToolCall ? lastToolCall.tool_calls[0].function.name : ''
        const docker = DOCKER_CMDS.some((c) => lastToolCmd.includes(c))
        const df = !docker && lastToolCmd.includes('df')
        const final =
          lastToolName === 'read_file'
            ? STRUCT_FINAL
            : lastToolName === 'remember'
              ? MEM_FINAL
              : docker
                ? DOCKER_FINAL
                : df
                  ? DF_FINAL
                  : FREE_FINAL
        text(final.slice(0, 10))
        text(final.slice(10))
        stop('stop')
        usage()
        done()
        return
      }

      // 结构化专用工具：模型不手写命令，只给「值」，由本地代码拼安全命令
      if (goal.includes('结构化')) {
        text('我用专用工具读一下 nginx 主配置。')
        toolCall('call_struct', { path: '/etc/nginx/nginx.conf', lines: 20 }, 0, 'read_file')
        stop('tool_calls')
        usage()
        done()
        return
      }

      // 长期记忆：remember 是纯本地写盘，不经过终端
      if (goal.includes('记住')) {
        text('这条信息值得长期记住。')
        toolCall('call_mem', { fact: MEM_FACT }, 0, 'remember')
        stop('tool_calls')
        usage()
        done()
        return
      }

      if (goal.includes('磁盘')) {
        text('我先看一下根分区使用率。')
        toolCall('call_df', { intent: '查看根分区使用率', command: 'df -h' })
        stop('tool_calls')
        usage()
        done()
        return
      }

      if (goal.includes('内存')) {
        text('接着看一下内存余量。')
        toolCall('call_free', { intent: '查看内存占用', command: 'free -m' })
        stop('tool_calls')
        usage()
        done()
        return
      }

      // 同一个 step 里一次给出两条命令 —— AI SDK 会并发调用 execute，
      // 用来验证两条命令在终端里是排队执行的（否则后一条会覆盖前一条的扫描器）
      if (goal.includes('容器')) {
        text('我把两条命令一起发给你。')
        toolCall('call_docker1', { intent: '看容器列表', command: DOCKER_CMDS[0] }, 0)
        toolCall('call_docker2', { intent: '看空间占用', command: DOCKER_CMDS[1] }, 1)
        stop('tool_calls')
        usage()
        done()
        return
      }

      text('看起来没有需要执行的命令。')
      stop('stop')
      usage()
      done()
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

  try {
    rmSync(MOCK_LOG, { force: true })
  } catch {
    /* ignore */
  }

  const mock = spawn(process.execPath, [MOCK], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_SSH_PORT: String(MOCK_PORT),
      MOCK_STATS_PORT: String(STATS_PORT),
      MOCK_MAX_SESSIONS: '10',
      MOCK_SSH_LOG: MOCK_LOG
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

  /**
   * 起一次打包产物，跑一段冒烟脚本，拿回脚本返回值。
   * 长期记忆的「跨会话」验证需要**第二次启动**（同一个 user-data-dir），
   * 所以这里不能只写死在一次 spawn 上。
   */
  const launch = async (smokeScript, pngName, timeoutMs = 150000) => {
    const app = spawn(EXE, [`--user-data-dir=${userData}`], {
      cwd: ROOT,
      env: {
        ...appEnv,
        EASYSSH_SMOKE: path.join(ROOT, pngName),
        EASYSSH_SMOKE_JS: smokeScript
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
      }, timeoutMs)
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
    return { code, result, stdout }
  }

  const run1 = await launch(SMOKE, '.tmp-smoke-agent.png')
  const { code } = run1
  const result = run1.result
  ok('打包产物正常退出', code === 0, `exit=${code}`)
  if (!result) {
    console.error('拿不到冒烟脚本结果，原始输出：\n' + run1.stdout)
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
  ok('AI 面板渲染出来了（嵌在终端右侧）', result.agentPanelExists === true && result.agentEmbedded === true, String(result.agentEmbedded))
  ok('面板带输入框与发送区', result.agentComposerExists === true, 'ok')
  ok('面板标题是当前角色名', !!result.introRole && result.introRole.includes('Linux'), String(result.introRole))
  ok('空状态给出了建议提问', result.starterCount >= 3, `${result.starterCount} 条`)
  ok('「模型配置」弹窗能打开', result.modalOpened === true && result.settingsClicked === true, 'ok')
  ok(
    '弹窗里有 Base URL 字段与供应商预设',
    result.modalHasBaseURL === true && result.modalPresetCount >= 5,
    `预设 ${result.modalPresetCount} 个`
  )
  ok('模型配置提供「获取模型」入口', result.hasGetModelsButton === true, 'ok')
  ok('不再向用户展示内部系统提示词', result.promptPreviewHidden === true, 'ok')
  ok('弹窗能关掉', result.modalClosed === true, 'ok')

  /* ------------------------------- 配置 */

  ok('保存模型配置成功', result.cfgOk === true, 'ok')
  ok('保存后 hasKey 为真（Key 已进本机加密存储）', result.cfgHasKey === true, String(result.cfgHasKey))
  ok('探测连通（地址/Key/模型一次跑通）', result.probeOk === true, String(result.probeModel))

  /* ------------------------------- 第一轮：工具调用 → 回灌 → 结论 */

  ok('第一轮任务收敛到 done', result.run1State === 'done', String(result.run1State))
  ok('第一轮没有报错', !result.run1Error, String(result.run1Error))
  ok('第一轮只有一步工具调用', result.run1StepCount === 1, `${result.run1StepCount} 步`)
  ok('工具入参的 intent 被带进时间线', result.run1FirstIntent === '查看根分区使用率', String(result.run1FirstIntent))
  ok('模型请求的是 df -h', result.run1FirstCommand === 'df -h', String(result.run1FirstCommand))
  ok('该步骤状态为 done', result.run1FirstStatus === 'done', String(result.run1FirstStatus))
  ok('退出码来自真实终端（0）', result.run1FirstExitCode === 0, String(result.run1FirstExitCode))
  ok('终端输出被回灌进时间线', /87%/.test(String(result.run1FirstOutput)), JSON.stringify(String(result.run1FirstOutput)).slice(0, 90))
  ok(
    '工具调用前模型的判断被记为这一步的思考',
    /看一下根分区使用率/.test(String(result.run1StepAnswer)),
    JSON.stringify(String(result.run1StepAnswer)).slice(0, 60)
  )
  ok('拿到终端证据后模型才给结论', result.run1Conclusion === DF_FINAL, JSON.stringify(result.run1Conclusion))
  ok('Agent 命令与输出在当前终端可见', result.agentRunVisible === true, String(result.agentRunVisible))
  ok(
    '结果即时回灌（整轮远快于旧的 90 秒假等待）',
    typeof result.runRound1ElapsedMs === 'number' && result.runRound1ElapsedMs > 0 && result.runRound1ElapsedMs < 30000,
    `${result.runRound1ElapsedMs}ms`
  )

  /* ------------------------------- 渲染 */

  ok('第一轮渲染出 1 个时间线回合', result.renderedTurns1 === 1, `${result.renderedTurns1} 个`)
  ok('渲染出 1 个步骤块', result.renderedSteps1 === 1, `${result.renderedSteps1} 个`)
  ok('步骤里渲染出终端输出区', result.renderedToolOutputs1 === 1, `${result.renderedToolOutputs1} 个`)
  ok('渲染出结论区并含关键数字', /87%/.test(String(result.renderedFinal1)), String(result.renderedFinal1).slice(0, 60))
  ok('界面上没有错误提示', !result.renderedErrorText, String(result.renderedErrorText))

  /* ------------------------------- 第二轮：多轮时间线必须累积 */

  ok('第二轮任务收敛到 done', result.run2State === 'done', String(result.run2State))
  ok('第二轮换了另一条命令', result.run2FirstCommand === 'free -m', String(result.run2FirstCommand))
  ok('第二轮给出了对应结论', result.run2Conclusion === FREE_FINAL, JSON.stringify(result.run2Conclusion))
  ok(
    '⚠️ 多轮时间线：第二轮发出后旧回合没有被删掉',
    result.runCountAfterFirstRender === 2,
    `发出第二轮后时间线长度=${result.runCountAfterFirstRender}`
  )
  ok('跑完两轮后时间线保留 2 轮', result.finalRunCount === 2, `${result.finalRunCount} 轮`)
  ok('第一轮的 id 仍在时间线上', result.firstRunStillThere === true, 'ok')
  ok('第一轮状态仍为 done（没被重置）', result.firstRunStillDone === true, 'ok')
  ok('第一轮的结论正文没被覆盖', result.firstRunConclusionIntact === true, 'ok')
  ok('第二轮 runId 与第一轮不同', !!result.runId2 && result.runId2 !== result.runId1, `${result.runId1} / ${result.runId2}`)
  ok('界面上渲染出 2 个时间线回合', result.renderedTurns2 === 2, `${result.renderedTurns2} 个`)
  ok('界面上渲染出 2 张任务卡', result.renderedRunCards2 === 2, `${result.renderedRunCards2} 张`)
  ok('界面上累计渲染出 2 个步骤块', result.renderedSteps2 === 2, `${result.renderedSteps2} 个`)

  /* ------------------------------- 清空 */

  ok('清空后时间线被移除', result.runsAfterClear === 0, `${result.runsAfterClear} 轮`)
  ok('清空后界面回合也消失', result.renderedTurnsAfterClear === 0, `${result.renderedTurnsAfterClear} 个`)

  /* ------------------------------- 再跑一轮（截图里留有真实时间线） */

  ok('清空后还能继续开新一轮', result.run3State === 'done', String(result.run3State))
  ok('新一轮渲染回 1 个回合', result.renderedTurnsFinal === 1, `${result.renderedTurnsFinal} 个`)
  ok('新一轮渲染出 1 张任务卡', result.renderedRunCardsFinal === 1, `${result.renderedRunCardsFinal} 张`)

  /* ---------------- 一步两条命令：串行进终端，谁都不能被覆盖 ---------------- */

  ok('两条命令的一轮也收敛到 done', result.parState === 'done', String(result.parState))
  ok('两条命令各占一个步骤块', result.parStepCount === 2, `${result.parStepCount} 步`)
  ok(
    '两条命令都按顺序送进了终端',
    JSON.stringify(result.parCommands) === JSON.stringify(DOCKER_CMDS),
    JSON.stringify(result.parCommands)
  )
  ok(
    '两条命令的状态都是 done（没有谁卡在等待结果）',
    Array.isArray(result.parStatuses) && result.parStatuses.every((s) => s === 'done'),
    JSON.stringify(result.parStatuses)
  )
  ok(
    '两条命令各自拿到了真实退出码 0',
    Array.isArray(result.parExitCodes) && result.parExitCodes.every((c) => c === 0),
    JSON.stringify(result.parExitCodes)
  )
  ok('没有哪一条落到超时文案上', result.parAnyTimeout === false, String(result.parAnyTimeout))
  ok(
    '两条命令的输出没有串台（各拿各的）',
    Array.isArray(result.parOutputs) &&
      /CONTAINER ID/.test(String(result.parOutputs[0])) &&
      /Images space usage/.test(String(result.parOutputs[1])),
    JSON.stringify(result.parOutputs).slice(0, 120)
  )
  ok(
    '回灌的输出已剥掉 ANSI 颜色（真机 docker 默认带色）',
    result.parAnsiStripped === true,
    String(result.parAnsiStripped)
  )
  ok('两条命令确实都跑在可见终端里', result.parTerminalSawBoth === true, String(result.parTerminalSawBoth))
  ok('两轮时间线叠加后渲染出 2 个回合', result.renderedTurns4 === 2, `${result.renderedTurns4} 个`)
  ok('渲染出 3 个步骤块（上一轮 1 个 + 本轮 2 个）', result.renderedSteps4 === 3, `${result.renderedSteps4} 个`)
  ok('两条命令的整轮耗时远低于旧的超时等待', result.parElapsedMs < 20000, `${result.parElapsedMs} ms`)
  ok('两条命令之后模型给出了结论', result.parConclusion === DOCKER_FINAL, JSON.stringify(result.parConclusion))

  /* ------------------------------- 结构化专用工具（read_file） */

  ok('结构化工具轮收敛到 done', result.structState === 'done', String(result.structState))
  ok('这一步被标记为 read_file 工具', result.structTool === 'read_file', String(result.structTool))
  ok(
    '命令由本地代码按参数拼出（含 -- 与转义引号）',
    result.structCommand === STRUCT_CMD,
    String(result.structCommand)
  )
  ok('结构化工具的步骤同样跑通了终端（退出码 0）', result.structStatus === 'done' && result.structExitCode === 0, `${result.structStatus}/${result.structExitCode}`)
  ok('只读的结构化工具不带「写操作」危险标记', result.structDanger === false, String(result.structDanger))
  ok('结构化工具的输出被回灌进时间线', /worker_processes/.test(String(result.structOutput)), String(result.structOutput).slice(0, 60))
  ok('结构化工具的命令确实出现在可见终端流里', result.structTerminalSawIt === true, String(result.structTerminalSawIt))
  ok(
    '步骤块上渲染出工具名徽标（用户能看出这不是手写命令）',
    Array.isArray(result.renderedToolBadges5) && result.renderedToolBadges5.includes('read_file'),
    JSON.stringify(result.renderedToolBadges5)
  )
  ok('结构化工具轮也给出了结论', result.structConclusion === STRUCT_FINAL, JSON.stringify(result.structConclusion))

  /* ------------------------------- 跨会话长期记忆（本会话内） */

  ok('记忆轮收敛到 done', result.memState === 'done', String(result.memState))
  ok('remember 不经过终端（这一轮没有任何步骤）', result.memStepCount === 0, `${result.memStepCount} 步`)
  ok('模型记下的事实进了 store.agentMemory', result.memCount >= 1, `${result.memCount} 条`)
  ok(
    '记下的就是模型给的那条事实',
    Array.isArray(result.memTexts) && result.memTexts.includes(MEM_FACT),
    JSON.stringify(result.memTexts)
  )
  ok('remember 写下的来源标为 agent', result.memSource === 'agent', String(result.memSource))
  ok('配置弹窗里渲染出记忆条目', result.memItemsRendered >= 1, `${result.memItemsRendered} 条`)
  ok(
    '记忆区块里能看到具体内容（用户可核对、可删除）',
    /apt/.test(String(result.memSectionText)),
    String(result.memSectionText).slice(0, 60)
  )
  ok('记忆轮也给出了结论', result.memConclusion === MEM_FINAL, JSON.stringify(result.memConclusion))

  /* ------------------------------- 假服务侧收到的请求 */

  const streamReqs = llm.seen.filter((r) => r.stream)
  const probeReqs = llm.seen.filter((r) => !r.stream)
  ok(
    '假 LLM 收到 12 次流式请求（六轮 × 每轮两条：先要动作、再给结论）',
    streamReqs.length === 12,
    `${streamReqs.length} 次`
  )
  ok('假 LLM 收到 1 次探测请求（非流式）', probeReqs.length === 1, `${probeReqs.length} 次`)
  const first = streamReqs[0]
  if (first) {
    ok('请求带上了 Bearer Key', first.auth.startsWith('Bearer sk-ui-smoke'), first.auth.slice(0, 22) + '…')
    ok('请求用的是配置里的模型', first.model === 'deepseek-chat', String(first.model))
    ok('请求第一条是 system 提示词', first.hasSystem === true, `长度 ${first.systemLen}`)
    ok('system 里带上了服务器环境（上下文开关生效）', first.systemHasEnv === true, 'ok')
    ok('system 里带上了终端执行协议（原生工具调用的行为边界）', first.systemHasProtocol === true, 'ok')
    ok('temperature 用的是保存的值', first.temperature === 0.2, String(first.temperature))
    ok('最后一条是用户提问', first.lastUser === '单步 Agent 验证：排查根分区磁盘使用情况', JSON.stringify(first.lastUser))
    ok(
      '用原生 tool calling：声明了全部 9 个工具（1 通用 + 7 结构化 + 1 记忆）',
      ALL_TOOLS.every((t) => first.toolNames.includes(t)),
      JSON.stringify(first.toolNames)
    )
    ok('工具选择交给模型（tool_choice=auto）', first.toolChoice === 'auto', String(first.toolChoice))
    ok('第一轮请求还没带工具结果', first.hasToolResult === false, String(first.hasToolResult))
  }
  const second = streamReqs[1]
  if (second) {
    ok('第二轮请求回来了工具结果（role: tool）', second.hasToolResult === true, String(second.hasToolResult))
  }

  /* ------------------------------- Mock 侧证据：命令真的走了可见 PTY */

  let mockLog = ''
  try {
    mockLog = readFileSync(MOCK_LOG, 'utf8')
  } catch {
    /* ignore */
  }
  ok('Mock 侧收到了带哨兵的整行命令（证明走的是可见 PTY）', /__EASYSSH_AGENT_[A-Z2-9]+_START__/.test(mockLog), 'ok')
  ok('命令被哨兵包住后整体送出（含退出码回填）', /;\s*\}\s*;\s*__easyssh_rc=\$\?/.test(mockLog), 'ok')
  ok('不再使用会被 readline 吞掉的 OSC 500 哨兵', !/EASYSSH_AGENT:[^_]*:START/.test(mockLog), 'ok')
  ok('各轮命令都真的落到了 PTY', /df -h/.test(mockLog) && /free -m/.test(mockLog), 'ok')
  ok(
    '一步里的两条命令也落到了同一个 PTY（且读到了各自的哨兵行）',
    /docker ps -a/.test(mockLog) && /docker system df -v/.test(mockLog),
    'ok'
  )
  ok(
    '结构化工具拼出来的命令也真的落到了 PTY',
    /head -n 20/.test(mockLog) && /\/etc\/nginx\/nginx\.conf/.test(mockLog),
    'ok'
  )

  /* ------------------------------- 跨会话：关掉应用重开，记忆还在 */

  const memFile = path.join(userData, 'data', 'agent-memory.json')
  let memOnDisk = null
  try {
    memOnDisk = JSON.parse(readFileSync(memFile, 'utf8'))
  } catch {
    memOnDisk = null
  }
  ok('记忆已落盘到 agent-memory.json', !!memOnDisk, memFile)
  const diskFacts = (memOnDisk && memOnDisk.profiles && memOnDisk.profiles[result.profileId]) || []
  ok(
    '落盘内容里就是模型记下的那条事实',
    diskFacts.some((f) => f.text === MEM_FACT),
    JSON.stringify(diskFacts.map((f) => f.text))
  )

  // 第二次启动：同一份 user-data-dir、复用同一条连接（profileId 不变）
  const second2 = await launch(SMOKE_MEMORY, '.tmp-smoke-agent-memory.png', 90000)
  ok('第二次启动正常退出', second2.code === 0, `exit=${second2.code}`)
  const r2 = second2.result
  if (!r2) {
    console.error('拿不到第二次启动的结果，原始输出：\n' + second2.stdout)
  } else {
    if (r2.__scriptError) console.error('第二个脚本内部报错：' + r2.__scriptError)
    ok('第二次启动复用了同一条连接（profileId 一致）', r2.reusedProfile === true && r2.profileId === result.profileId, `${r2.profileId} / ${result.profileId}`)
    ok('第二次启动仍能连上 Mock SSH', r2.status === 'connected', String(r2.status))
    ok('主进程能读回上一次的记忆', r2.fromMainOk === true && Array.isArray(r2.fromMain) && r2.fromMain.includes(MEM_FACT), JSON.stringify(r2.fromMain))
    ok('记忆被灌进 store.agentMemory', Array.isArray(r2.inStore) && r2.inStore.includes(MEM_FACT), JSON.stringify(r2.inStore))
    ok('重开后配置弹窗里能看到记忆条目', r2.renderedItems >= 1, `${r2.renderedItems} 条`)
    ok('记忆条目带删除按钮（用户随时能纠正）', r2.renderedDeleteButtons >= 1, `${r2.renderedDeleteButtons} 个`)
    ok('记忆区块标题写着「长期记忆」', r2.sectionLabelFound === true, String(r2.renderedText).slice(0, 50))
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
