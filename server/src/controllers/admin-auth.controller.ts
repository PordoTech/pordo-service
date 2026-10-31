import { Body, Controller, Get, Post, Ctx } from 'routing-controllers'
import { Container, Service } from 'typedi'
import type { Context } from 'koa'
import { envelope } from '../shared/envelope'
import { badRequest } from '../shared/errors'
import { AdminService } from '../modules/admin/application/admin.service'

@Service()
@Controller('/api/admin/v1')
export class AdminAuthController {
  private admin = Container.get(AdminService)

  @Get('/healthz')
  async healthz(@Ctx() ctx: Context): Promise<unknown> {
    ctx.status = 200
    return envelope(ctx, {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      initialized: await this.admin.isInitialized(),
    })
  }

  @Get('/session')
  async session(@Ctx() ctx: Context): Promise<unknown> {
    const info = await this.admin.sessionInfo(ctx)
    return envelope(ctx, {
      initialized: await this.admin.isInitialized(),
      session: info
        ? { username: info.username, csrfToken: info.csrfToken, expiresAt: info.expiresAt }
        : null,
    })
  }

  @Post('/setup')
  async setup(
    @Ctx() ctx: Context,
    @Body() body: { username?: string; password?: string },
  ): Promise<unknown> {
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!username.trim()) throw badRequest('username is required')
    await this.admin.setup(username, password)
    // Auto-login right after initialization for a smooth first run.
    const session = await this.admin.login(ctx, username, password)
    return envelope(ctx, { session })
  }

  @Post('/login')
  async login(
    @Ctx() ctx: Context,
    @Body() body: { username?: string; password?: string },
  ): Promise<unknown> {
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!username || !password) throw badRequest('username and password are required')
    const session = await this.admin.login(ctx, username, password)
    return envelope(ctx, { session })
  }

  @Post('/logout')
  async logout(@Ctx() ctx: Context): Promise<unknown> {
    await this.admin.logout(ctx)
    return envelope(ctx, { ok: true })
  }

  @Post('/password')
  async password(
    @Ctx() ctx: Context,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ): Promise<unknown> {
    const current = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    const next = typeof body?.newPassword === 'string' ? body.newPassword : ''
    await this.admin.changePassword(current, next)
    return envelope(ctx, { ok: true })
  }
}
