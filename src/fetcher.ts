import type { FileInput, RunOptions } from './types'

/** The bytes received don't match the file's declared `size`. */
export class SizeMismatchError extends Error {
  constructor(public file: string, public expected: number, public received: number, public short: boolean) {
    super(`"${file}": expected ${expected} bytes, got ${short ? received : `more than ${expected}`}`)
    this.name = 'SizeMismatchError'
  }
}

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url.split('?')[0]}`)
    this.name = 'HttpError'
  }
}

/**
 * Bounds the bytes held in memory for files fetched ahead of the writer.
 * The file at the head of the queue is never blocked, so the writer always makes progress.
 */
export class ByteBudget {
  used = 0
  head = 0
  private waiters: (() => void)[] = []
  constructor(public max: number) {}

  async acquire(n: number, index: number, signal: AbortSignal) {
    while (!(index <= this.head || this.used === 0 || this.used + n <= this.max)) {
      await new Promise<void>((r) => this.waiters.push(r))
      signal.throwIfAborted()
    }
    this.used += n
  }
  release(n: number) {
    this.used -= n
    this.wake()
  }
  setHead(i: number) {
    this.head = i
    this.wake()
  }
  wake() {
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }
  /** Wait until `cond` holds, re-checking on every budget change. */
  async until(cond: () => boolean, signal: AbortSignal) {
    while (!cond()) {
      await new Promise<void>((r) => this.waiters.push(r))
      signal.throwIfAborted()
    }
  }
}

/** Chunks of one file, produced by a fetcher and consumed in order by the writer. */
export class Slot {
  private chunks: Uint8Array[] = []
  private done = false
  private error: unknown
  private notify?: () => void
  push(c: Uint8Array) {
    this.chunks.push(c)
    this.notify?.()
  }
  end() {
    this.done = true
    this.notify?.()
  }
  fail(e: unknown) {
    this.error = e ?? new Error('Unknown error')
    this.notify?.()
  }
  async *drain(budget: ByteBudget): AsyncGenerator<Uint8Array> {
    for (;;) {
      const c = this.chunks.shift()
      if (c) {
        budget.release(c.length)
        yield c
        continue
      }
      if (this.error !== undefined) throw this.error
      if (this.done) return
      await new Promise<void>((r) => (this.notify = r))
      this.notify = undefined
    }
  }
  /** Drop buffered data (after cancel). */
  discard(budget: ByteBudget) {
    for (const c of this.chunks) budget.release(c.length)
    this.chunks = []
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)), { once: true })
  })

function retryable(e: unknown, canResign: boolean): boolean {
  if (e instanceof HttpError) {
    const s = e.status
    return s === 408 || s === 425 || s === 429 || s >= 500 || (canResign && (s === 401 || s === 403))
  }
  // A body that ended early is retried from where it stopped.
  if (e instanceof SizeMismatchError) return e.short
  // fetch() network failures and broken bodies surface as TypeError
  return e instanceof TypeError
}

interface Opened {
  body: ReadableStream<Uint8Array> | null
  /** Leading bytes to drop (server ignored our Range header). */
  skip: number
}

async function open(
  file: FileInput,
  offset: number,
  attempt: number,
  opts: RunOptions,
  signal: AbortSignal,
): Promise<Opened> {
  if (file.blob) return { body: file.blob.slice(offset).stream(), skip: 0 }
  const url = opts.getUrl ? await opts.getUrl(file, attempt) : file.url
  if (!url) throw new Error(`File "${file.name}" has no url or blob`)
  const headers = new Headers(opts.fetchInit?.headers)
  if (offset > 0) headers.set('Range', `bytes=${offset}-`)
  const res = await (opts.fetch ?? fetch)(url, { ...opts.fetchInit, headers, signal })
  if (!res.ok) throw new HttpError(res.status, url)
  let skip = 0
  if (offset > 0) {
    const m = res.status === 206 && /bytes (\d+)-/.exec(res.headers.get('Content-Range') ?? '')
    const start = m ? Number(m[1]) : 0
    if (start > offset) throw new Error(`Bad Content-Range for ${url}`)
    skip = offset - start
  }
  return { body: res.body, skip }
}

/**
 * Starts `concurrency` fetchers over files[start..]. Each file's bytes land in a Slot;
 * the writer reads slots in index order. Retries continue from the last byte received
 * using a Range request, so a dropped connection never duplicates or loses data.
 */
export function startFetchers(
  files: FileInput[],
  start: number,
  budget: ByteBudget,
  opts: RunOptions,
  signal: AbortSignal,
) {
  const slots = new Map<number, Slot>()
  const slot = (i: number) => {
    let s = slots.get(i)
    if (!s) {
      slots.set(i, (s = new Slot()))
      if (signal.aborted) s.fail(signal.reason)
    }
    return s
  }
  // On abort, wake the writer whichever slot it is waiting on, even one no fetcher has started.
  signal.addEventListener('abort', () => {
    for (const s of slots.values()) s.fail(signal.reason)
  }, { once: true })
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const retries = opts.retries ?? 3
  const baseDelay = opts.retryDelayMs ?? 500
  // Never run more than this many files ahead of the writer (bounds bookkeeping for tiny files).
  const maxAhead = Math.max(64, concurrency * 16)
  let next = start

  async function fetchInto(i: number, s: Slot) {
    const file = files[i]
    const declared = opts.sizeMismatch !== 'allow' && typeof file.size === 'number' ? file.size : undefined
    let received = 0
    for (let attempt = 0; ; attempt++) {
      try {
        const { body, skip } = await open(file, received, attempt, opts, signal)
        let toSkip = skip
        if (body) {
          const reader = body.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              let chunk = value
              if (toSkip) {
                const d = Math.min(toSkip, chunk.length)
                toSkip -= d
                chunk = chunk.subarray(d)
              }
              if (!chunk.length) continue
              if (declared !== undefined && received + chunk.length > declared) {
                throw new SizeMismatchError(file.name, declared, received + chunk.length, false)
              }
              await budget.acquire(chunk.length, i, signal)
              s.push(chunk)
              received += chunk.length
            }
          } finally {
            reader.releaseLock()
          }
        }
        if (declared !== undefined && received !== declared) {
          throw new SizeMismatchError(file.name, declared, received, true)
        }
        s.end()
        return
      } catch (e) {
        if (signal.aborted) return s.fail(signal.reason)
        if (attempt >= retries || !retryable(e, !!opts.getUrl)) return s.fail(e)
        try {
          await sleep(baseDelay * 2 ** attempt, signal)
        } catch {
          return s.fail(signal.reason)
        }
      }
    }
  }

  async function worker() {
    while (next < files.length && !signal.aborted) {
      const i = next++
      try {
        await budget.until(() => i - budget.head < maxAhead, signal)
      } catch {
        return slot(i).fail(signal.reason)
      }
      await fetchInto(i, slot(i))
    }
  }

  for (let k = 0; k < concurrency; k++) void worker()

  return {
    /** Slot for file i; call release(i) once it is fully consumed. */
    slot,
    release(i: number) {
      slots.get(i)?.discard(budget)
      slots.delete(i)
    },
    dispose() {
      for (const s of slots.values()) s.discard(budget)
      slots.clear()
    },
  }
}
