import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { bytesFor, mockServer, sha, verifyZip } from './helpers'

// Real IndexedDB structured-clones records, which would strip the mock handle's methods.
// Keep the handle by reference and clone everything else, exactly like IDB would.
vi.mock('../src/checkpoint', async (orig) => {
  const real: any = await orig()
  const store = new Map<string, any>()
  const clone = (c: any) => ({ ...structuredClone({ ...c, handle: null }), handle: c.handle })
  return {
    ...real,
    hasIDB: () => true,
    saveCheckpoint: async (c: any) => void store.set(c.id, clone(c)),
    loadCheckpoint: async (id: string) => (store.has(id) ? clone(store.get(id)) : undefined),
    deleteCheckpoint: async (id: string) => void store.delete(id),
    allCheckpoints: async () => [...store.values()].map(clone),
  }
})

const { exportZip, resume, listResumable } = await import('../src/index')

/** Behaves like Chromium: writes go to a swap copy and only land in `data` on close(). */
class MockHandle {
  kind = 'file'
  name = 'export.zip'
  data = new Uint8Array(0)
  commits = 0
  async getFile() { return new Blob([this.data]) }
  async queryPermission() { return 'granted' }
  async createWritable({ keepExistingData = false } = {}) {
    let swap = keepExistingData ? this.data.slice() : new Uint8Array(0)
    let len = swap.length
    let pos = 0
    const grow = (n: number) => {
      if (n <= swap.length) return
      const b = new Uint8Array(Math.max(n, swap.length * 2))
      b.set(swap.subarray(0, len))
      swap = b
    }
    return {
      write: async (c: Uint8Array) => { grow(pos + c.length); swap.set(c, pos); pos += c.length; len = Math.max(len, pos) },
      seek: async (p: number) => { pos = p },
      truncate: async (n: number) => { grow(n); if (n > len) swap.fill(0, len, n); len = n; pos = Math.min(pos, n) },
      close: async () => { this.data = swap.slice(0, len); this.commits++ },
      abort: async () => {},
    }
  }
}

describe('resume (FSA tier)', () => {
  it('continues after a failure from the last commit and produces a valid zip', async () => {
    const served: Record<string, any> = {}
    const files = Array.from({ length: 10 }, (_, i) => {
      const url = `https://cdn.test/${i}`
      served[url] = { data: bytesFor(i + 7, 40_000 + i * 999) }
      return { url, name: `p/${i}.jpg`, size: served[url].data.length }
    })
    // File 6 is down: the export dies ~60% through (stand-in for a tab crash).
    served[files[6].url].failTimes = 1
    served[files[6].url].failWith = 503
    const handle = new MockHandle()
    const job = exportZip(files, {
      fileHandle: handle as any,
      fetch: mockServer(served).fetch,
      retries: 0,
      checkpointBytes: 100_000,
    })
    await expect(job.done).rejects.toThrow(/503/)
    const [saved] = await listResumable()
    expect(saved).toMatchObject({ id: job.id, filesTotal: 10 })
    expect(saved.filesDone).toBeGreaterThan(0)
    expect(saved.filesDone).toBeLessThanOrEqual(6)
    expect(handle.data.length).toBe(saved.bytesWritten)

    // Junk past the checkpoint (an uncommitted write that did land) must be cut off.
    handle.data = new Uint8Array([...handle.data, 1, 2, 3])

    const res = await resume(job.id, { fetch: mockServer(served).fetch }).done
    expect(res.tier).toBe('fsa')
    const rep = verifyZip(handle.data)
    expect(rep.bad).toBeNull()
    expect(rep.unzipOk).toBe(true)
    expect(rep.files.map((f) => f.sha)).toEqual(files.map((f) => sha(served[f.url].data)))
    expect(await listResumable()).toEqual([])
  })

  it('refuses to resume when the file on disk is shorter than the checkpoint', async () => {
    const handle = new MockHandle()
    const served = { a: { data: bytesFor(1, 50_000) }, b: { data: new Uint8Array(0), failTimes: 1, failWith: 500 } }
    const job = exportZip(
      [{ url: 'a', name: 'a', size: 50_000 }, { url: 'b', name: 'b', size: 0 }],
      { fileHandle: handle as any, fetch: mockServer(served).fetch, retries: 0, checkpointBytes: 1 },
    )
    await expect(job.done).rejects.toThrow()
    handle.data = new Uint8Array(10)
    await expect(resume(job.id).done).rejects.toThrow(/shorter/)
  })
})
