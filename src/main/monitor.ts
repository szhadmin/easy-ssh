import type { DiskUsage, Metrics, NetIface, ProcessRow, ServerInfo } from '@shared/types'
import { sshManager } from './ssh-manager'

/* -------------------------------------------------------- 采集脚本 (POSIX) */

const METRICS_SCRIPT = [
  'echo "@@LOAD"; cat /proc/loadavg 2>/dev/null',
  'echo "@@UPTIME"; cat /proc/uptime 2>/dev/null',
  'echo "@@CPU"; head -n 1 /proc/stat 2>/dev/null',
  'echo "@@MEM"; grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Shmem):" /proc/meminfo 2>/dev/null',
  'echo "@@CORES"; grep -c "^processor" /proc/cpuinfo 2>/dev/null',
  'echo "@@MODEL"; grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2-',
  'echo "@@NPROC"; ps -e 2>/dev/null | wc -l',
  'echo "@@DISK"; df -kP 2>/dev/null | tail -n +2',
  'echo "@@NET"; cat /proc/net/dev 2>/dev/null | tail -n +3',
  'if ps -eo pid,pcpu --sort=-pcpu >/dev/null 2>&1; then',
  '  echo "@@PROC"; ps -eo pid,user,pcpu,pmem,args --sort=-pcpu 2>/dev/null | head -n 16',
  '  echo "@@PROCM"; ps -eo pid,user,pcpu,pmem,args --sort=-pmem 2>/dev/null | head -n 16',
  'else',
  '  echo "@@PROC"; top -bn1 2>/dev/null | tail -n +8 | head -n 16',
  '  echo "@@PROCM"',
  'fi',
  'echo "@@END"'
].join('\n')

const INFO_SCRIPT = [
  'echo "@@HOSTNAME"; hostname 2>/dev/null',
  'echo "@@OS"; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s',
  'echo "@@KERNEL"; uname -r 2>/dev/null',
  'echo "@@ARCH"; uname -m 2>/dev/null',
  'echo "@@HOME"; echo "$HOME"',
  'echo "@@ROOT"; id -u 2>/dev/null',
  'echo "@@CPU"; grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2-',
  'echo "@@CORES"; grep -c "^processor" /proc/cpuinfo 2>/dev/null',
  'echo "@@MEMTOTAL"; grep -m1 "^MemTotal:" /proc/meminfo 2>/dev/null | grep -oE "[0-9]+"',
  'echo "@@UPTIME"; cat /proc/uptime 2>/dev/null | cut -d" " -f1',
  'echo "@@DOCKER"; (docker version --format "{{.Server.Version}}" 2>/dev/null || echo "")',
  'echo "@@END"'
].join('\n')

const COMMANDS_SCRIPT = [
  'for d in /bin /sbin /usr/bin /usr/sbin /usr/local/bin /usr/local/sbin /opt/bin /snap/bin; do',
  '  ls -1 "$d" 2>/dev/null',
  'done | sort -u | head -n 4000'
].join('\n')

/* ------------------------------------------------------------------ 缓存 */

interface PrevSample {
  cpuTotal: number
  cpuIdle: number
  net: Map<string, { rx: number; tx: number }>
  ts: number
}

const prevSamples = new Map<string, PrevSample>()
const infoCache = new Map<string, ServerInfo>()
const commandCache = new Map<string, string[]>()

export function clearCaches(profileId?: string): void {
  if (!profileId) {
    prevSamples.clear()
    infoCache.clear()
    commandCache.clear()
    return
  }
  prevSamples.delete(profileId)
  infoCache.delete(profileId)
  commandCache.delete(profileId)
}

/* ------------------------------------------------------------------ 解析 */

function splitSections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.split(/\r?\n/)) {
    const m = /^@@([A-Z]+)$/.exec(line.trim())
    if (m) {
      cur = m[1]
      res[cur] = []
      continue
    }
    if (cur) res[cur].push(line)
  }
  return res
}

/** 从 ps 输出行解析；兼容 `PID USER %CPU %MEM COMMAND` 与 BusyBox top 行 */
function parseProcessRows(lines: string[] | undefined): ProcessRow[] {
  if (!lines) return []
  const out: ProcessRow[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^PID\s/i.test(line)) continue

    // 标准: 1234 root  12.3  4.5 /usr/bin/node ...
    const m = /^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/.exec(line)
    if (m) {
      out.push({
        pid: Number(m[1]),
        user: m[2],
        cpu: Number(m[3]),
        mem: Number(m[4]),
        command: m[5].slice(0, 200)
      })
      continue
    }
    // BusyBox top: 1234 root  0:00 2% 1% /usr/bin/node
    const t = /^(\d+)\s+(\S+)\s+\S+\s+([\d.]+)%\s+([\d.]+)%\s+(.*)$/.exec(line)
    if (t) {
      out.push({
        pid: Number(t[1]),
        user: t[2],
        cpu: Number(t[3]),
        mem: Number(t[4]),
        command: t[5].slice(0, 200)
      })
    }
  }
  return out
}

/* -------------------------------------------------------------- 系统信息 */

export async function getServerInfo(profileId: string, force = false): Promise<ServerInfo> {
  if (!force) {
    const c = infoCache.get(profileId)
    if (c) return c
  }
  const out = await sshManager.execSoft(profileId, INFO_SCRIPT, 15000)
  const s = splitSections(out)
  const one = (k: string): string => (s[k]?.[0] ?? '').trim()

  const info: ServerInfo = {
    hostname: one('HOSTNAME') || 'unknown',
    os: one('OS') || 'Linux',
    kernel: one('KERNEL'),
    arch: one('ARCH'),
    cpuModel: one('CPU').trim() || '未知 CPU',
    cpuCores: Number(one('CORES')) || 1,
    memTotalKb: Number(one('MEMTOTAL')) || 0,
    uptimeSec: Number(one('UPTIME')) || 0,
    home: one('HOME') || '/',
    isRoot: one('ROOT') === '0',
    dockerVersion: one('DOCKER') || undefined
  }
  infoCache.set(profileId, info)
  return info
}

/* ------------------------------------------------------------ 可用命令表 */

/** shell 内建 / 复合命令，服务器目录里查不到但很常用 */
const BUILTIN_COMMANDS = [
  'cd', 'pwd', 'exit', 'logout', 'alias', 'unalias', 'export', 'unset', 'source', 'echo',
  'history', 'jobs', 'fg', 'bg', 'kill', 'read', 'set', 'shift', 'test', 'umask', 'wait',
  'exec', 'eval', 'type', 'which', 'time', 'ulimit', 'trap', 'printf', 'readonly', 'local'
]

export async function getCommands(profileId: string, force = false): Promise<string[]> {
  if (!force) {
    const c = commandCache.get(profileId)
    if (c) return c
  }
  const out = await sshManager.execSoft(profileId, COMMANDS_SCRIPT, 20000)
  const list = out
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && /^[\w.:+-]+$/.test(x))
  const merged = Array.from(new Set([...BUILTIN_COMMANDS, ...list])).sort()
  commandCache.set(profileId, merged)
  return merged
}

/* ---------------------------------------------------------------- 指标 */

export async function getMetrics(profileId: string): Promise<Metrics> {
  const out = await sshManager.exec(profileId, METRICS_SCRIPT, 20000)
  const s = splitSections(out.stdout)
  const one = (k: string): string => (s[k]?.[0] ?? '').trim()

  // ---- CPU
  const cpuLine = one('CPU')
  const cpuParts = cpuLine.split(/\s+/).slice(1).map((n) => Number(n) || 0)
  const cpuTotal = cpuParts.slice(0, 8).reduce((a, b) => a + b, 0)
  const cpuIdle = (cpuParts[3] ?? 0) + (cpuParts[4] ?? 0)

  const prev = prevSamples.get(profileId)
  let cpuPercent = 0
  if (prev) {
    const dTotal = cpuTotal - prev.cpuTotal
    const dIdle = cpuIdle - prev.cpuIdle
    if (dTotal > 0) cpuPercent = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100))
  }

  // ---- 内存
  const mem: Record<string, number> = {}
  for (const line of s.MEM ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(line.trim())
    if (m) mem[m[1]] = Number(m[2])
  }
  const memTotalKb = mem.MemTotal ?? 0
  const memAvailableKb =
    mem.MemAvailable ?? ((mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0) - (mem.Shmem ?? 0))

  // ---- 负载 / 运行时长
  const load = (one('LOAD') || '0 0 0').split(/\s+/).map((n) => Number(n) || 0)
  const uptimeSec = Number((one('UPTIME') || '0').split(/\s+/)[0]) || 0

  // ---- 磁盘
  const disks: DiskUsage[] = []
  for (const raw of s.DISK ?? []) {
    const p = raw.trim().split(/\s+/)
    if (p.length < 6) continue
    const [fs, size, used, avail, pct, ...mountParts] = p
    if (!/^\d+$/.test(size) || fs.startsWith('tmpfs') || fs.startsWith('devtmpfs')) continue
    disks.push({
      filesystem: fs,
      sizeKb: Number(size),
      usedKb: Number(used),
      availKb: Number(avail),
      usePercent: Number(pct.replace('%', '')) || 0,
      mount: mountParts.join(' ') || '/'
    })
  }
  disks.sort((a, b) => b.sizeKb - a.sizeKb)

  // ---- 网络
  const net: NetIface[] = []
  for (const raw of s.NET ?? []) {
    const idx = raw.indexOf(':')
    if (idx < 0) continue
    const name = raw.slice(0, idx).trim()
    const cols = raw.slice(idx + 1).trim().split(/\s+/)
    if (cols.length < 9) continue
    net.push({ name, rxBytes: Number(cols[0]) || 0, txBytes: Number(cols[8]) || 0 })
  }

  const curNet = new Map(net.map((n) => [n.name, { rx: n.rxBytes, tx: n.txBytes }]))
  let rxRate = 0
  let txRate = 0
  if (prev) {
    const dt = Math.max(0.2, (Date.now() - prev.ts) / 1000)
    for (const [name, cur] of curNet) {
      if (name === 'lo') continue
      const before = prev.net.get(name)
      if (!before) continue
      const dRx = cur.rx - before.rx
      const dTx = cur.tx - before.tx
      if (dRx >= 0) rxRate += dRx / dt
      if (dTx >= 0) txRate += dTx / dt
    }
  }

  prevSamples.set(profileId, { cpuTotal, cpuIdle, net: curNet, ts: Date.now() })

  return {
    ts: Date.now(),
    cpuPercent,
    cpuCores: Number(one('CORES')) || 1,
    cpuModel: one('MODEL').trim() || '未知 CPU',
    load1: load[0] ?? 0,
    load5: load[1] ?? 0,
    load15: load[2] ?? 0,
    uptimeSec,
    memTotalKb,
    memAvailableKb,
    swapTotalKb: mem.SwapTotal ?? 0,
    swapFreeKb: mem.SwapFree ?? 0,
    disks,
    net,
    netRate: { rxBytesPerSec: rxRate, txBytesPerSec: txRate },
    topCpu: parseProcessRows(s.PROC),
    topMem: parseProcessRows(s.PROCM),
    procCount: Math.max(0, (Number(one('NPROC')) || 1) - 1)
  }
}
