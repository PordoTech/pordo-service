import { Container, Service } from 'typedi'
import { prisma } from '../../shared/prisma'
import { notFound, badRequest } from '../../shared/errors'
import { digest } from '../../shared/crypto'
import type { ComicProvider, ProviderContext, VideoProvider } from './types'
import { KomiicProvider } from './komiic'
import { MangaYunProvider } from './mangayun'

export interface SourceRuntime {
  id: string
  enabled: boolean
  priority: number
  proxy: string | null
  timeoutMs: number
  concurrency: number
  config: Record<string, unknown>
}

/**
 * Shared ProviderRegistry: comic providers are registered and strongly typed;
 * video providers are reserved for later without inventing sources.
 */
@Service()
export class ProviderRegistry {
  private comics = new Map<string, ComicProvider>()
  private videos = new Map<string, VideoProvider>()
  private runtimeCache = new Map<string, { runtime: SourceRuntime; at: number }>()

  constructor() {
    const komiic = Container.get(KomiicProvider)
    const mangayun = Container.get(MangaYunProvider)
    this.registerComic(komiic as unknown as ComicProvider)
    this.registerComic(mangayun as unknown as ComicProvider)
  }

  registerComic(provider: ComicProvider): void {
    this.comics.set(provider.id, provider)
  }

  registerVideo(provider: VideoProvider): void {
    this.videos.set(provider.id, provider)
  }

  comic(id: string): ComicProvider {
    const provider = this.comics.get(id)
    if (!provider) throw notFound(`Unknown comic provider: ${id}`, 'SOURCE_NOT_FOUND')
    return provider
  }

  hasComic(id: string): boolean {
    return this.comics.has(id)
  }

  comicIds(): string[] {
    return [...this.comics.keys()]
  }

  videoIds(): string[] {
    return [...this.videos.keys()]
  }

  /** Drop cached runtime config (after admin updates). */
  invalidate(sourceId?: string): void {
    if (sourceId) this.runtimeCache.delete(sourceId)
    else this.runtimeCache.clear()
  }

  async runtime(sourceId: string): Promise<SourceRuntime> {
    const cached = this.runtimeCache.get(sourceId)
    if (cached && Date.now() - cached.at < 5000) return cached.runtime
    const row = await prisma.sourceConfig.findUnique({ where: { id: sourceId } })
    if (!row) throw notFound(`Source not configured: ${sourceId}`, 'SOURCE_NOT_FOUND')
    let config: Record<string, unknown> = {}
    try {
      config = JSON.parse(row.config) as Record<string, unknown>
    } catch {
      config = {}
    }
    const runtime: SourceRuntime = {
      id: row.id,
      enabled: row.enabled,
      priority: row.priority,
      proxy: row.proxy,
      timeoutMs: row.timeoutMs,
      concurrency: row.concurrency,
      config,
    }
    this.runtimeCache.set(sourceId, { runtime, at: Date.now() })
    return runtime
  }

  /** Build the execution context for a provider call. */
  async context(
    sourceId: string,
    opts: { siteId?: string; signal?: AbortSignal; accountUsername?: string } = {},
  ): Promise<ProviderContext> {
    const runtime = await this.runtime(sourceId)
    return {
      sourceId,
      contextId: opts.accountUsername ? digest(opts.accountUsername.trim()) : '',
      siteId: opts.siteId,
      proxy: runtime.proxy,
      timeoutMs: runtime.timeoutMs,
      config: runtime.config,
      signal: opts.signal,
    }
  }

  validateProxy(proxy: string | null | undefined): string | null {
    if (proxy === null || proxy === undefined || proxy === '') return null
    let parsed: URL
    try {
      parsed = new URL(proxy)
    } catch {
      throw badRequest('Invalid proxy URL')
    }
    if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol)) {
      throw badRequest('Proxy must be http(s) or socks5')
    }
    return parsed.toString()
  }
}

/** Seed default SourceConfig rows for every registered provider. */
export const seedSources = async (registry: ProviderRegistry): Promise<void> => {
  const defaults: Record<string, { concurrency: number; timeoutMs: number }> = {
    komiic: { concurrency: 2, timeoutMs: 25000 },
    mangayun: { concurrency: 4, timeoutMs: 65000 },
  }
  let priority = 10
  for (const id of registry.comicIds()) {
    const existing = await prisma.sourceConfig.findUnique({ where: { id } })
    if (existing) continue
    const preset = defaults[id] ?? { concurrency: 4, timeoutMs: 25000 }
    await prisma.sourceConfig.create({
      data: {
        id,
        enabled: true,
        priority,
        timeoutMs: preset.timeoutMs,
        concurrency: preset.concurrency,
        config: '{}',
      },
    })
    priority += 10
  }
}
