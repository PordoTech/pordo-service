import { Container, Service } from 'typedi'
import { badRequest } from '../../../shared/errors'
import { httpUrl } from '../../../shared/http'
import { semaphoreFor } from '../../../shared/scheduler'
import { ProviderRegistry } from '../../providers/registry'
import { SourceService } from '../../sources/application/source.service'
import type { ImageAccess } from '../../providers/types'

export interface ImageRef { provider: string; siteId: string; url: string }

/** Resolves third-party URLs and scoped image tickets, never image bytes. */
@Service()
export class ImageService {
  private registry = Container.get(ProviderRegistry)
  private sources = Container.get(SourceService)

  async resolve(ref: ImageRef, signal?: AbortSignal): Promise<ImageAccess> {
    if (!ref || typeof ref.provider !== 'string' || typeof ref.siteId !== 'string' || !ref.siteId || typeof ref.url !== 'string') {
      throw badRequest('provider, siteId and url are required')
    }
    httpUrl(ref.url)
    const id = ref.provider || 'mangayun'
    await this.sources.requireEnabled(id)
    const runtime = await this.registry.runtime(id)
    const context = await this.sources.contentContext(id, { siteId: ref.siteId, signal })
    const access = await semaphoreFor(`image:${id}:${context.contextId}`, Math.min(runtime.concurrency, id === 'komiic' ? 2 : runtime.concurrency))
      .run(() => this.registry.comic(id).imageAccess(ref.url, context), signal)
    httpUrl(access.url)
    return access
  }
}
