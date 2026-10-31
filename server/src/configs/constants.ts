import path from 'node:path'
import fs from 'node:fs'

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export const ENV_LABEL = process.env.NODE_ENV || 'development'
export const IS_TEST = ENV_LABEL === 'test'
export const PORT = envInt('PORT', 8790)
export const HOST = process.env.HOST || '127.0.0.1'

/** All runtime state lives under this directory and must never enter git. */
export const DATA_DIR =
  process.env.PORDO_DATA_DIR || path.join(__dirname, '..', '..', 'data')
export const DATABASE_URL =
  process.env.DATABASE_URL || `file:${path.join(DATA_DIR, 'pordo.db')}`
// Prisma reads process.env directly at client initialization.
process.env.DATABASE_URL = DATABASE_URL
export const MASTER_KEY_PATH =
  process.env.PORDO_MASTER_KEY_FILE || path.join(DATA_DIR, 'master.key')
export const STATIC_PATH =
  process.env.STATIC_PATH || path.join(__dirname, '..', '..', '..', 'web', 'dist')

export const SESSION_COOKIE = 'pordo_admin'
export const SESSION_TTL_MS = envInt('PORDO_SESSION_TTL_MS', 12 * 3600 * 1000)
/** Device tokens are high entropy; only their sha256 is stored. */
export const DEVICE_TOKEN_PREFIX = 'pt_'

export const UPSTREAM_USER_AGENT = 'pordo-service/0.1 comic-source'
export const DEFAULT_TIMEOUT_MS = envInt('PORDO_DEFAULT_TIMEOUT_MS', 25000)
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024
export const MAX_PAGE_IMAGES = 2000
export const MAX_CHAPTERS = 10000

export const ensureDataDir = (): void => {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}
