import { app, BrowserWindow, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EV } from '@shared/channels'
import { sshManager } from './ssh-manager'
import { registerIpc } from './ipc'
import { abortAll as abortAllAgentChats, setEventSink as setAgentEventSink } from './agent'

let mainWindow: BrowserWindow | null = null

/* 单实例：第二次启动时聚焦已有窗口，避免多个实例同时占端口 / 抢凭据文件 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    title: 'Easy SSH',
    backgroundColor: '#f5f6fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 外部链接一律交给系统浏览器，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev && url.startsWith(dev)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // 冒烟自检：设置 EASYSSH_SMOKE=<png 输出路径> 时，界面渲染完成后截图并退出。
  // 用于 CI / 打包后验证「真的能起来」，不影响正常使用。
  // 追加 EASYSSH_SMOKE_JS=<js 文件> 可以在渲染进程里跑一段脚本（用来摆出特定界面 / 做断言）。
  const smokeOut = process.env['EASYSSH_SMOKE']

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      // 带 ?smoke=1 打开时，渲染层才会挂出 store 调试入口
      smokeOut ? { query: { smoke: '1' } } : undefined
    )
  }

  if (smokeOut) {
    mainWindow.webContents.once('did-finish-load', () => {
      const clickText = process.env['EASYSSH_SMOKE_CLICK']
      const scriptPath = process.env['EASYSSH_SMOKE_JS']
      setTimeout(() => {
        void (async () => {
          try {
            if (scriptPath) {
              const code = readFileSync(scriptPath, 'utf8').trim().replace(/^;/, '')
              // 先放个探针：渲染层如果连 1+1 都算不出来，说明是环境问题而不是脚本问题
              console.log('[smoke] canary:', await mainWindow!.webContents.executeJavaScript('1 + 1'))
              // 把脚本包一层 try/catch，脚本内部抛错时当成返回值带回来，避免拿到一个空 rejection
              const r = await mainWindow!.webContents.executeJavaScript(
                `(async () => { try { return await (${code}) } catch (e) { return { __scriptError: String((e && e.stack) || e) } } })()`,
                true
              )
              console.log('[smoke] script result:', JSON.stringify(r, null, 2))
            } else if (clickText) {
              await mainWindow!.webContents.executeJavaScript(
                `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes(${JSON.stringify(
                  clickText
                )})); if(b){b.click(); return true;} return false; })()`
              )
              await new Promise((r) => setTimeout(r, 700))
            }
            const img = await mainWindow!.webContents.capturePage()
            writeFileSync(smokeOut, img.toPNG())
            console.log('[smoke] screenshot saved ->', smokeOut)
            console.log('[smoke] title:', await mainWindow!.webContents.executeJavaScript('document.title'))
          } catch (e) {
            const err = e as Error | undefined
            console.error(
              '[smoke] failed:',
              err?.message ?? JSON.stringify(e),
              '| stack:',
              err?.stack ?? '(none)'
            )
          }
          app.exit(0)
        })()
      }, 2500)
    })
    mainWindow.webContents.on('render-process-gone', (_e, d) => {
      console.error('[smoke] renderer gone:', JSON.stringify(d))
      app.exit(1)
    })
    mainWindow.webContents.on('console-message', (_e, level, message, line, sid) => {
      console.log(`[renderer:${level}] ${message} (${sid}:${line})`)
    })
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.szhadmin.easyssh')

  // 把 SSH 事件转发到渲染进程
  sshManager.onData = (termId, data) => broadcast(EV.TERM_DATA, { termId, data })
  sshManager.onExit = (payload) => broadcast(EV.TERM_EXIT, payload)
  sshManager.onClosed = (profileId) => broadcast(EV.CONN_CLOSED, { profileId })
  sshManager.onReconnect = (payload) => broadcast(EV.CONN_RECONNECT, payload)

  // AI 助手的流式增量
  setAgentEventSink((e) => broadcast(EV.AGENT_EVENT, e))

  registerIpc(sshManager)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sshManager.disconnectAll()
  abortAllAgentChats()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sshManager.disconnectAll()
  abortAllAgentChats()
})
