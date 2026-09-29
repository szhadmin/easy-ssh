/**
 * 一次性自检脚本（不随包发布）：
 *  1. 打印注入 payload 的真实字节，肉眼核对引号 / 反斜杠有没有被 TS 吃掉
 *  2. 把钩子脚本喂给 bash / sh 做语法检查（bash -n / sh -n）
 *  3. 真正跑一次钩子函数，确认能吐出合法的 OSC 7 序列
 *  4. 跑一遍状态机，确认写入顺序与次数符合预期
 */
import { INTEGRATION_PAYLOAD, ShellIntegration } from '../.tmp-check/main/shell-integration.js'
import { spawnSync } from 'node:child_process'

const { echoOff, hook, finish } = INTEGRATION_PAYLOAD

console.log('=== echoOff ===')
console.log(JSON.stringify(echoOff))
console.log('\n=== hook ===')
console.log(JSON.stringify(hook))
console.log('\n=== finish ===')
console.log(JSON.stringify(finish))

console.log('\n=== 语法检查 ===')
for (const bin of ['bash', 'sh']) {
  const r = spawnSync(bin, ['-n'], { input: hook, encoding: 'utf8' })
  const ok = r.status === 0 && !r.stderr.trim()
  console.log(`${bin} -n : ${ok ? 'OK' : 'FAIL'} ${(r.stderr || '').trim().slice(0, 500)}`)
}

const run = spawnSync('bash', ['-c', `${hook}\n__es_cwd\n`], { encoding: 'utf8' })
console.log('\n=== 执行 __es_cwd 的实际输出 ===')
console.log(JSON.stringify(run.stdout))
console.log('stderr:', JSON.stringify((run.stderr || '').slice(0, 300)))

console.log('\n=== 状态机 ===')
const writes = []
const si = new ShellIntegration((d) => writes.push(d), () => false)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
si.onOutput() // 远端第一段输出（登录横幅）—— 开始计时「安静 700ms」
await wait(900) // 安静期到了 -> 应发出 stty -echo
console.log('phase1 写入:', JSON.stringify(writes))
si.onOutput() // 远端打出新提示符 -> 应发出钩子 + 收尾
await wait(60)
console.log('写入次数:', writes.length)
writes.forEach((w, i) => console.log(`  #${i} ${JSON.stringify(w)}`))
console.log('done =', si.done)

// 用户抢在注入前敲键 -> 先让一让，等他停手再补上（钩子脚本幂等，晚注入无副作用）
let busyNow = true
const writes2 = []
const si2 = new ShellIntegration((d) => writes2.push(d), () => busyNow)
si2.onOutput()
await wait(900)
console.log('\n=== 用户还在输入时 ===')
console.log('写入次数:', writes2.length, '（期望 0，先不打扰他）', 'done =', si2.done)
busyNow = false // 用户停手
await wait(2600) // 等过一轮重试间隔（DEFER_MS = 2000）
console.log('用户停手后写入次数:', writes2.length, '（期望 3）', 'done =', si2.done)
writes2.forEach((w, i) => console.log(`  #${i} ${JSON.stringify(w).slice(0, 80)}`))
