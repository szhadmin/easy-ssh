/**
 * Agent 的跨会话长期记忆 —— 每台服务器各记一小撮「长期事实」。
 *
 * 和会话内历史的区别：历史只活在当前这次对话里，重开应用就没了；
 * 这里记的是「下次再连上这台机器时依然成立的东西」，例如
 *   - 这台机器用 apt 管理软件包，不是 yum
 *   - nginx 的站点配置在 /etc/nginx/conf.d/
 *   - /data 是生产数据目录，不要动
 *
 * 由模型通过 remember 工具主动写入，用户也可以在「模型配置」里手动增删。
 * 必须让用户看得见、删得掉 —— 否则哪天模型记错了什么，就无从纠正。
 *
 * 存 userData/data/agent-memory.json，按 profileId 分组，新的在前。
 * 写盘方式与 agent.json 保持一致：先写临时文件再 rename，并且串行化。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMemoryFact } from '@shared/types'

/** 每台服务器最多记多少条；到顶后新的挤掉最旧的 */
export const MAX_FACTS_PER_PROFILE = 50
/** 单条事实的长度上限 */
export const MAX_FACT_LENGTH = 200

interface MemoryFile {
  version: 1
  profiles: Record<string, AgentMemoryFact[]>
}

const EMPTY: MemoryFile = { version: 1, profiles: {} }

let cache: MemoryFile | null = null

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function filePath(): string {
  return join(dataDir(), 'agent-memory.json')
}

async function load(): Promise<MemoryFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fs.readFile(filePath(), 'utf8')) as Partial<MemoryFile>
    const profiles: Record<string, AgentMemoryFact[]> = {}
    if (parsed.profiles && typeof parsed.profiles === 'object') {
      for (const [pid, list] of Object.entries(parsed.profiles)) {
        if (!Array.isArray(list)) continue
        profiles[pid] = list.filter(
          (f): f is AgentMemoryFact =>
            !!f && typeof f.text === 'string' && f.text.trim().length > 0
        )
      }
    }
    cache = { version: 1, profiles }
  } catch {
    cache = { ...EMPTY, profiles: {} }
  }
  return cache
}

/** 写盘串行化：模型可能在同一轮里连着记好几条 */
let chain: Promise<void> = Promise.resolve()
let seq = 0

function persist(): Promise<void> {
  if (!cache) return Promise.resolve()
  const snapshot = JSON.stringify(cache, null, 2)
  const run = async (): Promise<void> => {
    const file = filePath()
    const tmp = `${file}.${process.pid}.${++seq}.tmp`
    try {
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
  }
  chain = chain.then(run, run)
  return chain
}

export async function listFacts(profileId: string): Promise<AgentMemoryFact[]> {
  const f = await load()
  return f.profiles[profileId] ?? []
}

/**
 * 记一条事实。
 *
 * 会先做归一化（压掉多余空白）与去重 —— 模型很爱把同样的意思换个说法记第二遍，
 * 不去重的话几十条上限很快就被废话占满。
 */
export async function addFact(
  profileId: string,
  text: string,
  source: 'agent' | 'user'
): Promise<{ facts: AgentMemoryFact[]; added: boolean; reason?: string }> {
  const clean = (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH)
  if (!clean) return { facts: await listFacts(profileId), added: false, reason: '内容是空的' }

  const f = await load()
  const list = f.profiles[profileId] ?? []
  if (list.some((x) => x.text === clean)) {
    return { facts: list, added: false, reason: '这条已经记过了' }
  }

  const fact: AgentMemoryFact = {
    id: randomUUID(),
    text: clean,
    createdAt: Date.now(),
    source
  }
  const next = [fact, ...list].slice(0, MAX_FACTS_PER_PROFILE)
  f.profiles[profileId] = next
  await persist()
  return { facts: next, added: true }
}

export async function removeFact(
  profileId: string,
  id: string
): Promise<AgentMemoryFact[]> {
  const f = await load()
  const list = f.profiles[profileId] ?? []
  const next = list.filter((x) => x.id !== id)
  if (next.length === list.length) return list
  f.profiles[profileId] = next
  await persist()
  return next
}

export async function clearFacts(profileId: string): Promise<AgentMemoryFact[]> {
  const f = await load()
  if (!f.profiles[profileId]?.length) return []
  f.profiles[profileId] = []
  await persist()
  return []
}

/**
 * 拼进 system prompt 的形态。没有记忆时返回空串，避免白白占上下文。
 *
 * 结尾特意留了一条纠错出口：记忆是模型自己写的，可能过时或记错，
 * 得让它知道「发现不对就该改口」，而不是拿旧结论硬套。
 */
export function formatMemory(facts: AgentMemoryFact[]): string {
  if (!facts.length) return ''
  return (
    '【关于这台服务器你已经记下的事实】（来自之前的对话，可直接采信）\n' +
    facts.map((f) => `- ${f.text}`).join('\n') +
    '\n这些是你自己之前记下的，可能已经过时。一旦发现与实际情况冲突，' +
    '以实际探测结果为准，并用 remember 更新掉旧说法。'
  )
}
