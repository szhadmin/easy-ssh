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

/* -------------------------------------- Agent 单步命令的输出边界扫描 */

export interface AgentTerminalResult {
  token: string
  output: string
  exitCode: number
}

/**
 * 去掉终端输出里的 ANSI 转义序列。
 *
 * docker / ls --color 之类默认带色，原样回填给模型既浪费 token 又干扰阅读
 * （面板里还会显示成 `[1m` 这种残渣）。这段输出只给模型看，不需要样式，一律剥掉。
 *
 * 只在「整段输出已收齐」之后剥，不在流式扫描过程中剥：扫描器要按位置找哨兵，
 * 边流边改会打乱分片边界。哨兵本身是纯 ASCII，不受影响。
 */
const ANSI_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** 与 @shared/agent-tools 的 agentSentinelToken 字母表保持一致（去掉了易混的 I/O） */
const START_RE = /__EASYSSH_AGENT_([A-Z2-9]{4,32})_START__/
const END_RE = /__EASYSSH_AGENT_([A-Z2-9]{4,32})_END__(\d+)/

/** 两种标记的共同前缀，用来判断「尾巴是不是半个标记」 */
const SENTINEL_PREFIX = '__EASYSSH_AGENT_'
/** 与 agentSentinelToken 一致的字母表 / 长度上限 */
const TOKEN_CHARS = /^[A-Z2-9]*$/
const TOKEN_MAX = 32
const SUFFIX_START = '_START__'
const SUFFIX_END = '_END__'

/**
 * `rest` 是不是一个「还没收全」的标记（从共同前缀开始，被截断在中间）。
 *
 * 为什么不能只看共同前缀：`..._END__` 这种形态是合法标记的前半段，
 * 但 END_RE 要求后面还得跟退出码数字，所以用正则匹配不上。
 * 如果这时把它当普通输出吃掉，后面的数字就到了「没有头」的状态，
 * 这一步永远收不到结果 —— 又变回「命令跑完了 Agent 还在等」。
 */
function isPartialSentinel(rest: string): boolean {
  if (!rest.startsWith(SENTINEL_PREFIX)) {
    // 可能是共同前缀被切断了
    return SENTINEL_PREFIX.startsWith(rest)
  }
  const body = rest.slice(SENTINEL_PREFIX.length)
  const u = body.indexOf('_')
  const tokenPart = u < 0 ? body : body.slice(0, u)
  if (tokenPart.length > TOKEN_MAX || !TOKEN_CHARS.test(tokenPart)) return false
  if (u < 0) return true // 还在 token 里
  const suffixPart = body.slice(u)
  if (SUFFIX_START.startsWith(suffixPart) || SUFFIX_END.startsWith(suffixPart)) return true
  if (suffixPart.startsWith(SUFFIX_END)) return /^\d*$/.test(suffixPart.slice(SUFFIX_END.length))
  return false
}

/**
 * s 末尾有多少字符可能是标记的一部分。
 *
 * 网络分片可能正好切在标记中间（实测很常见）。如果不管三七二十一先把半截标记
 * 收进输出，那真正的标记就再也拼不起来了 —— 表现就是「命令早跑完了，Agent 却
 * 一直等到超时」。所以宁可先押着这几个字符，等下一片到了再决定它是标记还是普通输出。
 */
function holdBack(s: string): number {
  if (!s) return 0
  const at = s.lastIndexOf(SENTINEL_PREFIX)
  if (at >= 0 && isPartialSentinel(s.slice(at))) return s.length - at
  const max = Math.min(s.length, SENTINEL_PREFIX.length - 1)
  for (let n = max; n > 0; n--) {
    if (s.endsWith(SENTINEL_PREFIX.slice(0, n))) return n
  }
  return 0
}

/**
 * 从终端输出流里切出某一步命令的输出与退出码。
 *
 * 为什么不是 OSC：哨兵要拼进「键入的命令行」，而 ESC 是 readline 的 meta 前缀，
 * 会被连同后一个字符一起吞掉 —— 那正是「终端早就跑完、Agent 却干等 90 秒」的根因。
 * 换成纯 ASCII 行标记后 readline 原样透传，不依赖任何 shell 特性。
 *
 * 需要同时应付两种到达形态：
 *  - 常规：PTY 会把整条命令行回显出来（其中含 START 字面量），之后才是命令真正打印的标记
 *  - 静默：终端关了回显，只有真正打印出来的标记
 * 所以「遇到 START 一律重置累加器」——回显那一次会被真实的那一次覆盖掉。
 * 回显里的 END 形如 `..._END__%s`，第一位不是数字，天然命中不了 END_RE。
 */
export function createAgentResultScanner(): (chunk: string) => AgentTerminalResult | null {
  let active: { token: string; output: string } | null = null
  let tail = ''
  return (chunk: string): AgentTerminalResult | null => {
    // 哨兵本身不含 CR；顺手去掉 CR，回填给模型的输出也更干净
    let s = (tail + chunk).replace(/\r/g, '')
    tail = ''
    for (;;) {
      const si = s.search(START_RE)
      const ei = s.search(END_RE)
      if (si < 0 && ei < 0) {
        // 末尾若是半个标记就先押着，别把它当成普通输出吃掉
        const hold = holdBack(s)
        const body = hold ? s.slice(0, s.length - hold) : s
        if (active) active.output += body
        else tail = s.slice(-128)
        if (hold) tail = s.slice(s.length - hold)
        break
      }
      // 先出现的先处理，才能保证「回显的 START」与「真实的 START」按顺序各复位一次
      if (si >= 0 && (ei < 0 || si < ei)) {
        if (active) active.output += s.slice(0, si)
        const m = START_RE.exec(s.slice(si))
        active = { token: m ? m[1] : '', output: '' }
        s = s.slice(si + (m ? m[0].length : 1))
        continue
      }
      if (active) active.output += s.slice(0, ei)
      const m = END_RE.exec(s.slice(ei))
      s = s.slice(ei + (m ? m[0].length : 1))
      if (active && m && active.token === m[1]) {
        const result = {
          token: active.token,
          output: stripAnsi(active.output),
          exitCode: Number(m[2])
        }
        active = null
        return result
      }
      // 标记不属于当前这一步（回显残留等），丢掉继续找
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
