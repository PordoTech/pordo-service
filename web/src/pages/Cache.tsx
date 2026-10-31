import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorText } from '../api'
import type { CacheSettings, CacheStats } from '../types'
import { Button, Card, ErrorNote, Field, Input, formatBytes } from '../components/ui'

interface CacheData {
  settings: CacheSettings
  stats: CacheStats
}

export default function Cache(): ReactNode {
  const [data, setData] = useState<CacheData | null>(null)
  const [maxBytes, setMaxBytes] = useState('')
  const [ttlSeconds, setTtlSeconds] = useState('')
  const [clearSource, setClearSource] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const loaded = await api<CacheData>('/api/admin/v1/cache')
      setData(loaded)
      setMaxBytes(String(loaded.settings.maxBytes))
      setTtlSeconds(String(loaded.settings.ttlSeconds))
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: () => Promise<CacheData | { removed: number; stats: CacheStats }>, message: string): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(message)
      await load()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">图片缓存</h1>
      {error && <ErrorNote error={error} />}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="当前状态">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-400">条目数</dt>
              <dd className="font-medium text-slate-700">{data?.stats.entries ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">占用空间</dt>
              <dd className="font-medium text-slate-700">{formatBytes(data?.stats.bytes)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">命中次数</dt>
              <dd className="font-medium text-slate-700">{data?.stats.hits ?? '—'}</dd>
            </div>
          </dl>
        </Card>

        <Card title="设置">
          <div className="space-y-3">
            <Field label="容量上限 maxBytes（0-2147483647）">
              <Input
                type="number"
                min={0}
                max={2147483647}
                value={maxBytes}
                onChange={(event) => setMaxBytes(event.target.value)}
              />
            </Field>
            <Field label="TTL 秒（≥60）">
              <Input
                type="number"
                min={60}
                value={ttlSeconds}
                onChange={(event) => setTtlSeconds(event.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    api<CacheData>('/api/admin/v1/cache', {
                      method: 'PUT',
                      body: JSON.stringify({
                        maxBytes: Number(maxBytes),
                        ttlSeconds: Number(ttlSeconds),
                      }),
                    }),
                  '缓存设置已更新',
                )
              }
            >
              保存设置
            </Button>
          </div>
        </Card>

        <Card title="清理">
          <div className="space-y-3">
            <Field label="仅清理指定源（留空清理全部）">
              <Input
                value={clearSource}
                onChange={(event) => setClearSource(event.target.value)}
                placeholder="komiic"
              />
            </Field>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    api('/api/admin/v1/cache/clear', {
                      method: 'POST',
                      body: JSON.stringify(clearSource.trim() ? { sourceId: clearSource.trim() } : {}),
                    }),
                  '缓存已清理',
                )
              }
            >
              清理缓存
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}
