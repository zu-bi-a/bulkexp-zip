import { crc32 as zlibCrc } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { crc32 } from '../src/crc32'
import { nameResolver, sanitizeName } from '../src/names'
import { centralDirectory, dataDescriptor, dosTime, encodeName, localHeader, predictZipSize, type ZipState } from '../src/zip'
import { bytesFor, sha, verifyZip } from './helpers'

describe('crc32', () => {
  it('matches the reference value and zlib', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    for (const n of [0, 1, 7, 8, 9, 1000, 65537]) {
      const b = bytesFor(n, n)
      expect(crc32(b)).toBe(zlibCrc(b))
    }
  })
  it('continues across chunks', () => {
    const b = bytesFor(3, 10_001)
    expect(crc32(b.subarray(5000), crc32(b.subarray(0, 5000)))).toBe(crc32(b))
  })
})

describe('names', () => {
  it('sanitizes paths', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etc/passwd')
    expect(sanitizeName('\\a\\b.jpg')).toBe('a/b.jpg')
    expect(sanitizeName('/./x//y')).toBe('x/y')
  })
  it('renames duplicates, case-insensitively, keeping the extension', () => {
    const r = nameResolver()
    expect(['a.jpg', 'a.jpg', 'A.JPG', 'a (1).jpg', 'dir/.env', 'dir/.env', 'noext', 'noext', ''].map(r)).toEqual([
      'a.jpg', 'a (1).jpg', 'A (2).JPG', 'a (1) (1).jpg', 'dir/.env', 'dir/.env (1)', 'noext', 'noext (1)', 'file',
    ])
  })
})

/** Build a zip synchronously from in-memory files with the low-level writer. */
function build(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = []
  const state: ZipState = { offset: 0, entries: [] }
  const t = dosTime(new Date(2026, 10, 6, 12, 30, 10))
  const push = (b: Uint8Array) => (parts.push(b), (state.offset += b.length))
  for (const f of files) {
    const offset = state.offset
    push(localHeader(encodeName(f.name), t, false))
    push(f.data)
    const crc = crc32(f.data)
    push(dataDescriptor(crc, f.data.length, false))
    state.entries.push({ name: f.name, crc, size: f.data.length, offset, dosTime: t, zip64: false })
  }
  push(centralDirectory(state))
  const out = new Uint8Array(state.offset)
  let at = 0
  for (const p of parts) out.set(p, at), (at += p.length)
  return out
}

describe('zip writer', () => {
  it('produces a valid archive with UTF-8 names and exact predicted size', () => {
    const files = [
      { name: 'hello.txt', data: new TextEncoder().encode('hello world') },
      { name: 'photos/日本語 ñ émoji 📷.jpg', data: bytesFor(1, 200_000) },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ]
    const zip = build(files)
    expect(zip.length).toBe(predictZipSize(files.map((f) => ({ name: f.name, size: f.data.length }))))
    const rep = verifyZip(zip)
    expect(rep.bad).toBeNull()
    expect(rep.unzipOk).toBe(true)
    expect(rep.files.map((f) => f.name)).toEqual(files.map((f) => f.name))
    expect(rep.files.map((f) => f.sha)).toEqual(files.map((f) => sha(f.data)))
  })

  it('writes a Zip64 end record above 65535 entries', () => {
    const files = Array.from({ length: 70_000 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }))
    const zip = build(files)
    expect(zip.length).toBe(predictZipSize(files.map((f) => ({ name: f.name, size: 0 }))))
    const rep = verifyZip(zip)
    expect(rep.bad).toBeNull()
    expect(rep.unzipOk).toBe(true)
    expect(rep.files.length).toBe(70_000)
  })
})
