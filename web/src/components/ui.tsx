import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export const Card = ({
  title,
  actions,
  children,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
}): ReactNode => (
  <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
    {(title || actions) && (
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
    )}
    <div className="p-4">{children}</div>
  </section>
)

type ButtonVariant = 'primary' | 'default' | 'danger' | 'ghost'

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300',
  default:
    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:text-red-300',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
}

export const Button = ({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): ReactNode => (
  <button
    {...props}
    className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${buttonStyles[variant]} ${className}`}
  />
)

const fieldStyles =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'

export const Input = ({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>): ReactNode => (
  <input {...props} className={`${fieldStyles} ${className}`} />
)

export const Textarea = ({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode => (
  <textarea {...props} className={`${fieldStyles} font-mono ${className}`} />
)

export const Select = ({
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactNode => (
  <select {...props} className={`${fieldStyles} ${className}`} />
)

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode => (
  <label className="block">
    <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
  </label>
)

export const Badge = ({
  tone = 'slate',
  children,
}: {
  tone?: 'slate' | 'green' | 'red' | 'amber' | 'indigo'
  children: ReactNode
}): ReactNode => {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600',
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
    indigo: 'bg-indigo-100 text-indigo-700',
  }
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

export const ErrorNote = ({ error }: { error: string }): ReactNode =>
  error ? (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  ) : null

export const Spinner = (): ReactNode => (
  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
)

export const Empty = ({ children }: { children: ReactNode }): ReactNode => (
  <p className="py-6 text-center text-sm text-slate-400">{children}</p>
)

export const formatBytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export const formatDuration = (seconds: number): string => {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分`
  return `${minutes}分 ${Math.floor(seconds % 60)}秒`
}

export const formatTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'
