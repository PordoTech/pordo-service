import { Service } from 'typedi'
import crypto from 'node:crypto'
import { prisma } from '../../../shared/prisma'
import { ApiError, conflict, unauthorized, badRequest } from '../../../shared/errors'
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../../../shared/crypto'
import { SESSION_COOKIE, SESSION_TTL_MS } from '../../../configs/constants'
import type { Context } from 'koa'

export interface SessionInfo {
  username: string
  csrfToken: string
  expiresAt: string
}

@Service()
export class AdminService {
  async isInitialized(): Promise<boolean> {
    return (await prisma.adminUser.count()) > 0
  }

  async setup(username: string, password: string): Promise<void> {
    if (await this.isInitialized()) {
      throw conflict('Administrator already exists', 'ADMIN_ALREADY_INITIALIZED')
    }
    this.validatePassword(password)
    await prisma.adminUser.create({
      data: {
        username: username.trim().slice(0, 64),
        passwordHash: await hashPassword(password),
      },
    })
  }

  async login(ctx: Context, username: string, password: string): Promise<SessionInfo> {
    const admin = await prisma.adminUser.findUnique({
      where: { username: username.trim() },
    })
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      throw unauthorized('Incorrect username or password', 'ADMIN_CREDENTIALS_INVALID')
    }
    return this.issueSession(ctx, admin.username)
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const admin = await prisma.adminUser.findFirst()
    if (!admin) throw new ApiError(404, 'ADMIN_NOT_INITIALIZED', 'Administrator missing')
    if (!(await verifyPassword(currentPassword, admin.passwordHash))) {
      throw unauthorized('Current password incorrect', 'ADMIN_CREDENTIALS_INVALID')
    }
    this.validatePassword(newPassword)
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: await hashPassword(newPassword) },
    })
    // Changing the password invalidates every existing session.
    await prisma.adminSession.deleteMany({})
  }

  async logout(ctx: Context): Promise<void> {
    const token = this.cookieToken(ctx)
    if (token) {
      await prisma.adminSession
        .delete({ where: { tokenHash: sha256Hex(token) } })
        .catch(() => {})
    }
    ctx.cookies.set(SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
      overwrite: true,
    })
  }

  /** Restore an existing session (page reload): re-issues the CSRF token. */
  async sessionInfo(ctx: Context): Promise<SessionInfo | null> {
    const token = this.cookieToken(ctx)
    if (!token) return null
    const session = await prisma.adminSession.findUnique({
      where: { tokenHash: sha256Hex(token) },
    })
    if (!session || session.expiresAt.getTime() < Date.now()) return null
    const admin = await prisma.adminUser.findFirst({ select: { username: true } })
    if (!admin) return null
    const csrfToken = randomToken()
    await prisma.adminSession.update({
      where: { id: session.id },
      data: { csrfHash: sha256Hex(csrfToken), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    })
    return { username: admin.username, csrfToken, expiresAt: session.expiresAt.toISOString() }
  }

  private async issueSession(ctx: Context, username: string): Promise<SessionInfo> {
    const token = randomToken()
    const csrfToken = randomToken()
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    await prisma.adminSession.create({
      data: {
        tokenHash: sha256Hex(token),
        csrfHash: sha256Hex(csrfToken),
        expiresAt,
      },
    })
    ctx.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
      secure: ctx.protocol === 'https',
      overwrite: true,
    })
    return { username, csrfToken, expiresAt: expiresAt.toISOString() }
  }

  private cookieToken(ctx: Context): string | null {
    const raw = ctx.get('cookie')
    if (!raw) return null
    for (const part of raw.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
    }
    return null
  }

  private validatePassword(password: string): void {
    if (password.length < 8 || password.length > 1024) {
      throw badRequest('Password must be 8-1024 characters')
    }
  }
}

export const purgeExpiredSessions = async (): Promise<void> => {
  await prisma.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } })
}

export const sessionTokenEntropyCheck = (): string => crypto.randomUUID()
