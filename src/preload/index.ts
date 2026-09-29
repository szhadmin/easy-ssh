import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV } from '@shared/channels'
import type { EasySshApi } from '@shared/api'
import type { AgentRunEvent, AgentToolExecRequest, TransferProgress } from '@shared/types'
type Unsub = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

const api: EasySshApi = {
  connections: {
    list: () => ipcRenderer.invoke(CH.CONN_LIST),
    save: (profile: unknown, secret?: unknown) => ipcRenderer.invoke(CH.CONN_SAVE, profile, secret),
    remove: (id: string) => ipcRenderer.invoke(CH.CONN_DELETE, id),
    test: (profile: unknown, secret?: unknown) => ipcRenderer.invoke(CH.CONN_TEST, profile, secret),
    statuses: () => ipcRenderer.invoke(CH.CONN_STATUSES),
    exportFile: () => ipcRenderer.invoke(CH.CONN_EXPORT),
    importFile: () => ipcRenderer.invoke(CH.CONN_IMPORT)
  },

  ssh: {
    connect: (id: string) => ipcRenderer.invoke(CH.SSH_CONNECT, id),
    disconnect: (id: string) => ipcRenderer.invoke(CH.SSH_DISCONNECT, id),
    exec: (id: string, cmd: string, timeout?: number) =>
      ipcRenderer.invoke(CH.SSH_EXEC, id, cmd, timeout),
    onReconnect: (
      cb: (p: {
        profileId: string
        phase: 'scheduled' | 'ok' | 'failed'
        attempt: number
        delay: number
        epoch: number
      }) => void
    ): Unsub => on(EV.CONN_RECONNECT, cb)
  },

  term: {
    open: (args: unknown) => ipcRenderer.invoke(CH.TERM_OPEN, args),
    write: (termId: string, data: string, internal?: boolean) =>
      ipcRenderer.invoke(CH.TERM_WRITE, termId, data, internal === true),
    resize: (termId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(CH.TERM_RESIZE, termId, cols, rows),
    close: (termId: string) => ipcRenderer.invoke(CH.TERM_CLOSE, termId),
    onData: (cb: (p: { termId: string; data: string }) => void): Unsub => on(EV.TERM_DATA, cb),
    onExit: (
      cb: (p: { termId: string; code?: number; signal?: string; reason?: string }) => void
    ): Unsub => on(EV.TERM_EXIT, cb)
  },

  files: {
    home: (id: string) => ipcRenderer.invoke(CH.FILE_HOME, id),
    list: (id: string, path: string) => ipcRenderer.invoke(CH.FILE_LIST, id, path),
    readText: (id: string, path: string) => ipcRenderer.invoke(CH.FILE_READ, id, path),
    writeText: (id: string, path: string, content: string) =>
      ipcRenderer.invoke(CH.FILE_WRITE, id, path, content),
    mkdir: (id: string, path: string) => ipcRenderer.invoke(CH.FILE_MKDIR, id, path),
    rename: (id: string, from: string, to: string) => ipcRenderer.invoke(CH.FILE_RENAME, id, from, to),
    chmod: (id: string, path: string, mode: number) => ipcRenderer.invoke(CH.FILE_CHMOD, id, path, mode),
    remove: (id: string, path: string, isDir: boolean, recursive: boolean) =>
      ipcRenderer.invoke(CH.FILE_REMOVE, id, path, isDir, recursive),
    upload: (id: string, remoteDir: string) => ipcRenderer.invoke(CH.FILE_UPLOAD, id, remoteDir),
    uploadDir: (id: string, remoteDir: string) => ipcRenderer.invoke(CH.FILE_UPLOAD_DIR, id, remoteDir),
    download: (id: string, remotePaths: string[]) =>
      ipcRenderer.invoke(CH.FILE_DOWNLOAD, id, remotePaths),
    onProgress: (cb: (p: TransferProgress) => void): Unsub => on(EV.TRANSFER, cb),
    onClosed: (cb: (p: { profileId: string }) => void): Unsub => on(EV.CONN_CLOSED, cb)
  },

  sys: {
    info: (id: string, force?: boolean) => ipcRenderer.invoke(CH.SYS_INFO, id, force),
    metrics: (id: string) => ipcRenderer.invoke(CH.SYS_METRICS, id),
    commands: (id: string, force?: boolean) => ipcRenderer.invoke(CH.SYS_COMMANDS, id, force),
    kill: (id: string, pid: number, force?: boolean) => ipcRenderer.invoke(CH.SYS_KILL, id, pid, force)
  },

  complete: {
    dynamic: (id: string, source: string, arg?: string) =>
      ipcRenderer.invoke(CH.COMPL_DYNAMIC, id, source, arg)
  },

  docker: {
    detect: (id: string) => ipcRenderer.invoke(CH.DOCKER_DETECT, id),
    containers: (id: string) => ipcRenderer.invoke(CH.DOCKER_CONTAINERS, id),
    images: (id: string) => ipcRenderer.invoke(CH.DOCKER_IMAGES, id),
    stats: (id: string) => ipcRenderer.invoke(CH.DOCKER_STATS, id),
    action: (id: string, cid: string, act: string) =>
      ipcRenderer.invoke(CH.DOCKER_ACTION, id, cid, act),
    logs: (id: string, cid: string, tail?: number) => ipcRenderer.invoke(CH.DOCKER_LOGS, id, cid, tail),
    inspect: (id: string, cid: string) => ipcRenderer.invoke(CH.DOCKER_INSPECT, id, cid),
    exec: (id: string, cid: string, cmd: string) => ipcRenderer.invoke(CH.DOCKER_EXEC, id, cid, cmd)
  },

  agent: {
    getConfig: () => ipcRenderer.invoke(CH.AGENT_CONFIG_GET),
    setConfig: (patch: unknown, apiKey?: string) => ipcRenderer.invoke(CH.AGENT_CONFIG_SET, patch, apiKey),
    test: (override?: unknown) => ipcRenderer.invoke(CH.AGENT_CONFIG_TEST, override),
    models: (override?: unknown) => ipcRenderer.invoke(CH.AGENT_MODELS, override),
    run: (req: unknown) => ipcRenderer.invoke(CH.AGENT_RUN, req),
    toolResult: (reply: unknown) => ipcRenderer.invoke(CH.AGENT_TOOL_RESULT, reply),
    abort: (runId: string) => ipcRenderer.invoke(CH.AGENT_ABORT, runId),
    /** 跨会话长期记忆（按服务器） */
    listMemory: (profileId: string) => ipcRenderer.invoke(CH.AGENT_MEMORY_LIST, profileId),
    addMemory: (profileId: string, text: string) =>
      ipcRenderer.invoke(CH.AGENT_MEMORY_ADD, profileId, text),
    removeMemory: (profileId: string, id: string) =>
      ipcRenderer.invoke(CH.AGENT_MEMORY_REMOVE, profileId, id),
    clearMemory: (profileId: string) => ipcRenderer.invoke(CH.AGENT_MEMORY_CLEAR, profileId),
    onEvent: (cb: (e: AgentRunEvent) => void): Unsub => on(EV.AGENT_RUN_EVENT, cb),
    /** 主进程请求在渲染层当前可见的终端里执行一条命令 */
    onToolExec: (cb: (req: AgentToolExecRequest) => void): Unsub => on(EV.AGENT_TOOL_EXEC, cb)
  },

  app: {
    openExternal: (url: string) => ipcRenderer.invoke(CH.APP_OPEN_EXTERNAL, url),
    reveal: (p: string) => ipcRenderer.invoke(CH.APP_REVEAL, p),
    pickFile: (title?: string) => ipcRenderer.invoke(CH.APP_PICK_FILE, title),
    info: () => ipcRenderer.invoke(CH.APP_INFO)
  }
}

contextBridge.exposeInMainWorld('api', api)
