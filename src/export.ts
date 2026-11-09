import {
  allCheckpoints,
  deleteCheckpoint,
  hasIDB,
  loadCheckpoint,
  saveCheckpoint,
  type Checkpoint,
  type ResolvedFile,
} from './checkpoint'
import { runEngine } from './engine'
import { DEFAULT_BLOB_MAX, DEFAULT_TIERS, planForSize, predictSize, resolveFiles } from './plan'
import { blobSink } from './sinks/blob'
import { ensureWritePermission, fsaSink, hasFSA, pickFile } from './sinks/fsa'
import { cleanupOPFS, opfsSink } from './sinks/opfs'
import { clickDownload, type Sink } from './sinks/sink'
import { swSink } from './sinks/sw'
import type { ExportJob, ExportOptions, ExportResult, FileError, FileInput, Plan, RunOptions, Tier } from './types'
import type { ZipState } from './zip'

/** Thrown by exportZip when the browser can't handle the export; check `plan.reason`. */
export class UseServerError extends Error {
  constructor(public plan: Extract<Plan, { ok: false }>) {
    super(`Export should use the server path: ${plan.reason}`)
    this.name = 'UseServerError'
  }
}

const DEFAULT_CHECKPOINT = 1 << 30

const randomId = () =>
  globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError'

function controller(signal?: AbortSignal) {
  const ac = new AbortController()
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason)
    else signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true })
  }
  return ac
}

interface Execution {
  id: string
  name: string
  tier: Tier
  sink: Sink
  files: ResolvedFile[]
  errorsName: string
  state: ZipState
  startIndex: number
  errors: FileError[]
  total?: number
  opts: RunOptions
  signal: AbortSignal
  autoSave: boolean
  /** FSA tier only. */
  handle?: FileSystemFileHandle
  checkpointBytes: number
  createdAt: number
  ckOptions: Checkpoint['options']
}

async function execute(x: Execution): Promise<ExportResult> {
  const { state, files } = x
  let resumable = x.tier === 'fsa' && !!x.handle && x.checkpointBytes > 0 && hasIDB()
  let lastCommit = state.offset

  const save = async (nextIndex: number) => {
    if (!resumable) return
    try {
      await saveCheckpoint({
        id: x.id,
        version: 1,
        createdAt: x.createdAt,
        updatedAt: Date.now(),
        name: x.name,
        handle: x.handle!,
        files,
        errorsName: x.errorsName,
        nextIndex,
        state,
        errors: x.errors,
        total: x.total,
        options: x.ckOptions,
      })
    } catch (e) {
      // e.g. a FileInput field that can't be stored in IndexedDB. The export continues without resume.
      console.warn('[bulkexp-zip] checkpoint failed, resume disabled for this export:', e)
      resumable = false
    }
  }

  await save(x.startIndex)
  let blob: Blob | void
  try {
    blob = await runEngine({
      id: x.id,
      tier: x.tier,
      sink: x.sink,
      files,
      errorsName: x.errorsName,
      state,
      startIndex: x.startIndex,
      errors: x.errors,
      total: x.total,
      opts: x.opts,
      signal: x.signal,
      afterFile: resumable
        ? async (next, out) => {
            if (!resumable || next >= files.length || state.offset - lastCommit < x.checkpointBytes) return
            await out.commit!()
            lastCommit = state.offset
            await save(next)
          }
        : undefined,
    })
  } catch (e) {
    await x.sink.abort(e).catch(() => {})
    if (isAbort(e) && x.signal.aborted) {
      // Cancelled: nothing to resume. Remove the partial file where the browser allows it.
      if (resumable) await deleteCheckpoint(x.id).catch(() => {})
      await (x.handle as FileSystemFileHandle & { remove?(): Promise<void> })?.remove?.().catch(() => {})
    }
    // On other failures the checkpoint stays, so resume(id) can continue from the last commit.
    throw e
  }
  if (resumable) await deleteCheckpoint(x.id).catch(() => {})

  if (blob && x.autoSave && typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob)
    clickDownload(url, x.name)
    // Never revoke/delete right away: the download may still be reading it.
    setTimeout(() => URL.revokeObjectURL(url), x.tier === 'blob' ? 60_000 : 10 * 60_000)
  }
  return {
    id: x.id,
    tier: x.tier,
    bytes: state.offset,
    files: files.length,
    errors: x.errors,
    file: blob || undefined,
  }
}

function runOpts(o: ExportOptions, signal: AbortSignal): RunOptions {
  return { ...o, signal }
}

/**
 * Stream `files` into one zip on the user's disk.
 * Call it from a click handler: in Chromium it opens the save dialog first.
 */
export function exportZip(files: FileInput[], options: ExportOptions = {}): ExportJob {
  const id = options.id ?? randomId()
  const name = options.name ?? 'export.zip'
  const ac = controller(options.signal)
  let tier: Tier | undefined

  // Open the save picker before any await, while the click's user activation is still valid.
  const order = options.tiers ?? DEFAULT_TIERS
  const wantFSA = options.plan
    ? options.plan.ok && options.plan.tier === 'fsa'
    : order[0] === 'fsa' && hasFSA()
  const handleP = options.fileHandle
    ? Promise.resolve(options.fileHandle)
    : wantFSA
      ? pickFile(name)
      : undefined
  handleP?.catch(() => {})

  const done = (async (): Promise<ExportResult> => {
    const { resolved, errorsName } = resolveFiles(files)
    const total = predictSize(resolved)
    void cleanupOPFS().catch(() => {})

    let p: Plan = handleP
      ? { ok: true, tier: 'fsa', zipSize: total, warnings: [] }
      : options.plan ?? (await planForSize(total, options))
    let sink: Sink
    let handle: FileSystemFileHandle | undefined
    for (;;) {
      if (!p.ok) throw new UseServerError(p)
      tier = p.tier
      try {
        if (tier === 'fsa') sink = await fsaSink((handle = await (handleP ?? pickFile(name))))
        else if (tier === 'sw') sink = await swSink(options.serviceWorker!, id, name)
        else if (tier === 'opfs') sink = await opfsSink(id, options.opfsWorkerUrl)
        else sink = blobSink(options.blobMaxBytes ?? DEFAULT_BLOB_MAX)
        break
      } catch (e) {
        // A picker dismissal or cancel is final; a tier that fails to start falls back to the next one.
        if (tier === 'fsa' || ac.signal.aborted) throw e
        console.warn(`[bulkexp-zip] tier "${tier}" failed to start, trying the next one:`, e)
        const rest = order.slice(order.indexOf(tier) + 1)
        p = await planForSize(total, { ...options, tiers: rest })
      }
    }
    ac.signal.throwIfAborted()

    return execute({
      id,
      name,
      tier,
      sink,
      files: resolved,
      errorsName,
      state: { offset: 0, entries: [] },
      startIndex: 0,
      errors: [],
      total,
      opts: runOpts(options, ac.signal),
      signal: ac.signal,
      autoSave: options.autoSave ?? true,
      handle,
      checkpointBytes: options.checkpointBytes ?? DEFAULT_CHECKPOINT,
      createdAt: Date.now(),
      ckOptions: pickCk(options),
    })
  })()

  return {
    id,
    get tier() {
      return tier
    },
    done,
    cancel: () => ac.abort(new DOMException('Export cancelled', 'AbortError')),
  }
}

const pickCk = (o: ExportOptions): Checkpoint['options'] => ({
  concurrency: o.concurrency,
  maxBufferBytes: o.maxBufferBytes,
  retries: o.retries,
  retryDelayMs: o.retryDelayMs,
  onFileError: o.onFileError,
  sizeMismatch: o.sizeMismatch,
  checkpointBytes: o.checkpointBytes,
})

export interface ResumeOptions
  extends Pick<RunOptions, 'onProgress' | 'getUrl' | 'fetchInit' | 'fetch' | 'signal' | 'concurrency'> {
  /** Replace the stored file list's inputs (e.g. fresh presigned URLs). Must be the same files, same order. */
  files?: FileInput[]
}

/**
 * Continue an FSA-tier export after a crash or reload. Call it from a click handler:
 * the browser may ask the user to allow writing to the file again.
 */
export function resume(id: string, options: ResumeOptions = {}): ExportJob {
  const ac = controller(options.signal)
  const done = (async () => {
    const cp = await loadCheckpoint(id)
    if (!cp) throw new Error(`No resumable export with id "${id}"`)
    await ensureWritePermission(cp.handle)
    const onDisk = (await cp.handle.getFile()).size
    if (onDisk < cp.state.offset) {
      throw new Error('The file on disk is shorter than the checkpoint (moved or edited?). Start a new export.')
    }
    let files = cp.files
    if (options.files) {
      if (options.files.length !== files.length) throw new Error('resume(): `files` must match the original list')
      files = files.map((f, i) => ({ ...f, input: options.files![i] }))
    }
    const sink = await fsaSink(cp.handle, cp.state.offset)
    return execute({
      id,
      name: cp.name,
      tier: 'fsa',
      sink,
      files,
      errorsName: cp.errorsName,
      state: cp.state,
      startIndex: cp.nextIndex,
      errors: cp.errors,
      total: cp.total,
      opts: { ...cp.options, ...options, signal: ac.signal },
      signal: ac.signal,
      autoSave: false,
      handle: cp.handle,
      checkpointBytes: cp.options.checkpointBytes ?? DEFAULT_CHECKPOINT,
      createdAt: cp.createdAt,
      ckOptions: cp.options,
    })
  })()
  return {
    id,
    tier: 'fsa',
    done,
    cancel: () => ac.abort(new DOMException('Export cancelled', 'AbortError')),
  }
}

export interface ResumableExport {
  id: string
  name: string
  bytesWritten: number
  total?: number
  filesDone: number
  filesTotal: number
  createdAt: number
  updatedAt: number
}

/** Exports that stopped before finishing and can be resumed. */
export async function listResumable(): Promise<ResumableExport[]> {
  if (!hasIDB()) return []
  return (await allCheckpoints()).map((c) => ({
    id: c.id,
    name: c.name,
    bytesWritten: c.state.offset,
    total: c.total,
    filesDone: c.nextIndex,
    filesTotal: c.files.length,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }))
}

/** Forget a resumable export (the partial file on disk is left alone). */
export const discard = (id: string) => deleteCheckpoint(id)

/** Delete leftover OPFS exports. Files still being written in any tab are kept. */
export const cleanup = (opts?: { force?: boolean; keepMs?: number }) => cleanupOPFS(opts)
