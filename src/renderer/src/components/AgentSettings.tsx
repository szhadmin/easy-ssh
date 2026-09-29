import React, { useEffect, useState } from 'react'
import { AGENT_PRESETS, AGENT_ROLES, DEFAULT_ROLE_ID, findRole } from '@shared/agent-roles'
import type { AgentModelItem } from '@shared/types'
import { Btn, Field, Icons, Modal } from './ui'
import { useStore } from '../store'
import { cls } from '../lib/utils'

/** 判断是不是本机地址（本地推理服务通常不校验 Key） */
export function isLocalEndpoint(baseURL: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(
    (baseURL || '').trim()
  )
}

export function AgentSettings({
  onClose,
  onSaved
}: {
  onClose: () => void
  onSaved?: () => void
}): React.ReactElement {
  const config = useStore((s) => s.agentConfig)
  const saveAgentConfig = useStore((s) => s.saveAgentConfig)
  const testAgentConfig = useStore((s) => s.testAgentConfig)
  const toast = useStore((s) => s.toast)

  const [baseURL, setBaseURL] = useState(config?.baseURL ?? '')
  const [model, setModel] = useState(config?.model ?? '')
  const [temperature, setTemperature] = useState(config?.temperature ?? 0.3)
  const [apiKey, setApiKey] = useState('')
  const [roleId, setRoleId] = useState(config?.roleId ?? DEFAULT_ROLE_ID)
  const [prompts, setPrompts] = useState<Record<string, string>>(config?.prompts ?? {})

  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [models, setModels] = useState<AgentModelItem[]>([])
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // 配置是异步加载的，回来了再补一次初值（用户已经改过的输入会被下面的 dirty 判断保护）
  useEffect(() => {
    if (!config) return
    setBaseURL((v) => v || config.baseURL)
    setModel((v) => v || config.model)
    setRoleId((v) => v || config.roleId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  const role = findRole(roleId)
  const presetHit = AGENT_PRESETS.find(
    (p) => p.baseURL && p.baseURL === baseURL.trim() && p.model === model.trim()
  )

  const applyPreset = (id: string): void => {
    const p = AGENT_PRESETS.find((x) => x.id === id)
    if (!p) return
    if (p.baseURL) setBaseURL(p.baseURL)
    if (p.model) setModel(p.model)
    setTestResult(null)
  }

  const loadModels = async (): Promise<void> => {
    if (!baseURL.trim()) {
      setTestResult({ ok: false, msg: '请先填写 Base URL' })
      return
    }
    if (!apiKey.trim() && !config?.hasKey && !isLocalEndpoint(baseURL)) {
      setTestResult({ ok: false, msg: '请先填写 API Key（本地推理服务可留空）' })
      return
    }
    setLoadingModels(true)
    setTestResult(null)
    try {
      const r = await window.api.agent.models({ baseURL: baseURL.trim(), apiKey: apiKey.trim() || undefined })
      if (!r.ok) throw new Error(r.error || '获取模型失败')
      setModels(r.data ?? [])
      setTestResult({ ok: true, msg: `已获取 ${r.data?.length ?? 0} 个模型，点击下拉框选择` })
    } catch (e) {
      setModels([])
      setTestResult({ ok: false, msg: (e as Error).message })
    } finally {
      setLoadingModels(false)
    }
  }

  const doTest = async (): Promise<void> => {
    if (!baseURL.trim()) {
      setTestResult({ ok: false, msg: '请先填写 Base URL' })
      return
    }
    if (!model.trim()) {
      setTestResult({ ok: false, msg: '请先填写模型名' })
      return
    }
    if (!apiKey.trim() && !config?.hasKey && !isLocalEndpoint(baseURL)) {
      setTestResult({ ok: false, msg: '请先填写 API Key（本地推理服务可留空）' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = await testAgentConfig({
        baseURL: baseURL.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined
      })
      setTestResult({
        ok: true,
        msg:
          `连通正常（${r.latencyMs} ms），模型 ${r.model}` +
          (r.sample ? `，返回内容：「${r.sample.slice(0, 40)}」` : '')
      })
    } catch (e) {
      setTestResult({ ok: false, msg: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const doSave = async (): Promise<void> => {
    setSaving(true)
    const ok = await saveAgentConfig(
      {
        baseURL: baseURL.trim(),
        model: model.trim(),
        temperature,
        roleId,
        prompts
      },
      // 留空表示不改动已保存的 Key
      apiKey.trim() ? apiKey.trim() : undefined
    )
    setSaving(false)
    if (ok) {
      toast('success', '模型配置已保存')
      onSaved?.()
      onClose()
    }
  }

  const clearKey = async (): Promise<void> => {
    await saveAgentConfig({}, '')
    setApiKey('')
    toast('info', '已清除本机保存的 API Key')
  }

  return (
    <Modal
      title="AI 助手 · 模型配置"
      onClose={onClose}
      wide
      xtall
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
      <div className="banner info" style={{ marginTop: 0 }}>
        <Icons.info size={15} />
        <div>
          任何兼容 <span className="mono">/v1/chat/completions</span> 的服务都能用（OpenAI、DeepSeek、
          通义、智谱、Moonshot、本地 Ollama、one-api 中转等）。API Key 用 Windows DPAPI
          加密后存在本机，不会随连接配置导出，也不会写进日志。
        </div>
      </div>

      <Field label="快捷预设" hint="点一下自动填好地址和模型，改完记得点「测试连接」">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {AGENT_PRESETS.map((p) => (
            <button
              key={p.id}
              className={cls('agent-preset', presetHit?.id === p.id && 'on')}
              onClick={() => applyPreset(p.id)}
              title={p.note}
            >
              {p.name}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid-2">
        <Field label="Base URL" hint="一般以 /v1 结尾，程序会自动补 /chat/completions">
          <input
            className="input mono"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
          />
        </Field>
        <Field label="模型名" hint="可手动填写；点击“获取模型”后也可从下拉框选择">
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input mono flex1"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              list="agent-model-list"
            />
            <Btn size="sm" onClick={() => void loadModels()} loading={loadingModels} icon={<Icons.refresh size={13} />}>
              获取模型
            </Btn>
          </div>
          {models.length ? (
            <datalist id="agent-model-list">
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.ownedBy ? `${m.id} · ${m.ownedBy}` : m.id}</option>
              ))}
            </datalist>
          ) : null}
        </Field>
      </div>

      <Field
        label="API Key"
        hint={
          config?.hasKey
            ? `已保存：${config.keyMasked}${config.plaintextFallback ? '（当前环境不支持加密，仅做了混淆存储）' : ''}。留空表示不修改。`
            : '还没有保存 Key。本地 Ollama 之类的服务可以随便填一个（如 ollama）。'
        }
      >
        <div className="row">
          <input
            className="input mono flex1"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasKey ? '••••••••（不改动请留空）' : 'sk-...'}
            autoComplete="off"
          />
          {config?.hasKey ? (
            <Btn onClick={() => void clearKey()} icon={<Icons.trash size={14} />} title="清除本机保存的 Key">
              清除
            </Btn>
          ) : null}
        </div>
      </Field>

      <Field label={`随机性 temperature：${temperature.toFixed(1)}`} hint="运维问答建议 0.2 ~ 0.4，越低越稳">
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="角色模板" hint="决定系统提示词里的专家人设；下面的补充要求会追加在末尾">
        <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {AGENT_ROLES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} —— {r.tagline}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={`「${role.name}」的补充要求（可选）`}
        hint="例如：我们的服务器统一是 Ubuntu 22.04、禁止直接改 /etc/nginx 而是走 conf.d；只写这一段即可"
      >
        <textarea
          className="input"
          rows={3}
          value={prompts[roleId] ?? ''}
          onChange={(e) => setPrompts((p) => ({ ...p, [roleId]: e.target.value }))}
          placeholder="补充你的环境约定、命名规范、必须遵守的约束…"
          style={{ resize: 'vertical', lineHeight: 1.7 }}
        />
      </Field>

      {testResult ? (
        <div className={`banner ${testResult.ok ? 'info' : 'error'}`} style={{ marginBottom: 0 }}>
          {testResult.ok ? <Icons.check size={15} /> : <Icons.warn size={15} />}
          <div>{testResult.msg}</div>
        </div>
      ) : null}
    </Modal>
  )
}
