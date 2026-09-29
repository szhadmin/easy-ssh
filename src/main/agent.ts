/**
 * AI 助手的宿主侧实现：配置存储 + 终端 Agent 循环。
 *
 * 设计取舍：
 *  - 只做「OpenAI 兼容」一种协议，用 Vercel AI SDK 的 createOpenAICompatible 接入。
 *    一套配置就能同时覆盖 OpenAI、DeepSeek、通义千问（兼容模式）、智谱、Moonshot、
 *    以及本地 Ollama / one-api 之类的自建网关，用户改个 Base URL 就能用。
 *  - Agent 循环交给 AI SDK：原生 tool calling + stopWhen(stepCountIs(n))。
 *    不再自己解析模型文本里的协议标记 —— 工具调用由 SDK 抽取、校验参数、回填结果，
 *    模型遵循度远高于「要求它输出固定格式代码块」的老做法。
 *  - 网络请求放在主进程（Node 的全局 fetch），不走渲染进程：
 *    既绕开页面 CSP，也保证 API Key 不进入渲染进程的内存。
 *  - 工具本身在主进程被调起，但命令必须跑在渲染层那个**用户可见的终端**里，
 *    因此通过 agent-bridge 做一次反向请求，主进程自己不持有任何终端细节。
 *  - Key 用 Electron 的 safeStorage（Windows 下即 DPAPI）加密后落盘，
 *    与连接密码同一套做法；极端环境下退化为 base64 混淆并如实标记。
 */
import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import type {
  AgentConfigPatch,
  AgentConfigView,
  AgentModelItem,
  AgentProbeResult,
  AgentRunEvent,
  AgentRunRequest
} from '@shared/types'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ROLE_ID,
  composeSystemPrompt,
  findRole
} from '@shared/agent-roles'
import {
  AGENT_TOOL_NAME,
  MAX_AGENT_STEPS,
  sanitizeAgentCommand,
  truncateAgentOutput
} from '@shared/agent-tools'
import {
  cancelAllTools,
  cancelToolsOfRun,
  formatToolObservation,
  requestToolExec
} from './agent-bridge'

/** 上游「多久没有任何数据」就认为挂死了（毫秒） */
const IDLE_TIMEOUT_MS = 120_000
/** 探测配置时的超时 */
const PROBE_TIMEOUT_MS = 30_000
const DEFAULT_TEMPERATURE = 0.3

interface AgentFile {
  version: number
  baseURL: string
  model: string
  temperature: number
  roleId: string
  /** 角色 id -> 用户改写过的 system prompt */
  prompts: Record<string, string>
  /** base64(safeStorage 加密后的 Key) 或 PLAIN:... */
  apiKeyEnc?: string
  plaintextFallback?: boolean
}

const EMPTY: AgentFile = {
  version: 1,
  baseURL: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  temperature: DEFAULT_TEMPERATURE,
  roleId: DEFAULT_ROLE_ID,
  prompts: {}
}

/** 流式事件出口，由 index.ts 接到 IPC 广播上 */
export let onEvent: ((e: AgentRunEvent) => void) | null = null
export function setEventSink(fn: (e: AgentRunEvent) => void): void {
  onEvent = fn
}

function emit(e: AgentRunEvent): void {
  try {
    onEvent?.(e)
  } catch {
    /* 渲染层已销毁时忽略 */
  }
}

/* ------------------------------------------------------------------ 存储 */

let cache: AgentFile | null = null

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function filePath(): string {
  return join(dataDir(), 'agent.json')
}

async function load(): Promise<AgentFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fs.readFile(filePath(), 'utf8')) as Partial<AgentFile>
    cache = {
      version: parsed.version ?? 1,
      baseURL: typeof parsed.baseURL === 'string' && parsed.baseURL ? parsed.baseURL : DEFAULT_BASE_URL,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_MODEL,
      temperature:
        typeof parsed.temperature === 'number' && parsed.temperature >= 0 && parsed.temperature <= 2
          ? parsed.temperature
          : DEFAULT_TEMPERATURE,
      roleId: typeof parsed.roleId === 'string' && parsed.roleId ? parsed.roleId : DEFAULT_ROLE_ID,
      prompts: parsed.prompts && typeof parsed.prompts === 'object' ? parsed.prompts : {},
      apiKeyEnc: parsed.apiKeyEnc,
      plaintextFallback: parsed.plaintextFallback
    }
  } catch {
    cache = { ...EMPTY, prompts: {} }
  }
  return cache
}

/** 写盘串行化：连点保存也不会撞上 rename 竞态 */
let chain: Promise<void> = Promise.resolve()
let seq = 0

function persist(): Promise<void> {
  if (!cache) return Promise.resolve()
  const snapshot = JSON.stringify(cache, null, 2)
  const run = async (): Promise<void> => {
    const file = filePath()
    const tmp = `${file}.${process.pid}.${++seq}.tmp`
    try {
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
  }
  chain = chain.then(run, run)
  return chain
}

/* --------------------------------------------------------------- Key 加解密 */

function encryptKey(key: string): { value: string; plaintext: boolean } {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { value: safeStorage.encryptString(key).toString('base64'), plaintext: false }
    }
  } catch {
    /* fall through */
  }
  return { value: 'PLAIN:' + Buffer.from(key, 'utf8').toString('base64'), plaintext: true }
}

function decryptKey(value: string | undefined): string {
  if (!value) return ''
  try {
    if (value.startsWith('PLAIN:')) return Buffer.from(value.slice(6), 'base64').toString('utf8')
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return ''
  }
}

/** sk-abcdef…3f9c —— 只留头尾，够用户确认「存的是哪一把」 */
function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '•'.repeat(key.length)
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/* ------------------------------------------------------------------ 对外 API */

export async function getConfig(): Promise<AgentConfigView> {
  const s = await load()
  const key = decryptKey(s.apiKeyEnc)
  return {
    baseURL: s.baseURL,
    model: s.model,
    temperature: s.temperature,
    roleId: s.roleId,
    prompts: { ...s.prompts },
    hasKey: !!key,
    keyMasked: maskKey(key),
    plaintextFallback: !!s.plaintextFallback
  }
}

/**
 * 保存配置。
 *  - `apiKey` 传 undefined：不动已保存的 Key
 *  - 传空字符串：清除 Key
 *  - 传非空：覆盖
 */
export async function setConfig(
  patch: AgentConfigPatch,
  apiKey?: string
): Promise<AgentConfigView> {
  const s = await load()
  if (patch.baseURL !== undefined) s.baseURL = String(patch.baseURL).trim() || DEFAULT_BASE_URL
  if (patch.model !== undefined) s.model = String(patch.model).trim() || DEFAULT_MODEL
  if (patch.temperature !== undefined) {
    const t = Number(patch.temperature)
    s.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : DEFAULT_TEMPERATURE
  }
  if (patch.roleId !== undefined && patch.roleId) s.roleId = patch.roleId
  if (patch.prompts !== undefined) s.prompts = { ...patch.prompts }

  if (apiKey !== undefined) {
    const k = apiKey.trim()
    if (k) {
      const { value, plaintext } = encryptKey(k)
      s.apiKeyEnc = value
      s.plaintextFallback = plaintext
    } else {
      delete s.apiKeyEnc
    }
  }
  await persist()
  return getConfig()
}

export async function isPlaintextFallback(): Promise<boolean> {
  const s = await load()
  return !!s.plaintextFallback
}

/** 把 Base URL 归一化成 chat/completions 的完整地址 */
function baseOf(base: string): string {
  const b = (base || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
  if (!b) throw new Error('请先填写 Base URL，例如 https://api.deepseek.com/v1')
  if (!/^https?:\/\//i.test(b)) throw new Error('Base URL 需要以 http:// 或 https:// 开头')
  return b
}

/** 把 Base URL 归一化成 chat/completions 的完整地址 */
function endpointOf(base: string): string {
  return `${baseOf(base)}/chat/completions`
}

/** 标准 OpenAI 兼容模型发现接口 */
function modelsEndpointOf(base: string): string {
  return `${baseOf(base)}/models`
}

/** 把上游返回的 HTTP 错误翻译成人话 */
function describeHttpError(status: number, raw: string): string {
  let detail = ''
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string }
    const e = j.error
    detail = (typeof e === 'string' ? e : e?.message) || j.message || ''
  } catch {
    detail = raw.slice(0, 300)
  }
  const head =
    status === 401
      ? 'API Key 无效或已过期'
      : status === 402
        ? '账户余额不足'
        : status === 403
          ? '没有访问该模型的权限，或 Key 被网关限制'
          : status === 404
            ? '接口地址不对（上游没有 /chat/completions），检查 Base URL 是否少了 /v1'
            : status === 429
              ? '触发限流或配额用尽，稍后重试'
              : status >= 500
                ? '上游服务异常，稍后重试或换一个模型'
                : `请求被拒绝（HTTP ${status}）`
  return detail ? `${head}：${detail}` : head
}

/**
 * 测试配置：发一条最短的对话请求，一次跑通「地址 / Key / 模型」三件事。
 * 用最小的 max_tokens，尽量省钱。
 */
export async function probe(
  override?: { baseURL?: string; model?: string; apiKey?: string }
): Promise<AgentProbeResult> {
  const s = await load()
  const key = (override?.apiKey ?? '').trim() || decryptKey(s.apiKeyEnc)
  const model = (override?.model ?? '').trim() || s.model
  const url = endpointOf(override?.baseURL || s.baseURL)
  if (!key) throw new Error('还没有填写 API Key')

  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复两个字：正常' }],
        max_tokens: 8,
        stream: false
      }),
      signal: ctrl.signal
    })
  } catch (e) {
    clearTimeout(timer)
    const msg = (e as Error)?.message ?? ''
    if (/abort/i.test(msg)) throw new Error(`连接超时（${PROBE_TIMEOUT_MS / 1000}s 内没有响应），检查网络或 Base URL`)
    throw new Error(`连不上 ${url}：${msg || '网络错误'}`)
  }
  clearTimeout(timer)

  const text = await res.text()
  if (!res.ok) throw new Error(describeHttpError(res.status, text))

  let sample = ''
  try {
    const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }
    sample = j.choices?.[0]?.message?.content?.trim() ?? ''
  } catch {
    /* 上游没按规范返回也无所谓，HTTP 200 说明链路通了 */
  }
  return { ok: true, model, latencyMs: Date.now() - started, sample }
}

/**
 * 获取模型列表。遵循 OpenAI 兼容规范 GET {baseURL}/models；
 * 部分中转站不实现该接口，调用方可继续手填模型名。
 */
export async function listModels(
  override?: { baseURL?: string; apiKey?: string }
): Promise<AgentModelItem[]> {
  const s = await load()
  const baseURL = override?.baseURL || s.baseURL
  const url = modelsEndpointOf(baseURL)
  const key = (override?.apiKey ?? '').trim() || decryptKey(s.apiKeyEnc)
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)
  if (!key && !isLocal) throw new Error('还没有填写 API Key，无法获取模型列表')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: ctrl.signal
    })
  } catch (e) {
    const msg = (e as Error)?.message ?? ''
    if (/abort/i.test(msg)) throw new Error(`获取模型超时（${PROBE_TIMEOUT_MS / 1000}s）`)
    throw new Error(`无法获取模型列表：${msg || '网络错误'}`)
  } finally {
    clearTimeout(timer)
  }
  const raw = await res.text()
  if (!res.ok) throw new Error(describeHttpError(res.status, raw))
  try {
    const parsed = JSON.parse(raw) as { data?: Array<{ id?: unknown; owned_by?: unknown }> }
    const seen = new Set<string>()
    return (parsed.data ?? [])
      .map((m) => ({ id: typeof m.id === 'string' ? m.id.trim() : '', ownedBy: typeof m.owned_by === 'string' ? m.owned_by : undefined }))
      .filter((m) => !!m.id && !seen.has(m.id) && !!seen.add(m.id))
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    throw new Error('模型接口返回格式不兼容：期望 { data: [{ id }] }')
  }
}

/* ------------------------------------------------------------- 终端 Agent */

/**
 * 终端操作协议。原生 tool calling 已经替我们解决了「格式遵循」，
 * 这段只负责约束行为边界：一次一条命令、必须等结果、危险操作先说明风险。
 */
const AGENT_PROTOCOL = `

【终端执行协议】
你正连在用户这台服务器上，并且可以在他左侧那个**可见的真实终端**里执行命令。
- 需要查看或改变服务器状态时，调用 ${AGENT_TOOL_NAME} 工具，每次只传一条**单行**命令；
  禁止使用 && ; || 拼接多步，禁止多行脚本，也不要调用 vim / top / ssh 这类会占用终端的交互式命令。
- 工具会返回该命令真实的输出与退出码。**必须等结果返回后再决定下一步**，
  绝不要在结果出来之前假设命令已经执行，也不要编造任何输出。
- 先诊断后修复：不确定现状时先跑只读命令（ls / cat / df / du / systemctl status / journalctl 等）。
- 每一步只做一件事，并在 intent 里用一句中文说明「这条命令想确认什么」。
- 每一步只发起**一个**工具调用：终端只有一个，多给的命令会排队依次执行，
  并发发起只会让你更晚拿到结果，也更容易看错对应关系。
- 涉及删除、格式化、覆盖配置、重启服务、改权限、清空数据的命令，先一句话说明风险；
  客户端会要求用户二次确认。如果被拒绝，不要原样重试，改为说明替代方案。
- 不需要再执行命令时，直接用中文给出结论：说明观察到的证据、判断和建议，不要再调用工具。`

type Emit = (e: AgentRunEvent) => void

interface RunHandle {
  controller: AbortController
  /** 用户点了「停止」 */
  userAborted: boolean
}

const runs = new Map<string, RunHandle>()

export function activeCount(): number {
  return runs.size
}

/** 中止某一轮任务：既切断模型流，也把该轮挂起的终端等待作废 */
export function abort(runId: string): boolean {
  const h = runs.get(runId)
  if (!h) return false
  h.userAborted = true
  try {
    h.controller.abort()
  } catch {
    /* ignore */
  }
  cancelToolsOfRun(runId)
  return true
}

export function abortAll(): void {
  for (const [id, h] of [...runs]) {
    h.userAborted = true
    try {
      h.controller.abort()
    } catch {
      /* ignore */
    }
    runs.delete(id)
  }
  cancelAllTools()
}

/** 把 SDK 抛出的错误翻译成人话（HTTP 层错误复用配置探测那套文案） */
function describeAgentError(e: unknown): string {
  const err = e as { statusCode?: number; responseBody?: string; message?: string }
  const status = typeof err?.statusCode === 'number' ? err.statusCode : undefined
  if (status) {
    try {
      return describeHttpError(status, err.responseBody ?? '')
    } catch {
      /* 落到通用分支 */
    }
  }
  const msg = err?.message || (typeof e === 'string' ? e : '')
  if (/abort/i.test(msg)) return '请求已中止'
  return msg || '模型调用失败，且上游没有返回可读原因'
}

interface Upstream {
  base: string
  modelId: string
  key: string
  temperature: number
}

/**
 * 启动一轮终端 Agent。
 *
 * 返回值只代表「已经受理并开始跑」；正文、工具调用与结论都通过
 * EV.AGENT_RUN_EVENT 一点点推回渲染层。
 * 建连前的配置类错误（没 Key / 没模型名）直接抛给 IPC，界面能立刻给出准确提示。
 */
export async function run(req: AgentRunRequest): Promise<{ started: boolean }> {
  const s = await load()
  const key = decryptKey(s.apiKeyEnc)
  const base = baseOf(s.baseURL)
  const modelId = (s.model || '').trim()
  const goal = (req.goal || '').trim()

  if (!modelId) throw new Error('还没有配置模型名，例如 deepseek-chat')
  if (!goal) throw new Error('没有要执行的任务')
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(base)
  if (!key && !isLocal) throw new Error('还没有填写 API Key，请先在「模型配置」里补齐')

  // 同一个 runId 重复发起时，先把旧的收掉
  abort(req.runId)
  const handle: RunHandle = { controller: new AbortController(), userAborted: false }
  runs.set(req.runId, handle)

  void loop(req, handle, { base, modelId, key, temperature: s.temperature })
    .catch((e) => emit({ runId: req.runId, type: 'error', message: describeAgentError(e) }))
    .finally(() => runs.delete(req.runId))

  return { started: true }
}

/**
 * 每台服务器的终端都有自己的执行队列 —— 同一时刻只允许一条命令真的跑在 PTY 里。
 *
 * 为什么非要有这个：AI SDK 对**同一个 step 里返回的多个 tool call 是并发调用 execute 的**。
 * 模型很自然会一次给出「docker ps -a」和「docker system df -v」两条命令，于是两次
 * requestToolExec 同时飞向渲染层，两条命令被接连注入同一个终端。渲染层的输出扫描器是
 * 单槽的，后一条会把前一条的扫描器直接覆盖掉，前一条的输出就永远解析不出来了 ——
 * 表现正是「命令在终端里明明跑完了，Agent 却一直显示等待终端结果」。
 *
 * 上游的 OpenAI 兼容接口并不保证支持 `parallel_tool_calls: false`，所以不能指望模型只给一条；
 * 串行化是本地硬约束：终端只有一个，交互式命令必须排队。
 */
const terminalQueues = new Map<string, Promise<unknown>>()

function runInTerminalQueue<T>(profileId: string, job: () => Promise<T>): Promise<T> {
  const prev = terminalQueues.get(profileId) ?? Promise.resolve()
  // 前一条失败 / 被中止也要让后面的继续排队，否则一次异常会把整台服务器堵死
  const run = prev.then(job, job)
  terminalQueues.set(
    profileId,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

async function loop(req: AgentRunRequest, handle: RunHandle, up: Upstream): Promise<void> {
  const runId = req.runId
  const send: Emit = (e) => emit(e)

  const persona = composeSystemPrompt(findRole(req.roleId), req.systemExtra)
  const system = req.context
    ? `${persona}${AGENT_PROTOCOL}\n\n${req.context}`
    : `${persona}${AGENT_PROTOCOL}`

  const provider = createOpenAICompatible({
    name: 'easyssh',
    baseURL: up.base,
    apiKey: up.key || 'not-needed'
  })

  const runCommand = tool({
    description:
      '在用户当前可见的 SSH 终端里执行一条单行 shell 命令，并返回它真实的输出与退出码。每次调用只允许传一条命令。',
    inputSchema: z.object({
      intent: z.string().min(1).max(200).describe('这条命令想确认什么，用一句中文说明'),
      command: z
        .string()
        .min(1)
        .max(2000)
        .describe('要执行的单行 shell 命令；禁止 && ; || 拼接，禁止多行脚本')
    }),
    execute: async ({ intent, command }, options) => {
      const stepId = options.toolCallId
      send({ runId, type: 'tool-call', stepId, intent, command })

      const safe = sanitizeAgentCommand(command)
      if (!safe) {
        const output =
          '这条命令不符合单步执行协议（只允许一条单行命令，不能包含 && ; || 或多行脚本），已拒绝执行。请改写后重试。'
        send({ runId, type: 'tool-done', stepId, approved: false, output, exitCode: -1 })
        return output
      }

      // 排队执行：模型可以在一步里给出多条命令，但终端只有一个，必须一条跑完再跑下一条
      const reply = await runInTerminalQueue(req.profileId, () =>
        requestToolExec({
          runId,
          stepId,
          profileId: req.profileId,
          intent,
          command: safe
        })
      )
      send({
        runId,
        type: 'tool-done',
        stepId,
        approved: reply.approved,
        output: reply.output,
        exitCode: reply.exitCode
      })

      if (!reply.approved) {
        const why = truncateAgentOutput(reply.output || '')
        return `用户拒绝执行这条命令，它没有在终端里运行。${why ? `\n说明：${why}` : ''}\n不要原样重试；请改用更安全的做法，或说明为什么必须执行并请用户手动确认。`
      }
      return formatToolObservation(reply)
    }
  })

  const maxSteps = Math.max(1, Math.min(MAX_AGENT_STEPS, req.maxSteps ?? MAX_AGENT_STEPS))
  const result = streamText({
    model: provider.chatModel(up.modelId),
    system,
    prompt: req.goal.trim(),
    tools: { [AGENT_TOOL_NAME]: runCommand },
    stopWhen: stepCountIs(maxSteps),
    temperature: up.temperature,
    abortSignal: handle.controller.signal
  })

  // 每步的正文单独累计：`stepText` 在每步开始时清空，`allText` 是全程拼接（兜底用）。
  // 只把最后一步的正文当结论，否则「第一步的判断」会被重复贴进结论里 ——
  // 那段文字已经作为该步骤的「思考」显示过一次了。
  let allText = ''
  let stepText = ''
  let finishReason: string | undefined

  try {
    for await (const part of result.fullStream) {
      if (handle.userAborted) break
      switch (part.type) {
        case 'start-step':
          stepText = ''
          break
        case 'text-delta':
          allText += part.text
          stepText += part.text
          send({ runId, type: 'text', text: part.text })
          break
        case 'reasoning-delta':
          send({ runId, type: 'reasoning', text: part.text })
          break
        case 'finish':
          finishReason = part.finishReason
          break
        case 'abort':
          send({ runId, type: 'aborted' })
          return
        case 'error':
          send({ runId, type: 'error', message: describeAgentError(part.error) })
          return
        default:
          break
      }
    }
  } catch (e) {
    // 中止时 SDK 通常发 `abort` 分片后正常收流；这里兜住少数会抛出的情形，
    // 免得把「用户主动停止」误报成「Agent 出错」。
    if (handle.userAborted || /abort/i.test((e as Error)?.name ?? '')) {
      send({ runId, type: 'aborted' })
      return
    }
    throw e
  }

  if (handle.userAborted) {
    send({ runId, type: 'aborted' })
    return
  }
  send({ runId, type: 'finish', text: stepText.trim() || allText.trim(), reason: finishReason })
}
