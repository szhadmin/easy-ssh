import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { ConnectionProfile, CompSource } from '@shared/types'
import { useStore } from '../store'
import { Btn, Confirm, Icons, Modal } from './ui'
import { COMMAND_DICT, QUICK_COMMANDS, groupedDict, isDangerous } from '../lib/commands'
import {
  applyCompletion,
  planCompletion,
  type CompItem,
  type Plan,
  type RemoteItem
} from '../lib/complete'
import { createCwdScanner } from '../lib/osc'
import { cls } from '../lib/utils'

/** 面板默认只列这么多条，超过就让用户决定要不要看全部 */
const AC_COLLAPSE = 8

const THEME = {
  background: '#171a26',
  foreground: '#dfe4f2',
  cursor: '#8b5cf6',
  cursorAccent: '#171a26',
  selectionBackground: 'rgba(139,92,246,0.35)',
  black: '#22262f',
  red: '#f2607a',
  green: '#53d38a',
  yellow: '#e8c46a',
  blue: '#7aa2f7',
  magenta: '#c39bf7',
  cyan: '#5fd7d7',
  white: '#dfe4f2',
  brightBlack: '#6b7280',
  brightRed: '#ff8095',
  brightGreen: '#7ee2ab',
  brightYellow: '#f5d98b',
  brightBlue: '#9bb8ff',
  brightMagenta: '#dcb6ff',
  brightCyan: '#84e8e8',
  brightWhite: '#ffffff'
}

/** 这些 Pattern 命中时，回车前弹二次确认 */
const DANGER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(^|\s)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, label: '强制删除文件（rm -rf）' },
  { re: /(^|\s)rm\s+-[a-zA-Z]*f/, label: '强制删除文件（rm -f）' },
  { re: /(^|\s)mkfs(\.|\s|$)/, label: '格式化文件系统（mkfs）' },
  { re: /(^|\s)dd\s+.*of=\/dev\//, label: '向块设备写入数据（dd of=/dev/…）' },
  { re: /(^|\s)(shutdown|reboot|halt|poweroff)\b/, label: '关机 / 重启服务器' },
  { re: /(^|\s)(docker\s+system\s+prune|docker\s+volume\s+prune)/, label: '批量清理 Docker 资源' },
  { re: />\s*\/dev\/sd/, label: '重定向写入磁盘设备' },
  { re: /(^|\s)chmod\s+-R\s+777/, label: '递归放开全部权限（chmod -R 777）' },
  { re: /(^|\s)chown\s+-R\s+.*\s+\/\s*$/, label: '递归修改根目录归属' }
]

export function TerminalPanel({
  profile,
  cwd,
  filesOpen,
  onToggleFiles,
  agentOpen,
  onToggleAgent
}: {
  profile: ConnectionProfile
  /** 终端当前工作目录（由远端 shell 的 OSC 7 上报） */
  cwd?: string
  filesOpen?: boolean
  onToggleFiles?: () => void
  agentOpen?: boolean
  onToggleAgent?: () => void
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)

  const toast = useStore((s) => s.toast)
  const status = useStore((s) => s.statuses[profile.id] ?? 'disconnected')
  const remoteCommands = useStore((s) => s.remoteCommands[profile.id]) ?? []
  /** 每次（重）连成功 +1；变了就说明要重开 shell 通道 */
  const connEpoch = useStore((s) => s.connEpoch[profile.id] ?? 0)
  /** AI 助手送过来的待插入命令 */
  const termInject = useStore((s) => s.termInject)

  const [acOpen, setAcOpen] = useState(false)
  const [acIndex, setAcIndex] = useState(0)
  const [acPlan, setAcPlan] = useState<Plan | null>(null)
  const [acItems, setAcItems] = useState<CompItem[]>([])
  const [acLoading, setAcLoading] = useState(false)
  const [acExpanded, setAcExpanded] = useState(false)
  const [danger, setDanger] = useState<{ line: string; label: string } | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')

  const termId = useMemo(() => `${profile.id}`, [profile.id])
  const bufRef = useRef('')
  const acOpenRef = useRef(false)
  const acIndexRef = useRef(0)
  const acPlanRef = useRef<Plan | null>(null)
  const acItemsRef = useRef<CompItem[]>([])
  const acTotalRef = useRef(0)
  const acExpandedRef = useRef(false)
  const acToken = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  /** 远端 shell 通道是否已经开好（AI 插入命令要等它 ready） */
  const shellReadyRef = useRef(false)
  const applyInjectRef = useRef<((text: string, execute?: boolean) => void) | null>(null)
  const pendingInjectRef = useRef<{ text: string; execute?: boolean } | null>(null)

  const write = useCallback((data: string) => {
    void window.api.term.write(termId, data)
  }, [termId])

  useEffect(() => {
    acOpenRef.current = acOpen
  }, [acOpen])
  useEffect(() => {
    acIndexRef.current = acIndex
  }, [acIndex])
  useEffect(() => {
    acPlanRef.current = acPlan
  }, [acPlan])
  useEffect(() => {
    acItemsRef.current = acItems
    acTotalRef.current = acItems.length
  }, [acItems])
  useEffect(() => {
    acExpandedRef.current = acExpanded
  }, [acExpanded])

  /** 把当前输入行交给引擎，算出「现在该补什么」 */
  const openCompletion = useCallback((): void => {
    const st = useStore.getState()
    const plan = planCompletion({
      line: bufRef.current,
      remoteCommands: st.remoteCommands[profile.id] ?? [],
      cwd: st.termCwd[profile.id],
      home: st.infos[profile.id]?.home
    })
    const token = ++acToken.current
    setAcPlan(plan)
    setAcIndex(0)
    setAcExpanded(false)
    setAcOpen(true)

    if (!plan.need) {
      setAcItems(plan.items)
      setAcLoading(false)
      return
    }

    setAcItems(plan.items)
    setAcLoading(true)
    void window.api.complete
      .dynamic(profile.id, plan.need.kind as CompSource, plan.need.arg)
      .then((r) => {
        if (token !== acToken.current) return
        setAcLoading(false)
        if (!r.ok) return
        const raw: RemoteItem[] = r.data ?? []
        setAcItems(plan.build ? [...plan.items, ...plan.build(raw)] : plan.items)
      })
      .catch(() => {
        if (token === acToken.current) setAcLoading(false)
      })
  }, [profile.id])

  /* ------------------------------------------------- 初始化 xterm + 会话 */

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Terminal({
      theme: THEME,
      fontFamily: "'Cascadia Mono','JetBrains Mono',Consolas,'Courier New',monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      macOptionIsMeta: true
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, url) => void window.api.app.openExternal(url)))
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const doFit = (): void => {
      try {
        fit.fit()
      } catch {
        /* 容器还未布局完成 */
      }
    }
    doFit()
    setTimeout(doFit, 60)

    const ro = new ResizeObserver(() => {
      doFit()
      void window.api.term.resize(termId, term.cols, term.rows)
    })
    ro.observe(el)

    /**
     * Agent 命令与用户键盘共用同一个 PTY：execute=true 时只是在终端里补一个回车，
     * 远端回显、实时输出、Ctrl+C 都仍走既有 xterm 流，绝不走隐藏 ssh.exec 通道。
     */
    const applyInject = (text: string, execute = false): void => {
      if (acOpenRef.current) setAcOpen(false)
      write('\x15') // Ctrl+U：先清掉当前输入行
      write(text)
      bufRef.current = text
      if (execute) {
        write('\r')
        bufRef.current = ''
      }
      term.focus()
    }
    applyInjectRef.current = applyInject
    shellReadyRef.current = false
    pendingInjectRef.current = null

    // 打开远端 shell
    if (connEpoch > 0) {
      // 走到这里说明是「掉线后自动重连成功」触发的重建：旧的 shell 通道已经随连接没了
      term.write('\r\n\x1b[33m[Easy SSH] 连接已恢复，已为你重开一个 shell\x1b[0m\r\n')
    }
    void window.api.term
      .open({
        termId,
        profileId: profile.id,
        kind: 'host',
        cols: term.cols,
        rows: term.rows
      })
      .then(() => {
        shellReadyRef.current = true
        // 通道还没开好就收到插入请求时，先存着，这里补上
        const pending = pendingInjectRef.current
        if (pending) {
          pendingInjectRef.current = null
          applyInject(pending.text, pending.execute)
        }
      })

    const scanCwd = createCwdScanner()
    const offData = window.api.term.onData((p) => {
      if (p.termId !== termId) return
      // 先解析 shell 上报的目录（OSC 7 是不可见序列，xterm 会自行忽略）
      const cwdNow = scanCwd(p.data)
      if (cwdNow) useStore.getState().setTermCwd(profile.id, cwdNow)
      term.write(p.data)
    })
    const offExit = window.api.term.onExit((p) => {
      if (p.termId !== termId) return
      const why = p.reason ? p.reason : `会话结束（code=${p.code ?? '-'}）`
      term.write(`\r\n\x1b[33m[Easy SSH] ${why}\x1b[0m\r\n`)
    })

    term.onData((d) => {
      write(d)
      trackInput(d)
    })

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // 补全面板打开时，方向键 / Tab / Esc / Enter 交给面板
      if (acOpenRef.current) {
        const total = acTotalRef.current
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (total === 0) return false
          const cur = acIndexRef.current
          const next = e.key === 'ArrowDown' ? (cur + 1) % total : (cur - 1 + total) % total
          // 走到折叠窗口之外就自动把全部展开，省得用户先去找展开按钮
          if (next >= AC_COLLAPSE && !acExpandedRef.current) setAcExpanded(true)
          setAcIndex(next)
          return false
        }
        if (e.key === 'ArrowRight') {
          setAcExpanded(true)
          return false
        }
        if (e.key === 'ArrowLeft') {
          setAcExpanded(false)
          return false
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          acceptRef.current(acIndexRef.current)
          return false
        }
        if (e.key === 'Escape') {
          setAcOpen(false)
          return false
        }
      }

      // 任何位置按 Tab 都尝试补全：命令名 / 子命令 / 选项 / 路径 / 容器名…
      if (e.key === 'Tab') {
        e.preventDefault()
        openRef.current()
        return false
      }

      if (e.key === 'Enter') {
        const line = bufRef.current.trim()
        const hit = DANGER_PATTERNS.find((p) => p.re.test(line))
        if (line && hit) {
          e.preventDefault()
          setDanger({ line, label: hit.label })
          return false
        }
      }

      return true
    })

    term.onTitleChange(() => {
      /* 远端设置的标题，暂不使用 */
    })

    return () => {
      ro.disconnect()
      offData()
      offExit()
      shellReadyRef.current = false
      applyInjectRef.current = null
      pendingInjectRef.current = null
      void window.api.term.close(termId)
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, profile.id, connEpoch])

  /** AI 助手点了「插入终端」：等 shell 就绪后填进命令行 */
  useEffect(() => {
    if (!termInject || termInject.profileId !== profile.id) return
    if (!shellReadyRef.current || !applyInjectRef.current) {
      pendingInjectRef.current = { text: termInject.text, execute: termInject.execute }
      return
    }
    applyInjectRef.current(termInject.text, termInject.execute)
  }, [termInject, profile.id])

  /** 记录用户当前输入行（用于补全）。仅处理可打印字符与退格。 */
  const trackInput = (d: string): void => {
    let line = bufRef.current
    for (let i = 0; i < d.length; i++) {
      const c = d[i]
      if (c === '\r' || c === '\n') {
        line = ''
        continue
      }
      if (c === '\x7f' || c === '\b') {
        if (line.length) line = line.slice(0, -1)
        else line = ''
        continue
      }
      if (c === '\x03' || c === '\x15') {
        // Ctrl+C / Ctrl+U
        line = ''
        continue
      }
      if (c === '\x1b') {
        // 方向键 / 历史记录等序列：无法可靠推断，直接放弃这一行的补全
        line = ''
        i = d.length
        continue
      }
      if (c === '\t') continue
      if (c < ' ') continue
      line += c
    }
    if (line !== bufRef.current) {
      bufRef.current = line
      // 面板开着就按新内容重新算一遍（相当于边输边过滤），关着就什么都不做
      if (acOpenRef.current) void openRef.current()
      else setAcOpen(false)
    }
  }

  /** 接受补全项：只替换光标所在的这一个 token，前面的参数原样保留 */
  const accept = useCallback(
    (index: number): void => {
      const plan = acPlanRef.current
      const item = acItemsRef.current[index]
      setAcOpen(false)
      if (!plan || !item) return
      const next = applyCompletion(bufRef.current, plan, item.value)
      write('\x15') // Ctrl+U：清掉当前输入行
      write(next)
      bufRef.current = next
    },
    [write]
  )
  const acceptRef = useRef(accept)
  useEffect(() => {
    acceptRef.current = accept
  }, [accept])

  const openRef = useRef(openCompletion)
  useEffect(() => {
    openRef.current = openCompletion
  }, [openCompletion])

  /* ------------------------------------------------------------- 操作 */

  const insertCommand = (cmd: string): void => {
    setAcOpen(false)
    write('\x15')
    write(cmd)
    bufRef.current = cmd
    termRef.current?.focus()
  }

  const doClear = (): void => {
    setAcOpen(false)
    termRef.current?.clear()
    write('clear\r')
    bufRef.current = ''
  }

  const doCopy = async (): Promise<void> => {
    const sel = termRef.current?.getSelection()
    if (!sel) {
      toast('info', '没有选中内容', '用鼠标拖选终端里的文本后再复制')
      return
    }
    await navigator.clipboard.writeText(sel)
    toast('success', '已复制到剪贴板')
  }

  const doPaste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      write(text)
      toast('info', '已粘贴', '如内容有多行，远端 shell 会逐行执行，请留意')
    } catch {
      toast('warn', '粘贴失败', '系统剪贴板不可用，请用 Ctrl+V')
    }
  }

  const doFind = (): void => {
    setFindOpen(true)
  }

  const runFind = (forward: boolean): void => {
    if (!findText) return
    if (forward) searchRef.current?.findNext(findText)
    else searchRef.current?.findPrevious(findText)
  }

  const reconnect = (): void => {
    void window.api.term.close(termId)
    setTimeout(() => {
      const t = termRef.current
      if (!t) return
      t.reset()
      t.write('\x1b[36m[Easy SSH] 正在重新打开会话…\x1b[0m\r\n')
      void window.api.term.open({
        termId,
        profileId: profile.id,
        kind: 'host',
        cols: t.cols,
        rows: t.rows
      })
    }, 180)
  }

  /* ------------------------------------------------------------ 渲染 */

  const visible = acExpanded ? acItems : acItems.slice(0, AC_COLLAPSE)

  // 键盘上下选的时候把高亮项滚进可视区（展开全部后尤其需要）
  useEffect(() => {
    if (!acOpen) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${acIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [acIndex, acOpen, acItems, acExpanded])

  const quick = QUICK_COMMANDS.map(
    (c) =>
      COMMAND_DICT.find((d) => d.cmd === c) ?? {
        cmd: c,
        desc: '常用命令',
        group: '常用',
        danger: false
      }
  )

  return (
    <div className="panel flush">
      <div className="pathbar term-bar" style={{ background: '#1d2130', borderColor: '#262b3d' }}>
        <span style={{ color: '#8b93ab', fontSize: 11.5, fontFamily: 'var(--mono)' }}>
          {profile.username}@{profile.host} · bash
        </span>
        <span
          className={cls('term-cwd', !cwd && 'waiting')}
          title={cwd ? `终端当前目录：${cwd}` : '等待远端 shell 上报目录（在终端里回车后会刷新）'}
        >
          {cwd || '目录同步中…'}
        </span>
        <span style={{ flex: 1 }} />
        {status !== 'connected' ? (
          <span style={{ color: '#e8c46a', fontSize: 11.5 }}>连接已断开</span>
        ) : null}
        <Btn size="sm" icon={<Icons.refresh size={13} />} onClick={reconnect}>
          重开会话
        </Btn>
        <Btn size="sm" icon={<Icons.search size={13} />} onClick={doFind}>
          查找
        </Btn>
        <Btn size="sm" icon={<Icons.copy size={13} />} onClick={() => void doCopy()}>
          复制
        </Btn>
        <Btn size="sm" icon={<Icons.download size={13} />} onClick={() => void doPaste()}>
          粘贴
        </Btn>
        <Btn size="sm" icon={<Icons.trash size={13} />} onClick={doClear}>
          清屏
        </Btn>
        {onToggleAgent ? (
          <Btn
            size="sm"
            variant={agentOpen ? 'primary' : 'default'}
            icon={<Icons.robot size={13} />}
            onClick={onToggleAgent}
            title={agentOpen ? '收起右侧 AI 助手' : '在右侧打开 AI 助手；命令会通过当前终端执行'}
          >
            {agentOpen ? '收起 AI' : 'AI 助手'}
          </Btn>
        ) : null}
        {onToggleFiles ? (
          <Btn
            size="sm"
            variant={filesOpen ? 'primary' : 'default'}
            icon={<Icons.folder size={13} />}
            onClick={onToggleFiles}
            title={
              filesOpen
                ? '收起右侧文件面板'
                : '在右侧展开文件面板（会跟随终端当前目录自动刷新）'
            }
          >
            {filesOpen ? '收起文件' : '文件面板'}
          </Btn>
        ) : null}
        <Btn size="sm" variant="primary" icon={<Icons.chart size={13} />} onClick={() => setManualOpen(true)}>
          命令手册
        </Btn>
      </div>

      <div className="term-shell" ref={shellRef} style={{ position: 'relative' }}>
        <div className="term-host" ref={hostRef} onClick={() => termRef.current?.focus()} />

        {findOpen ? (
          <div
            style={{
              position: 'absolute',
              right: 14,
              top: 10,
              zIndex: 40,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              background: '#1d2130',
              border: '1px solid #333a52',
              borderRadius: 9,
              padding: '6px 8px'
            }}
          >
            <input
              className="input mono"
              style={{ width: 190, height: 26, background: '#262b3d', borderColor: '#3a4258', color: '#dfe4f2' }}
              placeholder="查找终端内容…"
              value={findText}
              autoFocus
              onChange={(e) => setFindText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runFind(!e.shiftKey)
                if (e.key === 'Escape') setFindOpen(false)
              }}
            />
            <Btn size="sm" onClick={() => runFind(false)}>
              上一个
            </Btn>
            <Btn size="sm" onClick={() => runFind(true)}>
              下一个
            </Btn>
            <Btn size="sm" variant="ghost" icon={<Icons.close size={12} />} onClick={() => setFindOpen(false)} />
          </div>
        ) : null}

        {acOpen && acPlan ? (
          <div
            className={cls('ac-popup', acExpanded && 'expanded')}
            style={{ left: 12, bottom: 52 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="ac-head">
              <span className="ac-title">{acPlan.title}</span>
              {acItems.length > 0 ? (
                <span className="ac-count">共 {acItems.length} 条</span>
              ) : null}
              {acLoading ? <span className="ac-loading">读取中…</span> : null}
            </div>
            {acPlan.note ? <div className="ac-note">{acPlan.note}</div> : null}

            <div className="ac-list" ref={listRef}>
              {visible.length === 0 ? (
                <div className="ac-empty">
                  {acLoading ? '正在从服务器读取…' : acPlan.emptyHint}
                </div>
              ) : (
                visible.map((s, i) => (
                  <div
                    key={`${s.kind}:${s.value}`}
                    data-idx={i}
                    className={cls('ac-item', i === acIndex && 'active')}
                    onMouseEnter={() => setAcIndex(i)}
                    onClick={() => accept(i)}
                  >
                    <span className="ac-cmd">{s.label ?? s.value}</span>
                    <span className="ac-desc">{s.desc}</span>
                    {s.kind === 'sub' || s.kind === 'opt' ? (
                      <span className="ac-kind">{s.kind === 'sub' ? '子命令' : '选项'}</span>
                    ) : null}
                    {s.danger ? <span className="ac-badge">危险</span> : null}
                  </div>
                ))
              )}
            </div>

            {acItems.length > AC_COLLAPSE ? (
              <button
                className="ac-more"
                onClick={(e) => {
                  e.stopPropagation()
                  setAcExpanded((v) => !v)
                }}
              >
                {acExpanded
                  ? `▲ 收起，只显示前 ${AC_COLLAPSE} 条`
                  : `▼ 还有 ${acItems.length - visible.length} 条没显示 —— 点这里或按 → 展开全部`}
              </button>
            ) : null}

            <div className="ac-foot">
              <span>
                <b>↑↓</b> 选择
              </span>
              <span>
                <b>Tab</b>/<b>Enter</b> 补全
              </span>
              {acItems.length > AC_COLLAPSE ? (
                <span>
                  <b>→</b> 展开 · <b>←</b> 收起
                </span>
              ) : null}
              <span>
                <b>Esc</b> 关闭
              </span>
            </div>
          </div>
        ) : null}

        <div className="term-hintbar">
          <span className="term-hint-label">常用：</span>
          {quick.map((q) => (
            <button
              key={q.cmd}
              className="btn sm"
              title={q.desc}
              onClick={() => {
                if (isDangerous(q.cmd)) {
                  setDanger({ line: q.cmd, label: '该命令可能造成不可逆影响' })
                  return
                }
                insertCommand(q.cmd)
              }}
            >
              {q.cmd}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <span className="term-hint-label">
            提示：任意位置按 <b>Tab</b> 都会补全 —— 命令名 / 子命令 / 选项 / 路径 / 容器名，
            共 {remoteCommands.length} 个可用命令
          </span>
        </div>
      </div>

      {danger ? (
        <Confirm
          title="⚠️ 危险命令二次确认"
          danger
          confirmText="确认执行"
          message={
            <>
              检测到高风险操作：<b>{danger.label}</b>
              <div
                style={{
                  margin: '10px 0',
                  padding: '9px 11px',
                  background: '#fdeaf0',
                  borderRadius: 8,
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  color: '#9f1239',
                  wordBreak: 'break-all'
                }}
              >
                {danger.line}
              </div>
              <span className="muted">
                该操作在服务器上通常不可撤销。请再次确认目标路径 / 服务无误，并且你已做好备份。
              </span>
            </>
          }
          onCancel={() => setDanger(null)}
          onConfirm={() => {
            setDanger(null)
            write('\r')
            bufRef.current = ''
            termRef.current?.focus()
          }}
        />
      ) : null}

      {manualOpen ? (
        <CommandManual
          onClose={() => setManualOpen(false)}
          onInsert={(cmd) => {
            setManualOpen(false)
            insertCommand(cmd)
          }}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- 命令手册 */

function CommandManual({
  onClose,
  onInsert
}: {
  onClose: () => void
  onInsert: (cmd: string) => void
}): React.ReactElement {
  const [q, setQ] = useState('')
  const groups = groupedDict()
  const kw = q.trim().toLowerCase()
  const filtered = groups
    .map((g) => ({
      group: g.group,
      items: g.items.filter(
        (i) => !kw || i.cmd.toLowerCase().includes(kw) || i.desc.toLowerCase().includes(kw)
      )
    }))
    .filter((g) => g.items.length > 0)

  return (
    <Modal title="命令手册（点击即可插入到终端）" onClose={onClose} wide>
      <input
        className="input mb14"
        placeholder="搜索命令或中文说明，例如「磁盘」「日志」「docker」"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
        {filtered.map((g) => (
          <div key={g.group} className="mb14">
            <div className="group-title" style={{ padding: '4px 0 6px' }}>
              {g.group}
            </div>
            <table className="table">
              <tbody>
                {g.items.map((i) => (
                  <tr
                    key={i.cmd}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onInsert(i.example ? `${i.cmd} ` : i.cmd)}
                  >
                    <td className="mono" style={{ width: 250, color: 'var(--accent)', fontWeight: 500 }}>
                      {i.cmd}
                      {i.example ? <span className="muted"> {i.example}</span> : null}
                    </td>
                    <td>{i.desc}</td>
                    <td style={{ width: 60, textAlign: 'right' }}>
                      {i.danger ? <span className="ac-badge">危险</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {filtered.length === 0 ? <div className="muted">没有匹配的命令</div> : null}
      </div>
    </Modal>
  )
}
