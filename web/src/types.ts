/** View models mirroring contracts/openapi.yaml components. */

export interface SessionView {
  username: string
  csrfToken: string
  expiresAt: string
}

export interface SessionData {
  initialized: boolean
  session: SessionView | null
}

export interface AccountState {
  phase: 'guest' | 'pending' | 'signing_in' | 'signed_in' | 'error'
  nickname: string
  message: string
  limit: number | null
  usage: number | null
}

export interface AccountAdminView {
  configured: boolean
  username: string
  hasPassword: boolean
  autoLogin: boolean
  state: AccountState | null
}

export interface ConfigSchemaField {
  key: string
  label: string
  type: 'string' | 'password' | 'boolean'
  required?: boolean
  placeholder?: string
}

export interface SourceAdminView {
  id: string
  displayName: string
  kind: 'comic' | 'video'
  enabled: boolean
  priority: number
  proxy: string | null
  timeoutMs: number
  concurrency: number
  config: Record<string, unknown>
  configSchema: ConfigSchemaField[]
  account: AccountAdminView | null
}

export interface OverviewData {
  uptimeSeconds: number
  rssBytes: number
  heapUsedBytes: number
  sources: Array<{
    id: string
    displayName: string
    enabled: boolean
    accountPhase: string | null
    quota: { limit: number | null; usage: number | null } | null
  }>
  requests24h: { total: number; failed: number }
  activeTokens: number
  resolvedComics: number
  runningJobs: number
}

export interface ComicView {
  comicId: string
  provider: string
  siteId: string
  siteName: string
  title: string
  author: string
  description: string
  status: string
  coverUrl: string
  detailUrl: string
}

export interface ChapterView {
  id: string
  key: string
  name: string
  order: number
  kind: 'chapter' | 'volume'
}

export interface PageView {
  index: number
  url: string
}

export interface ImagePolicy {
  concurrency: number
  ahead: number
  behind: number
  retainCacheOnRefresh: boolean
}

export interface SearchGroup {
  site: { siteId: string; siteName: string; provider: string }
  books: ComicView[]
  error: string | null
}

export interface UpdateResult {
  comicId: string
  provider: string
  siteId: string
  detailUrl: string
  status: 'ok' | 'error'
  chapterCount?: number
  newChapters?: number
  latestChapterKey?: string
  error?: string
}

export interface JobView {
  jobId: string
  kind: string
  status: 'pending' | 'running' | 'done' | 'partial' | 'failed'
  total: number
  completed: number
  createdAt: string
  updatedAt: string
  results?: UpdateResult[]
  error?: string | null
}

export interface LogRecord {
  id: number
  requestId: string
  kind: 'api' | 'upstream' | 'job'
  sourceId: string | null
  op: string
  status: number | null
  errorCode: string | null
  durationMs: number
  detail: string | null
  createdAt: string
}

export interface TokenRecord {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface ImageAccess { url: string; headers: Record<string, string>; expiresAt: number | null }
