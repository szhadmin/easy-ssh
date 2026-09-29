import type { IpcResult } from '@shared/types'

/** 统一解包 IPC 结果：失败直接 throw，调用方用 try/catch 或 toast() 兜住 */
export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const r = await p
  if (!r || !r.ok) throw new Error(r?.error ?? '未知错误')
  return r.data as T
}

export function formatBytes(n: number, digits?: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const d = digits ?? (i === 0 ? 0 : v >= 100 ? 1 : 2)
  return `${v.toFixed(d)} ${units[i]}`
}

export function formatKb(kb: number): string {
  return formatBytes(kb * 1024)
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** 网络速率，KB/s 起步，超过 1MB/s 自动升级单位 */
export function formatKbps(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return '-'
  const kbps = bytesPerSec / 1024
  if (kbps < 1024) return `${kbps.toFixed(kbps >= 100 ? 0 : 1)} KB/s`
  return `${(kbps / 1024).toFixed(2)} MB/s`
}

export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '-'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分钟`
}

export function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 使用率 -> 颜色（绿 -> 琥珀 -> 红） */
export function usageColor(percent: number): string {
  if (percent >= 85) return '#e11d48'
  if (percent >= 65) return '#d97706'
  return '#15a34a'
}

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function shortName(name: string, max = 2): string {
  const t = (name || '?').trim()
  if (!t) return '?'
  const ascii = /^[\x20-\x7f]+$/.test(t)
  return ascii ? t.slice(0, max).toUpperCase() : t.slice(0, max)
}

/** 从 mode 数值生成 rwxrwxrwx */
export function modeString(mode: number): string {
  const bit = (m: number, s: string): string => ((mode & m) ? s : '-')
  return (
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

/** 远程路径规范化（处理 .. 与重复斜杠） */
export function normalizePath(p: string): string {
  if (!p) return '/'
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length) out.pop()
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  if (abs) return '/' + joined
  return joined || '.'
}

export function parentPath(p: string): string {
  const n = normalizePath(p)
  if (n === '/') return '/'
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}

/** 判断是否像一个文本文件（用于决定能否进编辑器） */
const TEXT_EXT = new Set([
  'txt', 'log', 'conf', 'cfg', 'ini', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'sh', 'bash', 'zsh', 'fish',
  'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'pl', 'lua', 'sql',
  'env', 'properties', 'service', 'md', 'markdown', 'csv', 'tsv', 'gitignore', 'dockerfile',
  'nginx', 'lock', 'pem', 'pub', 'crt', 'key', 'restart', 'rules', 'list', 'repo', 'desktop'
])

export function isProbablyText(name: string): boolean {
  if (/^(Dockerfile|Makefile|Jenkinsfile|\.env|\.bashrc|\.profile|\.gitconfig)$/i.test(name)) return true
  const idx = name.lastIndexOf('.')
  if (idx < 0) return true // 无扩展名（脚本、配置）大多可编辑
  return TEXT_EXT.has(name.slice(idx + 1).toLowerCase())
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
