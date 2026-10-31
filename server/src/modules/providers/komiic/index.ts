import { Service } from 'typedi'
import { ApiError, badRequest } from '../../../shared/errors'
import { httpUrl, readJsonLimited, sendUpstream } from '../../../shared/http'
import type {
  AccountConfigSchemaField,
  AccountState,
  ComicBook,
  ComicChapter,
  ComicDetail,
  ImagePolicy,
  ProviderCapabilities,
  ProviderContext,
  SearchGroup,
  Site,
  ImageAccess,
} from '../types'
import { KomiicSession, numberOf, unauthorized, type KomiicCredentials } from './session'

type Json = Record<string, unknown>

const DEFAULT_BASE = 'https://komiic.com'

const jsonArrayOf = (value: unknown): Json[] | null =>
  Array.isArray(value) ? (value as Json[]) : null

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Komiic provider, migrated from crates/pordo-core/src/comics/source/komiic.rs.
 * Sessions are per source id; swapping accounts replaces the session object so
 * in-flight requests from the old account fail fast instead of polluting state.
 */
@Service()
export class KomiicProvider {
  readonly id = 'komiic'
  readonly displayName = 'Komiic'
  readonly kind = 'comic' as const

  private sessions = new Map<string, KomiicSession>()

  capabilities(): ProviderCapabilities {
    return {
      search: true,
      detail: true,
      chapters: true,
      pages: true,
      images: true,
      covers: true,
      updateCheck: true,
      accountLogin: true,
      searchPagination: false,
      sites: true,
    }
  }

  accountSchema(): AccountConfigSchemaField[] {
    return [
      { key: 'username', label: '邮箱 / Email', type: 'string', required: true, placeholder: 'you@example.com' },
      { key: 'password', label: '密码 / Password', type: 'password', required: false },
      { key: 'autoLogin', label: '自动登录 / Auto sign-in', type: 'boolean' },
    ]
  }

  imagePolicy(_book: ComicBook): ImagePolicy {
    return { concurrency: 2, ahead: 1, behind: 0, retainCacheOnRefresh: true }
  }

  private base(ctx: ProviderContext): string {
    const configured = ctx.config?.baseUrl
    return (typeof configured === 'string' && configured ? configured : DEFAULT_BASE).replace(
      /\/+$/,
      '',
    )
  }

  /** Current session, creating an anonymous one when the account is unset. */
  session(ctx: ProviderContext): KomiicSession {
    const base = this.base(ctx)
    let session = this.sessions.get(ctx.sourceId)
    if (!session || session.base !== base) {
      session = new KomiicSession(base, { username: '', password: '', autoLogin: false }, {
        proxy: ctx.proxy ?? null,
        timeoutMs: ctx.timeoutMs,
      })
      this.sessions.set(ctx.sourceId, session)
    }
    return session
  }

  configure(ctx: ProviderContext, credentials: KomiicCredentials): void {
    const base = this.base(ctx)
    const existing = this.sessions.get(ctx.sourceId)
    // Mirrors the client's Sessions::configure: identical settings keep the
    // live session; any change replaces it so stale cookies, terminal flags
    // and phase never survive a credential edit or logout.
    if (existing && existing.base === base && existing.sameCredentials(credentials)) return
    this.sessions.set(
      ctx.sourceId,
      new KomiicSession(base, credentials, {
        proxy: ctx.proxy ?? null,
        timeoutMs: ctx.timeoutMs,
      }),
    )
  }

  /** Account switch guard, equivalent to the client's Arc::ptr_eq check. */
  private check(ctx: ProviderContext, session: KomiicSession): void {
    if (this.sessions.get(ctx.sourceId) !== session) {
      throw new ApiError(409, 'ACCOUNT_SWITCHED', 'Komiic 账号已切换 / Account changed')
    }
  }

  status(ctx: ProviderContext): AccountState {
    return this.session(ctx).status()
  }

  async login(ctx: ProviderContext, manual: boolean): Promise<AccountState> {
    const session = this.session(ctx)
    await session.ensureReady(manual)
    this.check(ctx, session)
    return session.status()
  }

  async logout(ctx: ProviderContext): Promise<void> {
    const session = this.session(ctx)
    this.configure(ctx, { username: '', password: '', autoLogin: false })
    await session.logout().catch((error) => {
      // Local state is already cleared; surface upstream failure only.
      if (error instanceof ApiError) throw error
    })
  }

  async query(
    ctx: ProviderContext,
    operation: string,
    query: string,
    variables: Json,
  ): Promise<Json> {
    const base = this.base(ctx)
    const session = this.session(ctx)
    await session.ensureReady(false)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.check(ctx, session)
      const epoch = session.epoch()
      const cookie = await session.jar.getCookieString(base)
      const response = await sendUpstream({
        method: 'POST',
        url: `${base}/api/query`,
        jsonBody: JSON.stringify({ operationName: operation, query, variables }),
        headers: {
          origin: base,
          referer: `${base}/`,
          ...(cookie ? { cookie } : {}),
        },
        proxy: ctx.proxy ?? null,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      })
      const setCookies = response.headers['set-cookie']
      for (const value of setCookies === undefined ? [] : Array.isArray(setCookies) ? setCookies : [setCookies]) {
        await session.jar.setCookie(value, base, { ignoreError: true }).catch(() => {})
      }
      const status = response.status
      if (status === 401 && attempt === 0 && session.configured()) {
        response.body.destroy()
        await session.recover(epoch)
        continue
      }
      if (status === 401 && session.configured()) session.reject(epoch)
      if (status === 402) {
        response.body.destroy()
        session.quotaBlock(session.resetSeconds())
        session.quotaCheck()
      }
      if (status < 200 || status >= 300) {
        response.body.destroy()
        throw new ApiError(
          502,
          'UPSTREAM_HTTP',
          `Komiic HTTP ${status} / Source unavailable`,
          status >= 500,
        )
      }
      const value = (await readJsonLimited(response)) as Json
      this.check(ctx, session)
      if (unauthorized(value) && attempt === 0 && session.configured()) {
        await session.recover(epoch)
        continue
      }
      if (unauthorized(value) && session.configured()) session.reject(epoch)
      const data = value.data as Json | undefined
      session.quotaUpdate(data?.getImageLimit as Json | undefined)
      const errors = jsonArrayOf(value.errors)
      if (errors && errors.length > 0) {
        if (errors.some((e) => (e.extensions as Json | undefined)?.code === 'QUOTA_EXCEEDED')) {
          session.quotaBlock(session.resetSeconds())
          session.quotaCheck()
        }
        throw new ApiError(
          502,
          'UPSTREAM_PROTOCOL',
          'Komiic 请求未成功 / Source rejected the request',
        )
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Komiic 未返回数据 / Missing source data')
      }
      return data
    }
    throw new ApiError(401, 'UPSTREAM_UNAUTHORIZED', 'Komiic 会话已失效，请重新登录 / Sign in again')
  }

  static idOf(url: string, segment: string): string {
    const parsed = httpUrl(url)
    if (parsed.hostname !== 'komiic.com') {
      throw badRequest('无效 Komiic 地址 / Invalid source URL')
    }
    const parts = parsed.pathname.split('/').filter(Boolean)
    let id = ''
    for (let i = 0; i + 1 < parts.length; i += 1) {
      if (parts[i] === segment) {
        id = parts[i + 1] ?? ''
        break
      }
    }
    if (!id || id.length > 20 || !/^\d+$/.test(id)) {
      throw badRequest('无效漫画编号 / Invalid comic ID')
    }
    return id
  }

  static book(value: Json): ComicBook {
    const id = str(value.id)
    if (!id || !/^\d+$/.test(id)) throw badRequest('无效漫画编号 / Invalid comic ID')
    const title = str(value.title).trim()
    if (!title) throw badRequest('缺少漫画名称 / Missing comic title')
    const authors = jsonArrayOf(value.authors) ?? []
    const status = value.status
    return {
      provider: 'komiic',
      siteId: 'komiic',
      siteName: 'Komiic',
      title,
      author: authors.map((a) => str(a.name)).filter(Boolean).join(' / '),
      description: str(value.description),
      status: status === 'ONGOING' ? '连载中' : status === 'END' ? '已完结' : '',
      coverUrl: str(value.imageUrl),
      detailUrl: `https://komiic.com/comic/${id}`,
    }
  }

  async sites(_ctx: ProviderContext): Promise<Site[]> {
    return [{ siteId: 'komiic', siteName: 'Komiic' }]
  }

  async search(keyword: string, ctx: ProviderContext): Promise<SearchGroup[]> {
    const trimmed = keyword.trim()
    if (!trimmed || trimmed.length > 512) {
      throw badRequest('请输入漫画名称 / Enter a comic title')
    }
    const value = await this.query(
      ctx,
      'Search',
      'query Search($keyword:String!){searchComicsAndAuthors(keyword:$keyword){comics{id title status imageUrl authors{name}}}}',
      { keyword: trimmed },
    )
    const result = (value.searchComicsAndAuthors as Json | undefined)?.comics
    const records = jsonArrayOf(result)
    if (!records) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Komiic 搜索数据已变化 / Invalid search response')
    }
    const seen = new Set<string>()
    const books: ComicBook[] = []
    for (const record of records.slice(0, 200)) {
      try {
        const book = KomiicProvider.book(record)
        const key = `${book.provider}\u0000${book.siteId}\u0000${book.detailUrl}`
        if (!seen.has(key)) {
          seen.add(key)
          books.push(book)
        }
      } catch {
        // Skip malformed records exactly like the client does.
      }
    }
    return [{ site: { siteId: 'komiic', siteName: 'Komiic' }, books, error: null }]
  }

  async detail(book: ComicBook, ctx: ProviderContext): Promise<ComicDetail> {
    const id = KomiicProvider.idOf(book.detailUrl, 'comic')
    const value = await this.query(
      ctx,
      'Detail',
      'query Detail($comicId:ID!){comicById(comicId:$comicId){id title description status imageUrl authors{name}} chaptersByComicId(comicId:$comicId){id serial type size}}',
      { comicId: id },
    )
    const comicById = value.comicById as Json | undefined
    if (!comicById) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Komiic 数据已变化 / Invalid detail response')
    }
    const normalized = KomiicProvider.book(comicById)
    if (normalized.detailUrl !== book.detailUrl) {
      throw badRequest('漫画编号不一致 / Comic ID mismatch')
    }
    const records = jsonArrayOf(value.chaptersByComicId)
    if (!records) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Komiic 目录格式已变化 / Invalid chapter list')
    }
    const seen = new Set<string>()
    const chapters: ComicChapter[] = []
    for (const record of records.slice(0, 10000)) {
      const cid = str(record.id)
      const serial = str(record.serial)
      const type = str(record.type)
      if (type !== 'chapter' && type !== 'book') continue
      if (!cid || !/^\d+$/.test(cid) || seen.has(cid)) continue
      seen.add(cid)
      chapters.push({
        id: cid,
        name: `第 ${serial} ${type === 'book' ? '卷' : '话'}`,
        url: `https://komiic.com/comic/${id}/chapter/${cid}/images/all`,
        order: 0,
        kind: type === 'book' ? 'volume' : 'chapter',
      })
    }
    // Numeric serials, including decimals, sort naturally within each edition.
    const serialOf = (c: ComicChapter): number | null => {
      const parsed = Number(c.name.split(/\s+/)[1])
      return Number.isFinite(parsed) ? parsed : null
    }
    chapters.sort((a, b) => {
      const volumeDiff =
        Number(a.kind === 'volume') - Number(b.kind === 'volume')
      if (volumeDiff !== 0) return volumeDiff
      const sa = serialOf(a)
      const sb = serialOf(b)
      if (sa !== null && sb !== null && sa !== sb) return sa - sb
      if (sa !== null && sb === null) return -1
      if (sa === null && sb !== null) return 1
      const nameDiff = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      if (nameDiff !== 0) return nameDiff
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    chapters.forEach((chapter, index) => {
      chapter.order = index
    })
    if (chapters.length === 0) {
      throw new ApiError(404, 'NO_RESULTS', 'Komiic 暂无可读章节 / No readable chapters')
    }
    return { book: normalized, chapters }
  }

  async pages(
    book: ComicBook,
    chapter: ComicChapter,
    _refresh: boolean,
    ctx: ProviderContext,
  ): Promise<string[]> {
    if (KomiicProvider.idOf(book.detailUrl, 'comic') !== KomiicProvider.idOf(chapter.url, 'comic')) {
      throw badRequest('章节不属于该漫画 / Chapter belongs to another comic')
    }
    const base = this.base(ctx)
    const id = KomiicProvider.idOf(chapter.url, 'chapter')
    const value = await this.query(
      ctx,
      'Pages',
      'query Pages($chapterId:ID!){imagesByChapterId(chapterId:$chapterId){kid} getImageLimit{limit usage resetInSeconds}}',
      { chapterId: id },
    )
    // Keep the page list usable offline even when the remote image quota is exhausted.
    const records = jsonArrayOf(value.imagesByChapterId)
    if (!records) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Komiic 图片列表已变化 / Invalid page list')
    }
    const pages: string[] = []
    for (const record of records.slice(0, 2000)) {
      const kid = str(record.kid)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(kid)) {
        throw badRequest('无效图片编号 / Invalid image ID')
      }
      pages.push(`${base}/api/image/${kid}`)
    }
    if (pages.length === 0 || records.length > 2000) {
      throw new ApiError(404, 'NO_RESULTS', 'Komiic 无有效图片 / No valid pages')
    }
    return pages
  }

  /** Resolve a scoped image ticket without fetching the corresponding image. */
  private async ticket(
    ctx: ProviderContext,
    kid: string,
  ): Promise<ImageAccess> {
    const base = this.base(ctx)
    const session = this.session(ctx)
    await session.ensureReady(false)
    this.check(ctx, session)
    session.quotaCheck()
    const value = await this.query(
      ctx,
      'ImageTicket',
      'query ImageTicket($kids:[String!]!){getImageTickets(kids:$kids){kid url ticket expiresAt}}',
      { kids: [kid] },
    )
    this.check(ctx, session)
    const tickets = jsonArrayOf(value.getImageTickets)
    const ticket = tickets?.find((t) => t.kid === kid)
    if (!ticket) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Komiic 图片凭证不可用 / Missing image ticket')
    }
    const url = httpUrl(str(ticket.url))
    // Tickets must never be forwarded to an arbitrary host or through redirects.
    const baseOrigin = new URL(base).origin
    const allowed =
      (url.protocol === 'https:' && url.hostname === 'img.komiic.com') ||
      url.origin === baseOrigin
    if (!allowed) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', '无效图片服务器 / Invalid image server')
    }
    const ticketHeader = str(ticket.ticket)
    if (!ticketHeader) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', '缺少图片凭证 / Missing image ticket')
    }
    const expires = ticket.expiresAt
    const numeric = typeof expires === 'number' ? expires : typeof expires === 'string' && /^\d+(\.\d+)?$/.test(expires) ? Number(expires) : NaN
    const parsedExpiry = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric)
      : typeof expires === 'string' ? Date.parse(expires) : NaN
    return { url: url.toString(), headers: { 'x-image-ticket': ticketHeader }, expiresAt: Number.isFinite(parsedExpiry) ? Math.trunc(parsedExpiry) : null }
  }

  /** Resolve a short-lived ticket; only the client requests the image body. */
  async imageAccess(url: string, ctx: ProviderContext): Promise<ImageAccess> {
    const base = this.base(ctx)
    const parsed = httpUrl(url)
    if (parsed.origin === new URL(base).origin && parsed.pathname.startsWith('/api/image/')) {
      const kid = parsed.pathname.slice('/api/image/'.length)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(kid)) {
        throw badRequest('无效图片编号 / Invalid image ID')
      }
      return this.ticket(ctx, kid)
    }
    if (!(parsed.protocol === 'https:' && parsed.hostname === 'public.komiic.com')) {
      throw badRequest('无效 Komiic 图片地址 / Invalid image URL')
    }
    return { url: parsed.toString(), headers: {}, expiresAt: null }
  }

  /** Exposed for tests: force a quota block like the client's quota_block. */
  quotaBlock(ctx: ProviderContext, seconds: number): void {
    this.session(ctx).quotaBlock(seconds)
  }

  /** Quota info from GraphQL payloads (limit may arrive as string). */
  static readQuota(value: Json): { limit: number | null; usage: number | null } {
    return { limit: numberOf(value.limit), usage: numberOf(value.usage) }
  }
}

export const komiicProviderId = 'komiic'
export type { KomiicCredentials }
