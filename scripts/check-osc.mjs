/**
 * OSC 7 解析器 + Agent 哨兵扫描器自检。
 * 重点分别是「序列被网络分片切断的各种切法」和「同一行里既有回显标记又有真实标记」。
 */
import {
  createCwdScanner,
  createAgentResultScanner,
  stripAnsi
} from '../.tmp-check/renderer/src/lib/osc.js'

const ESC = '\u001b'
const BEL = '\u0007'
const ST = `${ESC}\\`
const seq = (path, term = BEL) => `${ESC}]7;file://mock${path}${term}`

let pass = 0
let fail = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`)
}

// 1. BEL 结尾，整段到达
let s = createCwdScanner()
check('BEL 终止 · 单次送达', s(seq('/root')), '/root')

// 2. ST 结尾
s = createCwdScanner()
check('ST 终止 · 单次送达', s(seq('/var/log', ST)), '/var/log')

// 3. 混在普通输出里
s = createCwdScanner()
check('混在普通输出中', s(`hello\r\n${seq('/etc')}root@x:~# `), '/etc')

// 4. 逐字符切（最极端的分片）
s = createCwdScanner()
let got = null
for (const ch of seq('/usr/local/bin')) got = s(ch) ?? got
check('逐字符分片', got, '/usr/local/bin')

// 5. 切在 ESC 和 ] 之间
s = createCwdScanner()
check('切在 ESC 与 ] 之间（前半）', s(`${ESC}`), null)
check('切在 ESC 与 ] 之间（后半）', s(`]7;file://mock/opt${BEL}`), '/opt')

// 6. 切在终止符之前
s = createCwdScanner()
check('切在终止符前（前半）', s(`${ESC}]7;file://mock/srv`), null)
check('切在终止符前（后半）', s(`${BEL}xxx`), '/srv')

// 7. 百分号编码
s = createCwdScanner()
check('百分号编码路径', s(seq('/home/my%20dir')), '/home/my dir')

// 8. 无 host（file:///path）
s = createCwdScanner()
check('省略 host', s(`${ESC}]7;file:///tmp${BEL}`), '/tmp')

// 9. 同一片里两次上报：取最后一次
s = createCwdScanner()
check('同一片两次上报', s(`${seq('/a')}${seq('/b')}`), '/b')

// 10. 与 OSC 标题序列混排，不应误伤
s = createCwdScanner()
check('不误伤 OSC 0 标题', s(`${ESC}]0;my title${BEL}${seq('/data')}`), '/data')

// 11. 只有噪声时不应有产出，且内存不涨（尾巴被清干净）
s = createCwdScanner()
let noisy = null
for (let i = 0; i < 50; i++) noisy = s('x'.repeat(1024)) ?? noisy
check('纯噪声不产出', noisy, null)

// 12. 序列后面还有一大段输出，尾巴不能把已消费的内容留着重复解析
s = createCwdScanner()
check('后接长输出', s(`${seq('/one')}${'y'.repeat(500)}`), '/one')
check('下一片无序列', s('z'.repeat(100)), null)

/* ------------------------------------------------------------------
 * Agent 单步命令的哨兵扫描器
 *
 * 这是「终端早就跑完、Agent 却干等 90 秒」那个 bug 的核心：
 * 哨兵是拼进**要键入的命令行**里的，bash readline 会把 ESC 当 meta 前缀吞掉，
 * 所以标记必须是纯 ASCII。同时 PTY 会把整条命令行回显出来，
 * 回显里也含标记字面量 —— 扫描器必须能区分「回显」和「真实打印」。
 * ------------------------------------------------------------------ */

const TOKEN = 'ABCD2345EF'
const START = `__EASYSSH_AGENT_${TOKEN}_START__`
const END = `__EASYSSH_AGENT_${TOKEN}_END__`
/** 模拟真实 shell：PTY 回显出来的那一整行（printf 的 \n 是字面量，%s 未展开） */
const echoLine = `printf '\\n${START}\\n'; { df -h; }; __easyssh_rc=$?; printf '\\n${END}%s\\n' "$__easyssh_rc"\r\n`

// 13. 常规：先回显整行，再由命令真正打印标记与输出
let a = createAgentResultScanner()
check('回显整行时不提前收结果', a(echoLine), null)
check('真实 START + 输出 + END 一次送达', a(`\n${START}\nFilesystem  87% /\n\n${END}0\n`), {
  token: TOKEN,
  output: '\nFilesystem  87% /\n\n',
  exitCode: 0
})

// 14. 静默：回显关闭（stty -echo）时只有真实标记
a = createAgentResultScanner()
check('无回显时直接收结果', a(`${START}\n/dev/sda1 87%\n${END}0\n`), {
  token: TOKEN,
  output: '\n/dev/sda1 87%\n',
  exitCode: 0
})

// 15. 回显与真实标记在同一片里（PTY 合并写是常态）
a = createAgentResultScanner()
const merged = `${echoLine}\n${START}\nhello\n${END}0\n`
check('回显与真实标记同片到达（回显被覆盖）', a(merged), {
  token: TOKEN,
  output: '\nhello\n',
  exitCode: 0
})

// 16. 退出码非 0 要如实带回
a = createAgentResultScanner()
check('退出码 3 原样带回', a(`${START}\nboom\n${END}3\n`), {
  token: TOKEN,
  output: '\nboom\n',
  exitCode: 3
})

// 17. 标记被网络分片切开（START 中间 / END 中间都要能拼回去）
a = createAgentResultScanner()
check('切在 START 中间', a(`__EASYSSH_AGENT_ABC`), null)
check('补全后半段并给输出', a(`D2345EF_START__\ndata\n${END.slice(0, 8)}`), null)
check('再补 END 尾部与退出码（半个标记不能被当成输出吃掉）', a(`${END.slice(8)}0\n`), {
  token: TOKEN,
  output: '\ndata\n',
  exitCode: 0
})

// 17b. 逐字符切：最极端的分片也不该丢标记
a = createAgentResultScanner()
let charGot = null
for (const ch of `${START}\nchar by char\n${END}7\n`) charGot = a(ch) ?? charGot
check('逐字符分片也能收全一步', charGot, { token: TOKEN, output: '\nchar by char\n', exitCode: 7 })

// 17c. 输出里出现「像标记开头但其实是普通文本」的片段，不能被吞掉
a = createAgentResultScanner()
check('疑似标记开头但其实是普通文本', a(`${START}\n__EASYSSH_AGENT_x is not a marker\n${END}0\n`), {
  token: TOKEN,
  output: '\n__EASYSSH_AGENT_x is not a marker\n',
  exitCode: 0
})

// 18. 回显里的 `_END__%s` 不是数字开头，不能当成结束标记
a = createAgentResultScanner()
check('回显的 END__%s 不会被误判为结束', a(echoLine), null)
check('随后真实 END 才结束这一步', a(`${START}\nok\n${END}0\n`), {
  token: TOKEN,
  output: '\nok\n',
  exitCode: 0
})

// 19. 完成一步后同一个扫描器还能继续处理下一步
a = createAgentResultScanner()
check('第一步完成', a(`${START}\nonce\n${END}0\n`), { token: TOKEN, output: '\nonce\n', exitCode: 0 })
check('第二步复用同一扫描器', a(`${START}\ntwice\n${END}1\n`), { token: TOKEN, output: '\ntwice\n', exitCode: 1 })

// 20. token 不匹配的 END 不能结束当前这一步（旧一轮的标记会串到同一路输出里）
a = createAgentResultScanner()
check('外来的 END 被丢掉且不污染本步输出', a(`${START}\nkept\n__EASYSSH_AGENT_ZZZZ9999XX_END__0\nmore\n${END}0\n`), {
  token: TOKEN,
  output: '\nkept\n\nmore\n',
  exitCode: 0
})

// 21. 回填给模型的输出必须剥掉 ANSI 颜色（docker / ls --color 默认带色）
//     原样回填既浪费 token，面板里还会显示成 `[1m` 这种残渣
a = createAgentResultScanner()
check('带色的输出被剥成纯文本', a(`${START}\nrepo\u001b[1m\u001b[34m/nginx\u001b[0m  latest\n${END}0\n`), {
  token: TOKEN,
  output: '\nrepo/nginx  latest\n',
  exitCode: 0
})

// 22. stripAnsi 本身的覆盖面
check('CSI 颜色 / 样式序列', stripAnsi('\u001b[1m\u001b[31m红色\u001b[0m 普通'), '红色 普通')
check('OSC 标题序列（BEL 结尾）', stripAnsi('\u001b]0;window title\u0007text'), 'text')
check('OSC 标题序列（ST 结尾）', stripAnsi('\u001b]0;title\u001b\\text'), 'text')
check('光标移动 / 擦除序列', stripAnsi('a\u001b[2K\u001b[1Gb'), 'ab')
check('普通文本原样保留', stripAnsi('plain  text\n第二行'), 'plain  text\n第二行')

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
