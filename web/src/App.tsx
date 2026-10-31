import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { api, clearCsrf, setCsrf } from './api'
import type { SessionData } from './types'
import { Spinner } from './components/ui'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Sources from './pages/Sources'
import ContentTest from './pages/ContentTest'
import Jobs from './pages/Jobs'
import Logs from './pages/Logs'
import Cache from './pages/Cache'
import Tokens from './pages/Tokens'

const navItems: Array<{ to: string; label: string; end?: boolean }> = [
  { to: '/', label: '概览', end: true },
  { to: '/sources', label: '内容源' },
  { to: '/test', label: '内容测试' },
  { to: '/jobs', label: '任务' },
  { to: '/logs', label: '日志' },
  { to: '/cache', label: '缓存' },
  { to: '/tokens', label: '设备令牌' },
]

export default function App(): ReactNode {
  const [loading, setLoading] = useState(true)
  const [initialized, setInitialized] = useState(true)
  const [authed, setAuthed] = useState(false)
  const [username, setUsername] = useState('')

  const bootstrap = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<SessionData>('/api/admin/v1/session')
      setInitialized(data.initialized)
      if (data.session) {
        setCsrf(data.session.csrfToken)
        setUsername(data.session.username)
        setAuthed(true)
      } else {
        clearCsrf()
        setAuthed(false)
      }
    } catch {
      setAuthed(false)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const logout = async (): Promise<void> => {
    try {
      await api('/api/admin/v1/logout', { method: 'POST' })
    } catch {
      // Session already gone; fall through to the signed-out state.
    }
    clearCsrf()
    setAuthed(false)
    await bootstrap()
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (!authed) {
    return <Login initialized={initialized} onAuthed={bootstrap} />
  }

  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="px-4 py-4">
            <p className="text-base font-bold text-slate-800">Pordo 服务</p>
            <p className="text-xs text-slate-400">内容源管理 · {username}</p>
          </div>
          <nav className="flex-1 space-y-1 px-2">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-slate-100 p-3">
            <button
              onClick={() => void logout()}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50 hover:text-red-600"
            >
              退出登录
            </button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 p-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/test" element={<ContentTest />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/cache" element={<Cache />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route path="*" element={<p className="text-sm text-slate-400">页面不存在</p>} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
