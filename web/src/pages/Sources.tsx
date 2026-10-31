import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorText } from '../api'
import type { AccountState, SourceAdminView } from '../types'
import { Badge, Button, Card, ErrorNote, Field, Input, Textarea } from '../components/ui'

interface AccountResponse {
  account: {
    configured: boolean
    username: string
    hasPassword: boolean
    autoLogin: boolean
  } | null
  state: AccountState | null
}

const phaseTone = (phase: AccountState['phase']): 'green' | 'red' | 'amber' | 'slate' =>
  phase === 'signed_in' ? 'green' : phase === 'error' ? 'red' : phase === 'guest' ? 'slate' : 'amber'

function SourceCard({
  source,
  onChanged,
}: {
  source: SourceAdminView
  onChanged: () => Promise<void>
}): ReactNode {
  const [enabled, setEnabled] = useState(source.enabled)
  const [priority, setPriority] = useState(String(source.priority))
  const [timeoutMs, setTimeoutMs] = useState(String(source.timeoutMs))
  const [concurrency, setConcurrency] = useState(String(source.concurrency))
  const [configText, setConfigText] = useState(JSON.stringify(source.config ?? {}, null, 2))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const usesAccount = source.configSchema.some((field) => field.type === 'password')
  const [account, setAccount] = useState<AccountResponse | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [autoLogin, setAutoLogin] = useState(true)

  const loadAccount = useCallback(async () => {
    if (!usesAccount) return
    try {
      setAccount(await api<AccountResponse>(`/api/admin/v1/sources/${source.id}/account`))
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [source.id, usesAccount])

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  const run = async (action: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(message)
      await Promise.all([onChanged(), loadAccount()])
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const saveRuntime = async (): Promise<void> => {
    let config: Record<string, unknown>
    try {
      config = JSON.parse(configText) as Record<string, unknown>
    } catch {
      setError('配置不是合法 JSON')
      return
    }
    await run(
      () =>
        api(`/api/admin/v1/sources/${source.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            enabled,
            priority: Number(priority),
            timeoutMs: Number(timeoutMs),
            concurrency: Number(concurrency),
            config,
          }),
        }),
      '已保存运行时配置',
    )
  }

  const saveAccount = async (): Promise<void> => {
    await run(
      () =>
        api(`/api/admin/v1/sources/${source.id}/account`, {
          method: 'PUT',
          body: JSON.stringify({
            username,
            ...(password ? { password } : {}),
            autoLogin,
          }),
        }),
      '账号已保存',
    )
    setPassword('')
  }

  const state = account?.state ?? null
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {source.displayName}
          <span className="text-xs font-normal text-slate-400">{source.id}</span>
          <Badge tone={source.enabled ? 'green' : 'slate'}>{source.enabled ? '启用' : '停用'}</Badge>
          {state && <Badge tone={phaseTone(state.phase)}>{state.phase}</Badge>}
        </span>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}
        {notice && <p className="text-sm text-emerald-600">{notice}</p>}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="启用">
            <label className="flex h-8 items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              {enabled ? '开' : '关'}
            </label>
          </Field>
          <Field label="优先级（小者先）">
            <Input
              type="number"
              min={0}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Field>
          <Field label="超时 ms（1000-300000）">
            <Input
              type="number"
              min={1000}
              max={300000}
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(event.target.value)}
            />
          </Field>
          <Field label="并发（1-16）">
            <Input
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" disabled={busy} onClick={() => void saveRuntime()}>
              保存配置
            </Button>
          </div>
        </div>

        <Field label="运行配置 config（JSON；baseUrl 可覆盖上游地址，仅调试用）">
          <Textarea
            rows={3}
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
          />
        </Field>

        {usesAccount && (
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-2 text-xs font-semibold text-slate-500">上游账号</p>
            {account?.account ? (
              <p className="mb-2 text-xs text-slate-500">
                已配置：{account.account.username || '（空）'} · 密码
                {account.account.hasPassword ? '已存' : '未存'} · 自动登录
                {account.account.autoLogin ? '开' : '关'}
              </p>
            ) : (
              <p className="mb-2 text-xs text-slate-400">未配置账号（游客模式）</p>
            )}
            {state && (
              <p className="mb-2 text-xs text-slate-500">
                状态：{state.phase}
                {state.nickname ? ` · ${state.nickname}` : ''}
                {state.limit !== null ? ` · 图量 ${state.usage ?? 0}/${state.limit}` : ''}
                {state.message ? ` · ${state.message}` : ''}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label="邮箱 / 用户名">
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={account?.account?.username ?? 'you@example.com'}
                  autoComplete="off"
                />
              </Field>
              <Field label="密码（留空保持不变）">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="自动登录">
                <label className="flex h-8 items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={autoLogin}
                    onChange={(event) => setAutoLogin(event.target.checked)}
                  />
                  保存后立即登录
                </label>
              </Field>
              <div className="flex flex-wrap items-end gap-2">
                <Button variant="primary" disabled={busy || !username} onClick={() => void saveAccount()}>
                  保存账号
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api(`/api/admin/v1/sources/${source.id}/login`, { method: 'POST' }),
                      '已执行登录',
                    )
                  }
                >
                  手动登录
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api(`/api/admin/v1/sources/${source.id}/logout`, { method: 'POST' }),
                      '已登出',
                    )
                  }
                >
                  登出
                </Button>
                <Button
                  variant="danger"
                  disabled={busy || !account?.account}
                  onClick={() =>
                    void run(
                      () =>
                        api(`/api/admin/v1/sources/${source.id}/account`, { method: 'DELETE' }),
                      '已移除账号',
                    )
                  }
                >
                  移除账号
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

export default function Sources(): ReactNode {
  const [sources, setSources] = useState<SourceAdminView[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api<{ sources: SourceAdminView[] }>('/api/admin/v1/sources')
      setSources(data.sources)
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <ErrorNote error={error} />
  if (!sources) return null

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">内容源</h1>
      {sources.map((source) => (
        <SourceCard key={source.id} source={source} onChanged={load} />
      ))}
    </div>
  )
}
