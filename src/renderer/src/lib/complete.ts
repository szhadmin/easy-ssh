/**
 * 上下文感知的命令补全引擎（纯逻辑，无 React / 无 IPC）。
 *
 * 解决的问题：
 *   1. 以前只在「行内没有空格」时才补全 —— 于是 `cd /var/lo`、`docker ps -a` 全都补不了。
 *      现在按 token 逐个判定：第 0 个 token 补命令名，第 1 个补子命令，`-` 开头补选项，
 *      位置参数按类型补（路径 / 容器名 / 服务名 …）。
 *   2. 补全路径后要能继续往下导航：`cd /var/lo` → `/var/log/` → 接着 `/ng` → `/var/log/nginx`。
 *   3. 候选可能上百条，需要交给界面决定「只显示前几条 + 是否展开全部」。
 *
 * 本文件只负责「算出候选」；真实远端数据（目录 / 容器 / 服务）由调用方异步取回后回填。
 */

import { COMMAND_DICT, describe } from './commands'

/** 位置参数（或选项值）需要什么类型的候选 */
export type ValueKind =
  | 'path' // 远端文件 / 目录
  | 'container' // docker 容器名 / ID
  | 'image' // docker 镜像
  | 'service' // systemd 服务名
  | 'composeService' // docker compose 服务名
  | 'user' // 系统用户
  | 'group' // 系统用户组
  | 'branch' // git 分支
  | 'remote' // git 远端仓库名
  | 'process' // 进程（PID + 名称）
  | 'procname' // 进程名（pkill / pgrep 用）
  | 'host' // 主机名 / IP（来自 /etc/hosts）
  | 'command' // 补一个「命令名」（sudo / watch / xargs 后面那种）
  | 'mode' // 权限模式（644 / 755 …）
  | 'literal' // 由 staticValues 直接给出
  | 'none' // 这个位置没有可补的（提示用户直接输）

export interface OptionSpec {
  name: string
  desc: string
  /** 该选项后面要求一个值，值是哪种类型 */
  value?: ValueKind
  /** value === 'literal' 时直接给的候选 */
  staticValues?: string[]
}

export interface SubSpec {
  name: string
  desc: string
  /** 自己的选项（会与命令级选项合并） */
  opts?: OptionSpec[]
  /** 位置参数序列，按出现顺序取；用完则回落到该命令的 rest */
  positional?: ValueKind[]
  /** 还能再嵌一层（如 docker compose ps） */
  subs?: SubSpec[]
  /** 只吃路径/只吃名字这类没有选项的子命令，用 rest 表示剩余位置参数类型 */
  rest?: ValueKind
}

export interface CommandSpec {
  opts?: OptionSpec[]
  /** 位置参数类型序列；不足时回落到 rest */
  positional?: ValueKind[]
  rest?: ValueKind
  subs?: SubSpec[]
}

/** 一个候选补全项 */
export interface CompItem {
  /** 实际写入终端的文本（路径类会带尾斜杠） */
  value: string
  /** 显示用的文本，默认同 value */
  label?: string
  desc: string
  /** 界面上的分类：命令 / 子命令 / 选项 / 路径 / 值 */
  kind: 'cmd' | 'sub' | 'opt' | 'path' | 'value'
  danger?: boolean
  /** 是不是目录（路径补全时用来排序、决定要不要补尾斜杠） */
  isDir?: boolean
  /** 所属分组，仅用于命令名补全时的归类显示 */
  group?: string
}

/* ------------------------------------------------------------------ 分词 */

export interface LineTokens {
  tokens: string[]
  /** 每个 token 在原始行中的起始下标 */
  starts: number[]
  /** 行尾是否是一个「词尾空格」——意味着用户正在开一个新 token */
  trailingSpace: boolean
  /** 未闭合的引号字符，没有则 null */
  openQuote: string | null
}

/**
 * 按 POSIX shell 的粗略规则切词：空格分隔，单/双引号内的空格不切。
 * 不做变量展开、不做转义（`\ ` 这种少见写法按普通字符处理，最多是候选里少一条，不会出错）。
 */
export function tokenizeLine(line: string): LineTokens {
  const tokens: string[] = []
  const starts: number[] = []
  let cur = ''
  let curStart = -1
  let quote: string | null = null
  let i = 0

  const flush = (): void => {
    if (curStart >= 0) {
      tokens.push(cur)
      starts.push(curStart)
      cur = ''
      curStart = -1
    }
  }

  while (i < line.length) {
    const c = line[i]
    if (quote) {
      if (c === quote) {
        quote = null
      } else {
        cur += c
      }
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      if (curStart < 0) curStart = i
      i++
      continue
    }
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    if (curStart < 0) curStart = i
    cur += c
    i++
  }
  flush()

  return {
    tokens,
    starts,
    // 引号没闭合时，结尾的空格属于「引号里的内容」，不是在开新 token
    trailingSpace: !quote && line.length > 0 && /[ \t]$/.test(line),
    openQuote: quote
  }
}

/** 把行尾的 token 前缀取出来（含引号内的内容） */
export function splitAtCursor(line: string): { head: string; prefix: string } {
  const t = tokenizeLine(line)
  if (t.trailingSpace) return { head: line, prefix: '' }
  const start = t.starts[t.starts.length - 1] ?? line.length
  return { head: line.slice(0, start), prefix: line.slice(start) }
}

/* ------------------------------------------------- 路径 token 的拆分/拼接 */

export interface PathParts {
  /** 目录部分，不含结尾斜杠；空串表示「当前目录」 */
  dir: string
  /** 最后一个斜杠之后的前缀 */
  base: string
  /** 用 ~ 开头（需要展开成家目录） */
  tilde: boolean
  /** 以 / 开头 */
  absolute: boolean
  /** 是否以斜杠结尾（用户已经进了这一层，直接列内容） */
  dirOnly: boolean
}

/**
 * 把形如 `/var/lo`、`./sub/`、`~/doc`、`logs` 的 token 拆成「目录 + 前缀」。
 * 注意：以斜杠结尾时（用户已经进了这一层）base 必须是空串，
 * 否则 `/var/` 会被拆成 dir=`/` + base=`var`，后面全错。
 */
export function splitPathToken(token: string): PathParts {
  const dirOnly = token.endsWith('/')
  const tilde = token.startsWith('~')
  const absolute = token.startsWith('/')
  if (dirOnly) return { dir: token, base: '', tilde, absolute, dirOnly: true }
  const slash = token.lastIndexOf('/')
  const dir = slash < 0 ? '' : token.slice(0, slash + 1)
  const base = slash < 0 ? token : token.slice(slash + 1)
  return { dir, base, tilde, absolute, dirOnly: false }
}

/** 用选中的目录项拼出新的 token（目录补尾斜杠，便于继续 Tab 往下钻） */
export function joinPathToken(parts: PathParts, name: string, isDir: boolean): string {
  const head = parts.dir + name
  if (!isDir) return head
  return head + '/'
}

/* ------------------------------------------------------------ 静态知识表 */

const o = (name: string, desc: string, value?: ValueKind, staticValues?: string[]): OptionSpec => ({
  name,
  desc,
  value,
  staticValues
})

const PATH_OPTS: OptionSpec[] = [
  o('-l', '长格式：权限 / 属主 / 大小 / 时间'),
  o('-a', '包含以 . 开头的隐藏文件'),
  o('-h', '大小显示成 KB / MB 这样好读的'),
  o('-t', '按修改时间排序（新的在前）'),
  o('-S', '按文件大小排序'),
  o('-r', '反向排序'),
  o('-R', '递归进子目录'),
  o('-i', '显示 inode 编号'),
  o('-1', '每行只输出一个'),
  o('--color', '彩色输出（auto / always / never）')
]

/** 这些命令的所有位置参数都是路径 —— 一条规则覆盖 30 多个命令 */
const PATH_COMMANDS: Record<string, string> = {
  ls: '列出目录内容',
  ll: '长格式列出目录内容',
  dir: '列出目录内容',
  vdir: '长格式列出目录内容',
  cd: '切换目录',
  pushd: '切换目录并压栈',
  popd: '回到上一个目录',
  mkdir: '创建目录',
  rmdir: '删除空目录',
  rm: '删除文件或目录',
  cp: '复制文件或目录',
  mv: '移动或重命名',
  touch: '创建空文件 / 更新时间戳',
  ln: '创建链接',
  readlink: '查看软链接指向哪里',
  realpath: '输出绝对路径',
  basename: '取路径最后一段',
  dirname: '取路径的目录部分',
  stat: '查看文件详细属性',
  file: '判断文件类型',
  tree: '树状展示目录结构',
  du: '统计目录占用空间',
  cat: '输出文件全部内容',
  tac: '倒序输出文件内容',
  less: '分页查看（q 退出，/ 搜索）',
  more: '分页查看',
  nl: '输出内容并带行号',
  nano: '用 nano 编辑文件',
  vi: '用 vi 编辑文件',
  vim: '用 vim 编辑文件',
  wc: '统计行数 / 词数 / 字节数',
  diff: '比较两个文件的差异',
  cmp: '逐字节比较两个文件',
  md5sum: '计算 MD5 校验值',
  sha256sum: '计算 SHA256 校验值',
  unzip: '解压 zip',
  zip: '压缩成 zip',
  scp: '在两台机器之间复制文件（本工具已内置上传下载，一般用不上）',
  rsync: '增量同步文件'
}

const SPECS: Record<string, CommandSpec> = {}

for (const [cmd, desc] of Object.entries(PATH_COMMANDS)) {
  SPECS[cmd] = { positional: ['path'], rest: 'path' }
}
// 覆盖掉需要特殊处理的
SPECS.ls = { opts: PATH_OPTS, positional: ['path'], rest: 'path' }
SPECS.ll = { opts: PATH_OPTS, positional: ['path'], rest: 'path' }
SPECS.dir = { opts: PATH_OPTS, positional: ['path'], rest: 'path' }
SPECS.vdir = { opts: PATH_OPTS, positional: ['path'], rest: 'path' }
SPECS.cd = { positional: ['path'] }
SPECS.pushd = { positional: ['path'] }
SPECS.mkdir = { opts: [o('-p', '递归创建父目录'), o('-m', '创建时直接给权限，如 755', 'literal', ['755', '700', '750'])], positional: ['path'], rest: 'path' }
SPECS.rmdir = { opts: [o('-p', '父目录空了也一起删')], positional: ['path'], rest: 'path' }
SPECS.rm = {
  opts: [o('-r', '递归删除目录（危险）'), o('-f', '强制删除，不提示'), o('-i', '逐个确认'), o('-v', '显示删了什么')],
  positional: ['path'],
  rest: 'path'
}
SPECS.cp = {
  opts: [o('-r', '递归复制目录'), o('-p', '保留权限与时间'), o('-a', '归档模式（等于 -dpr）'), o('-v', '显示过程'), o('-f', '覆盖前不提示')],
  positional: ['path'],
  rest: 'path'
}
SPECS.mv = { opts: [o('-f', '覆盖前不提示'), o('-n', '不覆盖已存在的'), o('-v', '显示过程')], positional: ['path'], rest: 'path' }
SPECS.ln = { opts: [o('-s', '建软链接（最常用）'), o('-f', '已存在就覆盖')], positional: ['path'], rest: 'path' }
SPECS.less = { opts: [o('-N', '显示行号'), o('-S', '长行不折行'), o('+F', '像 tail -f 一样跟随')], positional: ['path'], rest: 'path' }
SPECS.more = { positional: ['path'], rest: 'path' }
SPECS.wc = { opts: [o('-l', '只统计行数'), o('-w', '只统计单词数'), o('-c', '只统计字节数')], positional: ['path'], rest: 'path' }
SPECS.unzip = { opts: [o('-d', '解压到指定目录', 'path'), o('-l', '只列出内容不解压'), o('-o', '覆盖已存在文件不再问'), o('-q', '安静模式')], positional: ['path'], rest: 'path' }
SPECS.zip = { opts: [o('-r', '递归压缩目录'), o('-q', '安静模式'), o('-e', '加密码')], positional: ['path'], rest: 'path' }
SPECS.rsync = { opts: [o('-a', '归档模式'), o('-v', '显示过程'), o('-z', '传输时压缩'), o('--delete', '删除目标端多余文件'), o('-n', '只试运行不实际改')], positional: ['path'], rest: 'path' }
SPECS.scp = { opts: [o('-r', '递归复制目录'), o('-P', '指定端口'), o('-i', '指定私钥', 'path')], positional: ['path'], rest: 'path' }
SPECS.tree = { opts: [o('-L', '限制展示层级，如 -L 2', 'none'), o('-a', '包含隐藏文件'), o('-d', '只显示目录'), o('-h', '大小好读')], positional: ['path'], rest: 'path' }
SPECS.du = { opts: [o('-s', '只显示合计'), o('-h', '大小好读'), o('-d', '限制深度，如 -d 1', 'none'), o('-a', '连文件也算')], positional: ['path'], rest: 'path' }

SPECS.head = { opts: [o('-n', '显示前 N 行（默认 10）', 'none'), o('-c', '显示前 N 个字节', 'none')], positional: ['path'], rest: 'path' }
SPECS.tail = {
  opts: [o('-f', '实时跟随新日志（Ctrl+C 退出）'), o('-n', '显示最后 N 行（默认 10）', 'none'), o('-F', '文件被轮转后仍跟随'), o('--pid', '跟随到指定进程结束', 'none')],
  positional: ['path'],
  rest: 'path'
}
SPECS.find = {
  opts: [
    o('-name', '按文件名匹配，支持 * 通配（注意加引号）', 'none'),
    o('-iname', '按文件名匹配，忽略大小写', 'none'),
    o('-type', '类型：f 文件 / d 目录 / l 链接', 'literal', ['f', 'd', 'l', 'b', 'c', 's', 'p']),
    o('-size', '大小条件，如 +100M / -1k', 'none'),
    o('-mtime', '修改时间条件，如 -7 表示 7 天内', 'none'),
    o('-maxdepth', '最多往下找几层', 'none'),
    o('-delete', '把找到的删掉（危险）'),
    o('-exec', '对每个结果执行命令', 'none')
  ],
  positional: ['path'],
  rest: 'path'
}
SPECS.grep = {
  opts: [
    o('-r', '递归搜索目录'),
    o('-n', '显示行号'),
    o('-i', '忽略大小写'),
    o('-v', '反向匹配：只显示不含关键字的行'),
    o('-E', '用扩展正则'),
    o('-l', '只列出包含关键字的文件名'),
    o('-c', '只统计匹配了多少行'),
    o('-A', '同时显示匹配行之后 N 行', 'none'),
    o('-B', '同时显示匹配行之前 N 行', 'none'),
    o('--include', '只搜匹配的文件名，如 "*.conf"', 'none'),
    o('--exclude', '排除匹配的文件名', 'none')
  ],
  positional: ['none', 'path'],
  rest: 'path'
}
SPECS.rgrep = SPECS.grep
SPECS.sed = {
  opts: [o('-i', '直接改原文件（建议先备份）'), o('-n', '不自动输出'), o('-e', '追加一条表达式', 'none'), o('-E', '用扩展正则')],
  positional: ['none', 'path'],
  rest: 'path'
}
SPECS.awk = { opts: [o('-F', '指定分隔符', 'literal', ['",",', '"|",', '":",'])], positional: ['none', 'path'], rest: 'path' }
SPECS.chmod = {
  opts: [o('-R', '递归应用到目录下所有内容'), o('-v', '显示改了什么'), o('--reference', '照另一个文件的权限设置')],
  positional: ['mode', 'path'],
  rest: 'path'
}
SPECS.chown = { opts: [o('-R', '递归应用到目录下所有内容'), o('-v', '显示改了什么')], positional: ['user', 'path'], rest: 'path' }
SPECS.chgrp = { opts: [o('-R', '递归')], positional: ['group', 'path'], rest: 'path' }
SPECS.useradd = {
  opts: [o('-m', '顺便创建家目录'), o('-s', '指定登录 shell'), o('-G', '附加到某个组', 'group')],
  positional: ['none'],
  rest: 'none'
}
SPECS.usermod = { opts: [o('-aG', '追加到某个组'), o('-s', '改登录 shell'), o('-L', '锁定账号'), o('-U', '解锁账号')], positional: ['user'], rest: 'none' }
SPECS.userdel = { opts: [o('-r', '连家目录一起删')], positional: ['user'], rest: 'none' }
SPECS.passwd = { positional: ['user'], rest: 'none' }
SPECS.groups = { positional: ['user'], rest: 'user' }
SPECS.id = { positional: ['user'], rest: 'user' }
SPECS.tar = {
  opts: [
    o('-c', '创建一个归档'),
    o('-x', '解开一个归档'),
    o('-t', '只列出归档里的内容'),
    o('-z', '用 gzip 压缩 / 解压'),
    o('-j', '用 bzip2'),
    o('-J', '用 xz'),
    o('-v', '显示处理过程'),
    o('-f', '指定归档文件名（后面紧跟文件名）', 'path'),
    o('-C', '先切换到某个目录再操作', 'path'),
    o('--exclude', '排除某些路径', 'path')
  ],
  positional: ['path'],
  rest: 'path'
}

/* ------------------------------------------- 系统 / 服务 / 进程 / 网络 */

const SERVICE_ACTIONS: SubSpec[] = [
  { name: 'status', desc: '查看服务运行状态', positional: ['service'], opts: [o('-l', '不截断长行')] },
  { name: 'start', desc: '启动服务', positional: ['service'] },
  { name: 'stop', desc: '停止服务', positional: ['service'] },
  { name: 'restart', desc: '重启服务（会断开已有连接）', positional: ['service'] },
  { name: 'reload', desc: '热加载配置，不断连接', positional: ['service'] },
  { name: 'enable', desc: '设为开机自启', positional: ['service'] },
  { name: 'disable', desc: '取消开机自启', positional: ['service'] },
  { name: 'is-active', desc: '判断是否正在运行', positional: ['service'] },
  { name: 'is-enabled', desc: '判断是否开机自启', positional: ['service'] },
  { name: 'mask', desc: '彻底屏蔽某个服务', positional: ['service'] },
  { name: 'unmask', desc: '解除屏蔽', positional: ['service'] }
]

SPECS.systemctl = {
  opts: [
    o('--now', '启动/停止的同时设置为开机自启/不自启'),
    o('-l', '长行不截断'),
    o('--no-pager', '不分页输出'),
    o('-a', '显示全部（含未激活的）'),
    o('--failed', '只列出失败的服务')
  ],
  positional: [],
  subs: [
    ...SERVICE_ACTIONS,
    {
      name: 'list-units',
      desc: '列出已加载的单元',
      positional: ['none'],
      opts: [
        o('--type', '单元类型，如 service', 'literal', ['service', 'socket', 'timer', 'mount', 'target', 'path', 'device']),
        o('--state', '按状态筛选', 'literal', ['running', 'failed', 'exited', 'dead', 'active', 'inactive', 'enabled', 'disabled']),
        o('--all', '包含未激活的')
      ]
    },
    { name: 'list-unit-files', desc: '列出所有单元文件', positional: ['none'] },
    { name: 'daemon-reload', desc: '改过 unit 文件后重新加载' },
    { name: 'show', desc: '查看单元的全部属性', positional: ['service'] },
    { name: 'cat', desc: '查看 unit 文件内容', positional: ['service'] },
    { name: 'list-timers', desc: '列出定时器' },
    { name: 'reset-failed', desc: '清除失败计数' }
  ]
}

SPECS.journalctl = {
  opts: [
    o('-u', '只看某个服务的日志', 'service'),
    o('-f', '实时跟随新日志'),
    o('-n', '只显示最后 N 行', 'none'),
    o('--since', '起始时间，如 "1 hour ago"', 'literal', ['1 hour ago', '30 min ago', 'today', 'yesterday', '3 days ago']),
    o('--until', '结束时间，如 "10 min ago"', 'literal', ['now', '10 min ago', 'today']),
    o('-p', '按日志级别筛选', 'literal', ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']),
    o('-r', '倒序输出（新的在前）'),
    o('-k', '只看内核日志'),
    o('-b', '只看本次启动以来的'),
    o('-x', '附带解释性说明'),
    o('-e', '直接跳到日志末尾'),
    o('--no-pager', '不分页')
  ],
  positional: []
}

SPECS.ps = {
  opts: [o('-e', '显示所有进程'), o('-f', '完整格式'), o('-u', '按用户筛选', 'user'), o('-o', '自定义输出列'), o('--sort', '排序，如 -%mem / -%cpu'), o('-p', '只看指定 PID')],
  positional: []
}
SPECS.top = { opts: [o('-d', '刷新间隔秒数'), o('-n', '刷新几次后退出'), o('-p', '只看指定 PID'), o('-u', '只看某个用户', 'user'), o('-b', '批处理模式，配合 -n 用')], positional: [] }
SPECS.htop = { opts: [o('-u', '只看某个用户', 'user'), o('-d', '刷新间隔')], positional: [] }
SPECS.kill = {
  opts: [o('-s', '指定要发的信号', 'literal', ['TERM', 'KILL', 'HUP', 'INT', 'QUIT', 'USR1', 'USR2']), o('-9', '强制杀死（SIGKILL）'), o('-15', '优雅结束（SIGTERM）'), o('-l', '列出所有信号名')],
  positional: ['process'],
  rest: 'process'
}
SPECS.killall = { opts: [o('-9', '强制杀死'), o('-s', '指定信号')], positional: ['procname'], rest: 'procname' }
SPECS.pkill = { opts: [o('-f', '匹配完整命令行'), o('-9', '强制杀死'), o('-u', '限定某个用户', 'user'), o('-x', '进程名完全匹配')], positional: ['procname'], rest: 'procname' }
SPECS.pgrep = { opts: [o('-a', '顺便显示命令行'), o('-f', '匹配完整命令行'), o('-l', '显示进程名'), o('-u', '限定某个用户', 'user'), o('-x', '完全匹配')], positional: ['procname'], rest: 'procname' }
SPECS.renice = { positional: ['none', 'process'], rest: 'process' }
SPECS.lsof = { opts: [o('-i', '按端口查，如 -i:80'), o('-p', '按 PID 查', 'process'), o('-u', '按用户查', 'user'), o('-n', '不做 DNS 反解')], positional: ['path'], rest: 'path' }
SPECS.fuser = { opts: [o('-v', '详细输出'), o('-k', '杀掉占用者')], positional: ['path'], rest: 'path' }
SPECS.df = { opts: [o('-h', '大小好读'), o('-T', '显示文件系统类型'), o('-i', '显示 inode 使用情况'), o('-P', 'POSIX 格式'), o('-a', '包含全部文件系统')], positional: ['path'], rest: 'path' }
SPECS.mount = { opts: [o('-t', '按类型过滤'), o('-o', '挂载参数')], positional: [], rest: 'path' }
SPECS.umount = { positional: ['path'], rest: 'path' }
SPECS.free = { opts: [o('-h', '好读的单位'), o('-m', '以 MB 为单位'), o('-g', '以 GB 为单位'), o('-s', '每 N 秒刷新')], positional: [] }
SPECS.uptime = { positional: [] }
SPECS.ss = { opts: [o('-t', '只看 TCP'), o('-u', '只看 UDP'), o('-l', '只看监听端口'), o('-n', '端口显示成数字'), o('-p', '显示占用端口的进程'), o('-a', '显示全部')], positional: [] }
SPECS.netstat = { opts: [o('-a', '显示全部连接'), o('-n', '不做反解'), o('-p', '显示进程'), o('-t', 'TCP'), o('-u', 'UDP'), o('-l', '监听中')], positional: [] }
SPECS.ip = {
  opts: [o('-br', '简洁输出'), o('-4', '只看 IPv4'), o('-6', '只看 IPv6'), o('-s', '显示统计')],
  positional: [],
  subs: [
    { name: 'addr', desc: '查看 / 配置网卡地址', positional: ['none'] },
    { name: 'link', desc: '查看 / 配置网卡', positional: ['none'] },
    { name: 'route', desc: '查看 / 配置路由', positional: ['none'] },
    { name: 'neigh', desc: '查看 ARP 邻居表', positional: ['none'] },
    { name: 'a', desc: 'addr 的简写', positional: ['none'] },
    { name: 'r', desc: 'route 的简写', positional: ['none'] },
    { name: 'l', desc: 'link 的简写', positional: ['none'] }
  ]
}
SPECS.ping = { opts: [o('-c', '发几个包就停，如 -c 4', 'none'), o('-i', '发包间隔秒数', 'none'), o('-W', '等待超时秒数', 'none'), o('-6', '用 IPv6')], positional: ['host'], rest: 'host' }
SPECS.traceroute = { opts: [o('-n', '不做反解'), o('-I', '用 ICMP'), o('-T', '用 TCP')], positional: ['host'], rest: 'host' }
SPECS.dig = { opts: [o('+short', '只输出结果'), o('+trace', '跟踪完整解析链路'), o('-t', '查询类型', 'literal', ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA'])], positional: ['host'], rest: 'host' }
SPECS.nslookup = { positional: ['host'], rest: 'host' }
SPECS.host = { positional: ['host'], rest: 'host' }
SPECS.whois = { positional: ['host'], rest: 'host' }
SPECS.ssh = {
  opts: [o('-p', '指定端口', 'none'), o('-i', '指定私钥文件', 'path'), o('-L', '本地端口转发'), o('-R', '远程端口转发'), o('-N', '只转发不执行命令'), o('-v', '调试输出'), o('-o', '指定选项，如 -o StrictHostKeyChecking=no')],
  positional: ['host'],
  rest: 'none'
}
SPECS.curl = {
  opts: [o('-I', '只看响应头'), o('-i', '连响应头一起输出'), o('-X', '指定请求方法', 'literal', ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']), o('-H', '加请求头，如 -H "Content-Type: application/json"', 'none'), o('-d', '发送请求体', 'none'), o('--data-raw', '发送原始请求体', 'none'), o('-o', '保存到文件', 'path'), o('-O', '用远端文件名保存到当前目录'), o('-k', '跳过证书校验'), o('-s', '安静模式'), o('-L', '跟随重定向'), o('-v', '显示详细过程'), o('-w', '输出指定格式，如 -w "%{http_code}"', 'none'), o('-F', '表单上传文件', 'none')],
  positional: ['none'],
  rest: 'none'
}
SPECS.wget = { opts: [o('-O', '保存为指定文件名', 'path'), o('-c', '断点续传'), o('-q', '安静模式'), o('--no-check-certificate', '跳过证书校验'), o('-r', '递归下载')], positional: ['none'], rest: 'none' }
SPECS.iptables = { opts: [o('-L', '列出规则'), o('-n', '不做反解'), o('-v', '详细输出'), o('-F', '清空规则（危险）'), o('-A', '追加规则'), o('-D', '删除规则'), o('-I', '插入规则'), o('-t', '指定表', 'literal', ['filter', 'nat', 'mangle', 'raw', 'security'])], positional: [] }
SPECS.ufw = {
  opts: [o('--dry-run', '只试跑不生效'), o('-v', '详细输出')],
  positional: [],
  subs: [
    { name: 'status', desc: '查看防火墙状态与规则' },
    { name: 'enable', desc: '启用防火墙（小心把自己挡在外面）' },
    { name: 'disable', desc: '关闭防火墙' },
    { name: 'reload', desc: '重新加载规则' },
    { name: 'allow', desc: '放行端口 / 服务', positional: ['none'] },
    { name: 'deny', desc: '拒绝端口 / 服务', positional: ['none'] },
    { name: 'delete', desc: '删除某条规则', positional: ['none'] },
    { name: 'reset', desc: '重置全部规则' }
  ]
}
SPECS['systemd-run'] = { positional: ['command'], rest: 'command' }
SPECS['systemd-analyze'] = {
  positional: [],
  subs: [
    { name: 'blame', desc: '启动耗时排到最慢的服务' },
    { name: 'critical-chain', desc: '看启动关键路径' },
    { name: 'time', desc: '看启动总耗时' },
    { name: 'verify', desc: '校验 unit 文件' }
  ]
}
SPECS.htpasswd = { positional: ['path', 'none'], rest: 'none' }
SPECS.openssl = { positional: ['none'], rest: 'path' }
SPECS.date = { opts: [o('-u', '显示 UTC 时间'), o('-R', 'RFC 2822 格式'), o('-d', '解析指定的时间描述')], positional: [] }
SPECS.hostname = { opts: [o('-i', '显示 IP'), o('-f', '显示完整域名')], positional: [] }
SPECS.hostnamectl = { positional: [] }
SPECS.timedatectl = { positional: [], subs: [{ name: 'status', desc: '查看时间与时区' }, { name: 'list-timezones', desc: '列出时区' }, { name: 'set-timezone', desc: '设置时区', positional: ['none'] }] }
SPECS.crontab = { opts: [o('-l', '列出当前用户的定时任务'), o('-e', '编辑定时任务'), o('-r', '删除全部定时任务（危险）'), o('-u', '指定用户', 'user')], positional: [] }
SPECS.env = { positional: ['command'], rest: 'command' }
SPECS.sudo = {
  opts: [o('-i', '切到 root 的交互 shell'), o('-u', '以指定用户执行', 'user'), o('-s', '启动一个 shell'), o('-E', '保留当前环境变量'), o('-H', '把 HOME 设成目标用户的家目录'), o('-l', '列出当前用户能执行的命令'), o('-k', '清掉密码缓存')],
  positional: ['command'],
  rest: 'command'
}
SPECS.su = { opts: [o('-', '连同环境一起切换（最常用）'), o('-c', '只执行一条命令')], positional: ['user'], rest: 'none' }
SPECS.nohup = { positional: ['command'], rest: 'command' }
SPECS.setsid = { positional: ['command'], rest: 'command' }
SPECS.time = { opts: [o('-v', '输出详细统计')], positional: ['command'], rest: 'command' }
SPECS.nice = { opts: [o('-n', '调整的优先级数值', 'none')], positional: ['command'], rest: 'command' }
SPECS.ionice = { opts: [o('-c', '调度类别 0-3', 'none'), o('-n', '优先级 0-7', 'none')], positional: ['command'], rest: 'command' }
SPECS.watch = { opts: [o('-n', '间隔秒数', 'none'), o('-d', '变化的地方高亮'), o('-t', '不显示标题')], positional: ['command'], rest: 'command' }
SPECS.xargs = { opts: [o('-0', '按 \\0 分隔'), o('-I', '用占位符替换，如 -I{}', 'none'), o('-n', '每次传几个参数', 'none'), o('-P', '并行几个进程', 'none')], positional: ['command'], rest: 'command' }
SPECS.which = { opts: [o('-a', '列出所有匹配的路径')], positional: ['command'], rest: 'command' }
SPECS.type = { positional: ['command'], rest: 'command' }
SPECS.command = { opts: [o('-v', '显示路径或类型')], positional: ['command'], rest: 'command' }
SPECS.man = { positional: ['command'], rest: 'command' }
SPECS.info = { positional: ['command'], rest: 'command' }
const PKG_OPTS: OptionSpec[] = [
  o('-y', '所有提问都自动回答 yes'),
  o('--no-install-recommends', '不安装推荐包（更干净）'),
  o('-q', '安静模式')
]
SPECS.apt = {
  opts: PKG_OPTS,
  positional: [],
  subs: [
    { name: 'update', desc: '更新软件包索引（装软件前先跑这个）' },
    { name: 'upgrade', desc: '升级已安装的软件包', opts: [o('-y', '自动确认')] },
    { name: 'install', desc: '安装软件包', opts: PKG_OPTS, positional: ['none'], rest: 'none' },
    { name: 'remove', desc: '卸载软件包（保留配置文件）', positional: ['none'], rest: 'none' },
    { name: 'purge', desc: '卸载并删除配置文件', positional: ['none'], rest: 'none' },
    { name: 'autoremove', desc: '清理不再被依赖的包', opts: [o('-y', '自动确认')] },
    { name: 'search', desc: '搜索软件包', positional: ['none'], rest: 'none' },
    { name: 'show', desc: '查看软件包详细信息', positional: ['none'], rest: 'none' },
    { name: 'list', desc: '列出软件包', opts: [o('--upgradable', '只看可以升级的')] },
    { name: 'clean', desc: '清理已下载的安装包缓存' },
    { name: 'dist-upgrade', desc: '完整升级（可能会装/删包）' },
    { name: 'full-upgrade', desc: '完整升级' }
  ]
}
SPECS['apt-get'] = SPECS.apt
SPECS.yum = {
  opts: PKG_OPTS,
  positional: [],
  subs: [
    { name: 'install', desc: '安装软件包', positional: ['none'], rest: 'none' },
    { name: 'remove', desc: '卸载软件包', positional: ['none'], rest: 'none' },
    { name: 'update', desc: '升级软件包' },
    { name: 'upgrade', desc: '升级软件包（含内核）' },
    { name: 'search', desc: '搜索软件包', positional: ['none'], rest: 'none' },
    { name: 'info', desc: '查看软件包信息', positional: ['none'], rest: 'none' },
    { name: 'list', desc: '列出软件包' },
    { name: 'repolist', desc: '列出软件源' },
    { name: 'clean', desc: '清理缓存' },
    { name: 'makecache', desc: '重建元数据缓存' }
  ]
}
SPECS.dnf = SPECS.yum
SPECS.apk = {
  positional: [],
  subs: [
    { name: 'add', desc: '安装软件包（Alpine）', positional: ['none'], rest: 'none' },
    { name: 'del', desc: '卸载软件包', positional: ['none'], rest: 'none' },
    { name: 'update', desc: '更新索引并升级' },
    { name: 'upgrade', desc: '升级已安装的包' },
    { name: 'search', desc: '搜索软件包', positional: ['none'], rest: 'none' },
    { name: 'info', desc: '查看软件包信息', positional: ['none'], rest: 'none' },
    { name: 'list', desc: '列出软件包' }
  ]
}

/* ---------------------------------------------------------------- Docker */

/** docker ps --filter 后面能跟的筛选条件（新手最缺的就是这个） */
const DOCKER_FILTERS: string[] = [
  'status=running',
  'status=exited',
  'status=created',
  'status=paused',
  'status=restarting',
  'status=dead',
  'health=healthy',
  'health=unhealthy',
  'name=',
  'id=',
  'label=',
  'ancestor=nginx',
  'before=',
  'since=',
  'volume=',
  'network=bridge',
  'publish=',
  'expose=',
  'is-task=true',
  'dangling=true',
  'reference='
]

const DOCKER_FORMAT: string[] = [
  String.raw`table {{.Names}}\t{{.Status}}\t{{.Ports}}`,
  String.raw`table {{.ID}}\t{{.Image}}\t{{.RunningFor}}`,
  '{{.Names}}',
  '{{.ID}}',
  '{{.Image}}',
  '{{.Status}}',
  '{{.Ports}}',
  '{{.Size}}',
  '{{.Mounts}}',
  '{{.Networks}}',
  '{{.Labels}}',
  '{{.Repository}}:{{.Tag}}'
]

const DOCKER_LOG_OPTS: OptionSpec[] = [
  o('-f', '实时跟随新日志（Ctrl+C 退出）'),
  o('--tail', '只看最后 N 行', 'none'),
  o('-t', '每行前面加时间戳'),
  o('--since', '从这个时间之后开始', 'literal', ['1h', '30m', '10m', '2026-01-01']),
  o('--until', '只看到这个时间为止', 'literal', ['now', '10m', '1h']),
  o('--details', '显示额外细节')
]

const DOCKER_EXEC_OPTS: OptionSpec[] = [
  o('-i', '保持标准输入打开'),
  o('-t', '分配一个终端'),
  o('-it', '等价于 -i -t（进容器最常用）'),
  o('-d', '在后台执行'),
  o('-u', '以指定用户执行', 'user'),
  o('-w', '指定工作目录', 'path'),
  o('-e', '传入环境变量', 'none'),
  o('--privileged', '给容器内进程全部权限'),
  o('--entrypoint', '覆盖镜像的入口点')
]

const dockerContainerSubs: SubSpec[] = [
  { name: 'ps', desc: '查看容器列表', opts: [
    o('-a', '连已停止的容器一起显示'),
    o('-q', '只输出容器 ID（常用于管道）'),
    o('-s', '显示容器占用的大小'),
    o('-l', '只看最近创建的那一个'),
    o('-n', '只看最近创建的 N 个', 'none'),
    o('--filter', '按条件筛选，如 status=running', 'literal', DOCKER_FILTERS),
    o('--format', '自定义输出列', 'literal', DOCKER_FORMAT),
    o('--no-trunc', '不截断长内容'),
    o('--size', '显示容器占用大小')
  ], positional: [] },
  { name: 'images', desc: '查看本地镜像列表', opts: [
    o('-a', '连中间层镜像一起显示'),
    o('-q', '只输出镜像 ID'),
    o('--filter', '按条件筛选，如 dangling=true', 'literal', DOCKER_FILTERS),
    o('--format', '自定义输出列', 'literal', DOCKER_FORMAT),
    o('--digests', '显示镜像摘要'),
    o('--no-trunc', '不截断内容')
  ], positional: [] },
  { name: 'exec', desc: '在运行中的容器里执行命令', opts: DOCKER_EXEC_OPTS, positional: ['container', 'none'], rest: 'none' },
  { name: 'logs', desc: '查看容器日志', opts: DOCKER_LOG_OPTS, positional: ['container'], rest: 'container' },
  { name: 'restart', desc: '重启容器', opts: [o('-t', '等几秒再强杀', 'none')], positional: ['container'], rest: 'container' },
  { name: 'stop', desc: '停止容器', opts: [o('-t', '等几秒再强杀', 'none')], positional: ['container'], rest: 'container' },
  { name: 'start', desc: '启动已停止的容器', positional: ['container'], rest: 'container' },
  { name: 'pause', desc: '暂停容器（冻结进程）', positional: ['container'], rest: 'container' },
  { name: 'unpause', desc: '恢复被暂停的容器', positional: ['container'], rest: 'container' },
  { name: 'kill', desc: '强制结束容器', opts: [o('-s', '指定发送的信号', 'literal', ['SIGKILL', 'SIGTERM', 'SIGHUP'])], positional: ['container'], rest: 'container' },
  { name: 'rm', desc: '删除容器（要先停止）', opts: [o('-f', '连运行中的一起强删'), o('-v', '顺便删掉匿名数据卷'), o('-l', '删的是链接而不是容器')], positional: ['container'], rest: 'container' },
  { name: 'inspect', desc: '查看容器 / 镜像的完整配置 JSON', opts: [o('-f', '用模板只取某个字段'), o('-s', '显示文件大小'), o('--type', '指定对象类型', 'literal', ['container', 'image', 'network', 'volume', 'task'])], positional: ['container'], rest: 'container' },
  { name: 'stats', desc: '看容器实时资源占用（Ctrl+C 退出）', opts: [o('-a', '连已停止的也列出来'), o('--no-stream', '只取一次快照就退出'), o('--format', '自定义输出列', 'literal', DOCKER_FORMAT)], positional: ['container'], rest: 'container' },
  { name: 'top', desc: '查看容器里跑的进程', positional: ['container'], rest: 'container' },
  { name: 'port', desc: '查看容器的端口映射', positional: ['container'], rest: 'container' },
  { name: 'diff', desc: '查看容器改了哪些文件', positional: ['container'], rest: 'container' },
  { name: 'attach', desc: '附加到容器的主进程（Ctrl+P Ctrl+Q 脱离）', positional: ['container'], rest: 'container' },
  { name: 'wait', desc: '等容器退出并输出退出码', positional: ['container'], rest: 'container' },
  { name: 'rename', desc: '给容器改名', positional: ['container', 'none'], rest: 'none' },
  { name: 'update', desc: '改运行中容器的资源限制', opts: [o('--memory', '内存上限，如 512m'), o('--cpus', 'CPU 核数上限'), o('--restart', '重启策略', 'literal', ['no', 'always', 'on-failure', 'unless-stopped'])], positional: ['container'], rest: 'container' },
  { name: 'cp', desc: '在容器和宿主机之间复制文件', positional: ['path'], rest: 'path' },
  { name: 'commit', desc: '把容器当前状态存成新镜像', opts: [o('-m', '提交信息'), o('-a', '作者')], positional: ['container', 'none'], rest: 'none' },
  { name: 'export', desc: '把容器文件系统导出成 tar', opts: [o('-o', '写到文件', 'path')], positional: ['container'], rest: 'container' },
  { name: 'run', desc: '创建并启动一个新容器', opts: [
    o('-d', '在后台运行'),
    o('-i', '保持标准输入打开'),
    o('-t', '分配一个终端'),
    o('-it', '-i -t 组合，进容器最常用'),
    o('--name', '给容器起个名字', 'none'),
    o('-p', '端口映射，格式 宿主机端口:容器端口', 'literal', ['80:80', '8080:80', '443:443', '3306:3306', '6379:6379', '9200:9200']),
    o('-v', '挂载目录 / 卷，格式 宿主机路径:容器路径', 'path'),
    o('-e', '传入环境变量', 'literal', ['TZ=Asia/Shanghai', 'LANG=C.UTF-8', 'SPRING_PROFILES_ACTIVE=prod']),
    o('--env-file', '从文件读环境变量', 'path'),
    o('--rm', '容器退出后自动删除'),
    o('--network', '接入哪个网络', 'none'),
    o('-w', '容器内的工作目录', 'path'),
    o('-u', '用哪个用户运行', 'user'),
    o('--restart', '重启策略', 'literal', ['no', 'always', 'on-failure', 'unless-stopped']),
    o('--entrypoint', '覆盖镜像入口点', 'none'),
    o('--privileged', '给容器全部权限（慎用）'),
    o('-m', '内存上限，如 512m', 'none'),
    o('--cpus', 'CPU 核数上限，如 1.5', 'none'),
    o('--hostname', '容器主机名', 'none'),
    o('--label', '给容器打标签', 'none'),
    o('--log-driver', '日志驱动', 'literal', ['json-file', 'local', 'journald', 'syslog', 'none'])
  ], positional: ['image', 'none'], rest: 'none' },
  { name: 'rmi', desc: '删除镜像', opts: [o('-f', '强制删除'), o('--no-prune', '保留没打标签的父镜像')], positional: ['image'], rest: 'image' },
  { name: 'pull', desc: '拉取镜像', opts: [o('-q', '安静模式'), o('--platform', '指定平台', 'literal', ['linux/amd64', 'linux/arm64'])], positional: ['image'], rest: 'image' },
  { name: 'push', desc: '推送镜像到仓库', positional: ['image'], rest: 'image' },
  { name: 'tag', desc: '给镜像打标签', positional: ['image', 'none'], rest: 'none' },
  { name: 'save', desc: '把镜像导出成 tar 文件', opts: [o('-o', '写到指定文件', 'path')], positional: ['image'], rest: 'image' },
  { name: 'load', desc: '从 tar 文件导入镜像', opts: [o('-i', '从指定文件读', 'path'), o('-q', '安静模式')], positional: ['path'], rest: 'path' },
  { name: 'history', desc: '查看镜像的构建历史', positional: ['image'], rest: 'image' },
  { name: 'build', desc: '用 Dockerfile 构建镜像', opts: [
    o('-t', '镜像名:标签', 'none'),
    o('-f', '指定 Dockerfile 路径', 'path'),
    o('--no-cache', '不用构建缓存'),
    o('--build-arg', '传构建参数', 'none'),
    o('--target', '只构建到某个阶段', 'none'),
    o('--platform', '目标平台', 'literal', ['linux/amd64', 'linux/arm64']),
    o('--pull', '每次都重新拉基础镜像')
  ], positional: ['path'], rest: 'path' },
  { name: 'search', desc: '在仓库里搜镜像', positional: ['none'], rest: 'none' }
]

SPECS.docker = {
  opts: [
    o('-H', '指定 Docker 守护进程地址'),
    o('--context', '使用的上下文'),
    o('--log-level', '日志级别', 'literal', ['debug', 'info', 'warn', 'error', 'fatal']),
    o('-D', '打开调试输出')
  ],
  positional: [],
  subs: [
    ...dockerContainerSubs,
    { name: 'compose', desc: 'Docker Compose（v2 插件）', subs: [
      { name: 'up', desc: '创建并启动全部服务', opts: [o('-d', '后台运行'), o('--build', '启动前先重新构建镜像'), o('--force-recreate', '强制重建容器'), o('-f', '指定 compose 文件', 'path')], positional: ['none'], rest: 'none' },
      { name: 'down', desc: '停止并删除全部服务与网络', opts: [o('-v', '连数据卷一起删（危险）'), o('--rmi', '连镜像一起删', 'literal', ['all', 'local'])], positional: [] },
      { name: 'ps', desc: '查看 compose 项目里的容器状态', positional: [] },
      { name: 'logs', desc: '查看 compose 项目日志', opts: [o('-f', '实时跟随'), o('--tail', '只看最后 N 行', 'none')], positional: ['composeService'], rest: 'composeService' },
      { name: 'restart', desc: '重启服务', positional: ['composeService'], rest: 'composeService' },
      { name: 'stop', desc: '停止服务', positional: ['composeService'], rest: 'composeService' },
      { name: 'start', desc: '启动服务', positional: ['composeService'], rest: 'composeService' },
      { name: 'build', desc: '构建服务镜像', positional: ['composeService'], rest: 'composeService' },
      { name: 'pull', desc: '拉取服务镜像', positional: ['composeService'], rest: 'composeService' },
      { name: 'exec', desc: '在服务容器里执行命令', positional: ['composeService', 'none'], rest: 'none' },
      { name: 'run', desc: '起一个一次性容器跑命令', positional: ['composeService', 'none'], rest: 'none' },
      { name: 'config', desc: '校验并打印合并后的配置' },
      { name: 'top', desc: '查看各服务的进程' },
      { name: 'ls', desc: '列出本机的 compose 项目' }
    ] },
    { name: 'system', desc: 'Docker 系统级操作', subs: [
      { name: 'df', desc: '看镜像 / 容器 / 卷各占多少磁盘', opts: [o('-v', '详细模式')] },
      { name: 'prune', desc: '清理没在用的容器、网络、悬空镜像', opts: [o('-a', '连没在用的镜像一起清'), o('-f', '不再问确认'), o('--volumes', '连数据卷一起清（危险）')] },
      { name: 'info', desc: '查看 Docker 引擎信息' },
      { name: 'events', desc: '实时输出引擎事件', opts: [o('--since', '从这个时间之后', 'literal', ['1h', '30m']), o('--until', '只看到这个时间为止')] }
    ] },
    { name: 'container', desc: '容器管理（新式子命令，等价于上面的简写）', subs: [
      { name: 'ls', desc: '列出容器', opts: [o('-a', '含已停止的')], positional: [] },
      { name: 'start', desc: '启动容器', positional: ['container'], rest: 'container' },
      { name: 'stop', desc: '停止容器', positional: ['container'], rest: 'container' },
      { name: 'restart', desc: '重启容器', positional: ['container'], rest: 'container' },
      { name: 'rm', desc: '删除容器', opts: [o('-f', '强制删除运行中的')], positional: ['container'], rest: 'container' },
      { name: 'logs', desc: '查看日志', opts: DOCKER_LOG_OPTS, positional: ['container'], rest: 'container' },
      { name: 'exec', desc: '在容器内执行命令', opts: DOCKER_EXEC_OPTS, positional: ['container', 'none'], rest: 'none' },
      { name: 'inspect', desc: '查看容器详情', positional: ['container'], rest: 'container' },
      { name: 'prune', desc: '清理所有已停止的容器', opts: [o('-f', '不再问确认')] }
    ] },
    { name: 'image', desc: '镜像管理（新式子命令）', subs: [
      { name: 'ls', desc: '列出镜像', positional: [] },
      { name: 'rm', desc: '删除镜像', opts: [o('-f', '强制删除')], positional: ['image'], rest: 'image' },
      { name: 'pull', desc: '拉取镜像', positional: ['image'], rest: 'image' },
      { name: 'push', desc: '推送镜像', positional: ['image'], rest: 'image' },
      { name: 'inspect', desc: '查看镜像详情', positional: ['image'], rest: 'image' },
      { name: 'build', desc: '构建镜像', opts: [o('-t', '镜像名:标签', 'none'), o('-f', 'Dockerfile 路径', 'path')], positional: ['path'], rest: 'path' },
      { name: 'prune', desc: '清理没在用的镜像', opts: [o('-a', '连没打标签的也清')] }
    ] },
    { name: 'volume', desc: '数据卷管理', subs: [
      { name: 'ls', desc: '列出数据卷', positional: [] },
      { name: 'create', desc: '创建数据卷', positional: ['none'], rest: 'none' },
      { name: 'rm', desc: '删除数据卷', opts: [o('-f', '强制删除')], positional: ['none'], rest: 'none' },
      { name: 'inspect', desc: '查看数据卷详情', positional: ['none'], rest: 'none' },
      { name: 'prune', desc: '清理没被使用的数据卷', opts: [o('-f', '不再问确认')] }
    ] },
    { name: 'network', desc: '网络管理', subs: [
      { name: 'ls', desc: '列出网络', positional: [] },
      { name: 'create', desc: '创建网络', positional: ['none'], rest: 'none' },
      { name: 'rm', desc: '删除网络', positional: ['none'], rest: 'none' },
      { name: 'inspect', desc: '查看网络详情', positional: ['none'], rest: 'none' },
      { name: 'connect', desc: '把容器接进某个网络', positional: ['container'], rest: 'container' },
      { name: 'disconnect', desc: '把容器移出某个网络', positional: ['container'], rest: 'container' },
      { name: 'prune', desc: '清理没在用的网络' }
    ] },
    { name: 'version', desc: '查看客户端与服务端版本' },
    { name: 'info', desc: '查看 Docker 引擎信息' },
    { name: 'login', desc: '登录镜像仓库', positional: ['none'], rest: 'none' },
    { name: 'logout', desc: '退出镜像仓库', positional: ['none'], rest: 'none' },
    { name: 'events', desc: '实时输出引擎事件' }
  ]
}

/* -------------------------------------------------------------------- Git */

SPECS.git = {
  opts: [o('-C', '先把工作目录切到指定路径', 'path'), o('--no-pager', '不分页输出'), o('-c', '临时覆盖某个配置项')],
  positional: [],
  subs: [
    { name: 'status', desc: '查看工作区状态（最常用）', opts: [o('-s', '简洁输出'), o('-b', '顺便显示分支')] },
    { name: 'log', desc: '查看提交历史', opts: [o('--oneline', '每次提交压成一行'), o('--graph', '画分支图'), o('-n', '只看最近几条', 'none'), o('--stat', '显示改了哪些文件'), o('-p', '显示具体改动'), o('--all', '包含所有分支'), o('--author', '只看某个人提交的')] },
    { name: 'diff', desc: '查看还没提交的改动', opts: [o('--cached', '看已暂存的改动'), o('--stat', '只看统计'), o('--name-only', '只列文件名')] },
    { name: 'add', desc: '把改动放进暂存区', opts: [o('-A', '暂存全部改动'), o('-u', '只暂存已跟踪过的文件'), o('-p', '逐块挑选')], positional: ['path'], rest: 'path' },
    { name: 'commit', desc: '提交暂存区的改动', opts: [o('-m', '直接给提交信息'), o('-a', '连已跟踪文件的改动一起提交'), o('--amend', '修改上一次提交'), o('--no-verify', '跳过提交钩子')] },
    { name: 'push', desc: '把本地提交推到远端', opts: [o('-u', '同时建立上游追踪'), o('-f', '强制推送（会覆盖远端）'), o('--tags', '连标签一起推')], positional: ['none', 'branch'], rest: 'branch' },
    { name: 'pull', desc: '拉取并合并远端改动', opts: [o('--rebase', '用变基而不是合并'), o('--ff-only', '只允许快进合并')], positional: ['none', 'branch'], rest: 'branch' },
    { name: 'fetch', desc: '只拉取不合并', opts: [o('--all', '拉取全部远端'), o('-p', '清理已删除的远端分支')], positional: ['none'], rest: 'none' },
    { name: 'checkout', desc: '切换分支 / 还原文件', opts: [o('-b', '新建并切过去')], positional: ['branch'], rest: 'path' },
    { name: 'switch', desc: '切换分支（新式写法）', opts: [o('-c', '新建并切过去'), o('-', '切回上一个分支')], positional: ['branch'], rest: 'branch' },
    { name: 'branch', desc: '列出 / 管理分支', opts: [o('-a', '连远端分支一起列'), o('-d', '删除已合并的分支'), o('-D', '强制删除分支'), o('-m', '重命名分支')], positional: ['branch'], rest: 'branch' },
    { name: 'merge', desc: '合并某个分支进来', opts: [o('--no-ff', '即使能快进也生成合并提交'), o('--abort', '放弃这次合并')], positional: ['branch'], rest: 'branch' },
    { name: 'rebase', desc: '把当前分支变基到目标分支', opts: [o('--continue', '解决冲突后继续'), o('--abort', '放弃这次变基')], positional: ['branch'], rest: 'branch' },
    { name: 'reset', desc: '回退提交 / 取消暂存', opts: [o('--soft', '只回退提交，改动保留在暂存区'), o('--mixed', '默认：改动保留在工作区'), o('--hard', '连改动一起丢掉（危险）')], positional: ['none'], rest: 'none' },
    { name: 'stash', desc: '临时收起当前改动', positional: [], subs: [{ name: 'list', desc: '看有哪些暂存' }, { name: 'pop', desc: '恢复最近一次暂存' }, { name: 'apply', desc: '恢复但不删除记录' }, { name: 'drop', desc: '丢掉某次暂存' }] },
    { name: 'remote', desc: '管理远端仓库', opts: [o('-v', '显示远端地址')], positional: [], subs: [{ name: 'add', desc: '添加远端', positional: ['none', 'none'] }, { name: 'remove', desc: '删除远端', positional: ['remote'] }, { name: 'set-url', desc: '改远端地址', positional: ['remote', 'none'] }, { name: 'show', desc: '查看远端详情', positional: ['remote'] }] },
    { name: 'clone', desc: '克隆一个仓库', opts: [o('-b', '检出指定分支'), o('--depth', '浅克隆层数', 'none'), o('--recursive', '连子模块一起')], positional: ['none', 'path'], rest: 'path' },
    { name: 'restore', desc: '还原文件改动（丢弃未提交的修改）', opts: [o('--staged', '从暂存区还原'), o('--source', '从指定提交还原')], positional: ['path'], rest: 'path' },
    { name: 'tag', desc: '给提交打标签', opts: [o('-a', '创建带说明的标签'), o('-d', '删除标签'), o('-l', '列出标签')], positional: ['none'], rest: 'none' },
    { name: 'show', desc: '查看某次提交的详情', positional: ['none'], rest: 'path' },
    { name: 'config', desc: '读写 git 配置', positional: ['none', 'none'], rest: 'none' },
    { name: 'init', desc: '把当前目录变成 git 仓库' },
    { name: 'rm', desc: '从 git 里删除文件', opts: [o('-r', '递归'), o('--cached', '只从索引里删，保留本地文件')], positional: ['path'], rest: 'path' },
    { name: 'mv', desc: '移动 / 重命名并告知 git', positional: ['path'], rest: 'path' },
    { name: 'reflog', desc: '查看 HEAD 移动记录（找回误删的提交）' },
    { name: 'cherry-pick', desc: '把某个提交摘到当前分支', positional: ['none'], rest: 'none' },
    { name: 'rev-parse', desc: '解析引用成提交号', positional: ['none'], rest: 'none' }
  ]
}

/* ------------------------------------------------------------ 上下文判定 */

export interface PlanInput {
  line: string
  remoteCommands: string[]
  /** 终端当前工作目录（OSC 7 上报），用于解析相对路径 */
  cwd?: string
  /** 远端家目录，用于展开 ~ */
  home?: string
}

export interface RemoteItem {
  value: string
  desc: string
  isDir?: boolean
  isSymlink?: boolean
  danger?: boolean
}

export interface Plan {
  /** 面板标题：现在在补什么 */
  title: string
  /** 一句新手向的说明 */
  note: string
  /** 不依赖远端就能给出的候选 */
  items: CompItem[]
  /** 需要异步取的数据 */
  need: { kind: ValueKind; arg: string } | null
  /** 远端数据 → 候选 */
  build: ((raw: RemoteItem[]) => CompItem[]) | null
  /** 排序时目录优先 */
  dirFirst: boolean
  /** 一条候选都没有时显示的说明 */
  emptyHint: string
  /** 当前 token 在原始行中的起始下标 */
  tokenStart: number
  /** 当前 token 处于未闭合引号内 */
  openQuote: string | null
}

export interface SpecLevel {
  opts?: OptionSpec[]
  positional?: ValueKind[]
  rest?: ValueKind
  subs?: SubSpec[]
}

export interface Walked {
  root: CommandSpec
  level: SpecLevel
  /** 命中的子命令链 */
  subNames: string[]
  usedOpts: Set<string>
  /** 已经写完的位置参数个数 */
  positionalCount: number
  /** 上一个 token 是「要取值的选项」——当前要补的就是它的值 */
  pendingOpt: OptionSpec | null
}

const KIND_TITLE: Record<string, string> = {
  path: '路径',
  container: '容器',
  image: '镜像',
  service: '服务',
  composeService: 'Compose 服务',
  user: '用户',
  group: '用户组',
  branch: '分支',
  remote: '远端仓库',
  process: '进程',
  procname: '进程名',
  host: '主机',
  command: '命令',
  mode: '权限'
}

/** chmod 常用的几组权限，新手照着选就行 */
const MODE_VALUES: Array<[string, string]> = [
  ['644', 'rw-r--r-- 普通文件（最常用）'],
  ['600', 'rw------- 仅属主可读写（密钥 / 配置）'],
  ['755', 'rwxr-xr-x 可执行文件 / 目录（最常用）'],
  ['700', 'rwx------ 仅属主可访问（.ssh 目录）'],
  ['664', 'rw-rw-r-- 同组可写'],
  ['775', 'rwxrwxr-x 同组可写可执行'],
  ['640', 'rw-r----- 同组只读'],
  ['750', 'rwxr-x--- 同组可进入'],
  ['777', 'rwxrwxrwx 所有人可读写执行（危险）']
]

const REMOTE_EMPTY: Partial<Record<ValueKind, string>> = {
  container: '没读到容器（docker 未安装 / 未启动，或当前账号没权限）',
  image: '没读到镜像（docker 未安装 / 未启动，或当前账号没权限）',
  service: '没读到服务（这台机器可能不是 systemd）',
  composeService: '没读到 compose 服务（正在跑的容器上没有 compose 标签）',
  user: '没读到用户列表',
  group: '没读到用户组',
  branch: '没读到分支（当前目录可能不是 git 仓库）',
  remote: '没读到远端仓库（当前目录可能不是 git 仓库）',
  process: '没读到进程',
  procname: '没读到进程名',
  host: '没读到主机记录（/etc/hosts 里是空的）'
}

export function joinPosix(a: string, b: string): string {
  return a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '')
}

/* -------------------------------------------------------------- 规格遍历 */

/**
 * 沿着已写完的 token 往下走：认子命令、记用过的选项、数位置参数。
 * `docker ps -a --filter status=running` 走完就知道「下一个 token 该是什么」。
 */
export function walkSpec(root: CommandSpec, tail: string[]): Walked {
  const used = new Set<string>()
  let level: SpecLevel = root
  const subNames: string[] = []
  let positionalCount = 0
  let pendingOpt: OptionSpec | null = null

  const findOpt = (name: string): OptionSpec | undefined =>
    level.opts?.find((x) => x.name === name) ?? root.opts?.find((x) => x.name === name)

  for (const raw of tail) {
    if (raw === '--') break

    if (pendingOpt) {
      pendingOpt = null
      continue
    }

    const eq = raw.indexOf('=')
    const longWithValue = raw.startsWith('--') && eq > 0
    const name = longWithValue ? raw.slice(0, eq) : raw

    if (name.startsWith('-') && name.length > 1) {
      const found = findOpt(name)
      used.add(name)
      // 只要这个选项要求取值（哪怕我们给不出候选），下一个 token 就得当值吃掉，
      // 否则位置参数会数错，后面的补全全歪。
      if (found && !longWithValue && (found.value || found.staticValues)) pendingOpt = found
      continue
    }

    if (level.subs?.length && subNames.length < 3) {
      const s = level.subs.find((x) => x.name === raw)
      if (s) {
        subNames.push(s.name)
        level = s
        continue
      }
    }
    positionalCount++
  }

  return { root, level, subNames, usedOpts: used, positionalCount, pendingOpt }
}

/** 当前要补的位置参数是什么类型 */
export function posKindAt(w: Walked): ValueKind | undefined {
  const seq = w.level.positional
  if (seq && seq.length) return seq[Math.min(w.positionalCount, seq.length - 1)]
  return w.level.rest
}

/** 「包装命令」：它们后面跟的才是真正要执行的命令，补全要透传到里面那层 */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'setsid', 'time', 'nice', 'ionice', 'watch', 'xargs'])

/**
 * 在 tail 里找出「第一个真正的命令」的位置（返回 args 中的下标，找不到返回 -1）。
 * 会跳过包装命令自己的选项、这些选项的取值，以及 env 的 KEY=VALUE 赋值。
 */
export function firstCommandIndex(root: CommandSpec, tail: string[]): number {
  let pendingValue = false
  for (let i = 0; i < tail.length; i++) {
    const raw = tail[i]
    if (raw === '--') return -1
    if (pendingValue) {
      pendingValue = false
      continue
    }
    const eq = raw.indexOf('=')
    const longWithValue = raw.startsWith('--') && eq > 0
    const name = longWithValue ? raw.slice(0, eq) : raw
    if (name.startsWith('-') && name.length > 1) {
      const found = root.opts?.find((x) => x.name === name)
      if (found && !longWithValue && (found.value || found.staticValues)) pendingValue = true
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue // env FOO=bar cmd
    return i + 1
  }
  return -1
}

/* ---------------------------------------------------------------- 候选构造 */

function commandItems(prefix: string, remoteCommands: string[]): CompItem[] {
  const q = prefix.toLowerCase()
  const out: CompItem[] = []
  const seen = new Set<string>()
  const add = (value: string, desc: string, danger?: boolean, group?: string): void => {
    if (seen.has(value)) return
    seen.add(value)
    out.push({ value, desc, kind: 'cmd', danger, group })
  }

  // 1) 先给「命令名本身」。词典里的词条大多是用法示例（docker ps / ls -alh），
  //    只抽命令名出来，这样输入 doc 能先看到 docker，再按 Tab 才去补子命令。
  const baseSeen = new Set<string>()
  for (const e of COMMAND_DICT) {
    const base = e.cmd.split(' ')[0]
    if (baseSeen.has(base)) continue
    baseSeen.add(base)
    if (q && !base.toLowerCase().startsWith(q)) continue
    add(base, describe(base) ?? e.desc, e.danger, e.group)
  }

  // 2) 带参数的常用写法（只在有前缀时给，免得空行按 Tab 刷一大片）
  if (q) {
    for (const e of COMMAND_DICT) {
      if (!e.cmd.includes(' ')) continue
      if (!e.cmd.toLowerCase().startsWith(q)) continue
      add(e.cmd, e.desc, e.danger, e.group)
    }
  }

  // 3) 服务器上真实存在的命令（同样只在有前缀时给）
  if (q) {
    for (const c of remoteCommands) {
      if (!c.toLowerCase().startsWith(q)) continue
      add(c, describe(c) ?? '服务器上的可执行命令', false, '服务器')
    }
  }

  return out
}

function literalItems(values: string[], prefix: string): CompItem[] {
  const q = prefix.toLowerCase()
  return values
    .filter((v) => v.toLowerCase().startsWith(q))
    .map((v) => ({ value: v, desc: '', kind: 'value' as const }))
}

function kindPlan(
  kind: ValueKind,
  prefix: string,
  input: PlanInput,
  base: { tokenStart: number; openQuote: string | null },
  title: string,
  note?: string
): Plan {
  if (kind === 'command') {
    return {
      ...base,
      title,
      note: note ?? '这里要填一个命令名',
      items: commandItems(prefix, input.remoteCommands),
      need: null,
      build: null,
      dirFirst: false,
      emptyHint: '没有匹配的命令'
    }
  }
  if (kind === 'mode') {
    return {
      ...base,
      title,
      note: note ?? '常用权限组合，选一个之后还能接着改',
      items: MODE_VALUES.filter(([v]) => v.startsWith(prefix)).map(([v, d]) => ({
        value: v,
        desc: d,
        kind: 'value' as const,
        danger: v === '777'
      })),
      need: null,
      build: null,
      dirFirst: false,
      emptyHint: '直接输入八进制权限也可以，例如 640'
    }
  }
  if (kind === 'literal') {
    return {
      ...base,
      title,
      note: note ?? '',
      items: [],
      need: null,
      build: null,
      dirFirst: false,
      emptyHint: '这个位置没有固定取值，直接输入即可'
    }
  }
  if (kind === 'path') return pathPlan(prefix, input, base, title, note)

  // 剩下都靠远端数据
  const arg = kind === 'branch' || kind === 'remote' ? (input.cwd ?? '') : ''
  return {
    ...base,
    title,
    note: note ?? '列表来自服务器上的实时状态',
    items: [],
    need: { kind, arg },
    dirFirst: false,
    build: (raw) => filterRemote(raw, prefix),
    emptyHint: REMOTE_EMPTY[kind] ?? '服务器上没有读到可选项'
  }
}

function filterRemote(raw: RemoteItem[], prefix: string): CompItem[] {
  const q = prefix.toLowerCase()
  return raw
    .filter((r) => r.value.toLowerCase().startsWith(q))
    .slice()
    .sort((a, b) => a.value.localeCompare(b.value))
    .map((r) => ({ value: r.value, desc: r.desc, kind: 'value' as const, danger: r.danger }))
}

function resolveRemoteDir(parts: PathParts, input: PlanInput): string {
  const strip = (p: string): string => {
    const t = p.replace(/\/+$/, '')
    return t || '/'
  }
  if (parts.tilde) {
    const rest = parts.dir.replace(/^~/, '')
    return input.home ? strip(joinPosix(input.home, rest)) : '~'
  }
  if (parts.absolute) return strip(parts.dir || '/')
  if (parts.dir) return strip(input.cwd ? joinPosix(input.cwd, parts.dir) : parts.dir)
  return input.cwd ?? '.'
}

function pathPlan(
  prefix: string,
  input: PlanInput,
  base: { tokenStart: number; openQuote: string | null },
  title: string,
  note?: string
): Plan {
  const parts = splitPathToken(prefix)
  const quick: CompItem[] = []
  // 空 token 时给两个新手最常用的「跳转」候选
  if (!parts.base && !parts.dir) {
    quick.push({ value: '..', desc: '上一级目录', kind: 'path', isDir: true })
    quick.push({ value: '~', desc: '当前用户的家目录', kind: 'path', isDir: true })
  }
  return {
    ...base,
    title,
    note:
      note ??
      (input.cwd
        ? '列表来自服务器；选目录会自动补一个 / 方便继续往下钻'
        : '还没拿到终端当前目录，相对路径会按家目录解析'),
    items: quick,
    need: { kind: 'path', arg: resolveRemoteDir(parts, input) },
    dirFirst: true,
    emptyHint: '这个目录里没有读到可显示的内容（可能没有读权限）',
    build: (raw) => {
      const q = parts.base.toLowerCase()
      return raw
        .filter((r) => r.value.toLowerCase().startsWith(q))
        .slice()
        .sort((a, b) => {
          if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1
          return a.value.localeCompare(b.value)
        })
        .map<CompItem>((r) => {
          const token = joinPathToken(parts, r.value, !!r.isDir)
          return { value: token, label: token, desc: r.desc, kind: 'path', isDir: r.isDir }
        })
    }
  }
}

function optPlan(
  w: Walked,
  prefix: string,
  nodeTitle: string,
  base: { tokenStart: number; openQuote: string | null }
): Plan {
  const seen = new Set<string>()
  const all: CompItem[] = []
  const collect = (list?: OptionSpec[]): void => {
    for (const op of list ?? []) {
      if (seen.has(op.name)) continue
      seen.add(op.name)
      if (w.usedOpts.has(op.name)) continue // 已经写过的选项不重复提示
      all.push({ value: op.name, desc: op.desc, kind: 'opt' })
    }
  }
  collect(w.level.opts)
  collect(w.root.opts)
  if (!seen.has('--help')) all.push({ value: '--help', desc: '打开该命令的帮助，看完按 q 退出', kind: 'opt' })

  const q = prefix.toLowerCase()
  const hit = all.filter((x) => x.value.toLowerCase().startsWith(q))
  return {
    ...base,
    title: `${nodeTitle} 的选项`,
    note: hit.length ? '可以连着写多个选项；补完一个继续按 Tab 会接着提示' : '没有匹配的选项',
    items: hit,
    need: null,
    build: null,
    dirFirst: false,
    emptyHint: '没有匹配的选项，直接回车执行即可'
  }
}

/* ---------------------------------------------------------------- 主入口 */

export function planCompletion(input: PlanInput): Plan {
  const line = input.line
  const tok = tokenizeLine(line)
  const prefix = tok.trailingSpace ? '' : (tok.tokens[tok.tokens.length - 1] ?? '')
  const tokenStart = tok.trailingSpace
    ? line.length
    : (tok.starts[tok.starts.length - 1] ?? line.length)
  const args = tok.trailingSpace ? tok.tokens : tok.tokens.slice(0, -1)
  const base = { tokenStart, openQuote: tok.openQuote }

  /* --- 1. 补命令名 --- */
  if (args.length === 0) {
    return {
      ...base,
      title: prefix ? `命令（前缀 ${prefix}）` : '可用命令',
      note: 'Tab / Enter 选中即写入；停在命令名后面再按 Tab，会继续提示子命令和选项',
      items: commandItems(prefix, input.remoteCommands),
      need: null,
      build: null,
      dirFirst: false,
      emptyHint: '没有匹配的命令，可以直接回车执行，或点右上角「命令手册」查一查'
    }
  }

  const cmd = args[0]
  const spec = SPECS[cmd]

  /* --- 2. 不认识的命令：按路径补（多半是在补脚本或文件） --- */
  if (!spec) {
    if (prefix.startsWith('-')) {
      return {
        ...base,
        title: `${cmd} 的选项`,
        note: '内置数据里没有这个命令，可以直接试 man 或 --help',
        items: [],
        need: null,
        build: null,
        dirFirst: false,
        emptyHint: `没有 ${cmd} 的选项数据，直接输入后回车执行`
      }
    }
    return pathPlan(prefix, input, base, `${cmd} 的参数（按路径补全）`)
  }

  /* --- 2.5 包装命令（sudo / watch / xargs…）：透传到里面那条命令 ---
     这样 `sudo systemctl restart <Tab>` 照样能提示服务名，
     而不是卡在「这里要填一个命令名」。 */
  if (WRAPPERS.has(cmd) && !tok.openQuote) {
    const idx = firstCommandIndex(spec, args.slice(1))
    if (idx > 0) {
      const inner = args.slice(idx)
      // prefix 为空说明原行是「词尾空格」，内层拼串也要保留这个尾空格，
      // 否则 'systemctl' 会被当成未完成的 token 去补命令名
      const innerLine = prefix ? [...inner, prefix].join(' ') : inner.join(' ') + ' '
      const innerPlan = planCompletion({ ...input, line: innerLine })
      // 行内定位与引号状态以原行为准
      return { ...innerPlan, tokenStart, openQuote: tok.openQuote }
    }
  }

  const w = walkSpec(spec, args.slice(1))
  const nodeTitle = cmd + (w.subNames.length ? ' ' + w.subNames.join(' ') : '')

  /* --- 3. 上一个 token 是「要取值的选项」→ 补它的值 --- */
  if (w.pendingOpt) {
    const opt = w.pendingOpt
    const title = `${opt.name} 的取值`
    if (opt.staticValues?.length) {
      return {
        ...base,
        title,
        note: opt.desc,
        items: literalItems(opt.staticValues, prefix),
        need: null,
        build: null,
        dirFirst: false,
        emptyHint: '这里没有可选项，直接输入即可'
      }
    }
    if (opt.value && opt.value !== 'none' && opt.value !== 'literal') {
      return kindPlan(opt.value, prefix, input, base, title, opt.desc)
    }
    return {
      ...base,
      title,
      note: opt.desc,
      items: [],
      need: null,
      build: null,
      dirFirst: false,
      emptyHint: `${opt.name} 后面直接输入具体值（${opt.desc}）`
    }
  }

  /* --- 4. 补子命令 --- */
  if (!prefix.startsWith('-') && w.level.subs?.length) {
    const subs = w.level.subs
      .filter((s) => s.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map<CompItem>((s) => ({ value: s.name, desc: s.desc, kind: 'sub' }))
    if (subs.length) {
      return {
        ...base,
        title: `${nodeTitle} 的子命令`,
        note: '选一个子命令，接着再按 Tab 就会提示它自己的选项',
        items: subs,
        need: null,
        build: null,
        dirFirst: false,
        emptyHint: '没有匹配的子命令'
      }
    }
  }

  /* --- 5. 位置参数 --- */
  if (!prefix.startsWith('-')) {
    const kind = posKindAt(w)
    if (kind === 'none') {
      return {
        ...base,
        title: `${nodeTitle} 的参数`,
        note: '这个位置没有现成候选，直接输入内容',
        items: [],
        need: null,
        build: null,
        dirFirst: false,
        emptyHint: `这里直接输入内容（${nodeTitle}）`
      }
    }
    if (kind) {
      return kindPlan(
        kind,
        prefix,
        input,
        base,
        `${nodeTitle} 的${KIND_TITLE[kind] ?? '参数'}`
      )
    }
  }

  /* --- 6. 选项 --- */
  return optPlan(w, prefix, nodeTitle, base)
}

/* ------------------------------------------------------------ 写回命令行 */

/**
 * 把选中的候选写回输入行：只替换光标所在的这一个 token，
 * 前面的参数原样保留（包括原来的引号与空格）。
 */
export function applyCompletion(line: string, plan: Plan, value: string): string {
  const quoteCoversToken = !!plan.openQuote && line[plan.tokenStart] === plan.openQuote
  let insert = value
  if (quoteCoversToken) {
    insert = plan.openQuote + value + plan.openQuote
  } else if (/[ \t]/.test(value)) {
    // 带空格的值（路径、格式串）必须加引号，否则会被拆成两个参数
    insert = "'" + value.replace(/'/g, "'\\''") + "'"
  }
  // 目录补完还停在结尾斜杠上，不加空格，方便继续 Tab 往下钻
  const tail = value.endsWith('/') ? '' : ' '
  return line.slice(0, plan.tokenStart) + insert + tail
}

/** 供界面/自检使用 */
export { SPECS, KIND_TITLE, MODE_VALUES }


