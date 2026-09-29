import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ConnectionProfile, DockerContainer, DockerImage } from '@shared/types'
import type { DockerDetailView } from '@shared/api'
import { useStore } from '../store'
import { Btn, Confirm, Empty, Icons } from './ui'
import { cls, formatBytes } from '../lib/utils'

const TERM_THEME = {
  background: '#12141d',
  foreground: '#dfe4f2',
  cursor: '#8b5cf6',
  selectionBackground: 'rgba(139,92,246,0.35)'
}

const QUICK_DIAGNOSTICS: Array<{ label: string; cmd: string }> = [
  { label: '查看进程', cmd: 'ps aux 2>/dev/null || ps -ef' },
  { label: '环境变量', cmd: 'env | sort' },
  { label: '工作目录', cmd: 'pwd && ls -alh' },
  { label: '磁盘占用', cmd: 'df -h 2>/dev/null; du -sh / 2>/dev/null' },
  { label: '网络连接', cmd: 'cat /proc/net/tcp 2>/dev/null | head -20' },
  { label: 'Java 线程快照', cmd: 'ls /usr/lib/jvm 2>/dev/null; java -version 2>&1' },
  { label: '监听端口', cmd: 'ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null' }
]

export function DockerPanel({ profile }: { profile: ConnectionProfile }): React.ReactElement {
  const toast = useStore((s) => s.toast)
  const detect = useStore((s) => s.docker[profile.id])
  const setDocker = useStore((s) => s.setDocker)

  const [containers, setContainers] = useState<DockerContainer[]>([])
  const [images, setImages] = useState<DockerImage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'containers' | 'images'>('containers')
  const [filter, setFilter] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmRm, setConfirmRm] = useState<DockerContainer | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const reload = useCallback(async () => {
    if (!detect?.available) return
    setLoading(true)
    setError('')
    try {
      const [c, i] = await Promise.all([
        window.api.docker.containers(profile.id),
        window.api.docker.images(profile.id)
      ])
      if (!c.ok) throw new Error(c.error)
      setContainers(c.data ?? [])
      if (i.ok) setImages(i.data ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [profile.id, detect?.available])

  // 首次进入时探测并加载
  useEffect(() => {
    if (!detect) {
      void (async () => {
        try {
          const r = await window.api.docker.detect(profile.id)
          if (r.ok && r.data) setDocker(profile.id, r.data)
        } catch {
          /* 忽略 */
        }
      })()
      return
    }
    if (detect.available) void reload()
  }, [detect, profile.id, reload, setDocker])

  useEffect(() => {
    if (!detect?.available || !autoRefresh) return
    const t = window.setInterval(() => void reload(), 8000)
    return () => window.clearInterval(t)
  }, [detect?.available, autoRefresh, reload])

  const act = async (c: DockerContainer, action: string, label: string): Promise<void> => {
    try {
      const r = await window.api.docker.action(profile.id, c.id, action)
      if (!r.ok) throw new Error(r.error)
      toast('success', `${label}成功`, c.name || c.image)
      await reload()
    } catch (e) {
      toast('error', `${label}失败`, (e as Error).message)
    }
  }

  const shown = useMemo(() => {
    const kw = filter.trim().toLowerCase()
    if (!kw) return containers
    return containers.filter(
      (c) =>
        c.name.toLowerCase().includes(kw) ||
        c.image.toLowerCase().includes(kw) ||
        c.id.toLowerCase().includes(kw) ||
        c.ports.toLowerCase().includes(kw)
    )
  }, [containers, filter])

  const summary = useMemo(() => {
    const running = containers.filter((c) => c.state === 'running').length
    const stopped = containers.filter((c) => c.state === 'exited' || c.state === 'dead').length
    return { total: containers.length, running, stopped }
  }, [containers])

  const open = containers.find((c) => c.id === openId) ?? null

  /* ------------------------------------------------- 未安装 / 不可用 */

  if (detect && !detect.available) {
    return (
      <div className="panel">
        <Empty
          icon={<Icons.docker size={44} />}
          title="没有检测到可用的 Docker"
          desc={detect.error || '该服务器上未安装 docker，或当前账号没有访问权限。'}
        >
          <div className="steps">
            <div className="step">
              <span className="step-no">1</span>
              <span className="step-text">
                确认是否安装：在终端执行 <span className="mono">docker -v</span>；未装可用官方脚本一键安装。
              </span>
            </div>
            <div className="step">
              <span className="step-no">2</span>
              <span className="step-text">
                若提示权限不足，把当前用户加入 docker 组：
                <span className="mono"> sudo usermod -aG docker $USER</span>，然后重新登录。
              </span>
            </div>
            <div className="step">
              <span className="step-no">3</span>
              <span className="step-text">
                若守护进程没起来：<span className="mono">sudo systemctl start docker</span>。
              </span>
            </div>
            <div className="step">
              <span className="step-no">4</span>
              <span className="step-text">
                处理完后点下面的「重新检测」，或直接切换到「终端」标签页手工排查。
              </span>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
            <Btn
              variant="primary"
              icon={<Icons.refresh size={14} />}
              onClick={async () => {
                const r = await window.api.docker.detect(profile.id)
                if (r.ok && r.data) {
                  setDocker(profile.id, r.data)
                  if (r.data.available) toast('success', '已检测到 Docker', r.data.version)
                  else toast('warn', '仍未检测到 Docker', r.data.error)
                }
              }}
            >
              重新检测
            </Btn>
          </div>
        </Empty>
      </div>
    )
  }

  if (!detect) {
    return (
      <div className="panel muted center">
        <span className="spinner" /> 正在检测 Docker 环境…
      </div>
    )
  }

  /* -------------------------------------------------------------- 主界面 */

  return (
    <div className="panel flush">
      <div className="pathbar">
        <div className="row" style={{ gap: 4 }}>
          <Btn size="sm" variant={view === 'containers' ? 'primary' : 'default'} onClick={() => setView('containers')}>
            容器 {summary.total}
          </Btn>
          <Btn size="sm" variant={view === 'images' ? 'primary' : 'default'} onClick={() => setView('images')}>
            镜像 {images.length}
          </Btn>
        </div>

        <span className="chip green">运行中 {summary.running}</span>
        <span className="chip">已停止 {summary.stopped}</span>
        <span className="chip accent">Docker {detect.version ?? '-'}</span>

        <span style={{ flex: 1 }} />

        <input
          className="input"
          style={{ width: 190 }}
          placeholder="筛选名称 / 镜像 / 端口"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <label className="checkbox" title="每 8 秒自动刷新容器状态">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          自动刷新
        </label>

        <Btn size="sm" icon={<Icons.refresh size={13} />} loading={loading} onClick={() => void reload()}>
          刷新
        </Btn>
      </div>

      {error ? (
        <div style={{ padding: '10px 14px' }}>
          <div className="banner error" style={{ marginBottom: 0 }}>
            <Icons.warn size={15} />
            <div>{error}</div>
          </div>
        </div>
      ) : null}

      <div className="docker-shell">
        <div className="docker-main">
          <div className="file-list">
            {view === 'containers' ? (
              <>
                <div className="file-row head" style={{ gridTemplateColumns: '150px 1fr 200px 120px 96px' }}>
                  <div>状态</div>
                  <div>名称 / 镜像</div>
                  <div>端口映射</div>
                  <div>运行时长</div>
                  <div style={{ textAlign: 'right' }}>操作</div>
                </div>
                {shown.map((c) => (
                  <div
                    key={c.id}
                    className={cls('file-row', openId === c.id && 'selected')}
                    style={{ gridTemplateColumns: '150px 1fr 200px 120px 96px', cursor: 'pointer' }}
                    onClick={() => setOpenId(c.id)}
                  >
                    <div>
                      <span className={cls('tag', c.state)}>{stateLabel(c.state)}</span>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name}
                      </div>
                      <div className="dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.image}
                      </div>
                    </div>
                    <div className="dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.ports}>
                      {c.ports || '—'}
                    </div>
                    <div className="dim">{c.created || '—'}</div>
                    <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                      {c.state === 'running' ? (
                        <>
                          <Btn size="sm" variant="ghost" title="停止" onClick={() => void act(c, 'stop', '停止容器')}>
                            <Icons.stop size={12} />
                          </Btn>
                          <Btn size="sm" variant="ghost" title="重启" onClick={() => void act(c, 'restart', '重启容器')}>
                            <Icons.restart size={12} />
                          </Btn>
                        </>
                      ) : (
                        <Btn size="sm" variant="ghost" title="启动" onClick={() => void act(c, 'start', '启动容器')}>
                          <Icons.play size={12} />
                        </Btn>
                      )}
                      <Btn size="sm" variant="ghost" title="删除容器" onClick={() => setConfirmRm(c)}>
                        <Icons.trash size={12} />
                      </Btn>
                    </div>
                  </div>
                ))}
                {shown.length === 0 && !loading ? (
                  <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
                    没有容器。可以在终端里用 <span className="mono">docker run</span> 启动一个。
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="file-row head" style={{ gridTemplateColumns: '1fr 220px 110px 140px' }}>
                  <div>仓库 / 标签</div>
                  <div>镜像 ID</div>
                  <div style={{ textAlign: 'right' }}>大小</div>
                  <div>创建时间</div>
                </div>
                {images.map((i) => (
                  <div key={i.id + i.tag} className="file-row" style={{ gridTemplateColumns: '1fr 220px 110px 140px' }}>
                    <div className="mono">
                      {i.repository}
                      <span className="muted">:{i.tag}</span>
                    </div>
                    <div className="dim">{i.id.replace('sha256:', '').slice(0, 12)}</div>
                    <div className="dim" style={{ textAlign: 'right' }}>
                      {i.size}
                    </div>
                    <div className="dim">{i.createdSince}</div>
                  </div>
                ))}
                {images.length === 0 ? (
                  <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
                    本地没有镜像。
                  </div>
                ) : null}
              </>
            )}
            {loading ? (
              <div className="muted center" style={{ padding: 16 }}>
                <span className="spinner" /> 正在读取 Docker…
              </div>
            ) : null}
          </div>
        </div>

        {open ? (
          <ContainerDrawer
            profile={profile}
            container={open}
            onClose={() => setOpenId(null)}
            onAction={act}
            onRequestDelete={() => setConfirmRm(open)}
          />
        ) : null}
      </div>

      {confirmRm ? (
        <Confirm
          title="删除容器"
          danger
          confirmText="强制删除"
          message={
            <>
              确定删除容器 <b>{confirmRm.name}</b> 吗？
              <br />
              <span className="muted">
                将执行 <span className="mono">docker rm -f</span>：容器会先被强制停止再删除，容器内的临时数据会丢失；
                若 /data 之类的目录挂载到了宿主机，挂载卷里的数据不受影响。
              </span>
            </>
          }
          onCancel={() => setConfirmRm(null)}
          onConfirm={() => {
            const c = confirmRm
            setConfirmRm(null)
            setOpenId(null)
            void act(c, 'rm-force', '删除容器')
          }}
        />
      ) : null}
    </div>
  )
}

function stateLabel(state: string): string {
  switch (state) {
    case 'running':
      return '运行中'
    case 'exited':
      return '已停止'
    case 'paused':
      return '已暂停'
    case 'created':
      return '已创建'
    case 'restarting':
      return '重启中'
    case 'dead':
      return '异常'
    default:
      return state || '未知'
  }
}

/* ------------------------------------------------------------- 详情抽屉 */

function ContainerDrawer({
  profile,
  container,
  onClose,
  onAction,
  onRequestDelete
}: {
  profile: ConnectionProfile
  container: DockerContainer
  onClose: () => void
  onAction: (c: DockerContainer, action: string, label: string) => Promise<void>
  onRequestDelete: () => void
}): React.ReactElement {
  const toast = useStore((s) => s.toast)
  const [tab, setTab] = useState<'detail' | 'logs' | 'term'>('detail')
  const [detail, setDetail] = useState<DockerDetailView | null>(null)
  const [logs, setLogs] = useState('')
  const [logTail, setLogTail] = useState(300)
  const [followLogs, setFollowLogs] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const loadDetail = useCallback(async () => {
    try {
      const r = await window.api.docker.inspect(profile.id, container.id)
      if (!r.ok) throw new Error(r.error)
      setDetail(r.data ?? null)
    } catch (e) {
      setLoadErr((e as Error).message)
    }
  }, [profile.id, container.id])

  const loadLogs = useCallback(async () => {
    try {
      const r = await window.api.docker.logs(profile.id, container.id, logTail)
      if (!r.ok) throw new Error(r.error)
      setLogs(r.data ?? '')
    } catch (e) {
      setLogs(`读取日志失败：${(e as Error).message}`)
    }
  }, [profile.id, container.id, logTail])

  useEffect(() => {
    setDetail(null)
    setLogs('')
    setLoadErr('')
    setTab('detail')
    void loadDetail()
  }, [container.id, loadDetail])

  useEffect(() => {
    if (tab !== 'logs') return
    void loadLogs()
    if (!followLogs) return
    const t = window.setInterval(() => void loadLogs(), 4000)
    return () => window.clearInterval(t)
  }, [tab, followLogs, loadLogs])

  useEffect(() => {
    // 跟随滚动到底部
    const el = logRef.current
    if (el && followLogs) el.scrollTop = el.scrollHeight
  }, [logs, followLogs])

  return (
    <div className="docker-drawer">
      <div className="drawer-head">
        <div className="row">
          <span className={cls('tag', container.state)}>{stateLabel(container.state)}</span>
          <b style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {container.name}
          </b>
          <span style={{ flex: 1 }} />
          <Btn size="sm" variant="ghost" icon={<Icons.close size={13} />} onClick={onClose} />
        </div>
        <div className="dim mt8" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {container.image} · {container.created}
        </div>
        <div className="row mt8" style={{ gap: 5 }}>
          {container.state === 'running' ? (
            <>
              <Btn size="sm" icon={<Icons.restart size={12} />} onClick={() => void onAction(container, 'restart', '重启容器')}>
                重启
              </Btn>
              <Btn size="sm" icon={<Icons.stop size={12} />} onClick={() => void onAction(container, 'stop', '停止容器')}>
                停止
              </Btn>
            </>
          ) : (
            <Btn size="sm" variant="primary" icon={<Icons.play size={12} />} onClick={() => void onAction(container, 'start', '启动容器')}>
              启动
            </Btn>
          )}
          <Btn size="sm" variant="danger" icon={<Icons.trash size={12} />} onClick={onRequestDelete}>
            删除
          </Btn>
        </div>
      </div>

      <div className="drawer-tabs">
        <button className={cls('drawer-tab', tab === 'detail' && 'active')} onClick={() => setTab('detail')}>
          详情
        </button>
        <button className={cls('drawer-tab', tab === 'logs' && 'active')} onClick={() => setTab('logs')}>
          日志
        </button>
        <button
          className={cls('drawer-tab', tab === 'term' && 'active')}
          onClick={() => setTab('term')}
          disabled={container.state !== 'running'}
          title={container.state !== 'running' ? '容器未运行，无法进入' : '进入容器内部'}
        >
          进入容器
        </button>
      </div>

      {tab === 'detail' ? (
        <div className="drawer-body">
          {loadErr ? <div className="banner error">{loadErr}</div> : null}
          {!detail ? (
            <div className="muted center">
              <span className="spinner" /> 读取容器配置…
            </div>
          ) : (
            <>
              <dl className="kv">
                <dt>容器 ID</dt>
                <dd>{detail.id}</dd>
                <dt>镜像</dt>
                <dd>{detail.image}</dd>
                <dt>创建时间</dt>
                <dd>{detail.created}</dd>
                <dt>重启策略</dt>
                <dd>{detail.restartPolicy}</dd>
                <dt>容器 IP</dt>
                <dd>{detail.ip}</dd>
                <dt>网络</dt>
                <dd>{detail.networks.join(', ') || '—'}</dd>
              </dl>

              <Section title="启动命令">
                <div className="log-view" style={{ maxHeight: 120 }}>
                  {[...(detail.entrypoint ?? []), ...(detail.cmd ?? [])].join(' ') || '（镜像默认）'}
                </div>
              </Section>

              <Section title={`端口映射（${detail.ports.length}）`}>
                {detail.ports.length ? (
                  detail.ports.map((p) => (
                    <div key={p} className="mono" style={{ fontSize: 11.5, padding: '3px 0' }}>
                      {p}
                    </div>
                  ))
                ) : (
                  <span className="muted">未映射端口</span>
                )}
              </Section>

              <Section title={`挂载卷（${detail.mounts.length}）`}>
                {detail.mounts.length ? (
                  detail.mounts.map((m) => (
                    <div key={m} className="mono" style={{ fontSize: 11.5, padding: '3px 0', wordBreak: 'break-all' }}>
                      {m}
                    </div>
                  ))
                ) : (
                  <span className="muted">没有挂载</span>
                )}
              </Section>

              <Section title={`环境变量（${detail.env.length}）`}>
                <div className="log-view" style={{ maxHeight: 180 }}>
                  {detail.env.join('\n') || '（无）'}
                </div>
              </Section>

              <Section title="快捷诊断（在容器内执行）">
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {QUICK_DIAGNOSTICS.map((q) => (
                    <Btn
                      key={q.label}
                      size="sm"
                      onClick={async () => {
                        try {
                          const r = await window.api.docker.exec(profile.id, container.id, q.cmd)
                          if (!r.ok) throw new Error(r.error)
                          setTab('logs')
                          setLogs(`$ ${q.cmd}\n\n${r.data ?? ''}`)
                          setFollowLogs(false)
                        } catch (e) {
                          toast('error', '执行失败', (e as Error).message)
                        }
                      }}
                    >
                      {q.label}
                    </Btn>
                  ))}
                </div>
                <div className="hint">点击后在「日志」标签页查看输出，不会影响容器本身。</div>
              </Section>
            </>
          )}
        </div>
      ) : null}

      {tab === 'logs' ? (
        <div className="drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>
              最近
            </span>
            <select
              className="select"
              style={{ width: 84, height: 26 }}
              value={logTail}
              onChange={(e) => setLogTail(Number(e.target.value))}
            >
              <option value={100}>100 行</option>
              <option value={300}>300 行</option>
              <option value={1000}>1000 行</option>
              <option value={3000}>3000 行</option>
            </select>
            <Btn size="sm" icon={<Icons.refresh size={12} />} onClick={() => void loadLogs()}>
              刷新
            </Btn>
            <label className="checkbox">
              <input type="checkbox" checked={followLogs} onChange={(e) => setFollowLogs(e.target.checked)} />
              自动跟随
            </label>
            <span style={{ flex: 1 }} />
            <Btn
              size="sm"
              icon={<Icons.copy size={12} />}
              onClick={async () => {
                await navigator.clipboard.writeText(logs)
                toast('success', '日志已复制')
              }}
            >
              复制
            </Btn>
          </div>
          <div className="log-view" ref={logRef} style={{ flex: 1, maxHeight: 'none' }}>
            {logs || '（暂无日志）'}
          </div>
        </div>
      ) : null}

      {tab === 'term' ? <ContainerTerminal profile={profile} container={container} /> : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

/* --------------------------------------------------- 容器内交互式终端 */

function ContainerTerminal({
  profile,
  container
}: {
  profile: ConnectionProfile
  container: DockerContainer
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const termId = useMemo(() => `${profile.id}#docker#${container.id}`, [profile.id, container.id])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: "'Cascadia Mono',Consolas,monospace",
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 4000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    try {
      fit.fit()
    } catch {
      /* ignore */
    }

    term.write(`\x1b[36m[Easy SSH] 正在进入容器 ${container.name} …\x1b[0m\r\n`)
    void window.api.term.open({
      termId,
      profileId: profile.id,
      kind: 'docker',
      target: container.id,
      cols: term.cols,
      rows: term.rows
    })

    const offData = window.api.term.onData((p) => {
      if (p.termId === termId) term.write(p.data)
    })
    const offExit = window.api.term.onExit((p) => {
      if (p.termId !== termId) return
      term.write(`\r\n\x1b[33m[Easy SSH] ${p.reason ?? `会话结束（code=${p.code ?? '-'}）`}\x1b[0m\r\n`)
    })
    term.onData((d) => void window.api.term.write(termId, d))

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.api.term.resize(termId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      void window.api.term.close(termId)
      term.dispose()
      termRef.current = null
    }
  }, [termId, profile.id, container.id, container.name])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="row" style={{ padding: '0 14px 8px', gap: 8 }}>
        <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>
          已在容器内打开 shell；容器内没有 bash 时会自动退回 sh。输入 <span className="mono">exit</span> 可退出。
        </span>
        <Btn size="sm" icon={<Icons.trash size={12} />} onClick={() => termRef.current?.clear()}>
          清屏
        </Btn>
      </div>
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 220, background: '#12141d', padding: '6px 4px 6px 8px', borderRadius: 8, margin: '0 14px 14px' }}
        onClick={() => termRef.current?.focus()}
      />
    </div>
  )
}
