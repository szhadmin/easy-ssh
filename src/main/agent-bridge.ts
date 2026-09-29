/**
 * Agent 工具执行的「反向通道」。
 *
 * 工具本身是在主进程里被 AI SDK 调起的，但命令必须跑在**用户当前可见的那个终端**里，
 * 而终端的 xterm 实例与 PTY 输出流都在渲染层手上。所以这里做一次反向请求：
 *
 *   主进程 tool.execute ──► EV.AGENT_TOOL_EXEC ──► 渲染层
 *        ▲                                            │ 权限闸门 → 注入 PTY → 扫描输出
 *        └────────── CH.AGENT_TOOL_RESULT ◄───────────┘
 *
 * 主进程侧只负责挂起等待与超时兜底，不持有任何终端细节。
 */
import { EV } from '@shared/channels'
import { truncateAgentOutput } from '@shared/agent-tools'
import type { AgentToolExecReply, AgentToolExecRequest } from '@shared/types'

/** 兜底上限：渲染层若既不回传也不报错，超过这个时间就放行，避免整轮任务永久挂住 */
const BRIDGE_TIMEOUT_MS = 11 * 60 * 1000

type Sender = (channel: string, payload: unknown) => void

let sender: Sender | null = null

/** 由 index.ts 注入「把事件广播给渲染窗口」的能力 */
export function setBridgeSender(fn: Sender): void {
  sender = fn
}

interface Pending {
  resolve: (r: AgentToolExecReply) => void
  timer: ReturnType<typeof setTimeout>
  runId: string
}

const pending = new Map<string, Pending>()

function key(runId: string, stepId: string): string {
  return `${runId}::${stepId}`
}

function settle(
  id: string,
  reply: AgentToolExecReply
): void {
  const p = pending.get(id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(id)
  p.resolve(reply)
}

/**
 * 请渲染层在可见终端里执行一条命令。永远不会 reject ——
 * 失败、被拒、超时都会以正常的「工具结果」形态返回，让模型拿到明确反馈继续决策。
 */
export function requestToolExec(req: AgentToolExecRequest): Promise<AgentToolExecReply> {
  if (!sender) {
    return Promise.resolve({
      stepId: req.stepId,
      approved: false,
      output: '客户端未就绪：终端通道不可用，请重试。',
      exitCode: -1
    })
  }
  const id = key(req.runId, req.stepId)
  return new Promise<AgentToolExecReply>((resolve) => {
    const timer = setTimeout(() => {
      settle(id, {
        stepId: req.stepId,
        approved: false,
        output: `命令在 ${Math.round(BRIDGE_TIMEOUT_MS / 60000)} 分钟内没有回传结果，已按超时处理。`,
        exitCode: 124
      })
    }, BRIDGE_TIMEOUT_MS)
    pending.set(id, { resolve, timer, runId: req.runId })
    sender?.(EV.AGENT_TOOL_EXEC, req)
  })
}

/** 渲染层回传某一步的结果 */
export function resolveToolExec(reply: AgentToolExecReply): void {
  if (reply.runId) {
    settle(key(reply.runId, reply.stepId), reply)
    return
  }
  // 不带 runId 时按 stepId 兜底匹配（stepId 来自上游的 toolCallId，本身已足够唯一）
  for (const id of [...pending.keys()]) {
    if (id.endsWith(`::${reply.stepId}`)) {
      settle(id, reply)
      return
    }
  }
}

/** 用户中止某一轮任务：把该轮挂起的工具等待全部作废 */
export function cancelToolsOfRun(runId: string): void {
  for (const [id, p] of [...pending]) {
    if (p.runId !== runId) continue
    settle(id, {
      stepId: id.split('::')[1] ?? '',
      approved: false,
      output: '用户已停止本次任务，该命令未执行。',
      exitCode: 130
    })
  }
}

export function cancelAllTools(): void {
  for (const id of [...pending.keys()]) {
    const stepId = id.split('::')[1] ?? ''
    settle(id, { stepId, approved: false, output: '应用正在退出，该命令未执行。', exitCode: 130 })
  }
}

/** 给模型看的工具结果文本：把退出码与输出拼成一段可读的观察 */
export function formatToolObservation(reply: AgentToolExecReply): string {
  const body = truncateAgentOutput(reply.output ?? '')
  const head = `退出码：${reply.exitCode}`
  return body ? `${head}\n输出：\n${body}` : `${head}\n输出：（无）`
}
