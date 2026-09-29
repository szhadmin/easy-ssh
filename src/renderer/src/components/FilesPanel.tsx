import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import type { ConnectionProfile, RemoteEntry } from '@shared/types'
import { useStore } from '../store'
import { Btn, Empty, Icons, InlineInput, Modal } from './ui'
import {
  cls,
  formatBytes,
  formatTime,
  isProbablyText,
  modeString,
  parentPath
} from '../lib/utils'

export function FilesPanel({
  profile,
  compact,
  syncPath
}: {
  profile: ConnectionProfile
  /** 紧凑模式：放在终端右侧的分栏里，工具栏收成图标、表格少两列 */
  compact?: boolean
  /** 终端上报的当前目录；开启跟随时会自动切过去 */
  syncPath?: string
}): React.ReactElement {
  const toast = useStore((s) => s.toast)
  const following = useStore((s) => s.followCwd)
  const setFollowCwd = useStore((s) => s.setFollowCwd)
  const connected = useStore((s) => s.statuses[profile.id] === 'connected')

  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  const [renaming, setRenaming] = useState<RemoteEntry | null>(null)
  const [newFolder, setNewFolder] = useState(false)
  const [permTarget, setPermTarget] = useState<RemoteEntry | null>(null)
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null)
  const [goPath, setGoPath] = useState('')

  /** 已经跟随过的终端目录，用来区分「目录真的变了」和「只是重新渲染」 */
  const lastSyncRef = useRef('')

  const load = useCallback(
    async (path: string): Promise<boolean> => {
      setLoading(true)
      setError('')
      try {
        const r = await window.api.files.list(profile.id, path)
        if (!r.ok) throw new Error(r.error)
        setEntries(r.data ?? [])
        setCwd(path)
        setSelected(new Set())
        return true
      } catch (e) {
        setError((e as Error).message)
        setEntries([])
        return false
      } finally {
        setLoading(false)
      }
    },
    [profile.id]
  )

  /** 跟随到某个目录；目录被删 / 无权限时退到它的上级，避免停在空白页 */
  const followTo = useCallback(
    async (path: string): Promise<void> => {
      const ok = await load(path)
      if (ok) return
      const parent = parentPath(path)
      if (parent !== path) await load(parent)
    },
    [load]
  )

  // 进入面板：跟随模式直接落在终端目录，否则回用户主目录
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    void (async () => {
      if (following && syncPath) {
        lastSyncRef.current = syncPath
        if (!cancelled) await followTo(syncPath)
        return
      }
      try {
        const r = await window.api.files.home(profile.id)
        if (!cancelled) await load(r.ok && r.data ? r.data : '/')
      } catch {
        if (!cancelled) await load('/')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, connected])

  // 终端 cd 到新目录 -> 文件列表同步刷新（只在目录真的变化时触发）
  useEffect(() => {
    if (!connected || !following || !syncPath) return
    if (lastSyncRef.current === syncPath) return
    lastSyncRef.current = syncPath
    void followTo(syncPath)
  }, [syncPath, following, connected, followTo])


  const shown = useMemo(() => {
    const kw = filter.trim().toLowerCase()
    if (!kw) return entries
    return entries.filter((e) => e.name.toLowerCase().includes(kw))
  }, [entries, filter])

  const crumbs = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean)
    const out: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    let acc = ''
    for (const p of parts) {
      acc += '/' + p
      out.push({ label: p, path: acc })
    }
    return out
  }, [cwd])

  const toggle = (path: string): void => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })
  }

  const selectedEntries = entries.filter((e) => selected.has(e.path))

  /* --------------------------------------------------------- 操作封装 */

  const enter = (e: RemoteEntry): void => {
    // 符号链接可能指向目录，一并尝试进入
    if (e.isDir || e.isSymlink) void load(e.path)
  }

  const doUpload = async (): Promise<void> => {
    try {
      const r = await window.api.files.upload(profile.id, cwd)
      if (!r.ok) throw new Error(r.error)
      if (r.data && r.data.uploaded > 0) {
        toast('success', `已上传 ${r.data.uploaded} 个文件`)
        await load(cwd)
      }
    } catch (e) {
      toast('error', '上传失败', (e as Error).message)
    }
  }

  const doUploadDir = async (): Promise<void> => {
    try {
      const r = await window.api.files.uploadDir(profile.id, cwd)
      if (!r.ok) throw new Error(r.error)
      if (r.data?.uploaded) {
        toast('success', '文件夹上传完成', r.data.target)
        await load(cwd)
      }
    } catch (e) {
      toast('error', '上传文件夹失败', (e as Error).message)
    }
  }

  const doDownload = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    try {
      const r = await window.api.files.download(profile.id, paths)
      if (!r.ok) throw new Error(r.error)
      if (r.data && r.data.downloaded > 0) toast('success', `已下载 ${r.data.downloaded} 项`, r.data.dir)
    } catch (e) {
      toast('error', '下载失败', (e as Error).message)
    }
  }

  const doDelete = async (e: RemoteEntry): Promise<void> => {
    const isDirNonEmpty = e.isDir
    const tip = isDirNonEmpty
      ? `目录「${e.name}」及其内部所有内容将被递归删除，且不可恢复。`
      : `文件「${e.name}」将被永久删除，且不可恢复。`
    if (!window.confirm(`确定删除吗？\n\n${tip}`)) return
    try {
      const r = await window.api.files.remove(profile.id, e.path, e.isDir, true)
      if (!r.ok) throw new Error(r.error)
      toast('success', `已删除 ${e.name}`)
      await load(cwd)
    } catch (err) {
      toast('error', '删除失败', (err as Error).message)
    }
  }

  const doRename = async (from: RemoteEntry, newName: string): Promise<void> => {
    setRenaming(null)
    if (!newName || newName === from.name) return
    const to = from.path.replace(/[^/]+$/, newName)
    if (!/^[^/\0]+$/.test(newName)) {
      toast('warn', '名称不合法', '文件名不能包含 / 字符')
      return
    }
    try {
      const r = await window.api.files.rename(profile.id, from.path, to)
      if (!r.ok) throw new Error(r.error)
      toast('success', '重命名成功', `${from.name} → ${newName}`)
      await load(cwd)
    } catch (e) {
      toast('error', '重命名失败', (e as Error).message)
    }
  }

  const doMkdir = async (name: string): Promise<void> => {
    setNewFolder(false)
    if (!name) return
    try {
      const r = await window.api.files.mkdir(profile.id, `${cwd.replace(/\/$/, '')}/${name}`)
      if (!r.ok) throw new Error(r.error)
      toast('success', `已创建目录 ${name}`)
      await load(cwd)
    } catch (e) {
      toast('error', '创建目录失败', (e as Error).message)
    }
  }

  const doOpenEditor = async (e: RemoteEntry): Promise<void> => {
    try {
      const r = await window.api.files.readText(profile.id, e.path)
      if (!r.ok) throw new Error(r.error)
      setEditing({ path: e.path, content: r.data ?? '' })
    } catch (err) {
      toast('error', '打开文件失败', (err as Error).message)
    }
  }

  const doSaveEditor = async (path: string, content: string): Promise<boolean> => {
    try {
      const r = await window.api.files.writeText(profile.id, path, content)
      if (!r.ok) throw new Error(r.error)
      toast('success', '已保存到服务器', path)
      setEditing(null)
      await load(cwd)
      return true
    } catch (e) {
      toast('error', '保存失败', (e as Error).message)
      return false
    }
  }

  /* ------------------------------------------------- 与终端联动的两个动作 */

  /** 开关「跟随终端目录」；重新打开时立刻同步一次 */
  const toggleFollow = (): void => {
    const next = !following
    setFollowCwd(next)
    if (next && syncPath) {
      lastSyncRef.current = syncPath
      void followTo(syncPath)
    }
  }

  /** 手动跳到终端当前目录（锁定状态下用） */
  const jumpToTerminalDir = (): void => {
    if (!syncPath) return
    lastSyncRef.current = syncPath
    void followTo(syncPath)
  }

  /** 反向操作：让终端 cd 到文件面板当前目录 */
  const cdInTerminal = (): void => {
    // 单引号包裹，内部单引号按 shell 规则转义成 '\''
    const quoted = `'${cwd.replace(/'/g, `'\\''`)}'`
    void window.api.term.write(profile.id, ` cd ${quoted}\r`, true)
    toast('info', '已在终端执行 cd', cwd)
  }

  /* -------------------------------------------------------------- 渲染 */

  if (!connected) {
    return (
      <div
        className="panel"
        style={{ display: 'grid', placeItems: 'center', textAlign: 'center', color: 'var(--text-3)' }}
      >
        <div>
          <Icons.plugOff size={34} />
          <div style={{ marginTop: 10 }}>连接服务器后才能浏览远端文件</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel flush">
      <div className={cls('pathbar', compact && 'compact')}>
        <Btn
          size="sm"
          icon={<Icons.chevronRight size={14} className="rot180" />}
          onClick={() => void load(parentPath(cwd))}
          title="上级目录"
        >
          {compact ? null : '上级'}
        </Btn>
        <Btn
          size="sm"
          icon={<Icons.refresh size={14} />}
          loading={loading}
          onClick={() => void load(cwd)}
          title="刷新当前目录"
        >
          {compact ? null : '刷新'}
        </Btn>

        <div className="breadcrumb">
          {crumbs.map((c, i) => (
            <React.Fragment key={c.path}>
              {i > 0 ? <span className="crumb-sep">/</span> : null}
              <button className="crumb" onClick={() => void load(c.path)} title={c.path}>
                {c.label === '/' ? '根目录' : c.label}
              </button>
            </React.Fragment>
          ))}
        </div>

        {!compact ? (
          <input
            className="input mono"
            style={{ width: 190 }}
            placeholder="输入路径后回车跳转"
            value={goPath}
            onChange={(e) => setGoPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && goPath.trim()) {
                void load(goPath.trim())
                setGoPath('')
              }
            }}
          />
        ) : null}

        <button
          className={cls('follow-pill', following && 'on')}
          onClick={toggleFollow}
          title={
            following
              ? '文件列表正跟随终端目录，点一下锁定在当前目录'
              : '当前已锁定，点一下重新跟随终端目录'
          }
        >
          <Icons.terminal size={12} />
          {following ? '跟随终端' : '已锁定'}
        </button>

        {!following && syncPath && syncPath !== cwd ? (
          <Btn
            size="sm"
            icon={<Icons.chevronRight size={13} />}
            onClick={jumpToTerminalDir}
            title={`跳到终端目录 ${syncPath}`}
          >
            {compact ? null : '跳到终端目录'}
          </Btn>
        ) : null}

        <input
          className="input"
          style={{ width: compact ? 110 : 150 }}
          placeholder="筛选"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <Btn
          size="sm"
          variant="primary"
          icon={<Icons.upload size={13} />}
          onClick={doUpload}
          title="上传文件（可多选）"
        >
          {compact ? null : '上传文件'}
        </Btn>
        <Btn
          size="sm"
          icon={<Icons.upload size={13} />}
          onClick={doUploadDir}
          title="上传整个文件夹（含子目录）"
        >
          {compact ? null : '上传文件夹'}
        </Btn>
        <Btn
          size="sm"
          icon={<Icons.plus size={13} />}
          onClick={() => setNewFolder(true)}
          title="在当前目录新建文件夹"
        >
          {compact ? null : '新建目录'}
        </Btn>
        <Btn
          size="sm"
          icon={<Icons.terminal size={13} />}
          onClick={cdInTerminal}
          title={`让终端 cd 到 ${cwd}`}
        />

        {selected.size > 0 ? (
          <>
            <span className="muted">已选 {selected.size} 项</span>
            <Btn size="sm" icon={<Icons.download size={13} />} onClick={() => void doDownload([...selected])}>
              批量下载
            </Btn>
            <Btn
              size="sm"
              variant="danger"
              icon={<Icons.trash size={13} />}
              onClick={async () => {
                if (!window.confirm(`确定删除选中的 ${selected.size} 项？此操作不可恢复。`)) return
                for (const e of selectedEntries) {
                  const r = await window.api.files.remove(profile.id, e.path, e.isDir, true)
                  if (!r.ok) {
                    toast('error', `删除失败：${e.name}`, r.error)
                    break
                  }
                }
                toast('success', '批量删除完成')
                await load(cwd)
              }}
            >
              批量删除
            </Btn>
          </>
        ) : null}
      </div>

      {error ? (
        <div style={{ padding: '10px 14px' }}>
          <div className="banner error" style={{ marginBottom: 0 }}>
            <Icons.warn size={15} />
            <div>{error}</div>
          </div>
        </div>
      ) : null}

      <div className="file-list">
        <div className={cls('file-row head', compact && 'compact')}>
          <div>名称</div>
          <div style={{ textAlign: 'right' }}>大小</div>
          <div>权限</div>
          {!compact ? <div>修改时间</div> : null}
        </div>

        {newFolder ? (
          <div className={cls('file-row', compact && 'compact')} style={{ background: '#fafbff' }}>
            <div className="file-name">
              <Icons.folder size={15} />
              <InlineInput
                initial="新建文件夹"
                selectBasename
                onSubmit={(v) => void doMkdir(v)}
                onCancel={() => setNewFolder(false)}
              />
            </div>
            <div />
            <div />
            {!compact ? <div /> : null}
          </div>
        ) : null}

        {shown.map((e) => (
          <div
            key={e.path}
            className={cls('file-row', compact && 'compact', selected.has(e.path) && 'selected')}
          >
            <div className={cls('file-name', e.isDir && 'dir')}>
              <input
                type="checkbox"
                checked={selected.has(e.path)}
                onChange={() => toggle(e.path)}
                onClick={(ev) => ev.stopPropagation()}
              />
              <span
                onClick={() => enter(e)}
                title={e.isSymlink ? `${e.name}（符号链接）` : e.name}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <span style={{ color: e.isDir ? '#6366f1' : '#98a1b8' }}>
                  {e.isDir ? <Icons.folder size={15} /> : <Icons.file size={15} />}
                </span>
                {renaming && renaming.path === e.path ? (
                  <InlineInput
                    initial={e.name}
                    selectBasename={!e.isDir}
                    onSubmit={(v) => void doRename(e, v)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span>
                    {e.name}
                    {e.isSymlink ? <span className="muted"> →</span> : null}
                  </span>
                )}
              </span>
            </div>
            <div className="dim" style={{ textAlign: 'right' }}>
              {e.isDir ? '—' : formatBytes(e.size)}
            </div>
            <div className="dim">{e.modeText}</div>
            {!compact ? <div className="dim">{formatTime(e.mtime)}</div> : null}
            <span className="file-actions">
              {!e.isDir && isProbablyText(e.name) ? (
                <Btn size="sm" variant="ghost" onClick={() => void doOpenEditor(e)} title="在线编辑">
                  <Icons.edit size={13} />
                </Btn>
              ) : null}
              <Btn size="sm" variant="ghost" onClick={() => void doDownload([e.path])} title="下载到本地">
                <Icons.download size={13} />
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => setPermTarget(e)} title="修改权限">
                <Icons.lock size={13} />
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => setRenaming(e)} title="重命名">
                <Icons.edit size={13} />
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => void doDelete(e)} title="删除">
                <Icons.trash size={13} />
              </Btn>
            </span>
          </div>
        ))}

        {!loading && !error && shown.length === 0 ? (
          <div className="muted" style={{ padding: 22, textAlign: 'center' }}>
            这个目录是空的{filter ? '（或没有匹配项）' : ''}
          </div>
        ) : null}
        {loading ? (
          <div className="muted center" style={{ padding: 20 }}>
            <span className="spinner" /> 正在读取远端目录…
          </div>
        ) : null}
      </div>

      {permTarget ? (
        <PermDialog
          entry={permTarget}
          onClose={() => setPermTarget(null)}
          onApply={async (mode) => {
            try {
              const r = await window.api.files.chmod(profile.id, permTarget.path, mode)
              if (!r.ok) throw new Error(r.error)
              toast('success', '权限已修改', `${permTarget.name} → ${modeString(mode)} (0${mode.toString(8)})`)
              setPermTarget(null)
              await load(cwd)
            } catch (e) {
              toast('error', '修改权限失败', (e as Error).message)
            }
          }}
        />
      ) : null}

      {editing ? (
        <EditorModal
          path={editing.path}
          initial={editing.content}
          onClose={() => setEditing(null)}
          onSave={doSaveEditor}
        />
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- 权限弹窗 */

function PermDialog({
  entry,
  onClose,
  onApply
}: {
  entry: RemoteEntry
  onClose: () => void
  onApply: (mode: number) => void
}): React.ReactElement {
  const BIT_VALUES = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  const start = entry.mode & 0o777
  const [bits, setBits] = useState(BIT_VALUES.map((b) => !!(start & b)))
  const [octal, setOctal] = useState(start.toString(8).padStart(3, '0'))

  const mode = bits.reduce((acc, on, i) => acc + (on ? BIT_VALUES[i] : 0), 0)

  /** 勾选框变化时同步八进制显示 */
  const setBitAt = (i: number, value: boolean): void => {
    const next = bits.map((v, j) => (j === i ? value : v))
    setBits(next)
    setOctal(next.reduce((acc, on, k) => acc + (on ? BIT_VALUES[k] : 0), 0).toString(8).padStart(3, '0'))
  }

  const applyValue = (v: number): void => {
    setBits(BIT_VALUES.map((b) => !!(v & b)))
    setOctal(v.toString(8).padStart(3, '0'))
  }

  const presets: Array<{ label: string; v: number; desc: string }> = [
    { label: '644', v: 0o644, desc: '普通文件（属主可写，其他只读）' },
    { label: '755', v: 0o755, desc: '可执行文件 / 目录（属主可写，所有人可读可执行）' },
    { label: '600', v: 0o600, desc: '私密文件（仅属主可读写，如私钥）' },
    { label: '700', v: 0o700, desc: '私密目录（仅属主可访问）' },
    { label: '777', v: 0o777, desc: '所有人可读写执行（不推荐）' }
  ]

  return (
    <Modal
      title={`修改权限 · ${entry.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted mono" style={{ flex: 1 }}>
            当前：{entry.modeText} ({start.toString(8).padStart(3, '0')}) → 新：{modeString(mode)} ({octal})
          </span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" onClick={() => onApply(mode)}>
            应用
          </Btn>
        </>
      }
    >
      <div className="mb14">
        <div className="label">快捷设置</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {presets.map((p) => (
            <Btn
              key={p.label}
              size="sm"
              variant={mode === p.v ? 'primary' : 'default'}
              title={p.desc}
              onClick={() => applyValue(p.v)}
            >
              {p.label}
            </Btn>
          ))}
        </div>
        <div className="hint">
          644 = 普通文件；755 = 可执行文件或目录；600 = 私钥等敏感文件；777 = 放开全部权限，仅临时排障使用。
        </div>
      </div>

      <div className="perm-grid mb14">
        <div />
        <div className="head">读取 r</div>
        <div className="head">写入 w</div>
        <div className="head">执行 x</div>

        <div className="who">属主 owner</div>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <input type="checkbox" checked={bits[i]} onChange={() => setBitAt(i, !bits[i])} />
          </div>
        ))}

        <div className="who">同组 group</div>
        {[3, 4, 5].map((i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <input type="checkbox" checked={bits[i]} onChange={() => setBitAt(i, !bits[i])} />
          </div>
        ))}

        <div className="who">其他人 other</div>
        {[6, 7, 8].map((i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <input type="checkbox" checked={bits[i]} onChange={() => setBitAt(i, !bits[i])} />
          </div>
        ))}
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label className="label">八进制数值</label>
        <input
          className="input mono"
          value={octal}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-7]/g, '').slice(0, 3)
            setOctal(v)
            const n = parseInt(v || '0', 8)
            setBits(BIT_VALUES.map((b) => !!(n & b)))
          }}
        />
        <div className="hint">
          支持直接输入八进制，例如 640、750。常见组合：
          <span className="mono"> rwxr-xr-x = 755</span>，
          <span className="mono"> rw-r--r-- = 644</span>。
        </div>
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------------- 编辑器 */

function langFor(name: string): Extension | null {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower
  if (lower === 'dockerfile' || ext === 'dockerfile') return StreamLanguage.define(dockerFile)
  switch (ext) {
    case 'json':
      return json()
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext.endsWith('x') })
    case 'py':
      return python()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'env':
    case 'conf':
      return StreamLanguage.define(shell)
    default:
      if (/\.(service|ini|cfg|properties|toml)$/.test(lower)) return StreamLanguage.define(shell)
      return null
  }
}

function EditorModal({
  path,
  initial,
  onClose,
  onSave
}: {
  path: string
  initial: string
  onClose: () => void
  onSave: (path: string, content: string) => Promise<boolean>
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const lang = langFor(path)
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          oneDark,
          ...(lang ? [lang] : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(true)
          })
        ]
      })
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [path, initial])

  const save = async (): Promise<void> => {
    const content = viewRef.current?.state.doc.toString() ?? ''
    setSaving(true)
    const done = await onSave(path, content)
    setSaving(false)
    if (done) setDirty(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <Modal
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          在线编辑
          <span className="mono muted" style={{ fontWeight: 400, fontSize: 12 }}>
            {path}
          </span>
          {dirty ? <span className="tag" style={{ background: '#fef4e6', color: '#d97706' }}>未保存</span> : null}
        </span>
      }
      onClose={onClose}
      wide
      xtall
      footer={
        <>
          <span className="muted" style={{ flex: 1, fontSize: 11.5 }}>
            保存会直接覆盖服务器上的原文件；建议先下载一份备份。Ctrl+S 快速保存。
          </span>
          <Btn onClick={onClose}>关闭</Btn>
          <Btn variant="primary" loading={saving} icon={<Icons.check size={14} />} onClick={() => void save()}>
            保存到服务器
          </Btn>
        </>
      }
    >
      <div className="editor-wrap" ref={hostRef} style={{ height: 'calc(100% - 4px)' }} />
    </Modal>
  )
}
