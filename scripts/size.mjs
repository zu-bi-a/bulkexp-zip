// Fails if the main bundle exceeds the PRD budget (10 kB gzipped).
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const LIMIT = 10 * 1024
let failed = false
for (const f of ['index.js', 'opfs-worker.js', 'sw.js']) {
  const gz = gzipSync(readFileSync(new URL(`../dist/${f}`, import.meta.url))).length
  const over = f === 'index.js' && gz > LIMIT
  failed ||= over
  console.log(`${f.padEnd(16)} ${(gz / 1024).toFixed(2)} kB gzipped${over ? '  <-- over 10 kB budget' : ''}`)
}
process.exit(failed ? 1 : 0)
