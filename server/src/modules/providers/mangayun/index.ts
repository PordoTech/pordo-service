import { Service } from 'typedi'
import { createHash, randomUUID } from 'node:crypto'
import { ApiError, badRequest } from '../../../shared/errors'
import {
  headerValue,
  hostMatches,
  httpUrl,
  readJsonLimited,
  sendUpstream,
} from '../../../shared/http'
import { nowSeconds } from '../../../shared/time'
import type {
  AccountConfigSchemaField,
  ComicBook,
  ComicChapter,
  ComicDetail,
  ProviderCapabilities,
  ProviderContext,
  SearchGroup,
  Site,
  UpstreamImage,
} from '../types'
import * as dm5 from '../dm5'

type Json = Record<string, unknown>

const DEFAULT_BASE = 'https://mangayun.com'
const YM_SALT = 'ym-salt-883a0f7e-29f1-4b72-9ad2'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * MangaYun provider, migrated from the MangaYun implementation in
 * crates/pordo-core/src/comics/source.rs. MangaYun is itself an external
 * aggregation service; this adapter depends on that upstream and isolates its
 * public web-client signing protocol here so it can be replaced when the
 * website changes. DM5 keeps only the existing parsing/fallback capability.
 */
@Service()
export class MangaYunProvider {
  readonly id = 'mangayun'
  readonly displayName = 'MangaYun'
  readonly kind = 'comic' as const

  capabilities(): ProviderCapabilities {
    return {
      search: true,
      detail: true,
      chapters: true,
      pages: true,
      images: true,
      covers: true,
      updateCheck: true,
      accountLogin: false,
      searchPagination: false,
      sites: true,
    }
  }

  accountSchema(): AccountConfigSchemaField[] {
    return []
  }

  private base(ctx: ProviderContext): string {
    const configured = ctx.config?.baseUrl
    return (typeof configured === 'string' && configured ? configured : DEFAULT_BASE).replace(
      /\/+$/,
      '',
    )
  }

  private async request(
    ctx: ProviderContext,
    path: string,
    body?: Json,
  ): Promise<Json | Json[] | unknown> {
    const bodyStr = body === undefined ? '' : JSON.stringify(body)
    const ts = String(nowSeconds() * 1000)
    const nonce = randomUUID().replaceAll('-', '')
    // Public web-client protocol; isolate it here when the website changes.
    const sign = createHash('sha256')
      .update(`${path}|${bodyStr}|${ts}|${nonce}|${YM_SALT}`)
      .digest('hex')
    const response = await sendUpstream({
      method: body === undefined ? 'GET' : 'POST',
      url: `${this.base(ctx)}${path}`,
      ...(body === undefined ? {} : { jsonBody: bodyStr }),
      headers: {
        'content-type': 'application/json',
        'x-ym-ts': ts,
        'x-ym-nonce': nonce,
        'x-ym-sign': sign,
      },
      proxy: ctx.proxy ?? null,
      timeoutMs: Math.max(ctx.timeoutMs, 65_000),
      signal: ctx.signal,
    })
    if (response.status < 200 || response.status >= 300) {
      response.body.destroy()
      throw new ApiError(
        502,
        'UPSTREAM_HTTP',
        `漫画源 HTTP ${response.status} / Comic source unavailable`,
        response.status >= 500,
      )
    }
    let value: Json
    try {
      value = (await readJsonLimited(response)) as Json
    } catch {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', '漫画源数据格式已变化 / Invalid comic response')
    }
    if (value === null || typeof value !== 'object' || value.data === undefined) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', '漫画源未返回数据 / Missing comic data')
    }
    return value.data as Json
  }

  async sites(ctx: ProviderContext): Promise<Site[]> {
    const data = await this.request(ctx, '/api/sites?v=3')
    if (!Array.isArray(data)) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', '漫画源站点列表已变化 / Invalid site list')
    }
    const sites: Site[] = []
    for (const item of data as Json[]) {
      const siteId = str(item.siteId)
      if (!siteId) continue
      sites.push({ siteId, siteName: str(item.siteName) || siteId })
    }
    return sites
  }

  async search(keyword: string, ctx: ProviderContext): Promise<SearchGroup[]> {
    const trimmed = keyword.trim()
    if (!trimmed || trimmed.length > 512) {
      throw badRequest('请输入漫画名称 / Enter a title')
    }
    const data = await this.request(ctx, '/api/search', { keyword: trimmed })
    if (!Array.isArray(data)) {
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', '无效搜索结果 / Invalid search response')
    }
    const groups: SearchGroup[] = []
    for (const group of (data as Json[]).slice(0, 40)) {
      const site: Site = {
        siteId: str(group.siteId),
        siteName: str(group.siteName) || str(group.siteId),
      }
      const books: ComicBook[] = []
      const list = Array.isArray(group.results) ? (group.results as Json[]) : []
      for (const item of list.slice(0, 100)) {
        const book = this.bookFrom(item, site)
        if (book && book.title && book.detailUrl) books.push(book)
      }
      const error = str(group.error)
      groups.push({
        site,
        books,
        error: error ? '来源暂时不可用 / Source unavailable' : null,
      })
    }
    return groups
  }

  private bookFrom(item: Json, site: Site): ComicBook | null {
    const title = str(item.title)
    const detailUrl = str(item.detailUrl) || str(item.url)
    if (!title || !detailUrl) return null
    return {
      provider: 'mangayun',
      siteId: site.siteId,
      siteName: site.siteName,
      title,
      author: str(item.author),
      description: str(item.description),
      status: str(item.status),
      coverUrl: str(item.coverUrl) || str(item.cover),
      detailUrl,
    }
  }

  async detail(book: ComicBook, ctx: ProviderContext): Promise<ComicDetail> {
    const data = (await this.request(ctx, '/api/details', {
      siteId: book.siteId,
      detailUrl: book.detailUrl,
    })) as Json
    const details: ComicBook = {
      provider: book.provider,
      siteId: book.siteId,
      siteName: book.siteName,
      title: str(data.title) || book.title,
      author: str(data.author),
      description: str(data.description),
      status: str(data.status),
      coverUrl: str(data.coverUrl) || str(data.cover) || book.coverUrl,
      detailUrl: book.detailUrl,
    }
    const rawChapters = Array.isArray(data.chapters) ? (data.chapters as Json[]) : []
    const seen = new Set<string>()
    const chapters: ComicChapter[] = []
    for (const item of rawChapters) {
      const url = str(item.url)
      if (!url) continue
      const chapter: ComicChapter = {
        id: str(item.id),
        name: str(item.name),
        url,
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
        kind: item.kind === 'volume' || item.kind === 'Volume' ? 'volume' : 'chapter',
      }
      const key = chapter.id || chapter.url
      if (seen.has(key)) continue
      seen.add(key)
      chapters.push(chapter)
    }
    chapters.sort((a, b) => a.order - b.order)
    if (chapters.length === 0) {
      throw new ApiError(404, 'NO_RESULTS', '没有可读章节 / No chapters available')
    }
    return { book: details, chapters }
  }

  async pages(
    book: ComicBook,
    chapter: ComicChapter,
    refresh: boolean,
    ctx: ProviderContext,
  ): Promise<string[]> {
    if (book.siteId === 'comicbox') {
      throw badRequest('暂不支持此来源的阅读，请选择其他来源 / Reading this source is not supported yet')
    }
    let pages: string[] | null = null
    try {
      const data = (await this.request(ctx, '/api/chapter-images', {
        siteId: book.siteId,
        chapterUrl: chapter.url,
        refresh,
      })) as Json
      const images = Array.isArray(data.images) ? (data.images as unknown[]) : null
      if (images) {
        const list = images.filter((v): v is string => typeof v === 'string')
        if (list.length > 0 && list.length <= 2000) pages = list
      }
    } catch {
      pages = null
    }
    if (pages === null && book.siteId === 'dm5') {
      const chapterUrl = httpUrl(chapter.url)
      if (!dm5.isChapter(chapterUrl)) {
        throw badRequest('无效动漫屋章节地址 / Invalid DM5 chapter URL')
      }
      return dm5.pages(chapterUrl, {
        proxy: ctx.proxy ?? null,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      })
    }
    if (pages === null) {
      throw new ApiError(
        404,
        'NO_RESULTS',
        '来源未返回章节图片 / Source returned no chapter images',
      )
    }
    return pages
  }

  private static readonly PROTECTED_DOMAINS = [
    'hamreus.com',
    'cdndm5.com',
    'ccavbox.com',
    'bgm.tv',
    'tuku.cc',
  ]

  /**
   * Fetch original image bytes. Matches the public web client: only
   * hotlink-protected sources need the relay initially; other CDNs are faster
   * directly, with a relay fallback if the CDN rejects us. DM5 lazy page
   * endpoints are resolved on demand (once) before fetching.
   */
  async fetchImage(url: string, ctx: ProviderContext): Promise<UpstreamImage> {
    const base = this.base(ctx)
    const siteId = ctx.siteId ?? ''
    let absolute = new URL(url, base)
    httpUrl(absolute.toString())

    if (siteId === 'dm5' && dm5.isPage(absolute)) {
      const resolved = await dm5.resolve(absolute, {
        proxy: ctx.proxy ?? null,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      })
      const direct = await this.tryDirect(resolved.image, resolved.referer.toString(), ctx)
      if (direct) return direct
      return this.relay(resolved.image.toString(), siteId, ctx, resolved.referer.toString())
    }

    const protectedSource =
      hostMatches(absolute.hostname, MangaYunProvider.PROTECTED_DOMAINS) ||
      ['manhuagui', 'comicbox', 'manben', 'dm5', 'tuku'].includes(siteId)
    if (protectedSource) {
      return this.relay(absolute.toString(), siteId, ctx)
    }
    const direct = await this.tryDirect(absolute, null, ctx)
    if (direct) return direct
    return this.relay(absolute.toString(), siteId, ctx)
  }

  private async tryDirect(
    image: URL,
    referer: string | null,
    ctx: ProviderContext,
  ): Promise<UpstreamImage | null> {
    try {
      const response = await sendUpstream({
        url: image.toString(),
        headers: referer ? { referer, 'user-agent': 'Mozilla/5.0' } : undefined,
        proxy: ctx.proxy ?? null,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      })
      if (response.status !== 200) {
        response.body.destroy()
        return null
      }
      return {
        body: response.body,
        contentType: headerValue(response.headers, 'content-type') || 'image/jpeg',
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REQUEST_CANCELLED') throw error
      return null
    }
  }

  private async relay(
    url: string,
    siteId: string,
    ctx: ProviderContext,
    referer?: string,
  ): Promise<UpstreamImage> {
    const relayUrl = new URL(`${this.base(ctx)}/api/image`)
    relayUrl.searchParams.set('url', url)
    relayUrl.searchParams.set('siteId', siteId)
    const response = await sendUpstream({
      url: relayUrl.toString(),
      headers: referer ? { referer } : undefined,
      proxy: ctx.proxy ?? null,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    })
    if (response.status !== 200) {
      response.body.destroy()
      throw new ApiError(
        502,
        'UPSTREAM_HTTP',
        `漫画源 HTTP ${response.status} / Comic source unavailable`,
        response.status >= 500,
      )
    }
    return {
      body: response.body,
      contentType: headerValue(response.headers, 'content-type') || 'image/jpeg',
    }
  }
}
