import React, { useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { ConnectionProfile, ProcessRow } from '@shared/types'
import { useStore } from '../store'
import { Btn, Confirm, Icons } from './ui'
import { cls, formatBytes, formatClock, formatKbps, formatUptime, usageColor } from '../lib/utils'

export function OverviewPanel({ profile }: { profile: ConnectionProfile }): React.ReactElement {
  const m = useStore((s) => s.metrics[profile.id])
  const history = useStore((s) => s.history[profile.id]) ?? []
  const info = useStore((s) => s.infos[profile.id])
  const toast = useStore((s) => s.toast)
  const poll = useStore((s) => s.pollMetrics)
  const [killTarget, setKillTarget] = useState<ProcessRow | null>(null)
  const [procSort, setProcSort] = useState<'cpu' | 'mem'>('cpu')

  if (!m) {
    return (
      <div className="panel">
        <div className="muted center">
          <span className="spinner" /> 正在采集系统指标…
        </div>
      </div>
    )
  }

  const memUsed = m.memTotalKb - m.memAvailableKb
  const memPercent = m.memTotalKb > 0 ? (memUsed / m.memTotalKb) * 100 : 0
  const swapUsed = m.swapTotalKb - m.swapFreeKb
  const loadPercent = m.cpuCores > 0 ? (m.load1 / m.cpuCores) * 100 : 0
  const netTotal = m.netRate.rxBytesPerSec + m.netRate.txBytesPerSec

  const chartData = history.map((p) => ({
    t: formatClock(p.t),
    CPU: p.cpu,
    内存: p.memUsedPercent,
    '↓ 下载 KB/s': Number((p.rx / 1024).toFixed(1)),
    '↑ 上传 KB/s': Number((p.tx / 1024).toFixed(1))
  }))

  const rows = procSort === 'cpu' ? m.topCpu : m.topMem

  return (
    <div className="panel">
      <div className="cards">
        <MetricCard
          icon={<Icons.chip size={14} />}
          title="CPU 使用率"
          value={`${m.cpuPercent.toFixed(1)}%`}
          color={usageColor(m.cpuPercent)}
          percent={m.cpuPercent}
          sub={`${m.cpuCores} 核 · ${trimCpu(m.cpuModel)}`}
        />
        <MetricCard
          icon={<Icons.server size={14} />}
          title="内存使用"
          value={`${memPercent.toFixed(1)}%`}
          color={usageColor(memPercent)}
          percent={memPercent}
          sub={`${formatBytes(memUsed * 1024)} / ${formatBytes(m.memTotalKb * 1024)}${
            m.swapTotalKb > 0 ? ` · swap ${formatBytes(swapUsed * 1024)}` : ''
          }`}
        />
        <MetricCard
          icon={<Icons.chart size={14} />}
          title="平均负载 (1/5/15 分钟)"
          value={m.load1.toFixed(2)}
          color={usageColor(loadPercent)}
          percent={Math.min(100, loadPercent)}
          sub={`${m.load1.toFixed(2)} / ${m.load5.toFixed(2)} / ${m.load15.toFixed(2)} · ${m.procCount} 个进程`}
        />
        <MetricCard
          icon={<Icons.net size={14} />}
          title="网络吞吐"
          value={formatKbps(netTotal)}
          color="#0891b2"
          percent={0}
          sub={`↓ ${formatKbps(m.netRate.rxBytesPerSec)}　↑ ${formatKbps(m.netRate.txBytesPerSec)}`}
        />
      </div>

      <div className="section">
        <div className="section-head">
          <Icons.chart size={14} />
          <span>实时趋势</span>
          <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>
            每 {(3000 / 1000).toFixed(0)} 秒采样一次，保留最近 {history.length} 个点
          </span>
          <span className="spacer" />
          <Btn size="sm" icon={<Icons.refresh size={13} />} onClick={() => void poll(profile.id)}>
            立即刷新
          </Btn>
        </div>
        <div className="section-body">
          {chartData.length < 2 ? (
            <div className="muted" style={{ padding: '12px 4px' }}>
              正在累积采样点，几秒后曲线出现…
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={190}>
                <LineChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f6" />
                  <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#949cb2' }} interval="preserveStartEnd" minTickGap={44} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#949cb2' }} unit="%" />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e8f1' }} />
                  <Legend wrapperStyle={{ fontSize: 11.5 }} />
                  <Line type="monotone" dataKey="CPU" stroke="#6366f1" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="内存" stroke="#8b5cf6" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -6 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f6" />
                  <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#949cb2' }} interval="preserveStartEnd" minTickGap={44} />
                  <YAxis tick={{ fontSize: 11, fill: '#949cb2' }} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e8f1' }} />
                  <Legend wrapperStyle={{ fontSize: 11.5 }} />
                  <Line type="monotone" dataKey="↓ 下载 KB/s" stroke="#0891b2" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="↑ 上传 KB/s" stroke="#d97706" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <Icons.disk size={14} />
          <span>磁盘使用</span>
          <span className="spacer" />
          <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>
            共 {m.disks.length} 个分区
          </span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>挂载点</th>
              <th>设备</th>
              <th style={{ width: 180 }}>使用率</th>
              <th className="num">已用 / 总量</th>
              <th className="num">可用</th>
            </tr>
          </thead>
          <tbody>
            {m.disks.map((d) => (
              <tr key={d.mount + d.filesystem}>
                <td className="mono">{d.mount}</td>
                <td className="mono muted">{d.filesystem}</td>
                <td>
                  <div className="center">
                    <span className="meter" style={{ flex: 1, marginTop: 0 }}>
                      <i style={{ width: `${d.usePercent}%`, background: usageColor(d.usePercent) }} />
                    </span>
                    <span className="mono" style={{ width: 42, textAlign: 'right' }}>
                      {d.usePercent}%
                    </span>
                  </div>
                </td>
                <td className="num">
                  {formatBytes(d.usedKb * 1024)} / {formatBytes(d.sizeKb * 1024)}
                </td>
                <td className="num">{formatBytes(d.availKb * 1024)}</td>
              </tr>
            ))}
            {m.disks.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 14 }}>
                  未采集到磁盘信息（部分容器环境无 df 输出）
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="section">
        <div className="section-head">
          <Icons.terminal size={14} />
          <span>进程 Top {rows.length}</span>
          <span className="spacer" />
          <div className="row" style={{ gap: 4 }}>
            <Btn size="sm" variant={procSort === 'cpu' ? 'primary' : 'default'} onClick={() => setProcSort('cpu')}>
              按 CPU
            </Btn>
            <Btn size="sm" variant={procSort === 'mem' ? 'primary' : 'default'} onClick={() => setProcSort('mem')}>
              按内存
            </Btn>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 76 }}>PID</th>
              <th style={{ width: 108 }}>用户</th>
              <th style={{ width: 68 }} className="num">
                CPU
              </th>
              <th style={{ width: 68 }} className="num">
                内存
              </th>
              <th>命令</th>
              <th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.pid}-${p.command}`}>
                <td className="mono">{p.pid}</td>
                <td className="mono muted">{p.user}</td>
                <td className="num" style={{ color: p.cpu >= 50 ? '#e11d48' : undefined }}>
                  {p.cpu.toFixed(1)}%
                </td>
                <td className="num">{p.mem.toFixed(1)}%</td>
                <td className="mono" style={{ maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.command}>
                  {p.command}
                </td>
                <td>
                  <Btn size="sm" variant="ghost" onClick={() => setKillTarget(p)} title="结束该进程">
                    结束
                  </Btn>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 14 }}>
                  未采集到进程信息
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {info ? (
        <div className="section">
          <div className="section-head">
            <Icons.info size={14} />
            <span>系统信息</span>
          </div>
          <div className="section-body">
            <div className="grid-2">
              <InfoRow k="主机名" v={info.hostname} />
              <InfoRow k="操作系统" v={info.os} />
              <InfoRow k="内核版本" v={info.kernel} />
              <InfoRow k="CPU 架构" v={info.arch} />
              <InfoRow k="CPU 型号" v={info.cpuModel} />
              <InfoRow k="运行时长" v={formatUptime(info.uptimeSec)} />
              <InfoRow k="家目录" v={info.home} />
              <InfoRow k="Docker" v={info.dockerVersion ?? '未安装 / 不可用'} />
            </div>
          </div>
        </div>
      ) : null}

      {killTarget ? (
        <Confirm
          title="结束进程"
          danger
          confirmText="发送 SIGTERM"
          message={
            <>
              确定结束进程 <b>{killTarget.pid}</b>（{killTarget.command.slice(0, 60)}）吗？
              <br />
              <span className="muted">
                将先发送 SIGTERM 让进程优雅退出；若是系统关键进程，可能导致服务中断，请确认后再操作。
              </span>
            </>
          }
          onCancel={() => setKillTarget(null)}
          onConfirm={async () => {
            const t = killTarget
            setKillTarget(null)
            try {
              const r = await window.api.sys.kill(profile.id, t.pid)
              if (!r.ok) throw new Error(r.error)
              toast('success', `已向 PID ${t.pid} 发送 SIGTERM`)
              void poll(profile.id)
            } catch (e) {
              toast('error', '结束进程失败', (e as Error).message)
            }
          }}
        />
      ) : null}
    </div>
  )
}

function MetricCard({
  icon,
  title,
  value,
  color,
  percent,
  sub
}: {
  icon: React.ReactNode
  title: string
  value: string
  color: string
  percent: number
  sub: string
}): React.ReactElement {
  return (
    <div className="card">
      <div className="card-title">
        {icon}
        {title}
      </div>
      <div className="card-value" style={{ color }}>
        {value}
      </div>
      {percent > 0 ? (
        <div className="meter">
          <i style={{ width: `${Math.min(100, percent)}%`, background: color }} />
        </div>
      ) : null}
      <div className="card-sub">{sub}</div>
    </div>
  )
}

function InfoRow({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div className={cls('row')} style={{ padding: '5px 0', borderBottom: '1px solid #f2f4f9' }}>
      <span className="muted" style={{ width: 84, flex: '0 0 auto' }}>
        {k}
      </span>
      <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
        {v}
      </span>
    </div>
  )
}

function trimCpu(model: string): string {
  return (model || '未知 CPU').replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').trim().slice(0, 42)
}
