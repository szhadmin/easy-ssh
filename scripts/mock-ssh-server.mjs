/**
 * 本地 Mock SSH 服务（仅用于自动化验证，不随包发布）
 *
 * 目的：在没有真实 Linux 服务器的前提下，端到端验证
 *   ① 主进程是否按「先关回显、再注入钩子」的两步顺序发送
 *   ② 渲染层能否解析 shell 上报的 OSC 7 并把目录写进 store
 *   ③ 文件面板是否真的拿着这个目录去拉远端列表（所以也实现了一个内存 SFTP）
 *
 * 它模拟了一个带行规程回显的 pty：echo 打开时把收到的字节原样回显，
 * 遇到 `stty -echo` 后停止回显 —— 和真实终端一致，
 * 这样「注入脚本会不会糊在屏幕上」在日志里就能直接看出来。
 */
import ssh2 from 'ssh2'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const { Server, utils } = ssh2

const PORT = Number(process.env.MOCK_SSH_PORT || 2222)
const LOG = process.env.MOCK_SSH_LOG || 'mock-ssh.log'

/**
 * 对齐 OpenSSH 的 MaxSessions（默认 10）：限制**单条连接上同时打开的通道数**。
 * 真实服务器超限时会回 SSH_MSG_CHANNEL_OPEN_FAILURE（description = "open failed"），
 * 客户端 ssh2 便抛出 `(SSH) Channel open failure: open failed`。
 * 这里复刻这个行为，用来回归验证「客户端有没有漏关通道」。
 */
const MAX_SESSIONS = Number(process.env.MOCK_MAX_SESSIONS || 10)
/** 只读统计端口，给自动化脚本查「这次跑下来一共开了多少通道」 */
const STATS_PORT = Number(process.env.MOCK_STATS_PORT || 2223)

const stats = {
  connections: 0,
  channels: 0,
  concurrent: 0,
  peakConcurrent: 0,
  rejected: 0,
  /** 单独统计 SFTP 通道 —— 它是「通道泄漏」的关键指标：复用后应该只有 1 条 */
  sftpChannels: 0
}

writeFileSync(LOG, '')
const log = (m) => appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${m}\n`)

const hostKey = utils.generateKeyPairSync('ed25519').private

/* ------------------------------------------------- 非交互命令的固定输出 */

/**
 * 补全功能要去远端跑一堆「取列表」的命令（docker ps / systemctl / ps / /etc/passwd…）。
 * 这里按命令特征返回固定输出，让「补全数据源」这条链路能在没有真实服务器的前提下验通。
 * 注意顺序有意义：越具体的规则放越前面。
 */
const EXEC_FIXTURES = [
  [
    /Label "com\.docker\.compose\.service"/,
    () => 'web\nworker\nweb\n'
  ],
  [
    /docker ps -a --format/,
    () =>
      [
        'web-nginx\tUp 3 days (healthy)\tnginx:1.27-alpine',
        'mysql-db\tUp 3 days\tmysql:8.0',
        'redis-cache\tExited (0) 2 hours ago\tredis:7-alpine'
      ].join('\n')
  ],
  [
    /docker images --format/,
    () =>
      [
        'nginx:1.27-alpine\t52.4MB',
        'mysql:8.0\t589MB',
        'redis:7-alpine\t41.2MB',
        '<none>:<none>\t0B'
      ].join('\n')
  ],
  // 注意：真实命令是 `systemctl ... | awk '{print $1}'; ls -1 /etc/init.d`，
  // 所以这里要回「过完 awk 的结果」（每行一个单元名），不能回 `name state` 两列。
  [
    /systemctl list-unit-files/,
    () =>
      [
        'nginx.service',
        'sshd.service',
        'docker.service',
        'mysql.service',
        'user@.service'
      ].join('\n')
  ],
  [/ls -1 \/etc\/init\.d/, () => 'networking\ncron\n'],
  [/\/etc\/passwd/, () => 'root\t0\nwww-data\t33\nshizhenhuang\t1000\nubuntu\t1001\n'],
  [/\/etc\/group/, () => 'root\t0\nsudo\t27\nwww-data\t33\ndocker\t999\n'],
  [
    /ps -eo pid,pcpu,comm/,
    () => '1\t0.0\tsystemd\n812\t0.3\tsshd\n2140\t12.7\tjava\n3201\t2.1\tnginx\n'
  ],
  [/ps -eo comm/, () => 'systemd\nsshd\njava\nnginx\n'],
  [/\/etc\/hosts/, () => 'localhost\t127.0.0.1\ngateway\t192.168.1.1\ndb-prod\t10.0.0.8\n'],
  [/for-each-ref/, () => 'main\nfeature/pay\nrelease/1.2\n'],
  [/git -C .* remote/, () => 'origin\nupstream\n'],

  /* ---------------------------------------------- 系统信息 / 指标采集脚本
   *
   * 这两支脚本以前 Mock 没实现，于是「认证成功但探测全空」也能一路绿 —— 
   * 正好掩盖了「连不上却报已连接」这类假成功。这里照真实 Linux 的输出补上，
   * 让「连接成功」必须伴随真实探测数据。
   */
  [
    /@@HOSTNAME/,
    () =>
      [
        '@@HOSTNAME',
        'shizhenhuang-prod',
        '@@OS',
        'Ubuntu 22.04.4 LTS',
        '@@KERNEL',
        '5.15.0-105-generic',
        '@@ARCH',
        'x86_64',
        '@@HOME',
        '/root',
        '@@ROOT',
        '0',
        '@@CPU',
        'Intel(R) Xeon(R) Platinum 8255C CPU @ 2.50GHz',
        '@@CORES',
        '4',
        '@@MEMTOTAL',
        '7999788',
        '@@UPTIME',
        '1234567.89',
        '@@DOCKER',
        '24.0.7',
        '@@END'
      ].join('\n')
  ],
  [
    /@@LOAD/,
    () =>
      [
        '@@LOAD',
        '0.42 0.35 0.30 1/412 987654',
        '@@UPTIME',
        '1234567.89 9876543.21',
        '@@CPU',
        'cpu  1234567 1234 456789 98765432 5678 0 9876 0 0 0',
        '@@MEM',
        'MemTotal:        7999788 kB',
        'MemFree:         1234567 kB',
        'MemAvailable:    3456789 kB',
        'Buffers:          123456 kB',
        'Cached:          1234567 kB',
        'SwapTotal:       2097148 kB',
        'SwapFree:        2097148 kB',
        'Shmem:             12345 kB',
        '@@CORES',
        '4',
        '@@MODEL',
        'Intel(R) Xeon(R) Platinum 8255C CPU @ 2.50GHz',
        '@@NPROC',
        '412',
        '@@DISK',
        '/dev/vda1      41922560 12345678 27456000  32% /',
        'tmpfs            3999892        0   3999892   0% /dev/shm',
        '@@NET',
        '  eth0: 12345678 12345 0 0 0 0 0 0 9876543 9876 0 0 0 0 0 0',
        '@@PROC',
        '  PID USER     %CPU %MEM COMMAND',
        '    1 root      0.0  0.2 /sbin/init',
        ' 2140 root     12.7  8.4 /usr/bin/java -jar app.jar',
        ' 3201 www-data  2.1  1.2 nginx: worker process',
        '@@PROCM',
        '  PID USER     %CPU %MEM COMMAND',
        ' 2140 root     12.7  8.4 /usr/bin/java -jar app.jar',
        '    1 root      0.0  0.2 /sbin/init',
        '@@END'
      ].join('\n')
  ],
  // 可用命令清单：真实机器上是 `ls -1 /bin /sbin ...` 汇总
  [
    /ls -1 "\$d"/,
    () =>
      [
        'apt', 'awk', 'bash', 'cat', 'chmod', 'chown', 'cp', 'curl', 'cut', 'date',
        'df', 'diff', 'docker', 'du', 'echo', 'find', 'free', 'grep', 'gzip', 'head',
        'hostname', 'id', 'ifconfig', 'ip', 'journalctl', 'kill', 'less', 'ln', 'ls', 'lsblk',
        'lsof', 'mkdir', 'mount', 'mv', 'netstat', 'nginx', 'nproc', 'ps', 'pwd', 'rm',
        'rsync', 'sed', 'ss', 'ssh', 'sudo', 'systemctl', 'tail', 'tar', 'tee', 'top',
        'touch', 'tr', 'uname', 'uniq', 'uptime', 'vim', 'wc', 'wget', 'which', 'xargs', 'zcat'
      ].join('\n')
  ],

  // 连接后的存活探测：真实 shell 里 `echo` 一定会把参数回显，Mock 也要照做，
  // 否则客户端会认定「认证成功但会话不可用」而拒绝把这次连接当成成功。
  [/__es_ok__/, () => '__es_ok__']
]

function fakeExec(command) {
  // 客户端有些命令是 `a; b` 拼起来的（例如 systemctl + ls /etc/init.d），
  // 所以把所有命中的 fixture 依次拼起来，模拟 shell 顺序执行的输出。
  let out = ''
  for (const [re, fn] of EXEC_FIXTURES) {
    if (!re.test(command)) continue
    const part = fn()
    out += part.endsWith('\n') ? part : part + '\n'
  }
  return out
}

/* --------------------------------------------------------- 内存文件系统 */

const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const MODE_FROM_ATTRS = 0xffff
const MTIME = 1758000000

const D = (mode = 0o755) => ({ mode: S_IFDIR | mode, size: 4096 })
const F = (size, mode = 0o644) => ({ mode: S_IFREG | mode, size })

const FS = {
  '/': [['root', D(0o700)], ['etc', D()], ['var', D()], ['tmp', D(0o1777)]],
  '/root': [
    ['.bashrc', F(3771)],
    ['.ssh', D(0o700)],
    ['deploy.sh', F(1024, 0o755)],
    ['docker-compose.yml', F(1836)],
    ['app.log', F(96412)],
    ['logs', D()]
  ],
  '/var': [
    ['log', D()],
    ['local', D()],
    ['lib', D()],
    ['lock', D()],
    ['lost+found', D(0o700)],
    ['www', D()]
  ],
  '/var/log': [['nginx', D()], ['syslog', F(1048576)], ['auth.log', F(65536)]],
  '/var/log/nginx': [
    ['access.log', F(248192)],
    ['error.log', F(12384)],
    ['nginx.conf', F(1024)],
    ['conf.d', D()]
  ],
  '/etc': [
    ['nginx', D()],
    ['hosts', F(221)],
    ['passwd', F(2124)],
    ['crontab', F(1136)],
    ['systemd', D()]
  ],
  '/tmp': [['nginx.pid', F(5, 0o644)], ['systemd-private-8f2a', D(0o700)]]
}

const join = (p, name) => (p === '/' ? `/${name}` : `${p}/${name}`)

/** 找到某个路径的属性（目录 / 文件），找不到返回 null */
const statOf = (path) => {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/') return D()
  if (FS[p]) return D()
  for (const [parent, list] of Object.entries(FS)) {
    for (const [name, meta] of list) {
      if (join(parent, name) === p) return meta
    }
  }
  return null
}

/**
 * 取某个目录下的条目。
 * 注意不能只查 `FS[p]`：`/tmp` 这种「是目录、但没在 FS 里显式列过子项」的情况
 * 也要能打开（返回空列表），否则和真实 SFTP 行为不一致。
 */
const childrenOf = (path) => {
  const p = path.replace(/\/+$/, '') || '/'
  if (FS[p]) return FS[p]
  const meta = statOf(p)
  if (meta && meta.mode & S_IFDIR) return []
  return null
}

const attrsFor = (meta) => ({
  mode: meta.mode & MODE_FROM_ATTRS,
  uid: 0,
  gid: 0,
  size: meta.size ?? 0,
  atime: MTIME,
  mtime: MTIME
})

const longnameFor = (meta, name) => {
  const t = meta.mode & S_IFDIR ? 'd' : '-'
  const rwx = (meta.mode & 0o777).toString(8).padStart(3, '0')
  return `${t}${rwx}---  1 root root ${String(meta.size ?? 0).padStart(8)} Jan  1 00:00 ${name}`
}

/* ------------------------------------------------------------------ 服务 */

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  stats.connections++
  log(`CONNECT #${stats.connections}`)
  serverClients.add(client)
  client.on('close', () => {
    serverClients.delete(client)
    log(`DISCONNECT (${stats.concurrent} channels still open)`)
  })
  client.on('authentication', (ctx) => ctx.accept())

  client.on('ready', () => {
    client.on('session', (accept, reject) => {
      // 通道数打满 —— 与真实 OpenSSH MaxSessions 行为一致：直接拒绝新通道
      if (stats.concurrent >= MAX_SESSIONS) {
        stats.rejected++
        log(`SESSION REJECTED concurrent=${stats.concurrent} max=${MAX_SESSIONS}`)
        reject()
        return
      }

      const session = accept()
      stats.channels++
      stats.concurrent++
      if (stats.concurrent > stats.peakConcurrent) stats.peakConcurrent = stats.concurrent
      // 记下这条通道是什么类型，方便排查「谁没关」
      const kind = { v: 'session' }
      session.once('close', () => {
        stats.concurrent--
        log(`CHANNEL closed (${kind.v}) concurrent=${stats.concurrent}`)
      })

      session.on('pty', (a) => a && a())

      session.on('exec', (accept, reject, info) => {
        kind.v = 'exec'
        log(`EXEC ${JSON.stringify(info.command)}`)
        const ch = accept()
        const out = fakeExec(String(info.command || ''))
        if (out) ch.write(out.endsWith('\n') ? out : out + '\n')
        ch.exit(0)
        ch.end()
      })

      /* ------------------------------------------------------- SFTP */
      session.on('sftp', (accept) => {
        kind.v = 'sftp'
        stats.sftpChannels++
        const sftp = accept()
        log('SFTP opened')
        const handles = new Map()

        sftp.on('REALPATH', (reqid, path) => {
          const abs = path.startsWith('/') ? path : '/root'
          const target = statOf(abs) ? abs : '/root'
          sftp.name(reqid, [{ filename: target, longname: target, attrs: attrsFor(D(0o700)) }])
        })

        const replyStat = (reqid, path) => {
          const meta = statOf(path)
          if (!meta) return sftp.status(reqid, 2) // NO_SUCH_FILE
          sftp.attrs(reqid, attrsFor(meta))
        }
        sftp.on('STAT', (reqid, path) => replyStat(reqid, path))
        sftp.on('LSTAT', (reqid, path) => replyStat(reqid, path))

        sftp.on('OPENDIR', (reqid, path) => {
          const p = path.replace(/\/+$/, '') || '/'
          const kids = childrenOf(p)
          if (!kids) {
            log(`SFTP OPENDIR ${p} -> NO_SUCH_FILE`)
            return sftp.status(reqid, 2)
          }
          const key = Buffer.from(`dir:${p}:${Math.random()}`)
          handles.set(key.toString('hex'), { kids, sent: false })
          log(`SFTP OPENDIR ${p} -> OK`)
          sftp.handle(reqid, key)
        })

        sftp.on('READDIR', (reqid, handle) => {
          const rec = handles.get(handle.toString('hex'))
          if (!rec) return sftp.status(reqid, 4) // FAILURE
          if (rec.sent) return sftp.status(reqid, 1) // EOF
          rec.sent = true
          const names = rec.kids.map(([name, meta]) => ({
            filename: name,
            longname: longnameFor(meta, name),
            attrs: attrsFor(meta)
          }))
          sftp.name(reqid, names)
        })

        sftp.on('CLOSE', (reqid, handle) => {
          handles.delete(handle.toString('hex'))
          sftp.status(reqid, 0)
        })

        sftp.on('SETSTAT', (reqid) => sftp.status(reqid, 0))
        sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, 0))
        sftp.on('MKDIR', (reqid) => sftp.status(reqid, 0))
        sftp.on('RMDIR', (reqid) => sftp.status(reqid, 0))
        sftp.on('REMOVE', (reqid) => sftp.status(reqid, 0))
        sftp.on('RENAME', (reqid) => sftp.status(reqid, 0))
        sftp.on('OPEN', (reqid) => sftp.status(reqid, 2))
        sftp.on('WRITE', (reqid) => sftp.status(reqid, 0))

        sftp.on('error', (e) => log(`SFTP ERROR ${e.message}`))
      })

      /* ------------------------------------------------------ shell */
      session.on('shell', (accept) => {
        kind.v = 'shell'
        const ch = accept()
        log('SHELL opened')

        let cwd = '/root'
        let echo = true
        let hookInstalled = false

        const prompt = () => {
          if (hookInstalled) ch.write(`\u001b]7;file://mock${cwd}\u001b\\`)
          ch.write(`root@mock:${cwd}# `)
        }

        ch.write('Welcome to MOCK SSH (easy-ssh smoke test)\r\n')
        prompt()

        ch.on('data', (d) => {
          const s = d.toString('utf8')
          log(`IN ${JSON.stringify(s)}`)

          // 行规程回显：echo 开着才回显（与真实 pty 一致）
          if (echo) ch.write(s.replace(/\r/g, '\r\n'))

          let got = false
          for (const raw of s.split(/\r|\n/)) {
            const line = raw.trim()
            if (!line) continue
            got = true

            // 终端 Agent 单步工具调用：模拟 shell 实际输出，并用**纯 ASCII 行标记**回传退出码。
            // 命令仍由同一 shell 通道接收，测试不会退化成隐藏 exec。
            //
            // 为什么不是 OSC：哨兵要拼进「键入的命令行」，而 ESC 是 readline 的 meta 前缀，
            // 会被连同后一个字符一起吞掉 —— 真实 bash 下标记根本打印不出来，Agent 只能干等到超时。
            const agent = /__EASYSSH_AGENT_([A-Z2-9]{4,32})_START__/.exec(line)
            if (agent) {
              const token = agent[1]
              const cmd = /\{\s*([\s\S]*?);\s*\};\s*__easyssh_rc/.exec(line)?.[1] || ''
              const output =
                fakeExec(cmd) ||
                (cmd.includes('df -h')
                  ? 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        50G   43G  7G  87% /\n'
                  : cmd.includes('docker ps -a')
                    ? // 刻意带上 ANSI 颜色：真机 docker 默认带色，用来验证回灌前会被剥掉
                      '\u001b[1mCONTAINER ID\u001b[0m   IMAGE                STATUS\nabc123def456   \u001b[34mnginx:latest\u001b[0m       Up 3 days\n'
                    : cmd.includes('docker system df -v')
                      ? '\u001b[1mImages space usage:\u001b[0m\nREPOSITORY   TAG      SIZE     SHARED\nnginx        latest   187MB    0B\n'
                      : `mock executed: ${cmd}\n`)
              ch.write(
                `\n__EASYSSH_AGENT_${token}_START__\n${output}\n__EASYSSH_AGENT_${token}_END__0\n`
              )
              log(`AGENT ${JSON.stringify(cmd)}`)
              continue
            }

            // 注入脚本里的擦屏收尾：真实 shell 是「先执行 printf 输出 ANSI，再执行 stty echo」，
            // 所以这里必须先吐擦屏码、再恢复回显，顺序反了就复现不出真实效果
            if (line.includes('[2K')) {
              ch.write('\u001b[2K\r\u001b[1A\u001b[2K\r')
            }
            if (/stty\s+-echo/.test(line)) {
              echo = false
              log('ECHO off')
            } else if (/stty\s+echo/.test(line)) {
              echo = true
              log('ECHO on')
            } else if (line.includes('__es_cwd')) {
              hookInstalled = true
              log('HOOK installed')
            } else if (/^cd\s+/.test(line)) {
              const target = line.replace(/^cd\s+/, '').replace(/^['"]|['"]$/g, '')
              cwd = target.startsWith('/')
                ? target.replace(/\/+$/, '') || '/'
                : `${cwd === '/' ? '' : cwd}/${target}`.replace(/\/\/+/g, '/')
              log(`CD -> ${cwd}`)
            } else if (line === 'pwd') {
              ch.write(`${cwd}\r\n`)
            } else if (line === 'exit') {
              ch.exit(0)
              ch.end()
              return
            } else if (!line.includes('[2K')) {
              log(`UNHANDLED ${JSON.stringify(line)}`)
            }
          }

          if (got) prompt()
        })

        ch.on('close', () => log('SHELL closed'))
      })
    })
  })

  client.on('error', (e) => log(`CLIENT ERROR ${e.message}`))
})

server.listen(PORT, '127.0.0.1', () => log(`LISTEN 127.0.0.1:${PORT}`))

/* ------------------------------------------------------------ 统计接口 */

// 只读小端口：GET /stats → 通道计数，GET /reset → 清零，GET /kill → 掐断所有已建立的连接。
// 让自动化脚本（scripts/check-channels.cjs）能判断「跑完这一轮到底开了几条通道」，
// 以及验证客户端「意外掉线后能不能自己连回来」。
const sockets = new Set()
const serverClients = new Set()
// ssh2 的 Server 是个包装类，原始 socket 只在内部 net server 上；
// 拿不到就退化成用 server 侧 client.end()（优雅断开），一样能触发客户端的重连。
if (server._srv && typeof server._srv.on === 'function') {
  server._srv.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
}

createServer((req, res) => {
  if (req.url === '/reset') {
    for (const k of Object.keys(stats)) stats[k] = 0
  } else if (req.url === '/kill') {
    if (sockets.size) {
      const n = sockets.size
      for (const sock of [...sockets]) sock.destroy()
      sockets.clear()
      log(`KILL ${n} connection(s) (abrupt)`)
    } else {
      const n = serverClients.size
      for (const c of [...serverClients]) c.end()
      serverClients.clear()
      log(`KILL ${n} connection(s) (graceful)`)
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(stats))
}).listen(STATS_PORT, '127.0.0.1', () =>
  log(`STATS 127.0.0.1:${STATS_PORT} (maxSessions=${MAX_SESSIONS})`)
)
