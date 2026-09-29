/**
 * 在真实打包产物里跑的「命令补全」端到端冒烟脚本。
 * 由 EASYSSH_SMOKE_JS 指定，executeJavaScript 执行；整体会被包进
 * `return await (<本文件内容>)`，所以必须是一个表达式 —— 不能有前置分号、不能有顶层 import。
 *
 * 覆盖的是用户提的四个点：
 *   ① 目录补完能继续往下钻：cd /var/lo → /var/log/ → 接着 ng → /var/log/nginx
 *   ② docker 后面接得住子命令与选项：docker ps + Tab → -a / --filter …
 *   ③ 筛选条件 / 选项取值：docker ps --filter + Tab → status=running …
 *   ④ 候选过多时把总数交给界面（这里核对「输入 + 真实远端数据」合出来的完整候选集）
 */
(async () => {
  const api = window.api
  const store = window.__easyssh.store
  const eng = window.__easyssh.complete
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const port = Number(window.__mockPort || 2222)

  /* ---------------------------------------------------- 1. 连上 Mock */

  const saved = await api.connections.save(
    {
      name: 'Mock 补全验证',
      host: '127.0.0.1',
      port,
      username: 'root',
      authType: 'password',
      group: '验证'
    },
    { password: 'mock' }
  )
  if (!saved.ok) return { fatal: 'save failed: ' + saved.error }
  const id = saved.data.id
  out.profileId = id

  await store.getState().refreshProfiles()
  store.getState().setActive(id)
  store.getState().setTab('terminal')
  for (let i = 0; i < 60; i++) {
    if (store.getState().statuses[id] === 'connected') break
    await sleep(200)
  }
  out.status = store.getState().statuses[id]

  // 等 OSC 7 把当前目录报上来，补全的相对路径要基于它
  for (let i = 0; i < 60; i++) {
    if (store.getState().termCwd[id]) break
    await sleep(200)
  }
  out.termCwd = store.getState().termCwd[id]

  /* ------------------------------ 2. 动态数据源（走完整 IPC + 远端） */

  const pull = async (source, arg) => {
    const r = await api.complete.dynamic(id, source, arg)
    return r.ok ? (r.data || []) : { __error: r.error }
  }
  const vals = (items) => (Array.isArray(items) ? items.map((i) => i.value) : items)

  out.sources = {
    path: vals(await pull('path', '/var')),
    container: vals(await pull('container')),
    image: vals(await pull('image')),
    service: vals(await pull('service')),
    user: vals(await pull('user')),
    process: (await pull('process')).slice(0, 3),
    host: vals(await pull('host')),
    branch: vals(await pull('branch', '/root')),
    remote: vals(await pull('remote', '/root'))
  }

  /* ------------------------ 3. 用真实远端数据跑完整补全链路（核心） */

  const ctx = { cwd: store.getState().termCwd[id], home: store.getState().termCwd[id] }
  const planOf = (line) => eng.planCompletion({ line, remoteCommands: ['nginx', 'java'], ...ctx })

  /** 复刻界面行为：拿到 plan → 拉远端 → 合出最终候选列表 */
  const completeLine = async (line) => {
    const plan = planOf(line)
    let items = plan.items
    if (plan.need) {
      const raw = await pull(plan.need.kind, plan.need.arg)
      if (Array.isArray(raw)) items = plan.build ? plan.items.concat(plan.build(raw)) : plan.items
    }
    return { plan, items, values: items.map((i) => i.value) }
  }

  // ① 目录补全 + 继续往下钻
  const step1 = await completeLine('cd /var/lo')
  out.cd1 = { title: step1.plan.title, arg: step1.plan.need && step1.plan.need.arg, values: step1.values }

  const line1 = eng.applyCompletion('cd /var/lo', step1.plan, '/var/log/')
  out.line1 = line1
  const step2 = await completeLine(line1 + 'ng')
  out.cd2 = { title: step2.plan.title, arg: step2.plan.need && step2.plan.need.arg, values: step2.values }
  out.line2 = eng.applyCompletion(line1 + 'ng', step2.plan, '/var/log/nginx/')

  // ② 子命令 / 选项
  const subs = planOf('docker ')
  out.dockerSubs = subs.items.map((i) => i.value).slice(0, 8)
  const opts = planOf('docker ps -')
  out.dockerPsOpts = opts.items.map((i) => i.value)
  const optsAfterA = planOf('docker ps -a -')
  out.dockerPsOptsAfterA = optsAfterA.items.map((i) => i.value)

  // ③ 筛选条件 / 选项取值
  const filters = planOf('docker ps --filter ')
  out.filters = filters.items.map((i) => i.value).slice(0, 6)
  out.filtersStatusE = planOf('docker ps --filter status=e').items.map((i) => i.value)

  // ④ 容器名（真实数据来自 mock docker ps）
  const containers = await completeLine('docker exec ')
  out.execCandidates = containers.values
  const logs = await completeLine('docker logs --tail 200 ')
  out.logsCandidates = logs.values
  const afterContainer = planOf('docker exec web-nginx ')
  out.afterContainerHint = afterContainer.emptyHint
  const services = await completeLine('systemctl restart ')
  out.serviceCandidates = services.values

  // 数值型选项不该瞎猜
  out.tailNoGuess = planOf('docker logs --tail ').items.length

  /* ---------------------------------------- 4. 界面：模拟按键打开面板 */

  // 用真实的输入事件喂给 xterm，让 TerminalPanel 自己记下输入行，
  // 再派发一次 Tab —— 走的就是用户手敲的那条路径。
  // 注意：xterm 5.x 的 textarea input 处理要求 inputType === 'insertText'，
  // 少了这个字段它会直接忽略，onData 不触发、面板就以为光标停在空行。
  const taEl = () => q('.xterm-helper-textarea')
  const typeInto = async (text) => {
    const ta = taEl()
    if (!ta) return false
    ta.focus()
    for (const ch of text) {
      ta.value = ch
      ta.dispatchEvent(
        new InputEvent('input', {
          data: ch,
          inputType: 'insertText',
          bubbles: true,
          cancelable: true
        })
      )
      await sleep(12)
    }
    return true
  }
  const pressKey = (key, code, keyCode) => {
    const ta = taEl()
    if (!ta) return false
    return ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true
      })
    )
  }
  const pressTab = () => pressKey('Tab', 'Tab', 9)
  const readPanel = () =>
    q('.ac-popup')
      ? {
          title: q('.ac-title') ? q('.ac-title').textContent : null,
          count: q('.ac-count') ? q('.ac-count').textContent : null,
          note: q('.ac-note') ? q('.ac-note').textContent : null,
          rows: [...document.querySelectorAll('.ac-item .ac-cmd')].map((e) => e.textContent),
          visibleRows: document.querySelectorAll('.ac-item').length,
          moreBar: q('.ac-more') ? q('.ac-more').textContent : null,
          foot: q('.ac-foot') ? q('.ac-foot').textContent : null
        }
      : null

  // A) 上下文补全真的生效：光标停在 `cd /var/lo`，面板标题应是「cd 的路径」，
  //    候选是 4 个目录，且不该出现「还有 N 条」折叠条。
  out.typed = await typeInto('cd /var/lo')
  await sleep(150)
  pressTab()
  await sleep(1000)
  out.panelCtx = readPanel()

  // 关掉面板 + 回车清空当前输入行（trackInput 收到 \r 会重置）
  pressKey('Escape', 'Escape', 27)
  await sleep(80)
  pressKey('Enter', 'Enter', 13)
  await sleep(250)

  // B) 折叠 / 展开：敲一个命令前缀，候选很多，默认只展示 8 条
  await typeInto('s')
  await sleep(150)
  pressTab()
  await sleep(1000)
  out.panelMany = readPanel()

  if (q('.ac-popup')) {
    pressKey('ArrowRight', 'ArrowRight', 39)
    await sleep(400)
    out.afterExpand = {
      rows: document.querySelectorAll('.ac-item').length,
      popupExpanded: !!q('.ac-popup.expanded'),
      moreBar: q('.ac-more') ? q('.ac-more').textContent : null
    }
    pressKey('ArrowLeft', 'ArrowLeft', 37)
    await sleep(400)
    out.afterCollapse = {
      rows: document.querySelectorAll('.ac-item').length,
      popupExpanded: !!q('.ac-popup.expanded'),
      moreBar: q('.ac-more') ? q('.ac-more').textContent : null
    }
  }

  out.layout = {
    mainOverflowPx: q('.main') ? q('.main').scrollWidth - q('.main').clientWidth : 0
  }
  out.finalStatus = store.getState().statuses[id]
  return out
})()
