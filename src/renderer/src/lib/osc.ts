/**
 * 从终端输出流里提取 shell 上报的当前目录。
 *
 * 序列格式（OSC 7，业界通用）：
 *     ESC ] 7 ; file://<host><path> BEL
 *     ESC ] 7 ; file://<host><path> ESC \
 * 终止符有 BEL 和 ST 两种，不同 shell 用的不一样，两种都要认。
 *
 * 注意：数据是按网络分片到达的，一个序列完全可能被切成两半
 * （甚至切在 ESC 和 `]` 之间），所以内部要保留「还没收全的尾巴」，
 * 与下一片拼起来再解析。
 */

const ESC = '\u001b'
const BEL = '\u0007'
const PREFIX = `${ESC}]7;`

/** 尾巴最多留多少字符，防止异常数据把内存撑爆 */
const MAX_TAIL = 4096

function decode(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    // 路径里有裸 % 之类的非法转义，原样使用
    return p
  }
}

/**
 * 创建一个有状态的扫描器。
 * 每次 feed 一段终端输出，返回解析到的目录（没有新目录时返回 null）。
 */
export interface AgentTerminalResult {
  runId: string
  output: string
  exitCode: number
}

/** 从 OSC 500 边界间截取 Agent 单步命令的终端输出，支持网络分片。 */
export function createAgentResultScanner(): (chunk: string) => AgentTerminalResult | null {
  let active: { runId: string; output: string } | null = null
  let tail = ''
  return (chunk: string): AgentTerminalResult | null => {
    let s = tail + chunk
    tail = ''
    for (;;) {
      const start = s.indexOf(`${ESC}]500;EASYSSH_AGENT:`)
      if (start < 0) {
        if (active) active.output += s
        else tail = s.slice(-64)
        break
      }
      const end = s.indexOf(BEL, start)
      if (end < 0) {
        if (active) active.output += s.slice(0, start)
        tail = s.slice(start)
        break
      }
      if (active) active.output += s.slice(0, start)
      const marker = s.slice(start + `${ESC}]500;EASYSSH_AGENT:`.length, end)
      s = s.slice(end + 1)
      const begin = /^([^:]+):START$/.exec(marker)
      const finish = /^([^:]+):END:(\d+)$/.exec(marker)
      if (begin) {
        active = { runId: begin[1], output: '' }
        continue
      }
      if (finish && active?.runId === finish[1]) {
        const result = { runId: active.runId, output: active.output, exitCode: Number(finish[2]) }
        active = null
        return result
      }
    }
    if (tail.length > MAX_TAIL) tail = tail.slice(-MAX_TAIL)
    return null
  }
}

export function createCwdScanner(): (chunk: string) => string | null {
  let tail = ''

  return (chunk: string): string | null => {
    const s = tail + chunk
    let found: string | null = null
    let consumed = 0

    for (;;) {
      const start = s.indexOf(PREFIX, consumed)
      if (start < 0) break

      const bel = s.indexOf(BEL, start)
      const st = s.indexOf(`${ESC}\\`, start)

      let payloadEnd: number
      let next: number
      if (bel >= 0 && (st < 0 || bel < st)) {
        payloadEnd = bel
        next = bel + 1
      } else if (st >= 0) {
        payloadEnd = st
        next = st + 2
      } else {
        // 序列还没收全，留到下一片再拼
        consumed = start
        break
      }

      const payload = s.slice(start + PREFIX.length, payloadEnd)
      // file://<host>/<path>：host 部分忽略（可能是空串），只取路径
      const m = /^file:\/\/[^/]*(\/[\s\S]*)$/.exec(payload)
      if (m) found = decode(m[1])

      consumed = next
    }

    // 只有「未闭合的序列 / 孤立的 ESC」需要留到下一片，其余全部丢弃
    let keep = s.length
    const lastEsc = s.lastIndexOf(ESC)
    if (lastEsc >= consumed) {
      const rest = s.slice(lastEsc)
      if (rest.indexOf(BEL) < 0 && rest.indexOf(`${ESC}\\`) < 0) keep = lastEsc
    }

    tail = s.slice(keep)
    if (tail.length > MAX_TAIL) tail = tail.slice(-MAX_TAIL)

    return found
  }
}
