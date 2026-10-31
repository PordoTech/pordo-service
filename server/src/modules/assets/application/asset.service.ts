import { Container, Service } from 'typedi'
import net from 'node:net'
import dns from 'node:dns/promises'
import type { Context } from 'koa'
import { ApiError, badRequest, forbidden, notFound } from '../../../shared/errors'
import { httpUrl } from '../../../shared/http'
import { signAsset, verifyAsset } from '../../../shared/crypto'
import { inFlight, semaphoreFor } from '../../../shared/scheduler'
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
      if (!this.registry.hasComic(item.provider)) {
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
    const ref = this.parse(assetId)
    await this.sources.requireEnabled(ref.provider)
    const runtime = await this.registry.runtime(ref.provider)
    const provider = this.registry.comic(ref.provider)
    const accountCtx = await this.sources.contentContext(ref.provider, {
      siteId: ref.siteId,
    })
    await this.assertPublicDestination(ref.url, runtime.config)

    const { ttlSeconds } = await this.cache.settings()
    const cacheId = this.cache.entryId(ref.provider, accountCtx.contextId, ref.url)

    const hit = await this.cache.read(cacheId)
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

    // Cancellation: abort the upstream fetch when the client disconnects.
    const abort = new AbortController()
    ctx.res.on('close', () => {
      if (!ctx.res.writableEnded) abort.abort()
    })
    const fetchCtx = { ...accountCtx, signal: abort.signal }

    const sem = semaphoreFor(
      `asset:${ref.provider}:${accountCtx.contextId}`,
      Math.min(runtime.concurrency, provider.id === 'komiic' ? 2 : runtime.concurrency),
    )
    try {
      const upstream = await sem.run(
        () =>
          inFlight.dedupe(`asset:${cacheId}`, async () => {
            const image = await provider.fetchImage(ref.url, fetchCtx)
            const { clientBody, done } = this.cache.write(cacheId, image.body, {
              sourceId: ref.provider,
              contextId: accountCtx.contextId,
              url: ref.url,
              contentType: image.contentType,
              ttlSeconds,
            })
            void done.then((size) => {
              void logRequest({
                requestId,
                kind: 'upstream',
                sourceId: ref.provider,
                op: 'asset.miss',
                status: 200,
                durationMs: Date.now() - started,
                detail: size === null ? 'cache write skipped' : `${size} bytes cached`,
              })
            })
            return { clientBody, contentType: image.contentType }
          }),
        abort.signal,
      )
      ctx.status = 200
      ctx.set('Content-Type', upstream.contentType)
      ctx.set('Cache-Control', 'private, max-age=3600')
      ctx.set('X-Cache', 'MISS')
      ctx.body = upstream.clientBody
    } catch (error) {
      if (error instanceof Error && error.message === 'aborted') {
        throw new ApiError(499, 'REQUEST_CANCELLED', 'Request cancelled by client')
      }
      throw error
    }
  }
}
