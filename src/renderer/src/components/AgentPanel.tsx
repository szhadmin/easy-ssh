import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types'
import { AGENT_ROLES, findRole } from '@shared/agent-roles'
import { useStore, type AgentMsg } from '../store'
import { Btn, Confirm, Icons, Spinner } from './ui'
import { AgentSettings, isLocalEndpoint } from './AgentSettings'
import { isDangerous } from '../lib/commands'
import { cls } from '../lib/utils'

export function AgentPanel({ profile, embedded = false }: { profile: ConnectionProfile; embedded?: boolean }): React.ReactElement {
  const conv = useStore((s) => s.agentConvos[profile.id])
  const config = useStore((s) => s.agentConfig)
  const configLoaded = useStore((s) => s.agentConfigLoaded)
  const agentContext = useStore((s) => s.agentContext)
  const setAgentContext = useStore((s) => s.setAgentContext)
  const agentExecutionMode = useStore((s) => s.agentExecutionMode)
  const setAgentExecutionMode = useStore((s) => s.setAgentExecutionMode)
  const dispatchAgentRun = useStore((s) => s.agentRun)
  const agentRuns = useStore((s) => s.agentRuns)
  const agentConfirmStep = useStore((s) => s.agentConfirmStep)
  const agentSend = useStore((s) => s.agentSend)
  const agentStop = useStore((s) => s.agentStop)
  const agentClear = useStore((s) => s.agentClear)
  const saveAgentConfig = useStore((s) => s.saveAgentConfig)
  const injectTerm = useStore((s) => s.injectTerm)
  const setTab = useStore((s) => s.setTab)
  const toast = useStore((s) => s.toast)

  const [input, setInput] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingExec, setPendingExec] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const roleId = config?.roleId ?? AGENT_ROLES[0].id
  const role = findRole(roleId)
  const messages = conv?.messages ?? []
  const streaming = !!conv?.streaming
  const needsKey = configLoaded && !!config && !config.hasKey && !isLocalEndpoint(config.baseURL)
  const noConfig = configLoaded && !config
  const agentRun = agentRuns[profile.id]
  const agentBusy = !!agentRun && ['thinking', 'executing', 'confirming'].includes(agentRun.state)
  const canRestart = !!agentRun && !agentBusy && agentRun.goal.trim().length > 0

  // 新内容进来时贴着底部滚（用户自己往上翻就不打扰他）
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const onScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = (text?: string): void => {
    const t = (text ?? input).trim()
    if (!t || streaming || agentBusy) return
    // 三种权限都走同一条“观察 → 单步执行 → 回传结果 → 再决策”循环；差别仅在每步是否需要确认。
    void dispatchAgentRun(profile.id, t)
    setInput('')
    stickToBottom.current = true
  }

  const insertToTerminal = (cmd: string): void => {
    injectTerm(profile.id, cmd)
    setTab('terminal')
    toast('info', '已插入终端', '确认无误后按回车执行；多行命令已用 && 连接成一个整体')
  }

  /** 执行仍复用当前 xterm 关联的 PTY，命令回显和输出与手工执行完全一致。 */
  const executeInTerminal = (cmd: string): void => {
    if (isDangerous(cmd)) {
      setPendingExec(cmd)
      return
    }
    injectTerm(profile.id, cmd, true)
    setTab('terminal')
    toast('info', 'AI 命令已在终端执行', '输出会实时显示在终端；可用 Ctrl+C 中止')
  }

  const confirmExecute = (): void => {
    if (!pendingExec) return
    injectTerm(profile.id, pendingExec, true)
    setTab('terminal')
    toast('warn', '危险命令已确认执行', '命令与输出均在终端可见；需要时按 Ctrl+C 中止')
    setPendingExec(null)
  }

  const doSwitchRole = (id: string): void => {
    void saveAgentConfig({ roleId: id })
  }

  return (
    <div className="panel flush agent-panel">
      <div className="pathbar agent-bar">
        <span className="agent-bar-role">
          <Icons.robot size={14} />
          <select
            className="agent-role-select"
            value={roleId}
            onChange={(e) => doSwitchRole(e.target.value)}
            title="切换专家角色（会写进系统提示词）"
          >
            {AGENT_ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </span>
        <span className="chip" title="当前使用的模型">
          {config?.model || '未配置模型'}
        </span>
        <span
          className={cls('follow-pill', agentContext && 'on')}
          onClick={() => setAgentContext(!agentContext)}
          title="开启后，每次提问都会自动把当前服务器的系统 / 内存 / 目录等信息一并带上"
        >
          {agentContext ? '已带服务器环境' : '不带服务器环境'}
        </span>
        <select
          className="agent-role-select"
          value={agentExecutionMode}
          onChange={(e) => setAgentExecutionMode(e.target.value as 'manual' | 'guarded' | 'trusted')}
          title="Agent 每次只执行一条命令，等待终端结果后再决定下一步"
        >
          <option value="manual">手动执行</option>
          <option value="guarded">受限授权</option>
          <option value="trusted">完全信任（高级）</option>
        </select>
        <span style={{ flex: 1 }} />
        {embedded ? <span className="muted agent-terminal-hint">命令会在左侧终端执行</span> : null}
        <Btn size="sm" icon={<Icons.sliders size={13} />} onClick={() => setSettingsOpen(true)}>
          模型配置
        </Btn>
        {canRestart ? (
          <Btn size="sm" icon={<Icons.refresh size={13} />} onClick={() => void dispatchAgentRun(profile.id, agentRun.goal)}>
            重新发送
          </Btn>
        ) : null}
        <Btn
          size="sm"
          icon={<Icons.trash size={13} />}
          onClick={() => agentClear(profile.id)}
          disabled={!messages.length && !agentRun}
        >
          清空对话
        </Btn>
      </div>

      {needsKey || noConfig ? (
        <div className="banner warn agent-noKey">
          <Icons.warn size={15} />
          <div>
            <b>还没有可用的模型配置</b>
            <div style={{ marginTop: 3 }}>
              填一个 Base URL + API Key 就能用了（支持 DeepSeek / 通义 / 智谱 / OpenAI / 本地 Ollama）。
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <Btn size="sm" variant="primary" onClick={() => setSettingsOpen(true)}>
            去配置
          </Btn>
        </div>
      ) : null}

      <div className="agent-body" ref={bodyRef} onScroll={onScroll}>
        {agentRun ? <AgentRunCard run={agentRun} onConfirm={(approve) => agentConfirmStep(profile.id, approve)} /> : null}
        {messages.length === 0 && !agentRun ? (
          <div className="agent-intro">
            <div className="agent-intro-icon">
              <Icons.robot size={30} />
            </div>
            <h3>{role.name}</h3>
            <p>{role.greeting}</p>
            <div className="agent-starters">
              {role.starters.map((s) => (
                <button key={s} className="agent-starter" onClick={() => send(s)} disabled={streaming}>
                  <Icons.sparkles size={12} />
                  {s}
                </button>
              ))}
            </div>
            <div className="agent-intro-tip">
              回答里的 <span className="mono">bash</span> 代码块可以直接「插入终端」——
              只填进命令行、不会自动回车，你确认后再执行。
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <MessageRow
              key={m.id}
              msg={m}
              streaming={streaming}
              isLast={i === messages.length - 1}
              elapsedMs={conv?.elapsedMs}
              usage={conv?.usage}
              onInsert={insertToTerminal}
              onExecute={executeInTerminal}
              autoExecute={false}
            />
          ))
        )}
      </div>

      <div className="agent-composer">
        <textarea
          className="agent-input"
          value={input}
          rows={2}
          placeholder={`向「${role.name}」提问，Enter 发送 / Shift+Enter 换行`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          disabled={streaming || agentBusy}
        />
        {streaming || agentBusy ? (
          <Btn variant="danger" icon={<Icons.stop size={14} />} onClick={() => void agentStop(profile.id)}>
            停止
          </Btn>
        ) : (
          <Btn
            variant="primary"
            icon={<Icons.send size={14} />}
            onClick={() => send()}
            disabled={!input.trim()}
          >
            发送
          </Btn>
        )}
      </div>

      {settingsOpen ? <AgentSettings onClose={() => setSettingsOpen(false)} /> : null}
      {pendingExec ? (
        <Confirm
          title="确认执行 AI 建议的危险命令？"
          danger
          confirmText="在终端执行"
          message={
            <>
              <p>这条命令会通过当前终端的真实 PTY 执行，回显和输出都会显示在终端中：</p>
              <pre className="agent-pre"><code>{pendingExec}</code></pre>
            </>
          }
          onCancel={() => setPendingExec(null)}
          onConfirm={confirmExecute}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- Agent 工具记录 */

function AgentRunCard({ run, onConfirm }: { run: import('@shared/types').AgentRunView; onConfirm: (approve: boolean) => void }): React.ReactElement {
  const stateLabel: Record<typeof run.state, string> = {
    idle: '待开始',
    thinking: '正在思考',
    confirming: '等待授权',
    executing: '终端执行中',
    done: '已完成',
    error: '执行失败',
    aborted: '已停止'
  }
  return (
    <section className="agent-run-card">
      <div className="agent-run-head"><Icons.robot size={14} /><b>终端 Agent</b><span className="chip">{stateLabel[run.state]}</span></div>
      <div className="agent-run-goal">任务：{run.goal}</div>
      {run.activity ? <div className="agent-thinking"><Spinner /><span>{run.activity}</span></div> : null}
      {run.steps.map((step, i) => (
        <details className="agent-tool-call" key={step.id} open>
          <summary>第 {i + 1} 步 · {step.summary} · <b>{step.status}</b></summary>
          <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>Agent 判断后只调用这一条命令，并等待左侧终端返回。</div>
          <pre className="agent-pre"><code>$ {step.command}</code></pre>
          {step.status === 'running' ? <div className="agent-thinking"><Spinner /><span>命令正在左侧终端运行，等待结果…</span></div> : null}
          {step.output !== undefined ? <><div className="muted" style={{ marginTop: 8, fontSize: 12 }}>终端返回</div><pre className="agent-tool-output"><code>{step.output || '(无输出)'}</code></pre></> : null}
          {step.exitCode !== undefined ? <span className="muted">退出码：{step.exitCode}</span> : null}
          {step.status === 'confirming' ? <div className="row" style={{ marginTop: 8 }}><Btn size="sm" variant="primary" onClick={() => onConfirm(true)}>执行此步骤</Btn><Btn size="sm" variant="ghost" onClick={() => onConfirm(false)}>停止 Agent</Btn></div> : null}
        </details>
      ))}
      {run.conclusion ? <div className="agent-final"><b>最终结论</b><MarkdownText text={run.conclusion} onInsert={() => {}} onExecute={() => {}} autoExecute={false} canAutoExecute={false} /></div> : null}
      {run.error ? <div className="agent-msg-error"><Icons.warn size={14} />{run.error}</div> : null}
    </section>
  )
}

/* --------------------------------------------------------------- 单条消息 */

function MessageRow({
  msg,
  streaming,
  isLast,
  elapsedMs,
  usage,
  onInsert,
  onExecute,
  autoExecute
}: {
  msg: AgentMsg
  streaming: boolean
  isLast: boolean
  elapsedMs?: number
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  onInsert: (cmd: string) => void
  onExecute: (cmd: string) => void
  autoExecute: boolean
}): React.ReactElement {
  const [copied, setCopied] = useState(false)

  if (msg.role === 'user') {
    return (
      <div className="agent-msg user">
        <div className="agent-bubble user">{msg.content}</div>
      </div>
    )
  }

  const busy = streaming && isLast && !msg.error

  const doCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(msg.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用就静默 */
    }
  }

  return (
    <div className="agent-msg bot">
      <div className="agent-avatar">
        <Icons.robot size={14} />
      </div>
      <div className="agent-bubble bot">
        {msg.reasoning ? (
          <details className="agent-reasoning">
            <summary>思考过程（{msg.reasoning.length} 字）</summary>
            <div className="agent-reasoning-body">{msg.reasoning}</div>
          </details>
        ) : null}

        {msg.content ? (
          <MarkdownText
            text={msg.content}
            onInsert={onInsert}
            onExecute={onExecute}
            autoExecute={autoExecute}
            canAutoExecute={isLast && !busy}
          />
        ) : busy ? (
          <div className="agent-thinking">
            <Spinner />
            <span>正在思考…</span>
          </div>
        ) : null}

        {msg.error ? (
          <div className="agent-msg-error">
            <Icons.warn size={14} />
            <span>{msg.error}</span>
          </div>
        ) : null}

        {!busy && (msg.content || msg.error) ? (
          <div className="agent-msg-foot">
            <button className="agent-mini" onClick={() => void doCopy()}>
              {copied ? '已复制' : '复制全文'}
            </button>
            {isLast && elapsedMs ? (
              <span className="muted">
                {(elapsedMs / 1000).toFixed(1)}s
                {usage?.completionTokens ? ` · 输出 ${usage.completionTokens} tokens` : ''}
              </span>
            ) : null}
            {msg.aborted ? <span className="muted">已中止</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* --------------------------------------------------- Markdown 的最小实现 */

type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'text'; text: string }

/** 只需要认识 fenced code block；其余按行做轻量处理（标题 / 列表 / 加粗 / 行内 code） */
function parseBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const out: Block[] = []
  let buf: string[] = []
  let i = 0
  const flush = (): void => {
    if (buf.length) {
      out.push({ kind: 'text', text: buf.join('\n') })
      buf = []
    }
  }
  while (i < lines.length) {
    const open = /^\s*```([\w+#.-]*)\s*$/.exec(lines[i])
    if (open) {
      flush()
      const lang = (open[1] || '').toLowerCase()
      const code: string[] = []
      i++
      // 流式输出时闭合的 ``` 可能还没到，这里按 EOF 收尾即可
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      i++
      out.push({ kind: 'code', lang, code: code.join('\n') })
      continue
    }
    buf.push(lines[i])
    i++
  }
  flush()
  return out
}

/**
 * 安全的行内 Markdown：仅创建 React 文本节点，不解析原始 HTML，避免模型输出注入页面。
 * 覆盖运维回答最常用的 code / bold / 删除线 / 链接。
 */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(<code key={`${keyPrefix}c${k++}`} className="agent-inline-code">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}b${k++}`}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('~~')) {
      out.push(<del key={`${keyPrefix}s${k++}`}>{tok.slice(2, -2)}</del>)
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(tok)
      out.push(link ? <a key={`${keyPrefix}a${k++}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a> : tok)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function TextBlock({ text, k }: { text: string; k: string }): React.ReactElement {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let list: string[] = []
  let ordered = false

  const flushList = (): void => {
    if (!list.length) return
    const items = list.map((li, i) => <li key={`${k}li${i}`}>{inline(li, `${k}li${i}`)}</li>)
    nodes.push(
      ordered ? <ol key={`${k}ol${nodes.length}`}>{items}</ol> : <ul key={`${k}ul${nodes.length}`}>{items}</ul>
    )
    list = []
  }

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '')
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushList()
      const level = Math.min(4, h[1].length)
      nodes.push(
        React.createElement(
          `h${level + 2}`,
          { key: `${k}h${i}`, className: 'agent-h' },
          inline(h[2], `${k}h${i}`)
        )
      )
      return
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      if (ordered) flushList()
      ordered = false
      list.push(ul[1])
      return
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ol) {
      if (!ordered) flushList()
      ordered = true
      list.push(ol[1])
      return
    }
    flushList()
    if (!line.trim()) return
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      nodes.push(
        <blockquote key={`${k}q${i}`} className="agent-quote">
          {inline(quote[1], `${k}q${i}`)}
        </blockquote>
      )
      return
    }
    nodes.push(
      <p key={`${k}p${i}`} className="agent-p">
        {inline(line, `${k}p${i}`)}
      </p>
    )
  })
  flushList()
  return <>{nodes}</>
}

/** 把代码块变成一个可以「复制 / 插入终端」的命令 */
function toInsertable(code: string): string | null {
  const lines = code
    .split('\n')
    .map((l) => l.replace(/^\s*\$\s+/, '').trimEnd())
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => l.trim())
  if (!lines.length) return null
  if (lines.length === 1) return lines[0]
  // 多行只有「全是普通命令」时才串成一个整体，含控制流就用粘贴的方式，别擅自改写语义
  const risky = /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|\}|\{|\(|\))\s*$/
  if (lines.some((l) => risky.test(l))) return null
  return lines.join(' && ')
}

/** 这些语言标记的代码块才值得往终端里插 */
const SHELLISH = /^(bash|sh|shell|zsh|console|shell-session|)$/

function MarkdownText({
  text,
  onInsert,
  onExecute,
  autoExecute,
  canAutoExecute
}: {
  text: string
  onInsert: (cmd: string) => void
  onExecute: (cmd: string) => void
  autoExecute: boolean
  canAutoExecute: boolean
}): React.ReactElement {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <div className="agent-md">
      {blocks.map((b, i) =>
        b.kind === 'code' ? (
          <CodeBlock
            key={`b${i}`}
            lang={b.lang}
            code={b.code}
            onInsert={onInsert}
            onExecute={onExecute}
            autoExecute={autoExecute}
            canAutoExecute={canAutoExecute}
          />
        ) : (
          <TextBlock key={`b${i}`} text={b.text} k={`b${i}`} />
        )
      )}
    </div>
  )
}

function CodeBlock({
  lang,
  code,
  onInsert,
  onExecute,
  autoExecute,
  canAutoExecute
}: {
  lang: string
  code: string
  onInsert: (cmd: string) => void
  onExecute: (cmd: string) => void
  autoExecute: boolean
  canAutoExecute: boolean
}): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const insertable = SHELLISH.test(lang) ? toInsertable(code) : null
  const executedRef = useRef<string | null>(null)

  // 仅对“最新回复 + 流式结束”的普通 Shell 命令自动执行一次；历史消息和危险命令永不自动重跑。
  useEffect(() => {
    if (!autoExecute || !canAutoExecute || !insertable || isDangerous(insertable)) return
    if (executedRef.current === insertable) return
    executedRef.current = insertable
    onExecute(insertable)
  }, [autoExecute, canAutoExecute, insertable, onExecute])

  const doCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code.replace(/^\s*\$\s+/gm, ''))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="agent-codeblock">
      <div className="agent-cb-head">
        <span className="agent-cb-lang">{lang || 'text'}</span>
        <span style={{ flex: 1 }} />
        <Btn size="sm" variant="ghost" icon={<Icons.copy size={12} />} onClick={() => void doCopy()}>
          {copied ? '已复制' : '复制'}
        </Btn>
        {insertable ? (
          <>
            <Btn
              size="sm"
              variant="ghost"
              icon={<Icons.terminal size={12} />}
              onClick={() => onInsert(insertable)}
              title="把这条命令填进终端命令行（不会自动执行）"
            >
              插入终端
            </Btn>
            <Btn
              size="sm"
              variant="primary"
              icon={<Icons.send size={12} />}
              onClick={() => onExecute(insertable)}
              title="通过当前终端 PTY 执行；命令与输出都在终端可见"
            >
              在终端执行
            </Btn>
          </>
        ) : null}
      </div>
      <pre className="agent-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}
