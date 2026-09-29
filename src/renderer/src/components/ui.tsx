import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { cls } from '../lib/utils'

/* ------------------------------------------------------------------ 图标 */

type IconProps = { size?: number; className?: string }

const svg = (path: React.ReactNode, viewBox = '0 0 24 24') =>
  function Icon({ size = 15, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={{ flex: '0 0 auto' }}
      >
        {path}
      </svg>
    )
  }

export const Icons = {
  server: svg(
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  terminal: svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  folder: svg(<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />),
  file: svg(
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </>
  ),
  chart: svg(<path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3" />),
  docker: svg(
    <>
      <path d="M3 12h13a4 4 0 004-4h2a3 3 0 01-3 3" />
      <path d="M6 12V9h3v3M10 12V9h3v3M10 8V5h3v3M14 12V9h3v3" />
      <path d="M1.5 13c1 3.5 4 5.5 8 5.5 5 0 8.5-2.5 10-6" />
    </>
  ),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  refresh: svg(<path d="M20 11a8 8 0 10-2.3 5.7M20 4v5h-5" />),
  upload: svg(<path d="M12 16V4M7 9l5-5 5 5M4 20h16" />),
  download: svg(<path d="M12 4v12M7 11l5 5 5-5M4 20h16" />),
  trash: svg(<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" />),
  edit: svg(<path d="M4 20h4l10-10-4-4L4 16v4zM14 6l4 4" />),
  key: svg(
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21M18 12v3M15 12v2.5" />
    </>
  ),
  lock: svg(
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </>
  ),
  play: svg(<path d="M7 5l12 7-12 7V5z" />),
  stop: svg(<rect x="6" y="6" width="12" height="12" rx="1.5" />),
  restart: svg(<path d="M20 12a8 8 0 10-3 6.2M20 6v6h-6" />),
  chevronRight: svg(<path d="M9 6l6 6-6 6" />),
  chevronDown: svg(<path d="M6 9l6 6 6-6" />),
  search: svg(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
  close: svg(<path d="M6 6l12 12M18 6L6 18" />),
  check: svg(<path d="M5 13l4 4L19 7" />),
  warn: svg(
    <>
      <path d="M12 3l9 16H3l9-16z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  info: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  plug: svg(<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 01-6 6 6 6 0 01-6-6V9zM12 18v3" />),
  plugOff: svg(<path d="M9 3v5M15 3v5M6 9h12v3a6 6 0 01-1.5 3.9M12 18v3M3 3l18 18" />),
  copy: svg(
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 012-2h9" />
    </>
  ),
  chip: svg(
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  disk: svg(
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  net: svg(<path d="M12 3v18M4 8l8-5 8 5M4 16l8 5 8-5" />),
  clock: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  robot: svg(
    <>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 8V5M12 3.5h.01" />
      <circle cx="9" cy="13" r="1.2" />
      <circle cx="15" cy="13" r="1.2" />
      <path d="M9.5 16.2h5" />
      <path d="M2.5 12v3M21.5 12v3" />
    </>
  ),
  sparkles: svg(
    <>
      <path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </>
  ),
  send: svg(<path d="M4.5 12l15-7-4.2 15-3.6-6.2L4.5 12zM11.7 13.8l3.4-3.4" />),
  sliders: svg(
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  )
}

/* ------------------------------------------------------------------ 基础 */

export function Spinner({ light }: { light?: boolean }): React.ReactElement {
  return <span className={cls('spinner', light && 'light')} />
}

export function Btn({
  children,
  icon,
  variant = 'default',
  size,
  block,
  loading,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: React.ReactNode
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm'
  block?: boolean
  loading?: boolean
}): React.ReactElement {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cls(
        'btn',
        variant !== 'default' && variant,
        size === 'sm' && 'sm',
        block && 'block',
        !children && 'icon',
        rest.className
      )}
      title={rest.title}
    >
      {loading ? <Spinner light={variant === 'primary'} /> : icon}
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="field">
      <label className="label">{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide,
  xtall
}: {
  title: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  onClose: () => void
  wide?: boolean
  xtall?: boolean
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cls('modal', wide && 'wide', xtall && 'xtall')}>
        <div className="modal-head">
          <span>{title}</span>
          <span className="spacer" />
          <Btn variant="ghost" size="sm" icon={<Icons.close size={14} />} onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Confirm({
  title,
  message,
  danger,
  confirmText = '确定',
  onConfirm,
  onCancel
}: {
  title: string
  message: React.ReactNode
  danger?: boolean
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Btn onClick={onCancel}>取消</Btn>
          <Btn variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </Btn>
        </>
      }
    >
      <div style={{ lineHeight: 1.7, fontSize: 13 }}>{message}</div>
    </Modal>
  )
}

export function Toasts(): React.ReactElement {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', t.type)} onClick={() => dismiss(t.id)} role="alert">
          <div className="toast-title">{t.title}</div>
          {t.message ? <div className="muted">{t.message}</div> : null}
        </div>
      ))}
    </div>
  )
}

export function Empty({
  icon,
  title,
  desc,
  children
}: {
  icon?: React.ReactNode
  title: string
  desc?: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="empty">
      <div className="empty-inner">
        <div style={{ color: '#c3c8da', display: 'flex', justifyContent: 'center' }}>{icon}</div>
        <h2>{title}</h2>
        {desc ? <p>{desc}</p> : null}
        {children}
      </div>
    </div>
  )
}

/** 简易受控输入：回车提交 */
export function InlineInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
  selectBasename
}: {
  initial: string
  placeholder?: string
  onSubmit: (v: string) => void
  onCancel: () => void
  selectBasename?: boolean
}): React.ReactElement {
  const [v, setV] = useState(initial)
  const ref = React.useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (selectBasename) {
      const dot = initial.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : initial.length)
    } else {
      el.select()
    }
  }, [initial, selectBasename])

  return (
    <input
      ref={ref}
      className="input mono"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit(v.trim())
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={onCancel}
    />
  )
}
