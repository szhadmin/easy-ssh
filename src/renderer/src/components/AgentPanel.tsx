import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRunView, AgentToolStep, ConnectionProfile } from '@shared/types'
import { AGENT_ROLES, findRole } from '@shared/agent-roles'
import { useStore } from '../store'
import { Btn, Confirm, Icons, Spinner } from './ui'
import { AgentSettings, isLocalEndpoint } from './AgentSettings'
import { isDangerous } from '../lib/commands'
import { cls } from '../lib/utils'

/** 稳定引用：避免每次都造一个新数组，把 zustand 的选择器逼成死循环 */
const NO_RUNS: AgentRunView[] = []

export function AgentPanel({
  profile,
  embedded = false
}: {
  profile: ConnectionProfile
  embedded?: boolean
}): React.ReactElement {
  const runs = useStore((s) => s.agentRuns[profile.id]) ?? NO_RUNS
  const config = useStore((s) => s.agentConfig)
  const configLoaded = useStore((s) => s.agentConfigLoaded)
  const agentContext = useStore((s) => s.agentContext)
  const setAgentContext = useStore((s) => s.setAgentContext)
  const agentExecutionMode = useStore((s) => s.agentExecutionMode)
  const setAgentExecutionMode = useStore((s) => s.setAgentExecutionMode)
  const agentRun = useStore((s) => s.agentRun)
  const agentConfirmStep = useStore((s) => s.agentConfirmStep)
  const agentStop = useStore((s) => s.agentStop)
  const agentClear = useStore((s) => s.agentClear)
  const loadAgentMemory = useStore((s) => s.loadAgentMemory)
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
  const needsKey = configLoaded && !!config && !config.hasKey && !isLocalEndpoint(config.baseURL)
  const noConfig = configLoaded && !config

  const busy = runs.some((r) => r.state === 'thinking' || r.state === 'executing')

  // 新内容进来时贴着底部滚（用户自己往上翻就不打扰他）
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [runs])

  // 打开面板 / 换服务器时把长期记忆拉进来
  // （模型运行中用 remember 记了新事实会推 memory 事件，由 store 就地更新）
  useEffect(() => {
    void loadAgentMemory(profile.id)
  }, [profile.id, loadAgentMemory])

  const onScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = (text?: string): void => {
    const t = (text ?? input).trim()
    if (!t || busy) return
    void agentRun(profile.id, t)
    setInput('')
    stickToBottom.current = true
  }

  const insertToTerminal = (cmd: string): void => {
    injectTerm(profile.id, cmd)
    setTab('terminal')
    toast('info', '已插入终端', '确认无误后按回车执行')
  }

  /** 执行仍复用当前 xterm 关联的 PTY：回显与输出和手工执行完全一致 */
  const executeInTerminal = (cmd: string): void => {
    if (isDangerous(cmd)) {
      setPendingExec(cmd)
      return
    }
    injectTerm(profile.id, cmd, true)
    setTab('terminal')
    toast('info', '命令已在终端执行', '输出会实时显示在终端；可用 Ctrl+C 中止')
  }

  const confirmExecute = (): void => {
    if (!pendingExec) return
    injectTerm(profile.id, pendingExec, true)
    setTab('terminal')
    toast('warn', '危险命令已确认执行', '命令与输出均在终端可见；需要时按 Ctrl+C 中止')
    setPendingExec(null)
  }

  const mdProps = {
    onInsert: insertToTerminal,
    onExecute: executeInTerminal,
    autoExecute: false,
    canAutoExecute: false
  }

  return (
    <div className="panel flush agent-panel">
      <div className="pathbar agent-bar">
        <span className="agent-bar-role">
          <Icons.robot size={14} />
          <select
            className="agent-role-select"
            value={roleId}
            onChange={(e) => void saveAgentConfig({ roleId: e.target.value })}
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
          onChange={(e) =>
            setAgentExecutionMode(e.target.value as 'manual' | 'guarded' | 'trusted')
          }
          title="Agent 每次只执行一条命令，等终端结果回来后再决定下一步"
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
        <Btn
          size="sm"
          icon={<Icons.trash size={13} />}
          onClick={() => agentClear(profile.id)}
          disabled={runs.length === 0}
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
        {runs.length === 0 ? (
          <div className="agent-intro">
            <div className="agent-intro-icon">
              <Icons.robot size={30} />
            </div>
            <h3>{role.name}</h3>
            <p>{role.greeting}</p>
            <div className="agent-starters">
              {role.starters.map((s) => (
                <button key={s} className="agent-starter" onClick={() => send(s)} disabled={busy}>
                  <Icons.sparkles size={12} />
                  {s}
                </button>
              ))}
            </div>
            <div className="agent-intro-tip">
              Agent 会一步步来：每一步只发<b>一条</b>命令，在左侧终端执行，
              拿到真实输出与退出码后再决定下一步。
            </div>
          </div>
        ) : (
          runs.map((r) => (
            <div className="agent-turn" key={r.id}>
              <div className="agent-msg user">
                <div className="agent-bubble user">{r.goal}</div>
              </div>
              <RunCard
                run={r}
                mdProps={mdProps}
                onConfirm={(approve) => agentConfirmStep(profile.id, approve)}
                onRerun={() => void agentRun(profile.id, r.goal)}
              />
            </div>
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
          disabled={busy}
        />
        {busy ? (
          <Btn variant="danger" icon={<Icons.stop size={14} />} onClick={() => void agentStop(profile.id)}>
            停止
          </Btn>
        ) : (
          <Btn variant="primary" icon={<Icons.send size={14} />} onClick={() => send()} disabled={!input.trim()}>
            发送
          </Btn>
        )}
      </div>

      {settingsOpen ? (
        <AgentSettings profileId={profile.id} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {pendingExec ? (
        <Confirm
          title="确认执行这条危险命令？"
          danger
          confirmText="在终端执行"
          message={
            <>
              <p>这条命令会通过当前终端的真实 PTY 执行，回显和输出都会显示在终端中：</p>
              <pre className="agent-pre">
                <code>{pendingExec}</code>
              </pre>
            </>
          }
          onCancel={() => setPendingExec(null)}
          onConfirm={confirmExecute}
        />
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------- 一轮任务的卡片 */

type MdProps = {
  onInsert: (cmd: string) => void
  onExecute: (cmd: string) => void
  autoExecute: boolean
  canAutoExecute: boolean
}

const RUN_STATE_LABEL: Record<AgentRunView['state'], string> = {
  thinking: '正在思考',
  executing: '终端执行中',
  done: '已完成',
  error: '执行失败',
  aborted: '已停止'
}

const STEP_STATE_LABEL: Record<AgentToolStep['status'], string> = {
  pending: '待执行',
  confirming: '等待授权',
  running: '终端执行中',
  done: '已完成',
  failed: '执行失败',
  denied: '已拒绝',
  cancelled: '已取消'
}

function RunCard({
  run,
  mdProps,
  onConfirm,
  onRerun
}: {
  run: AgentRunView
  mdProps: MdProps
  onConfirm: (approve: boolean) => void
  onRerun: () => void
}): React.ReactElement {
  const busy = run.state === 'thinking' || run.state === 'executing'
  return (
    <section className="agent-run-card">
      <div className="agent-run-head">
        <Icons.robot size={14} />
        <b>终端 Agent</b>
        <span className="chip">{RUN_STATE_LABEL[run.state]}</span>
        <span style={{ flex: 1 }} />
        {!busy ? (
          <Btn size="sm" variant="ghost" icon={<Icons.refresh size={12} />} onClick={onRerun}>
            重新发送
          </Btn>
        ) : null}
      </div>

      {run.activity ? (
        <div className="agent-thinking">
          {busy ? <Spinner /> : null}
          <span>{run.activity}</span>
        </div>
      ) : null}

      {run.reasoning ? (
        <details className="agent-reasoning">
          <summary>模型推理过程（{run.reasoning.length} 字）</summary>
          <div className="agent-reasoning-body">{run.reasoning}</div>
        </details>
      ) : null}

      {run.steps.map((step, i) => (
        <StepBlock key={step.id} index={i} step={step} onConfirm={onConfirm} />
      ))}

      {/* 正在流式输出的正文：等模型调用下一步工具时会被收进那一步的「思考」里 */}
      {run.text ? (
        <div className="agent-run-text">
          <MarkdownText text={run.text} {...mdProps} />
        </div>
      ) : null}

      {run.conclusion ? (
        <div className="agent-final">
          <b>结论</b>
          <MarkdownText text={run.conclusion} {...mdProps} />
        </div>
      ) : null}

      {run.error ? (
        <div className="agent-msg-error">
          <Icons.warn size={14} />
          {run.error}
        </div>
      ) : null}
    </section>
  )
}

function StepBlock({
  index,
  step,
  onConfirm
}: {
  index: number
  step: AgentToolStep
  onConfirm: (approve: boolean) => void
}): React.ReactElement {
  return (
    <div className={cls('agent-step', `st-${step.status}`)}>
      <div className="agent-step-head">
        <span className="agent-step-no">第 {index + 1} 步</span>
        {step.tool && step.tool !== 'run_command' ? (
          <span className="chip accent" title="由专用工具生成，参数已转义">
            {step.tool}
          </span>
        ) : null}
        {step.danger ? (
          <span className="chip amber" title="这是写操作，会改动服务器上的文件">
            写操作
          </span>
        ) : null}
        <span className="agent-step-intent">{step.intent}</span>
        <span className={cls('agent-step-state', `st-${step.status}`)}>
          {STEP_STATE_LABEL[step.status]}
        </span>
      </div>

      {step.thinking ? <div className="agent-step-think">{step.thinking}</div> : null}

      <pre className="agent-pre">
        <code>$ {step.command}</code>
      </pre>

      {step.status === 'running' ? (
        <div className="agent-thinking">
          <Spinner />
          <span>命令正在左侧终端运行，等待结果…</span>
        </div>
      ) : null}

      {step.status === 'confirming' ? (
        <>
          {step.danger ? (
            <div className="banner warn" style={{ margin: '8px 0 0' }}>
              <Icons.warn size={14} />
              <div>这是写操作：命令会把内容写入服务器上的文件，覆盖原内容不可撤销。确认后再执行。</div>
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            <Btn size="sm" variant="primary" onClick={() => onConfirm(true)}>
              在终端执行
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => onConfirm(false)}>
              拒绝并停止
            </Btn>
          </div>
        </>
      ) : null}

      {step.output !== undefined ? (
        <>
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            终端返回
          </div>
          <pre className="agent-tool-output">
            <code>{step.output || '(无输出)'}</code>
          </pre>
        </>
      ) : null}

      {step.exitCode !== undefined ? (
        <span className={cls('muted', step.exitCode !== 0 && 'agent-rc-bad')}>退出码：{step.exitCode}</span>
      ) : null}
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
      out.push(
        <code key={`${keyPrefix}c${k++}`} className="agent-inline-code">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}b${k++}`}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('~~')) {
      out.push(<del key={`${keyPrefix}s${k++}`}>{tok.slice(2, -2)}</del>)
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(tok)
      out.push(
        link ? (
          <a key={`${keyPrefix}a${k++}`} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          tok
        )
      )
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

  // 仅对「最新回复 + 流式结束」的普通 Shell 命令自动执行一次；历史消息和危险命令永不自动重跑。
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
