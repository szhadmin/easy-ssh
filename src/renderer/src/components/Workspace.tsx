import React, { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types'
import { useStore, type WorkspaceTab } from '../store'
import { Btn, Empty, Icons, Spinner } from './ui'
import { OverviewPanel } from './OverviewPanel'
import { TerminalPanel } from './TerminalPanel'
import { FilesPanel } from './FilesPanel'
import { DockerPanel } from './DockerPanel'
import { AgentPanel } from './AgentPanel'
import { cls, formatBytes } from '../lib/utils'

const TABS: Array<{ key: WorkspaceTab; label: string; icon: React.ReactNode }> = [
  { key: 'overview', label: '概览', icon: <Icons.chart size={14} /> },
  { key: 'terminal', label: '终端', icon: <Icons.terminal size={14} /> },
  { key: 'files', label: '文件', icon: <Icons.folder size={14} /> },
  { key: 'docker', label: 'Docker', icon: <Icons.docker size={14} /> }
]

export function Workspace({
  profile,
  onEdit,
  onDeleted
}: {
  profile: ConnectionProfile
  onEdit: () => void
  onDeleted: () => void
}): React.ReactElement {
  const status = useStore((s) => s.statuses[profile.id] ?? 'disconnected')
  const error = useStore((s) => s.errors[profile.id])
  const info = useStore((s) => s.infos[profile.id])
  const docker = useStore((s) => s.docker[profile.id])
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const connect = useStore((s) => s.connect)
  const disconnect = useStore((s) => s.disconnect)
  const pollMetrics = useStore((s) => s.pollMetrics)
  const transfers = useStore((s) => s.transfers)
  const termCwd = useStore((s) => s.termCwd[profile.id])
  const filesPaneOpen = useStore((s) => s.filesPaneOpen)
  const splitRatio = useStore((s) => s.splitRatio)
  const setFilesPaneOpen = useStore((s) => s.setFilesPaneOpen)
  const setSplitRatio = useStore((s) => s.setSplitRatio)
  const [showTransfers, setShowTransfers] = useState(true)
  const [agentOpen, setAgentOpen] = useState(false)
  const prevStatus = useRef(status)
  const splitRef = useRef<HTMLDivElement>(null)

  /** 拖动中间的分隔条调整左右比例（双击恢复默认） */
  const startDrag = (e: React.MouseEvent): void => {
    const box = splitRef.current?.getBoundingClientRect()
    if (!box || box.width < 2) return
    e.preventDefault()
    const move = (ev: MouseEvent): void => {
      setSplitRatio(((ev.clientX - box.left) / box.width) * 100)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // 进入连接时若尚未连接则自动连接
  useEffect(() => {
    if (prevStatus.current === 'disconnected' && status === 'disconnected') {
      void connect(profile.id)
    }
    prevStatus.current = status
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  // 指标轮询
  useEffect(() => {
    if (status !== 'connected') return
    void pollMetrics(profile.id)
    const interval = tab === 'overview' ? 3000 : 8000
    const timer = window.setInterval(() => void pollMetrics(profile.id), interval)
    return () => window.clearInterval(timer)
  }, [status, tab, profile.id, pollMetrics])

  const connecting = status === 'connecting'

  return (
    <>
      <div className="topbar">
        <div
          className="conn-avatar"
          style={{ background: profile.color || '#6366f1', width: 28, height: 28, borderRadius: 8 }}
        >
          {profile.name.slice(0, 2)}
        </div>
        <div className="topbar-title">{profile.name}</div>

        <div className="chips">
          <span className="chip">
            {profile.username}@{profile.host}
            {profile.port !== 22 ? `:${profile.port}` : ''}
          </span>
          {info ? (
            <>
              <span className="chip">{info.os}</span>
              <span className="chip">
                {info.cpuCores} 核 · {formatBytes(info.memTotalKb * 1024, 0)} 内存
              </span>
              <span className="chip">内核 {info.kernel}</span>
              {info.dockerVersion ? (
                <span className="chip accent">Docker {info.dockerVersion}</span>
              ) : docker && !docker.available ? (
                <span className="chip">无 Docker</span>
              ) : null}
              {info.isRoot ? <span className="chip green">root</span> : <span className="chip amber">非 root</span>}
            </>
          ) : (
            <span className="chip">
              {connecting ? '正在建立连接…' : status === 'error' ? '连接失败' : '未连接'}
            </span>
          )}
        </div>

        <Btn size="sm" icon={<Icons.edit size={13} />} onClick={onEdit}>
          编辑
        </Btn>
        {status === 'connected' ? (
          <Btn size="sm" icon={<Icons.plugOff size={13} />} onClick={() => void disconnect(profile.id)}>
            断开
          </Btn>
        ) : (
          <Btn
            size="sm"
            variant="primary"
            icon={<Icons.plug size={13} />}
            loading={connecting}
            onClick={() => void connect(profile.id)}
          >
            连接
          </Btn>
        )}
        <Btn size="sm" variant="ghost" icon={<Icons.trash size={13} />} onClick={onDeleted} title="删除该连接" />
      </div>

      {status === 'connected' ? (
        <>
          <div className="tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={cls('tab', tab === t.key && 'active')}
                onClick={() => setTab(t.key)}
              >
                {t.icon}
                {t.label}
                {t.key === 'docker' && docker?.available ? <span className="tab-badge">●</span> : null}
              </button>
            ))}
          </div>

          {tab === 'overview' ? <OverviewPanel profile={profile} /> : null}
          {tab === 'terminal' ? (
            <div className="split" ref={splitRef}>
              <div
                className="split-pane"
                style={{ flex: filesPaneOpen || agentOpen ? `0 0 ${splitRatio}%` : '1 1 auto' }}
              >
                <TerminalPanel
                  profile={profile}
                  cwd={termCwd}
                  filesOpen={filesPaneOpen}
                  onToggleFiles={() => {
                    setAgentOpen(false)
                    setFilesPaneOpen(!filesPaneOpen)
                  }}
                  agentOpen={agentOpen}
                  onToggleAgent={() => {
                    setFilesPaneOpen(false)
                    setAgentOpen(!agentOpen)
                  }}
                />
              </div>

              {filesPaneOpen ? (
                <>
                  <div
                    className="split-handle"
                    onMouseDown={startDrag}
                    onDoubleClick={() => setSplitRatio(46)}
                    title="拖动调整宽度，双击恢复默认比例"
                  />
                  <div className="split-pane grow">
                    <FilesPanel profile={profile} compact syncPath={termCwd} />
                  </div>
                </>
              ) : null}

              {agentOpen ? (
                <>
                  <div className="split-handle" />
                  <div className="split-pane grow agent-sidepane">
                    <AgentPanel profile={profile} embedded />
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          {tab === 'files' ? <FilesPanel profile={profile} syncPath={termCwd} /> : null}
          {tab === 'docker' ? <DockerPanel profile={profile} /> : null}
        </>
      ) : connecting ? (
        <Empty
          icon={<Spinner />}
          title="正在连接…"
          desc={`正在与 ${profile.host}:${profile.port} 建立 SSH 会话，并探测系统信息与 Docker 环境。`}
        />
      ) : status === 'error' ? (
        <div className="panel">
          <div className="banner error">
            <Icons.warn size={16} />
            <div>
              <b>连接失败</b>
              <div style={{ marginTop: 4 }}>{error || '未知错误'}</div>
            </div>
          </div>
          <div className="row">
            <Btn variant="primary" icon={<Icons.refresh size={14} />} onClick={() => void connect(profile.id)}>
              重试连接
            </Btn>
            <Btn icon={<Icons.edit size={14} />} onClick={onEdit}>
              检查连接配置
            </Btn>
          </div>
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head">排查清单</div>
            <div className="section-body muted" style={{ lineHeight: 1.9, fontSize: 12.5 }}>
              1. 服务器是否可达：本机 <span className="mono">ping {profile.host}</span> 是否有回包； <br />
              2. 端口是否放行：云厂商安全组、系统防火墙需放行 {profile.port} 端口； <br />
              3. SSH 服务是否在跑：服务器上 <span className="mono">systemctl status sshd</span>； <br />
              4. 账号密码 / 私钥是否正确，服务器是否开了 <span className="mono">PasswordAuthentication</span>； <br />
              5. 若提示「握手失败」，确认该端口确实是 SSH 而非其它服务。
            </div>
          </div>
        </div>
      ) : (
        <Empty
          icon={<Icons.plugOff size={44} />}
          title="当前未连接"
          desc="点击右上角「连接」建立会话。"
          children={
            <Btn variant="primary" icon={<Icons.plug size={14} />} onClick={() => void connect(profile.id)}>
              立即连接
            </Btn>
          }
        />
      )}

      {transfers.length > 0 && showTransfers ? (
        <div className="transfers">
          <div className="row" style={{ marginBottom: 4 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>
              文件传输
            </span>
            <span style={{ flex: 1 }} />
            <Btn size="sm" variant="ghost" onClick={() => setShowTransfers(false)}>
              收起
            </Btn>
          </div>
          {transfers.map((t) => (
            <div key={t.id} className="transfer-row">
              <span style={{ width: 34, color: t.direction === 'upload' ? '#6366f1' : '#0891b2' }}>
                {t.direction === 'upload' ? '↑' : '↓'}
              </span>
              <span className="transfer-name" title={t.remotePath}>
                {t.name}
              </span>
              {t.error ? (
                <span style={{ color: '#e11d48' }}>失败：{t.error}</span>
              ) : t.done ? (
                <span style={{ color: '#15a34a' }}>完成</span>
              ) : (
                <>
                  <span className="progress">
                    <i
                      style={{
                        width: t.total > 0 ? `${Math.min(100, (t.transferred / t.total) * 100)}%` : '12%'
                      }}
                    />
                  </span>
                  <span className="muted mono" style={{ width: 130, textAlign: 'right' }}>
                    {formatBytes(t.transferred)} / {formatBytes(t.total)}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : transfers.length > 0 ? (
        <div className="transfers">
          <Btn size="sm" variant="ghost" onClick={() => setShowTransfers(true)}>
            展开文件传输（{transfers.length}）
          </Btn>
        </div>
      ) : null}
    </>
  )
}
