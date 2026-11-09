import { afterEach, describe, expect, it, vi } from 'vitest'
import { plan } from '../src/index'

const files = (n: number, size: number) => Array.from({ length: n }, (_, i) => ({ url: `u${i}`, name: `${i}.jpg`, size }))
const MB = 1 << 20

function opfs(free: number) {
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => ({}), estimate: async () => ({ quota: free, usage: 0 }) },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('plan()', () => {
  it('picks File System Access when available', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: () => {} })
    const p = await plan(files(3, 10))
    expect(p).toMatchObject({ ok: true, tier: 'fsa' })
    expect(p.zipSize).toBeGreaterThan(30)
  })

  it('picks the Service Worker tier only when configured, and never on WebKit', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { serviceWorker: {}, vendor: 'Google Inc.' })
    expect(await plan(files(1, 1))).toMatchObject({ tier: 'blob' })
    expect(await plan(files(1, 1), { serviceWorker: { url: '/sw.js' } })).toMatchObject({ tier: 'sw' })
    vi.stubGlobal('navigator', { serviceWorker: {}, vendor: 'Apple Computer, Inc.' })
    expect(await plan(files(1, 1), { serviceWorker: { url: '/sw.js' } })).toMatchObject({ tier: 'blob' })
  })

  it('uses OPFS when quota allows', async () => {
    opfs(10_000 * MB)
    expect(await plan(files(500, 10 * MB))).toMatchObject({ ok: true, tier: 'opfs', quotaFree: 10_000 * MB })
  })

  it('routes to the server when OPFS quota is short and the zip is too big for a Blob', async () => {
    opfs(1000 * MB)
    expect(await plan(files(500, 10 * MB))).toMatchObject({ ok: false, useServer: true, reason: 'opfs-quota' })
  })

  it('falls back to Blob under the cap when OPFS quota is short', async () => {
    opfs(10 * MB)
    expect(await plan(files(10, 2 * MB))).toMatchObject({ ok: true, tier: 'blob' })
  })

  it('treats a throwing getDirectory (Safari private mode) as unavailable', async () => {
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => { throw new DOMException('', 'SecurityError') } } })
    expect(await plan(files(1, 1000 * MB))).toMatchObject({ ok: false, reason: 'too-large-for-blob' })
  })

  it('refuses the Blob tier when sizes are unknown', async () => {
    const p = await plan([{ url: 'x', name: 'x' }])
    expect(p).toMatchObject({ ok: false, reason: 'size-unknown' })
    expect(p.warnings.length).toBe(1)
  })

  it('respects a custom tier order and blob cap', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: () => {} })
    expect(await plan(files(1, 10), { tiers: ['blob', 'fsa'] })).toMatchObject({ tier: 'blob' })
    expect(await plan(files(1, 10 * MB), { tiers: ['blob'], blobMaxBytes: MB })).toMatchObject({ reason: 'too-large-for-blob' })
  })
})
