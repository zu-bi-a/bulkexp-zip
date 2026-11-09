#!/usr/bin/env node
// Copies the files that must be served from your own origin into a static folder.
//   npx bulkexp-zip copy public
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [cmd, dir] = process.argv.slice(2)
if (cmd !== 'copy' || !dir) {
  console.log(`Usage: bulkexp-zip copy <static-dir>

Copies into <static-dir>:
  bulkexp-zip-sw.js           Service Worker (optional; streams Firefox exports straight to Downloads)
  bulkexp-zip-opfs-worker.js  OPFS worker (only needed if your bundler can't handle new URL(..., import.meta.url))`)
  process.exit(cmd ? 1 : 0)
}

const dist = new URL('../dist/', import.meta.url)
mkdirSync(dir, { recursive: true })
for (const [from, to] of [['sw.js', 'bulkexp-zip-sw.js'], ['opfs-worker.js', 'bulkexp-zip-opfs-worker.js']]) {
  const src = new URL(from, dist)
  if (!existsSync(src)) throw new Error(`Missing ${src.pathname}: is the package built?`)
  copyFileSync(src, join(dir, to))
  console.log(`copied ${join(dir, to)}`)
}
console.log(`
Use them with:
  exportZip(files, {
    serviceWorker: { url: '/bulkexp-zip-sw.js' },        // optional
    opfsWorkerUrl: '/bulkexp-zip-opfs-worker.js',          // optional
  })
Tip: add "postinstall": "bulkexp-zip copy public" so the copies stay in sync with the package version.`)
