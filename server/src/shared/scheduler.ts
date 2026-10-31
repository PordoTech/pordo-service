/** Single-process concurrency limits for source metadata and image-ticket resolution. */
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

  async acquire(abort?: AbortSignal): Promise<() => void> {
    if (abort?.aborted) throw new Error('aborted')
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const settle = (): void => { abort?.removeEventListener('abort', onAbort); resolve() }
        const onAbort = (): void => {
          const index = this.queue.indexOf(settle)
          if (index >= 0) this.queue.splice(index, 1)
          reject(new Error('aborted'))
        }
        this.queue.push(settle)
        abort?.addEventListener('abort', onAbort, { once: true })
      })
      if (abort?.aborted) { this.queue.shift()?.(); throw new Error('aborted') }
    }
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.queue.shift()?.()
    }
  }

  async run<T>(task: (signal: { aborted: boolean }) => Promise<T>, abort?: AbortSignal): Promise<T> {
    const release = await this.acquire(abort)
    try { return await task({ aborted: abort?.aborted ?? false }) }
    finally { release() }
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
