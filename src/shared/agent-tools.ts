/**
 * 终端 Agent 的公共约定：工具名、命令校验、终端哨兵、输出截断。
 *
 * 放在 shared 下是因为两端都要用同一份定义：
 *  - 主进程：校验模型给出的工具入参、裁剪回填给模型的工具输出
 *  - 渲染层：把命令包上哨兵注入可见 PTY，再从终端流里切出这一步的输出与退出码
 * 任何一端单独改格式都会让哨兵对不上，所以只留一处定义。
 */

/** 一次任务最多允许模型发起多少步终端调用（安全阀，防止无限循环） */
export const MAX_AGENT_STEPS = 12

/** 单步输出回填给模型时的字符上限 */
export const MAX_AGENT_OUTPUT = 6000

/** 模型请求执行终端命令所使用的工具名 */
export const AGENT_TOOL_NAME = 'run_command'

/**
 * 只允许一个单行命令：拒绝多段脚本、控制字符与过长输入。
 * 返回 null 表示这条命令不被允许执行。
 */
export function sanitizeAgentCommand(raw: string): string | null {
  const command = (raw ?? '').trim()
  if (!command || command.length > 2000) return null
  if (/\r|\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) return null
  if (/\s*(?:&&|;|\|\||\n)\s*/.test(command)) return null
  return command
}

/** 保留头尾、中间省略，避免超长输出撑爆上下文 */
export function truncateAgentOutput(raw: string): string {
  const s = raw ?? ''
  if (s.length <= MAX_AGENT_OUTPUT) return s
  const head = s.slice(0, Math.floor(MAX_AGENT_OUTPUT * 0.7))
  const tail = s.slice(-Math.floor(MAX_AGENT_OUTPUT * 0.3))
  return `${head}\n\n… 输出过长，已截断 …\n\n${tail}`
}

/* ------------------------------------------------------------------ 哨兵 */

/**
 * 为什么不继续用 OSC（ESC ] 500 ; ... BEL）标定输出边界：
 *
 * 哨兵是拼进「要键入的命令行」里的，而 ESC(0x1B) 正是 readline 的 meta 前缀。
 * bash / zsh 收到 ESC 后会把它和紧随其后的字符一起当转义序列处理并吞掉，
 * 于是标记根本没按预期打印出来，扫描器永远等不到结束标记 ——
 * 表现就是「终端里命令早就跑完了，Agent 还要干等 90 秒然后报退出码 124」。
 *
 * 换成纯 ASCII 行标记后，readline 会原样透传，不需要任何 shell 特性，
 * dash / busybox ash 这类精简 shell 也一样可用。
 */
export function agentSentinelToken(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const size = 10
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto
  if (c?.getRandomValues) {
    const buf = new Uint8Array(size)
    c.getRandomValues(buf)
    return Array.from(buf, (b) => alphabet[b % alphabet.length]).join('')
  }
  let out = ''
  for (let i = 0; i < size; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

export function agentSentinelStart(token: string): string {
  return `__EASYSSH_AGENT_${token}_START__`
}

export function agentSentinelEnd(token: string): string {
  return `__EASYSSH_AGENT_${token}_END__`
}

/**
 * 把单条命令包成「开始哨兵 + 命令 + 退出码哨兵」后注入可见 PTY。
 *
 * 整行仍是最普通的 sh 语法：
 *  - printf 只负责打印标记（`\n` 用反斜杠转义写，命令行里不含任何真实控制字节）
 *  - `{ ...; }` 保留原命令语义（重定向、管道、内建命令都不受影响）
 *  - `$?` 紧跟该组之后立刻取值，末尾把退出码打印出来
 */
export function wrapAgentCommand(command: string, token: string): string {
  const start = agentSentinelStart(token)
  const end = agentSentinelEnd(token)
  return `printf '\\n${start}\\n'; { ${command}; }; __easyssh_rc=$?; printf '\\n${end}%s\\n' "$__easyssh_rc"`
}
