import { SW_PREFIX } from '../protocol'
import type { ServiceWorkerOptions } from '../types'
import { ownBuffer, type Sink } from './sink'

/**
 * Safari (macOS and iOS, including other iOS browsers) buffers Service Worker
 * download streams into memory, which reproduces the crash this library exists
 * to avoid. That cannot be feature-detected, so it is the one vendor check.
 */
export const isWebKit = () => typeof navigator !== 'undefined' && /apple/i.test(navigator.vendor ?? '')

export const hasSW = () =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof isSecureContext !== 'undefined' &&
  isSecureContext &&
  !isWebKit()

async function activeWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  if (reg.active) return reg.active
  const sw = (reg.installing ?? reg.waiting)!
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Service Worker did not activate')), 10_000)
    sw.addEventListener('statechange', () => {
      if (sw.state === 'activated') clearTimeout(t), resolve()
      if (sw.state === 'redundant') clearTimeout(t), reject(new Error('Service Worker install failed'))
    })
  })
  return reg.active ?? sw
}

/**
 * Streams the zip through a Service Worker into the browser's downloads folder.
 * The SW pulls chunks over a MessageChannel one at a time, so backpressure from
 * the download reaches the fetchers and memory stays flat.
 */
export async function swSink(opts: ServiceWorkerOptions, id: string, name: string): Promise<Sink> {
  const reg = await navigator.serviceWorker.register(opts.url, opts.scope ? { scope: opts.scope } : undefined)
  const sw = await activeWorker(reg)
  const { port1, port2 } = new MessageChannel()

  let pulls = 0
  let failure: unknown
  let wake: (() => void) | undefined
  let onReady!: () => void
  const ready = new Promise<void>((r) => (onReady = r))

  port1.onmessage = (e) => {
    const t = e.data?.type
    if (t === 'ready') onReady()
    else if (t === 'pull') pulls++
    else if (t === 'cancel') failure = new DOMException('Download was cancelled in the browser', 'AbortError')
    wake?.()
  }
  sw.postMessage({ bulkexpZip: 'register', id, name }, [port2])
  await Promise.race([
    ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Service Worker did not answer')), 10_000)),
  ])

  // Navigating a hidden same-origin iframe to the intercepted URL starts the download.
  const iframe = document.createElement('iframe')
  iframe.hidden = true
  iframe.src = new URL(`${SW_PREFIX}/${id}/${encodeURIComponent(name)}`, reg.scope).href
  document.body.appendChild(iframe)

  // Keep the SW alive during long downloads (browsers stop idle workers after ~30 s).
  const ping = setInterval(() => sw.postMessage({ bulkexpZip: 'ping' }), 10_000)
  const finish = () => {
    clearInterval(ping)
    setTimeout(() => iframe.remove(), 60_000)
  }

  return {
    async write(c) {
      while (!pulls && !failure) await new Promise<void>((r) => (wake = r))
      if (failure) throw failure
      pulls--
      const buf = ownBuffer(c)
      port1.postMessage({ type: 'chunk', chunk: buf }, [buf])
    },
    async close() {
      port1.postMessage({ type: 'end' })
      finish()
    },
    async abort(reason) {
      port1.postMessage({ type: 'abort', reason: String(reason ?? 'aborted') })
      finish()
    },
  }
}
