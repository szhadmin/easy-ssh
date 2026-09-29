/**
 * OSC 7 解析器自检：重点是「序列被网络分片切断」的各种切法。
 */
import { createCwdScanner } from '../.tmp-check/renderer/src/lib/osc.js'

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

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
