import type { Readable } from 'node:stream'

/**
 * Strongly typed provider contracts. Content identity (provider/siteId/urls)
 * is separated from resource access (asset ids handled by the asset layer).
 * ComicProvider is implemented now; VideoProvider reserves the video surface
 * without inventing sources or transcoding.
 */

export interface Site {
  siteId: string
  siteName: string
}

/** Mirrors the client's Book record; field names match its JSON serde names. */
export interface ComicBook {
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

export type ChapterKind = 'chapter' | 'volume'

export interface ComicChapter {
  id: string
  name: string
  url: string
  order: number
  kind: ChapterKind
}

export interface ComicDetail {
  book: ComicBook
  chapters: ComicChapter[]
}

export interface SearchGroup {
  site: Site
  books: ComicBook[]
  error?: string | null
}

export interface ImagePolicy {
  concurrency: number
  ahead: number
  behind: number
  retainCacheOnRefresh: boolean
}

export const defaultImagePolicy: ImagePolicy = {
  concurrency: 4,
  ahead: 3,
  behind: 1,
  retainCacheOnRefresh: false,
}

export interface ProviderCapabilities {
  search: boolean
  detail: boolean
  chapters: boolean
  pages: boolean
  images: boolean
  covers: boolean
  updateCheck: boolean
  accountLogin: boolean
  /** Honest pagination support only; never claim what a site lacks. */
  searchPagination: boolean
  sites: boolean
}

export interface AccountState {
  phase: 'guest' | 'pending' | 'signing_in' | 'signed_in' | 'error'
  nickname: string
  message: string
  limit: number | null
  usage: number | null
}

export interface AccountConfigSchemaField {
  key: string
  label: string
  type: 'string' | 'password' | 'boolean' | 'number'
  required?: boolean
  placeholder?: string
}

export interface UpstreamImage {
  body: Readable
  contentType: string
  /** When true the bytes must not be cached beyond this request (e.g. tickets). */
  status?: number
}

/** Per-account execution context passed to providers for scheduling/isolation. */
export interface ProviderContext {
  sourceId: string
  /** '' for anonymous; otherwise credential digest - cache keys include it. */
  contextId: string
  /** Upstream site id for multi-site providers (e.g. mangayun child sites). */
  siteId?: string
  proxy?: string | null
  timeoutMs: number
  /** Provider specific config JSON from SourceConfig (baseUrl overrides, ...). */
  config?: Record<string, unknown>
  signal?: AbortSignal
}

export interface ComicProvider {
  readonly id: string
  readonly displayName: string
  readonly kind: 'comic'
  capabilities(): ProviderCapabilities
  accountSchema(): AccountConfigSchemaField[]
  sites(ctx: ProviderContext): Promise<Site[]>
  search(keyword: string, ctx: ProviderContext): Promise<SearchGroup[]>
  detail(book: ComicBook, ctx: ProviderContext): Promise<ComicDetail>
  /** Original upstream page URLs (content identity), never proxy URLs. */
  pages(book: ComicBook, chapter: ComicChapter, refresh: boolean, ctx: ProviderContext): Promise<string[]>
  /**
   * Fetch original image bytes for an upstream URL (cover or page). Providers
   * apply their own headers/tickets/relays internally and must validate the
   * destination host.
   */
  fetchImage(url: string, ctx: ProviderContext): Promise<UpstreamImage>
  imagePolicy?(book: ComicBook): ImagePolicy
}

/** Account lifecycle is optional; only providers with logins implement it. */
export interface AccountController {
  configure(sourceId: string, settings: AccountSettings): Promise<void>
  status(sourceId: string): AccountState
  login(sourceId: string, manual: boolean): Promise<AccountState>
  logout(sourceId: string): Promise<void>
}

export interface AccountSettings {
  username: string
  password?: string // undefined/'' = keep existing; explicit clear via clearPassword
  autoLogin: boolean
}

/** Reserved video surface. No source implements it in v1; no transcoding. */
export interface VideoEpisode {
  id: string
  name: string
  order: number
}

export interface VideoStreamLine {
  id: string
  name: string
}

export interface PlaybackTarget {
  format: string
  /** Milliseconds until the URL stops working; null = stable. */
  expiresAt: number | null
  /** direct = client may fetch itself; proxy = must go through /assets. */
  access: 'direct' | 'proxy'
  url: string
}

export interface VideoProvider {
  readonly id: string
  readonly displayName: string
  readonly kind: 'video'
  capabilities(): ProviderCapabilities
  search(keyword: string, ctx: ProviderContext): Promise<SearchGroup[]>
  detail(book: ComicBook, ctx: ProviderContext): Promise<{ book: ComicBook; episodes: VideoEpisode[]; lines: VideoStreamLine[] }>
  playback(episodeId: string, lineId: string, ctx: ProviderContext): Promise<PlaybackTarget[]>
}
