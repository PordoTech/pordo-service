import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorText } from '../api'
import type { OverviewData } from '../types'
import { Badge, Card, ErrorNote, formatBytes, formatDuration } from '../components/ui'

const Stat = ({ label, value }: { label: string; value: ReactNode }): ReactNode => (
  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    <p className="text-xs text-slate-400">{label}</p>
    <p className="mt-1 text-xl font-semibold text-slate-800">{value}</p>
  </div>
)

export default function Overview(): ReactNode {
  const [data, setData] = useState<OverviewData | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api<OverviewData>('/api/admin/v1/overview'))
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  if (error) return <ErrorNote error={error} />
  if (!data) return null

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">概览</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="运行时长" value={formatDuration(data.uptimeSeconds)} />
        <Stat label="内存 RSS" value={formatBytes(data.rssBytes)} />
        <Stat label="24h 请求" value={`${data.requests24h.total}（失败 ${data.requests24h.failed}）`} />
        <Stat label="活动令牌" value={data.activeTokens} />
        <Stat label="已解析书籍" value={data.resolvedComics} />
        <Stat label="进行中任务" value={data.runningJobs} />
      </div>
      <Card title="内容源状态">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
              <th className="py-2 pr-3 font-medium">源</th>
              <th className="py-2 pr-3 font-medium">启用</th>
              <th className="py-2 pr-3 font-medium">账号状态</th>
              <th className="py-2 font-medium">图量配额（用/限）</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((source) => (
              <tr key={source.id} className="border-b border-slate-50 last:border-0">
                <td className="py-2 pr-3">
                  <span className="font-medium text-slate-700">{source.displayName}</span>
                  <span className="ml-2 text-xs text-slate-400">{source.id}</span>
                </td>
                <td className="py-2 pr-3">
                  <Badge tone={source.enabled ? 'green' : 'slate'}>
                    {source.enabled ? '启用' : '停用'}
                  </Badge>
                </td>
                <td className="py-2 pr-3">
                  {source.accountPhase ? (
                    <Badge
                      tone={
                        source.accountPhase === 'signed_in'
                          ? 'green'
                          : source.accountPhase === 'error'
                            ? 'red'
                            : 'amber'
                      }
                    >
                      {source.accountPhase}
                    </Badge>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="py-2 text-slate-600">
                  {source.quota && source.quota.limit !== null
                    ? `${source.quota.usage ?? 0} / ${source.quota.limit}`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
