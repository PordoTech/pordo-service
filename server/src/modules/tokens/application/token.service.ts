import { Service } from 'typedi'
import { prisma } from '../../../shared/prisma'
import { badRequest, notFound } from '../../../shared/errors'
import { randomToken, sha256Hex } from '../../../shared/crypto'
import { DEVICE_TOKEN_PREFIX } from '../../../configs/constants'

export interface TokenRecord {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

const toRecord = (row: {
  id: string
  name: string
  prefix: string
  scopes: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}): TokenRecord => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: row.scopes.split(',').filter(Boolean),
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
})

@Service()
export class TokenService {
  async list(): Promise<TokenRecord[]> {
    const rows = await prisma.apiToken.findMany({ orderBy: { createdAt: 'desc' } })
    return rows.map(toRecord)
  }

  /** Creates a device token; the plaintext is returned exactly once. */
  async create(name: string, scopes: string[] = ['content']): Promise<TokenRecord & { token: string }> {
    const cleanName = name.trim().slice(0, 64)
    if (!cleanName) throw badRequest('Token name is required')
    const cleanScopes = scopes.length ? scopes : ['content']
    for (const scope of cleanScopes) {
      if (scope !== 'content') throw badRequest(`Unsupported scope: ${scope}`)
    }
    const token = randomToken(DEVICE_TOKEN_PREFIX)
    const row = await prisma.apiToken.create({
      data: {
        name: cleanName,
        tokenHash: sha256Hex(token),
        prefix: token.slice(0, DEVICE_TOKEN_PREFIX.length + 6),
        scopes: cleanScopes.join(','),
      },
    })
    return { ...toRecord(row), token }
  }

  async revoke(id: string): Promise<TokenRecord> {
    const row = await prisma.apiToken.findUnique({ where: { id } })
    if (!row) throw notFound('Token not found')
    const updated = await prisma.apiToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    })
    return toRecord(updated)
  }

  async remove(id: string): Promise<void> {
    const result = await prisma.apiToken.deleteMany({ where: { id } })
    if (result.count === 0) throw notFound('Token not found')
  }
}
