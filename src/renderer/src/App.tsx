import React, { useEffect, useMemo, useState } from 'react'
import type { ConnectionProfile } from '@shared/types'
import { useStore } from './store'
import { Btn, Confirm, Empty, Icons, Toasts } from './components/ui'
import { ConnectionDialog } from './components/ConnectionDialog'
import { Workspace } from './components/Workspace'
import { cls, shortName } from './lib/utils'

export default function App(): React.ReactElement {
  const init = useStore((s) => s.init)
  const ready = useStore((s) => s.ready)
  const profiles = useStore((s) => s.profiles)
  const statuses = useStore((s) => s.statuses)
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)

  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ConnectionProfile | null>(null)
  const [confirmDel, setConfirmDel] = useState<ConnectionProfile | null>(null)
  const removeProfile = useStore((s) => s.removeProfile)
  const refresh = useStore((s) => s.refreshProfiles)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    void init()
  }, [init])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = profiles.filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.username.toLowerCase().includes(q)
    )
    const map = new Map<string, ConnectionProfile[]>()
    for (const p of filtered) {
      const g = p.group || '默认分组'
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(p)
    }
    return [...map.entries()]
  }, [profiles, query])

  const openNew = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }

  const doImport = async (): Promise<void> => {
    try {
      const r = await window.api.connections.importFile()
      if (!r.ok) throw new Error(r.error)
      if (r.data && r.data.added > 0) {
        await refresh()
        toast('success', `已导入 ${r.data.added} 条连接`)
      } else {
        toast('info', '没有新增连接', '文件中的连接可能已存在')
      }
    } catch (e) {
      toast('error', '导入失败', (e as Error).message)
    }
  }

  const doExport = async (): Promise<void> => {
    try {
      const r = await window.api.connections.exportFile()
      if (!r.ok) throw new Error(r.error)
      if (r.data?.saved) toast('success', '已导出连接配置', r.data.path)
    } catch (e) {
      toast('error', '导出失败', (e as Error).message)
    }
  }

  const active = profiles.find((p) => p.id === activeId) ?? null

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand-mark">&gt;_</div>
          <div className="flex1" style={{ minWidth: 0 }}>
            <div className="brand-name">Easy SSH</div>
            <div className="brand-sub">SSH · SFTP · Docker 可视化管理</div>
          </div>
        </div>

        <div className="sidebar-search">
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 9, top: 8, color: '#a8b0c4' }}>
              <Icons.search size={14} />
            </span>
            <input
              className="input"
              style={{ paddingLeft: 29 }}
              placeholder="搜索名称 / IP / 用户名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="sidebar-body">
          {!ready ? (
            <div className="muted" style={{ padding: 14 }}>
              正在加载…
            </div>
          ) : profiles.length === 0 ? (
            <div className="muted" style={{ padding: '18px 12px', lineHeight: 1.8 }}>
              还没有连接。
              <br />
              点击下方「新建连接」开始，或者从 JSON 导入已有配置。
            </div>
          ) : (
            groups.map(([group, items]) => (
              <div key={group}>
                <div className="group-title">
                  {group} · {items.length}
                </div>
                {items.map((p) => {
                  const st = statuses[p.id] ?? 'disconnected'
                  return (
                    <div
                      key={p.id}
                      className={cls('conn-item', activeId === p.id && 'active')}
                      onClick={() => setActive(p.id)}
                      onDoubleClick={() => setActive(p.id)}
                      title={`${p.username}@${p.host}:${p.port}`}
                    >
                      <div className="conn-avatar" style={{ background: p.color || '#6366f1' }}>
                        {shortName(p.name)}
                        <span className={cls('conn-dot', st)} />
                      </div>
                      <div className="conn-meta">
                        <div className="conn-name">{p.name}</div>
                        <div className="conn-host">
                          {p.username}@{p.host}
                          {p.port !== 22 ? `:${p.port}` : ''}
                        </div>
                      </div>
                      <button
                        className="conn-more"
                        title="编辑连接"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditing(p)
                          setDialogOpen(true)
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="sidebar-foot">
          <Btn variant="primary" block icon={<Icons.plus size={14} />} onClick={openNew}>
            新建连接
          </Btn>
          <Btn icon={<Icons.upload size={14} />} onClick={doImport} title="从 JSON 导入连接" />
          <Btn icon={<Icons.download size={14} />} onClick={doExport} title="导出连接（不含密码）" />
        </div>
      </aside>

      <main className="main">
        {active ? (
          <Workspace
            key={active.id}
            profile={active}
            onEdit={() => {
              setEditing(active)
              setDialogOpen(true)
            }}
            onDeleted={() => setConfirmDel(active)}
          />
        ) : (
          <Welcome onNew={openNew} hasProfiles={profiles.length > 0} first={profiles[0]} onPick={setActive} />
        )}
      </main>

      {dialogOpen ? (
        <ConnectionDialog
          editing={editing}
          onClose={() => {
            setDialogOpen(false)
            setEditing(null)
          }}
        />
      ) : null}

      {confirmDel ? (
        <Confirm
          title="删除连接"
          danger
          confirmText="删除"
          message={
            <>
              确定删除连接 <b>{confirmDel.name}</b>（{confirmDel.username}@{confirmDel.host}）吗？
              <br />
              已保存的密码 / 私钥口令也会一并清除，此操作不可撤销。
            </>
          }
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => {
            void removeProfile(confirmDel.id)
            setConfirmDel(null)
          }}
        />
      ) : null}

      <Toasts />
    </div>
  )
}

function Welcome({
  onNew,
  hasProfiles,
  first,
  onPick
}: {
  onNew: () => void
  hasProfiles: boolean
  first?: ConnectionProfile
  onPick: (id: string) => void
}): React.ReactElement {
  return (
    <div className="empty">
      <div className="empty-inner">
        <div style={{ display: 'flex', justifyContent: 'center', color: '#c3c8da' }}>
          <Icons.server size={46} />
        </div>
        <h2>欢迎使用 Easy SSH</h2>
        <p>
          连接你的 Linux 服务器，用图形界面完成日常运维：看负载、传文件、改权限、开终端、管容器。
          <br />
          不需要记复杂的命令，也能把服务器管明白。
        </p>

        <div className="steps">
          <div className="step">
            <span className="step-no">1</span>
            <span className="step-text">
              <b>新建连接</b> —— 填 IP、用户名和密码（或私钥），点「测试连接」确认能通。
            </span>
          </div>
          <div className="step">
            <span className="step-no">2</span>
            <span className="step-text">
              <b>点击左侧连接</b> —— 自动登录，进入「概览」看 CPU / 内存 / 磁盘 / 网络实时曲线。
            </span>
          </div>
          <div className="step">
            <span className="step-no">3</span>
            <span className="step-text">
              <b>切换上方标签页</b> —— 终端（带命令提示）、文件（上传下载改权限）、Docker（容器一把梭）。
            </span>
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'center', marginTop: 20, gap: 10 }}>
          <Btn variant="primary" icon={<Icons.plus size={14} />} onClick={onNew}>
            新建连接
          </Btn>
          {hasProfiles && first ? (
            <Btn icon={<Icons.plug size={14} />} onClick={() => onPick(first.id)}>
              连接「{first.name}」
            </Btn>
          ) : null}
        </div>
      </div>
    </div>
  )
}
