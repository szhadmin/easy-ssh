import React, { useState } from 'react'
import type { AuthType, ConnectionProfile, ConnectionSecret } from '@shared/types'
import { Btn, Field, Icons, Modal } from './ui'
import { useStore } from '../store'
import { unwrap } from '../lib/utils'

const COLORS = ['#6366f1', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444', '#ec4899', '#22c55e']

export function ConnectionDialog({
  editing,
  onClose
}: {
  editing: ConnectionProfile | null
  onClose: () => void
}): React.ReactElement {
  const toast = useStore((s) => s.toast)
  const refresh = useStore((s) => s.refreshProfiles)

  const [name, setName] = useState(editing?.name ?? '')
  const [host, setHost] = useState(editing?.host ?? '')
  const [port, setPort] = useState(String(editing?.port ?? 22))
  const [username, setUsername] = useState(editing?.username ?? 'root')
  const [authType, setAuthType] = useState<AuthType>(editing?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState(editing?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [group, setGroup] = useState(editing?.group ?? '默认分组')
  const [color, setColor] = useState(editing?.color ?? COLORS[0])

  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const buildProfile = (): ConnectionProfile =>
    ({
      id: editing?.id ?? '',
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authType,
      privateKeyPath: authType === 'key' ? keyPath.trim() : undefined,
      group: group.trim() || '默认分组',
      color,
      createdAt: editing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }) as ConnectionProfile

  const buildSecret = (): ConnectionSecret => {
    if (authType === 'password') return { password }
    if (authType === 'key') return { passphrase }
    return {}
  }

  const validate = (): string | null => {
    if (!name.trim()) return '请填写连接名称，例如「生产服务器」'
    if (!host.trim()) return '请填写服务器 IP 或域名'
    if (!username.trim()) return '请填写登录用户名'
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return '端口需为 1-65535 之间的整数'
    if (authType === 'key' && !keyPath.trim()) return '选择私钥登录时，请填写私钥文件路径'
    if (!editing && authType === 'password' && !password) return '请填写登录密码'
    return null
  }

  const doTest = async (): Promise<void> => {
    const err = validate()
    if (err) {
      setTestResult({ ok: false, msg: err })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = await unwrap(window.api.connections.test(buildProfile(), buildSecret()))
      setTestResult({
        ok: true,
        msg: `连接成功！远端主机：${r.hostname || '未知'}，家目录：${r.home}`
      })
    } catch (e) {
      setTestResult({ ok: false, msg: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const doSave = async (): Promise<void> => {
    const err = validate()
    if (err) {
      toast('warn', '请先补全信息', err)
      return
    }
    setSaving(true)
    try {
      // 编辑且未重新输入密码时，secret 传 undefined 表示不改动
      const secret = editing && authType === 'password' && !password ? undefined : buildSecret()
      await unwrap(window.api.connections.save(buildProfile(), secret))
      await refresh()
      toast('success', editing ? '已保存修改' : '连接已创建')
      onClose()
    } catch (e) {
      toast('error', '保存失败', (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const pickKey = async (): Promise<void> => {
    try {
      const r = await unwrap(window.api.app.pickFile('选择 SSH 私钥文件'))
      if (r.path) setKeyPath(r.path)
    } catch (e) {
      toast('error', '选择文件失败', (e as Error).message)
    }
  }

  return (
    <Modal
      title={editing ? `编辑连接 · ${editing.name}` : '新建 SSH 连接'}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={doTest} loading={testing} icon={<Icons.plug size={14} />}>
            测试连接
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" onClick={doSave} loading={saving} icon={<Icons.check size={14} />}>
            保存
          </Btn>
        </>
      }
    >
      <div className="grid-2">
        <Field label="连接名称" hint="仅本地显示，方便区分，例如「生产 Web 服务器」">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="生产服务器"
            autoFocus
          />
        </Field>
        <Field label="分组" hint="侧边栏按分组归类，可留空">
          <input className="input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="默认分组" />
        </Field>
      </div>

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 3 }}>
          <Field label="服务器地址">
            <input
              className="input mono"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.10 或 example.com"
            />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="端口">
            <input className="input mono" value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
          </Field>
        </div>
        <div style={{ flex: 2 }}>
          <Field label="登录用户名">
            <input
              className="input mono"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
            />
          </Field>
        </div>
      </div>

      <Field label="认证方式">
        <div className="row" style={{ gap: 16 }}>
          {(
            [
              ['password', '密码', '最简单，填账号密码即可'],
              ['key', '密钥文件', '更安全，使用 id_rsa / id_ed25519 等私钥'],
              ['agent', 'SSH Agent', '复用本机已加载的密钥（需已启动 ssh-agent）']
            ] as Array<[AuthType, string, string]>
          ).map(([v, label, d]) => (
            <label key={v} className="checkbox" title={d}>
              <input type="radio" checked={authType === v} onChange={() => setAuthType(v)} />
              {label}
            </label>
          ))}
        </div>
        <div className="hint">
          {authType === 'password'
            ? '密码将使用 Windows DPAPI 加密后保存在本机，不会明文落盘，也不会外传。'
            : authType === 'key'
              ? '私钥始终留在本机，仅用于握手；建议私钥文件权限设为仅本人可读。'
              : '将调用 Windows 的 OpenSSH Agent（\\\\.\\pipe\\openssh-ssh-agent），需要先 ssh-add 加载密钥。'}
        </div>
      </Field>

      {authType === 'password' ? (
        <Field
          label={editing ? '登录密码（留空表示不修改）' : '登录密码'}
          hint="仅保存在本机加密存储中"
        >
          <input
            className="input mono"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={editing ? '••••••（不改动请留空）' : '输入密码'}
          />
        </Field>
      ) : null}

      {authType === 'key' ? (
        <>
          <Field label="私钥文件路径">
            <div className="row">
              <input
                className="input mono flex1"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder={'C:\\Users\\you\\.ssh\\id_ed25519'}
              />
              <Btn onClick={pickKey} icon={<Icons.folder size={14} />}>
                浏览
              </Btn>
            </div>
          </Field>
          <Field label="私钥口令 Passphrase（可选）" hint="私钥未加密时留空即可">
            <input
              className="input mono"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="私钥若已加密，请填写口令"
            />
          </Field>
        </>
      ) : null}

      <Field label="标识颜色">
        <div className="row" style={{ gap: 8 }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: c,
                border: color === c ? '2px solid #1e2233' : '2px solid transparent',
                cursor: 'pointer'
              }}
              title={c}
            />
          ))}
        </div>
      </Field>

      {testResult ? (
        <div className={`banner ${testResult.ok ? 'info' : 'error'}`} style={{ marginTop: 4, marginBottom: 0 }}>
          <span style={{ marginTop: 1 }}>{testResult.ok ? <Icons.check size={15} /> : <Icons.warn size={15} />}</span>
          <div>{testResult.msg}</div>
        </div>
      ) : null}
    </Modal>
  )
}
