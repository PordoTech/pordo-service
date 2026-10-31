import crypto from 'node:crypto'
import fs from 'node:fs'
import { MASTER_KEY_PATH, ensureDataDir } from '../configs/constants'

/**
 * Master key management. The key is independent from the database: it lives in
 * a restricted file (0600) or a deployment secret. Backups must keep both the
 * database and this key to remain restorable.
 */
let masterKeyCache: Buffer | null = null

export const getMasterKey = (): Buffer => {
  if (masterKeyCache) return masterKeyCache
  const fromEnv = process.env.PORDO_MASTER_KEY
  if (fromEnv && fromEnv.length >= 32) {
    masterKeyCache = Buffer.from(fromEnv, 'utf8')
    return masterKeyCache
  }
  ensureDataDir()
  if (fs.existsSync(MASTER_KEY_PATH)) {
    const key = fs.readFileSync(MASTER_KEY_PATH)
    if (key.length !== 32) throw new Error('master key file must contain 32 bytes')
    masterKeyCache = key
    return masterKeyCache
  }
  const key = crypto.randomBytes(32)
  fs.writeFileSync(MASTER_KEY_PATH, key, { mode: 0o600 })
  fs.chmodSync(MASTER_KEY_PATH, 0o600)
  masterKeyCache = key
  return key
}

/** Test hook: forget the cached key (e.g. after changing PORDO_MASTER_KEY). */
export const resetMasterKeyCache = (): void => {
  masterKeyCache = null
}

const deriveKey = (salt: Buffer, info: string): Buffer =>
  crypto.createHmac('sha256', Buffer.concat([getMasterKey(), salt])).update(info).digest()

export const sha256Hex = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex')

export const digest = (value: string): string => sha256Hex(value)

/** AES-256-GCM encryption for upstream account passwords at rest. */
export const encryptSecret = (plaintext: string): string => {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(salt, 'pordo/secret-box/v1')
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${salt.toString('base64url')}.${iv.toString('base64url')}.${data.toString('base64url')}.${tag.toString('base64url')}`
}

export const decryptSecret = (encoded: string): string => {
  const parts = encoded.split('.')
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('invalid secret box')
  const [, salt, iv, data, tag] = parts as [string, string, string, string, string]
  const saltBuf = Buffer.from(salt, 'base64url')
  const key = deriveKey(saltBuf, 'pordo/secret-box/v1')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** HMAC-signed, deterministic asset ids; unforgeable without the master key. */
export const signAsset = (payload: string): string => {
  const mac = crypto
    .createHmac('sha256', deriveKey(Buffer.alloc(16, 7), 'pordo/asset-id/v1'))
    .update(payload)
    .digest()
    .subarray(0, 16)
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac.toString('base64url')}`
}

export const verifyAsset = (signed: string): string | null => {
  const index = signed.lastIndexOf('.')
  if (index <= 0) return null
  const payload = signed.slice(0, index)
  const expected = signAsset(Buffer.from(payload, 'base64url').toString('utf8'))
  const a = Buffer.from(expected)
  const b = Buffer.from(signed)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
    ? Buffer.from(payload, 'base64url').toString('utf8')
    : null
}

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.randomBytes(16)
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [N, r, p, salt, hash] = parts.slice(1) as [string, string, string, string, string]
  const expected = Buffer.from(hash, 'base64url')
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      Buffer.from(salt, 'base64url'),
      expected.length,
      { N: Number(N), r: Number(r), p: Number(p) },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
  return crypto.timingSafeEqual(expected, derived)
}

export const randomToken = (prefix = ''): string =>
  `${prefix}${crypto.randomBytes(32).toString('base64url')}`

export const randomId = (): string => crypto.randomUUID()

/** Stable content identity, identical to the client's Book.key. */
export const bookKey = (provider: string, siteId: string, detailUrl: string): string =>
  sha256Hex(`${provider}\u0000${siteId}\u0000${detailUrl}`)
