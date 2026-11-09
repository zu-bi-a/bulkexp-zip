import { expect, test as base, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha, verifyZip } from '../test/helpers'

/** Node port of demo/sw.js's generator, to know every file's expected bytes. */
function testdata(seed: number, size: number): Uint8Array {
  const BLOCK = 64 * 1024
  const out = new Uint8Array(size)
  for (let k = 0; k * BLOCK < size; k++) {
    const u = new Uint32Array(BLOCK / 4)
    let x = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)) >>> 0 || 1
    for (let i = 0; i < u.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; u[i] = x }
    out.set(new Uint8Array(u.buffer).subarray(0, Math.min(BLOCK, size - k * BLOCK)), k * BLOCK)
  }
  return out
}

// Playwright's default WebKit context is ephemeral, where OPFS throws (like Safari private
// browsing). Use a persistent profile so WebKit behaves like a normal Safari window.
const test = base.extend({
  page: async ({ page, browserName, playwright, baseURL }, use) => {
    if (browserName !== 'webkit') return use(page)
    const ctx = await playwright.webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bulkexp-wk-')), { baseURL, acceptDownloads: true })
    await use(ctx.pages()[0] ?? (await ctx.newPage()))
    await ctx.close()
  },
})

const N = 24
const SIZE = 150_000
const expected = Array.from({ length: N }, (_, i) => sha(testdata(i + 1, SIZE)))

async function ready(page: Page) {
  await page.goto('/')
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller && !!(window as any).bulkexp)
}

/** Runs in the page: the file list, served by the demo SW. */
const filesSrc = `(n, size, q = '') => Array.from({ length: n }, (_, i) => ({ url: './testdata/' + (i + 1) + '/' + size + '/f' + q, name: 'photos/' + i + '.jpg', size }))`

function check(zip: Uint8Array) {
  const rep = verifyZip(zip)
  expect(rep.bad).toBeNull()
  expect(rep.unzipOk).toBe(true)
  expect(rep.files.map((f) => f.sha)).toEqual(expected)
}

test('plan() picks the right tier for each engine', async ({ page, browserName }) => {
  await ready(page)
  const tier = await page.evaluate(`(async () => {
    const files = (${filesSrc})(3, 1000)
    return (await bulkexp.plan(files, { serviceWorker: { url: './sw.js' } })).tier
  })()`)
  expect(tier).toBe({ chromium: 'fsa', firefox: 'sw', webkit: 'opfs' }[browserName])
})

test('forced low quota routes to the server', async ({ page, browserName }) => {
  test.skip(browserName === 'chromium', 'Chromium picks the FSA tier before quota matters')
  await ready(page)
  const p: any = await page.evaluate(`(async () => {
    navigator.storage.estimate = async () => ({ quota: 50e6, usage: 0 })
    return bulkexp.plan((${filesSrc})(100, 10e6), { tiers: ['opfs', 'blob'] })
  })()`)
  expect(p).toMatchObject({ ok: false, useServer: true, reason: 'opfs-quota' })
})

for (const tier of ['blob', 'opfs', 'sw'] as const) {
  test(`exports a valid zip through the ${tier} tier`, async ({ page, browserName }) => {
    test.skip(tier === 'sw' && browserName === 'webkit', 'SW tier is disabled on WebKit by design')
    await ready(page)
    const download = page.waitForEvent('download')
    const res: any = await page.evaluate(`(async () => {
      const r = await bulkexp.exportZip((${filesSrc})(${N}, ${SIZE}), { tiers: ['${tier}'], serviceWorker: { url: './sw.js' }, name: 'e2e.zip' }).done
      return { tier: r.tier, bytes: r.bytes }
    })()`)
    expect(res.tier).toBe(tier)
    const d = await download
    const zip = new Uint8Array(readFileSync(await d.path()))
    expect(zip.length).toBe(res.bytes)
    check(zip)
  })
}

/** Reads an OPFS file back as base64. */
const readOpfs = (name: string) => `(async () => {
  const f = await (await (await navigator.storage.getDirectory()).getFileHandle('${name}')).getFile()
  const b = new Uint8Array(await f.arrayBuffer()); let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
})()`

test('FSA tier writes through a file handle', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'showSaveFilePicker is Chromium-only')
  await ready(page)
  // The save picker can't be automated; an OPFS handle exercises the same FileSystemWritableFileStream code.
  await page.evaluate(`(async () => {
    const h = await (await navigator.storage.getDirectory()).getFileHandle('fsa.zip', { create: true })
    await bulkexp.exportZip((${filesSrc})(${N}, ${SIZE}), { fileHandle: h }).done
  })()`)
  check(Buffer.from(await page.evaluate<string>(readOpfs('fsa.zip')), 'base64'))
})

test('FSA resume after a page reload mid-export', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'FSA tier is Chromium-only')
  await ready(page)
  await page.evaluate(`(async () => {
    for (const r of await bulkexp.listResumable()) await bulkexp.discard(r.id)
    const h = await (await navigator.storage.getDirectory()).getFileHandle('resume.zip', { create: true })
    window.job = bulkexp.exportZip((${filesSrc})(${N}, ${SIZE}, '?latency=150'), {
      fileHandle: h, concurrency: 1, checkpointBytes: 1,
      onProgress: (p) => (window.pct = p.filesDone / p.filesTotal),
    })
    window.job.done.catch(() => {})
  })()`)
  await page.waitForFunction(() => (window as any).pct >= 0.6)
  await page.reload() // kills the export like a crash
  await page.waitForFunction(() => !!(window as any).bulkexp)
  const pending: any[] = await page.evaluate(`bulkexp.listResumable()`)
  expect(pending).toHaveLength(1)
  expect(pending[0].filesDone).toBeGreaterThanOrEqual(N * 0.5)
  expect(pending[0].filesDone).toBeLessThan(N)
  await page.evaluate(`bulkexp.resume('${pending[0].id}').done`)
  check(Buffer.from(await page.evaluate<string>(readOpfs('resume.zip')), 'base64'))
  expect(await page.evaluate(`bulkexp.listResumable()`)).toEqual([])
})

base('ephemeral WebKit (like Safari private mode) has no OPFS and routes big exports to the server', async ({ page, browserName }) => {
  base.skip(browserName !== 'webkit')
  await ready(page)
  const p: any = await page.evaluate(`bulkexp.plan((${filesSrc})(100, 10e6))`)
  expect(p).toMatchObject({ ok: false, useServer: true, reason: 'too-large-for-blob' })
})
