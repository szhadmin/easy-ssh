/**
 * 终端 Agent（agent.ts）回归测试 —— 不需要 Electron 本体，也不需要真实终端。
 *
 * 覆盖三块容易出错、又不好靠肉眼确认的逻辑：
 *   ① 配置存储：Key 必须加密落盘（明文不得出现在 agent.json 里）、
 *      重启后还能解出来、baseURL/model/temperature 的归一化与边界值收敛
 *   ② 探测：一次跑通「地址 / Key / 模型」，并把 401 / 404 这类上游错误
 *      翻译成人话（而不是把 JSON 原文糊到界面上）
 *   ③ Agent 工具调用循环：正文增量、reasoning 单独成流、run_command 的
 *      反向桥（送到渲染层可见终端再回灌）、非法命令本地拦下、用户拒绝、
 *      上游中途报错、用户中止、步数上限收尾
 *
 * 做法：把 agent.ts / agent-bridge.ts 单独编译成 CJS，然后
 *   - 用一个假的 `electron` 模块顶掉 app / safeStorage（后者做可逆的假加密，
 *     这样「落盘的是密文」和「重启能解开」两件事都能真断言）
 *   - 起一个假的 OpenAI 兼容服务，按目标文案切换行为
 *     （纯文本 / 推理 / 工具调用 / 非法命令 / 上游报错 / 慢流 / 无限工具）
 *   - 自己当渲染层：给 agent-bridge 装上 sender，收到工具执行请求后
 *     按用例需要回填「批准 / 拒绝 / 输出 / 退出码」
 *
 * 为什么能直接 require 编译产物：Node 22 起默认支持 require(ESM)，
 * 而 ai / @ai-sdk/openai-compatible 都是 ESM-only 包。
 *
 * 用法：
 *   npx tsc -p scripts/tsconfig.agent.json && node scripts/check-agent.cjs
 */
'use strict'

const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const Module = require('node:module')

const ROOT = path.resolve(__dirname, '..')
const TMP = path.join(ROOT, '.tmp-agent-cjs')
const COMPILED = path.join(TMP, 'src', 'main', 'agent.js')
const BRIDGE = path.join(TMP, 'src', 'main', 'agent-bridge.js')

const GOOD_KEY = 'sk-test-abcdefghijklmnop'
const PORT = Number(process.env.FAKE_LLM_PORT || 2499)
const BASE = `http://127.0.0.1:${PORT}/v1`

/* ------------------------------------------------------------ 假 electron */

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyssh-agent-'))

const fakeElectron = {
  app: {
    getPath: () => userDataDir
  },
  safeStorage: {
    // 假装本机支持 DPAPI：加密就是加个前缀，可逆，便于断言「解开的是原文」
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('FAKEENC:' + s, 'utf8'),
    decryptString: (b) => {
      const s = Buffer.from(b).toString('utf8')
      if (!s.startsWith('FAKEENC:')) throw new Error('不是本模块加密的密文')
      return s.slice(8)
    }
  }
}

/** tsc 不会重写 @shared/* 路径别名，这里按编译产物的真实位置接管 */
const ALIAS = {
  '@shared/agent-roles': path.join(TMP, 'src', 'shared', 'agent-roles.js'),
  '@shared/agent-tools': path.join(TMP, 'src', 'shared', 'agent-tools.js'),
  '@shared/channels': path.join(TMP, 'src', 'shared', 'channels.js'),
  '@shared/types': path.join(TMP, 'src', 'shared', 'types.js')
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron
  if (Object.prototype.hasOwnProperty.call(ALIAS, request)) {
    return origLoad.call(this, ALIAS[request], parent, isMain)
  }
  return origLoad.call(this, request, parent, isMain)
}

/* ---------------------------------------------------------------- 小工具 */

let passed = 0
let failed = 0
const failures = []

function ok(name, cond, extra) {
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

function loadAgent() {
  delete require.cache[require.resolve(COMPILED)]
  return require(COMPILED)
}

/** 等某个事件出现（循环是后台跑的，只能轮询） */
function waitFor(events, pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const hit = events.find(pred)
      if (hit) {
        clearInterval(iv)
        resolve(hit)
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv)
        reject(new Error(`等待事件超时（已收到 ${events.length} 条：${events.map((e) => e.type).join(',') || '空'}）`))
      }
    }, 20)
  })
}

async function waitZero(agent, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (agent.activeCount() === 0) return true
    await sleep(25)
  }
  return false
}

async function expectThrow(fn, label) {
  try {
    await fn()
    return { threw: false, msg: '' }
  } catch (e) {
    return { threw: true, msg: (e && e.message) || String(e) }
  }
}

/* --------------------------------------------------------- 假 OpenAI 服务 */

/** 目标里带这些标记，就切到对应剧本 */
const SCENES = {
  TEXT: '场景:纯文本',
  REASON: '场景:推理',
  TOOL: '场景:工具',
  BAD_CMD: '场景:非法命令',
  BOOM: '场景:上游报错',
  SLOW: '场景:慢流',
  LOOP: '场景:无限工具'
}

function startFakeLlm() {
  const server = http.createServer((req, res) => {
    // 客户端中途 abort 时，后面的 res.write 会打到一个已销毁的 socket 上
    res.on('error', () => {})
    req.on('error', () => {})
    // 标准 OpenAI 兼容模型列表接口
    if (req.method === 'GET' && req.url === '/v1/models') {
      if ((req.headers.authorization || '') !== `Bearer ${GOOD_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'deepseek-chat', owned_by: 'deepseek' },
            { id: 'deepseek-reasoner', owned_by: 'deepseek' },
            { id: 'deepseek-chat', owned_by: 'duplicate' }
          ]
        })
      )
      return
    }
    // 只认这一个对话路径，方便测「Base URL 写错 → 404」
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
      if ((req.headers.authorization || '') !== `Bearer ${GOOD_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }))
        return
      }

      const model = body.model

      // 非流式：给 probe 用
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model,
            choices: [{ message: { role: 'assistant', content: '正常' } }],
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
          })
        )
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (o) => {
        if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`)
      }
      const text = (t) => send({ choices: [{ index: 0, delta: { content: t } }] })
      const reason = (t) => send({ choices: [{ index: 0, delta: { reasoning_content: t } }] })
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
      const toolCall = (id, name, args, idx = 0) =>
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

      const messages = Array.isArray(body.messages) ? body.messages : []
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const goal = typeof lastUser?.content === 'string' ? lastUser.content : ''
      const hasToolMsg = messages.some((m) => m.role === 'tool')

      // 无限工具：不论第几轮都只调工具，用来验证步数上限能收尾
      if (goal.includes(SCENES.LOOP)) {
        toolCall('call_loop', 'run_command', { intent: '再看一眼', command: 'echo step' })
        stop('tool_calls')
        usage()
        done()
        return
      }

      // 并行工具：同一个 step 里一次给出两条命令 —— 真实模型很常这么干。
      // AI SDK 对同一 step 的多个 tool call 是并发调用 execute 的，
      // 这正是「命令明明跑完了 Agent 却一直等结果」的触发条件。
      if (goal.includes(SCENES.PARALLEL)) {
        if (hasToolMsg) {
          text('两条命令的结果都拿到了。')
          stop('stop')
          usage()
          done()
          return
        }
        text('我把两条命令一起发给你。')
        toolCall('call_par1', 'run_command', { intent: '看容器列表', command: 'docker ps -a' }, 0)
        toolCall('call_par2', 'run_command', { intent: '看空间占用', command: 'docker system df -v' }, 1)
        stop('tool_calls')
        usage()
        done()
        return
      }

      // 工具调用：第一轮请求命令；拿到工具结果后给结论
      if (goal.includes(SCENES.TOOL) || goal.includes(SCENES.BAD_CMD)) {
        if (hasToolMsg) {
          reason('终端结果已经拿到了，可以下结论。')
          text('根分区已使用 87%，')
          text('建议继续定位 / 的下一级目录；当前没有执行任何变更。')
          stop('stop')
          usage()
          done()
          return
        }
        text('我先看一下根分区使用率。')
        if (goal.includes(SCENES.BAD_CMD)) {
          toolCall('call_bad', 'run_command', {
            intent: '一次做完两件事',
            command: 'rm -rf /tmp/x && echo hi'
          })
        } else {
          toolCall('call_df', 'run_command', { intent: '查看根分区使用率', command: 'df -h' })
        }
        stop('tool_calls')
        usage()
        done()
        return
      }

      if (goal.includes(SCENES.REASON)) {
        reason('磁盘满一般先看 ')
        reason('inode 和占用大头。')
        text('结论：')
        text('用 du 定位。')
        stop('stop')
        usage()
        done()
        return
      }

      if (goal.includes(SCENES.BOOM)) {
        text('开始了')
        // 上游在流中途塞一个 error 对象（OpenAI 兼容网关常见做法）
        send({ error: { message: '上游模型负载过高' } })
        res.end()
        return
      }

      if (goal.includes(SCENES.SLOW)) {
        text('第一段')
        // 留出足够时间让测试执行 abort；客户端断开后要收掉这个定时器
        const timer = setTimeout(() => {
          text('第二段')
          usage()
          stop('stop')
          done()
        }, 5000)
        res.on('close', () => clearTimeout(timer))
        return
      }

      // 默认：两段正文 + 带 usage 的收尾块 + [DONE]
      reason('用户只是打招呼，直接回即可。')
      text('你好，')
      text('这是一段流式输出。')
      usage()
      stop('stop')
      done()
    })
  })
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)))
}

/* ------------------------------------------------------------------ 用例 */

async function main() {
  if (!fs.existsSync(COMPILED)) {
    console.error(`找不到编译产物：${COMPILED}\n请先执行： npx tsc -p scripts/tsconfig.agent.json`)
    process.exit(2)
  }

  const server = await startFakeLlm()
  console.log(`\n=== 假 OpenAI 服务已就绪：${BASE} ===\n`)

  /* ---------- ① 配置存储 ---------- */

  let agent = loadAgent()
  let cfg = await agent.getConfig()
  ok('首次启动用的是内置默认值', cfg.baseURL.includes('deepseek') && !!cfg.model && !!cfg.roleId, cfg.baseURL)
  ok('首次启动没有 Key', cfg.hasKey === false, `hasKey=${cfg.hasKey}`)

  await agent.setConfig(
    { baseURL: BASE, model: 'deepseek-chat', temperature: 0.7, roleId: 'docker' },
    GOOD_KEY
  )
  cfg = await agent.getConfig()
  ok('保存后 hasKey 为真且 Key 已脱敏', cfg.hasKey && cfg.keyMasked.includes('…'), cfg.keyMasked)
  ok('脱敏串不能泄露完整 Key', !cfg.keyMasked.includes(GOOD_KEY) && cfg.keyMasked.length <= 12, cfg.keyMasked)
  ok('roleId / temperature 已落库', cfg.roleId === 'docker' && cfg.temperature === 0.7, `${cfg.roleId} ${cfg.temperature}`)
  ok('getConfig 的返回值里不含明文 Key', !JSON.stringify(cfg).includes('sk-test'), '已检查')

  await agent.setConfig({ prompts: { docker: '自定义补充规则' } })
  ok('角色改写提示词能落库并读回', (await agent.getConfig()).prompts.docker === '自定义补充规则', 'ok')

  const rawFile = fs.readFileSync(path.join(userDataDir, 'data', 'agent.json'), 'utf8')
  ok('agent.json 里没有明文 Key（落盘的是密文）', !rawFile.includes('sk-test'), `文件 ${rawFile.length} 字节`)
  ok('agent.json 里确实有一份密文', /"apiKeyEnc"\s*:\s*"[A-Za-z0-9+/=]+"/.test(rawFile), 'apiKeyEnc 存在')

  // 温度越界要被夹回合法区间
  await agent.setConfig({ temperature: 9 })
  ok('temperature 超过 2 会被夹回 2', (await agent.getConfig()).temperature === 2, 'clamped')
  await agent.setConfig({ temperature: -3 })
  ok('temperature 小于 0 会被夹回 0', (await agent.getConfig()).temperature === 0, 'clamped')
  await agent.setConfig({ temperature: 0.3, model: 'deepseek-chat' })

  // 模拟重启：清掉模块缓存重新加载，必须还能解开 Key
  agent = loadAgent()
  cfg = await agent.getConfig()
  ok('模拟重启后仍能读回 Key（说明密文可解）', cfg.hasKey === true, `hasKey=${cfg.hasKey}`)

  /* ---------- ② 探测 ---------- */

  const probe = await agent.probe()
  ok('probe 一次跑通地址/Key/模型', probe.ok === true && probe.model === 'deepseek-chat', `${probe.latencyMs}ms`)
  ok('probe 能拿到上游回复片段', probe.sample === '正常', `sample=${JSON.stringify(probe.sample)}`)

  const badKey = await expectThrow(() => agent.probe({ apiKey: 'sk-wrong' }), 'bad key')
  ok(
    'Key 错误被翻译成「无效或已过期」而不是原始 JSON',
    badKey.threw && badKey.msg.includes('无效或已过期') && badKey.msg.includes('Invalid API key'),
    badKey.msg
  )

  const badPath = await expectThrow(
    () => agent.probe({ baseURL: `http://127.0.0.1:${PORT}/wrong-base` }),
    'bad path'
  )
  ok('地址写错被翻译成「接口地址不对」并提示 /v1', badPath.threw && badPath.msg.includes('接口地址不对'), badPath.msg)

  const noProto = await expectThrow(() => agent.probe({ baseURL: 'api.deepseek.com/v1' }), 'no proto')
  ok('Base URL 缺协议头会被拦下', noProto.threw && noProto.msg.includes('http://'), noProto.msg)

  const models = await agent.listModels({ baseURL: BASE, apiKey: GOOD_KEY })
  ok(
    '能从标准 GET /models 获取并去重排序模型列表',
    models.map((m) => m.id).join(',') === 'deepseek-chat,deepseek-reasoner',
    JSON.stringify(models)
  )
  const badModelsKey = await expectThrow(
    () => agent.listModels({ baseURL: BASE, apiKey: 'bad-key' }),
    'models bad key'
  )
  ok('模型列表接口错误会翻译 Key 无效', badModelsKey.threw && badModelsKey.msg.includes('无效或已过期'), badModelsKey.msg)

  /* ---------- ③ Agent 工具调用循环 ---------- */

  // 自己扮演渲染层：接管 agent-bridge 的 sender
  const bridge = require(BRIDGE)
  const execReqs = []
  /** 返回 null 表示这一条不回填，交给用例手动 resolve */
  let autoReply = null
  bridge.setBridgeSender((channel, payload) => {
    if (channel !== 'evt:agent:toolExec') return
    execReqs.push(payload)
    const r = autoReply ? autoReply(payload) : null
    if (r) setImmediate(() => bridge.resolveToolExec(r))
  })

  const approve = (output, exitCode) => (req) => ({
    runId: req.runId,
    stepId: req.stepId,
    approved: true,
    output,
    exitCode
  })
  const reject = () => (req) => ({
    runId: req.runId,
    stepId: req.stepId,
    approved: false,
    output: '用户拒绝执行这条命令，它没有在终端里运行。',
    exitCode: -1
  })

  let events = []
  agent.setEventSink((e) => events.push(e))

  await agent.setConfig({ baseURL: BASE, model: 'deepseek-chat', temperature: 0.3 }, GOOD_KEY)

  // —— 纯文本：增量拼接 + finish
  await agent.run({ runId: 'r1', profileId: 'p1', goal: `${SCENES.TEXT}：说两句` })
  const fin1 = await waitFor(events, (e) => e.runId === 'r1' && e.type === 'finish')
  const text1 = events.filter((e) => e.runId === 'r1' && e.type === 'text').map((e) => e.text).join('')
  const reason1 = events.filter((e) => e.runId === 'r1' && e.type === 'reasoning').map((e) => e.text).join('')
  ok('正文增量被正确拼成完整回复', text1 === '你好，这是一段流式输出。', JSON.stringify(text1))
  ok('思维链单独走 reasoning 事件、不混进正文', reason1 === '用户只是打招呼，直接回即可。', JSON.stringify(reason1))
  ok('结束时给出 finish 事件并带上结论', fin1.text === text1, JSON.stringify(fin1.text))
  ok('finish 带上了结束原因', fin1.reason === 'stop', String(fin1.reason))
  ok('每条事件都带 runId', events.every((e) => e.runId === 'r1'), 'ok')
  ok('纯文本场景没有触发任何终端调用', execReqs.length === 0, `exec=${execReqs.length}`)
  ok('任务结束后 activeCount 归零', await waitZero(agent), `active=${agent.activeCount()}`)

  // —— 工具调用：反向桥 → 回灌 → 第二轮结论
  events = []
  execReqs.length = 0
  autoReply = approve('Filesystem  Size  Used Avail Use% Mounted on\n/dev/vda1   40G   33G   5G  87% /', 0)
  await agent.run({ runId: 'r2', profileId: 'p1', goal: `${SCENES.TOOL}：看看磁盘` })
  const fin2 = await waitFor(events, (e) => e.runId === 'r2' && e.type === 'finish')
  const call = events.find((e) => e.type === 'tool-call')
  const stepDone = events.find((e) => e.type === 'tool-done')
  ok('模型通过原生 tool calling 请求执行命令', !!call && call.command === 'df -h', call && call.command)
  ok('工具入参的 intent 被完整带下来', !!call && call.intent === '查看根分区使用率', call && call.intent)
  ok(
    '命令经反向通道送到了「渲染层」（不落地主进程自执行）',
    execReqs.length === 1 && execReqs[0].command === 'df -h' && execReqs[0].profileId === 'p1',
    `${execReqs.length} 次`
  )
  ok(
    '终端结果回灌后给出 tool-done（批准 + 退出码）',
    !!stepDone && stepDone.approved === true && stepDone.exitCode === 0,
    stepDone && `code=${stepDone.exitCode}`
  )
  ok('tool-call 与 tool-done 的 stepId 一致', !!call && !!stepDone && call.stepId === stepDone.stepId, call && call.stepId)
  ok('每轮只执行一条命令（没有批量方案）', events.filter((e) => e.type === 'tool-call').length === 1, 'ok')
  ok('拿到终端证据后才给结论', /87%/.test(fin2.text), JSON.stringify(fin2.text))
  ok(
    '结论只取最后一步的正文（不含第一步的判断，免得和步骤「思考」重复）',
    fin2.text === '根分区已使用 87%，建议继续定位 / 的下一级目录；当前没有执行任何变更。',
    JSON.stringify(fin2.text)
  )
  ok(
    '第一步的判断落在了这一步的思考里（而不是结论里）',
    events.some((e) => e.type === 'text' && e.text.includes('我先看一下根分区使用率')),
    'ok'
  )
  ok('工具调用场景最终也归零', await waitZero(agent), `active=${agent.activeCount()}`)

  // —— 非法命令：本地拦下，不经过终端
  events = []
  execReqs.length = 0
  autoReply = null
  await agent.run({ runId: 'r3', profileId: 'p1', goal: `${SCENES.BAD_CMD}：一把梭` })
  await waitFor(events, (e) => e.runId === 'r3' && e.type === 'finish')
  const denied = events.find((e) => e.type === 'tool-done')
  ok('含 && 的复合命令被判为不符合单步协议', !!denied && denied.approved === false && denied.exitCode === -1, denied && `code=${denied.exitCode}`)
  ok('非法命令根本不会送进终端', execReqs.length === 0, `${execReqs.length} 次`)
  ok('拒绝原因回灌给模型（说明为什么没执行）', !!denied && /不符合单步执行协议/.test(denied.output), denied && denied.output.slice(0, 30))
  ok('被拦下后模型仍能收到结果并收尾', !!events.find((e) => e.type === 'finish'), 'ok')

  // —— 用户拒绝：不执行、不原样重试
  events = []
  execReqs.length = 0
  autoReply = reject()
  await agent.run({ runId: 'r4', profileId: 'p1', goal: `${SCENES.TOOL}：看看磁盘` })
  await waitFor(events, (e) => e.runId === 'r4' && e.type === 'finish')
  const refused = events.find((e) => e.type === 'tool-done')
  ok('被用户拒绝的步骤标记为未批准', !!refused && refused.approved === false && refused.exitCode === -1, refused && `code=${refused.exitCode}`)
  ok('被拒后不会自动重试同一条命令', execReqs.length === 1, `${execReqs.length} 次`)
  ok('被拒后任务照样收敛到 finish', !!events.find((e) => e.type === 'finish'), 'ok')

  // —— 同一步里并发两条命令：必须串行进终端
  //    并发注入会让渲染层的单槽扫描器被后一条覆盖，前一条永远等不到结果
  //    （用户看到的正是「命令跑完了，Agent 一直显示等待终端结果」）
  events = []
  execReqs.length = 0
  autoReply = null // 手动控制回填时机，才能观察两条命令的先后
  await agent.run({ runId: 'r11', profileId: 'p1', goal: `${SCENES.PARALLEL}：两条一起给我` })

  const parFirst = await waitFor(execReqs, () => true, 12000)
  await sleep(400) // 若存在并发，第二条此刻早该冒出来了
  ok(
    '同一步里的第二条命令会排队，不会同时挤进终端',
    execReqs.length === 1 && execReqs[0].command === 'docker ps -a',
    `${execReqs.length} 条：${execReqs.map((r) => r.command).join(' | ') || '空'}`
  )

  bridge.resolveToolExec({
    runId: parFirst.runId,
    stepId: parFirst.stepId,
    approved: true,
    output: 'CONTAINER ID   IMAGE\nabc123         nginx:latest',
    exitCode: 0
  })
  const parSecond = await waitFor(execReqs, (r) => r.stepId !== parFirst.stepId, 12000)
  ok(
    '第一条回填之后，第二条才被放行',
    parSecond.command === 'docker system df -v',
    parSecond.command
  )

  bridge.resolveToolExec({
    runId: parSecond.runId,
    stepId: parSecond.stepId,
    approved: true,
    output: 'TYPE            TOTAL   ACTIVE\nImages          5       2',
    exitCode: 0
  })

  const finPar = await waitFor(events, (e) => e.runId === 'r11' && e.type === 'finish', 12000)
  const parDones = events.filter((e) => e.runId === 'r11' && e.type === 'tool-done')
  ok(
    '两条命令各自都拿到了结果（没有谁被覆盖而超时）',
    parDones.length === 2 && parDones.every((d) => d.exitCode === 0),
    `${parDones.length} 条，退出码 ${parDones.map((d) => d.exitCode).join(',')}`
  )
  ok(
    '两条命令的输出没有串台',
    parDones.some((d) => d.output.includes('CONTAINER ID')) &&
      parDones.some((d) => d.output.includes('TYPE')),
    parDones.map((d) => (d.output || '').slice(0, 14)).join(' | ')
  )
  ok('并发场景也能收敛到 finish', !!finPar, 'ok')
  ok('并发场景最终归零', await waitZero(agent), `active=${agent.activeCount()}`)

  // —— 步数上限：无限工具请求也能收尾
  events = []
  execReqs.length = 0
  autoReply = approve('step ok', 0)
  await agent.run({ runId: 'r5', profileId: 'p1', goal: `${SCENES.LOOP}：别停`, maxSteps: 2 })
  const fin5 = await waitFor(events, (e) => e.runId === 'r5' && e.type === 'finish')
  ok('达到步数上限后收尾，不会无限循环', events.filter((e) => e.type === 'tool-call').length === 2, `${events.filter((e) => e.type === 'tool-call').length} 步`)
  ok('收尾原因如实透传（tool-calls）', fin5.reason === 'tool-calls', String(fin5.reason))

  // —— 上游中途报错
  events = []
  await agent.run({ runId: 'r6', profileId: 'p1', goal: `${SCENES.BOOM}：试试` })
  const err6 = await waitFor(events, (e) => e.runId === 'r6' && e.type === 'error')
  ok('上游中途塞 error 会被转成 error 事件', /负载过高/.test(err6.message), err6.message)
  ok('报错后不会再多发一个 finish', !events.some((e) => e.type === 'finish'), 'ok')
  ok('报错后 activeCount 也归零', await waitZero(agent), `active=${agent.activeCount()}`)

  // —— 用户中止
  events = []
  await agent.run({ runId: 'r7', profileId: 'p1', goal: `${SCENES.SLOW}：慢慢说` })
  await waitFor(events, (e) => e.runId === 'r7' && e.type === 'text')
  ok('慢流会先吐出一部分内容', events.some((e) => e.text === '第一段'), 'ok')
  ok('abort 对进行中的任务返回 true', agent.abort('r7') === true, 'aborted')
  await waitFor(events, (e) => e.runId === 'r7' && e.type === 'aborted')
  ok('中止后收到 aborted 事件', events.some((e) => e.type === 'aborted'), 'ok')
  ok('用户主动停止不会被误报成 error', !events.some((e) => e.type === 'error'), 'ok')
  ok('中止后 activeCount 也归零', await waitZero(agent), `active=${agent.activeCount()}`)
  ok('对不存在的 runId 调 abort 返回 false', agent.abort('nope') === false, 'ok')

  // —— 未配置 Key + 远程地址 → 拦下来
  await agent.setConfig({ baseURL: 'https://example.com/v1', model: 'm' }, '')
  const noKey = await expectThrow(() => agent.run({ runId: 'r8', profileId: 'p1', goal: 'x' }), 'no key')
  ok('没配 Key 且是远程地址时直接拦下（不发请求）', noKey.threw && noKey.msg.includes('API Key'), noKey.msg)

  const noGoal = await expectThrow(() => agent.run({ runId: 'r8b', profileId: 'p1', goal: '   ' }), 'no goal')
  ok('没有任务内容时给出明确提示', noGoal.threw && noGoal.msg.includes('任务'), noGoal.msg)

  // —— 本地地址不强制要 Key，只是连不上会以 error 事件收场
  //    这一条会触发上游重试，SDK 默认会把整段 APICallError 打到 stderr，测试里静音掉
  const quiet = console.error
  console.error = () => {}
  try {
    await agent.setConfig({ baseURL: 'http://127.0.0.1:1/v1', model: 'm' }, '')
    events = []
    const localStarted = await agent.run({ runId: 'r9', profileId: 'p1', goal: `${SCENES.TEXT}：hi` })
    ok('本地地址（127.0.0.1）不强制要 Key，受理成功', localStarted.started === true, 'ok')
    const e9 = await waitFor(events, (e) => e.type === 'error' || e.type === 'finish', 20000)
    ok('连不上时以 error 事件收场（而不是抛回调用方）', e9.type === 'error', JSON.stringify(e9).slice(0, 120))
  } finally {
    console.error = quiet
  }

  // —— baseURL 直接写成完整的 chat/completions 也能用（用户很容易粘整条）
  await agent.setConfig({ baseURL: `${BASE}/chat/completions`, model: 'deepseek-chat' }, GOOD_KEY)
  events = []
  await agent.run({ runId: 'r10', profileId: 'p1', goal: `${SCENES.TEXT}：hi` })
  await waitFor(events, (e) => e.runId === 'r10' && e.type === 'finish')
  const text10 = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
  ok('Base URL 粘成完整 /chat/completions 也能正常用', text10 === '你好，这是一段流式输出。', JSON.stringify(text10))

  /* ---------- 收尾 ---------- */

  agent.setEventSink(() => {})
  bridge.setBridgeSender(() => {})
  server.close()

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  if (failed) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试异常：', e)
  process.exit(1)
})
