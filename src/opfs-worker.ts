// Dedicated worker that writes one zip into the Origin Private File System.
// Sync access handles (worker-only) write in place, with no swap-file copy.
/// <reference lib="webworker" />

const DIR = 'bulkexp-zip' // keep in sync with protocol.ts (no imports: this file ships standalone)

interface SyncHandle {
  write(b: ArrayBufferView, o: { at: number }): number
  truncate(n: number): void | Promise<void>
  flush(): void | Promise<void>
  close(): void | Promise<void>
}
interface Writable {
  write(d: unknown): Promise<void>
  truncate(n: number): Promise<void>
  seek(n: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

let dir: FileSystemDirectoryHandle
let file = ''
let sync: SyncHandle | undefined
let writable: Writable | undefined
let pos = 0

const ops: Record<string, (m: any) => Promise<unknown>> = {
  async open(m) {
    const root = await navigator.storage.getDirectory()
    dir = await root.getDirectoryHandle(DIR, { create: true })
    file = m.file
    const fh = await dir.getFileHandle(file, { create: true })
    const h = fh as FileSystemFileHandle & {
      createSyncAccessHandle?: () => Promise<SyncHandle>
      createWritable?: () => Promise<Writable>
    }
    if (h.createSyncAccessHandle) {
      sync = await h.createSyncAccessHandle()
      await sync.truncate(0)
    } else {
      writable = await h.createWritable!()
    }
    pos = 0
  },
  async write(m) {
    const b = new Uint8Array(m.chunk as ArrayBuffer)
    if (sync) {
      let at = 0
      while (at < b.length) {
        const n = sync.write(b.subarray(at), { at: pos })
        if (n <= 0) throw new DOMException('Write failed (disk or quota full?)', 'QuotaExceededError')
        at += n
        pos += n
      }
    } else {
      await writable!.write(b)
      pos += b.length
    }
  },
  async truncate(m) {
    if (sync) await sync.truncate(m.size)
    else await writable!.truncate(m.size), await writable!.seek(m.size)
    pos = m.size
  },
  async close() {
    if (sync) await sync.flush(), await sync.close()
    else await writable!.close()
    sync = writable = undefined
  },
  async abort() {
    try {
      if (sync) await sync.close()
      else await writable?.abort()
    } catch {}
    sync = writable = undefined
    if (dir && file) await dir.removeEntry(file).catch(() => {})
  },
}

self.onmessage = async (e: MessageEvent) => {
  const { id, op } = e.data
  try {
    await ops[op](e.data)
    self.postMessage({ id, ok: true })
  } catch (err) {
    const x = err as DOMException
    self.postMessage({ id, ok: false, name: x?.name ?? 'Error', message: x?.message ?? String(err) })
  }
}
