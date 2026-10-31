import { Container, Service } from 'typedi'
import { prisma } from '../../../shared/prisma'
import { badRequest, forbidden, notFound } from '../../../shared/errors'
import { decryptSecret, digest, encryptSecret } from '../../../shared/crypto'
import { ProviderRegistry } from '../../providers/registry'
import { KomiicProvider } from '../../providers/komiic'
import type { AccountState, ProviderContext } from '../../providers/types'

export interface SourceView {
  id: string
  displayName: string
  kind: 'comic' | 'video'
  enabled: boolean
  priority: number
  capabilities: ReturnType<ProviderRegistry['comic']> extends never ? never : object
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
  configSchema: object[]
  account: AccountAdminView | null
}

export interface AccountAdminView {
  configured: boolean
  username: string // masked
  hasPassword: boolean
  autoLogin: boolean
  state: AccountState | null
}

const maskUsername = (username: string): string => {
  if (!username) return ''
  const at = username.indexOf('@')
  if (at <= 1) return `${username[0]}***`
  return `${username.slice(0, 2)}***${username.slice(at)}`
}

@Service()
export class SourceService {
  private registry = Container.get(ProviderRegistry)

  /** Public list for device clients: enabled sources + honest capabilities. */
  async listEnabled(): Promise<object[]> {
    const rows = await prisma.sourceConfig.findMany({ orderBy: { priority: 'asc' } })
    const out: object[] = []
    for (const row of rows) {
      if (!row.enabled || !this.registry.hasComic(row.id)) continue
      const provider = this.registry.comic(row.id)
      out.push({
        id: row.id,
        displayName: provider.displayName,
        kind: provider.kind,
        capabilities: provider.capabilities(),
        imagePolicy: null,
      })
    }
    return out
  }

  async listAdmin(): Promise<SourceAdminView[]> {
    const rows = await prisma.sourceConfig.findMany({ orderBy: { priority: 'asc' } })
    const accounts = await prisma.sourceAccount.findMany()
    const out: SourceAdminView[] = []
    for (const row of rows) {
      if (!this.registry.hasComic(row.id)) continue
      const provider = this.registry.comic(row.id)
      const account = accounts.find((a) => a.sourceId === row.id)
      out.push({
        id: row.id,
        displayName: provider.displayName,
        kind: 'comic',
        enabled: row.enabled,
        priority: row.priority,
        proxy: row.proxy,
        timeoutMs: row.timeoutMs,
        concurrency: row.concurrency,
        config: this.parseConfig(row.config),
        configSchema: provider.accountSchema(),
        account: account ? await this.accountView(row.id, account) : null,
      })
    }
    return out
  }

  async updateConfig(
    id: string,
    update: {
      enabled?: boolean
      priority?: number
      proxy?: string | null
      timeoutMs?: number
      concurrency?: number
      config?: Record<string, unknown>
    },
  ): Promise<SourceAdminView> {
    const provider = this.registry.comic(id)
    const data: Record<string, unknown> = {}
    if (update.enabled !== undefined) data.enabled = update.enabled
    if (update.priority !== undefined) {
      if (!Number.isInteger(update.priority) || update.priority < 0) {
        throw badRequest('priority must be a non-negative integer')
      }
      data.priority = update.priority
    }
    if (update.proxy !== undefined) data.proxy = this.registry.validateProxy(update.proxy)
    if (update.timeoutMs !== undefined) {
      if (update.timeoutMs < 1000 || update.timeoutMs > 300000) {
        throw badRequest('timeoutMs must be between 1000 and 300000')
      }
      data.timeoutMs = update.timeoutMs
    }
    if (update.concurrency !== undefined) {
      if (update.concurrency < 1 || update.concurrency > 16) {
        throw badRequest('concurrency must be between 1 and 16')
      }
      data.concurrency = update.concurrency
    }
    if (update.config !== undefined) data.config = JSON.stringify(update.config)
    const row = await prisma.sourceConfig.update({ where: { id }, data })
    this.registry.invalidate(id)
    void provider
    const views = await this.listAdmin()
    const view = views.find((v) => v.id === id)
    if (!view) throw notFound('Source missing after update', 'SOURCE_NOT_FOUND')
    return view
  }

  async accountView(
    sourceId: string,
    account: { username: string; passwordEnc: string | null; autoLogin: boolean },
  ): Promise<AccountAdminView> {
    const ctx = await this.registry.context(sourceId)
    const provider = this.registry.comic(sourceId)
    const status = 'status' in provider
      ? await (provider as unknown as KomiicProvider).status(ctx)
      : null
    return {
      configured: true,
      username: maskUsername(account.username),
      hasPassword: account.passwordEnc !== null,
      autoLogin: account.autoLogin,
      state: status,
    }
  }

  /**
   * Save the upstream account. Empty password keeps the stored one;
   * clearPassword=true removes it explicitly.
   */
  async saveAccount(
    sourceId: string,
    input: {
      username: string
      password?: string
      autoLogin?: boolean
      clearPassword?: boolean
    },
  ): Promise<AccountAdminView> {
    const provider = this.registry.comic(sourceId)
    if (!provider.capabilities().accountLogin) {
      throw badRequest(`Source ${sourceId} does not use accounts`)
    }
    const username = input.username.trim()
    if (!username.includes('@')) throw badRequest('请填写邮箱 / Enter the account email')
    const existing = await prisma.sourceAccount.findUnique({ where: { sourceId } })
    const keepPassword =
      !input.clearPassword && (input.password === undefined || input.password === '')
    let passwordEnc: string | null
    if (input.clearPassword) passwordEnc = null
    else if (keepPassword) passwordEnc = existing?.passwordEnc ?? null
    else {
      if (!input.password) throw badRequest('Missing password')
      passwordEnc = encryptSecret(input.password)
    }
    const autoLogin = input.autoLogin ?? existing?.autoLogin ?? true
    const row = await prisma.sourceAccount.upsert({
      where: { sourceId },
      create: {
        sourceId,
        username,
        passwordEnc,
        autoLogin,
        credentialId: existing?.credentialId ?? '',
      },
      update: { username, passwordEnc, autoLogin },
    })
    await this.applyAccount(sourceId)
    return this.accountView(sourceId, row)
  }

  async removeAccount(sourceId: string): Promise<void> {
    const provider = this.registry.comic(sourceId)
    const ctx = await this.registry.context(sourceId)
    if ('logout' in provider) {
      await (provider as unknown as KomiicProvider).logout(ctx).catch(() => {})
    }
    await prisma.sourceAccount.deleteMany({ where: { sourceId } })
    await this.applyAccount(sourceId)
  }

  /** Push stored credentials into the live provider session (startup/save). */
  async applyAccount(sourceId: string): Promise<void> {
    const provider = this.registry.comic(sourceId)
    if (!('configure' in provider)) return
    const account = await prisma.sourceAccount.findUnique({ where: { sourceId } })
    const ctx = await this.registry.context(sourceId)
    const komiic = provider as unknown as KomiicProvider
    if (!account) {
      komiic.configure(ctx, { username: '', password: '', autoLogin: false })
      return
    }
    const password = account.passwordEnc ? decryptSecret(account.passwordEnc) : ''
    komiic.configure(ctx, {
      username: account.username,
      password,
      autoLogin: account.autoLogin,
    })
  }

  async applyAllAccounts(): Promise<void> {
    for (const id of this.registry.comicIds()) {
      await this.applyAccount(id).catch(() => {})
    }
  }

  async accountState(sourceId: string): Promise<AccountState | null> {
    const provider = this.registry.comic(sourceId)
    if (!('status' in provider)) return null
    const ctx = await this.registry.context(sourceId)
    return (provider as unknown as KomiicProvider).status(ctx)
  }

  /**
   * Content-call context: cache/request isolation keyed by the current
   * account fingerprint, so switching accounts never serves the previous
   * account's restricted results.
   */
  async contentContext(
    sourceId: string,
    opts: { siteId?: string; signal?: AbortSignal } = {},
  ): Promise<ProviderContext> {
    const account = await prisma.sourceAccount.findUnique({ where: { sourceId } })
    return this.registry.context(sourceId, {
      siteId: opts.siteId,
      signal: opts.signal,
      accountUsername: account?.username,
    })
  }

  /** Ensure the source is enabled for content calls; throws otherwise. */
  async requireEnabled(sourceId: string): Promise<void> {
    const runtime = await this.registry.runtime(sourceId)
    if (!runtime.enabled) {
      throw forbidden(`来源已停用 / Source disabled: ${sourceId}`, 'SOURCE_DISABLED')
    }
  }

  async login(sourceId: string): Promise<AccountState> {
    const provider = this.registry.comic(sourceId)
    if (!('login' in provider)) throw badRequest(`Source ${sourceId} has no login`)
    const ctx = await this.registry.context(sourceId)
    const state = await (provider as unknown as KomiicProvider).login(ctx, true)
    await this.persistStatus(sourceId, state)
    return state
  }

  async logout(sourceId: string): Promise<AccountState | null> {
    const provider = this.registry.comic(sourceId)
    if (!('logout' in provider)) throw badRequest(`Source ${sourceId} has no login`)
    const ctx = await this.registry.context(sourceId)
    await (provider as unknown as KomiicProvider).logout(ctx)
    const account = await prisma.sourceAccount.findUnique({ where: { sourceId } })
    if (account) {
      await prisma.sourceAccount.update({
        where: { sourceId },
        data: { passwordEnc: null, autoLogin: false },
      })
      await this.applyAccount(sourceId)
    }
    const state = await this.accountState(sourceId)
    if (state) await this.persistStatus(sourceId, state)
    return state
  }

  async persistStatus(sourceId: string, state: AccountState): Promise<void> {
    try {
      await prisma.sourceAccount.update({
        where: { sourceId },
        data: { statusJson: JSON.stringify(state) },
      })
    } catch {
      // no account row yet; status is transient
    }
  }

  private parseConfig(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}
