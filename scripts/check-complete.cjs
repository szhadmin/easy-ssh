/**
 * 补全引擎自检（纯逻辑，不碰网络）。
 *
 * 先编译再跑：
 *   npx tsc -p scripts/tsconfig.check.json
 *   node scripts/check-complete.cjs
 *
 * 断言重点就是用户提出的那几件事：
 *   · 目录补完能继续往下钻（/var/lo → /var/log/ → /var/log/nginx）
 *   · docker 这类命令要接得住子命令、选项、选项取值
 *   · 筛选条件（--filter status=running）要能提示
 *   · 候选太多时把「总数」交给界面，由界面决定展示全部
 */

const {
  planCompletion,
  applyCompletion,
  tokenizeLine,
  splitPathToken,
  walkSpec,
  firstCommandIndex,
  SPECS
} = require('../.tmp-check-cjs/src/renderer/src/lib/complete.js')

const CTX = {
  remoteCommands: ['nginx', 'htop', 'jq', 'docker-compose', 'systemctl'],
  cwd: '/root',
  home: '/root'
}

/** 模拟在行尾按 Tab */
const plan = (line, override) =>
  planCompletion({ line, remoteCommands: CTX.remoteCommands, cwd: CTX.cwd, home: CTX.home, ...override })

const vals = (p) => p.items.map((i) => i.value)
const has = (p, v) => vals(p).includes(v)

let pass = 0
let fail = 0

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

function eq(name, got, want) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  ok(name, a === b, `got  ${a}\n      want ${b}`)
}

function section(title) {
  console.log(`\n— ${title} —`)
}

/* ============================================================ 分词 */

section('分词')

eq('普通参数切分', (() => {
  const t = tokenizeLine('cd /var/lo')
  return [t.tokens, t.trailingSpace]
})(), [['cd', '/var/lo'], false])

eq('行尾空格 = 正在开新 token', (() => {
  const t = tokenizeLine('docker ps ')
  return [t.tokens, t.trailingSpace]
})(), [['docker', 'ps'], true])

eq('引号内的空格不切', tokenizeLine('grep -rn "error log" /var').tokens, [
  'grep',
  '-rn',
  'error log',
  '/var'
])

eq('未闭合引号会被识别', tokenizeLine('journalctl --since "1 hour ').openQuote, '"')

eq('空行不报错', tokenizeLine('').tokens, [])

/* ========================================================= 路径拆分 */

section('路径 token 拆分')

eq('/var/lo', (() => { const p = splitPathToken('/var/lo'); return [p.dir, p.base, p.absolute] })(), ['/var/', 'lo', true])
eq('/var/log/（已进目录）', (() => { const p = splitPathToken('/var/log/'); return [p.dir, p.base, p.dirOnly] })(), ['/var/log/', '', true])
eq('~/doc', (() => { const p = splitPathToken('~/doc'); return [p.dir, p.base, p.tilde] })(), ['~/', 'doc', true])
eq('相对路径 logs', (() => { const p = splitPathToken('logs'); return [p.dir, p.base] })(), ['', 'logs'])

/* ====================================================== 命令名补全 */

section('命令名补全')

ok('doc → docker', has(plan('doc'), 'docker'), `got ${JSON.stringify(vals(plan('doc')).slice(0, 8))}`)
ok(
  'doc 的第一条是裸命令名 docker（不是 docker ps 这种示例）',
  vals(plan('doc'))[0] === 'docker',
  JSON.stringify(vals(plan('doc')).slice(0, 6))
)
ok('带参数的示例写法也还在（tail -f 类）', has(plan('tail'), 'tail -f'), JSON.stringify(vals(plan('tail')).slice(0, 6)))
ok('空行列出可用命令（只给词典里的命令名，不刷远端 4000 条）', vals(plan('')).length > 20 && vals(plan('')).length < 200, `got ${vals(plan('')).length}`)
ok('服务器上的命令也参与（jq）', has(plan('j'), 'jq'), `got ${JSON.stringify(vals(plan('j')))}`)

/* ==================================================== 子命令补全 */

section('子命令补全（原来完全接不上）')

const dockerSubs = plan('docker ')
ok('docker␣ 出子命令', ['ps', 'images', 'exec', 'run'].every((s) => has(dockerSubs, s)), `got ${JSON.stringify(vals(dockerSubs).slice(0, 12))}`)
ok('docker p → ps / pull / push', ['ps', 'pull', 'push'].every((s) => has(plan('docker p'), s)))
ok('docker compose␣ 出 compose 子命令', ['up', 'down', 'logs', 'ps'].every((s) => has(plan('docker compose '), s)))
ok('docker compose logs 是三级', plan('docker compose logs ').title.includes('compose logs'), plan('docker compose logs ').title)
ok('systemctl␣ 出服务动作', ['status', 'restart', 'reload'].every((s) => has(plan('systemctl '), s)))
ok('git␣ 出 git 子命令', ['status', 'log', 'push', 'checkout'].every((s) => has(plan('git '), s)))

/* ====================================================== 选项补全 */

section('选项补全（docker ps -a 这类）')

const psOpts = plan('docker ps -')
ok('docker ps - 出 -a / -q / --filter / --format', ['-a', '-q', '--filter', '--format'].every((v) => has(psOpts, v)), `got ${JSON.stringify(vals(psOpts))}`)
ok('docker ps␣ 直接给选项（位置参数用尽后回落到选项）', has(plan('docker ps '), '-a'))
ok('docker ps -- 只出长选项', vals(plan('docker ps --')).every((v) => v.startsWith('--')), `got ${JSON.stringify(vals(plan('docker ps --')))}`)

const used = plan('docker ps -a -')
ok('已写过的 -a 不再重复提示', !has(used, '-a'), `got ${JSON.stringify(vals(used))}`)
ok('但 --filter 还在', has(used, '--filter'))

ok('docker run - 出 -d/-p/-v/--name', ['-d', '-p', '-v', '--name'].every((v) => has(plan('docker run -'), v)))
ok('ls -la␣ 之后仍然补路径', plan('ls -la ').need?.kind === 'path', JSON.stringify(plan('ls -la ').need))

/* ================================================ 选项取值 / 筛选条件 */

section('选项取值（--filter 这类原来不接的）')

const f = plan('docker ps --filter ')
ok('--filter␣ 给筛选条件', ['status=running', 'status=exited', 'name=', 'label='].every((v) => has(f, v)), `got ${JSON.stringify(vals(f).slice(0, 10))}`)
ok('--filter stat → status=running', has(plan('docker ps --filter stat'), 'status=running'))
ok('--filter status=e → status=exited', has(plan('docker ps --filter status=e'), 'status=exited'))

ok('docker logs --tail 需要一个数字（不瞎猜）', vals(plan('docker logs --tail ')).length === 0, `got ${JSON.stringify(vals(plan('docker logs --tail ')))}`)
ok('docker logs --tail 200␣ 转去补容器名', plan('docker logs --tail 200 ').need?.kind === 'container')
ok('docker logs --filter 不存在也不炸', Array.isArray(vals(plan('docker logs '))))

ok('journalctl -u␣ 补服务名', plan('journalctl -u ').need?.kind === 'service')
ok('journalctl --since␣ 给时间示例', has(plan('journalctl --since '), '1 hour ago'))

/* ==================================================== 参数类型补全 */

section('位置参数类型')

ok('docker exec␣ → 容器', plan('docker exec ').need?.kind === 'container')
ok('docker exec -it␣ → 容器', plan('docker exec -it ').need?.kind === 'container')
ok('docker rm -f␣ → 容器', plan('docker rm -f ').need?.kind === 'container')
ok('docker stop␣ → 容器', plan('docker stop ').need?.kind === 'container')
ok('docker exec myapp␣ → 输入命令（不再乱猜容器）', plan('docker exec myapp ').emptyHint.includes('直接输入'))
ok('docker run␣ → 镜像', plan('docker run ').need?.kind === 'image')
ok('docker run -d -p 8080:80␣ → 还是镜像（-p 的值没被算成位置参数）', plan('docker run -d -p 8080:80 ').need?.kind === 'image', JSON.stringify(plan('docker run -d -p 8080:80 ').need))
ok('systemctl restart␣ → 服务', plan('systemctl restart ').need?.kind === 'service')
ok('kill␣ → 进程 PID', plan('kill ').need?.kind === 'process')
ok('pkill␣ → 进程名', plan('pkill ').need?.kind === 'procname')
ok('chown␣ → 用户', plan('chown ').need?.kind === 'user')
ok('ssh -p 2222␣ → 主机', plan('ssh -p 2222 ').need?.kind === 'host')
ok('git push origin␣ → 分支（带上终端当前目录）', plan('git push origin ').need?.kind === 'branch' && plan('git push origin ').need.arg === '/root', JSON.stringify(plan('git push origin ').need))
ok('git checkout␣ → 分支', plan('git checkout ').need?.kind === 'branch')

section('权限模式是静态候选')

ok('chmod␣ 给常用组合', has(plan('chmod '), '755') && has(plan('chmod '), '644'))
ok('chmod 6 过滤到 6xx', vals(plan('chmod 6')).every((v) => v.startsWith('6')), `got ${JSON.stringify(vals(plan('chmod 6')))}`)
ok('chmod 755␣ → 路径', plan('chmod 755 ').need?.kind === 'path')

section('包装命令透传（sudo / watch / xargs）')

ok('sudo␣ → 补命令名', has(plan('sudo '), 'docker') || has(plan('sudo '), 'ls'), `got ${JSON.stringify(vals(plan('sudo ')).slice(0, 6))}`)
ok('sudo systemctl restart␣ → 服务（透传到内层）', plan('sudo systemctl restart ').need?.kind === 'service', JSON.stringify(plan('sudo systemctl restart ').need))
ok('sudo -u root systemctl␣ → 服务动作（-u 的值不被当命令）', has(plan('sudo -u root systemctl '), 'restart'), JSON.stringify(vals(plan('sudo -u root systemctl ')).slice(0, 6)))
ok('watch -n 2␣ → 命令名', vals(plan('watch -n 2 ')).length > 0)
ok('time ls␣ → 路径', plan('time ls ').need?.kind === 'path')

/* ================================================== 路径补全（核心） */

section('路径补全：补完能继续往下钻')

const p1 = plan('cd /var/lo')
ok('cd /var/lo → 去列 /var', p1.need?.kind === 'path' && p1.need.arg === '/var', JSON.stringify(p1.need))

const p2 = plan('cd /var/log/')
ok('cd /var/log/ → 去列 /var/log', p2.need?.arg === '/var/log', JSON.stringify(p2.need))

const p3 = plan('cd ')
ok('cd␣ → 列终端当前目录', p3.need?.arg === '/root', JSON.stringify(p3.need))
ok('cd␣ 附赠 .. 和 ~', has(p3, '..') && has(p3, '~'))

ok('cd sub/di → 相对路径按 cwd 拼', plan('cd sub/di').need?.arg === '/root/sub', JSON.stringify(plan('cd sub/di').need))
ok('cd ~/do → 家目录展开', plan('cd ~/do').need?.arg === '/root', JSON.stringify(plan('cd ~/do').need))
ok('cd /␣ → 根目录', plan('cd /').need?.arg === '/', JSON.stringify(plan('cd /').need))

const noCwd = plan('cd ', { cwd: undefined })
ok('cwd 未知时不崩，回落成 .', noCwd.need?.arg === '.', JSON.stringify(noCwd.need))

ok('未知命令按路径补（./deploy.sh␣）', plan('./deploy.sh ').need?.kind === 'path')
ok('未知命令 + 选项 → 老实说没数据', vals(plan('nginx -')).length === 0)

/* =========================================== 远端数据回填成候选 */

section('远端数据回来之后怎么变成候选')

const dir = [
  { value: 'log', desc: '目录', isDir: true },
  { value: 'local', desc: '目录', isDir: true },
  { value: 'lost+found', desc: '目录', isDir: true },
  { value: 'lockfile', desc: '1.2 KB' }
]
const builtVals = plan('cd /var/lo').build(dir).map((b) => b.value)
eq(
  '补出来的是「整段 token」，目录自动补尾斜杠',
  builtVals.slice().sort(),
  ['/var/local/', '/var/log/', '/var/lockfile', '/var/lost+found/'].sort()
)
const builtDirs = plan('cd /var/lo').build(dir)
ok('目录排在文件前面', builtDirs[builtDirs.length - 1].value === '/var/lockfile', JSON.stringify(builtVals))
ok('不匹配的前缀被过滤掉', !builtVals.some((v) => v.includes('lockfile/')), JSON.stringify(builtVals))
eq('base 为空时不过滤（/var/ 下列全部）', plan('cd /var/').build(dir).length, 4)

const nextLine = applyCompletion('cd /var/lo', plan('cd /var/lo'), '/var/log/')
eq('补完只是替换当前 token', nextLine, 'cd /var/log/')
const nextPlan = planCompletion({ line: nextLine + 'ng', ...CTX })
eq('补完能接着往下钻：/var/log/ng → /var/log', [nextPlan.need.kind, nextPlan.need.arg], ['path', '/var/log'])
eq('再补一次得到完整路径', applyCompletion('cd /var/log/ng', nextPlan, '/var/log/nginx/'), 'cd /var/log/nginx/')

section('写回命令行时的细节')

eq('前面的引号原样保留', applyCompletion('grep -rn "error log" /va', plan('grep -rn "error log" /va'), '/var/'), 'grep -rn "error log" /var/')
eq('目录补完不加空格（好继续钻）', applyCompletion('cd /var', plan('cd /var'), '/var/'), 'cd /var/')
eq('文件补完加空格', applyCompletion('cat /etc/hos', plan('cat /etc/hos'), '/etc/hosts'), 'cat /etc/hosts ')
eq('选项补完加空格', applyCompletion('docker ps -', plan('docker ps -'), '-a'), 'docker ps -a ')
eq(
  '含空格的值自动加单引号',
  applyCompletion('docker ps --format ', plan('docker ps --format '), String.raw`table {{.Names}}\t{{.Status}}`),
  String.raw`docker ps --format 'table {{.Names}}\t{{.Status}}' `
)
eq('未闭合引号内补全会补上收尾引号', applyCompletion('journalctl --since "1 hour ', plan('journalctl --since "1 hour '), '1 hour ago'), 'journalctl --since "1 hour ago" ')

/* ================================================== 规格表健全性 */

section('规格表健全性')

const badOpts = []
for (const [cmd, spec] of Object.entries(SPECS)) {
  for (const o of spec.opts ?? []) if (!o.name.startsWith('-') && !o.name.startsWith('+')) badOpts.push(`${cmd} ${o.name}`)
}
eq('所有选项都已 - 或 + 开头', badOpts, [])

const emptySubs = Object.entries(SPECS).filter(([, s]) => s.subs && s.subs.length === 0)
eq('没有空的子命令表', emptySubs.map(([c]) => c), [])

// docker 的每个二级子命令都应该能在三级里被走到
const dockerWalk = walkSpec(SPECS.docker, ['compose', 'logs'])
eq('docker compose logs 能被 walk 到', dockerWalk.subNames, ['compose', 'logs'])
eq('docker run -d -p 8080:80 的位置参数计数正确', walkSpec(SPECS.docker, ['run', '-d', '-p', '8080:80']).positionalCount, 0)
eq('docker run -d nginx 的位置参数计数正确', walkSpec(SPECS.docker, ['run', '-d', 'nginx']).positionalCount, 1)
eq('firstCommandIndex: sudo systemctl → 1', firstCommandIndex(SPECS.sudo, ['systemctl']), 1)
eq('firstCommandIndex: sudo -u root systemctl → 3', firstCommandIndex(SPECS.sudo, ['-u', 'root', 'systemctl']), 3)
eq('firstCommandIndex: sudo␣ → -1', firstCommandIndex(SPECS.sudo, []), -1)

/* ============================================================ 收尾 */

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
