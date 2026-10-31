import { Body, Controller, Delete, Get, Param, Post, Put, QueryParam, Ctx } from 'routing-controllers'
import { Container, Service } from 'typedi'
import type { Context } from 'koa'
import { envelope } from '../shared/envelope'
import { badRequest } from '../shared/errors'
import { prisma } from '../shared/prisma'
import { SourceService } from '../modules/sources/application/source.service'
import { TokenService } from '../modules/tokens/application/token.service'
import { ComicService } from '../modules/comics/application/comic.service'
import { AssetService } from '../modules/assets/application/asset.service'
import { JobService } from '../modules/jobs/application/job.service'
import { ImageCache } from '../modules/assets/infrastructure/image-cache'

@Service()
@Controller('/api/admin/v1')
export class AdminController {
  private sources = Container.get(SourceService)
  private tokens = Container.get(TokenService)
  private comics = Container.get(ComicService)
  private assets = Container.get(AssetService)
  private jobs = Container.get(JobService)
  private cache = Container.get(ImageCache)

  @Get('/overview')
  async overview(@Ctx() ctx: Context): Promise<unknown> {
    const since = new Date(Date.now() - 24 * 3600 * 1000)
    const [failedRequests, totalRequests, tokenCount, comicCount, runningJobs, cacheStats, mem] =
      await Promise.all([
        prisma.requestLog.count({
          where: { createdAt: { gte: since }, OR: [{ errorCode: { not: null } }, { status: { gte: 400 } }] },
        }),
        prisma.requestLog.count({ where: { createdAt: { gte: since } } }),
        prisma.apiToken.count({ where: { revokedAt: null } }),
        prisma.comicRef.count(),
        prisma.job.count({ where: { status: { in: ['pending', 'running'] } } }),
        this.cache.stats(),
        Promise.resolve(process.memoryUsage()),
      ])
    const sourceList = await this.sources.listAdmin()
    return envelope(ctx, {
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      sources: sourceList.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        enabled: s.enabled,
        accountPhase: s.account?.state?.phase ?? null,
        quota: s.account?.state
          ? { limit: s.account.state.limit, usage: s.account.state.usage }
          : null,
      })),
      requests24h: { total: totalRequests, failed: failedRequests },
      activeTokens: tokenCount,
      resolvedComics: comicCount,
      runningJobs,
      cache: cacheStats,
    })
  }

  @Get('/sources')
  async listSources(@Ctx() ctx: Context): Promise<unknown> {
    return envelope(ctx, { sources: await this.sources.listAdmin() })
  }

  @Put('/sources/:id')
  async updateSource(
    @Ctx() ctx: Context,
    @Param('id') id: string,
    @Body()
    body: {
      enabled?: boolean
      priority?: number
      proxy?: string | null
      timeoutMs?: number
      concurrency?: number
      config?: Record<string, unknown>
    },
  ): Promise<unknown> {
    const view = await this.sources.updateConfig(id, body ?? {})
    return envelope(ctx, { source: view })
  }

  @Get('/sources/:id/account')
  async getAccount(@Ctx() ctx: Context, @Param('id') id: string): Promise<unknown> {
    const state = await this.sources.accountState(id)
    const account = await prisma.sourceAccount.findUnique({ where: { sourceId: id } })
    return envelope(ctx, {
      account: account
        ? {
            configured: true,
            username: account.username.replace(
              /^(.{2}).*(@.*)$/,
              (_m, head: string, tail: string) => `${head}***${tail}`,
            ),
            hasPassword: account.passwordEnc !== null,
            autoLogin: account.autoLogin,
          }
        : null,
      state,
    })
  }

  @Put('/sources/:id/account')
  async saveAccount(
    @Ctx() ctx: Context,
    @Param('id') id: string,
    @Body()
    body: { username?: string; password?: string; autoLogin?: boolean; clearPassword?: boolean },
  ): Promise<unknown> {
    const view = await this.sources.saveAccount(id, {
      username: typeof body?.username === 'string' ? body.username : '',
      ...(typeof body?.password === 'string' && body.password !== ''
        ? { password: body.password }
        : {}),
      autoLogin: body?.autoLogin,
      clearPassword: body?.clearPassword === true,
    })
    // Auto-login after saving so the admin sees the result immediately.
    let state = null
    if (body?.autoLogin !== false) {
      state = await this.sources.login(id).catch((error: unknown) => ({
        phase: 'error' as const,
        nickname: '',
        message: error instanceof Error ? error.message : String(error),
        limit: null,
        usage: null,
      }))
    }
    return envelope(ctx, { account: view, state })
  }

  @Delete('/sources/:id/account')
  async deleteAccount(@Ctx() ctx: Context, @Param('id') id: string): Promise<unknown> {
    await this.sources.removeAccount(id)
    return envelope(ctx, { ok: true })
  }

  @Post('/sources/:id/login')
  async loginSource(@Ctx() ctx: Context, @Param('id') id: string): Promise<unknown> {
    const state = await this.sources.login(id)
    return envelope(ctx, { state })
  }

  @Post('/sources/:id/logout')
  async logoutSource(@Ctx() ctx: Context, @Param('id') id: string): Promise<unknown> {
    const state = await this.sources.logout(id)
    return envelope(ctx, { state })
  }

  @Post('/test/search')
  async testSearch(
    @Ctx() ctx: Context,
    @Body() body: { sourceId?: string; q?: string },
  ): Promise<unknown> {
    const q = typeof body?.q === 'string' ? body.q : ''
    if (!q.trim()) throw badRequest('q is required')
    const sourceId = body?.sourceId
    if (!sourceId) throw badRequest('sourceId is required')
    const signal = new AbortController().signal
    const result = await this.comics.search(q, sourceId, signal)
    return envelope(ctx, result)
  }

  @Post('/test/detail')
  async testDetail(
    @Ctx() ctx: Context,
    @Body() body: { provider?: string; siteId?: string; detailUrl?: string },
  ): Promise<unknown> {
    if (!body?.provider || !body?.siteId || !body?.detailUrl) {
      throw badRequest('provider, siteId and detailUrl are required')
    }
    const [comic] = await this.comics.resolve([
      { provider: body.provider, siteId: body.siteId, detailUrl: body.detailUrl },
    ])
    if (!comic) throw badRequest('resolve failed')
    const detail = await this.comics.getComic(comic.comicId)
    return envelope(ctx, detail)
  }

  @Post('/test/pages')
  async testPages(
    @Ctx() ctx: Context,
    @Body() body: { comicId?: string; chapterKey?: string },
  ): Promise<unknown> {
    if (!body?.comicId || !body?.chapterKey) {
      throw badRequest('comicId and chapterKey are required')
    }
    const data = await this.comics.pages(body.comicId, body.chapterKey, false)
    return envelope(ctx, {
      chapter: data.chapter,
      imagePolicy: data.imagePolicy,
      pages: data.pages.slice(0, 20),
      total: data.pages.length,
    })
  }

  /** Stream an asset under the admin session for browser-based verification. */
  @Get('/assets/:assetId')
  async testImage(@Ctx() ctx: Context, @Param('assetId') assetId: string): Promise<Context> {
    await this.assets.serve(ctx, assetId, ctx.state.requestId ?? '')
    // Returning ctx short-circuits routing-controllers' undefined-result 404.
    return ctx
  }

  @Get('/jobs')
  async listJobs(@Ctx() ctx: Context, @QueryParam('limit') limit?: string): Promise<unknown> {
    const take = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200)
    return envelope(ctx, { jobs: await this.jobs.listAdmin(take) })
  }

  @Get('/logs')
  async logs(
    @Ctx() ctx: Context,
    @QueryParam('limit') limit?: string,
    @QueryParam('kind') kind?: string,
    @QueryParam('sourceId') sourceId?: string,
  ): Promise<unknown> {
    const take = Math.min(Math.max(Number(limit ?? 100) || 100, 1), 500)
    const rows = await prisma.requestLog.findMany({
      where: {
        ...(kind ? { kind } : {}),
        ...(sourceId ? { sourceId } : {}),
      },
      orderBy: { id: 'desc' },
      take,
    })
    return envelope(
      ctx,
      {
        logs: rows.map((row) => ({
          id: Number(row.id),
          requestId: row.requestId,
          kind: row.kind,
          sourceId: row.sourceId,
          op: row.op,
          status: row.status,
          errorCode: row.errorCode,
          durationMs: row.durationMs,
          detail: row.detail,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      { count: rows.length },
    )
  }

  @Get('/cache')
  async cacheInfo(@Ctx() ctx: Context): Promise<unknown> {
    const [settings, stats] = await Promise.all([this.cache.settings(), this.cache.stats()])
    return envelope(ctx, { settings, stats })
  }

  @Put('/cache')
  async cacheSettings(
    @Ctx() ctx: Context,
    @Body() body: { maxBytes?: number; ttlSeconds?: number },
  ): Promise<unknown> {
    const settings = await this.cache.updateSettings({
      ...(typeof body?.maxBytes === 'number' ? { maxBytes: body.maxBytes } : {}),
      ...(typeof body?.ttlSeconds === 'number' ? { ttlSeconds: body.ttlSeconds } : {}),
    })
    return envelope(ctx, { settings, stats: await this.cache.stats() })
  }

  @Post('/cache/clear')
  async cacheClear(@Ctx() ctx: Context, @Body() body: { sourceId?: string }): Promise<unknown> {
    const removed = await this.cache.clear(body?.sourceId || undefined)
    return envelope(ctx, { removed, stats: await this.cache.stats() })
  }

  @Get('/tokens')
  async listTokens(@Ctx() ctx: Context): Promise<unknown> {
    return envelope(ctx, { tokens: await this.tokens.list() })
  }

  @Post('/tokens')
  async createToken(
    @Ctx() ctx: Context,
    @Body() body: { name?: string },
  ): Promise<unknown> {
    const name = typeof body?.name === 'string' ? body.name : ''
    // Plaintext is returned exactly once and never stored.
    const created = await this.tokens.create(name)
    return envelope(ctx, created)
  }

  @Post('/tokens/:id/revoke')
  async revokeToken(@Ctx() ctx: Context, @Param('id') id: string): Promise<unknown> {
    return envelope(ctx, { token: await this.tokens.revoke(id) })
  }

  @Delete('/tokens/:id')
  async deleteToken(@Ctx() ctx: Context, @Param('id') id: string): Promise<unknown> {
    await this.tokens.remove(id)
    return envelope(ctx, { ok: true })
  }
}
