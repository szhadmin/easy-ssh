import { create } from 'zustand'
import type {
  AgentExecutionMode,
  AgentRunEvent,
  AgentRunView,
  AgentToolExecRequest,
  AgentToolStep,
  AgentConfigPatch,
  AgentConfigView,
  AgentProbeResult,
  ConnStatus,
  ConnectionProfile,
  DockerDetect,
  Metrics,
  ServerInfo,
  TransferProgress
} from '@shared/types'
import { DEFAULT_ROLE_ID } from '@shared/agent-roles'
import { formatBytes, formatUptime, unwrap } from './lib/utils'
import { isDangerous } from './lib/commands'
import {
  MAX_AGENT_STEPS,
  agentSentinelToken,
  truncateAgentOutput,
  wrapAgentCommand
} from '@shared/agent-tools'
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

/**
 * Agent 的时间线以「轮」为单位累积：每按一次发送就 append 一条，旧轮不再被覆盖。
 * 这样右上角那一栏才真的像一段对话，而不是永远只显示最新一条。
 */

/**
 * 正在建立的 SSH 连接（profileId -> 那次 connect 的 promise）。
 *
 * 只靠 `statuses[id]` 做幂等是不够的：一旦有别的来源把状态改成 disconnected / error
 * （比如上一条会话迟到的 close 事件），同一台服务器就会再发一次 connect，
 * 于是「连上 → 被顶掉 → 再连上 → 再被顶掉」来回跳。这里用一个真正在途的锁兜住。
 */
const connectInflight = new Map<string, Promise<void>>()

/** Agent 单步执行的 PTY 结果等待器：key 是这一步的哨兵 token */
const agentStepWaiters = new Map<string, (r: { output: string; exitCode: number }) => void>()
/** 每台服务器同一时刻只会有一个在跑的 Agent 命令，扫描器按 profileId 存放 */
const agentStepScanners = new Map<string, ReturnType<typeof createAgentResultScanner>>()
/** 等待用户授权某一步（stepId -> 决议） */
const agentConfirmWaiters = new Map<string, (approve: boolean) => void>()

/** 单步命令的硬上限：超过就按超时处理，避免整轮任务永久挂住 */
const AGENT_STEP_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 每个终端同时只允许一条 Agent 命令在跑。
 *
 * 主进程侧已经有一道同源队列，这里是第二道保险：只要有任何入口绕过它（比如将来新增的
 * 触发方式）直接调 execInTerminal，单槽扫描器就会被后一条命令覆盖，前一条永远等不到结果。
 * 排队而不是并发注入，是「命令跑在用户眼前那个 PTY 里」这个设计的前提。
 */
const agentTermQueues = new Map<string, Promise<unknown>>()

function runInAgentTermQueue<T>(profileId: string, job: () => Promise<T>): Promise<T> {
  const prev = agentTermQueues.get(profileId) ?? Promise.resolve()
  const run = prev.then(job, job)
  agentTermQueues.set(
    profileId,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

const RUN_ACTIVE_STATES: AgentRunView['state'][] = ['thinking', 'executing']

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
  /** 终端 Agent：每台连接一条时间线，按轮次累积，旧轮不再被覆盖 */
  agentRuns: Record<string, AgentRunView[]>
  /** 正在等用户授权的步骤：面板据此渲染确认条 */
  agentPendingConfirm: {
    runId: string
    stepId: string
    profileId: string
    intent: string
    command: string
  } | null
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
  agentRun: (profileId: string, goal: string) => Promise<void>
  /** 对某一步的授权决议；approve=false 会让 Agent 收到「用户拒绝」并自己收尾 */
  agentConfirmStep: (profileId: string, approve: boolean) => void
  agentStop: (profileId: string) => Promise<void>
  /** 清空这台服务器的整条 Agent 时间线，并中止在途任务 */
  agentClear: (profileId: string) => void
  /** 主进程推来的 Agent 事件（正文 / 推理 / 工具调用 / 结束） */
  agentApplyEvent: (e: AgentRunEvent) => void
  /** 主进程请求：在某台服务器当前可见的终端里执行一条命令，并把结果回传 */
  agentHandleToolExec: (req: AgentToolExecRequest) => Promise<void>
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

export const useStore = create<State>((set, get) => {
  /* ------------------------------------------------ Agent 时间线的内部工具 */

  /** 找出某个 runId 属于哪台服务器 */
  function ownerOfRun(runId: string): string | null {
    for (const [pid, list] of Object.entries(get().agentRuns)) {
      if (list.some((r) => r.id === runId)) return pid
    }
    return null
  }

  /** 就地改写某一轮任务（不可变更新，避免 React 漏渲染） */
  function patchRun(
    profileId: string,
    runId: string,
    patch: Partial<AgentRunView> | ((r: AgentRunView) => Partial<AgentRunView>)
  ): void {
    set((s) => {
      const list = s.agentRuns[profileId]
      if (!list) return {}
      const next = list.map((r) =>
        r.id === runId ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r
      )
      return { agentRuns: { ...s.agentRuns, [profileId]: next } }
    })
  }

  /** 就地改写某一轮里的某一步 */
  function patchStep(
    profileId: string,
    runId: string,
    stepId: string,
    patch: Partial<AgentToolStep>
  ): void {
    set((s) => {
      const list = s.agentRuns[profileId]
      if (!list) return {}
      const next = list.map((r) =>
        r.id === runId
          ? { ...r, steps: r.steps.map((x) => (x.id === stepId ? { ...x, ...patch } : x)) }
          : r
      )
      return { agentRuns: { ...s.agentRuns, [profileId]: next } }
    })
  }

  /** 正文增量：追加到这一轮的正文缓冲，界面上就是逐字打出来的效果 */
  function appendRunText(profileId: string, runId: string, chunk: string): void {
    set((s) => {
      const list = s.agentRuns[profileId]
      if (!list) return {}
      const next = list.map((r) => (r.id === runId ? { ...r, text: r.text + chunk } : r))
      return { agentRuns: { ...s.agentRuns, [profileId]: next } }
    })
  }

  /**
   * 模型决定调用工具的那一刻，就是「思考」与「行动」的分界线：
   * 把这一轮已经流出来的正文交给这一步当思考，同时新建步骤、清空缓冲。
   * 这样界面上每一步都是「先看到判断，再看到命令」，而不是凭空冒出一条命令。
   */
  function commitThinking(
    profileId: string,
    runId: string,
    stepId: string,
    intent: string,
    command: string
  ): void {
    set((s) => {
      const list = s.agentRuns[profileId]
      if (!list) return {}
      const next = list.map((r) => {
        if (r.id !== runId) return r
        if (r.steps.some((x) => x.id === stepId)) return r
        const step: AgentToolStep = {
          id: stepId,
          intent: intent || '执行命令',
          command,
          status: 'pending',
          thinking: r.text.trim()
        }
        return { ...r, text: '', steps: [...r.steps, step], activity: `判断：${intent || command}` }
      })
      return { agentRuns: { ...s.agentRuns, [profileId]: next } }
    })
  }

  /**
   * 把一条命令送进当前可见的终端并等它跑完。
   *
   * 命令由 wrapAgentCommand 包上纯 ASCII 哨兵，扫描器从终端流里切出输出与退出码 ——
   * 走的就是用户眼前那个 PTY，回显、实时输出、Ctrl+C 全都与手工执行一致。
   * 哨兵只在命令真正跑完时才会打印，所以这里能立刻拿到结果，不再有 90 秒的假等待。
   */
  function execInTerminal(
    profileId: string,
    command: string
  ): Promise<{ output: string; exitCode: number }> {
    return runInAgentTermQueue(profileId, () => execInTerminalOnce(profileId, command))
  }

  function execInTerminalOnce(
    profileId: string,
    command: string
  ): Promise<{ output: string; exitCode: number }> {
    if (agentStepScanners.has(profileId)) {
      // 队列保证不会走到这里；真出现就说明有别的入口绕过了 execInTerminal，
      // 前一条命令的扫描器马上被覆盖、它会一直等到超时 —— 留个痕迹便于定位。
      console.warn('[agent] 上一条命令还没结束就开始了新的一条，扫描器将被覆盖')
    }
    const token = agentSentinelToken()
    agentStepScanners.set(profileId, createAgentResultScanner())
    return new Promise<{ output: string; exitCode: number }>((resolve) => {
      const finish = (r: { output: string; exitCode: number }): void => {
        agentStepWaiters.delete(token)
        clearTimeout(timer)
        agentStepScanners.delete(profileId)
        resolve(r)
      }
      const timer = setTimeout(
        () =>
          finish({
            output: `命令在 ${Math.round(AGENT_STEP_TIMEOUT_MS / 60000)} 分钟内没有结束，已按超时处理。必要时点「停止」中止本轮任务。`,
            exitCode: 124
          }),
        AGENT_STEP_TIMEOUT_MS
      )
      agentStepWaiters.set(token, finish)
      get().injectTerm(profileId, wrapAgentCommand(command, token), true)
    })
  }

  /** 把一步的结果回传给主进程；主进程正挂着等它 */
  async function replyTool(
    req: AgentToolExecRequest,
    r: { approved: boolean; output: string; exitCode: number }
  ): Promise<void> {
    try {
      await window.api.agent.toolResult({
        runId: req.runId,
        stepId: req.stepId,
        approved: r.approved,
        output: truncateAgentOutput(r.output ?? ''),
        exitCode: r.exitCode
      })
    } catch {
      /* 主进程可能已经不再等了（用户点了停止） */
    }
  }

  return {
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
  agentRuns: {},
  agentPendingConfirm: null,
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
      const resolve = agentStepWaiters.get(result.token)
      if (!resolve) return
      agentStepWaiters.delete(result.token)
      resolve({ output: result.output, exitCode: result.exitCode })
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
      const id = p.profileId
      // 正在自动重连，或用户刚点了连接、握手还没回来：这次 close 只是过程，不是结论
      if (get().statuses[id] === 'connecting') return
      const err = get().errors[id] ?? ''
      // 重连已经明确失败时，保留那条更准确的说明，只把状态定死为 error
      if (err.startsWith('自动重连失败')) {
        set((s) => ({ statuses: { ...s.statuses, [id]: 'error' } }))
        return
      }
      set((s) => ({
        statuses: { ...s.statuses, [id]: 'disconnected' },
        errors: { ...s.errors, [id]: '连接已断开' }
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

    // Agent 事件流：正文增量、工具调用、结束都由 agentApplyEvent 落到时间线上
    window.api.agent.onEvent((e) => get().agentApplyEvent(e))

    // 主进程的「请在这个终端里跑一条命令」请求：权限闸门 + 注入 PTY + 回传结果
    window.api.agent.onToolExec((req) => {
      void get().agentHandleToolExec(req)
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
    // 幂等：同一条连接正在握手时，第二个请求直接并到同一次握手上。
    // 只判断 statuses[id] 不够 —— 上一条会话迟到的 close 事件会把状态改回去，
    // 于是「连上 → 被顶掉 → 再连上」来回跳；这里的在途锁才是真正的闸门。
    const inflight = connectInflight.get(id)
    if (inflight) return inflight

    // 已经连着 / 正在连：不重复握手（除非明确要求重连）
    const cur = get().statuses[id]
    if (cur === 'connected' || cur === 'connecting') return

    const task = (async (): Promise<void> => {
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
        // 探测结果里的空字段不要留在提示里（否则会出现「Linux ·  · 可用命令 31 个」这种读不通的文案）
        const detail = res.info
          ? [res.info.os, res.info.arch, res.commandCount > 0 ? `可用命令 ${res.commandCount} 个` : '']
              .filter((x) => !!x && String(x).trim())
              .join(' · ')
          : ''
        get().toast('success', `已连接：${name}`, detail || undefined)
        void get().loadCommands(id)
        void get().pollMetrics(id)
      } catch (e) {
        const msg = (e as Error).message
        set((s) => ({
          statuses: { ...s.statuses, [id]: 'error' },
          errors: { ...s.errors, [id]: msg }
        }))
        get().toast('error', '连接失败', msg)
      } finally {
        connectInflight.delete(id)
      }
    })()

    connectInflight.set(id, task)
    return task
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
      // 正在自动重连 / 正在握手时，不要把状态改成 error —— 否则界面会从
      // 「重连中」直接跳到失败页，把终端面板也一起卸载掉。
      if (get().statuses[id] === 'connecting' || connectInflight.has(id)) return
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
    const text = goal.trim()
    if (!text) return
    const st = get()
    const timeline = st.agentRuns[profileId] ?? []
    // 同一台服务器同一时刻只跑一轮：两条时间线交错着往同一个 PTY 里灌命令必然乱套
    if (timeline.some((r) => RUN_ACTIVE_STATES.includes(r.state))) return

    const runId = `task-${uid()}${uid()}`
    const roleId = st.agentConfig?.roleId ?? DEFAULT_ROLE_ID
    const run: AgentRunView = {
      id: runId,
      state: 'thinking',
      goal: text,
      text: '',
      activity: '正在分析目标，并决定第一条只读命令…',
      steps: [],
      createdAt: Date.now()
    }
    set((s) => ({ agentRuns: { ...s.agentRuns, [profileId]: [...(s.agentRuns[profileId] ?? []), run] } }))

    try {
      await unwrap(
        window.api.agent.run({
          runId,
          profileId,
          goal: text,
          roleId,
          systemExtra: st.agentConfig?.prompts?.[roleId],
          context: st.agentContext ? buildAgentContext(st, profileId) : ''
        })
      )
    } catch (e) {
      const msg = (e as Error).message
      patchRun(profileId, runId, { state: 'error', activity: '任务没能启动。', error: msg })
      get().toast('error', 'Agent 启动失败', msg)
    }
  },

  agentApplyEvent(e) {
    const profileId = ownerOfRun(e.runId)
    if (!profileId) return
    switch (e.type) {
      case 'text':
        appendRunText(profileId, e.runId, e.text)
        break
      case 'reasoning':
        patchRun(profileId, e.runId, (r) => ({ reasoning: (r.reasoning ?? '') + e.text }))
        break
      case 'tool-call':
        commitThinking(profileId, e.runId, e.stepId, e.intent, e.command)
        break
      case 'tool-done':
        patchStep(profileId, e.runId, e.stepId, {
          status: e.approved ? (e.exitCode === 0 ? 'done' : 'failed') : 'denied',
          output: e.output,
          exitCode: e.exitCode
        })
        patchRun(profileId, e.runId, {
          state: 'thinking',
          activity: `已收到终端结果（退出码 ${e.exitCode}），正在判断下一步…`
        })
        break
      case 'finish':
        patchRun(profileId, e.runId, (r) => ({
          state: 'done',
          conclusion: e.text || r.text.trim() || '任务结束，但模型没有给出文字结论。',
          text: '',
          activity: e.reason === 'tool-calls' ? '已达到步数上限，任务收尾。' : '已基于终端证据得出结论。'
        }))
        break
      case 'error':
        patchRun(profileId, e.runId, { state: 'error', activity: '执行中断。', error: e.message })
        get().toast('error', 'Agent 出错', e.message)
        break
      case 'aborted':
        patchRun(profileId, e.runId, { state: 'aborted', activity: '已停止。' })
        break
      default:
        break
    }
  },

  async agentHandleToolExec(req) {
    const mode = get().agentExecutionMode
    const dangerous = isDangerous(req.command)
    // 手动：每一步都要点一下；受限：只有敏感命令才拦；完全信任：普通命令直接跑
    const needsConfirm = mode === 'manual' || (mode === 'guarded' && dangerous)

    if (needsConfirm) {
      patchStep(req.profileId, req.runId, req.stepId, { status: 'confirming' })
      patchRun(req.profileId, req.runId, {
        state: 'thinking',
        activity: `等待授权：${req.intent}`
      })
      set({
        agentPendingConfirm: {
          runId: req.runId,
          stepId: req.stepId,
          profileId: req.profileId,
          intent: req.intent,
          command: req.command
        }
      })
      const approved = await new Promise<boolean>((resolve) => {
        agentConfirmWaiters.set(req.stepId, resolve)
      })
      set((s) => (s.agentPendingConfirm?.stepId === req.stepId ? { agentPendingConfirm: null } : {}))
      if (!approved) {
        patchStep(req.profileId, req.runId, req.stepId, { status: 'denied' })
        await replyTool(req, {
          approved: false,
          output: '用户拒绝执行这条命令，它没有在终端里运行。',
          exitCode: -1
        })
        return
      }
    }

    patchStep(req.profileId, req.runId, req.stepId, { status: 'running' })
    patchRun(req.profileId, req.runId, {
      state: 'executing',
      activity: `正在左侧终端执行：${req.intent}`
    })

    const r = await execInTerminal(req.profileId, req.command)
    patchStep(req.profileId, req.runId, req.stepId, {
      status: r.exitCode === 0 ? 'done' : 'failed',
      output: r.output,
      exitCode: r.exitCode
    })
    await replyTool(req, { approved: true, output: r.output, exitCode: r.exitCode })
  },

  agentConfirmStep(profileId, approve) {
    const pending = get().agentPendingConfirm
    if (!pending || pending.profileId !== profileId) return
    const resolve = agentConfirmWaiters.get(pending.stepId)
    agentConfirmWaiters.delete(pending.stepId)
    resolve?.(approve)
  },

  async agentStop(profileId) {
    // 先放掉等待授权的步骤，否则主进程那侧会一直挂着
    const pending = get().agentPendingConfirm
    if (pending && pending.profileId === profileId) {
      const resolve = agentConfirmWaiters.get(pending.stepId)
      agentConfirmWaiters.delete(pending.stepId)
      set({ agentPendingConfirm: null })
      resolve?.(false)
    }
    const timeline = get().agentRuns[profileId] ?? []
    const active = timeline.find((r) => RUN_ACTIVE_STATES.includes(r.state))
    if (!active) return
    patchRun(profileId, active.id, { state: 'aborted', activity: '用户已停止本次任务。' })
    try {
      await window.api.agent.abort(active.id)
    } catch {
      /* 主进程那边可能已经结束了 */
    }
  },

  agentClear(profileId) {
    const pending = get().agentPendingConfirm
    if (pending && pending.profileId === profileId) {
      const resolve = agentConfirmWaiters.get(pending.stepId)
      agentConfirmWaiters.delete(pending.stepId)
      set({ agentPendingConfirm: null })
      resolve?.(false)
    }
    const timeline = get().agentRuns[profileId] ?? []
    const active = timeline.find((r) => RUN_ACTIVE_STATES.includes(r.state))
    if (active) void window.api.agent.abort(active.id)
    agentStepScanners.delete(profileId)
    set((s) => {
      const next = { ...s.agentRuns }
      delete next[profileId]
      return { agentRuns: next }
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
  }
})
