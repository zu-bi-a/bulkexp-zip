// Demo Service Worker = bulkexp-zip's download SW + a deterministic test-data server.
// This is also the integration pattern for apps that already have a Service Worker.
importScripts('./bulkexp-zip/sw.js')

// The demo page fetches test data through this SW, so take control right away.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

const BLOCK = 64 * 1024

/** Bytes of block k of file `seed`. Deterministic, so any byte range can be regenerated. */
function block(seed, k) {
  const out = new Uint32Array(BLOCK / 4)
  let x = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)) >>> 0 || 1
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x
  }
  return new Uint8Array(out.buffer)
}

function body(seed, size, start) {
  let pos = start
  return new ReadableStream({
    pull(c) {
      if (pos >= size) return c.close()
      const k = Math.floor(pos / BLOCK)
      const from = pos - k * BLOCK
      const to = Math.min(BLOCK, size - k * BLOCK)
      c.enqueue(block(seed, k).subarray(from, to))
      pos = k * BLOCK + to
    },
  }, { highWaterMark: 4 })
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  const base = new URL('testdata/', self.registration.scope).pathname
  if (!url.pathname.startsWith(base)) return
  // testdata/<seed>/<size>/<name>?latency=ms&failrate=0..1
  const [seed, size] = url.pathname.slice(base.length).split('/').map(Number)
  const latency = Number(url.searchParams.get('latency') || 0)
  const failrate = Number(url.searchParams.get('failrate') || 0)
  e.respondWith((async () => {
    if (latency) await new Promise((r) => setTimeout(r, latency))
    if (Math.random() < failrate) return new Response('injected failure', { status: 500 })
    const m = /bytes=(\d+)-/.exec(e.request.headers.get('Range') || '')
    const start = m ? Math.min(Number(m[1]), size) : 0
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size - start), 'Accept-Ranges': 'bytes' }
    if (m) headers['Content-Range'] = `bytes ${start}-${size - 1}/${size}`
    return new Response(body(seed, size, start), { status: m ? 206 : 200, headers })
  })())
})
