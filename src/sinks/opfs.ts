import { OPFS_DIR, lockName } from '../protocol'
import { ownBuffer, type Sink } from './sink'

export const hasOPFS = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.storage?.getDirectory === 'function' &&
  typeof Worker !== 'undefined'

/** Actually opens OPFS: Safari private browsing exposes the API but throws here. */
export async function opfsUsable(): Promise<boolean> {
  if (!hasOPFS()) return false
  try {
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}

export async function freeQuota(): Promise<number | undefined> {
  try {
    const { quota, usage } = await navigator.storage.estimate()
    return quota === undefined ? undefined : quota - (usage ?? 0)
  } catch {
    return undefined
  }
}

const MAX_IN_FLIGHT = 4

/**
 * Writes the zip into OPFS from a worker, then hands the finished, disk-backed
 * File to a normal download. A Web Lock is held while writing so cleanup() in
 * another tab never deletes a file that is still being written.
 */
export async function opfsSink(id: string, workerUrl?: string | URL): Promise<Sink> {
  const worker = workerUrl
    ? new Worker(workerUrl, { type: 'module' })
    : new Worker(new URL('./opfs-worker.js', import.meta.url), { type: 'module' })
  const file = `${id}.zip`
  let seq = 0
  const calls = new Map<number, { res: () => void; rej: (e: unknown) => void }>()
  worker.onmessage = (e) => {
    const { id, ok, name, message } = e.data
    const c = calls.get(id)
    calls.delete(id)
    ok ? c?.res() : c?.rej(new DOMException(message, name))
  }
  worker.onerror = (e) => {
    for (const c of calls.values()) c.rej(new Error(`OPFS worker failed: ${e.message}`))
    calls.clear()
  }
  const call = (op: string, data: object = {}, transfer: Transferable[] = []) =>
    new Promise<void>((res, rej) => {
      const n = ++seq
      calls.set(n, { res, rej })
      worker.postMessage({ id: n, op, ...data }, transfer)
    })

  let releaseLock: (() => void) | undefined
  if (navigator.locks) {
    await new Promise<void>((held) => {
      navigator.locks.request(lockName(id), () => {
        held()
        return new Promise<void>((r) => (releaseLock = r))
      })
    })
  }
  void navigator.storage.persist?.().catch(() => {})

  try {
    await call('open', { file })
  } catch (e) {
    worker.terminate()
    releaseLock?.()
    throw e
  }

  let inFlight: Promise<void>[] = []
  let failed: unknown
  const drain = async () => {
    await Promise.all(inFlight)
    inFlight = []
  }
  const end = () => (worker.terminate(), releaseLock?.())

  return {
    async write(c) {
      if (failed) throw failed
      const buf = ownBuffer(c)
      const p = call('write', { chunk: buf }, [buf])
      p.catch((e) => (failed ??= e))
      inFlight.push(p)
      if (inFlight.length >= MAX_IN_FLIGHT) await inFlight.shift()
    },
    async truncate(size) {
      await drain()
      await call('truncate', { size })
    },
    async close() {
      try {
        await drain()
        await call('close')
      } finally {
        end()
      }
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(OPFS_DIR)
      return (await dir.getFileHandle(file)).getFile()
    },
    async abort() {
      await Promise.allSettled(inFlight)
      await call('abort').catch(() => {})
      end()
    },
  }
}

/**
 * Deletes leftover OPFS exports. Skips files being written (locked) and, unless
 * `force`, files finished less than `keepMs` ago, since their download may still
 * be reading them.
 */
export async function cleanupOPFS(opts: { force?: boolean; keepMs?: number } = {}): Promise<number> {
  if (!hasOPFS()) return 0
  const keepMs = opts.force ? 0 : opts.keepMs ?? 10 * 60_000
  let dir: FileSystemDirectoryHandle
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR)
  } catch {
    return 0
  }
  const held = new Set<string>()
  try {
    const q = await navigator.locks?.query()
    for (const l of q?.held ?? []) if (l.name) held.add(l.name)
  } catch {}
  let removed = 0
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind !== 'file' || held.has(lockName(name.replace(/\.zip$/, '')))) continue
    try {
      const f = await (h as FileSystemFileHandle).getFile()
      if (Date.now() - f.lastModified < keepMs) continue
      await dir.removeEntry(name)
      removed++
    } catch {
      // In use (sync access handle open) or already gone.
    }
  }
  return removed
}
