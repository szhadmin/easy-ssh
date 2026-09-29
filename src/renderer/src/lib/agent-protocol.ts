const ESC = '\u001b'
const BEL = '\u0007'

export const MAX_AGENT_STEPS = 12
export const MAX_AGENT_OUTPUT = 6000

export interface AgentAction {
  summary: string
  command: string
}

export interface AgentFinal {
  summary: string
  conclusion: string
}

export type AgentDecision =
  | { kind: 'action'; action: AgentAction }
  | { kind: 'final'; final: AgentFinal }

/**
 * Agent 每轮仅允许一个 fenced block：bash = 下一条终端调用，final = 最终结论。
 * 未遵守协议时保守降级为 final，绝不从普通正文里猜测并执行命令。
 */
export function parseAgentDecision(text: string): AgentDecision {
  const summary = (/^\s*STEP:\s*(.+)$/mi.exec(text)?.[1] || '分析当前结果').trim().slice(0, 80)
  const final = /```final\s*\n([\s\S]*?)```/i.exec(text)
  if (final) return { kind: 'final', final: { summary, conclusion: final[1].trim() } }

  const bash = /```(?:bash|sh|shell|zsh)\s*\n([\s\S]*?)```/i.exec(text)
  if (!bash) return { kind: 'final', final: { summary, conclusion: text.trim() } }
  const command = sanitizeAgentCommand(bash[1])
  if (!command) {
    return {
      kind: 'final',
      final: { summary, conclusion: '模型返回的命令不符合单步执行协议，已停止执行。请要求 Agent 一次只调用一条单行命令。' }
    }
  }
  return { kind: 'action', action: { summary, command } }
}

/** 只允许一个单行命令，拒绝多段脚本、控制字符与过长输入。 */
export function sanitizeAgentCommand(raw: string): string | null {
  const command = raw.trim()
  if (!command || command.length > 2000) return null
  if (/\r|\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) return null
  if (/\s*(?:&&|;|\|\||\n)\s*/.test(command)) return null
  return command
}

/**
 * 通过 OSC 500 放置不可见边界。命令仍由当前可见 PTY 执行，OSC 仅用于客户端切出该步输出与退出码。
 */
export function wrapAgentCommand(command: string, runId: string): string {
  const mark = `EASYSSH_AGENT:${runId}`
  return `printf '${ESC}]500;${mark}:START${BEL}'; { ${command}; }; __easyssh_rc=$?; printf '${ESC}]500;${mark}:END:%s${BEL}' "$__easyssh_rc"`
}

export function truncateAgentOutput(raw: string): string {
  if (raw.length <= MAX_AGENT_OUTPUT) return raw
  const head = raw.slice(0, Math.floor(MAX_AGENT_OUTPUT * 0.7))
  const tail = raw.slice(-Math.floor(MAX_AGENT_OUTPUT * 0.3))
  return `${head}\n\n… 输出过长，已截断 …\n\n${tail}`
}

export function toolResultMessage(command: string, output: string, exitCode: number): string {
  return `【终端工具调用结果】\n命令：${command}\n退出码：${exitCode}\n输出：\n${truncateAgentOutput(output) || '(无输出)'}\n\n请根据此结果决定唯一下一步：继续时严格输出 STEP: + 一个 bash 代码块；结束时严格输出 \`\`\`final 代码块。`
}
