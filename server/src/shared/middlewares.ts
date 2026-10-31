import type { Context, Middleware } from 'koa'
import crypto from 'node:crypto'
import { ApiError, asApiError, unauthorized, forbidden } from './errors'
import { prisma } from './prisma'
import { logRequest } from './envelope'
import { SESSION_COOKIE, DEVICE_TOKEN_PREFIX } from '../configs/constants'
import { sha256Hex } from './crypto'

export interface AdminPrincipal {
  adminId: string
  username: string
}

export interface DevicePrincipal {
  tokenId: string
  name: string
  scopes: string[]
}

declare module 'koa' {
  interface DefaultState {
    requestId?: string
    admin?: AdminPrincipal
    device?: DevicePrincipal
  }
}

export const requestIdMiddleware: Middleware = async (ctx, next) => {
  const incoming = ctx.get('x-request-id').trim()
  const requestId =
    incoming && incoming.length <= 128 && /^[\w.-]+$/.test(incoming)
      ? incoming
      : crypto.randomUUID()
  ctx.state.requestId = requestId
  ctx.set('X-Request-Id', requestId)
  await next()
}

export const errorMiddleware: Middleware = async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    const apiError = asApiError(error)
    ctx.status = apiError.status === 499 ? 400 : apiError.status
    // 500s are logged internally but surfaced generically to callers.
    if (apiError.status >= 500) {
      console.error(
        `[${ctx.state.requestId}] ${ctx.method} ${ctx.path}`,
        apiError.message,
        error instanceof Error ? error.stack : '',
      )
    }
    const payload =
      apiError.code === 'INTERNAL'
        ? new ApiError(500, 'INTERNAL', 'Internal error').toJSON()
        : apiError.toJSON()
    ctx.body = {
      error: payload,
      requestId: ctx.state.requestId ?? '',
    }
  }
}

const readSessionCookie = (ctx: Context): string | null => {
  const raw = ctx.get('cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}

const ADMIN_OPEN_PATHS = new Set([
  '/api/admin/v1/setup',
  '/api/admin/v1/login',
  '/api/admin/v1/session',
  '/api/admin/v1/healthz',
])

export const adminAuthMiddleware: Middleware = async (ctx, next) => {
  if (!ctx.path.startsWith('/api/admin/')) return next()
  if (ctx.method === 'OPTIONS' || ADMIN_OPEN_PATHS.has(ctx.path)) return next()

  const token = readSessionCookie(ctx)
  if (!token) throw unauthorized('Admin session required', 'SESSION_EXPIRED')
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: sha256Hex(token) },
  })
  if (!session || session.expiresAt.getTime() < Date.now()) {
    if (session) await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {})
    throw unauthorized('Admin session expired', 'SESSION_EXPIRED')
  }

  // CSRF: double-submit header verified against the session row, plus a
  // same-origin check. Cookie is SameSite=Lax and httpOnly.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) {
    const csrf = ctx.get('x-csrf-token')
    const origin = ctx.get('origin')
    const sameOrigin = !origin || origin === `${ctx.protocol}://${ctx.host}`
    if (!csrf || sha256Hex(csrf) !== session.csrfHash || !sameOrigin) {
      throw forbidden('CSRF validation failed', 'CSRF_INVALID')
    }
  }

  const admin = await prisma.adminUser.findFirst({ select: { id: true, username: true } })
  if (!admin) throw unauthorized('Admin account missing', 'SESSION_EXPIRED')
  ctx.state.admin = { adminId: admin.id, username: admin.username }
  await next()
}

export const bearerAuthMiddleware: Middleware = async (ctx, next) => {
  if (!ctx.path.startsWith('/api/v1/')) return next()
  const header = ctx.get('authorization')
  if (!header.startsWith('Bearer ')) {
    throw unauthorized('Device token required', 'TOKEN_INVALID')
  }
  const token = header.slice('Bearer '.length).trim()
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) {
    throw unauthorized('Device token malformed', 'TOKEN_INVALID')
  }
  const record = await prisma.apiToken.findUnique({ where: { tokenHash: sha256Hex(token) } })
  if (!record) throw unauthorized('Device token invalid', 'TOKEN_INVALID')
  if (record.revokedAt) throw unauthorized('Device token revoked', 'TOKEN_REVOKED')
  ctx.state.device = {
    tokenId: record.id,
    name: record.name,
    scopes: record.scopes.split(',').filter(Boolean),
  }
  // Fire-and-forget; never block content reads on the write.
  prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})
  await next()
}

export const requireScope = (ctx: Context, scope: string): void => {
  if (!ctx.state.device?.scopes.includes(scope)) {
    throw new ApiError(403, 'FORBIDDEN', `Token lacks scope: ${scope}`)
  }
}

/**
 * Bounded request log for the content API (admin logs page / overview
 * counters). Query strings are never persisted; asset streams log their own
 * cache hit/miss entries, so they are skipped here.
 */
export const apiLogMiddleware: Middleware = async (ctx, next) => {
  if (!ctx.path.startsWith('/api/v1/') || ctx.path.startsWith('/api/v1/assets/')) {
    return next()
  }
  const started = Date.now()
  const sourceId = typeof ctx.query.sourceId === 'string' ? ctx.query.sourceId : null
  const op = `${ctx.method} ${ctx.path}`
  const requestId = ctx.state.requestId ?? ''
  try {
    await next()
    void logRequest({
      requestId,
      kind: 'api',
      sourceId,
      op,
      status: ctx.status,
      errorCode: ctx.status >= 400 ? `HTTP_${ctx.status}` : null,
      durationMs: Date.now() - started,
    })
  } catch (error) {
    const apiError = asApiError(error)
    void logRequest({
      requestId,
      kind: 'api',
      sourceId,
      op,
      status: apiError.status === 499 ? 400 : apiError.status,
      errorCode: apiError.code,
      durationMs: Date.now() - started,
    })
    throw error
  }
}
