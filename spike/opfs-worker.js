// Spike worker: generates deterministic file bytes, zips them with bulkexp-zip's
// low-level writer and writes to OPFS through a sync access handle (or, as a
// control, into an in-memory Blob). No network, so memory readings only reflect
// zipping and writing.
import { crc32, localHeader, dataDescriptor, centralDirectory, dosTime, encodeName } from '../bulkexp-zip/index.js'

const BLOCK = 1 << 20

function fillBlock(out, seed, k) {
  const u = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2)
  let x = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)) >>> 0 || 1
  for (let i = 0; i < u.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; u[i] = x }
}

self.onmessage = async (e) => {
  const { mode, totalBytes, fileCount, name } = e.data
  const post = (m) => self.postMessage(m)
  try {
    let write, finish
    if (mode === 'opfs') {
      const root = await navigator.storage.getDirectory()
      const fh = await root.getFileHandle(name, { create: true })
      const h = await fh.createSyncAccessHandle()
      await h.truncate(0)
      let pos = 0
      write = (b) => { let at = 0; while (at < b.length) { const n = h.write(b.subarray(at), { at: pos }); if (n <= 0) throw new DOMException('write returned 0', 'QuotaExceededError'); at += n; pos += n } }
      finish = async () => { await h.flush(); await h.close() }
    } else {
      const parts = []
      write = (b) => parts.push(b.slice())
      finish = async () => post({ type: 'blob', blob: new Blob(parts, { type: 'application/zip' }) })
    }

    const each = Math.floor(totalBytes / fileCount)
    const state = { offset: 0, entries: [] }
    const t = dosTime(new Date())
    const block = new Uint8Array(BLOCK)
    const put = (b) => { write(b); state.offset += b.length }
    const t0 = performance.now()
    let lastPost = 0
    for (let i = 0; i < fileCount; i++) {
      const fname = `photos/IMG_${String(i).padStart(5, '0')}.jpg`
      const offset = state.offset
      const zip64 = each >= 0xffffffff
      put(localHeader(encodeName(fname), t, zip64))
      let crc = 0
      for (let done = 0, k = 0; done < each; k++) {
        const n = Math.min(BLOCK, each - done)
        fillBlock(block, i + 1, k)
        const chunk = block.subarray(0, n)
        crc = crc32(chunk, crc)
        put(chunk)
        done += n
        const now = performance.now()
        if (now - lastPost > 250) {
          lastPost = now
          post({ type: 'progress', bytes: state.offset, mbps: state.offset / 1048576 / ((now - t0) / 1000), file: i })
        }
      }
      put(dataDescriptor(crc, each, zip64))
      state.entries.push({ name: fname, crc, size: each, offset, dosTime: t, zip64 })
    }
    put(centralDirectory(state))
    await finish()
    const secs = (performance.now() - t0) / 1000
    post({ type: 'done', bytes: state.offset, secs, mbps: state.offset / 1048576 / secs })
  } catch (err) {
    post({ type: 'error', name: err?.name, message: err?.message ?? String(err) })
  }
}
