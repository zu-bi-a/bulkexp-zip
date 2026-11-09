import type { ResolvedFile } from './checkpoint'
import { crc32 } from './crc32'
import { ByteBudget, startFetchers } from './fetcher'
import { Coalescer, type Sink } from './sinks/sink'
import type { FileError, Progress, RunOptions, Tier } from './types'
import { centralDirectory, dataDescriptor, dosTime, encodeName, localHeader, type ZipState } from './zip'

export interface EngineInput {
  id: string
  tier: Tier
  sink: Sink
  files: ResolvedFile[]
  errorsName: string
  /** Mutated as the zip is written. */
  state: ZipState
  startIndex: number
  errors: FileError[]
  total?: number
  opts: RunOptions
  signal: AbortSignal
  /** Called after each file with the next index; the FSA tier checkpoints here. */
  afterFile?: (nextIndex: number, out: Coalescer) => Promise<void>
}

export class FileFailedError extends Error {
  constructor(public file: string, public cause: unknown) {
    super(`Failed to fetch "${file}": ${(cause as Error)?.message ?? cause}`)
    this.name = 'FileFailedError'
  }
}

/** Fetch files in parallel, write them in order as one zip into `sink`. Returns the sink's result. */
export async function runEngine(x: EngineInput): Promise<Blob | void> {
  const { files, state, errors, opts, signal } = x
  const out = new Coalescer(x.sink)
  const budget = new ByteBudget(opts.maxBufferBytes ?? 64 << 20)
  const inner = new AbortController()
  const onAbort = () => (inner.abort(signal.reason), budget.wake())
  signal.addEventListener('abort', onAbort, { once: true })
  const fetchers = startFetchers(
    files.map((f) => f.input),
    x.startIndex,
    budget,
    opts,
    inner.signal,
  )

  let last = 0
  let current: string | undefined
  let filesDone = x.startIndex
  const progress = (force = false) => {
    if (!opts.onProgress) return
    const now = Date.now()
    if (!force && now - last < 100) return
    last = now
    const p: Progress = {
      id: x.id,
      tier: x.tier,
      bytes: state.offset,
      total: x.total,
      filesDone,
      filesTotal: files.length,
      currentFile: current,
      errors: errors.length,
    }
    opts.onProgress(p)
  }

  const write = async (b: Uint8Array) => {
    await out.write(b)
    state.offset += b.length
  }

  async function addEntry(name: string, time: number, zip64: boolean, chunks: AsyncIterable<Uint8Array>) {
    const start = state.offset
    const nameBytes = encodeName(name)
    let headerDone = false
    let crc = 0
    let size = 0
    const finish = async () => {
      await write(dataDescriptor(crc, size, zip64))
      state.entries.push({ name, crc, size, offset: start, dosTime: time, zip64 })
    }
    // Only errors from fetching the file are per-file errors. Write errors (disk full,
    // download cancelled) propagate and stop the export.
    const it = chunks[Symbol.asyncIterator]()
    let failure: unknown
    for (;;) {
      let r: IteratorResult<Uint8Array>
      try {
        r = await it.next()
      } catch (e) {
        failure = e ?? new Error('Unknown error')
        break
      }
      if (r.done) break
      if (!headerDone) await write(localHeader(nameBytes, time, zip64)), (headerDone = true)
      crc = crc32(r.value, crc)
      size += r.value.length
      await write(r.value)
      progress()
    }
    if (failure === undefined) {
      if (!headerDone) await write(localHeader(nameBytes, time, zip64))
      await finish()
      return
    }
    if (signal.aborted || inner.signal.aborted) throw signal.reason ?? failure
    if (opts.onFileError !== 'skip') throw new FileFailedError(name, failure)
    const err: FileError = { index: -1, name, message: (failure as Error)?.message ?? String(failure) }
    if (headerDone) {
      if (out.truncate) {
        await out.truncate(start)
        state.offset = start
      } else {
        // Already streamed to the downloads folder: close the entry with what arrived.
        err.truncated = true
        await finish()
      }
    }
    return err
  }

  try {
    for (let i = x.startIndex; i < files.length; i++) {
      signal.throwIfAborted()
      budget.setHead(i)
      const f = files[i]
      current = f.zipName
      const err = await addEntry(f.zipName, f.dosTime, f.zip64, fetchers.slot(i).drain(budget))
      fetchers.release(i)
      if (err) errors.push({ ...err, index: i })
      filesDone = i + 1
      progress(true)
      await x.afterFile?.(i + 1, out)
    }

    if (errors.length) {
      const text = errors
        .map((e) => `${e.name}\t${e.truncated ? 'TRUNCATED' : 'MISSING'}\t${e.message}`)
        .join('\n')
      const body = new TextEncoder().encode(`Files that could not be exported:\n\n${text}\n`)
      await addEntry(x.errorsName, dosTime(new Date()), false, (async function* () {
        yield body
      })())
    }
    await write(centralDirectory(state))
    current = undefined
    progress(true)
    return await out.close()
  } catch (e) {
    inner.abort(e)
    throw e
  } finally {
    fetchers.dispose()
    signal.removeEventListener('abort', onAbort)
  }
}
