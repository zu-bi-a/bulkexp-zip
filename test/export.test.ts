import { describe, expect, it } from 'vitest'
import { exportZip, FileFailedError, type FileInput } from '../src/index'
import { bytesFor, mockServer, sha, toBytes, verifyZip } from './helpers'

const blobOnly = { tiers: ['blob' as const], autoSave: false }

function dataset(n: number, size: (i: number) => number, extra: (i: number) => object = () => ({})) {
  const served: Record<string, any> = {}
  const files: FileInput[] = []
  for (let i = 0; i < n; i++) {
    const url = `https://cdn.test/f${i}?sig=abc`
    served[url] = { data: bytesFor(i + 1, size(i)), ...extra(i) }
    files.push({ url, name: `img/${i}.jpg`, size: size(i) })
  }
  return { served, files }
}

describe('exportZip (blob tier, mocked network)', () => {
  it('writes files in order with exact progress total', async () => {
    const { served, files } = dataset(40, (i) => 1000 + i * 3713, (i) => ({ latencyMs: (i * 37) % 23 }))
    const srv = mockServer(served)
    const events: number[] = []
    const job = exportZip(files, { ...blobOnly, fetch: srv.fetch, concurrency: 6, onProgress: (p) => events.push(p.bytes) })
    const res = await job.done
    const zip = await toBytes(res.file!)
    expect(res.tier).toBe('blob')
    expect(zip.length).toBe(res.bytes)
    const rep = verifyZip(zip)
    expect(rep.bad).toBeNull()
    expect(rep.unzipOk).toBe(true)
    expect(rep.files.map((f) => f.name)).toEqual(files.map((f) => f.name))
    expect(rep.files.map((f) => f.sha)).toEqual(files.map((f) => sha(served[f.url!].data)))
    expect(events.at(-1)).toBe(zip.length)
    expect(srv.maxLive).toBeGreaterThan(1)
    expect(srv.maxLive).toBeLessThanOrEqual(6)
  })

  it('runs faster with concurrency (400 files, 20 ms latency)', async () => {
    const run = async (concurrency: number) => {
      const { served, files } = dataset(400, () => 2000, () => ({ latencyMs: 20 }))
      const t = performance.now()
      await exportZip(files, { ...blobOnly, fetch: mockServer(served).fetch, concurrency }).done
      return performance.now() - t
    }
    const serial = await run(1)
    const parallel = await run(8)
    expect(serial / parallel).toBeGreaterThan(3)
  })

  it('keeps read-ahead within the byte budget', async () => {
    const { served, files } = dataset(30, () => 1 << 20, () => ({ chunk: 64 * 1024 }))
    let fetched = 0
    let maxAhead = 0
    const srv = mockServer(served)
    const countingFetch = (async (u: string, i?: RequestInit) => {
      const r = await srv.fetch(u, i)
      const counted = r.body!.pipeThrough(new TransformStream({ transform(c, ctl) { fetched += c.length; ctl.enqueue(c) } }))
      return new Response(counted, { status: r.status, headers: r.headers })
    }) as typeof fetch
    let written = 0
    const job = exportZip(files, {
      ...blobOnly,
      fetch: countingFetch,
      concurrency: 8,
      maxBufferBytes: 4 << 20,
      onProgress: (p) => {
        written = p.bytes
        maxAhead = Math.max(maxAhead, fetched - written)
      },
    })
    await job.done
    // budget + one in-flight chunk per fetcher + the 4 MB write coalescer
    expect(maxAhead).toBeLessThan((4 << 20) + 8 * 64 * 1024 + (4 << 20) + (1 << 20))
  })

  it('retries a broken body with a Range request and gets identical bytes', async () => {
    const { served, files } = dataset(3, () => 300_000)
    served[files[1].url!].failTimes = 1
    served[files[1].url!].failWith = 'midstream'
    const srv = mockServer(served)
    const res = await exportZip(files, { ...blobOnly, fetch: srv.fetch, retryDelayMs: 1 }).done
    const rep = verifyZip(await toBytes(res.file!))
    expect(rep.bad).toBeNull()
    expect(rep.files[1].sha).toBe(sha(served[files[1].url!].data))
    expect(srv.log.filter((l) => l.url === files[1].url).map((l) => l.range)).toEqual([null, 'bytes=150000-'])
  })

  it('handles servers that ignore Range by skipping already-received bytes', async () => {
    const { served, files } = dataset(1, () => 100_000)
    Object.assign(served[files[0].url!], { failTimes: 1, failWith: 'midstream', noRange: true })
    const res = await exportZip(files, { ...blobOnly, fetch: mockServer(served).fetch, retryDelayMs: 1 }).done
    expect(verifyZip(await toBytes(res.file!)).files[0].sha).toBe(sha(served[files[0].url!].data))
  })

  it('re-signs URLs through getUrl after a 403', async () => {
    const { served, files } = dataset(2, () => 1000)
    served['https://cdn.test/f1?sig=fresh'] = served[files[1].url!]
    served[files[1].url!] = { data: new Uint8Array(0), failTimes: 99, failWith: 403 }
    const res = await exportZip(files, {
      ...blobOnly,
      fetch: mockServer(served).fetch,
      retryDelayMs: 1,
      getUrl: (f, attempt) => (attempt === 0 ? f.url! : f.url!.replace('abc', 'fresh')),
    }).done
    expect(res.errors).toEqual([])
  })

  it("onFileError 'skip' leaves failed files out and adds errors.txt", async () => {
    const { served, files } = dataset(4, () => 50_000)
    served[files[1].url!] = { data: new Uint8Array(0), failTimes: 99, failWith: 404 }
    // fails after some bytes were written: the blob tier truncates them away
    Object.assign(served[files[2].url!], { failTimes: 99, failWith: 'midstream' })
    files.push({ url: 'https://cdn.test/f0?sig=abc', name: 'errors.txt', size: 50_000 })
    const res = await exportZip(files, { ...blobOnly, fetch: mockServer(served).fetch, retries: 1, retryDelayMs: 1, onFileError: 'skip' }).done
    expect(res.errors.map((e) => e.index)).toEqual([1, 2])
    const rep = verifyZip(await toBytes(res.file!))
    expect(rep.bad).toBeNull()
    expect(rep.files.map((f) => f.name)).toEqual(['img/0.jpg', 'img/3.jpg', 'errors.txt', 'errors (1).txt'])
  })

  it("onFileError 'fail' rejects", async () => {
    const { served, files } = dataset(3, () => 1000)
    served[files[2].url!] = { data: new Uint8Array(0), failTimes: 99, failWith: 404 }
    await expect(exportZip(files, { ...blobOnly, fetch: mockServer(served).fetch }).done).rejects.toBeInstanceOf(FileFailedError)
  })

  it('cancel() rejects with AbortError', async () => {
    const { served, files } = dataset(50, () => 10_000, () => ({ latencyMs: 20 }))
    const job = exportZip(files, { ...blobOnly, fetch: mockServer(served).fetch, concurrency: 1 })
    setTimeout(() => job.cancel(), 50)
    await expect(job.done).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('accepts Blob sources and files without size', async () => {
    const files = [{ name: 'a.txt', blob: new Blob(['hello']) }, { name: 'a.txt', blob: new Blob(['world']) }]
    const res = await exportZip(files, { ...blobOnly, plan: { ok: true, tier: 'blob', warnings: [] } }).done
    expect(verifyZip(await toBytes(res.file!)).files.map((f) => f.name)).toEqual(['a.txt', 'a (1).txt'])
  })
})

describe('write errors', () => {
  it("are not swallowed by onFileError 'skip'", async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `${i}`, blob: new Blob([new Uint8Array(300_000)]), size: 300_000 }))
    // Blob tier with a 1 MB cap: the sink throws partway, like a full disk would.
    const job = exportZip(files, { tiers: ['blob'], autoSave: false, onFileError: 'skip', blobMaxBytes: 1 << 20, plan: { ok: true, tier: 'blob', warnings: [] } })
    await expect(job.done).rejects.toThrow(/in-memory limit/)
  })
})

describe('declared size checks', () => {
  const one = (data: Uint8Array, size: number, extra: object = {}) => {
    const served = { 'https://x/a': { data, ...extra } }
    return { served, files: [{ url: 'https://x/a', name: 'a.bin', size }] }
  }
  it('fails a file that is larger than declared', async () => {
    const { served, files } = one(bytesFor(1, 2000), 1000)
    await expect(exportZip(files, { ...blobOnly, fetch: mockServer(served).fetch }).done).rejects.toThrow(/expected 1000 bytes/)
  })
  it('fails a file that stays shorter than declared after retries', async () => {
    const { served, files } = one(bytesFor(1, 500), 1000)
    const srv = mockServer(served)
    await expect(exportZip(files, { ...blobOnly, fetch: srv.fetch, retries: 2, retryDelayMs: 1 }).done).rejects.toThrow(/got 500/)
    expect(srv.log.map((l) => l.range)).toEqual([null, 'bytes=500-', 'bytes=500-'])
  })
  it("'allow' accepts the actual bytes", async () => {
    const { served, files } = one(bytesFor(1, 2000), 1000)
    const res = await exportZip(files, { ...blobOnly, fetch: mockServer(served).fetch, sizeMismatch: 'allow' }).done
    expect(verifyZip(await toBytes(res.file!)).files[0].size).toBe(2000)
  })
})
