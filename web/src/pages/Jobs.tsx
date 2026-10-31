import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorText } from '../api'
import type { JobView } from '../types'
import { Badge, Button, Card, Empty, ErrorNote, formatTime } from '../components/ui'

const statusTone = (status: JobView['status']): 'green' | 'red' | 'amber' | 'indigo' | 'slate' => {
  if (status === 'done') return 'green'
  if (status === 'failed') return 'red'
  if (status === 'partial') return 'amber'
  if (status === 'running') return 'indigo'
  return 'slate'
}

export default function Jobs(): ReactNode {
  const [jobs, setJobs] = useState<JobView[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api<{ jobs: JobView[] }>('/api/admin/v1/jobs?limit=50')
      setJobs(data.jobs)
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-800">任务</h1>
        <Button onClick={() => void load()}>刷新</Button>
      </div>
      {error && <ErrorNote error={error} />}
      <Card>
        {!jobs ? (
          <Empty>加载中…</Empty>
        ) : jobs.length === 0 ? (
          <Empty>暂无任务；设备端 POST /api/v1/comics/updates/check 会在此出现</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="py-2 pr-3 font-medium">任务</th>
                <th className="py-2 pr-3 font-medium">类型</th>
                <th className="py-2 pr-3 font-medium">状态</th>
                <th className="py-2 pr-3 font-medium">进度</th>
                <th className="py-2 pr-3 font-medium">创建</th>
                <th className="py-2 font-medium">更新</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow
                  key={job.jobId}
                  job={job}
                  expanded={expanded === job.jobId}
                  onToggle={() => setExpanded(expanded === job.jobId ? null : job.jobId)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function JobRow({
  job,
  expanded,
  onToggle,
}: {
  job: JobView
  expanded: boolean
  onToggle: () => void
}): ReactNode {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50"
        onClick={onToggle}
      >
        <td className="py-2 pr-3 font-mono text-xs text-slate-500">{job.jobId.slice(0, 8)}</td>
        <td className="py-2 pr-3 text-slate-600">{job.kind}</td>
        <td className="py-2 pr-3">
          <Badge tone={statusTone(job.status)}>{job.status}</Badge>
        </td>
        <td className="py-2 pr-3 text-slate-600">
          {job.completed}/{job.total}
        </td>
        <td className="py-2 pr-3 text-xs text-slate-400">{formatTime(job.createdAt)}</td>
        <td className="py-2 text-xs text-slate-400">{formatTime(job.updatedAt)}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-slate-50">
          <td colSpan={6} className="bg-slate-50/60 px-3 py-2">
            {job.error && <p className="mb-1 text-xs text-red-600">{job.error}</p>}
            {!job.results || job.results.length === 0 ? (
              <p className="text-xs text-slate-400">无结果明细</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {job.results.map((result, index) => (
                    <tr key={`${result.comicId}-${index}`} className="border-b border-slate-100 last:border-0">
                      <td className="py-1 pr-2">
                        <Badge tone={result.status === 'ok' ? 'green' : 'red'}>{result.status}</Badge>
                      </td>
                      <td className="py-1 pr-2 text-slate-600">
                        {result.provider}:{result.siteId}
                      </td>
                      <td className="max-w-64 truncate py-1 pr-2 text-slate-400">{result.detailUrl}</td>
                      <td className="py-1 pr-2 text-slate-600">
                        {result.status === 'ok'
                          ? `章节 ${result.chapterCount ?? '—'}（新增 ${result.newChapters ?? 0}）`
                          : result.error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
