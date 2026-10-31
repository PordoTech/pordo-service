import { CookieJar } from 'tough-cookie'
import { ApiError } from '../../../shared/errors'
import { headerValue, readBodyLimited, readJsonLimited, sendUpstream } from '../../../shared/http'
import type { AccountState } from '../types'
import { nowSeconds } from '../../../shared/time'

/**
 * Komiic account session, migrated 1:1 from the client's
 * crates/pordo-core/src/comics/source/komiic/auth.rs:
 * - single-flight login behind a gate (no login loops)
 * - session epoch so stale requests cannot pollute a refreshed session
 * - refresh-before-password-login, with password fallback only when the
 *   server acknowledges refresh but reports a guest account
 * - terminal vs retryable auth failures with backoff (retry_after)
 * - quota: 402 / QUOTA_EXCEEDED block image fetches until resetInSeconds,
 *   metadata/search stay usable
 * - cookies are memory-only per session; persistence is owned by the DB
 */
export interface KomiicCredentials {
  username: string // email
  password: string // '' = no password stored
  autoLogin: boolean
}

interface AuthFailure {
  message: string
  terminal: boolean
  delay: number
  unauthorized: boolean
}

const authFailure = (
  message: string,
  terminal: boolean,
  delay = 0,
  unauthorized = false,
): AuthFailure => ({ message, terminal, delay, unauthorized })

const isAuthFailure = (error: unknown): error is AuthFailure =>
  typeof error === 'object' && error !== null && '__authFailure' in error

const wrapAuthFailure = (failure: AuthFailure): AuthFailure & { __authFailure: true } => ({
  ...failure,
  __authFailure: true as const,
})

type Json = Record<string, unknown>

const ACCOUNT_QUERY = {
  operationName: 'PordoAccount',
  query:
    'query PordoAccount { account { id nickname } getImageLimit { limit usage resetInSeconds } }',
  variables: {},
}

export class KomiicSession {
  readonly jar = new CookieJar()
  private state: AccountState
  private epochValue = 0
  private refreshAt = 0
  private retryAfter = 0
  private terminal = false
  private manualLoginDone = false
  blockedUntil = 0
  private quotaResetAt = 0
  private gate: Promise<void> = Promise.resolve()

  constructor(
    readonly base: string,
    private credentials: KomiicCredentials,
    private readonly ctxDefaults: { proxy?: string | null; timeoutMs: number },
  ) {
    const enabled = credentials.autoLogin && credentials.username.includes('@')
    this.state = enabled
      ? {
          phase: 'pending',
          nickname: '',
          message: '等待自动登录 / Waiting to sign in',
          limit: null,
          usage: null,
        }
      : { phase: 'guest', nickname: '', message: '游客 / Guest', limit: null, usage: null }
  }

  configured(): boolean {
    return (
      (this.credentials.autoLogin && this.credentials.username.includes('@')) ||
      this.manualLoginDone
    )
  }

  status(): AccountState {
    return { ...this.state }
  }

  epoch(): number {
    return this.epochValue
  }

  sameCredentials(credentials: KomiicCredentials): boolean {
    return (
      this.credentials.username === credentials.username &&
      this.credentials.password === credentials.password &&
      this.credentials.autoLogin === credentials.autoLogin
    )
  }

  get email(): string {
    return this.credentials.username
  }

  private ready(): boolean {
    return this.state.phase === 'signed_in' && nowSeconds() < this.refreshAt
  }

  /** Single-flight: concurrent callers wait on the same login gate. */
  async ensureReady(manual: boolean): Promise<void> {
    if (manual) {
      if (!this.credentials.username.includes('@') || !this.credentials.password) {
        throw new ApiError(
          400,
          'ACCOUNT_NOT_CONFIGURED',
          '请填写 Komiic 邮箱和密码 / Enter Komiic credentials',
        )
      }
      this.manualLoginDone = true
    }
    if (!this.configured()) return
    if (this.ready()) return
    await this.withGate(async () => {
      if (this.ready()) return
      this.checkRetry(manual)
      await this.authenticate(this.epochValue !== 0)
    })
  }

  private async withGate<T>(task: () => Promise<T>): Promise<T> {
    // Serialize auth mutations; waiters queue on the current gate.
    const previous = this.gate
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
    }
  }

  private checkRetry(manual: boolean): void {
    if (!manual && this.terminal) {
      throw new ApiError(401, 'UPSTREAM_UNAUTHORIZED', this.state.message, false)
    }
    if (!manual && nowSeconds() < this.retryAfter) {
      throw new ApiError(
        429,
        'UPSTREAM_UNAUTHORIZED',
        this.state.message,
        true,
        Math.max(1, this.retryAfter - nowSeconds()),
      )
    }
  }

  async recover(epoch: number): Promise<void> {
    await this.withGate(async () => {
      if (this.epochValue !== epoch && this.state.phase === 'signed_in') return
      this.checkRetry(false)
      await this.authenticate(true)
    })
  }

  reject(epoch: number): void {
    if (this.epochValue === epoch) {
      this.terminal = true
      this.setPhase('error', 'Komiic 会话无效，请重新登录 / Sign in again')
    }
  }

  private setPhase(phase: AccountState['phase'], message: string): void {
    this.state = { ...this.state, phase, message }
  }

  private async authenticate(refresh: boolean): Promise<void> {
    this.setPhase('signing_in', '正在登录 Komiic… / Signing in…')
    try {
      await this.authenticateInner(refresh)
      this.terminal = false
      this.retryAfter = 0
    } catch (error) {
      const failure = isAuthFailure(error) ? error : null
      this.terminal = failure?.terminal ?? false
      this.retryAfter = nowSeconds() + (failure?.delay ?? 60)
      const message = failure?.message ?? (error instanceof Error ? error.message : String(error))
      this.setPhase('error', message)
      throw new ApiError(
        failure?.terminal === false ? 429 : 401,
        'ACCOUNT_LOGIN_FAILED',
        message,
        failure ? !failure.terminal : true,
        failure && !failure.terminal ? Math.max(1, this.retryAfter - nowSeconds()) : undefined,
      )
    }
  }

  private async authenticateInner(refresh: boolean): Promise<void> {
    let refreshed = false
    if (refresh) {
      const response = await this.post('/auth/refresh')
      if (response.status >= 200 && response.status < 300) {
        refreshed = true
        response.body.destroy()
      } else if (![400, 401, 403].includes(response.status)) {
        throw await this.httpFailure(response.status, response.headers, response)
      } else {
        response.body.destroy()
      }
    }
    if (!refreshed) {
      const response = await this.post(
        '/api/login',
        JSON.stringify({
          email: this.credentials.username,
          password: this.credentials.password,
        }),
      )
      if (response.status < 200 || response.status >= 300) {
        throw await this.httpFailure(response.status, response.headers, response)
      }
      response.body.destroy()
    }
    let account = await this.account()
    // Some servers acknowledge refresh but report a guest account afterwards.
    // Only an explicit authentication failure permits another password login;
    // network failures must respect backoff instead.
    const fallback =
      refreshed &&
      (account.ok
        ? !hasAccount(account.value)
        : isAuthFailure(account.error) && account.error.unauthorized)
    if (fallback) {
      const response = await this.post(
        '/api/login',
        JSON.stringify({
          email: this.credentials.username,
          password: this.credentials.password,
        }),
      )
      if (response.status < 200 || response.status >= 300) {
        throw await this.httpFailure(response.status, response.headers, response)
      }
      response.body.destroy()
      account = await this.account()
    }
    if (!account.ok) throw account.error
    if (!hasAccount(account.value)) {
      throw wrapAuthFailure(
        authFailure('登录未成功，请检查账号 / Account verification failed', true),
      )
    }
    const data = (account.value as Json).data as Json | undefined
    const accountData = data?.account as Json | undefined
    this.state = {
      phase: 'signed_in',
      nickname: typeof accountData?.nickname === 'string' ? accountData.nickname : '',
      message: '已登录 / Signed in',
      limit: null,
      usage: null,
    }
    this.blockedUntil = 0
    this.quotaResetAt = 0
    this.quotaUpdate((data?.getImageLimit as Json | undefined) ?? {})
    this.refreshAt = Math.max(
      (this.expiry() ?? nowSeconds() + 900) - 120,
      nowSeconds() + 30,
    )
    this.epochValue += 1
  }

  private async post(
    path: string,
    jsonBody?: string,
  ): Promise<Awaited<ReturnType<typeof sendUpstream>>> {
    const cookie = await this.jar.getCookieString(this.base)
    const response = await sendUpstream({
      method: 'POST',
      url: `${this.base}${path}`,
      jsonBody,
      headers: {
        origin: this.base,
        referer: `${this.base}/`,
        ...(cookie ? { cookie } : {}),
      },
      proxy: this.ctxDefaults.proxy,
      timeoutMs: this.ctxDefaults.timeoutMs,
    })
    await this.storeCookies(response)
    return response
  }

  private async storeCookies(response: {
    headers: Record<string, string | string[]>
  }): Promise<void> {
    const raw = response.headers['set-cookie']
    const cookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    for (const cookie of cookies) {
      try {
        await this.jar.setCookie(cookie, this.base, { ignoreError: true })
      } catch {
        // Ignore malformed cookies like reqwest does.
      }
    }
  }

  private async account(): Promise<
    | { ok: true; value: unknown; error?: undefined }
    | { ok: false; error: unknown; value?: undefined }
  > {
    try {
      const response = await this.post('/api/query', JSON.stringify(ACCOUNT_QUERY))
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: await this.httpFailure(response.status, response.headers, response) }
      }
      const value = await readJsonLimited(response, 512 * 1024)
      if (unauthorized(value)) {
        return {
          ok: false,
          error: wrapAuthFailure(
            authFailure('Komiic 会话已过期 / Session expired', true, 0, true),
          ),
        }
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /** Unverified JWT expiry is only a refresh hint; account() authenticates. */
  private expiry(): number | null {
    try {
      const cookie = this.jar.getCookieStringSync(this.base)
      const token = cookie
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('komiic-access-token='))
        ?.slice('komiic-access-token='.length)
      if (!token) return null
      const payload = token.split('.')[1]
      if (!payload) return null
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { exp?: number }
      return typeof decoded.exp === 'number' ? decoded.exp : null
    } catch {
      return null
    }
  }

  async logout(): Promise<void> {
    if (this.state.phase !== 'signed_in') return
    const response = await this.post('/auth/logout')
    response.body.destroy()
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(
        502,
        'UPSTREAM_HTTP',
        '本机已退出，服务器退出失败 / Server logout failed',
      )
    }
  }

  quotaCheck(): void {
    if (nowSeconds() < this.blockedUntil) {
      throw new ApiError(
        429,
        'UPSTREAM_QUOTA',
        'Komiic 图片额度已用尽，请稍后重试 / Image quota exhausted; retry later',
        true,
        Math.max(1, this.blockedUntil - nowSeconds()),
      )
    }
  }

  quotaBlock(seconds: number): void {
    this.blockedUntil = Math.max(
      this.blockedUntil,
      nowSeconds() + Math.min(Math.max(seconds, 60), 86400),
    )
  }

  resetSeconds(): number {
    const remaining = this.quotaResetAt - nowSeconds()
    return remaining > 0 ? remaining : 3600
  }

  quotaUpdate(limit: Json | undefined): void {
    if (!limit) return
    const seconds = numberOf(limit.resetInSeconds)
    if (seconds !== null) this.quotaResetAt = nowSeconds() + seconds
    const max = numberOf(limit.limit)
    const usage = numberOf(limit.usage)
    if (max !== null && usage !== null) {
      this.state = { ...this.state, limit: max, usage }
      if (max > 0 && usage >= max) this.quotaBlock(this.resetSeconds())
    }
  }

  private async httpFailure(
    status: number,
    headers: Record<string, string | string[]>,
    response: Awaited<ReturnType<typeof sendUpstream>>,
  ): Promise<AuthFailure & { __authFailure: true }> {
    const retryHeader = headerValue(headers, 'retry-after')
    const parsed = retryHeader ? Number(retryHeader) : NaN
    const delay = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 60, 1), 3600)
    let code: string | undefined
    try {
      const bytes = await readBodyLimited(response, 64 * 1024)
      const value = JSON.parse(bytes.toString('utf8')) as Json
      const errorField = value?.error
      if (typeof errorField === 'string') code = errorField
    } catch {
      // body unreadable; classify by status only
      response.body.destroy()
    }
    let message: string
    let terminal: boolean
    if (code === 'account_not_activated') {
      message = 'Komiic 账号未激活，请先验证邮箱 / Verify your email first'
      terminal = true
    } else if (status === 429) {
      message = 'Komiic 登录过于频繁，请稍后重试 / Sign-in rate limited'
      terminal = false
    } else if (status === 403) {
      message = 'Komiic 登录被拒绝或需要额外验证 / Sign-in blocked; verification may be required'
      terminal = true
    } else if (status === 400 || status === 401) {
      message = 'Komiic 邮箱或密码错误 / Incorrect email or password'
      terminal = true
    } else {
      message = 'Komiic 登录服务暂不可用 / Sign-in service unavailable'
      terminal = false
    }
    response.body.destroy()
    return wrapAuthFailure(authFailure(message, terminal, delay, status === 401))
  }
}

export const hasAccount = (value: unknown): boolean => {
  const data = (value as Json)?.data as Json | undefined
  const account = data?.account as Json | undefined
  const id = account?.id
  return typeof id === 'string' && id !== '' && id !== '0'
}

export const unauthorized = (value: unknown): boolean => {
  const errors = (value as Json)?.errors
  if (!Array.isArray(errors)) return false
  return errors.some((error) => {
    const extensions = (error as Json)?.extensions as Json | undefined
    const code = extensions?.code
    return (
      code === 'UNAUTHENTICATED' || code === 'UNAUTHORIZED' || code === 'AUTHENTICATION_REQUIRED'
    )
  })
}

export const numberOf = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}
