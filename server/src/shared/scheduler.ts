/**
 * Single-process scheduler: per-context concurrency limits plus in-flight
 * deduplication, so all devices share upstream quotas and identical image
 * requests are never fetched twice at the same time.
 */
export class Semaphore {
  private queue: Array<() => void> = []
  private active = 0

  constructor(private readonly limit: number) {}

  get pending(): number {
    return this.queue.length
  }

  get running(): number {
    return this.active
  }

  async run<T>(task: (signal: { aborted: boolean }) => Promise<T>, abort?: AbortSignal): Promise<T> {
    if (abort?.aborted) throw new Error('aborted')
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const settle = (): void => {
          abort?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          const index = this.queue.indexOf(settle)
          if (index >= 0) this.queue.splice(index, 1)
          reject(new Error('aborted'))
        }
        this.queue.push(settle)
        abort?.addEventListener('abort', onAbort, { once: true })
      })
    }
    this.active += 1
    try {
      return await task({ aborted: abort?.aborted ?? false })
    } finally {
      this.active -= 1
      this.queue.shift()?.()
    }
  }
}

/**
 * In-flight map: concurrent identical requests share one promise. Keys must
 * include the source/account context so results never cross account
 * boundaries.
 */
export class InFlight {
  private map = new Map<string, Promise<unknown>>()

  async dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key)
    if (existing) return existing as Promise<T>
    const promise = task().finally(() => {
      if (this.map.get(key) === promise) this.map.delete(key)
    })
    this.map.set(key, promise)
    return promise
  }

  get size(): number {
    return this.map.size
  }
}

const semaphores = new Map<string, Semaphore>()

export const semaphoreFor = (context: string, limit: number): Semaphore => {
  let sem = semaphores.get(context)
  if (!sem || (sem as Semaphore & { _limit?: number })._limit !== limit) {
    sem = new Semaphore(limit)
    Object.defineProperty(sem, '_limit', { value: limit })
    semaphores.set(context, sem)
  }
  return sem
}

export const inFlight = new InFlight()
