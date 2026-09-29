/**
 * AI 助手（agent.ts）回归测试 —— 不需要 Electron 本体。
 *
 * 覆盖三块容易出错、又不好靠肉眼确认的逻辑：
 *   ① 配置存储：Key 必须加密落盘（明文不得出现在 agent.json 里）、
 *      重启后还能解出来、baseURL/model/temperature 的归一化与边界值收敛
 *   ② 探测：一次跑通「地址 / Key / 模型」，并把 401 / 404 这类上游错误
 *      翻译成人话（而不是把 JSON 原文糊到界面上）
 *   ③ 流式对话：SSE 分帧拼接、reasoning_content 单独成流、[DONE] 收尾、
 *      上游中途报错、用户中止、无 Key 拦截、baseURL 写成完整路径也能用
 *
 * 做法：把 agent.ts 单独编译成 CJS，然后
 *   - 用一个假的 `electron` 模块顶掉 app / safeStorage（后者做可逆的假加密，
 *     这样「落盘的是密文」和「重启能解开」两件事都能真断言）
 *   - 起一个假的 OpenAI 兼容服务，按模型名切换行为（正常 / 推理 / 中途报错 / 慢流）
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
const COMPILED = path.join(ROOT, '.tmp-agent-cjs', 'src', 'main', 'agent.js')
const SHARED_ROLES = path.join(ROOT, '.tmp-agent-cjs', 'src', 'shared', 'agent-roles.js')

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

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron
  if (request === '@shared/agent-roles') return origLoad.call(this, SHARED_ROLES, parent, isMain)
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

/** 等某个流式事件出现（pipe 是后台跑的，只能轮询） */
function waitFor(events, pred, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const hit = events.find(pred)
      if (hit) {
        clearInterval(iv)
        resolve(hit)
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv)
        reject(new Error('等待流式事件超时'))
      }
    }, 20)
  })
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
      res.end(JSON.stringify({ data: [
        { id: 'deepseek-chat', owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', owned_by: 'deepseek' },
        { id: 'deepseek-chat', owned_by: 'duplicate' }
      ] }))
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
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const chunk = (delta) => send({ choices: [{ index: 0, delta }] })

      if (model === 'boom-model') {
        chunk({ content: '开始了' })
        send({ error: { message: '上游模型负载过高' } })
        res.end()
        return
      }

      if (model === 'slow-model') {
        chunk({ content: '第一段' })
        // 留出足够时间让测试执行 abort；客户端断开后要收掉这个定时器
        const timer = setTimeout(() => {
          try {
            if (!res.destroyed && !res.writableEnded) {
              chunk({ content: '第二段' })
              res.write('data: [DONE]\n\n')
              res.end()
            }
          } catch {
            /* 客户端已断开 */
          }
        }, 5000)
        res.on('close', () => clearTimeout(timer))
        return
      }

      if (model === 'reason-model') {
        chunk({ reasoning_content: '磁盘满一般先看 ' })
        chunk({ reasoning_content: 'inode 和占用大头。' })
        chunk({ content: '结论：' })
        chunk({ content: '用 du 定位。' })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // 默认：两段正文 + 带 usage 的收尾块 + [DONE]
      chunk({ content: '你好，' })
      chunk({ content: '这是一段流式输出。' })
      send({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 8, total_tokens: 19 } })
      res.write('data: [DONE]\n\n')
      res.end()
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
  ok('Key 错误被翻译成「无效或已过期」而不是原始 JSON',
    badKey.threw && badKey.msg.includes('无效或已过期') && badKey.msg.includes('Invalid API key'), badKey.msg)

  const badPath = await expectThrow(
    () => agent.probe({ baseURL: `http://127.0.0.1:${PORT}/wrong-base` }),
    'bad path'
  )
  ok('地址写错被翻译成「接口地址不对」并提示 /v1',
    badPath.threw && badPath.msg.includes('接口地址不对'), badPath.msg)

  const noProto = await expectThrow(() => agent.probe({ baseURL: 'api.deepseek.com/v1' }), 'no proto')
  ok('Base URL 缺协议头会被拦下', noProto.threw && noProto.msg.includes('http://'), noProto.msg)

  const models = await agent.listModels({ baseURL: BASE, apiKey: GOOD_KEY })
  ok('能从标准 GET /models 获取并去重排序模型列表',
    models.map((m) => m.id).join(',') === 'deepseek-chat,deepseek-reasoner', JSON.stringify(models))
  const badModelsKey = await expectThrow(
    () => agent.listModels({ baseURL: BASE, apiKey: 'bad-key' }),
    'models bad key'
  )
  ok('模型列表接口错误会翻译 Key 无效', badModelsKey.threw && badModelsKey.msg.includes('无效或已过期'), badModelsKey.msg)

  /* ---------- ③ 流式对话 ---------- */

  const events = []
  agent.setEventSink((e) => events.push(e))

  await agent.chat({
    requestId: 'r1',
    messages: [{ role: 'user', content: '说两句' }],
    model: 'deepseek-chat'
  })
  const done1 = await waitFor(events, (e) => e.requestId === 'r1' && e.type === 'done')
  const text1 = events.filter((e) => e.requestId === 'r1' && e.type === 'delta').map((e) => e.text).join('')
  ok('SSE 增量被正确拼成完整回复', text1 === '你好，这是一段流式输出。', JSON.stringify(text1))
  ok('[DONE] 之后给出 done 事件', done1.type === 'done', `elapsed=${done1.elapsedMs}ms`)
  ok('usage 被透传给渲染层', done1.usage && done1.usage.totalTokens === 19, JSON.stringify(done1.usage))
  ok('每条增量都带 requestId', events.every((e) => e.requestId === 'r1'), 'ok')
  ok('流结束后 activeCount 归零', agent.activeCount() === 0, `active=${agent.activeCount()}`)

  // 推理模型：reasoning_content 单独成流
  const ev2 = []
  agent.setEventSink((e) => ev2.push(e))
  await agent.chat({ requestId: 'r2', messages: [{ role: 'user', content: 'hi' }], model: 'reason-model' })
  await waitFor(ev2, (e) => e.requestId === 'r2' && e.type === 'done')
  const reason = ev2.filter((e) => e.type === 'reasoning').map((e) => e.text).join('')
  const answer = ev2.filter((e) => e.type === 'delta').map((e) => e.text).join('')
  ok('思维链单独走 reasoning 事件', reason === '磁盘满一般先看 inode 和占用大头。', JSON.stringify(reason))
  ok('思维链不会混进正文', answer === '结论：用 du 定位。', JSON.stringify(answer))

  // 上游中途报错
  const ev3 = []
  agent.setEventSink((e) => ev3.push(e))
  await agent.chat({ requestId: 'r3', messages: [{ role: 'user', content: 'hi' }], model: 'boom-model' })
  const err3 = await waitFor(ev3, (e) => e.requestId === 'r3' && e.type === 'error')
  ok('上游中途塞 error 会被转成 error 事件', err3.message.includes('负载过高'), err3.message)
  ok('报错后不会再多发一个 done', !ev3.some((e) => e.type === 'done'), 'ok')

  // 用户中止
  const ev4 = []
  agent.setEventSink((e) => ev4.push(e))
  await agent.chat({ requestId: 'r4', messages: [{ role: 'user', content: 'hi' }], model: 'slow-model' })
  await waitFor(ev4, (e) => e.requestId === 'r4' && e.type === 'delta')
  ok('慢流会先吐出一部分内容', ev4.some((e) => e.text === '第一段'), 'ok')
  ok('abort 对进行中的请求返回 true', agent.abort('r4') === true, 'aborted')
  await waitFor(ev4, (e) => e.requestId === 'r4' && e.type === 'aborted')
  ok('中止后收到 aborted 事件而不是 error', ev4.some((e) => e.type === 'aborted'), 'ok')
  ok('中止后 activeCount 也归零', agent.activeCount() === 0, `active=${agent.activeCount()}`)
  ok('对不存在的 requestId 调 abort 返回 false', agent.abort('nope') === false, 'ok')

  // 未配置 Key + 远程地址 → 拦下来
  const localDir = 'http://127.0.0.1:1/v1'
  await agent.setConfig({ baseURL: localDir, model: 'm' }, '')
  const noKey = await expectThrow(
    () => agent.chat({ requestId: 'r5', messages: [{ role: 'user', content: 'hi' }], model: 'm', baseURL: 'https://example.com/v1' }),
    'no key'
  )
  ok('没配 Key 且是远程地址时直接拦下（不发请求）',
    noKey.threw && noKey.msg.includes('API Key'), noKey.msg)

  // 本地地址不强制要 Key
  const localOk = await expectThrow(
    () => agent.chat({ requestId: 'r6', messages: [{ role: 'user', content: 'hi' }], model: 'm', baseURL: 'http://127.0.0.1:1/v1' }),
    'local no key'
  )
  ok('本地地址（127.0.0.1）不强制要 Key，只是连不上会报网络错误',
    localOk.threw && !localOk.msg.includes('API Key'), localOk.msg.slice(0, 60))

  // baseURL 直接写成完整的 chat/completions 也能用（用户很容易粘整条）
  await agent.setConfig({ baseURL: `${BASE}/chat/completions`, model: 'deepseek-chat' }, GOOD_KEY)
  const ev7 = []
  agent.setEventSink((e) => ev7.push(e))
  await agent.chat({ requestId: 'r7', messages: [{ role: 'user', content: 'hi' }] })
  await waitFor(ev7, (e) => e.requestId === 'r7' && e.type === 'done')
  const text7 = ev7.filter((e) => e.type === 'delta').map((e) => e.text).join('')
  ok('Base URL 粘成完整 /chat/completions 也能正常用', text7 === '你好，这是一段流式输出。', JSON.stringify(text7))

  // 没填模型名要报错
  const noModel = await expectThrow(
    () => agent.chat({ requestId: 'r8', messages: [{ role: 'user', content: 'hi' }], model: '  ' }),
    'no model'
  )
  ok('模型名为空时给出明确提示', noModel.threw && noModel.msg.includes('模型'), noModel.msg)

  /* ---------- 收尾 ---------- */

  agent.setEventSink(() => {})
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
