/**
 * AI 助手的宿主侧实现：配置存储 + OpenAI 兼容的流式对话。
 *
 * 设计取舍：
 *  - 只做「OpenAI 兼容」一种协议（POST {baseURL}/chat/completions）。
 *    这样一套配置就能同时覆盖 OpenAI、DeepSeek、通义千问（兼容模式）、智谱、Moonshot、
 *    以及本地 Ollama / one-api 之类的自建网关，用户改个 Base URL 就能用。
 *  - 网络请求放在主进程（Node 的全局 fetch），不走渲染进程：
 *    既绕开页面 CSP，也保证 API Key 不进入渲染进程的内存。
 *  - Key 用 Electron 的 safeStorage（Windows 下即 DPAPI）加密后落盘，
 *    与连接密码同一套做法；极端环境下退化为 base64 混淆并如实标记。
 */
import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentChatRequest,
  AgentConfigPatch,
  AgentConfigView,
  AgentModelItem,
  AgentProbeResult,
  AgentStreamEvent
} from '@shared/types'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_ROLE_ID } from '@shared/agent-roles'

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
export let onEvent: ((e: AgentStreamEvent) => void) | null = null
export function setEventSink(fn: (e: AgentStreamEvent) => void): void {
  onEvent = fn
}

function emit(e: AgentStreamEvent): void {
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

/* ------------------------------------------------------------- 流式对话 */

interface Inflight {
  controller: AbortController
  /** 用户点了「停止」 */
  userAborted: boolean
  /** 被空闲看门狗中断 */
  idle: boolean
}

const inflight = new Map<string, Inflight>()

export function abort(requestId: string): boolean {
  const f = inflight.get(requestId)
  if (!f) return false
  f.userAborted = true
  try {
    f.controller.abort()
  } catch {
    /* ignore */
  }
  return true
}

export function abortAll(): void {
  for (const [id, f] of inflight) {
    f.userAborted = true
    try {
      f.controller.abort()
    } catch {
      /* ignore */
    }
    inflight.delete(id)
  }
}

export function activeCount(): number {
  return inflight.size
}

/**
 * 发起一次流式对话。
 *
 * 返回值只代表「请求已经发出去并被上游受理」；正文通过 onEvent 一点点推回来。
 * 这样把两类错误分得很干净：
 *   - 建连阶段的问题（地址错、401、模型不存在）走 IPC 的 { ok:false, error }
 *   - 流中途的问题（断流、上游报错、用户中止）走事件
 */
export async function chat(req: AgentChatRequest): Promise<{ started: boolean }> {
  const s = await load()
  const key = decryptKey(s.apiKeyEnc)
  const url = endpointOf(req.baseURL || s.baseURL)
  const model = (req.model || s.model).trim()
  const temp = typeof req.temperature === 'number' ? req.temperature : s.temperature

  if (!model) throw new Error('还没有配置模型名，例如 deepseek-chat')
  if (!req.messages?.length) throw new Error('没有可发送的消息')
  // 本地推理服务（Ollama 等）不校验 Key，所以这里只对「远程地址 + 无 Key」做拦截
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)
  if (!key && !isLocal) throw new Error('还没有填写 API Key，请先在「模型配置」里补齐')

  // 同一个 requestId 重复发起时，先把旧的收掉
  abort(req.requestId)

  const f: Inflight = { controller: new AbortController(), userAborted: false, idle: false }
  inflight.set(req.requestId, f)
  const started = Date.now()

  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    stream: true,
    temperature: temp
  }
  if (typeof req.maxTokens === 'number' && req.maxTokens > 0) body.max_tokens = req.maxTokens

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify(body),
      signal: f.controller.signal
    })
  } catch (e) {
    inflight.delete(req.requestId)
    if (f.userAborted) {
      emit({ requestId: req.requestId, type: 'aborted' })
      return { started: false }
    }
    throw new Error(`无法连接 ${url}：${(e as Error)?.message || '网络错误'}`)
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    inflight.delete(req.requestId)
    throw new Error(describeHttpError(res.status, raw))
  }
  if (!res.body) {
    inflight.delete(req.requestId)
    throw new Error('上游没有返回流式响应体')
  }

  // 后台把流读完；IPC 那边已经可以先返回了
  void pipe(req.requestId, res.body, f, started)
  return { started: true }
}

interface StreamDelta {
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

type Usage = { promptTokens?: number; completionTokens?: number; totalTokens?: number }

async function pipe(
  requestId: string,
  body: ReadableStream<Uint8Array>,
  f: Inflight,
  startedAt: number
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastByteAt = Date.now()
  let usage: Usage | undefined
  let sawDone = false

  // 看门狗：上游长时间不吐数据就主动断开，免得界面永远转圈
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > IDLE_TIMEOUT_MS) {
      f.idle = true
      try {
        f.controller.abort()
      } catch {
        /* ignore */
      }
    }
  }, 5000)

  const finish = (e: AgentStreamEvent): void => {
    clearInterval(watchdog)
    inflight.delete(requestId)
    emit(e)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lastByteAt = Date.now()
      buf += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          sawDone = true
          break
        }
        let json: StreamDelta
        try {
          json = JSON.parse(payload) as StreamDelta
        } catch {
          continue // 上游偶发半包 / 脏行，跳过即可
        }
        if (json.error?.message) {
          finish({ requestId, type: 'error', message: json.error.message })
          return
        }
        const d = json.choices?.[0]?.delta
        if (d?.reasoning_content) emit({ requestId, type: 'reasoning', text: d.reasoning_content })
        if (d?.content) emit({ requestId, type: 'delta', text: d.content })
        if (json.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens
          }
        }
      }
      if (sawDone) break
    }
    // 有些网关不发 [DONE] 就直接结束，这里一并当成正常收尾
    finish({ requestId, type: 'done', usage, elapsedMs: Date.now() - startedAt })
  } catch (e) {
    if (f.userAborted) {
      finish({ requestId, type: 'aborted' })
      return
    }
    if (f.idle) {
      finish({
        requestId,
        type: 'error',
        message: `上游超过 ${IDLE_TIMEOUT_MS / 1000} 秒没有返回任何数据，已中断。可能是网络卡住或模型侧排队。`
      })
      return
    }
    finish({ requestId, type: 'error', message: `读取响应流失败：${(e as Error)?.message || '未知错误'}` })
  }
}
