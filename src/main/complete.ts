/**
 * 补全用的动态数据源（主进程侧）。
 *
 * 渲染层的补全引擎只负责「说明我需要什么」，真正去远端取数据的活在这里干：
 *   path           → SFTP 列目录（复用 ssh-manager.listDir，支持 ~ 与相对路径）
 *   container/image→ docker ps / docker images 的 --format 输出
 *   service        → systemctl + /etc/init.d
 *   composeService → 正在运行容器上的 com.docker.compose.service 标签
 *   user/group     → /etc/passwd、/etc/group
 *   process        → ps 的 pid + 名称
 *   host           → /etc/hosts
 *   branch/remote  → git（需要终端当前目录，由渲染层随请求带过来）
 *
 * 一律「只读、失败当空」：补全拉不到数据不该打断用户，所以这里绝不抛错。
 */

import type { CompSource, CompleteItem } from '@shared/types'
import { formatBytes, posixJoin, posixNormalize, sshManager } from './ssh-manager'

const CACHE_TTL_MS = 8000
/** 单个目录最多回多少条，防止 /usr/bin 这种巨目录把 IPC 撑爆 */
const MAX_ITEMS = 3000

interface CacheEntry {
  ts: number
  items: CompleteItem[]
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CompleteItem[]>>()

/* 远端命令片段。注意 '{{.Names}}\t...' 里的 \t 必须是「反斜杠 + t」，
   由 docker 自己去解释成制表符，所以 TS 模板串里要写成 \\t。 */
const CMD_CONTAINERS =
  "docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null"
const CMD_IMAGES =
  "docker images --format '{{.Repository}}:{{.Tag}}\\t{{.Size}}' 2>/dev/null"
const CMD_COMPOSE_SERVICES =
  'docker ps --format \'{{.Label "com.docker.compose.service"}}\' 2>/dev/null | sort -u'
const CMD_SERVICES = [
  'systemctl list-unit-files --type=service --plain --no-legend 2>/dev/null | awk \'{print $1}\'',
  'ls -1 /etc/init.d 2>/dev/null'
].join('; ')
const CMD_USERS = "awk -F: '{print $1\"\\t\"$3}' /etc/passwd 2>/dev/null"
const CMD_GROUPS = "awk -F: '{print $1\"\\t\"$3}' /etc/group 2>/dev/null"
const CMD_PROCS = 'ps -eo pid,pcpu,comm --no-headers 2>/dev/null | head -n 300'
const CMD_HOSTS = "grep -v '^#' /etc/hosts 2>/dev/null | awk '{if ($2) print $2\"\\t\"$1}' | head -n 200"

export function clearCompleteCache(profileId?: string): void {
  if (!profileId) {
    cache.clear()
    inflight.clear()
    return
  }
  const prefix = profileId + '|'
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k)
}

const VALID_SOURCES: readonly CompSource[] = [
  'path',
  'container',
  'image',
  'service',
  'composeService',
  'user',
  'group',
  'process',
  'procname',
  'host',
  'branch',
  'remote'
]

export async function completeDynamic(
  profileId: string,
  source: CompSource,
  arg?: string
): Promise<CompleteItem[]> {
  if (!VALID_SOURCES.includes(source)) return []
  const key = `${profileId}|${source}|${arg ?? ''}`

  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.items

  const running = inflight.get(key)
  if (running) return running

  const job = load(profileId, source, arg)
    .then((items) => {
      cache.set(key, { ts: Date.now(), items })
      return items
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, job)
  return job
}

/* ------------------------------------------------------------------ 取数 */

async function load(
  profileId: string,
  source: CompSource,
  arg?: string
): Promise<CompleteItem[]> {
  try {
    if (source === 'path') return await pathItems(profileId, arg ?? '')
    if (source === 'container') return await containerItems(profileId)
    if (source === 'image') return await imageItems(profileId)
    if (source === 'service') return await serviceItems(profileId)
    if (source === 'composeService') return await composeServiceItems(profileId)
    if (source === 'user' || source === 'group') return await idItems(profileId, source)
    if (source === 'process' || source === 'procname') return await processItems(profileId, source)
    if (source === 'host') return await hostItems(profileId)
    if (source === 'branch' || source === 'remote') return await gitItems(profileId, source, arg)
    return []
  } catch {
    // 补全失败就退化成一个空列表，绝不打断用户
    return []
  }
}

async function sh(profileId: string, cmd: string, timeout = 12000): Promise<string> {
  return sshManager.execSoft(profileId, cmd, timeout)
}

/** 把「一行一条、字段用 \t 分隔」的输出解析成候选 */
function parseTabbed(
  out: string,
  make: (fields: string[]) => CompleteItem | null,
  limit = MAX_ITEMS
): CompleteItem[] {
  const items: CompleteItem[] = []
  const seen = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const item = make(line.split('\t'))
    if (!item || !item.value || seen.has(item.value)) continue
    seen.add(item.value)
    items.push(item)
    if (items.length >= limit) break
  }
  return items
}

/* ------------------------------------------------------------ 路径 */

async function pathItems(profileId: string, dir: string): Promise<CompleteItem[]> {
  const home = await sshManager.home(profileId)
  const target = resolveDir(dir, home)
  const entries = await sshManager.listDir(profileId, target)
  return entries.slice(0, MAX_ITEMS).map((e) => ({
    value: e.name,
    desc: e.isDir
      ? '目录'
      : e.isSymlink
        ? `链接 · ${formatBytes(e.size)}`
        : formatBytes(e.size),
    isDir: e.isDir,
    isSymlink: e.isSymlink
  }))
}

/** 把 '~'、相对路径、绝对路径统一成 SFTP 能吃的绝对路径 */
function resolveDir(dir: string, home: string): string {
  const d = (dir || '').trim()
  if (!d || d === '.') return home
  if (d === '~') return home
  if (d === '/') return '/'
  if (d.startsWith('~/')) return posixNormalize(posixJoin(home, d.slice(2)))
  if (d.startsWith('/')) return posixNormalize(d)
  return posixNormalize(posixJoin(home, d))
}

/* ------------------------------------------------------------ Docker */

async function containerItems(profileId: string): Promise<CompleteItem[]> {
  const out = await sh(profileId, CMD_CONTAINERS)
  return parseTabbed(out, ([name, status, image]) => {
    if (!name) return null
    const parts = [status?.trim(), image?.trim()].filter(Boolean)
    return { value: name, desc: parts.join(' · ') || '容器' }
  })
}

async function imageItems(profileId: string): Promise<CompleteItem[]> {
  const out = await sh(profileId, CMD_IMAGES)
  return parseTabbed(out, ([ref, size]) => {
    if (!ref || ref === '<none>:<none>') return null
    return { value: ref, desc: size?.trim() || '镜像' }
  })
}

async function composeServiceItems(profileId: string): Promise<CompleteItem[]> {
  const out = await sh(profileId, CMD_COMPOSE_SERVICES, 8000)
  return parseTabbed(out, ([name]) => (name?.trim() ? { value: name.trim(), desc: 'compose 服务' } : null))
}

/* ------------------------------------------------------- 系统 / 用户 */

async function serviceItems(profileId: string): Promise<CompleteItem[]> {
  const out = await sh(profileId, CMD_SERVICES, 15000)
  return parseTabbed(out, ([name]) => {
    const n = name?.trim()
    if (!n || n.includes('@')) return null // 模板单元（foo@.service）先不列，噪音太大
    return { value: n.replace(/\.service$/, ''), desc: '服务' }
  })
}

async function idItems(profileId: string, source: 'user' | 'group'): Promise<CompleteItem[]> {
  const out = await sh(profileId, source === 'user' ? CMD_USERS : CMD_GROUPS)
  return parseTabbed(out, ([name, id]) => {
    const n = name?.trim()
    if (!n) return null
    const num = Number(id)
    let desc = source === 'user' ? '普通用户' : '用户组'
    if (source === 'user') {
      if (num === 0) desc = 'root 超级用户'
      else if (!Number.isNaN(num) && num < 1000) desc = `系统账号（uid ${num}）`
      else desc = `普通用户（uid ${num}）`
    } else if (!Number.isNaN(num)) {
      desc = num < 1000 ? `系统组（gid ${num}）` : `用户组（gid ${num}）`
    }
    return { value: n, desc }
  })
}

async function processItems(
  profileId: string,
  source: 'process' | 'procname'
): Promise<CompleteItem[]> {
  if (source === 'procname') {
    const out = await sh(profileId, 'ps -eo comm --no-headers 2>/dev/null | sort -u | head -n 400')
    return parseTabbed(out, ([name]) => (name?.trim() ? { value: name.trim(), desc: '进程名' } : null))
  }
  const out = await sh(profileId, CMD_PROCS)
  return parseTabbed(out, ([pid, cpu, comm]) => {
    const p = pid?.trim()
    if (!p || !/^\d+$/.test(p)) return null
    const c = cpu?.trim()
    const name = comm?.trim() ?? ''
    return { value: p, desc: `${name}${c ? ` · CPU ${c}%` : ''}` }
  })
}

async function hostItems(profileId: string): Promise<CompleteItem[]> {
  const out = await sh(profileId, CMD_HOSTS, 8000)
  return parseTabbed(out, ([name, ip]) => {
    const n = name?.trim()
    if (!n) return null
    return { value: n, desc: ip?.trim() || '主机' }
  })
}

/* ----------------------------------------------------------------- Git */

/** POSIX 单引号转义；路径由渲染层算好传过来，仍要做一次防注入校验 */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function safeDir(dir?: string): string | null {
  const d = (dir || '').trim()
  if (!d) return null
  if (/[\n\r\0]/.test(d)) return null
  return d
}

async function gitItems(
  profileId: string,
  source: 'branch' | 'remote',
  dir?: string
): Promise<CompleteItem[]> {
  const cwd = safeDir(dir)
  if (!cwd) return []
  const cmd =
    source === 'branch'
      ? `git -C ${shq(cwd)} for-each-ref --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null | head -n 200`
      : `git -C ${shq(cwd)} remote 2>/dev/null | head -n 50`
  const out = await sh(profileId, cmd, 8000)
  return parseTabbed(out, ([name]) => {
    const n = name?.trim()
    if (!n || n.endsWith('/HEAD') || n === 'HEAD') return null
    return { value: n, desc: source === 'branch' ? '分支' : '远端' }
  })
}
