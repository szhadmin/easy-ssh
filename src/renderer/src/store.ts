import { create } from 'zustand'
import type {
  AgentChatMessage,
  AgentExecutionMode,
  AgentRunView,
  AgentToolStep,
  AgentConfigPatch,
  AgentConfigView,
  AgentProbeResult,
  AgentStreamEvent,
  ConnStatus,
  ConnectionProfile,
  DockerDetect,
  Metrics,
  ServerInfo,
  TransferProgress
} from '@shared/types'
import {
  DEFAULT_ROLE_ID,
  composeSystemPrompt,
  findRole
} from '@shared/agent-roles'
import { formatBytes, formatUptime, unwrap } from './lib/utils'
import { isDangerous } from './lib/commands'
import { MAX_AGENT_STEPS, parseAgentDecision, toolResultMessage, wrapAgentCommand } from './lib/agent-protocol'
import { createAgentResultScanner } from './lib/osc'

export type WorkspaceTab = 'overview' | 'terminal' | 'files' | 'docker' | 'agent'

/* --------------------------------------------------------------- 界面偏好 */

interface Prefs {
  /** 文件面板是否跟随终端的工作目录 */
  followCwd: boolean
  /** 终端占左侧的比例（%） */
  splitRatio: number
  /** 终端页右侧是否展开文件面板 */
  filesPaneOpen: boolean
  /** 问 AI 时是否自动带上当前服务器环境 */
  agentContext: boolean
  /** 已授权时，AI 给出的普通 Shell 命令完成流式输出后自动经当前 PTY 执行 */
  agentAutoExecute: boolean
}

const PREF_KEY = 'easyssh.prefs.v1'

const DEFAULT_PREFS: Prefs = {
  followCwd: true,
  splitRatio: 46,
  filesPaneOpen: true,
  agentContext: true,
  agentAutoExecute: false
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const p = JSON.parse(raw) as Partial<Prefs>
    return {
      followCwd: typeof p.followCwd === 'boolean' ? p.followCwd : DEFAULT_PREFS.followCwd,
      splitRatio:
        typeof p.splitRatio === 'number' && p.splitRatio >= 20 && p.splitRatio <= 85
          ? p.splitRatio
          : DEFAULT_PREFS.splitRatio,
      filesPaneOpen:
        typeof p.filesPaneOpen === 'boolean' ? p.filesPaneOpen : DEFAULT_PREFS.filesPaneOpen,
      agentContext:
        typeof p.agentContext === 'boolean' ? p.agentContext : DEFAULT_PREFS.agentContext,
      agentAutoExecute:
        typeof p.agentAutoExecute === 'boolean' ? p.agentAutoExecute : DEFAULT_PREFS.agentAutoExecute
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function writePrefs(patch: Partial<Prefs>): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...patch }))
  } catch {
    /* 隐私模式等场景下静默失败即可 */
  }
}


export interface Toast {
  id: string
  type: 'info' | 'success' | 'error' | 'warn'
  title: string
  message?: string
}

export interface MetricPoint {
  t: number
  cpu: number
  memUsedPercent: number
  rx: number
  tx: number
}

/* ------------------------------------------------------------- AI 助手会话 */

export interface AgentMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 推理模型吐的思维链，折叠展示 */
  reasoning?: string
  /** 出错时的原因（这条回复作废，不再进上下文） */
  error?: string
  /** 被用户中止 */
  aborted?: boolean
  createdAt: number
}

export interface AgentConv {
  messages: AgentMsg[]
  streaming: boolean
  requestId: string | null
  elapsedMs?: number
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}

/** requestId -> profileId。流式事件只带 requestId，靠这张表找回是哪台服务器的会话 */
const reqOwner = new Map<string, string>()

/** Agent 单步执行的 PTY 结果等待器；终端数据同时进 xterm 与这里，绝不走隐藏 exec。 */
const agentStepWaiters = new Map<string, (result: { output: string; exitCode: number }) => void>()
const agentStepScanners = new Map<string, ReturnType<typeof createAgentResultScanner>>()
const agentConfirmWaiters = new Map<string, (approve: boolean) => void>()

/** 端上下文最多回带多少条历史，避免 prompt 无限膨胀 */
const AGENT_HISTORY_LIMIT = 24

interface State {
  ready: boolean
  profiles: ConnectionProfile[]
  statuses: Record<string, ConnStatus>
  errors: Record<string, string>
  infos: Record<string, ServerInfo>
  docker: Record<string, DockerDetect>

  activeId: string | null
  tab: WorkspaceTab
  metrics: Record<string, Metrics>
  history: Record<string, MetricPoint[]>
  transfers: TransferProgress[]
  toasts: Toast[]
  /** 远程可用命令（连上后填充，供补全使用） */
  remoteCommands: Record<string, string[]>
  /** 终端上报的当前工作目录（OSC 7），文件面板据此同步刷新 */
  termCwd: Record<string, string>
  /** 每次（重）连成功自增；终端面板据此重开一个 shell 通道 */
  connEpoch: Record<string, number>
  /** AI 助手：每个连接一份对话 */
  agentConvos: Record<string, AgentConv>
  /** 终端 Agent：每台连接的单步执行状态 */
  agentRuns: Record<string, AgentRunView>
  agentExecutionMode: AgentExecutionMode
  /** AI 助手：模型配置（不含明文 Key） */
  agentConfig: AgentConfigView | null
  agentConfigLoaded: boolean
  /** 待插入终端的命令（Agent 面板 -> 终端面板 的单向通道） */
  termInject: { profileId: string; text: string; execute?: boolean; n: number } | null
  /** 界面偏好（持久化到 localStorage） */
  followCwd: boolean
  splitRatio: number
  filesPaneOpen: boolean
  agentContext: boolean
  agentAutoExecute: boolean

  init: () => Promise<void>
  refreshProfiles: () => Promise<void>
  connect: (id: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  setActive: (id: string | null) => void
  setTab: (t: WorkspaceTab) => void
  pollMetrics: (id: string) => Promise<void>
  setDocker: (id: string, d: DockerDetect) => void
  loadCommands: (id: string) => Promise<void>
  setTermCwd: (id: string, path: string) => void
  setFollowCwd: (v: boolean) => void
  setSplitRatio: (v: number) => void
  setFilesPaneOpen: (v: boolean) => void
  /** 把一段命令送到终端面板；execute=true 时通过同一 PTY 可见执行 */
  injectTerm: (profileId: string, text: string, execute?: boolean) => void
  loadAgentConfig: () => Promise<void>
  saveAgentConfig: (patch: AgentConfigPatch, apiKey?: string) => Promise<boolean>
  testAgentConfig: (override?: {
    baseURL?: string
    model?: string
    apiKey?: string
  }) => Promise<AgentProbeResult>
  setAgentContext: (v: boolean) => void
  setAgentAutoExecute: (v: boolean) => void
  setAgentExecutionMode: (v: AgentExecutionMode) => void
  agentSend: (profileId: string, text: string) => Promise<void>
  agentRun: (profileId: string, goal: string) => Promise<void>
  agentConfirmStep: (profileId: string, approve: boolean) => void
  agentStop: (profileId: string) => Promise<void>
  agentClear: (profileId: string) => void
  toast: (type: Toast['type'], title: string, message?: string) => void
  dismissToast: (id: string) => void
}

const MAX_HISTORY = 60

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * 把「当前这台服务器」的已知信息拼成一段上下文塞进 system prompt。
 * 用户在界面上已经能看到的东西（系统、内核、内存、Docker、当前目录…），
 * 没必要再让模型反问一遍 —— 这些正是运维问答里最常被漏掉的前提。
 */
function buildAgentContext(s: State, profileId: string): string {
  const profile = s.profiles.find((p) => p.id === profileId)
  const info = s.infos[profileId]
  const lines: string[] = []

  if (profile) lines.push(`连接名：${profile.name}（${profile.username}@${profile.host}:${profile.port}）`)
  if (info) {
    lines.push(`主机名：${info.hostname}`)
    lines.push(`操作系统：${info.os}，内核 ${info.kernel}，架构 ${info.arch}`)
    lines.push(`CPU：${info.cpuModel}，${info.cpuCores} 核`)
    lines.push(`内存总量：${formatBytes(info.memTotalKb * 1024, 1)}`)
    lines.push(`已运行：${formatUptime(info.uptimeSec)}`)
    lines.push(`登录身份：${info.isRoot ? 'root（最高权限）' : '普通用户（非 root）'}`)
    lines.push(`家目录：${info.home}`)
    if (info.dockerVersion) lines.push(`Docker 版本：${info.dockerVersion}`)
  }
  const d = s.docker[profileId]
  if (d && !d.available) lines.push('该机器未安装 / 未运行 Docker')

  const cwd = s.termCwd[profileId]
  if (cwd) lines.push(`终端当前所在目录：${cwd}`)

  const m = s.metrics[profileId]
  if (m) {
    lines.push(
      `最近一次采样：CPU ${m.cpuPercent.toFixed(0)}%，可用内存 ${formatBytes(m.memAvailableKb * 1024, 1)}，` +
        `负载 ${m.load1.toFixed(2)}/${m.load5.toFixed(2)}/${m.load15.toFixed(2)}，进程数 ${m.procCount}`
    )
  }

  if (!lines.length) return ''
  return (
    '【当前服务器环境】（来自本工具的实时探测，可直接采信）\n' +
    lines.map((l) => `- ${l}`).join('\n') +
    '\n不要反问以上已经给出的信息；如果还需要别的信息，直接给命令让用户执行。'
  )
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  profiles: [],
  statuses: {},
  errors: {},
  infos: {},
  docker: {},
  activeId: null,
  tab: 'overview',
  metrics: {},
  history: {},
  transfers: [],
  toasts: [],
  remoteCommands: {},
  termCwd: {},
  connEpoch: {},
  agentConvos: {},
  agentRuns: {},
  agentExecutionMode: 'manual',
  agentConfig: null,
  agentConfigLoaded: false,
  termInject: null,
  ...readPrefs(),

  async init() {
    await get().refreshProfiles()

    // 订阅主进程事件（只订阅一次）
    window.api.term.onData((packet) => {
      const scanner = agentStepScanners.get(packet.termId)
      if (!scanner) return
      const result = scanner(packet.data)
      if (!result) return
      const resolve = agentStepWaiters.get(result.runId)
      if (resolve) {
        agentStepWaiters.delete(result.runId)
        resolve({ output: result.output, exitCode: result.exitCode })
      }
    })

    window.api.files.onProgress((p) => {
      set((s) => {
        const list = [...s.transfers]
        const last = list[list.length - 1]
        if (p.done) {
          // 完成项：把同名进行中的记录标记完成，并保留短暂展示
          const idx = list.findIndex(
            (x) => !x.done && x.remotePath === p.remotePath && x.direction === p.direction
          )
          if (idx >= 0) list[idx] = { ...p, id: list[idx].id }
          else list.push(p)
          if (p.error) {
            get().toast('error', `${p.direction === 'upload' ? '上传' : '下载'}失败`, `${p.name}：${p.error}`)
          }
          const pruned = list.filter((x) => !x.done).concat(list.filter((x) => x.done).slice(-4))
          return { transfers: pruned }
        }
        const idx = list.findIndex(
          (x) => !x.done && x.remotePath === p.remotePath && x.direction === p.direction
        )
        if (idx >= 0) list[idx] = { ...list[idx], ...p }
        else list.push(p)
        return { transfers: list }
      })
    })

    window.api.files.onClosed((p) => {
      set((s) => ({
        statuses: { ...s.statuses, [p.profileId]: 'disconnected' },
        errors: { ...s.errors, [p.profileId]: '连接已断开' }
      }))
      get().toast('warn', '连接已断开', '远端关闭了 SSH 会话，请重新连接')
    })

    // 意外掉线后的自动重连：主进程负责重试，这里只反映状态
    window.api.ssh.onReconnect((p) => {
      if (p.phase === 'scheduled') {
        set((s) => ({
          statuses: { ...s.statuses, [p.profileId]: 'connecting' },
          errors: { ...s.errors, [p.profileId]: '连接意外断开，正在自动重连…' }
        }))
        // 只在第一次尝试时提示，避免连续弹 5 条
        if (p.attempt === 1) {
          get().toast('warn', '连接中断', '正在自动重连，请稍候…')
        }
        return
      }
      if (p.phase === 'ok') {
        set((s) => ({
          statuses: { ...s.statuses, [p.profileId]: 'connected' },
          errors: { ...s.errors, [p.profileId]: '' },
          connEpoch: { ...s.connEpoch, [p.profileId]: p.epoch }
        }))
        get().toast('success', '已重新连上', '连接已恢复，终端为你新开了一个 shell')
        return
      }
      set((s) => ({
        statuses: { ...s.statuses, [p.profileId]: 'error' },
        errors: { ...s.errors, [p.profileId]: '自动重连失败，请手动重连' }
      }))
      get().toast('error', '自动重连失败', '网络或服务器仍不可达，请点「连接」手动重试')
    })

    // AI 助手的流式增量：delta / reasoning 往当前回复上追加，done / error 收尾
    window.api.agent.onEvent((e) => {
      const profileId = reqOwner.get(e.requestId)
      if (!profileId) return

      if (e.type === 'error') get().toast('error', 'AI 请求出错', e.message)

      set((s) => {
        const conv = s.agentConvos[profileId]
        // 已经被清空 / 换了一轮对话，丢弃这条迟到的事件
        if (!conv || conv.requestId !== e.requestId) return {}
        const msgs = [...conv.messages]
        const i = msgs.length - 1
        if (i < 0) return {}
        const last = msgs[i]

        if (e.type === 'delta') {
          msgs[i] = { ...last, content: last.content + e.text }
          return { agentConvos: { ...s.agentConvos, [profileId]: { ...conv, messages: msgs } } }
        }
        if (e.type === 'reasoning') {
          msgs[i] = { ...last, reasoning: (last.reasoning ?? '') + e.text }
          return { agentConvos: { ...s.agentConvos, [profileId]: { ...conv, messages: msgs } } }
        }

        reqOwner.delete(e.requestId)
        if (e.type === 'done') {
          return {
            agentConvos: {
              ...s.agentConvos,
              [profileId]: {
                ...conv,
                messages: msgs,
                streaming: false,
                requestId: null,
                elapsedMs: e.elapsedMs,
                usage: e.usage
              }
            }
          }
        }
        if (e.type === 'error') {
          msgs[i] = { ...last, error: e.message }
        } else {
          // aborted：已经吐出来的内容留着，没内容就标一句「已停止」
          msgs[i] = last.content
            ? { ...last, aborted: true }
            : { ...last, aborted: true, error: '已停止生成' }
        }
        return {
          agentConvos: {
            ...s.agentConvos,
            [profileId]: { ...conv, messages: msgs, streaming: false, requestId: null }
          }
        }
      })
    })

    void get().loadAgentConfig()

    set({ ready: true })
  },

  async refreshProfiles() {
    try {
      const [profiles, statuses] = await Promise.all([
        unwrap(window.api.connections.list()),
        unwrap(window.api.connections.statuses())
      ])
      const statusMap: Record<string, ConnStatus> = {}
      for (const s of statuses) statusMap[s.id] = s.connected ? 'connected' : 'disconnected'
      set((s) => {
        const merged = { ...statusMap }
        // 保留正在连接 / 出错的状态
        for (const [k, v] of Object.entries(s.statuses)) {
          if ((v === 'connecting' || v === 'error') && merged[k] !== 'connected') merged[k] = v
        }
        return { profiles, statuses: merged }
      })
      if (!get().activeId && profiles.length) set({ activeId: profiles[0].id })
    } catch (e) {
      get().toast('error', '读取连接配置失败', (e as Error).message)
    }
  },

  async connect(id) {
    // 幂等：正在连 / 已连上就直接返回。
    // 否则「刚选中连接」的那一瞬间会有两个地方同时来连
    //（Workspace 挂载时的自动连接 effect + setActive 里的 connect），
    // 结果对同一台服务器建两条 SSH 连接、各跑一遍登录探路 —— 白占一条服务端会话。
    const cur = get().statuses[id]
    if (cur === 'connected' || cur === 'connecting') return

    set((s) => ({
      statuses: { ...s.statuses, [id]: 'connecting' },
      errors: { ...s.errors, [id]: '' }
    }))
    try {
      const res = await unwrap(window.api.ssh.connect(id))
      set((s) => ({
        statuses: { ...s.statuses, [id]: 'connected' },
        infos: res.info ? { ...s.infos, [id]: res.info } : s.infos,
        docker: { ...s.docker, [id]: res.docker }
      }))
      const name = get().profiles.find((p) => p.id === id)?.name ?? '服务器'
      get().toast('success', `已连接：${name}`, res.info ? `${res.info.os} · ${res.info.arch} · 可用命令 ${res.commandCount} 个` : undefined)
      void get().loadCommands(id)
      void get().pollMetrics(id)
    } catch (e) {
      const msg = (e as Error).message
      set((s) => ({
        statuses: { ...s.statuses, [id]: 'error' },
        errors: { ...s.errors, [id]: msg }
      }))
      get().toast('error', '连接失败', msg)
    }
  },

  async disconnect(id) {
    try {
      await unwrap(window.api.ssh.disconnect(id))
    } catch {
      /* 忽略 */
    }
    set((s) => ({
      statuses: { ...s.statuses, [id]: 'disconnected' },
      metrics: Object.fromEntries(Object.entries(s.metrics).filter(([k]) => k !== id)),
      history: Object.fromEntries(Object.entries(s.history).filter(([k]) => k !== id)),
      termCwd: Object.fromEntries(Object.entries(s.termCwd).filter(([k]) => k !== id))
    }))
  },

  async removeProfile(id) {
    try {
      await unwrap(window.api.connections.remove(id))
      set((s) => ({ activeId: s.activeId === id ? null : s.activeId }))
      await get().refreshProfiles()
      get().toast('success', '已删除连接配置')
    } catch (e) {
      get().toast('error', '删除失败', (e as Error).message)
    }
  },

  setActive(id) {
    set({ activeId: id })
    const st = get()
    if (id && st.statuses[id] !== 'connected') void st.connect(id)
  },

  setTab(t) {
    set({ tab: t })
  },

  async pollMetrics(id) {
    if (get().statuses[id] !== 'connected') return
    try {
      const m = await unwrap(window.api.sys.metrics(id))
      set((s) => {
        const memUsed = m.memTotalKb > 0 ? ((m.memTotalKb - m.memAvailableKb) / m.memTotalKb) * 100 : 0
        const point: MetricPoint = {
          t: m.ts,
          cpu: Number(m.cpuPercent.toFixed(1)),
          memUsedPercent: Number(memUsed.toFixed(1)),
          rx: Math.round(m.netRate.rxBytesPerSec),
          tx: Math.round(m.netRate.txBytesPerSec)
        }
        const prev = s.history[id] ?? []
        const next = [...prev, point].slice(-MAX_HISTORY)
        return { metrics: { ...s.metrics, [id]: m }, history: { ...s.history, [id]: next } }
      })
    } catch (e) {
      // 采集失败往往是会话已断，避免刷屏
      const msg = (e as Error).message
      if (/断开|not connected|No response/i.test(msg)) {
        set((s) => ({ statuses: { ...s.statuses, [id]: 'error' }, errors: { ...s.errors, [id]: msg } }))
      }
    }
  },

  setDocker(id, d) {
    set((s) => ({ docker: { ...s.docker, [id]: d } }))
  },

  async loadCommands(id) {
    try {
      const cmds = await unwrap(window.api.sys.commands(id))
      set((s) => ({ remoteCommands: { ...s.remoteCommands, [id]: cmds } }))
    } catch {
      /* 忽略：补全退化为仅词典 */
    }
  },

  /* ---------------------------------------- 终端目录 -> 文件面板 的联动 */

  setTermCwd(id, path) {
    set((s) => (s.termCwd[id] === path ? {} : { termCwd: { ...s.termCwd, [id]: path } }))
  },

  setFollowCwd(v) {
    set({ followCwd: v })
    writePrefs({ followCwd: v })
  },

  setSplitRatio(v) {
    const ratio = Math.min(85, Math.max(20, Math.round(v * 2) / 2))
    set({ splitRatio: ratio })
    writePrefs({ splitRatio: ratio })
  },

  setFilesPaneOpen(v) {
    set({ filesPaneOpen: v })
    writePrefs({ filesPaneOpen: v })
  },

  /* ------------------------------------------------------------ AI 助手 */

  injectTerm(profileId, text, execute = false) {
    // n 用时间戳当「序号」，终端面板据此判断这是一次新的插入请求
    set({ termInject: { profileId, text, execute, n: Date.now() } })
  },

  async loadAgentConfig() {
    try {
      const cfg = await unwrap(window.api.agent.getConfig())
      set({ agentConfig: cfg, agentConfigLoaded: true })
    } catch {
      set({ agentConfigLoaded: true })
    }
  },

  async saveAgentConfig(patch, apiKey) {
    try {
      const cfg = await unwrap(window.api.agent.setConfig(patch, apiKey))
      set({ agentConfig: cfg, agentConfigLoaded: true })
      return true
    } catch (e) {
      get().toast('error', '保存模型配置失败', (e as Error).message)
      return false
    }
  },

  async testAgentConfig(override) {
    return unwrap(window.api.agent.test(override))
  },

  setAgentContext(v) {
    set({ agentContext: v })
    writePrefs({ agentContext: v })
  },

  setAgentAutoExecute(v) {
    set({ agentAutoExecute: v })
    writePrefs({ agentAutoExecute: v })
  },

  setAgentExecutionMode(v) {
    // 新的单步 Agent 循环替代旧的“解析整段回答后批量执行代码块”模式。
    set({ agentExecutionMode: v, agentAutoExecute: false })
    writePrefs({ agentAutoExecute: false })
  },

  async agentRun(profileId, goal) {
    const initial = get()
    const previous = initial.agentRuns[profileId]
    if (!goal.trim() || ['thinking', 'executing', 'confirming'].includes(previous?.state ?? '')) return
    const restarting = !!previous && previous.goal === goal.trim()
    const runKey = `task-${uid()}${uid()}`
    const isCurrentRun = (): boolean => get().agentRuns[profileId]?.id === runKey
    const roleId = initial.agentConfig?.roleId ?? DEFAULT_ROLE_ID
    const role = findRole(roleId)
    const protocol = `\n\n【终端 Agent 协议】\n你正在操作用户可见的真实终端。每轮只能二选一：\n1) 执行下一步：输出一行 STEP: <本步意图>，再输出且仅输出一个 bash fenced code block，里面必须是一条单行命令，禁止 &&、;、脚本或多条命令。然后等待工具结果。\n2) 结束：输出一行 STEP: <结论意图>，再输出一个 final fenced code block，面向用户说明证据、结论和建议。\n不要一次给多步方案；不要声称看到了尚未返回的命令结果；不要输出原始思维链。`
    const baseSystem = `${composeSystemPrompt(role, initial.agentConfig?.prompts?.[roleId])}${protocol}`
    const ctx = initial.agentContext ? buildAgentContext(initial, profileId) : ''
    const messages: AgentChatMessage[] = [{ role: 'system', content: ctx ? `${baseSystem}\n\n${ctx}` : baseSystem }, { role: 'user', content: goal.trim() }]
    set((s) => ({
      agentRuns: { ...s.agentRuns, [profileId]: { id: runKey, state: 'thinking', activity: '正在分析目标，并决定第一条只读命令…', goal: goal.trim(), steps: [] } },
      // Agent 任务也落一条用户消息：对话区不会因 messages 为空退回欢迎页，清空按钮也始终有可清的实体。
      agentConvos: {
        ...s.agentConvos,
        [profileId]: {
          ...(s.agentConvos[profileId] ?? { messages: [], streaming: false, requestId: null }),
          messages: restarting
            ? (s.agentConvos[profileId]?.messages ?? [])
            : [...(s.agentConvos[profileId]?.messages ?? []), { id: uid(), role: 'user', content: goal.trim(), createdAt: Date.now() }],
          streaming: false,
          requestId: null
        }
      }
    }))

    for (let n = 0; n < MAX_AGENT_STEPS; n++) {
      if (!isCurrentRun()) return
      const requestId = `agent-${uid()}${uid()}`
      set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'thinking', activity: n === 0 ? '正在制定第一步排查动作…' : '正在根据终端结果判断下一步…', requestId } } }))
      const text = await new Promise<string>((resolve, reject) => {
        let content = ''
        reqOwner.set(requestId, profileId)
        const off = window.api.agent.onEvent((event) => {
          if (event.requestId !== requestId) return
          if (event.type === 'delta') content += event.text
          if (event.type === 'done') { off(); reqOwner.delete(requestId); resolve(content) }
          if (event.type === 'error') { off(); reqOwner.delete(requestId); reject(new Error(event.message)) }
          if (event.type === 'aborted') { off(); reqOwner.delete(requestId); reject(new Error('Agent 已停止')) }
        })
        void window.api.agent.chat({ requestId, messages, baseURL: get().agentConfig?.baseURL, model: get().agentConfig?.model, temperature: get().agentConfig?.temperature })
          .then((reply) => { if (!reply.ok) throw new Error(reply.error); return reply })
          .catch((e) => { off(); reqOwner.delete(requestId); reject(e) })
      }).catch((e) => {
        if (isCurrentRun()) {
          set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'error', activity: '模型请求失败。', error: (e as Error).message } } }))
        }
        return ''
      })
      if (!isCurrentRun() || !text) return
      messages.push({ role: 'assistant', content: text })
      const decision = parseAgentDecision(text)
      if (decision.kind === 'final') {
        if (!isCurrentRun()) return
        set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'done', activity: '已基于终端证据得出结论。', conclusion: decision.final.conclusion } } }))
        return
      }
      const step: AgentToolStep = { id: uid(), summary: decision.action.summary, command: decision.action.command, status: 'pending' }
      set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], activity: `判断：${decision.action.summary}`, steps: [...s.agentRuns[profileId].steps, step] } } }))
      const mode = get().agentExecutionMode
      const needsConfirm = mode === 'manual' || (mode === 'guarded' && isDangerous(step.command))
      if (needsConfirm) {
        const approved = await new Promise<boolean>((resolve) => {
          agentConfirmWaiters.set(profileId, resolve)
          set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'confirming', activity: `下一步需要授权：${decision.action.summary}`, steps: s.agentRuns[profileId].steps.map((x) => x.id === step.id ? { ...x, status: 'confirming' } : x) } } }))
        })
        if (!approved) {
          if (!isCurrentRun()) return
          set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'aborted', activity: '用户拒绝执行该步骤，任务已停止。', steps: s.agentRuns[profileId].steps.map((x) => x.id === step.id ? { ...x, status: 'cancelled' } : x) } } }))
          return
        }
      }
      const runId = `run-${uid()}${uid()}`
      const result = await new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
        const timer = setTimeout(() => { agentStepWaiters.delete(runId); reject(new Error('终端命令超过 90 秒未结束')) }, 90000)
        agentStepWaiters.set(runId, (value) => { clearTimeout(timer); resolve(value) })
        agentStepScanners.set(profileId, createAgentResultScanner())
        set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'executing', activity: `正在左侧终端执行：${decision.action.summary}`, steps: s.agentRuns[profileId].steps.map((x) => x.id === step.id ? { ...x, status: 'running' } : x) } } }))
        get().injectTerm(profileId, wrapAgentCommand(step.command, runId), true)
      }).catch((e) => ({ output: (e as Error).message, exitCode: 124 }))
      agentStepScanners.delete(profileId)
      if (!isCurrentRun()) return
      set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'thinking', activity: `已收到终端结果（退出码 ${result.exitCode}），正在判断下一步…`, steps: s.agentRuns[profileId].steps.map((x) => x.id === step.id ? { ...x, status: result.exitCode === 0 ? 'done' : 'failed', output: result.output, exitCode: result.exitCode } : x) } } }))
      messages.push({ role: 'user', content: toolResultMessage(step.command, result.output, result.exitCode) })
    }
    if (!isCurrentRun()) return
    set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...s.agentRuns[profileId], state: 'done', activity: '已达到安全步数上限。', conclusion: `已达到 ${MAX_AGENT_STEPS} 步上限，为避免无限执行，Agent 已停止。请根据已展示的工具结果继续判断。` } } }))
  },

  agentConfirmStep(profileId, approve) {
    const resolve = agentConfirmWaiters.get(profileId)
    if (!resolve) return
    agentConfirmWaiters.delete(profileId)
    resolve(approve)
  },

  async agentSend(profileId, text) {
    const content = text.trim()
    if (!content) return

    const st = get()
    const conv: AgentConv =
      st.agentConvos[profileId] ?? { messages: [], streaming: false, requestId: null }
    if (conv.streaming) return

    const roleId = st.agentConfig?.roleId ?? DEFAULT_ROLE_ID
    const role = findRole(roleId)
    const executionPolicy = st.agentAutoExecute
      ? '\n\n当前已开启“终端授权自动执行”。把需要执行的普通 Linux 命令放进标记为 bash 的 fenced code block；回复完成后客户端会经用户当前可见的终端执行。不要声称已经看到执行结果；等待用户贴出结果或继续提问。高风险破坏性命令仍须用户二次确认。'
      : '\n\n当前为手动执行模式。可以给出 bash 代码块，但不要声称自己已执行；用户会自行选择是否在终端执行。'
    const system = `${composeSystemPrompt(role, st.agentConfig?.prompts?.[roleId])}${executionPolicy}`

    // 先按「上一轮为止的历史」重建干净的 messages（出错 / 空回复不进上下文）
    const messages: AgentChatMessage[] = [{ role: 'system', content: system }]
    for (const m of conv.messages.slice(-AGENT_HISTORY_LIMIT)) {
      if (m.error) continue
      if (m.role === 'assistant' && !m.content.trim()) continue
      messages.push({ role: m.role, content: m.content })
    }

    const ctx = st.agentContext ? buildAgentContext(st, profileId) : ''
    if (ctx) messages[0] = { role: 'system', content: `${system}\n\n${ctx}` }
    messages.push({ role: 'user', content })

    const requestId = `${uid()}${uid()}`
    const userMsg: AgentMsg = { id: uid(), role: 'user', content, createdAt: Date.now() }
    const botMsg: AgentMsg = { id: uid(), role: 'assistant', content: '', createdAt: Date.now() }

    reqOwner.set(requestId, profileId)
    set((s) => ({
      agentConvos: {
        ...s.agentConvos,
        [profileId]: {
          messages: [...conv.messages, userMsg, botMsg],
          streaming: true,
          requestId
        }
      }
    }))

    try {
      const r = await unwrap(
        window.api.agent.chat({
          requestId,
          messages,
          baseURL: st.agentConfig?.baseURL,
          model: st.agentConfig?.model,
          temperature: st.agentConfig?.temperature
        })
      )
      // 建连阶段就被中止了（比如点发送后立刻点停止）
      if (!r.started) {
        reqOwner.delete(requestId)
        set((s) => {
          const c = s.agentConvos[profileId]
          if (!c || c.requestId !== requestId) return {}
          return {
            agentConvos: { ...s.agentConvos, [profileId]: { ...c, streaming: false, requestId: null } }
          }
        })
      }
    } catch (e) {
      const msg = (e as Error).message
      reqOwner.delete(requestId)
      set((s) => {
        const c = s.agentConvos[profileId]
        if (!c) return {}
        return {
          agentConvos: {
            ...s.agentConvos,
            [profileId]: {
              ...c,
              streaming: false,
              requestId: null,
              messages: c.messages.map((m) => (m.id === botMsg.id ? { ...m, error: msg } : m))
            }
          }
        }
      })
      get().toast('error', 'AI 请求失败', msg)
    }
  },

  async agentStop(profileId) {
    const conv = get().agentConvos[profileId]
    const run = get().agentRuns[profileId]
    const requestId = run?.requestId ?? conv?.requestId
    const confirm = agentConfirmWaiters.get(profileId)
    if (confirm) {
      agentConfirmWaiters.delete(profileId)
      confirm(false)
    }
    if (run && run.state !== 'done' && run.state !== 'error' && run.state !== 'aborted') {
      set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: { ...run, state: 'aborted', activity: '用户已停止本次任务。' } } }))
    }
    if (!requestId) return
    try {
      await window.api.agent.abort(requestId)
    } catch {
      /* 忽略：主进程那边可能已经结束了 */
    }
  },

  agentClear(profileId) {
    const conv = get().agentConvos[profileId]
    const run = get().agentRuns[profileId]
    const requestId = run?.requestId ?? conv?.requestId
    const confirm = agentConfirmWaiters.get(profileId)
    if (confirm) {
      agentConfirmWaiters.delete(profileId)
      confirm(false)
    }
    if (requestId) {
      void window.api.agent.abort(requestId)
      reqOwner.delete(requestId)
    }
    agentStepScanners.delete(profileId)
    set((s) => {
      const nextRuns = { ...s.agentRuns }
      delete nextRuns[profileId]
      return {
        agentRuns: nextRuns,
        agentConvos: {
          ...s.agentConvos,
          [profileId]: { messages: [], streaming: false, requestId: null }
        }
      }
    })
  },

  toast(type, title, message) {
    const t: Toast = { id: uid(), type, title, message }
    set((s) => ({ toasts: [...s.toasts, t] }))
    const ttl = type === 'error' ? 9000 : type === 'warn' ? 7000 : 4200
    setTimeout(() => get().dismissToast(t.id), ttl)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))
