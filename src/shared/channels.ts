/** IPC 通道名集中定义，主进程 / preload 共用，避免字符串写错 */

export const CH = {
  // 连接配置
  CONN_LIST: 'conn:list',
  CONN_SAVE: 'conn:save',
  CONN_DELETE: 'conn:delete',
  CONN_TEST: 'conn:test',
  CONN_IMPORT: 'conn:import',
  CONN_EXPORT: 'conn:export',
  CONN_STATUSES: 'conn:statuses',

  // SSH 会话
  SSH_CONNECT: 'ssh:connect',
  SSH_DISCONNECT: 'ssh:disconnect',
  SSH_EXEC: 'ssh:exec',

  // 终端
  TERM_OPEN: 'term:open',
  TERM_WRITE: 'term:write',
  TERM_RESIZE: 'term:resize',
  TERM_CLOSE: 'term:close',

  // 文件
  FILE_HOME: 'file:home',
  FILE_LIST: 'file:list',
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_MKDIR: 'file:mkdir',
  FILE_RENAME: 'file:rename',
  FILE_CHMOD: 'file:chmod',
  FILE_REMOVE: 'file:remove',
  FILE_UPLOAD: 'file:upload',
  FILE_UPLOAD_DIR: 'file:uploadDir',
  FILE_DOWNLOAD: 'file:download',

  // 系统
  SYS_INFO: 'sys:info',
  SYS_METRICS: 'sys:metrics',
  SYS_COMMANDS: 'sys:commands',
  SYS_KILL: 'sys:kill',

  // 命令补全
  COMPL_DYNAMIC: 'compl:dynamic',

  // Docker
  DOCKER_DETECT: 'docker:detect',
  DOCKER_CONTAINERS: 'docker:containers',
  DOCKER_IMAGES: 'docker:images',
  DOCKER_ACTION: 'docker:action',
  DOCKER_LOGS: 'docker:logs',
  DOCKER_INSPECT: 'docker:inspect',
  DOCKER_STATS: 'docker:stats',
  DOCKER_EXEC: 'docker:exec',

  // 应用
  APP_OPEN_EXTERNAL: 'app:openExternal',
  APP_REVEAL: 'app:reveal',
  APP_PICK_FILE: 'app:pickFile',
  APP_INFO: 'app:info',

  // AI 助手
  AGENT_CONFIG_GET: 'agent:configGet',
  AGENT_CONFIG_SET: 'agent:configSet',
  AGENT_CONFIG_TEST: 'agent:configTest',
  AGENT_MODELS: 'agent:models',
  AGENT_CHAT: 'agent:chat',
  AGENT_ABORT: 'agent:abort'
} as const

/** 主进程 -> 渲染进程 的事件 */
export const EV = {
  TERM_DATA: 'evt:term:data',
  TERM_EXIT: 'evt:term:exit',
  TRANSFER: 'evt:transfer',
  CONN_CLOSED: 'evt:conn:closed',
  /** 意外掉线后的自动重连进度（scheduled / ok / failed） */
  CONN_RECONNECT: 'evt:conn:reconnect',
  /** AI 助手的流式增量 */
  AGENT_EVENT: 'evt:agent'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
export type EventName = (typeof EV)[keyof typeof EV]
