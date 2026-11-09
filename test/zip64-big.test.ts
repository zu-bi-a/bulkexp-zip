// Writes a ~4.3 GB zip to a temp file. Opt-in: BIG=1 npx vitest run test/zip64-big.test.ts
import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runEngine } from '../src/engine'
import { resolveFiles, predictSize } from '../src/plan'

const BIG = 0x100000000 + 5_000_000 // just over 4 GiB

it.runIf(process.env.BIG)('streams a >4 GiB entry and >4 GiB offsets as valid Zip64', async () => {
  const chunk = new Uint8Array(1 << 20).fill(7)
  const fetchFn = (async (url: string) => {
    const size = url === 'big' ? BIG : 1000
    let left = size
    return new Response(new ReadableStream({
      pull(c) {
        if (!left) return c.close()
        const n = Math.min(left, chunk.length)
        c.enqueue(chunk.subarray(0, n))
        left -= n
      },
    }))
  }) as typeof fetch
  const { resolved, errorsName } = resolveFiles([
    { url: 'small', name: 'before.bin', size: 1000 },
    { url: 'big', name: 'big.bin', size: BIG },
    { url: 'small', name: 'after.bin', size: 1000 },
  ])
  const dir = mkdtempSync(join(tmpdir(), 'bulkexp-zip64-'))
  const path = join(dir, 'big.zip')
  const fd = openSync(path, 'w')
  try {
    await runEngine({
      id: 'big', tier: 'blob', files: resolved, errorsName, startIndex: 0, errors: [],
      state: { offset: 0, entries: [] }, opts: { fetch: fetchFn }, signal: new AbortController().signal,
      sink: { write: async (c) => void writeSync(fd, c), close: async () => {}, abort: async () => {} },
    })
    closeSync(fd)
    expect(statSync(path).size).toBe(predictSize(resolved))
    const out = execFileSync('python3', ['-I', '-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
print(z.testzip(), [(i.filename, i.file_size, i.header_offset) for i in z.infolist()])`, path]).toString()
    expect(out).toContain(`None [('before.bin', 1000, 0), ('big.bin', ${BIG}`)
    execFileSync('unzip', ['-tqq', path])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 600_000)
