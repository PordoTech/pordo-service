import { Controller, Get, Param, Ctx } from 'routing-controllers'
import { Container, Service } from 'typedi'
import type { Context } from 'koa'
import { AssetService } from '../modules/assets/application/asset.service'
import { requireScope } from '../shared/middlewares'

/**
 * Asset streaming: real image bytes, never a JSON envelope. Cache status is
 * exposed via X-Cache for measurement.
 */
@Service()
@Controller('/api/v1/assets')
export class AssetController {
  private assets = Container.get(AssetService)

  @Get('/:assetId')
  async get(@Ctx() ctx: Context, @Param('assetId') assetId: string): Promise<Context> {
    requireScope(ctx, 'content')
    await this.assets.serve(ctx, assetId, ctx.state.requestId ?? '')
    // Returning ctx short-circuits routing-controllers' undefined-result 404.
    return ctx
  }
}
