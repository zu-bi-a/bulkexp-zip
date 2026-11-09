/** Where zip bytes go. Each save tier implements one. */
export interface Sink {
  write(chunk: Uint8Array): Promise<void>
  /** Cut the output back to `size` bytes. Only tiers with a seekable target have it. */
  truncate?(size: number): Promise<void>
  /** FSA tier: make everything written so far durable on disk. */
  commit?(): Promise<void>
  /** Finish. OPFS/Blob tiers return the finished zip. */
  close(): Promise<Blob | void>
  abort(reason?: unknown): Promise<void>
}

/** Ensures `chunk` is a standalone buffer, so it can be transferred with postMessage. */
export function ownBuffer(c: Uint8Array): ArrayBuffer {
  return c.byteOffset === 0 && c.byteLength === c.buffer.byteLength
    ? (c.buffer as ArrayBuffer)
    : (c.slice().buffer as ArrayBuffer)
}

/**
 * Batches small writes (zip headers, 64 KB network chunks) into larger ones.
 * File System Access and worker postMessage both pay a fixed cost per call.
 */
export class Coalescer implements Sink {
  private buf: Uint8Array
  private len = 0
  truncate?: (size: number) => Promise<void>
  commit?: () => Promise<void>

  constructor(private inner: Sink, private cap = 4 << 20) {
    this.buf = new Uint8Array(cap)
    if (inner.truncate) this.truncate = async (size) => (await this.flush(), inner.truncate!(size))
    if (inner.commit) this.commit = async () => (await this.flush(), inner.commit!())
  }

  async write(c: Uint8Array) {
    let o = 0
    while (o < c.length) {
      const n = Math.min(this.cap - this.len, c.length - o)
      this.buf.set(c.subarray(o, o + n), this.len)
      this.len += n
      o += n
      if (this.len === this.cap) await this.flush()
    }
  }

  async flush() {
    if (!this.len) return
    const out = this.len === this.cap ? this.buf : this.buf.slice(0, this.len)
    if (out === this.buf) this.buf = new Uint8Array(this.cap)
    this.len = 0
    await this.inner.write(out)
  }

  async close() {
    await this.flush()
    return this.inner.close()
  }

  abort(reason?: unknown) {
    this.len = 0
    return this.inner.abort(reason)
  }
}

/** Trigger a normal browser download of a URL. */
export function clickDownload(href: string, name: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
