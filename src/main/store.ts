import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionSecret } from '@shared/types'

interface StoreShape {
  version: number
  profiles: ConnectionProfile[]
  /** id -> base64(safeStorage 加密后的凭据) */
  secrets: Record<string, string>
  /** 凭据是否以明文降级存储（safeStorage 不可用时） */
  plaintextFallback?: boolean
}

const EMPTY: StoreShape = { version: 1, profiles: [], secrets: {} }

let cache: StoreShape | null = null

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) {
    // sync mkdir 在启动路径上更省心
    require('node:fs').mkdirSync(dir, { recursive: true })
  }
  return dir
}

function storePath(): string {
  return join(dataDir(), 'connections.json')
}

async function load(): Promise<StoreShape> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as StoreShape
    cache = {
      version: parsed.version ?? 1,
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      secrets: parsed.secrets ?? {},
      plaintextFallback: parsed.plaintextFallback
    }
  } catch {
    cache = { ...EMPTY }
  }
  return cache!
}

/** 写盘串行化 + 临时文件唯一化。
 *
 *  原来用固定的 `connections.json.tmp`：两次 persist 交错时（例如刚保存完连接就点连接，
 *  saveProfile 与 touchProfile 各写一次），先跑完的那次已经把 tmp 改名走了，
 *  后一次 rename 的源文件就没了 → Windows 抛 ENOENT，界面上弹出「连接失败」。
 *  这里既排队执行，又给临时文件带上 pid + 序号，双保险。 */
let persistChain: Promise<void> = Promise.resolve()
let persistSeq = 0

function persist(): Promise<void> {
  if (!cache) return Promise.resolve()
  const snapshot = JSON.stringify(cache, null, 2)
  const run = async (): Promise<void> => {
    const file = storePath()
    const tmp = `${file}.${process.pid}.${++persistSeq}.tmp`
    try {
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
  }
  // 用同一个 run 同时当成功/失败回调：前一次失败也不能卡死后面的写入
  persistChain = persistChain.then(run, run)
  return persistChain
}

/* ------------------------------------------------------------- 凭据加解密 */

function encryptSecret(secret: ConnectionSecret): { value: string; plaintext: boolean } {
  const json = JSON.stringify(secret)
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { value: safeStorage.encryptString(json).toString('base64'), plaintext: false }
    }
  } catch {
    /* fall through */
  }
  // 降级：极少见（例如某些精简版 Windows / 无 DPAPI）。仅 base64 混淆，不是加密。
  return { value: 'PLAIN:' + Buffer.from(json, 'utf8').toString('base64'), plaintext: true }
}

function decryptSecret(value: string | undefined): ConnectionSecret | undefined {
  if (!value) return undefined
  try {
    if (value.startsWith('PLAIN:')) {
      return JSON.parse(Buffer.from(value.slice(6), 'base64').toString('utf8'))
    }
    return JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64')))
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ 对外 API */

export async function listProfiles(): Promise<ConnectionProfile[]> {
  const s = await load()
  return [...s.profiles].sort((a, b) => {
    const ga = a.group ?? ''
    const gb = b.group ?? ''
    if (ga !== gb) return ga.localeCompare(gb, 'zh-CN')
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

export async function getProfile(id: string): Promise<ConnectionProfile | undefined> {
  const s = await load()
  return s.profiles.find((p) => p.id === id)
}

export async function saveProfile(
  input: Partial<ConnectionProfile> & { name: string; host: string; username: string },
  secret?: ConnectionSecret
): Promise<ConnectionProfile> {
  const s = await load()
  const now = Date.now()
  let profile: ConnectionProfile

  if (input.id) {
    const idx = s.profiles.findIndex((p) => p.id === input.id)
    if (idx < 0) throw new Error('连接不存在: ' + input.id)
    profile = { ...s.profiles[idx], ...input, updatedAt: now } as ConnectionProfile
    s.profiles[idx] = profile
  } else {
    profile = {
      id: randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port ?? 22,
      username: input.username,
      authType: input.authType ?? 'password',
      privateKeyPath: input.privateKeyPath,
      group: input.group || '默认分组',
      color: input.color ?? pickColor(s.profiles.length),
      note: input.note,
      createdAt: now,
      updatedAt: now
    }
    s.profiles.push(profile)
  }

  // secret 为 undefined 表示「不改动」；为 {} 表示「清空」
  if (secret !== undefined) {
    const hasAny = Object.values(secret).some((v) => !!v)
    if (hasAny) {
      const { value, plaintext } = encryptSecret(secret)
      s.secrets[profile.id] = value
      if (plaintext) s.plaintextFallback = true
    } else {
      delete s.secrets[profile.id]
    }
  }

  await persist()
  return profile
}

export async function deleteProfile(id: string): Promise<void> {
  const s = await load()
  s.profiles = s.profiles.filter((p) => p.id !== id)
  delete s.secrets[id]
  await persist()
}

export async function getSecret(id: string): Promise<ConnectionSecret | undefined> {
  const s = await load()
  return decryptSecret(s.secrets[id])
}

export async function touchProfile(id: string): Promise<void> {
  const s = await load()
  const p = s.profiles.find((x) => x.id === id)
  if (p) {
    p.lastUsedAt = Date.now()
    await persist()
  }
}

/** 导出（不含凭据），便于备份 / 迁移 */
export async function exportProfiles(): Promise<string> {
  const s = await load()
  return JSON.stringify({ version: 1, profiles: s.profiles }, null, 2)
}

export async function importProfiles(json: string): Promise<number> {
  const parsed = JSON.parse(json)
  const incoming: ConnectionProfile[] = Array.isArray(parsed) ? parsed : parsed.profiles
  if (!Array.isArray(incoming)) throw new Error('文件格式不正确')
  const s = await load()
  let added = 0
  for (const p of incoming) {
    const exists = s.profiles.some((x) => x.host === p.host && x.port === p.port && x.username === p.username)
    if (exists) continue
    s.profiles.push({ ...p, id: randomUUID(), createdAt: p.createdAt ?? Date.now(), updatedAt: Date.now() })
    added++
  }
  await persist()
  return added
}

export async function isPlaintextFallback(): Promise<boolean> {
  const s = await load()
  return !!s.plaintextFallback
}

function pickColor(seed: number): string {
  const palette = [
    '#6366f1',
    '#8b5cf6',
    '#0ea5e9',
    '#14b8a6',
    '#f59e0b',
    '#ef4444',
    '#ec4899',
    '#22c55e'
  ]
  return palette[seed % palette.length]
}
