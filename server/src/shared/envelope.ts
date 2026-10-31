import type { Context } from 'koa'
import { prisma } from './prisma'
import { redactMessage } from './errors'

/** Success envelope: data/meta/requestId on every JSON response. */
export const envelope = <T>(ctx: Context, data: T, meta?: Record<string, unknown>): unknown => ({
  data,
  ...(meta ? { meta } : {}),
  requestId: ctx.state?.requestId ?? '',
})

export interface LogEntry {
  requestId?: string
  kind: 'api' | 'upstream' | 'job'
  sourceId?: string | null
  op: string
  status?: number | null
  errorCode?: string | null
  durationMs: number
  detail?: string | null
}

/** Persist a bounded, redacted request log for the admin jobs/logs page. */
export const logRequest = async (entry: LogEntry): Promise<void> => {
  try {
    await prisma.requestLog.create({
      data: {
        requestId: entry.requestId ?? '',
        kind: entry.kind,
        sourceId: entry.sourceId ?? null,
        op: entry.op,
        status: entry.status ?? null,
        errorCode: entry.errorCode ?? null,
        durationMs: entry.durationMs,
        detail: entry.detail ? redactMessage(entry.detail).slice(0, 2000) : null,
      },
    })
  } catch {
    // Logging must never break a request.
  }
}

export const trimLogs = async (keep = 5000): Promise<void> => {
  try {
    const count = await prisma.requestLog.count()
    if (count <= keep) return
    const cutoff = await prisma.requestLog.findMany({
      orderBy: { id: 'desc' },
      skip: keep,
      take: 1,
      select: { id: true },
    })
    const last = cutoff[0]
    if (last) await prisma.requestLog.deleteMany({ where: { id: { lte: last.id } } })
  } catch {
    // best effort
  }
}
