import type { DockerContainer, DockerDetect, DockerImage } from '@shared/types'
import { sshManager } from './ssh-manager'

/** docker 权限不足时的统一提示 */
function friendly(text: string): string {
  const t = (text || '').trim()
  if (/permission denied while trying to connect to the Docker daemon|Got permission denied/i.test(t)) {
    return '当前账号无 Docker 权限。请把用户加入 docker 组（sudo usermod -aG docker $USER 后重新登录），或改用 root 账号 / sudo。'
  }
  if (/Cannot connect to the Docker daemon/i.test(t)) {
    return 'Docker 守护进程未运行（或未安装）。请在服务器上执行 systemctl start docker 后重试。'
  }
  if (/command not found|not found/i.test(t)) return '目标服务器上未安装 docker。'
  return t
}

/**
 * 容器引用（ID / 名称）白名单校验。
 * 这些值会被拼进远端 shell 命令里，必须挡住注入。
 */
export function safeRef(ref: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(ref)) {
    throw new Error(`非法的容器标识: ${ref}`)
  }
  return ref
}

function parseJsonLines<T>(stdout: string): T[] {
  const out: T[] = []
  for (const line of (stdout || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      out.push(JSON.parse(s) as T)
    } catch {
      /* 跳过不能解析的行 */
    }
  }
  return out
}

export async function detect(profileId: string): Promise<DockerDetect> {
  const r = await sshManager.exec(
    profileId,
    'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>&1; else echo "__NODOCKER__"; fi',
    15000
  )
  const out = (r.stdout + r.stderr).trim()
  if (!out || out.includes('__NODOCKER__')) {
    return { available: false, error: '未检测到 docker 命令' }
  }
  if (r.code === 0 && /^[\d.]+/.test(out)) {
    return { available: true, version: out.split(/\s+/)[0] }
  }
  return { available: false, error: friendly(out) }
}

export async function containers(profileId: string): Promise<DockerContainer[]> {
  const r = await sshManager.exec(profileId, `docker ps -a --format '{{json .}}' 2>&1`, 25000)
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(friendly(r.stderr || r.stdout || 'docker ps 失败'))

  return parseJsonLines<Record<string, string>>(r.stdout).map((c) => ({
    id: c.ID ?? '',
    name: c.Names ?? '',
    image: c.Image ?? '',
    command: c.Command ?? '',
    status: c.Status ?? '',
    state: (c.State ?? '').toLowerCase(),
    ports: c.Ports ?? '',
    created: c.RunningFor || c.CreatedAt || '',
    size: c.Size || undefined
  }))
}

export async function images(profileId: string): Promise<DockerImage[]> {
  const r = await sshManager.exec(profileId, `docker images --format '{{json .}}' 2>&1`, 25000)
  return parseJsonLines<Record<string, string>>(r.stdout).map((i) => ({
    id: i.ID ?? '',
    repository: i.Repository ?? '',
    tag: i.Tag ?? '',
    size: i.Size ?? '',
    createdSince: i.CreatedSince ?? ''
  }))
}

export async function stats(profileId: string): Promise<Record<string, { cpu: string; mem: string; memPerc: string }>> {
  const r = await sshManager.exec(profileId, `docker stats --no-stream --format '{{json .}}' 2>&1`, 25000)
  const map: Record<string, { cpu: string; mem: string; memPerc: string }> = {}
  for (const row of parseJsonLines<Record<string, string>>(r.stdout)) {
    const key = row.ID || row.Container || row.Name || ''
    if (key) map[key] = { cpu: row.CPUPerc ?? '-', mem: row.MemUsage ?? '-', memPerc: row.MemPerc ?? '-' }
  }
  return map
}

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'rm', 'rm-force', 'pause', 'unpause', 'kill'])

export async function action(profileId: string, containerId: string, act: string): Promise<string> {
  if (!ALLOWED_ACTIONS.has(act)) throw new Error(`不支持的操作: ${act}`)
  const id = safeRef(containerId)
  const cmd =
    act === 'rm-force'
      ? `docker rm -f ${id}`
      : act === 'rm'
        ? `docker rm ${id}`
        : `docker ${act} ${id}`
  const r = await sshManager.exec(profileId, `${cmd} 2>&1`, 40000)
  const out = (r.stdout + r.stderr).trim()
  if (r.code !== 0) throw new Error(friendly(out || `docker ${act} 执行失败`))
  return out || 'ok'
}

export async function logs(profileId: string, containerId: string, tail = 300): Promise<string> {
  const n = Math.max(10, Math.min(5000, Math.floor(tail)))
  const id = safeRef(containerId)
  const r = await sshManager.exec(profileId, `docker logs --timestamps --tail ${n} ${id} 2>&1`, 30000)
  return r.stdout || r.stderr || '（无日志输出）'
}

export interface ContainerDetail {
  id: string
  name: string
  image: string
  created: string
  state: string
  status: string
  restartPolicy: string
  cmd: string[]
  entrypoint: string[]
  env: string[]
  ports: string[]
  mounts: string[]
  networks: string[]
  ip: string
  platform: string
}

export async function inspect(profileId: string, containerId: string): Promise<ContainerDetail> {
  const id = safeRef(containerId)
  const r = await sshManager.exec(profileId, `docker inspect ${id} 2>&1`, 25000)
  const text = r.stdout.trim()
  if (!text.startsWith('[')) throw new Error(friendly(text || 'docker inspect 失败'))
  const arr = JSON.parse(text) as Array<Record<string, any>>
  const d = arr[0]
  if (!d) throw new Error('未找到容器信息')

  const nets = d.NetworkSettings?.Networks ?? {}
  const reset = d.HostConfig?.RestartPolicy ?? {}
  return {
    id: (d.Id ?? '').slice(0, 12),
    name: (d.Name ?? '').replace(/^\//, ''),
    image: d.Config?.Image ?? '',
    created: d.Created ?? '',
    state: d.State?.Status ?? '',
    status: d.State?.Status ?? '',
    restartPolicy: reset.Name ? `${reset.Name}${reset.MaximumRetryCount ? `:${reset.MaximumRetryCount}` : ''}` : 'no',
    cmd: d.Config?.Cmd ?? [],
    entrypoint: d.Config?.Entrypoint ?? [],
    env: d.Config?.Env ?? [],
    ports: Object.entries(d.NetworkSettings?.Ports ?? {}).map(
      ([k, v]) => `${k} -> ${Array.isArray(v) && v.length ? (v as any[]).map((x) => `${x.HostIp}:${x.HostPort}`).join(', ') : '(未映射)'}`
    ),
    mounts: (d.Mounts ?? []).map((m: any) => `${m.Source} -> ${m.Destination}${m.RW === false ? ' (ro)' : ''}`),
    networks: Object.keys(nets),
    ip: (Object.values(nets)[0] as any)?.IPAddress ?? '-',
    platform: d.Platform ?? ''
  }
}

/** 容器内一次性执行命令（非交互），用于「快捷诊断」 */
export async function execInContainer(
  profileId: string,
  containerId: string,
  cmd: string
): Promise<string> {
  const id = safeRef(containerId)
  // 命令通过 base64 传递，彻底避免引号 / 转义问题
  const b64 = Buffer.from(cmd, 'utf8').toString('base64')
  const r = await sshManager.exec(
    profileId,
    `docker exec ${id} sh -c "echo ${b64} | base64 -d | sh" 2>&1`,
    30000
  )
  return r.stdout || r.stderr || '（无输出）'
}
