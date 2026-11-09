// bulkexp-zip Service Worker. Serve this file yourself (same origin), then either
// register it directly or add `importScripts('/bulkexp-zip-sw.js')` to your own SW.
/// <reference lib="webworker" />
import { SW_PREFIX } from './protocol'

declare const self: ServiceWorkerGlobalScope

interface Pending {
  port: MessagePort
  name: string
  done: () => void
}

const pending = new Map<string, Pending>()

// No skipWaiting()/clients.claim() here: when imported into an app's own SW, its lifecycle stays the app's call.

self.addEventListener('message', (e: ExtendableMessageEvent) => {
  const d = e.data
  if (!d || typeof d.bulkexpZip !== 'string') return
  if (d.bulkexpZip === 'register' && e.ports[0]) {
    const port = e.ports[0]
    // Keep this worker alive until the download ends (pings extend it further).
    e.waitUntil(new Promise<void>((done) => pending.set(d.id, { port, name: d.name, done })))
    port.postMessage({ type: 'ready' })
  } else if (d.bulkexpZip === 'ping') {
    e.waitUntil(new Promise((r) => setTimeout(r, 15_000)))
  }
})

function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

self.addEventListener('fetch', (e: FetchEvent) => {
  const url = new URL(e.request.url)
  const base = new URL(SW_PREFIX + '/', self.registration.scope).pathname
  if (url.origin !== self.location.origin || !url.pathname.startsWith(base)) return
  const id = url.pathname.slice(base.length).split('/')[0]
  const job = pending.get(id)
  if (!job) {
    e.respondWith(new Response('Export not found or already started', { status: 404 }))
    return
  }
  pending.delete(id)
  const { port, name, done } = job
  let resolvePull: (() => void) | undefined
  let closed = false

  const stream = new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        port.onmessage = (ev) => {
          const m = ev.data
          if (closed) return
          if (m.type === 'chunk') ctrl.enqueue(new Uint8Array(m.chunk))
          else if (m.type === 'end') (closed = true), ctrl.close(), done()
          else if (m.type === 'abort') (closed = true), ctrl.error(new Error(m.reason)), done()
          resolvePull?.()
        }
      },
      pull() {
        return new Promise<void>((r) => {
          resolvePull = r
          port.postMessage({ type: 'pull' })
        })
      },
      cancel() {
        closed = true
        port.postMessage({ type: 'cancel' })
        done()
      },
    },
    new CountQueuingStrategy({ highWaterMark: 2 }),
  )

  e.respondWith(
    new Response(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(name),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    }),
  )
})
