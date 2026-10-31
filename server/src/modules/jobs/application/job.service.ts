import { Container, Service } from 'typedi'
import { prisma } from '../../../shared/prisma'
import { badRequest, notFound } from '../../../shared/errors'
import { bookKey } from '../../../shared/crypto'
import { Semaphore } from '../../../shared/scheduler'
import { logRequest } from '../../../shared/envelope'
import { ProviderRegistry } from '../../providers/registry'
import { SourceService } from '../../sources/application/source.service'
import { ComicService } from '../../comics/application/comic.service'

export interface UpdateEntry {
  provider: string
  siteId: string
  detailUrl: string
  knownChapterCount?: number
  knownLastChapterKey?: string
}

export interface UpdateResult {
  comicId: string
  provider: string
  siteId: string
  detailUrl: string
  status: 'ok' | 'error'
  chapterCount?: number
  newChapters?: number
  latestChapterKey?: string
  error?: string
}

export interface JobView {
  jobId: string
  kind: string
  status: 'pending' | 'running' | 'done' | 'partial' | 'failed'
  total: number
  completed: number
  createdAt: string
  updatedAt: string
  results?: UpdateResult[]
  error?: string | null
}

/**
 * Directory update checks run as single-process jobs with bounded
 * concurrency; state lives in SQLite so results survive restarts.
 */
@Service()
export class JobService {
  private registry = Container.get(ProviderRegistry)
  private sources = Container.get(SourceService)
  private comics = Container.get(ComicService)

  async createUpdatesJob(entries: UpdateEntry[]): Promise<string> {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw badRequest('entries is required')
    }
    if (entries.length > 200) throw badRequest('Too many entries (max 200)')
    for (const entry of entries) {
      if (!this.registry.hasComic(entry.provider)) {
        throw notFound(`Unknown provider: ${entry.provider}`, 'SOURCE_NOT_FOUND')
      }
      if (!entry.siteId || !entry.detailUrl) {
        throw badRequest('siteId and detailUrl are required for every entry')
      }
    }
    const job = await prisma.job.create({
      data: {
        kind: 'updates.check',
        status: 'pending',
        input: JSON.stringify(entries),
      },
    })
    // Background execution; the client polls GET /api/v1/jobs/{jobId}.
    void this.run(job.id, entries).catch((error) => {
      console.error(`[job ${job.id}] failed`, error instanceof Error ? error.message : error)
    })
    return job.id
  }

  private async run(jobId: string, entries: UpdateEntry[]): Promise<void> {
    await prisma.job.update({ where: { id: jobId }, data: { status: 'running' } })
    const sem = new Semaphore(4)
    const results: UpdateResult[] = []
    let completed = 0
    await Promise.all(
      entries.map((entry) =>
        sem.run(async () => {
          const comicId = bookKey(entry.provider, entry.siteId, entry.detailUrl)
          const started = Date.now()
          try {
            await prisma.comicRef.upsert({
              where: { id: comicId },
              create: {
                id: comicId,
                provider: entry.provider,
                siteId: entry.siteId,
                detailUrl: entry.detailUrl,
              },
              update: {},
            })
            const detail = await this.comics.detail(comicId, true)
            const latest = detail.chapters[detail.chapters.length - 1]
            const latestKey = latest ? latest.id || latest.url : ''
            const knownCount = entry.knownChapterCount
            const knownLast = entry.knownLastChapterKey
            let newChapters: number | undefined
            if (typeof knownCount === 'number' && Number.isFinite(knownCount)) {
              newChapters = Math.max(0, detail.chapters.length - knownCount)
            } else if (knownLast) {
              const index = detail.chapters.findIndex((c) => (c.id || c.url) === knownLast)
              newChapters = index >= 0 ? detail.chapters.length - index - 1 : undefined
            }
            results.push({
              comicId,
              provider: entry.provider,
              siteId: entry.siteId,
              detailUrl: entry.detailUrl,
              status: 'ok',
              chapterCount: detail.chapters.length,
              ...(newChapters !== undefined ? { newChapters } : {}),
              latestChapterKey: latestKey,
            })
            await logRequest({
              kind: 'job',
              sourceId: entry.provider,
              op: 'updates.check',
              status: 200,
              durationMs: Date.now() - started,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            results.push({
              comicId,
              provider: entry.provider,
              siteId: entry.siteId,
              detailUrl: entry.detailUrl,
              status: 'error',
              error: message.slice(0, 500),
            })
            await logRequest({
              kind: 'job',
              sourceId: entry.provider,
              op: 'updates.check',
              errorCode: 'UPSTREAM',
              status: 502,
              durationMs: Date.now() - started,
              detail: message,
            })
          } finally {
            completed += 1
            await prisma.job
              .update({
                where: { id: jobId },
                data: { result: JSON.stringify({ completed, total: entries.length }) },
              })
              .catch(() => {})
          }
        }),
      ),
    )
    const okCount = results.filter((r) => r.status === 'ok').length
    const status = okCount === entries.length ? 'done' : okCount === 0 ? 'failed' : 'partial'
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status,
        result: JSON.stringify({ completed: entries.length, total: entries.length, results }),
      },
    })
  }

  async get(jobId: string): Promise<JobView> {
    const job = await prisma.job.findUnique({ where: { id: jobId } })
    if (!job) throw notFound('Job not found', 'JOB_NOT_FOUND')
    let parsed: { completed?: number; total?: number; results?: UpdateResult[] } = {}
    try {
      parsed = JSON.parse(job.result) as typeof parsed
    } catch {
      parsed = {}
    }
    let inputCount = 0
    try {
      inputCount = (JSON.parse(job.input) as unknown[]).length
    } catch {
      inputCount = 0
    }
    return {
      jobId: job.id,
      kind: job.kind,
      status: job.status as JobView['status'],
      total: parsed.total ?? inputCount,
      completed: parsed.completed ?? 0,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      ...(parsed.results ? { results: parsed.results } : {}),
      error: job.error,
    }
  }

  async listAdmin(limit = 50): Promise<JobView[]> {
    const jobs = await prisma.job.findMany({ orderBy: { createdAt: 'desc' }, take: limit })
    return Promise.all(jobs.map((job) => this.get(job.id)))
  }
}
