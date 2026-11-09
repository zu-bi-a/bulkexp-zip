import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Deterministic bytes for a (seed, size) pair. */
export function bytesFor(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = (seed * 2654435761) >>> 0 || 1
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export interface ZipReport {
  bad: string | null
  files: { name: string; size: number; sha: string }[]
  unzipOk: boolean
}

const PY = `
import zipfile, sys, json, hashlib
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad, "files": [{"name": i.filename, "size": i.file_size, "sha": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]}))
`

/** Validate a zip with Python's zipfile (CRC check) and Info-ZIP `unzip -t`. */
export function verifyZip(data: Uint8Array, { unzip = true } = {}): ZipReport {
  const dir = mkdtempSync(join(tmpdir(), 'bulkexp-zip-'))
  const file = join(dir, 'out.zip')
  try {
    writeFileSync(file, data)
    const rep = JSON.parse(execFileSync('python3', ['-I', '-c', PY, file], { maxBuffer: 1 << 28 }).toString())
    let unzipOk = true
    if (unzip) {
      try {
        execFileSync('unzip', ['-tqq', file], { stdio: 'pipe' })
      } catch {
        unzipOk = false
      }
    }
    return { ...rep, unzipOk }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const toBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer())

interface Served {
  data: Uint8Array
  /** Fail this many times before succeeding. */
  failTimes?: number
  /** How to fail: HTTP status, or 'midstream' (error after half the body). */
  failWith?: number | 'midstream'
  latencyMs?: number
  /** Ignore Range headers (always 200 + full body). */
  noRange?: boolean
  chunk?: number
}

/** A fetch() replacement serving in-memory files, with failures, latency and Range support. */
export function mockServer(files: Record<string, Served>) {
  const log: { url: string; range: string | null }[] = []
  let live = 0
  let maxLive = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const f = files[url]
    const range = new Headers(init?.headers).get('Range')
    log.push({ url, range })
    if (!f) return new Response('nope', { status: 404 })
    live++
    maxLive = Math.max(maxLive, live)
    try {
      if (f.latencyMs) await new Promise((r) => setTimeout(r, f.latencyMs))
      const failing = (f.failTimes ?? 0) > 0
      if (failing) f.failTimes!--
      if (failing && typeof f.failWith === 'number') return new Response('err', { status: f.failWith })
      let start = 0
      let status = 200
      const headers = new Headers()
      if (range && !f.noRange) {
        start = Number(/bytes=(\d+)-/.exec(range)![1])
        status = 206
        headers.set('Content-Range', `bytes ${start}-${f.data.length - 1}/${f.data.length}`)
      }
      const body = f.data.subarray(start)
      const step = f.chunk ?? 16 * 1024
      const breakAt = failing && f.failWith === 'midstream' ? Math.floor(body.length / 2) : -1
      let pos = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (breakAt >= 0 && pos >= breakAt) return ctrl.error(new TypeError('network error'))
          if (pos >= body.length) return ctrl.close()
          const end = Math.min(body.length, pos + step, breakAt >= 0 && pos < breakAt ? breakAt : Infinity)
          ctrl.enqueue(body.slice(pos, end))
          pos = end
        },
      })
      return new Response(stream, { status, headers })
    } finally {
      live--
    }
  }) as unknown as typeof fetch
  return { fetch: fetchFn, log, get maxLive() { return maxLive } }
}
