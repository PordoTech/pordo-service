import { Controller, Get, Post, Body, Param, QueryParam, Ctx, HttpCode } from 'routing-controllers'
import { Container, Service } from 'typedi'
import type { Context } from 'koa'
import { envelope } from '../shared/envelope'
import { badRequest } from '../shared/errors'
import { ComicService } from '../modules/comics/application/comic.service'
import { JobService, type UpdateEntry } from '../modules/jobs/application/job.service'
import { SourceService } from '../modules/sources/application/source.service'
import { ProviderRegistry } from '../modules/providers/registry'
import { ImageService, type ImageRef } from '../modules/images/application/image.service'
import { requireScope } from '../shared/middlewares'

const abortOnClose = (ctx: Context): AbortSignal => {
  const controller = new AbortController()
  ctx.res.on('close', () => {
    if (!ctx.res.writableEnded) controller.abort()
  })
  return controller.signal
}

@Service()
@Controller('/api/v1')
export class ContentController {
  private comics = Container.get(ComicService)
  private jobs = Container.get(JobService)
  private sources = Container.get(SourceService)
  private images = Container.get(ImageService)

  @Get('/sources')
  async sources_(@Ctx() ctx: Context): Promise<unknown> {
    requireScope(ctx, 'content')
    const sources = await this.sources.listEnabled()
    return envelope(ctx, { sources })
  }

  @Get('/sources/:sourceId/sites')
  async sites(@Ctx() ctx: Context, @Param('sourceId') sourceId: string): Promise<unknown> {
    requireScope(ctx, 'content')
    await this.sources.requireEnabled(sourceId)
    const provider = Container.get(ProviderRegistry).comic(sourceId)
    const config = await this.sources.contentContext(sourceId, { signal: abortOnClose(ctx) })
    return envelope(ctx, { sites: await provider.sites(config) })
  }

  @Get('/comics/search')
  async search(
    @Ctx() ctx: Context,
    @QueryParam('q') q: string,
    @QueryParam('sourceId') sourceId?: string,
  ): Promise<unknown> {
    requireScope(ctx, 'content')
    if (typeof q !== 'string' || !q.trim()) throw badRequest('q is required')
    const result = await this.comics.search(q, sourceId || undefined, abortOnClose(ctx))
    return envelope(
      ctx,
      { groups: result.groups },
      { partial: result.partial, pagination: null },
    )
  }

  @Post('/comics/resolve')
  async resolve(
    @Ctx() ctx: Context,
    @Body() body: { comics?: Array<{ provider: string; siteId: string; detailUrl: string; title?: string; coverUrl?: string }> },
  ): Promise<unknown> {
    requireScope(ctx, 'content')
    const items = body?.comics
    if (!Array.isArray(items) || items.length === 0) throw badRequest('comics is required')
    const data = await this.comics.resolve(items)
    return envelope(ctx, { comics: data })
  }

  @Post('/comics/updates/check')
  @HttpCode(202)
  async updatesCheck(@Ctx() ctx: Context, @Body() body: { entries?: UpdateEntry[] }): Promise<unknown> {
    requireScope(ctx, 'content')
    const entries = body?.entries
    if (!Array.isArray(entries)) throw badRequest('entries is required')
    const jobId = await this.jobs.createUpdatesJob(entries)
    return envelope(ctx, { jobId })
  }

  @Get('/jobs/:jobId')
  async job(@Ctx() ctx: Context, @Param('jobId') jobId: string): Promise<unknown> {
    requireScope(ctx, 'content')
    const data = await this.jobs.get(jobId)
    return envelope(ctx, data)
  }

  @Get('/comics/:comicId')
  async comic(@Ctx() ctx: Context, @Param('comicId') comicId: string): Promise<unknown> {
    requireScope(ctx, 'content')
    const data = await this.comics.getComic(comicId, abortOnClose(ctx))
    return envelope(ctx, data)
  }

  @Get('/comics/:comicId/chapters')
  async chapters(@Ctx() ctx: Context, @Param('comicId') comicId: string): Promise<unknown> {
    requireScope(ctx, 'content')
    const data = await this.comics.getComic(comicId, abortOnClose(ctx))
    return envelope(
      ctx,
      { comic: data.comic, chapters: data.chapters },
      { count: data.chapters.length },
    )
  }

  @Get('/comics/:comicId/chapters/:chapterKey/pages')
  async pages(
    @Ctx() ctx: Context,
    @Param('comicId') comicId: string,
    @Param('chapterKey') chapterKey: string,
    @QueryParam('refresh') refresh?: string,
  ): Promise<unknown> {
    requireScope(ctx, 'content')
    const data = await this.comics.pages(
      comicId,
      chapterKey,
      refresh === '1' || refresh === 'true',
      abortOnClose(ctx),
    )
    return envelope(ctx, data, { count: data.pages.length })
  }

  @Post('/images/resolve')
  async image(@Ctx() ctx: Context, @Body() body: ImageRef): Promise<unknown> {
    requireScope(ctx, 'content')
    ctx.set('Cache-Control', 'no-store')
    return envelope(ctx, await this.images.resolve(body, abortOnClose(ctx)))
  }
}
