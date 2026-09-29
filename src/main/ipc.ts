import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CH, EV } from '@shared/channels'
import type {
  AgentChatRequest,
  AgentConfigPatch,
  ConnectionProfile,
  ConnectionSecret,
  IpcResult,
  TermOpenArgs,
  TransferProgress
} from '@shared/types'
import {
  sshManager,
  posixJoin,
  posixNormalize,
  type SshManager
} from './ssh-manager'
import * as store from './store'
import * as monitor from './monitor'
import * as docker from './docker'
import * as agent from './agent'
import { clearCompleteCache, completeDynamic } from './complete'

/* ------------------------------------------------------------------ 工具 */

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(e: unknown): IpcResult<never> {
  const msg = e instanceof Error ? e.message : String(e)
  return { ok: false, error: msg }
}

/** 统一包装：任何异常都变成 { ok:false, error } ，渲染层不会拿到未捕获的 rejection */
function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => Promise<R> | R
): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return ok(await fn(...(args as A)))
    } catch (err) {
      return fail(err)
    }
  })
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

function emitProgress(p: TransferProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(EV.TRANSFER, p)
  }
}

function makeProgress(
  profileId: string,
  direction: 'upload' | 'download',
  localPath: string,
  remotePath: string,
  total: number
): (transferred: number, t: number) => void {
  const id = randomUUID()
  const base: TransferProgress = {
    id,
    profileId,
    direction,
    name: basename(remotePath),
    localPath,
    remotePath,
    transferred: 0,
    total,
    done: false
  }
  emitProgress({ ...base })
  let last = 0
  return (transferred: number, t: number) => {
    const now = Date.now()
    if (now - last < 100 && transferred !== t) return
    last = now
    emitProgress({ ...base, transferred, total: t || total })
  }
}

function doneProgress(profileId: string, direction: 'upload' | 'download', localPath: string, remotePath: string, error?: string): void {
  emitProgress({
    id: randomUUID(),
    profileId,
    direction,
    name: basename(remotePath),
    localPath,
    remotePath,
    transferred: 0,
    total: 0,
    done: true,
    error
  })
}

/* ------------------------------------------------------ 递归上传 / 下载 */

async function uploadDirRecursive(
  profileId: string,
  localDir: string,
  remoteDir: string
): Promise<void> {
  await sshManager.mkdirp(profileId, remoteDir)
  const entries = await fs.readdir(localDir, { withFileTypes: true })
  for (const e of entries) {
    const lp = join(localDir, e.name)
    const rp = posixJoin(remoteDir, e.name)
    if (e.isDirectory()) {
      await uploadDirRecursive(profileId, lp, rp)
    } else if (e.isFile()) {
      const st = await fs.stat(lp)
      const cb = makeProgress(profileId, 'upload', lp, rp, st.size)
      try {
        await sshManager.upload(profileId, lp, rp, cb)
        doneProgress(profileId, 'upload', lp, rp)
      } catch (err) {
        doneProgress(profileId, 'upload', lp, rp, (err as Error).message)
      }
    }
  }
}

async function downloadRecursive(
  profileId: string,
  remotePath: string,
  localDir: string
): Promise<void> {
  const st = await sshManager.stat(profileId, remotePath)
  if (!st.isDir) {
    const lp = join(localDir, basename(remotePath))
    const cb = makeProgress(profileId, 'download', lp, remotePath, st.size)
    try {
      await sshManager.download(profileId, remotePath, lp, cb)
      doneProgress(profileId, 'download', lp, remotePath)
    } catch (err) {
      doneProgress(profileId, 'download', lp, remotePath, (err as Error).message)
    }
    return
  }
  const targetDir = join(localDir, basename(remotePath))
  await fs.mkdir(targetDir, { recursive: true })
  for (const child of await sshManager.listDir(profileId, remotePath)) {
    await downloadRecursive(profileId, child.path, targetDir)
  }
}

/* ---------------------------------------------------------------- 注册 */

export function registerIpc(ssh: SshManager): void {
  /* ---- 连接配置 ---- */

  handle(CH.CONN_LIST, () => store.listProfiles())

  handle(CH.CONN_SAVE, (profile: ConnectionProfile, secret?: ConnectionSecret) =>
    store.saveProfile(profile as never, secret)
  )

  handle(CH.CONN_DELETE, async (id: string) => {
    await ssh.disconnect(id)
    monitor.clearCaches(id)
    clearCompleteCache(id)
    await store.deleteProfile(id)
    return true
  })

  handle(CH.CONN_STATUSES, async () => {
    const list = await store.listProfiles()
    return list.map((p) => ({ id: p.id, connected: ssh.isConnected(p.id) }))
  })

  handle(CH.CONN_TEST, async (profile: ConnectionProfile, secret?: ConnectionSecret) => {
    // 用临时 id 建一条独立会话，测完即断，不影响已保存的连接
    const probeId = randomUUID()
    await ssh.connect({ ...profile, id: probeId }, secret)
    try {
      // 走 ssh.sftp() 拿缓存通道，disconnect 时会被一起关掉（别自己 client.sftp 开裸通道）
      const home = await ssh.home(probeId)
      const hostname = await new Promise<string>((resolve) => {
        const session = ssh.get(probeId)
        if (!session) return resolve('')
        session.client.exec('hostname; uname -s', (err, stream) => {
          if (err) return resolve('')
          let out = ''
          stream.on('data', (d: Buffer) => (out += d.toString()))
          stream.on('close', () => resolve(out.trim().replace(/\n/g, ' / ')))
        })
      })
      return { home, hostname }
    } finally {
      await ssh.disconnect(probeId)
    }
  })

  handle(CH.CONN_EXPORT, async () => {
    const win = focusedWindow()
    const json = await store.exportProfiles()
    const r = await dialog.showSaveDialog(win!, {
      title: '导出连接配置',
      defaultPath: join(process.env.USERPROFILE ?? '.', 'easyssh-connections.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { saved: false }
    await fs.writeFile(r.filePath, json, 'utf8')
    return { saved: true, path: r.filePath }
  })

  handle(CH.CONN_IMPORT, async () => {
    const win = focusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '导入连接配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { added: 0 }
    const added = await store.importProfiles(await fs.readFile(r.filePaths[0], 'utf8'))
    return { added }
  })

  /* ---- SSH 会话 ---- */

  handle(CH.SSH_CONNECT, async (id: string) => {
    const profile = await store.getProfile(id)
    if (!profile) throw new Error('连接配置不存在')
    const secret = await store.getSecret(id)
    await ssh.connect(profile, secret)
    await store.touchProfile(id)

    // 登录后并行探路：系统信息 / 可用命令 / docker
    const [info, commandCount, dockerInfo] = await Promise.all([
      monitor.getServerInfo(id, true).catch(() => null),
      monitor.getCommands(id, true)
        .then((c) => c.length)
        .catch(() => 0),
      docker.detect(id).catch(() => ({ available: false }) as Awaited<ReturnType<typeof docker.detect>>)
    ])

    // getServerInfo 返回的是缓存对象本身，就地补上 docker 版本即可
    if (info && 'available' in dockerInfo && dockerInfo.available) {
      info.dockerVersion = dockerInfo.version
    }
    return { info, commandCount, docker: dockerInfo }
  })

  handle(CH.SSH_DISCONNECT, async (id: string) => {
    ssh.closeTerminalsOf(id)
    await ssh.disconnect(id)
    monitor.clearCaches(id)
    clearCompleteCache(id)
    return true
  })

  handle(CH.SSH_EXEC, (id: string, cmd: string, timeout?: number) =>
    ssh.exec(id, cmd, timeout ?? 20000)
  )

  /* ---- 终端 ---- */

  handle(CH.TERM_OPEN, (args: TermOpenArgs) => {
    ssh.openTerminal(args)
    return true
  })
  handle(CH.TERM_WRITE, (termId: string, data: string) => {
    ssh.writeTerminal(termId, data)
    return true
  })
  handle(CH.TERM_RESIZE, (termId: string, cols: number, rows: number) => {
    ssh.resizeTerminal(termId, cols, rows)
    return true
  })
  handle(CH.TERM_CLOSE, (termId: string) => {
    ssh.closeTerminal(termId)
    return true
  })

  /* ---- 文件 ---- */

  handle(CH.FILE_HOME, (id: string) => ssh.home(id))
  handle(CH.FILE_LIST, (id: string, path: string) => ssh.listDir(id, posixNormalize(path)))
  handle(CH.FILE_READ, (id: string, path: string) => ssh.readTextFile(id, path))
  handle(CH.FILE_WRITE, (id: string, path: string, content: string) =>
    ssh.writeTextFile(id, path, content)
  )
  handle(CH.FILE_MKDIR, (id: string, path: string) => ssh.mkdirp(id, path))
  handle(CH.FILE_RENAME, (id: string, from: string, to: string) => ssh.rename(id, from, to))
  handle(CH.FILE_CHMOD, (id: string, path: string, mode: number) => ssh.chmod(id, path, mode))
  handle(CH.FILE_REMOVE, (id: string, path: string, isDir: boolean, recursive: boolean) =>
    ssh.remove(id, path, isDir, recursive)
  )

  /** 上传：弹系统文件选择框（可多选） */
  handle(CH.FILE_UPLOAD, async (id: string, remoteDir: string) => {
    const win = focusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要上传的文件（可多选）',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent']
    })
    if (r.canceled || !r.filePaths.length) return { uploaded: 0 }

    let count = 0
    await sshManager.mkdirp(id, remoteDir)
    for (const lp of r.filePaths) {
      const rp = posixJoin(remoteDir, basename(lp))
      const st = await fs.stat(lp)
      const cb = makeProgress(id, 'upload', lp, rp, st.size)
      try {
        await sshManager.upload(id, lp, rp, cb)
        doneProgress(id, 'upload', lp, rp)
        count++
      } catch (err) {
        doneProgress(id, 'upload', lp, rp, (err as Error).message)
        throw err
      }
    }
    return { uploaded: count }
  })

  /** 上传整个文件夹（递归） */
  handle(CH.FILE_UPLOAD_DIR, async (id: string, remoteDir: string) => {
    const win = focusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要上传的文件夹',
      properties: ['openDirectory', 'dontAddToRecent']
    })
    if (r.canceled || !r.filePaths[0]) return { uploaded: false }
    const localDir = r.filePaths[0]
    const target = posixJoin(remoteDir, basename(localDir))
    await uploadDirRecursive(id, localDir, target)
    return { uploaded: true, target }
  })

  /** 下载：单个文件走「另存为」，多个 / 目录走「选择文件夹」 */
  handle(CH.FILE_DOWNLOAD, async (id: string, remotePaths: string[]) => {
    if (!remotePaths.length) return { downloaded: 0 }
    const win = focusedWindow()
    const stats = await Promise.all(remotePaths.map((p) => sshManager.stat(id, p)))
    const singleFile = remotePaths.length === 1 && !stats[0].isDir

    if (singleFile) {
      const r = await dialog.showSaveDialog(win!, {
        title: '保存到本地',
        defaultPath: join(process.env.USERPROFILE ?? '.', basename(remotePaths[0]))
      })
      if (r.canceled || !r.filePath) return { downloaded: 0 }
      const cb = makeProgress(id, 'download', r.filePath, remotePaths[0], stats[0].size)
      try {
        await sshManager.download(id, remotePaths[0], r.filePath, cb)
        doneProgress(id, 'download', r.filePath, remotePaths[0])
      } catch (err) {
        doneProgress(id, 'download', r.filePath, remotePaths[0], (err as Error).message)
        throw err
      }
      return { downloaded: 1 }
    }

    const r = await dialog.showOpenDialog(win!, {
      title: '选择保存目录',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    if (r.canceled || !r.filePaths[0]) return { downloaded: 0 }
    const dir = r.filePaths[0]
    for (const rp of remotePaths) {
      await downloadRecursive(id, rp, dir)
    }
    return { downloaded: remotePaths.length, dir }
  })

  /* ---- 系统 ---- */

  handle(CH.SYS_INFO, (id: string, force?: boolean) => monitor.getServerInfo(id, !!force))
  handle(CH.SYS_METRICS, (id: string) => monitor.getMetrics(id))
  handle(CH.SYS_COMMANDS, (id: string, force?: boolean) => monitor.getCommands(id, !!force))

  /* ---- 命令补全的动态数据 ---- */

  handle(CH.COMPL_DYNAMIC, (id: string, source: string, arg?: string) =>
    completeDynamic(id, source as never, arg)
  )

  /** 结束进程：先 TERM，1.5s 后仍存活再 KILL */
  handle(CH.SYS_KILL, async (id: string, pid: number, force = false) => {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('非法的 PID')
    const sig = force ? '9' : '15'
    const r = await ssh.exec(id, `kill -${sig} ${pid} 2>&1; echo "exit=$?"`, 15000)
    const m = /exit=(\d+)/.exec(r.stdout)
    if (m && m[1] !== '0') throw new Error(r.stdout.replace(/exit=\d+/, '').trim() || '发送信号失败')
    return { pid, signal: sig }
  })

  /* ---- Docker ---- */

  handle(CH.DOCKER_DETECT, (id: string) => docker.detect(id))
  handle(CH.DOCKER_CONTAINERS, (id: string) => docker.containers(id))
  handle(CH.DOCKER_IMAGES, (id: string) => docker.images(id))
  handle(CH.DOCKER_STATS, (id: string) => docker.stats(id))
  handle(CH.DOCKER_ACTION, (id: string, cid: string, act: string) => docker.action(id, cid, act))
  handle(CH.DOCKER_LOGS, (id: string, cid: string, tail?: number) => docker.logs(id, cid, tail))
  handle(CH.DOCKER_INSPECT, (id: string, cid: string) => docker.inspect(id, cid))
  handle(CH.DOCKER_EXEC, (id: string, cid: string, cmd: string) =>
    docker.execInContainer(id, cid, cmd)
  )

  /* ---- AI 助手 ---- */

  handle(CH.AGENT_CONFIG_GET, () => agent.getConfig())

  handle(CH.AGENT_CONFIG_SET, (patch: AgentConfigPatch, apiKey?: string) =>
    agent.setConfig(patch ?? {}, apiKey)
  )

  handle(
    CH.AGENT_CONFIG_TEST,
    (override?: { baseURL?: string; model?: string; apiKey?: string }) => agent.probe(override)
  )

  handle(CH.AGENT_MODELS, (override?: { baseURL?: string; apiKey?: string }) => agent.listModels(override))

  /** 只等到「上游受理」，正文靠 EV.AGENT_EVENT 流式推回来 */
  handle(CH.AGENT_CHAT, (req: AgentChatRequest) => agent.chat(req))

  handle(CH.AGENT_ABORT, (requestId: string) => agent.abort(requestId))

  /* ---- 应用 ---- */

  handle(CH.APP_OPEN_EXTERNAL, async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 链接')
    await shell.openExternal(url)
    return true
  })

  handle(CH.APP_REVEAL, (p: string) => {
    shell.showItemInFolder(p)
    return true
  })

  /** 选择本机文件（用于挑选私钥） */
  handle(CH.APP_PICK_FILE, async (title?: string) => {
    const win = focusedWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: title || '选择文件',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519', '*'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return { path: r.canceled ? null : (r.filePaths[0] ?? null) }
  })

  handle(CH.APP_INFO, async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    plaintextFallback: await store.isPlaintextFallback()
  }))
}
