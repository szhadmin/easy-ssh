/**
 * 在渲染进程里跑的冒烟脚本（由 EASYSSH_SMOKE_JS 指定，executeJavaScript 执行）。
 * 链路：建连接 -> 连本地 mock SSH -> 终端页 -> 校验目录同步 -> 分栏 DOM 断言。
 * 注意：整体会被包进 `return await (<本文件内容>)`，所以必须是一个「表达式」，
 * 不能有前置分号、也不能有顶层 import。
 */
(async () => {
  const api = window.api
  const store = window.__easyssh.store
  const out = {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const port = Number(window.__mockPort || 2222)

  // 1) 建一条指向本地 mock 服务的连接
  const saved = await api.connections.save(
    {
      name: 'Mock 服务器',
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

  // 2) 连上，并立刻切到「终端」页 —— 终端面板挂载后才会打开 shell 通道
  store.getState().setActive(id)
  store.getState().setTab('terminal')
  for (let i = 0; i < 60; i++) {
    if (store.getState().statuses[id] === 'connected') break
    await sleep(200)
  }
  out.statusAfterConnect = store.getState().statuses[id]

  // 3) 等 shell 钩子上报目录（这一步过了就说明主进程注入成功 + 渲染层解析成功）
  let cwd = ''
  for (let i = 0; i < 60; i++) {
    cwd = store.getState().termCwd[id] || ''
    if (cwd) break
    await sleep(200)
  }
  out.termCwd = cwd
  await sleep(800)

  out.dom = {
    split: !!q('.split'),
    handle: !!q('.split-handle'),
    termShell: !!q('.term-shell'),
    fileList: !!q('.file-list'),
    cwdChip: q('.term-cwd') ? q('.term-cwd').textContent : null,
    followPill: q('.follow-pill') ? q('.follow-pill').textContent : null,
    termWidth: q('.term-shell') ? q('.term-shell').clientWidth : 0,
    fileWidth: q('.file-list') ? q('.file-list').clientWidth : 0,
    mainOverflowPx: q('.main') ? q('.main').scrollWidth - q('.main').clientWidth : 0
  }

  // 4) 在终端里 cd，验证文件面板是否跟着切过去并刷新出新目录的内容
  await api.term.write(id, ' cd /var/log/nginx\r')
  await sleep(2000)
  out.cwdAfterFirstCd = store.getState().termCwd[id]
  out.breadcrumb = [...document.querySelectorAll('.crumb')].map((b) => b.textContent).join('/')
  out.fileNames = [...document.querySelectorAll('.file-row:not(.head) .file-name > span > span:last-child')]
    .map((s) => s.textContent)
    .filter(Boolean)
  out.filesPaneError = q('.banner.error') ? q('.banner.error').textContent : null

  // 5) 再 cd 一次，确认持续跟随
  await api.term.write(id, ' cd /etc\r')
  await sleep(2000)
  out.cwdAfterSecondCd = store.getState().termCwd[id]
  out.breadcrumb2 = [...document.querySelectorAll('.crumb')].map((b) => b.textContent).join('/')
  out.fileNames2 = [...document.querySelectorAll('.file-row:not(.head) .file-name > span > span:last-child')]
    .map((s) => s.textContent)
    .filter(Boolean)

  // 5.5) 回到 nginx 目录，留一张内容好看的截图
  await api.term.write(id, ' cd /var/log/nginx\r')
  await sleep(1800)

  // 6) 分栏比例可调 + 跟随开关可关
  const ratioBefore = store.getState().splitRatio
  store.getState().setSplitRatio(62)
  await sleep(250)
  out.splitRatio = { before: ratioBefore, after: store.getState().splitRatio }
  out.followCwd = store.getState().followCwd

  out.finalStatus = store.getState().statuses[id]
  return out
})()
