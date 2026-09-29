/**
 * 终端目录跟踪 —— 向远端交互式 shell 注入一段提示符钩子。
 *
 * 原理：shell 每次打印提示符前，用 OSC 7 序列上报当前工作目录
 *     ESC ] 7 ; file://<host><path> ST
 * 渲染层解析该序列后，把文件面板切到同一个目录，实现
 * 「终端 cd 到哪，右边文件列表就跟到哪」。
 *
 * 为什么要注入：bash / zsh 默认都不发 OSC 7，而远端不可能让我们改配置。
 * 这是 FinalShell / Tabby / VS Code 这类工具的通用做法：只在当前会话里
 * 挂一个只读的提示符钩子，不装任何服务端插件，不改磁盘上的任何文件。
 *
 * 注入分两步（必须分开，否则 tty 会在 stty -echo 生效之前就把整段脚本回显出来，
 * 因为回显发生在字符到达行规程的那一刻，跟 shell 有没有读到无关）：
 *   ① 发送 ` stty -echo 2>/dev/null`，等远端把回显关掉
 *      —— 下一段输出到达即视为「已执行」（shell 执行完会打印新提示符）
 *   ② 发送钩子脚本 + 收尾（此时回显已关，这两行不会出现在屏幕上）
 *      收尾用 ANSI 擦掉 ① 留下的那行字，并把终端回显恢复
 *
 * 行首统一加一个空格：Debian / Ubuntu 默认的 ~/.bashrc 带
 * HISTCONTROL=ignoreboth，这类命令不会进 history。
 */

/** 远端 printf 需要的是字面量反斜杠，用 String.raw 避免被 TS 提前吃掉 */
const ESC = String.raw`\033`
const BS = String.raw`\\`
const CR = String.raw`\r`
const D = '$'

/** 钩子函数名，同时用作「是否已注入」的幂等标记 */
const FN = '__es_cwd'

/** ① 只做一件事：关掉终端回显（很短，也会被 ② 擦掉） */
const LINE_ECHO_OFF = ` stty -echo 2>/dev/null`

/**
 * ② 钩子脚本本体（一行，POSIX 语法，bash / zsh / dash / busybox ash 通吃）
 *    - bash：挂到 PROMPT_COMMAND（保留用户已有的那个）
 *    - zsh ：挂到 precmd_functions
 *    - 其它（dash / ash）：塞进 PS1，靠命令替换触发
 *    三个分支都先判重，重复注入不会叠加。
 */
const HOOK =
  ` ${FN}(){ printf '${ESC}]7;file://%s%s${ESC}${BS}' "${D}{HOSTNAME:-h}" "${D}{PWD}"; };` +
  ` if [ -n "${D}BASH_VERSION" ]; then` +
  `   case "${D}PROMPT_COMMAND" in *${FN}*) ;; *) PROMPT_COMMAND="${FN}${D}{PROMPT_COMMAND:+;${D}PROMPT_COMMAND}";; esac;` +
  ` elif [ -n "${D}ZSH_VERSION" ]; then` +
  `   case "${D}{precmd_functions-}" in *${FN}*) ;; *) precmd_functions+=( ${FN} );; esac;` +
  ` else` +
  `   case "${D}PS1" in *${FN}*) ;; *) PS1='${D}(${FN})'"${D}PS1";; esac;` +
  ` fi`

/** ③ 擦掉 ① 的回显（2 行：命令本身 + 它打出的提示符），然后恢复回显 */
const FINISH = ` printf '${ESC}[2K${CR}${ESC}[1A${ESC}[2K${CR}'; stty echo 2>/dev/null`

/** 供本地语法自检使用 */
export const INTEGRATION_PAYLOAD = {
  echoOff: LINE_ECHO_OFF,
  hook: HOOK,
  finish: FINISH
}

/** 远端登录横幅刷完之后，安静多久就动手注入 */
const QUIET_MS = 700
/** 用户停手多久之后，才认为「可以插话注入」 */
export const USER_IDLE_MS = 1500
/** 被用户输入挡回来时的重试间隔（必须大于 USER_IDLE_MS，否则每次都还判定为忙） */
const DEFER_MS = 2000
/** 连续被挡多久就彻底收手（遇到一直在敲的用户，别去打断他） */
const MAX_DEFER_MS = 12000

type Phase = 'idle' | 'muted' | 'done'

/**
 * 注入状态机。由 ssh-manager 在打开 shell 通道后创建，
 * 每收到一段远端输出调用 onOutput()，通道关闭时调用 abort()。
 */
export class ShellIntegration {
  private phase: Phase = 'idle'
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 第一次因为用户正在输入而推迟的时刻，用来给「一直敲」兜一个放弃上限 */
  private deferSince = 0

  constructor(
    private readonly write: (data: string) => void,
    /**
     * 用户此刻是否正在敲键盘。
     *
     * 注意这里问的是「**用户**在不在打字」，程序注入（Agent 命令、文件面板的 cd、
     * 补全插入）不算 —— 早期把两者混为一谈，结果 Agent 一执行命令就等价于替用户
     * 敲了键，钩子被永久放弃，整条会话的目录跟随全部失效。
     */
    private readonly busy: () => boolean
  ) {
    // 兜底：即使远端一直没有输出（比如登录横幅是空的），也要在 6s 内完成
    this.fallbackTimer = setTimeout(() => this.step1(), 6000)
  }

  get done(): boolean {
    return this.phase === 'done'
  }

  /** 远端有输出时调用 */
  onOutput(): void {
    if (this.phase === 'done') return
    if (this.phase === 'muted') {
      // 回显已关：这段输出就是 stty 执行完打出的提示符，立刻进入第 ② 步
      this.step2()
      return
    }
    if (this.busy()) {
      this.defer()
      return
    }
    // 登录横幅 / motd 还在刷，等它安静下来再动手
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => this.step1(), QUIET_MS)
  }

  /** 通道关闭等情况下的收尾：若已经把回显关掉了，必须补回来 */
  abort(): void {
    if (this.phase === 'muted') {
      try {
        this.write(` stty echo 2>/dev/null\r`)
      } catch {
        /* 通道可能已经没了 */
      }
    }
    this.finish()
  }

  /**
   * 用户正在输入，先让一让。
   *
   * 以前这里直接放弃注入，代价是「连上服务器就顺手敲了一句命令」的会话从此再也
   * 没有目录跟随（用户完全不知道发生了什么）。钩子脚本本身是幂等的（三重判重），
   * 晚一点注入没有任何副作用，所以改成等用户停手再补上。
   */
  private defer(): void {
    this.clearTimers()
    const now = Date.now()
    if (!this.deferSince) this.deferSince = now
    if (now - this.deferSince >= MAX_DEFER_MS) return this.finish()
    this.quietTimer = setTimeout(() => this.step1(), DEFER_MS)
  }

  private step1(): void {
    if (this.phase !== 'idle') return
    this.clearTimers()
    if (this.busy()) return this.defer()
    this.phase = 'muted'
    this.safeWrite(`${LINE_ECHO_OFF}\r`)
    // 远端如果对 stty 完全没反应（没有 tty、没有 stty），别卡死在这
    this.fallbackTimer = setTimeout(() => this.step2(), 1500)
  }

  private step2(): void {
    if (this.phase !== 'muted') return
    this.clearTimers()
    this.phase = 'done'
    // 回显已关，这两行不会出现在屏幕上；第 ③ 行负责把回显恢复
    this.safeWrite(`${HOOK}\r`)
    this.safeWrite(`${FINISH}\r`)
  }

  private finish(): void {
    this.clearTimers()
    this.phase = 'done'
  }

  private clearTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    this.quietTimer = null
    this.fallbackTimer = null
  }

  private safeWrite(data: string): void {
    try {
      this.write(data)
    } catch {
      this.finish()
    }
  }
}
