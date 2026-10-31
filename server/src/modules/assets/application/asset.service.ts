import { Container, Service } from 'typedi'
import net from 'node:net'
import dns from 'node:dns/promises'
import type { Context } from 'koa'
import { ApiError, badRequest, forbidden, notFound } from '../../../shared/errors'
import { httpUrl } from '../../../shared/http'
import { signAsset, verifyAsset } from '../../../shared/crypto'
import { semaphoreFor } from '../../../shared/scheduler'
import { logRequest } from '../../../shared/envelope'
import { ProviderRegistry } from '../../providers/registry'
import { SourceService } from '../../sources/application/source.service'
import { ImageCache } from '../infrastructure/image-cache'
import { IS_TEST } from '../../../configs/constants'

export interface AssetRef {
  provider: string
  siteId: string
  url: string
}

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
]

/**
 * Controlled asset access: ids are HMAC-signed (provider, siteId, url)
 * triples. There is no arbitrary URL proxy; destinations are validated per
 * provider and (in production) against private/loopback ranges to block SSRF.
 * Credentials, cookies and image tickets never leave the provider layer.
 */
@Service()
export class AssetService {
  private pending = new Map<string, Promise<void>>()
  private registry = Container.get(ProviderRegistry)
  private sources = Container.get(SourceService)
  private cache = Container.get(ImageCache)

  sign(ref: AssetRef): string {
    return signAsset(JSON.stringify({ p: ref.provider, s: ref.siteId, u: ref.url }))
  }

  parse(assetId: string): AssetRef {
    const payload = verifyAsset(assetId)
    if (!payload) throw forbidden('无效资源地址 / Invalid asset id', 'ASSET_INVALID')
    try {
      const parsed = JSON.parse(payload) as { p?: string; s?: string; u?: string }
      if (
        typeof parsed.p !== 'string' ||
        typeof parsed.s !== 'string' ||
        typeof parsed.u !== 'string'
      ) {
        throw new Error('shape')
      }
      return { provider: parsed.p, siteId: parsed.s, url: parsed.u }
    } catch {
      throw forbidden('无效资源地址 / Invalid asset id', 'ASSET_INVALID')
    }
  }

  /**
   * Compatibility endpoint support: sign asset ids for legacy stored URLs.
   * Only http(s) URLs are accepted and provider validation still applies at
   * fetch time; abuse requires a valid device token (single-admin deployment).
   */
  prepare(items: Array<{ provider: string; siteId: string; url: string }>): Array<{
    provider: string
    siteId: string
    url: string
    assetId: string
  }> {
    if (items.length > 500) throw badRequest('Too many items (max 500)')
    return items.map((item) => {
      if (!this.registry.hasComic(item.provider || 'mangayun')) {
        throw notFound(`Unknown provider: ${item.provider}`, 'SOURCE_NOT_FOUND')
      }
      httpUrl(item.url)
      return { ...item, assetId: this.sign(item) }
    })
  }

  private async assertPublicDestination(url: string, ctxConfig: Record<string, unknown>): Promise<void> {
    // Test/dev upstreams (mock servers, overridden baseUrl) are local by design.
    if (IS_TEST || process.env.PORDO_ALLOW_PRIVATE_UPSTREAMS === '1') return
    const baseUrl = typeof ctxConfig.baseUrl === 'string' ? ctxConfig.baseUrl : ''
    if (baseUrl && /https?:\/\/(localhost|127\.|0\.|\[::1\])/.test(baseUrl)) return
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host === '::1' || PRIVATE_V4.some((re) => re.test(host))) {
      throw forbidden('不允许访问内网地址 / Private destinations are not allowed')
    }
    if (net.isIP(host) === 0) {
      try {
        const records = await dns.lookup(host, { all: true })
        for (const record of records) {
          const address = record.address
          if (
            address === '::1' ||
            address === 'localhost' ||
            PRIVATE_V4.some((re) => re.test(address)) ||
            address.startsWith('fc') ||
            address.startsWith('fd') ||
            address.startsWith('fe80')
          ) {
            throw forbidden('不允许访问内网地址 / Private destinations are not allowed')
          }
        }
      } catch (error) {
        if (error instanceof ApiError) throw error
        // DNS failure surfaces later as an upstream error.
      }
    }
  }

  /**
   * Serve an asset: cache hit streams from disk; a miss fetches upstream with
   * per-account concurrency + in-flight dedupe, tees to cache and streams to
   * the client. Never buffers whole originals in RAM.
   */
  async serve(ctx: Context, assetId: string, requestId: string): Promise<void> {
    if (ctx.res.destroyed) return
    const ref = this.parse(assetId)
    const providerId = ref.provider || 'mangayun'
    await this.sources.requireEnabled(providerId)
    const runtime = await this.registry.runtime(providerId)
    const provider = this.registry.comic(providerId)
    const accountCtx = await this.sources.contentContext(providerId, {
      siteId: ref.siteId,
    })
    await this.assertPublicDestination(ref.url, runtime.config)

    const { ttlSeconds } = await this.cache.settings()
    const cacheId = this.cache.entryId(providerId, accountCtx.contextId, ref.url)

    // Each HTTP response owns its readable. Other devices wait for the shared
    // cache fill, then open independent file streams rather than sharing a pipe.
    const pending = this.pending.get(cacheId)
    if (pending) await pending.catch(() => {})
    const hit = await this.cache.read(cacheId)
    if (ctx.res.destroyed) { hit?.body.destroy(); return }
    // Recheck after async disk lookup: another request may have started a fill.
    if (!hit && this.pending.has(cacheId)) {
      await this.pending.get(cacheId)!.catch(() => {})
      return this.serve(ctx, assetId, requestId)
    }
    const started = Date.now()
    if (hit) {
      ctx.status = 200
      ctx.set('Content-Type', hit.contentType)
      ctx.set('Content-Length', String(hit.size))
      ctx.set('Cache-Control', 'private, max-age=86400')
      ctx.set('X-Cache', 'HIT')
      ctx.body = hit.body
      void logRequest({
        requestId,
        kind: 'api',
        sourceId: ref.provider,
        op: 'asset.hit',
        status: 200,
        durationMs: Date.now() - started,
      })
      return
    }

    // Complete a started cache fill even if the first reader closes, so other
    // devices remain independent. The provider's timeout bounds the transfer.
    const sem = semaphoreFor(
      `asset:${providerId}:${accountCtx.contextId}`,
      Math.min(runtime.concurrency, provider.id === 'komiic' ? 2 : runtime.concurrency),
    )
    let finish!: () => void
    const filling = new Promise<void>((resolve) => { finish = resolve })
    this.pending.set(cacheId, filling)
    let release: (() => void) | undefined
    const complete = (): void => {
      release?.()
      if (this.pending.get(cacheId) === filling) this.pending.delete(cacheId)
      finish()
    }
    try {
      release = await sem.acquire()
      const image = await provider.fetchImage(ref.url, accountCtx)
      const { clientBody, done } = this.cache.write(cacheId, image.body, {
        sourceId: providerId, contextId: accountCtx.contextId, url: ref.url,
        contentType: image.contentType, ttlSeconds,
      })
      const deadline = setTimeout(() => image.body.destroy(new Error('Image transfer timed out')), runtime.timeoutMs)
      deadline.unref()
      void done.then((size) => {
        clearTimeout(deadline)
        complete()
        void logRequest({ requestId, kind: 'upstream', sourceId: providerId,
          op: 'asset.miss', status: 200, durationMs: Date.now() - started,
          detail: size === null ? 'cache write skipped' : `${size} bytes cached` })
      }, () => { clearTimeout(deadline); complete() })
      if (ctx.res.destroyed) { clientBody.destroy(); return }
      ctx.status = 200
      ctx.set('Content-Type', image.contentType)
      ctx.set('Cache-Control', 'private, max-age=3600')
      ctx.set('X-Cache', 'MISS')
      ctx.body = clientBody
    } catch (error) {
      complete()
      throw error
    }
  }
}
