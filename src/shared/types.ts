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

/** 终端 Agent 的执行权限：手动不执行；受限授权仅自动执行普通命令；完全信任包含敏感命令。 */
export type AgentExecutionMode = 'manual' | 'guarded' | 'trusted'

/** 一次终端调用的一个步骤 */
export interface AgentToolStep {
  id: string
  /** 模型给出的这一步意图：这条命令想确认什么 */
  intent: string
  command: string
  /** 触发这一步的工具名，便于界面区分「手写命令」与「专用工具」 */
  tool?: string
  /** 这一步是否为写操作（需要更强的确认提示） */
  danger?: boolean
  status: 'pending' | 'confirming' | 'running' | 'done' | 'failed' | 'denied' | 'cancelled'
  /** 调用这条命令之前，模型本轮说给自己/用户的判断文字 */
  thinking?: string
  output?: string
  exitCode?: number
}

/**
 * 一轮完整的 Agent 任务。
 * 时间线以「轮」为单位累积 —— 新一轮只追加，不再覆盖上一轮的展示。
 */
export interface AgentRunView {
  /** 一次任务的唯一标识，避免清空或重发后旧请求回写新界面。 */
  id: string
  state: 'thinking' | 'executing' | 'done' | 'error' | 'aborted'
  goal: string
  /** 模型本轮累计的正文（分析、结论都在这里，逐字流式追加） */
  text: string
  /** 当前这一轮的可展示判断，用于顶部一行状态 */
  activity?: string
  /** 推理模型的思维链（deepseek-reasoner 之类才有），单独折叠展示 */
  reasoning?: string
  steps: AgentToolStep[]
  conclusion?: string
  error?: string
  createdAt: number
}

/**
 * 跨会话的长期记忆条目（每台服务器一份）。
 *
 * 与会话内历史的区别：历史只活在当前这次对话里，重开应用就没了；
 * 这里记的是「下次再连上这台机器时依然成立的东西」。
 */
export interface AgentMemoryFact {
  id: string
  text: string
  createdAt: number
  /** 模型自己记的 / 用户手动加的 */
  source: 'agent' | 'user'
}

/**
 * 带进模型的一段历史对话。
 *
 * 只保留「用户要了什么」与「上一轮得出了什么结论」—— 每一步的命令与终端输出
 * 又多又碎，全塞进上下文会迅速顶满窗口，而模型真正需要记住的就是这两样。
 */
export interface AgentHistoryTurn {
  goal: string
  conclusion?: string
}

/** 启动一次 Agent 任务的入参 */
export interface AgentRunRequest {
  runId: string
  profileId: string
  goal: string
  /** 前几轮的对话摘要（渲染层已按字符预算裁剪好），让模型记得刚才聊过什么 */
  history?: AgentHistoryTurn[]
  /** 选中的专家角色 id，主进程据此拼 system prompt */
  roleId?: string
  /** 角色补充提示词（用户在「模型配置」里自行改写的那部分） */
  systemExtra?: string
  /** 服务器环境上下文（开启「带服务器环境」时由渲染层拼好） */
  context?: string
  /** 覆盖默认的最大步数 */
  maxSteps?: number
}

/** 主进程 -> 渲染进程的 Agent 事件流 */
export type AgentRunEvent =
  | { runId: string; type: 'text'; text: string }
  | { runId: string; type: 'reasoning'; text: string }
  /** 模型请求执行一条命令（此刻命令尚未执行） */
  | {
      runId: string
      type: 'tool-call'
      stepId: string
      intent: string
      command: string
      /** 触发这一步的工具名（run_command / read_file / write_file …） */
      tool?: string
      /** 写操作标记：界面据此给出更强的警示文案 */
      danger?: boolean
    }
  /** 一步结束：拿到终端回显与退出码，或被拒绝 / 命令非法未执行 */
  | {
      runId: string
      type: 'tool-done'
      stepId: string
      approved: boolean
      output: string
      exitCode: number
    }
  | { runId: string; type: 'finish'; text: string; reason?: string }
  /** 长期记忆有变动（模型用 remember 记了新的事实），界面据此刷新列表 */
  | { runId: string; type: 'memory'; facts: AgentMemoryFact[] }
  | { runId: string; type: 'error'; message: string }
  | { runId: string; type: 'aborted' }

/** 主进程 -> 渲染层：请在当前可见的终端里执行这条命令 */
export interface AgentToolExecRequest {
  runId: string
  stepId: string
  profileId: string
  intent: string
  command: string
  /** 触发这一步的工具名 */
  tool?: string
  /**
   * 强制走二次确认。
   * 结构化工具生成的命令（如 write_file 的 `base64 -d > path`）不一定能被
   * 渲染层的「危险命令正则」识别出来，所以由主进程显式声明。
   */
  dangerous?: boolean
}

/** 渲染层 -> 主进程：这一步的执行结果 */
export interface AgentToolExecReply {
  /** 带上轮次标识，主进程可以直接定位挂起的那次等待 */
  runId?: string
  stepId: string
  approved: boolean
  output: string
  exitCode: number
}

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

