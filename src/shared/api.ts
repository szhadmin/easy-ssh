/**
 * 渲染进程可见的 window.api 类型契约。
 * preload 实现它，renderer 消费它 —— 一处定义，两端受检。
 */
import type {
  AgentConfigPatch,
  AgentConfigView,
  AgentMemoryFact,
  AgentModelItem,
  AgentProbeResult,
  AgentRunEvent,
  AgentRunRequest,
  AgentToolExecReply,
  AgentToolExecRequest,
  CommandHint,
  CompleteItem,
  CompSource,
  ConnectionProfile,
  ConnectionSecret,
  DockerContainer,
  DockerDetect,
  DockerImage,
  ExecResult,
  IpcResult,
  Metrics,
  ReconnectProgress,
  RemoteEntry,
  ServerInfo,
  TermOpenArgs,
  TransferProgress
} from './types'

export type Unsub = () => void

export interface DockerDetailView {
  id: string
  name: string
  image: string
  created: string
  state: string
  status: string
  restartPolicy: string
  cmd: string[]
  entrypoint: string[]
  env: string[]
  ports: string[]
  mounts: string[]
  networks: string[]
  ip: string
  platform: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userData: string
  plaintextFallback: boolean
}

export interface ConnectResult {
  info: ServerInfo | null
  commandCount: number
  docker: DockerDetect
}

export interface EasySshApi {
  connections: {
    list(): Promise<IpcResult<ConnectionProfile[]>>
    save(
      profile: Partial<ConnectionProfile> & { name: string; host: string; username: string },
      secret?: ConnectionSecret
    ): Promise<IpcResult<ConnectionProfile>>
    remove(id: string): Promise<IpcResult<boolean>>
    test(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<IpcResult<{ home: string; hostname: string }>>
    statuses(): Promise<IpcResult<Array<{ id: string; connected: boolean }>>>
    exportFile(): Promise<IpcResult<{ saved: boolean; path?: string }>>
    importFile(): Promise<IpcResult<{ added: number }>>
  }

  ssh: {
    connect(id: string): Promise<IpcResult<ConnectResult>>
    disconnect(id: string): Promise<IpcResult<boolean>>
    exec(id: string, cmd: string, timeout?: number): Promise<IpcResult<ExecResult>>
    /** 意外掉线后的自动重连进度 */
    onReconnect(cb: (p: ReconnectProgress) => void): Unsub
  }

  term: {
    open(args: TermOpenArgs): Promise<IpcResult<boolean>>
    /**
     * 往终端写入数据。
     * `internal = true` 表示程序注入（Agent 命令 / 补全插入 / 文件面板 cd），
     * 不算「用户手敲键盘」—— 否则会打断远端目录钩子的注入。
     */
    write(termId: string, data: string, internal?: boolean): Promise<IpcResult<boolean>>
    resize(termId: string, cols: number, rows: number): Promise<IpcResult<boolean>>
    close(termId: string): Promise<IpcResult<boolean>>
    onData(cb: (p: { termId: string; data: string }) => void): Unsub
    onExit(cb: (p: { termId: string; code?: number; signal?: string; reason?: string }) => void): Unsub
  }

  files: {
    home(id: string): Promise<IpcResult<string>>
    list(id: string, path: string): Promise<IpcResult<RemoteEntry[]>>
    readText(id: string, path: string): Promise<IpcResult<string>>
    writeText(id: string, path: string, content: string): Promise<IpcResult<void>>
    mkdir(id: string, path: string): Promise<IpcResult<void>>
    rename(id: string, from: string, to: string): Promise<IpcResult<void>>
    chmod(id: string, path: string, mode: number): Promise<IpcResult<void>>
    remove(id: string, path: string, isDir: boolean, recursive: boolean): Promise<IpcResult<void>>
    upload(id: string, remoteDir: string): Promise<IpcResult<{ uploaded: number }>>
    uploadDir(id: string, remoteDir: string): Promise<IpcResult<{ uploaded: boolean; target?: string }>>
    download(id: string, remotePaths: string[]): Promise<IpcResult<{ downloaded: number; dir?: string }>>
    onProgress(cb: (p: TransferProgress) => void): Unsub
    onClosed(cb: (p: { profileId: string }) => void): Unsub
  }

  sys: {
    info(id: string, force?: boolean): Promise<IpcResult<ServerInfo>>
    metrics(id: string): Promise<IpcResult<Metrics>>
    commands(id: string, force?: boolean): Promise<IpcResult<string[]>>
    kill(id: string, pid: number, force?: boolean): Promise<IpcResult<{ pid: number; signal: string }>>
  }

  /** 命令补全的动态数据（远端目录、容器名、服务名…） */
  complete: {
    dynamic(
      id: string,
      source: CompSource,
      arg?: string
    ): Promise<IpcResult<CompleteItem[]>>
  }

  docker: {
    detect(id: string): Promise<IpcResult<DockerDetect>>
    containers(id: string): Promise<IpcResult<DockerContainer[]>>
    images(id: string): Promise<IpcResult<DockerImage[]>>
    stats(id: string): Promise<IpcResult<Record<string, { cpu: string; mem: string; memPerc: string }>>>
    action(id: string, cid: string, act: string): Promise<IpcResult<string>>
    logs(id: string, cid: string, tail?: number): Promise<IpcResult<string>>
    inspect(id: string, cid: string): Promise<IpcResult<DockerDetailView>>
    exec(id: string, cid: string, cmd: string): Promise<IpcResult<string>>
  }

  /** 内置 AI 助手：配置 LLM，并在用户可见的终端里跑多步 Agent */
  agent: {
    getConfig(): Promise<IpcResult<AgentConfigView>>
    setConfig(patch: AgentConfigPatch, apiKey?: string): Promise<IpcResult<AgentConfigView>>
    /** 拿一份（可能还没保存的）配置去试探上游，一次跑通地址 / Key / 模型 */
    test(
      override?: { baseURL?: string; model?: string; apiKey?: string }
    ): Promise<IpcResult<AgentProbeResult>>
    /** 从 OpenAI 兼容 GET /models 拉取模型列表；不支持时由界面保留手动填写 */
    models(override?: { baseURL?: string; apiKey?: string }): Promise<IpcResult<AgentModelItem[]>>
    /** 启动一轮 Agent：主进程用 AI SDK 跑工具调用循环 */
    run(req: AgentRunRequest): Promise<IpcResult<{ started: boolean }>>
    /** 回传某一步在可见终端里的执行结果 */
    toolResult(reply: AgentToolExecReply): Promise<IpcResult<boolean>>
    abort(runId: string): Promise<IpcResult<boolean>>
    /** 长期记忆：列出这台服务器记下的全部事实 */
    listMemory(profileId: string): Promise<IpcResult<AgentMemoryFact[]>>
    /** 手动补一条；内容重复时 added=false，不会重复记 */
    addMemory(
      profileId: string,
      text: string
    ): Promise<IpcResult<{ facts: AgentMemoryFact[]; added: boolean; reason?: string }>>
    removeMemory(profileId: string, id: string): Promise<IpcResult<AgentMemoryFact[]>>
    clearMemory(profileId: string): Promise<IpcResult<AgentMemoryFact[]>>
    /** Agent 事件流（正文增量 / 工具调用 / 结束） */
    onEvent(cb: (e: AgentRunEvent) => void): Unsub
    /** 主进程请求在当前可见终端里执行一条命令 */
    onToolExec(cb: (req: AgentToolExecRequest) => void): Unsub
  }

  app: {
    openExternal(url: string): Promise<IpcResult<boolean>>
    reveal(path: string): Promise<IpcResult<boolean>>
    pickFile(title?: string): Promise<IpcResult<{ path: string | null }>>
    info(): Promise<IpcResult<AppInfo>>
  }
}

export type { CommandHint }
