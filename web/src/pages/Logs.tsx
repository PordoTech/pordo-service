import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorText } from '../api'
import type { LogRecord } from '../types'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, formatTime } from '../components/ui'

export default function Logs(): ReactNode {
  const [logs, setLogs] = useState<LogRecord[] | null>(null)
  const [kind, setKind] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (kind) params.set('kind', kind)
      if (sourceId.trim()) params.set('sourceId', sourceId.trim())
      const data = await api<{ logs: LogRecord[] }>(`/api/admin/v1/logs?${params.toString()}`)
      setLogs(data.logs)
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [kind, sourceId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">日志</h1>
      {error && <ErrorNote error={error} />}
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="类型">
            <Select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">全部</option>
              <option value="api">api</option>
              <option value="upstream">upstream</option>
              <option value="job">job</option>
            </Select>
          </Field>
          <Field label="源 ID">
            <Input
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              placeholder="komiic"
            />
          </Field>
          <Button variant="primary" onClick={() => void load()}>
            查询
          </Button>
        </div>
        {!logs ? (
          <Empty>加载中…</Empty>
        ) : logs.length === 0 ? (
          <Empty>暂无日志</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-slate-400">
                  <th className="py-2 pr-3 font-medium">时间</th>
                  <th className="py-2 pr-3 font-medium">类型</th>
                  <th className="py-2 pr-3 font-medium">源</th>
                  <th className="py-2 pr-3 font-medium">操作</th>
                  <th className="py-2 pr-3 font-medium">状态</th>
                  <th className="py-2 pr-3 font-medium">错误码</th>
                  <th className="py-2 pr-3 font-medium">耗时</th>
                  <th className="py-2 pr-3 font-medium">requestId</th>
                  <th className="py-2 font-medium">详情</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-500">
                      {formatTime(log.createdAt)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={log.kind === 'upstream' ? 'indigo' : log.kind === 'job' ? 'amber' : 'slate'}>
                        {log.kind}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600">{log.sourceId ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-slate-600">{log.op}</td>
                    <td className="py-1.5 pr-3">
                      {log.status === null ? (
                        '—'
                      ) : (
                        <Badge tone={log.status >= 400 ? 'red' : 'green'}>{log.status}</Badge>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-red-600">{log.errorCode ?? ''}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{log.durationMs}ms</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-400">
                      {log.requestId.slice(0, 8)}
                    </td>
                    <td className="max-w-72 truncate py-1.5 text-slate-400" title={log.detail ?? ''}>
                      {log.detail ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
