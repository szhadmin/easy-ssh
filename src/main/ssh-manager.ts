import { Client, type ClientChannel, type SFTPWrapper, type Stats } from 'ssh2'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ShellIntegration } from './shell-integration'
import type {
  ConnectionProfile,
  ConnectionSecret,
  ExecResult,
  RemoteEntry
} from '@shared/types'

/* ------------------------------------------------------------------ 工具 */

export function fmtMode(mode: number, isDir: boolean): string {
  const type = isDir ? 'd' : '-'
  const bit = (m: number, s: string) => ((mode & m) ? s : '-')
  return (
    type +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    bit(0o100, 'x') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    bit(0o010, 'x') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    bit(0o001, 'x')
  )
}

export function posixJoin(base: string, name: string): string {
  if (name.startsWith('/')) return name
  if (base.endsWith('/')) return base + name
  return base + '/' + name
}

export function posixDirname(p: string): string {
  if (!p || p === '/') return '/'
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

export function posixNormalize(p: string): string {
  const abs = p.startsWith('/')
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length) parts.pop()
      continue
    }
    parts.push(seg)
  }
  return (abs ? '/' : '') + parts.join('/') || (abs ? '/' : '.')
}

/* --------------------------------------------------------------- 会话对象 */

export interface Session {
  profile: ConnectionProfile
  client: Client
  ready: boolean
  /** 凭据留在主进程内存里，供意外掉线后自动重连使用（渲染进程永远拿不到） */
  secret?: ConnectionSecret
  /** 用户主动断开 / 切换连接时置位，用来区分「意外掉线」—— 主动断开不重连 */
  manualClose: boolean
  /** 连续重连次数，连上一次就清零 */
  attempt: number
  /** 每次成功建立（含重连）自增；渲染层据此判断「终端要重开一个 shell」 */
  epoch: number
  /** 正在等待重连 */
  reconnecting: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}

interface TerminalRecord {
  stream: ClientChannel
  profileId: string
  /** 用户是否已经自己敲过键 —— 敲过就不再注入目录钩子，免得打断他的输入 */
  userTyped: boolean
  /** 目录跟踪钩子（OSC 7）的注入状态机，仅在宿主机 shell 上启用 */
  integration?: ShellIntegration
}

/** 意外掉线后的重连节奏（毫秒），用完就放弃并如实告诉用户 */
const RECONNECT_DELAYS = [1500, 4000, 8000, 15000, 25000]

export class SshManager {
  private sessions = new Map<string, Session>()
  private terminals = new Map<string, TerminalRecord>()

  /**
   * SFTP 通道缓存 —— 这是「用几分钟后终端 / 文件 / Docker 一起报错」的根因所在。
   *
   * `Client.sftp()` 每调用一次就新开一条 SSH 通道，而 OpenSSH 的 `MaxSessions`
   * （默认 10）限制的是**单条连接上同时打开的通道数**。以前 listDir / home /
   * stat / chmod / upload 每次调用都新开一条且从不关闭，浏览十几个目录就把通道
   * 数打满；之后服务端对所有新的通道请求一律回 `SSH_MSG_CHANNEL_OPEN_FAILURE`
   * （description 就是 `open failed`），ssh2 便抛出
   * `(SSH) Channel open failure: open failed` —— 终端、文件、docker 全废。
   *
   * 现在每条连接只保留一条 SFTP 通道并复用；通道被服务端或网络关掉时自动从
   * 缓存里摘掉，下次调用重建。
   */
  private sftpChannels = new Map<string, SFTPWrapper>()
  private sftpPending = new Map<string, Promise<SFTPWrapper>>()

  /* ------------------------------------------------------------ 连接 */

  async connect(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<Client> {
    // 先把上一条会话（若有）干净地收掉：置 manualClose 免得它触发自动重连
    const prev = this.sessions.get(profile.id)
    if (prev) {
      prev.manualClose = true
      if (prev.reconnectTimer) clearTimeout(prev.reconnectTimer)
      try {
        prev.client.end()
      } catch {
        /* ignore */
      }
      this.sessions.delete(profile.id)
    }
    this.dropSftp(profile.id)

    const client = await this.openClient(profile, secret)
    const session: Session = {
      profile,
      client,
      ready: true,
      secret,
      manualClose: false,
      attempt: 0,
      epoch: 1,
      reconnecting: false
    }
    this.wire(session)
    this.sessions.set(profile.id, session)
    return client
  }

  /** 只负责建连接（握手 + 认证），不注册会话、不碰缓存 */
  private openClient(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<Client> {
    const client = new Client()
    const cfg: Record<string, unknown> = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.username,
      readyTimeout: 20000,
      // 15s 一次心跳，连续 3 次没回应（≈45s）就判定链路已死。
      // 之前的 6 次要等 90s 才发现断线，中途所有操作都卡在「假活」状态。
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: true
    }

    if (profile.authType === 'password') {
      if (secret?.password) cfg.password = secret.password
      client.on('keyboard-interactive', (_n, _i, _l, _p, finish) => {
        finish(secret?.password ? [secret.password] : [])
      })
    } else if (profile.authType === 'key') {
      if (!profile.privateKeyPath) return Promise.reject(new Error('未配置私钥文件路径'))
      return readFile(profile.privateKeyPath)
        .catch((e: Error) => {
          throw new Error(`私钥读取失败：${profile.privateKeyPath}（${e.message}）`)
        })
        .then((key) => {
          cfg.privateKey = key
          if (secret?.passphrase) cfg.passphrase = secret.passphrase
          return this.handshake(client, cfg, profile)
        })
    } else {
      cfg.agent =
        process.env.SSH_AUTH_SOCK ||
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    }

    return this.handshake(client, cfg, profile)
  }

  private handshake(
    client: Client,
    cfg: Record<string, unknown>,
    profile: ConnectionProfile
  ): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const onError = (err: Error): void => {
        client.removeListener('ready', onReady)
        reject(normalizeSshError(err, profile))
      }
      const onReady = (): void => {
        client.removeListener('error', onError)
        resolve(client)
      }
      client.once('ready', onReady)
      client.once('error', onError)
      try {
        client.connect(cfg as never)
      } catch (e) {
        reject(normalizeSshError(e as Error, profile))
      }
    })
  }

  /** 注册会话生命周期：清终端、清 SFTP 缓存，意外掉线则自动重连 */
  private wire(session: Session): void {
    const { client, profile } = session

    client.on('close', () => {
      session.ready = false
      for (const [tid, t] of this.terminals) {
        if (t.profileId === profile.id) {
          this.terminals.delete(tid)
          this.emitExit(tid, undefined, undefined, '连接已断开')
        }
      }
      this.dropSftp(profile.id)

      if (session.manualClose) {
        this.emitClosed(profile.id)
        return
      }
      // 会话已经被替换掉（说明是重连过程中的旧连接）就不要再排队重连了
      if (this.sessions.get(profile.id) === session) this.scheduleReconnect(profile.id)
    })

    client.on('error', () => {
      session.ready = false
    })
  }

  /* --------------------------------------------------------- 自动重连 */

  private scheduleReconnect(profileId: string): void {
    const session = this.sessions.get(profileId)
    if (!session || session.manualClose) return

    if (session.attempt >= RECONNECT_DELAYS.length) {
      session.reconnecting = false
      this.emitReconnect(profileId, 'failed', session.attempt, 0, session.epoch)
      this.emitClosed(profileId)
      return
    }

    const delay = RECONNECT_DELAYS[session.attempt]
    session.attempt++
    session.reconnecting = true
    this.emitReconnect(profileId, 'scheduled', session.attempt, delay, session.epoch)
    session.reconnectTimer = setTimeout(() => void this.tryReconnect(profileId), delay)
    // 别让这个定时器拖住应用退出
    if (typeof session.reconnectTimer.unref === 'function') session.reconnectTimer.unref()
  }

  private async tryReconnect(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId)
    if (!session || session.manualClose) return
    try {
      const client = await this.openClient(session.profile, session.secret)
      const next: Session = {
        ...session,
        client,
        ready: true,
        attempt: 0,
        reconnecting: false,
        epoch: session.epoch + 1,
        reconnectTimer: undefined
      }
      this.sessions.set(profileId, next)
      this.wire(next)
      this.emitReconnect(profileId, 'ok', 0, 0, next.epoch)
    } catch {
      this.scheduleReconnect(profileId)
    }
  }

  /** 关掉并忘掉这条连接的 SFTP 通道（断线 / 重连 / 重连成功时调用） */
  private dropSftp(profileId: string): void {
    const sftp = this.sftpChannels.get(profileId)
    this.sftpChannels.delete(profileId)
    this.sftpPending.delete(profileId)
    if (!sftp) return
    try {
      sftp.end()
    } catch {
      /* 通道可能已经随连接一起没了 */
    }
  }

  async disconnect(profileId: string): Promise<void> {
    const s = this.sessions.get(profileId)
    if (s) {
      s.manualClose = true
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      s.reconnectTimer = undefined
      s.reconnecting = false
    }
    // 先显式关掉 SFTP 通道再断连接：让服务端立刻回收这条通道的配额，
    // 而不是等整条 TCP 连接被拆掉（后者在部分中间设备上会拖很久）。
    this.dropSftp(profileId)
    if (s) {
      try {
        s.client.end()
      } catch {
        /* ignore */
      }
      this.sessions.delete(profileId)
    }
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) void this.disconnect(id)
  }

  get(profileId: string): Session | undefined {
    const s = this.sessions.get(profileId)
    return s && s.ready ? s : undefined
  }

  isConnected(profileId: string): boolean {
    return !!this.get(profileId)
  }

  /** 渲染层用来把「正在重连」和「已断开」区分开显示 */
  reconnectState(profileId: string): { reconnecting: boolean; attempt: number } {
    const s = this.sessions.get(profileId)
    return { reconnecting: !!s?.reconnecting, attempt: s?.attempt ?? 0 }
  }

  /** 确保拿到一个可用会话（内部使用） */
  private require(profileId: string): Session {
    const s = this.get(profileId)
    if (s) return s
    if (this.sessions.get(profileId)?.reconnecting) {
      throw new Error('连接意外断开，正在自动重连，请稍候再试…')
    }
    throw new Error('连接已断开，请重新连接')
  }

  /* ---------------------------------------------------------- 命令执行 */

  async exec(profileId: string, command: string, timeoutMs = 20000): Promise<ExecResult> {
    const session = this.require(profileId)
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`命令执行超时（${timeoutMs}ms）: ${command.slice(0, 80)}`))
      }, timeoutMs)

      session.client.exec(command, { env: { LANG: 'C', LC_ALL: 'C' } }, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          if (!settled) {
            settled = true
            reject(normalizeSshError(err, session.profile))
          }
          return
        }
        let stdout = ''
        let stderr = ''
        let code: number | null = null
        let exitSignal: string | undefined

        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf8')
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8')
        })
        stream.on('exit', (c: number | null, sig?: string) => {
          code = c
          exitSignal = sig
        })
        stream.on('close', () => {
          clearTimeout(timer)
          if (settled) return
          settled = true
          resolve({ code, stdout, stderr: stderr || (exitSignal ? `signal ${exitSignal}` : '') })
        })
        stream.on('error', (e: Error) => {
          clearTimeout(timer)
          if (settled) return
          settled = true
          reject(e)
        })
      })
    })
  }

  /** 执行且不关心失败（用于探测类命令） */
  async execSoft(profileId: string, command: string, timeoutMs = 10000): Promise<string> {
    try {
      const r = await this.exec(profileId, command, timeoutMs)
      return r.stdout
    } catch {
      return ''
    }
  }

  /* ---------------------------------------------------------- 终端通道 */

  openTerminal(args: {
    termId: string
    profileId: string
    kind: 'host' | 'docker'
    target?: string
    cols: number
    rows: number
  }): void {
    const session = this.require(args.profileId)
    this.closeTerminal(args.termId)

    const pty = {
      term: 'xterm-256color',
      cols: args.cols || 100,
      rows: args.rows || 30,
      width: 0,
      height: 0
    }

    const onStream = (err: Error | undefined, stream: ClientChannel): void => {
      if (err) {
        this.emitExit(args.termId, undefined, undefined, normalizeSshError(err, session.profile).message)
        return
      }

      const rec: TerminalRecord = { stream, profileId: args.profileId, userTyped: false }

      // 宿主机 shell 挂目录跟踪钩子：远端每次打印提示符都会上报 PWD，
      // 渲染层据此把文件面板同步到同一个目录。容器内 shell 不注入。
      if (args.kind === 'host') {
        rec.integration = new ShellIntegration(
          (data) => {
            try {
              stream.write(data)
            } catch {
              /* 通道已关闭 */
            }
          },
          () => rec.userTyped
        )
      }

      this.terminals.set(args.termId, rec)

      stream.on('data', (d: Buffer) => {
        const text = d.toString('utf8')
        rec.integration?.onOutput()
        this.emitData(args.termId, text)
      })
      stream.stderr?.on('data', (d: Buffer) => this.emitData(args.termId, d.toString('utf8')))
      stream.on('close', (code?: number, signal?: string) => {
        rec.integration?.abort()
        this.terminals.delete(args.termId)
        this.emitExit(args.termId, code, signal)
      })
      stream.on('error', () => {
        rec.integration?.abort()
        this.terminals.delete(args.termId)
      })
    }

    if (args.kind === 'host') {
      session.client.shell(pty, onStream)
    } else {
      // 容器标识会被拼进远端命令，先做白名单校验
      const id = args.target || ''
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) {
        this.emitExit(args.termId, undefined, undefined, `非法的容器标识: ${id}`)
        return
      }
      const cmd =
        `docker exec -it ${id} sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; ` +
        `elif command -v sh >/dev/null 2>&1; then exec sh; else exec /bin/sh; fi'`
      session.client.exec(cmd, { pty }, onStream)
    }
  }

  writeTerminal(termId: string, data: string): void {
    const t = this.terminals.get(termId)
    if (!t) return
    // 只要用户自己开始敲键，就放弃尚未发出的目录钩子（避免在他的输入中途插话）
    if (t.integration && !t.integration.done) t.userTyped = true
    t.stream.write(data)
  }

  resizeTerminal(termId: string, cols: number, rows: number): void {
    const t = this.terminals.get(termId)
    if (!t) return
    try {
      t.stream.setWindow(rows, cols, 0, 0)
    } catch {
      /* 部分通道不支持 */
    }
  }

  closeTerminal(termId: string): void {
    const t = this.terminals.get(termId)
    if (!t) return
    try {
      t.integration?.abort()
      t.stream.close()
    } catch {
      /* ignore */
    }
    this.terminals.delete(termId)
  }

  closeTerminalsOf(profileId: string): void {
    for (const [tid, t] of [...this.terminals]) {
      if (t.profileId === profileId) this.closeTerminal(tid)
    }
  }

  /* ------------------------------------------------------------- SFTP */

  /**
   * 取这条连接的 SFTP 通道 —— 复用同一条，绝不再「一次调用开一条通道」。
   * 并发调用会共用同一个正在建立中的 promise，避免同时开出好几条。
   */
  async sftp(profileId: string): Promise<SFTPWrapper> {
    const cached = this.sftpChannels.get(profileId)
    if (cached) return cached

    const pending = this.sftpPending.get(profileId)
    if (pending) return pending

    const session = this.require(profileId)
    const promise = new Promise<SFTPWrapper>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) {
          reject(normalizeSshError(err, session.profile))
          return
        }
        // 通道被服务端 / 网络关掉时把它从缓存摘掉，下次调用自动重建
        const forget = (): void => {
          if (this.sftpChannels.get(profileId) === sftp) this.sftpChannels.delete(profileId)
        }
        sftp.once('close', forget)
        sftp.once('error', forget)
        this.sftpChannels.set(profileId, sftp)
        resolve(sftp)
      })
    })

    this.sftpPending.set(profileId, promise)
    try {
      return await promise
    } finally {
      this.sftpPending.delete(profileId)
    }
  }

  async home(profileId: string): Promise<string> {
    const sftp = await this.sftp(profileId)
    return new Promise<string>((resolve) => {
      sftp.realpath('.', (err, p) => resolve(err ? '/' : p))
    })
  }

  async listDir(profileId: string, path: string): Promise<RemoteEntry[]> {
    const sftp = await this.sftp(profileId)
    const items = await new Promise<Array<{ filename: string; longname: string; attrs: Stats }>>(
      (resolve, reject) => {
        sftp.readdir(path, (err, list) => {
          if (err) reject(new Error(translateSftpError(err.message, path)))
          else resolve(list as never)
        })
      }
    )

    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => {
        const isDir = i.attrs.isDirectory()
        const isSym = i.attrs.isSymbolicLink()
        return {
          name: i.filename,
          path: posixJoin(path, i.filename),
          isDir,
          isSymlink: isSym,
          size: i.attrs.size ?? 0,
          mode: i.attrs.mode ?? 0,
          modeText: fmtMode(i.attrs.mode ?? 0, isDir),
          mtime: (i.attrs.mtime ?? 0) * 1000,
          uid: i.attrs.uid ?? 0,
          gid: i.attrs.gid ?? 0
        }
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN')
      })
  }

  async readTextFile(profileId: string, path: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
    const sftp = await this.sftp(profileId)
    const size = await new Promise<number>((resolve, reject) => {
      sftp.stat(path, (err, st) => {
        if (err) reject(new Error(translateSftpError(err.message, path)))
        else resolve(st.size)
      })
    })
    if (size > maxBytes) {
      throw new Error(`文件过大（${formatBytes(size)}），超过 ${formatBytes(maxBytes)} 编辑上限，请先下载到本地编辑`)
    }
    const buf = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (err, data) => {
        if (err) reject(new Error(translateSftpError(err.message, path)))
        else resolve(data)
      })
    })
    return buf.toString('utf8')
  }

  async writeTextFile(profileId: string, path: string, content: string): Promise<void> {
    const sftp = await this.sftp(profileId)
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, Buffer.from(content, 'utf8'), (err) => {
        if (err) reject(new Error(translateSftpError(err.message, path)))
        else resolve()
      })
    })
  }

  async mkdir(profileId: string, path: string): Promise<void> {
    const sftp = await this.sftp(profileId)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(new Error(translateSftpError(err.message, path))) : resolve()))
    })
  }

  /** mkdir -p 语义：目录已存在时静默通过 */
  async mkdirp(profileId: string, path: string): Promise<void> {
    const sftp = await this.sftp(profileId)
    const segs = path.split('/').filter(Boolean)
    let cur = path.startsWith('/') ? '' : '.'
    for (const seg of segs) {
      cur = cur === '' ? '/' + seg : cur + '/' + seg
      await new Promise<void>((resolve) => {
        sftp.mkdir(cur, () => resolve())
      })
    }
  }

  async stat(profileId: string, path: string): Promise<{ isDir: boolean; size: number; mode: number }> {
    const sftp = await this.sftp(profileId)
    return new Promise((resolve, reject) => {
      sftp.stat(path, (err, st) => {
        if (err) reject(new Error(translateSftpError(err.message, path)))
        else resolve({ isDir: st.isDirectory(), size: st.size ?? 0, mode: st.mode ?? 0 })
      })
    })
  }

  async rename(profileId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sftp(profileId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(new Error(translateSftpError(err.message, from))) : resolve()))
    })
  }

  async chmod(profileId: string, path: string, mode: number): Promise<void> {
    const sftp = await this.sftp(profileId)
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(path, mode, (err) => (err ? reject(new Error(translateSftpError(err.message, path))) : resolve()))
    })
  }

  async remove(profileId: string, path: string, isDir: boolean, recursive = false): Promise<void> {
    const sftp = await this.sftp(profileId)
    if (!isDir) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (err) => (err ? reject(new Error(translateSftpError(err.message, path))) : resolve()))
      })
      return
    }
    if (recursive) {
      const children = await this.listDir(profileId, path)
      for (const c of children) {
        await this.remove(profileId, c.path, c.isDir, true)
      }
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (err) => (err ? reject(new Error(translateSftpError(err.message, path))) : resolve()))
    })
  }

  async upload(
    profileId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.sftp(profileId)
    await new Promise<void>((resolve, reject) => {
      let lastEmit = 0
      sftp.fastPut(
        localPath,
        remotePath,
        {
          concurrency: 8,
          chunkSize: 64 * 1024,
          step: (transferred: number, _nb: number, total: number) => {
            const now = Date.now()
            if (now - lastEmit > 120 || transferred === total) {
              lastEmit = now
              onProgress?.(transferred, total)
            }
          }
        },
        (err) => (err ? reject(new Error(translateSftpError(err.message, remotePath))) : resolve())
      )
    })
  }

  async download(
    profileId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.sftp(profileId)
    await new Promise<void>((resolve, reject) => {
      let lastEmit = 0
      sftp.fastGet(
        remotePath,
        localPath,
        {
          concurrency: 8,
          chunkSize: 64 * 1024,
          step: (transferred: number, _nb: number, total: number) => {
            const now = Date.now()
            if (now - lastEmit > 120 || transferred === total) {
              lastEmit = now
              onProgress?.(transferred, total)
            }
          }
        },
        (err) => (err ? reject(new Error(translateSftpError(err.message, remotePath))) : resolve())
      )
    })
  }

  /* ---------------------------------------------------- 事件转发（由 index.ts 注入） */
  onData: (termId: string, data: string) => void = () => {}
  onExit: (e: { termId: string; code?: number; signal?: string; reason?: string }) => void = () => {}
  onClosed: (profileId: string) => void = () => {}
  /** 意外掉线后的自动重连进度 */
  onReconnect: (e: {
    profileId: string
    phase: 'scheduled' | 'ok' | 'failed'
    attempt: number
    delay: number
    epoch: number
  }) => void = () => {}

  private emitData(termId: string, data: string): void {
    this.onData(termId, data)
  }

  private emitExit(termId: string, code?: number, signal?: string, reason?: string): void {
    this.onExit({ termId, code, signal, reason })
  }

  private emitClosed(profileId: string): void {
    this.onClosed(profileId)
  }

  private emitReconnect(
    profileId: string,
    phase: 'scheduled' | 'ok' | 'failed',
    attempt: number,
    delay: number,
    epoch: number
  ): void {
    this.onReconnect({ profileId, phase, attempt, delay, epoch })
  }
}

/* ------------------------------------------------------------------ 辅助 */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[i]}`
}

function translateSftpError(msg: string, path: string): string {
  const m = msg || 'SFTP 操作失败'
  if (/No such file/i.test(m)) return `路径不存在：${path}`
  if (/Permission denied/i.test(m)) return `权限不足：${path}（试试用 root 或 sudo 账号，或修改文件权限）`
  if (/Not a directory/i.test(m)) return `不是目录：${path}`
  if (/Directory not empty/i.test(m)) return `目录非空，无法删除：${path}`
  if (/Is a directory/i.test(m)) return `这是一个目录：${path}`
  if (/No space left/i.test(m)) return `远端磁盘空间不足`
  if (/Read-only file system/i.test(m)) return `远端为只读文件系统：${path}`
  return `${m}（${path}）`
}

/**
 * 把 ssh2 / 系统的英文报错翻成中文 + 可执行建议。
 * 纯函数，方便脱离 Electron 单测（见 scripts/check-ssh-errors.cjs）。
 */
export function translateSshError(msg: string, host: string, port: number): string {
  // 通道打满：OpenSSH MaxSessions（默认 10）超限时就是这个 description
  if (/Channel open failure|open failed|Resource shortage|resource shortage/i.test(msg)) {
    return (
      'SSH 通道数已达服务器上限（OpenSSH MaxSessions 默认 10）：' +
      '请断开后重新连接。若频繁出现，说明客户端有通道未释放'
    )
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    return '认证失败：用户名 / 密码 / 密钥不正确，或服务器禁用了该认证方式'
  }
  if (/Cannot parse privateKey/i.test(msg)) {
    return '私钥解析失败：格式不受支持，或私钥已加密但未填 passphrase'
  }
  if (/Handshake failed|handshake/i.test(msg)) {
    return 'SSH 握手失败：目标端口可能不是 SSH 服务，或密钥算法不兼容'
  }
  // 注意顺序：ssh2 的心跳失败文案是「Keepalive timeout」，含 timeout，
  // 必须排在通用的 ETIMEDOUT|timeout 之前，否则会被前者吃掉。
  if (/ECONNRESET|EPIPE|Socket closed|Keepalive timeout/i.test(msg)) {
    return `连接被重置或心跳超时：${host}:${port}（网络抖动、代理 / NAT 空闲回收，或服务端主动断开）`
  }
  if (/ETIMEDOUT|timeout/i.test(msg)) {
    return `连接超时：${host}:${port} 无响应（检查网络 / 防火墙 / 安全组）`
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `连接被拒绝：${host}:${port} 未监听或服务未启动`
  }
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return `无法到达主机 ${host}：请检查 IP、路由或 VPN`
  }
  if (/Host key verification|hostVerifier/i.test(msg)) return '主机密钥校验失败'
  if (/No more sessions|no more sessions/i.test(msg)) {
    return '服务器拒绝了新的会话通道（可能是 MaxSessions 限制或服务端资源不足）'
  }
  return msg
}

function normalizeSshError(err: Error, profile: ConnectionProfile): Error {
  return new Error(translateSshError(err?.message || String(err), profile.host, profile.port))
}

export const sshManager = new SshManager()
export { randomUUID }
