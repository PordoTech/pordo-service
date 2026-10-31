import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { Service } from 'typedi'
import { prisma } from '../../../shared/prisma'
import { sha256Hex } from '../../../shared/crypto'
import { IMAGE_CACHE_DIR } from '../../../configs/constants'

/**
 * Bounded on-disk image cache. Originals stream through to clients (never
 * fully buffered in RAM); entries are isolated per source/account context and
 * evicted by TTL + LRU under the configured size cap.
 */
@Service()
export class ImageCache {
  private dir(): string {
    fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true })
    return IMAGE_CACHE_DIR
  }

  entryId(sourceId: string, contextId: string, url: string): string {
    return sha256Hex(`${sourceId}\u0000${contextId}\u0000${url}`)
  }

  private pathFor(id: string): string {
    return path.join(this.dir(), id.slice(0, 2), id)
  }

  async settings(): Promise<{ maxBytes: number; ttlSeconds: number }> {
    const row = await prisma.cacheSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    })
    return { maxBytes: row.maxBytes, ttlSeconds: row.ttlSeconds }
  }

  async updateSettings(update: { maxBytes?: number; ttlSeconds?: number }): Promise<{
    maxBytes: number
    ttlSeconds: number
  }> {
    const data: Record<string, number> = {}
    if (update.maxBytes !== undefined) {
      data.maxBytes = Math.min(2_147_483_647, Math.max(0, Math.trunc(update.maxBytes)))
    }
    if (update.ttlSeconds !== undefined) {
      data.ttlSeconds = Math.max(60, Math.trunc(update.ttlSeconds))
    }
    const row = await prisma.cacheSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data },
      update: data,
    })
    if (update.maxBytes !== undefined) await this.enforceCap(row.maxBytes)
    return { maxBytes: row.maxBytes, ttlSeconds: row.ttlSeconds }
  }

  /** Return a readable stream for a fresh (non-expired) entry, or null. */
  async read(id: string): Promise<{ body: Readable; contentType: string; size: number } | null> {
    const entry = await prisma.cacheEntry.findUnique({ where: { id } })
    if (!entry) return null
    if (entry.expiresAt && entry.expiresAt.getTime() < Date.now()) {
      await this.remove(id)
      return null
    }
    const file = this.pathFor(id)
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile()) {
        await this.remove(id)
        return null
      }
      prisma.cacheEntry
        .update({
          where: { id },
          data: { lastUsedAt: new Date(), hits: { increment: 1 } },
        })
        .catch(() => {})
      return {
        body: fs.createReadStream(file),
        contentType: entry.contentType || 'application/octet-stream',
        size: stat.size,
      }
    } catch {
      await this.remove(id)
      return null
    }
  }

  /**
   * Stream upstream bytes to the caller while persisting a copy. The client
   * stream ends only after persistence finishes, so the next request is a
   * guaranteed HIT. Disk failures never break the client stream.
   */
  write(
    id: string,
    source: Readable,
    meta: { sourceId: string; contextId: string; url: string; contentType: string; ttlSeconds: number },
  ): { clientBody: Readable; done: Promise<number | null> } {
    const file = this.pathFor(id)
    const clientBody = new PassThrough()
    const done = (async (): Promise<number | null> => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      const out = fs.createWriteStream(tmp)
      let size = 0
      let fileBroken = false
      out.on('error', () => {
        fileBroken = true
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const pump = (): void => {
            if (out.writableNeedDrain || clientBody.writableNeedDrain) source.pause()
          }
          const resume = (): void => {
            if (!out.writableNeedDrain && !clientBody.writableNeedDrain) source.resume()
          }
          out.on('drain', resume)
          clientBody.on('drain', resume)
          source.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (!fileBroken && !out.write(chunk)) pump()
            if (!clientBody.write(chunk)) pump()
          })
          source.on('end', () => resolve())
          source.on('error', reject)
          clientBody.on('error', () => {
            // Client went away; keep persisting but stop delivering.
          })
        })
        await new Promise<void>((resolve) => out.end(() => resolve()))
        if (fileBroken) {
          await fsp.unlink(tmp).catch(() => {})
          return null
        }
        await fsp.rename(tmp, file)
        const expiresAt = new Date(Date.now() + meta.ttlSeconds * 1000)
        await prisma.cacheEntry.upsert({
          where: { id },
          create: {
            id,
            path: path.relative(this.dir(), file),
            size,
            sourceId: meta.sourceId,
            contextId: meta.contextId,
            contentType: meta.contentType,
            expiresAt,
          },
          update: {
            path: path.relative(this.dir(), file),
            size,
            sourceId: meta.sourceId,
            contextId: meta.contextId,
            contentType: meta.contentType,
            expiresAt,
            lastUsedAt: new Date(),
          },
        })
        // Eviction is best-effort housekeeping; never delays the client stream.
        void this.enforceCap().catch(() => {})
        return size
      } catch {
        await fsp.unlink(tmp).catch(() => {})
        return null
      }
    })()
    // End the client stream only after persistence completes, so a subsequent
    // request is guaranteed to see a cache HIT once this response finishes.
    // Bytes still flow through in real time; only the tail is delayed.
    void done.then(() => clientBody.end())
    source.on('error', (error) => clientBody.destroy(error))
    return { clientBody, done }
  }

  async remove(id: string): Promise<void> {
    const file = this.pathFor(id)
    await fsp.unlink(file).catch(() => {})
    await prisma.cacheEntry.deleteMany({ where: { id } }).catch(() => {})
  }

  async stats(): Promise<{ entries: number; bytes: number; hits: number }> {
    const agg = await prisma.cacheEntry.aggregate({
      _count: { id: true },
      _sum: { size: true, hits: true },
    })
    return {
      entries: agg._count.id ?? 0,
      bytes: agg._sum.size ?? 0,
      hits: agg._sum.hits ?? 0,
    }
  }

  async clear(sourceId?: string): Promise<number> {
    const where = sourceId ? { sourceId } : {}
    const entries = await prisma.cacheEntry.findMany({ where, select: { id: true } })
    for (const entry of entries) {
      await fsp.unlink(this.pathFor(entry.id)).catch(() => {})
    }
    const result = await prisma.cacheEntry.deleteMany({ where })
    return result.count
  }

  /** Remove expired entries, then evict LRU until under the cap. */
  async enforceCap(maxBytes?: number): Promise<void> {
    const cap = maxBytes ?? (await this.settings()).maxBytes
    await prisma.cacheEntry.deleteMany({
      where: { expiresAt: { not: null, lt: new Date() } },
    })
    let total = (await prisma.cacheEntry.aggregate({ _sum: { size: true } }))._sum.size ?? 0
    if (total <= cap) return
    const batch = 200
    while (total > cap) {
      const oldest = await prisma.cacheEntry.findMany({
        orderBy: { lastUsedAt: 'asc' },
        take: batch,
        select: { id: true, size: true },
      })
      if (oldest.length === 0) break
      for (const entry of oldest) {
        await fsp.unlink(this.pathFor(entry.id)).catch(() => {})
        total -= entry.size
      }
      await prisma.cacheEntry.deleteMany({
        where: { id: { in: oldest.map((e) => e.id) } },
      })
    }
  }
}
