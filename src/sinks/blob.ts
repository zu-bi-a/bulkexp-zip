import type { Sink } from './sink'

/** In-memory tier. Only used under a size cap; the whole zip lives in RAM. */
export function blobSink(maxBytes: number): Sink {
  let parts: Uint8Array[] = []
  let size = 0
  return {
    async write(c) {
      size += c.length
      if (size > maxBytes) throw new Error(`Zip exceeds the in-memory limit of ${maxBytes} bytes`)
      parts.push(c)
    },
    async truncate(to) {
      while (size > to) {
        const last = parts.pop()!
        size -= last.length
        if (size < to) {
          parts.push(last.subarray(0, to - size))
          size = to
        }
      }
    },
    async close() {
      const b = new Blob(parts as BlobPart[], { type: 'application/zip' })
      parts = []
      return b
    },
    async abort() {
      parts = []
    },
  }
}
