import { Container, Service } from 'typedi'
import { prisma } from '../../../shared/prisma'
import { ApiError, badRequest, notFound } from '../../../shared/errors'
import { bookKey } from '../../../shared/crypto'
import { ProviderRegistry } from '../../providers/registry'
import { SourceService } from '../../sources/application/source.service'
import { AssetService } from '../../assets/application/asset.service'
import type { ComicBook, ComicChapter, ComicDetail } from '../../providers/types'

export interface ComicView {
  comicId: string
  provider: string
  siteId: string
  siteName: string
  title: string
  author: string
  description: string
  status: string
  /** Original content identity; never a proxy URL. */
  coverUrl: string
  detailUrl: string
  /** Resource access address for the cover. */
  coverAssetId: string | null
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
  /** Original upstream URL (identity), never a proxy URL. */
  url: string
  assetId: string
}

interface DetailCacheEntry {
  detail: ComicDetail
  at: number
}

const DETAIL_CACHE_MS = 60_000

/**
 * Comics application service: identity-preserving discovery and directory
 * access. comicId == Book.key == sha256(provider\0siteId\0detailUrl), stable
 * across restarts, deployments and service domain changes.
 */
@Service()
export class ComicService {
  private registry = Container.get(ProviderRegistry)
  private sources = Container.get(SourceService)
  private assets = Container.get(AssetService)
  private detailCache = new Map<string, DetailCacheEntry>()

  toView(book: ComicBook, withCoverAsset = true): ComicView {
    return {
      comicId: bookKey(book.provider, book.siteId, book.detailUrl),
      provider: book.provider,
      siteId: book.siteId,
      siteName: book.siteName,
      title: book.title,
      author: book.author,
      description: book.description,
      status: book.status,
      coverUrl: book.coverUrl,
      detailUrl: book.detailUrl,
      coverAssetId:
        withCoverAsset && book.coverUrl
          ? this.assets.sign({
              provider: book.provider,
              siteId: book.siteId,
              url: book.coverUrl,
            })
          : null,
    }
  }

  /**
   * Parallel multi-source search; a failing source becomes an error group and
   * never blocks the others.
   */
  async search(
    keyword: string,
    sourceId: string | undefined,
    signal?: AbortSignal,
  ): Promise<{
    groups: Array<{
      site: { siteId: string; siteName: string; provider: string }
      books: ComicView[]
      error: string | null
    }>
    partial: boolean
  }> {
    const trimmed = keyword.trim()
    if (!trimmed) throw badRequest('请输入漫画名称 / Enter a title')
    if (trimmed.length > 512) throw badRequest('关键词过长 / Keyword too long')

    let ids: string[]
    if (sourceId) {
      await this.sources.requireEnabled(sourceId)
      ids = [sourceId]
    } else {
      const rows = await prisma.sourceConfig.findMany({
        where: { enabled: true },
        orderBy: { priority: 'asc' },
      })
      ids = rows.map((r) => r.id).filter((id) => this.registry.hasComic(id))
    }
    if (ids.length === 0) throw notFound('没有可用的内容源 / No sources available', 'SOURCE_NOT_FOUND')

    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const provider = this.registry.comic(id)
          const ctx = await this.sources.contentContext(id, { signal })
          const groups = await provider.search(trimmed, ctx)
          return { id, groups, error: null as string | null }
        } catch (error) {
          if (error instanceof ApiError && error.code === 'REQUEST_CANCELLED') throw error
          const message =
            error instanceof ApiError ? error.message : '来源暂时不可用 / Source unavailable'
          return { id, groups: [], error: message }
        }
      }),
    )

    const out: Array<{
      site: { siteId: string; siteName: string; provider: string }
      books: ComicView[]
      error: string | null
    }> = []
    let partial = false
    for (const result of results) {
      if (result.error) {
        partial = true
        out.push({
          site: { siteId: `${result.id}:${result.id}`, siteName: result.id, provider: result.id },
          books: [],
          error: result.error,
        })
        continue
      }
      for (const group of result.groups) {
        if (group.error) partial = true
        out.push({
          site: {
            // Qualified like the client's Sources.qualify: provider:siteId.
            siteId: `${result.id}:${group.site.siteId}`,
            siteName: group.site.siteName,
            provider: result.id,
          },
          books: group.books.map((b) => this.toView(b)),
          error: group.error ?? null,
        })
      }
    }
    return { groups: out, partial }
  }

  /**
   * Batch resolve legacy identities so an empty service database can open old
   * favorites directly, without re-searching.
   */
  async resolve(
    items: Array<{ provider: string; siteId: string; detailUrl: string; title?: string; coverUrl?: string }>,
  ): Promise<ComicView[]> {
    if (items.length > 500) throw badRequest('Too many items (max 500)')
    const views: ComicView[] = []
    for (const item of items) {
      if (!this.registry.hasComic(item.provider)) {
        throw notFound(`Unknown provider: ${item.provider}`, 'SOURCE_NOT_FOUND')
      }
      if (!item.siteId || !item.detailUrl) throw badRequest('siteId and detailUrl are required')
      const id = bookKey(item.provider, item.siteId, item.detailUrl)
      await prisma.comicRef.upsert({
        where: { id },
        create: {
          id,
          provider: item.provider,
          siteId: item.siteId,
          detailUrl: item.detailUrl,
          title: item.title ?? '',
          coverUrl: item.coverUrl ?? '',
        },
        update: {
          ...(item.title ? { title: item.title } : {}),
          ...(item.coverUrl ? { coverUrl: item.coverUrl } : {}),
          updatedAt: new Date(),
        },
      })
      views.push({
        comicId: id,
        provider: item.provider,
        siteId: item.siteId,
        siteName: '',
        title: item.title ?? '',
        author: '',
        description: '',
        status: '',
        coverUrl: item.coverUrl ?? '',
        detailUrl: item.detailUrl,
        coverAssetId: item.coverUrl
          ? this.assets.sign({
              provider: item.provider,
              siteId: item.siteId,
              url: item.coverUrl,
            })
          : null,
      })
    }
    return views
  }

  private async requireRef(comicId: string): Promise<{
    id: string
    provider: string
    siteId: string
    detailUrl: string
    title: string
    coverUrl: string
  }> {
    const ref = await prisma.comicRef.findUnique({ where: { id: comicId } })
    if (!ref) {
      throw new ApiError(
        404,
        'COMIC_NOT_RESOLVED',
        '漫画未解析，请先调用 /api/v1/comics/resolve / Comic not resolved',
      )
    }
    await this.sources.requireEnabled(ref.provider)
    return ref
  }

  private refToBook(ref: {
    provider: string
    siteId: string
    detailUrl: string
    title: string
    coverUrl: string
  }): ComicBook {
    return {
      provider: ref.provider,
      siteId: ref.siteId,
      siteName: '',
      title: ref.title,
      author: '',
      description: '',
      status: '',
      coverUrl: ref.coverUrl,
      detailUrl: ref.detailUrl,
    }
  }

  /** Fetch detail with a short in-memory cache to avoid duplicate upstream calls. */
  async detail(comicId: string, refresh = false, signal?: AbortSignal): Promise<ComicDetail> {
    const ref = await this.requireRef(comicId)
    if (!refresh) {
      const cached = this.detailCache.get(comicId)
      if (cached && Date.now() - cached.at < DETAIL_CACHE_MS) return cached.detail
    }
    const provider = this.registry.comic(ref.provider)
    const ctx = await this.sources.contentContext(ref.provider, {
      siteId: ref.siteId,
      signal,
    })
    const detail = await provider.detail(this.refToBook(ref), ctx)
    this.detailCache.set(comicId, { detail, at: Date.now() })
    const lastChapter = detail.chapters[detail.chapters.length - 1]
    await prisma.comicRef.update({
      where: { id: comicId },
      data: {
        title: detail.book.title,
        coverUrl: detail.book.coverUrl || ref.coverUrl,
        chapterCount: detail.chapters.length,
        lastChapterKey: lastChapter ? lastChapter.id || lastChapter.url : '',
        updatedAt: new Date(),
      },
    })
    return detail
  }

  async getComic(comicId: string, signal?: AbortSignal): Promise<{ comic: ComicView; chapters: ChapterView[] }> {
    const detail = await this.detail(comicId, false, signal)
    return {
      comic: this.toView(detail.book),
      chapters: detail.chapters.map((c) => this.chapterView(c)),
    }
  }

  chapterView(chapter: ComicChapter): ChapterView {
    return {
      id: chapter.id,
      key: chapter.id || chapter.url,
      name: chapter.name,
      order: chapter.order,
      kind: chapter.kind,
    }
  }

  async pages(
    comicId: string,
    chapterKey: string,
    refresh: boolean,
    signal?: AbortSignal,
  ): Promise<{ chapter: ChapterView; pages: PageView[]; imagePolicy: object }> {
    const detail = await this.detail(comicId, false, signal)
    const chapter = detail.chapters.find((c) => (c.id || c.url) === chapterKey)
    if (!chapter) {
      throw notFound('章节不存在 / Chapter not found', 'CHAPTER_NOT_FOUND')
    }
    const provider = this.registry.comic(detail.book.provider)
    const ctx = await this.sources.contentContext(detail.book.provider, {
      siteId: detail.book.siteId,
      signal,
    })
    const urls = await provider.pages(detail.book, chapter, refresh, ctx)
    const pages = urls.slice(0, 2000).map((url, index) => ({
      index,
      url,
      assetId: this.assets.sign({
        provider: detail.book.provider,
        siteId: detail.book.siteId,
        url,
      }),
    }))
    const policy = provider.imagePolicy
      ? provider.imagePolicy(detail.book)
      : { concurrency: 4, ahead: 3, behind: 1, retainCacheOnRefresh: false }
    return { chapter: this.chapterView(chapter), pages, imagePolicy: policy }
  }

  /** Periodic detail-cache pruning hook (called from the housekeeping timer). */
  pruneDetailCache(): void {
    const cutoff = Date.now() - DETAIL_CACHE_MS
    for (const [key, entry] of this.detailCache) {
      if (entry.at < cutoff) this.detailCache.delete(key)
    }
  }
}
