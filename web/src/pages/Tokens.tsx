import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorText } from '../api'
import type { TokenRecord } from '../types'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, formatTime } from '../components/ui'

interface CreatedToken extends TokenRecord {
  token: string
}

export default function Tokens(): ReactNode {
  const [tokens, setTokens] = useState<TokenRecord[] | null>(null)
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api<{ tokens: TokenRecord[] }>('/api/admin/v1/tokens')
      setTokens(data.tokens)
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const token = await api<CreatedToken>('/api/admin/v1/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      })
      setCreated(token)
      setCopied(false)
      setName('')
      await load()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      await load()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const copyToken = async (): Promise<void> => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.token)
      setCopied(true)
    } catch {
      // Clipboard unavailable; the user can still select the text manually.
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">设备令牌</h1>
      {error && <ErrorNote error={error} />}

      {created && (
        <Card title="新令牌（明文仅此一次，请立即保存）">
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-sm text-amber-800">
              {created.token}
            </code>
            <Button variant="primary" onClick={() => void copyToken()}>
              {copied ? '已复制' : '复制'}
            </Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>
              关闭
            </Button>
          </div>
        </Card>
      )}

      <Card title="创建令牌">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-52 flex-1">
            <Field label="名称（设备备注）">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="MacBook 桌面端"
                maxLength={64}
              />
            </Field>
          </div>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            创建
          </Button>
        </div>
      </Card>

      <Card title={`令牌列表（${tokens?.length ?? 0}）`}>
        {!tokens ? (
          <Empty>加载中…</Empty>
        ) : tokens.length === 0 ? (
          <Empty>暂无令牌</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="py-2 pr-3 font-medium">名称</th>
                <th className="py-2 pr-3 font-medium">前缀</th>
                <th className="py-2 pr-3 font-medium">作用域</th>
                <th className="py-2 pr-3 font-medium">创建</th>
                <th className="py-2 pr-3 font-medium">最近使用</th>
                <th className="py-2 pr-3 font-medium">状态</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id} className="border-b border-slate-50 last:border-0">
                  <td className="py-2 pr-3 font-medium text-slate-700">{token.name}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-500">{token.prefix}…</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">{token.scopes.join(', ')}</td>
                  <td className="py-2 pr-3 text-xs text-slate-400">{formatTime(token.createdAt)}</td>
                  <td className="py-2 pr-3 text-xs text-slate-400">{formatTime(token.lastUsedAt)}</td>
                  <td className="py-2 pr-3">
                    {token.revokedAt ? (
                      <Badge tone="red">已吊销</Badge>
                    ) : (
                      <Badge tone="green">活动</Badge>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-2">
                      {!token.revokedAt && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api(`/api/admin/v1/tokens/${token.id}/revoke`, { method: 'POST' }),
                            )
                          }
                        >
                          吊销
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() =>
                          void act(() => api(`/api/admin/v1/tokens/${token.id}`, { method: 'DELETE' }))
                        }
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
