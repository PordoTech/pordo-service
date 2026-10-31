import 'reflect-metadata'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import fs from 'node:fs'
import path from 'node:path'
import { Container } from 'typedi'
import { useContainer, useKoaServer } from 'routing-controllers'
import { prisma } from '../shared/prisma'
import {
  requestIdMiddleware,
  errorMiddleware,
  adminAuthMiddleware,
  bearerAuthMiddleware,
  apiLogMiddleware,
} from '../shared/middlewares'
import { trimLogs } from '../shared/envelope'
import { ensureDataDir, STATIC_PATH } from './constants'
import { ProviderRegistry, seedSources } from '../modules/providers/registry'
import { SourceService } from '../modules/sources/application/source.service'
import { ComicService } from '../modules/comics/application/comic.service'
import { ImageCache } from '../modules/assets/infrastructure/image-cache'
import { AdminAuthController } from '../controllers/admin-auth.controller'
import { AdminController } from '../controllers/admin.controller'
import { ContentController } from '../controllers/content.controller'
import { AssetController } from '../controllers/asset.controller'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.yaml': 'text/yaml; charset=utf-8',
}

const OPENAPI_PATH = path.join(__dirname, '..', '..', '..', 'contracts', 'openapi.yaml')

const serveStaticAndDocs = (app: Koa): void => {
  app.use(async (ctx, next) => {
    if (ctx.method !== 'GET') return next()
    if (ctx.path === '/openapi.yaml' || ctx.path === '/api/openapi.yaml') {
      if (fs.existsSync(OPENAPI_PATH)) {
        ctx.type = 'text/yaml; charset=utf-8'
        ctx.body = fs.createReadStream(OPENAPI_PATH)
        return
      }
    }
    if (ctx.path.startsWith('/api/')) return next()
    if (!fs.existsSync(STATIC_PATH)) return next()
    const resolved = path.join(STATIC_PATH, ctx.path)
    if (!resolved.startsWith(STATIC_PATH)) return next()
    const tryServe = async (filePath: string): Promise<boolean> => {
      const stats = await fs.promises.stat(filePath).catch(() => null)
      if (!stats?.isFile()) return false
      const ext = path.extname(filePath).toLowerCase()
      if (MIME_TYPES[ext]) ctx.type = MIME_TYPES[ext]
      if (ext === '.html') ctx.set('Cache-Control', 'no-cache')
      else ctx.set('Cache-Control', 'public, max-age=2592000')
      ctx.body = fs.createReadStream(filePath)
      return true
    }
    if (await tryServe(resolved)) return
    if (await tryServe(path.join(STATIC_PATH, 'index.html'))) return
    return next()
  })
}

export interface ServerHandle {
  app: Koa
  stop: () => Promise<void>
}

export const createServer = async (): Promise<ServerHandle> => {
  ensureDataDir()
  await prisma.$connect()

  const registry = Container.get(ProviderRegistry)
  await seedSources(registry)
  const sources = Container.get(SourceService)
  await sources.applyAllAccounts()

  const koa = new Koa({ proxy: true })
  koa.use(errorMiddleware)
  koa.use(requestIdMiddleware)
  koa.use(bodyParser({ enableTypes: ['json'], jsonLimit: '2mb' }))
  koa.use(adminAuthMiddleware)
  koa.use(bearerAuthMiddleware)
  koa.use(apiLogMiddleware)
  serveStaticAndDocs(koa)

  useContainer(Container)
  useKoaServer<Koa>(koa, {
    controllers: [AdminAuthController, AdminController, ContentController, AssetController],
    validation: false,
    // Let errors bubble to errorMiddleware for the JSON envelope; the
    // built-in handler would emit non-envelope bodies.
    defaultErrorHandler: false,
    defaults: { nullResultCode: 404 },
  })

  koa.on('error', (err: Error & { code?: string }, ctx) => {
    if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') return
    console.error('[koa.app.error]', err?.message, { url: ctx?.originalUrl || ctx?.url })
  })

  // Housekeeping: log trimming, cache expiry and detail-cache pruning.
  const comics = Container.get(ComicService)
  const cache = Container.get(ImageCache)
  const timer = setInterval(() => {
    comics.pruneDetailCache()
    void trimLogs()
    void cache.enforceCap().catch(() => {})
  }, 10 * 60 * 1000)
  timer.unref()

  return {
    app: koa,
    stop: async () => {
      clearInterval(timer)
      await prisma.$disconnect()
    },
  }
}

export default createServer
