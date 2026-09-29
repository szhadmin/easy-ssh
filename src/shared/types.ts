/**
 * 主进程 / 渲染进程共享的类型定义
 */

export type AuthType = 'password' | 'key' | 'agent'

/** 连接配置（不含任何明文凭据） */
export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** 私钥文件在本机的路径（authType === 'key'） */
  privateKeyPath?: string
  /** 分组名，仅用于侧边栏归类 */
  group?: string
  /** 头像色，形如 #6366f1 */
  color?: string
  /** 备注 */
  note?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

/** 明文凭据，只在内存 / IPC 单次传递，落盘时用 safeStorage 加密 */
export interface ConnectionSecret {
  password?: string
  passphrase?: string
}

export interface ConnectionWithSecret {
  profile: ConnectionProfile
  secret?: ConnectionSecret
}

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnState {
  id: string
  status: ConnStatus
  error?: string
  /** 远端系统信息，连上后填充 */
  info?: ServerInfo
}

export interface ServerInfo {
  hostname: string
  os: string
  kernel: string
  arch: string
  cpuModel: string
  cpuCores: number
  memTotalKb: number
  uptimeSec: number
  home: string
  isRoot: boolean
  dockerVersion?: string
}

/* ------------------------------------------------------------------ 终端 */

export type TermKind = 'host' | 'docker'

export interface TermOpenArgs {
  termId: string
  profileId: string
  kind: TermKind
  /** kind === 'docker' 时为容器 ID/名称 */
  target?: string
  cols: number
  rows: number
}

export interface TermDataEvent {
  termId: string
  data: string
}

export interface TermExitEvent {
  termId: string
  code?: number
  signal?: string
  reason?: string
}

/* --------------------------------------------------------------- 系统监控 */

export interface DiskUsage {
  filesystem: string
  mount: string
  sizeKb: number
  usedKb: number
  availKb: number
  usePercent: number
}

export interface NetIface {
  name: string
  rxBytes: number
  txBytes: number
}

export interface ProcessRow {
  pid: number
  user: string
  command: string
  cpu: number
  mem: number
}

export interface Metrics {
  /** 采样时间戳 */
  ts: number
  cpuPercent: number
  cpuCores: number
  cpuModel: string
  load1: number
  load5: number
  load15: number
  uptimeSec: number
  memTotalKb: number
  memAvailableKb: number
  swapTotalKb: number
  swapFreeKb: number
  disks: DiskUsage[]
  net: NetIface[]
  /** 相对上次采样的速率（字节/秒） */
  netRate: { rxBytesPerSec: number; txBytesPerSec: number }
  topCpu: ProcessRow[]
  topMem: ProcessRow[]
  procCount: number
}

/* ---------------------------------------------------------------- 文件 */

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mode: number
  modeText: string
  mtime: number
  uid: number
  gid: number
  owner?: string
}

export interface TransferProgress {
  id: string
  profileId: string
  direction: 'upload' | 'download'
  name: string
  localPath: string
  remotePath: string
  transferred: number
  total: number
  done: boolean
  error?: string
}

/* -------------------------------------------------------------- Docker */

export interface DockerContainer {
  id: string
  name: string
  image: string
  command: string
  status: string
  state: string
  ports: string
  created: string
  size?: string
  cpuPercent?: number
  memUsage?: string
}

export interface DockerImage {
  id: string
  repository: string
  tag: string
  size: string
  createdSince: string
}

export interface DockerDetect {
  available: boolean
  version?: string
  error?: string
}

/* ---------------------------------------------------------------- IPC */

export interface IpcResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface CommandHint {
  cmd: string
  desc: string
  /** 危险命令，插入前二次确认 */
  danger?: boolean
}

/* ---------------------------------------------------------------- 补全 */

/** 命令补全需要的「动态数据源」——由主进程去远端取，渲染层只负责说明要什么 */
export type CompSource =
  | 'path'
  | 'container'
  | 'image'
  | 'service'
  | 'composeService'
  | 'user'
  | 'group'
  | 'process'
  | 'procname'
  | 'host'
  | 'branch'
  | 'remote'

/** 一条补全候选（主进程只产出这几个字段，怎么插进命令行由渲染层决定） */
export interface CompleteItem {
  value: string
  desc: string
  isDir?: boolean
  isSymlink?: boolean
  danger?: boolean
}

/** 意外掉线后自动重连的进度广播 */
export interface ReconnectProgress {
  profileId: string
  /** scheduled = 已排上重试；ok = 已恢复；failed = 重试用尽 */
  phase: 'scheduled' | 'ok' | 'failed'
  /** 第几次尝试（ok 时为 0） */
  attempt: number
  /** 距离下次重试的毫秒数（ok / failed 时为 0） */
  delay: number
  /** 每次成功建立（含重连）自增，渲染层据此重开终端 */
  epoch: number
}

/* --------------------------------------------------------------- AI 助手 */

/** 一条对话消息（渲染层构造好，主进程原样透传给上游） */
export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 终端 Agent 的执行权限：手动不执行；受限授权仅自动执行普通命令；完全信任包含敏感命令。 */
export type AgentExecutionMode = 'manual' | 'guarded' | 'trusted'

export interface AgentToolStep {
  id: string
  summary: string
  command: string
  status: 'pending' | 'confirming' | 'running' | 'done' | 'failed' | 'cancelled'
  output?: string
  exitCode?: number
}

export interface AgentRunView {
  /** 一次任务的唯一标识，避免清空或重发后旧请求回写新界面。 */
  id: string
  state: 'idle' | 'thinking' | 'confirming' | 'executing' | 'done' | 'error' | 'aborted'
  goal: string
  /** 当前这一轮模型给出的可展示判断（不是原始思维链）。 */
  activity?: string
  requestId?: string
  conclusion?: string
  error?: string
  steps: AgentToolStep[]
}

/** 一次流式对话请求 */
export interface AgentChatRequest {
  /** 渲染层生成的请求 ID：既用来把流式事件对上号，也用来中止 */
  requestId: string
  messages: AgentChatMessage[]
  /** 覆盖已保存的连接参数（用于「配置里还没保存就想先试一下」） */
  baseURL?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

/** 主进程 -> 渲染进程的流式事件 */
export type AgentStreamEvent =
  | { requestId: string; type: 'delta'; text: string }
  /** 推理模型的思维链增量（DeepSeek-R1 / QwQ 等），单独展示 */
  | { requestId: string; type: 'reasoning'; text: string }
  | {
      requestId: string
      type: 'done'
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
      elapsedMs?: number
    }
  | { requestId: string; type: 'error'; message: string }
  | { requestId: string; type: 'aborted' }

/** 配置的对外视图 —— 绝不包含明文 Key */
export interface AgentConfigView {
  baseURL: string
  model: string
  temperature: number
  /** 当前选中的角色模板 id */
  roleId: string
  /** 角色 id -> 用户改写过的 system prompt */
  prompts: Record<string, string>
  /** 是否已保存 Key */
  hasKey: boolean
  /** 脱敏后的 Key（形如 sk-a…3f9c） */
  keyMasked: string
  /** Key 是否只能明文落盘（safeStorage 不可用时） */
  plaintextFallback: boolean
}

export interface AgentConfigPatch {
  baseURL?: string
  model?: string
  temperature?: number
  roleId?: string
  prompts?: Record<string, string>
}

export interface AgentProbeResult {
  ok: boolean
  model: string
  /** 从发起请求到首个字节的往返耗时 */
  latencyMs: number
  /** 上游返回的片段，用来确认「确实是这个模型在答」 */
  sample?: string
}

/** OpenAI 兼容 GET /models 返回的可选模型项 */
export interface AgentModelItem {
  id: string
  ownedBy?: string
}

