import { useState, type FormEvent, type ReactNode } from 'react'
import { api, errorText, setCsrf } from '../api'
import type { SessionView } from '../types'
import { Button, Field, Input } from '../components/ui'

export default function Login({
  initialized,
  onAuthed,
}: {
  initialized: boolean
  onAuthed: () => Promise<void>
}): ReactNode {
  const mode: 'login' | 'setup' = initialized ? 'login' : 'setup'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const path = mode === 'setup' ? '/api/admin/v1/setup' : '/api/admin/v1/login'
      const data = await api<{ session: SessionView }>(path, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setCsrf(data.session.csrfToken)
      await onAuthed()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-bold text-slate-800">Pordo 内容源服务</h1>
          <p className="mt-1 text-xs text-slate-400">
            {mode === 'setup' ? '首次使用：创建管理员账号' : '管理员登录'}
          </p>
        </div>
        <Field label="用户名">
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field
          label="密码"
          hint={mode === 'setup' ? '至少 8 位' : undefined}
        >
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            minLength={mode === 'setup' ? 8 : undefined}
            required
          />
        </Field>
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
          {busy ? '请稍候…' : mode === 'setup' ? '创建并登录' : '登录'}
        </Button>
      </form>
    </div>
  )
}
