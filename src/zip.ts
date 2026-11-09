// Minimal streaming zip writer: store mode only, data descriptors, UTF-8 names, Zip64.
// Its whole state is { offset, entries }, which is plain data, so it can be
// checkpointed to IndexedDB and restored to resume an export.

const MAX32 = 0xffffffff
const FLAGS = 0x0808 // bit 3: sizes in data descriptor; bit 11: UTF-8 names
const MADE_BY = 0x032d // Unix, spec 4.5
const EXT_ATTR = 0x81a40000 // regular file, 0644
const enc = new TextEncoder()

export interface ZipEntry {
  name: string
  crc: number
  size: number
  offset: number
  dosTime: number
  /** Local header carried a Zip64 extra field. */
  zip64: boolean
}

export interface ZipState {
  /** Bytes written so far. */
  offset: number
  entries: ZipEntry[]
}

function u64(dv: DataView, at: number, n: number) {
  dv.setUint32(at, n % 0x100000000, true)
  dv.setUint32(at + 4, Math.floor(n / 0x100000000), true)
}

export function encodeName(name: string): Uint8Array {
  return enc.encode(name)
}

export function dosTime(d: Date): number {
  const y = Math.max(1980, Math.min(2107, d.getFullYear()))
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return (time | (date << 16)) >>> 0
}

/** Whether a file of this declared size gets a Zip64 local header. */
export const needsZip64 = (size: number | undefined) => (size ?? 0) >= MAX32

export function localHeader(name: Uint8Array, time: number, zip64: boolean): Uint8Array {
  const b = new Uint8Array(30 + name.length + (zip64 ? 20 : 0))
  const v = new DataView(b.buffer)
  v.setUint32(0, 0x04034b50, true)
  v.setUint16(4, zip64 ? 45 : 20, true)
  v.setUint16(6, FLAGS, true)
  v.setUint32(10, time, true)
  if (zip64) {
    v.setUint32(18, MAX32, true)
    v.setUint32(22, MAX32, true)
  }
  v.setUint16(26, name.length, true)
  v.setUint16(28, zip64 ? 20 : 0, true)
  b.set(name, 30)
  if (zip64) {
    const x = 30 + name.length
    v.setUint16(x, 0x0001, true)
    v.setUint16(x + 2, 16, true) // sizes left 0: they follow in the descriptor
  }
  return b
}

const descriptorIs64 = (zip64: boolean, size: number) => zip64 || size >= MAX32

export function dataDescriptor(crc: number, size: number, zip64: boolean): Uint8Array {
  const big = descriptorIs64(zip64, size)
  const b = new Uint8Array(big ? 24 : 16)
  const v = new DataView(b.buffer)
  v.setUint32(0, 0x08074b50, true)
  v.setUint32(4, crc, true)
  if (big) {
    u64(v, 8, size)
    u64(v, 16, size)
  } else {
    v.setUint32(8, size, true)
    v.setUint32(12, size, true)
  }
  return b
}

function cdExtraLen(size: number, offset: number) {
  const n = (size >= MAX32 ? 2 : 0) + (offset >= MAX32 ? 1 : 0)
  return n ? 4 + 8 * n : 0
}

function centralEntry(e: ZipEntry): Uint8Array {
  const name = enc.encode(e.name)
  const bigSize = e.size >= MAX32
  const bigOff = e.offset >= MAX32
  const xl = cdExtraLen(e.size, e.offset)
  const b = new Uint8Array(46 + name.length + xl)
  const v = new DataView(b.buffer)
  v.setUint32(0, 0x02014b50, true)
  v.setUint16(4, MADE_BY, true)
  v.setUint16(6, e.zip64 || xl ? 45 : 20, true)
  v.setUint16(8, FLAGS, true)
  v.setUint32(12, e.dosTime, true)
  v.setUint32(16, e.crc, true)
  v.setUint32(20, bigSize ? MAX32 : e.size, true)
  v.setUint32(24, bigSize ? MAX32 : e.size, true)
  v.setUint16(28, name.length, true)
  v.setUint16(30, xl, true)
  v.setUint32(38, EXT_ATTR, true)
  v.setUint32(42, bigOff ? MAX32 : e.offset, true)
  b.set(name, 46)
  if (xl) {
    let x = 46 + name.length
    v.setUint16(x, 0x0001, true)
    v.setUint16(x + 2, xl - 4, true)
    x += 4
    if (bigSize) {
      u64(v, x, e.size)
      u64(v, x + 8, e.size)
      x += 16
    }
    if (bigOff) u64(v, x, e.offset)
  }
  return b
}

const endIs64 = (count: number, cdOffset: number, cdSize: number) =>
  count >= 0xffff || cdOffset >= MAX32 || cdSize >= MAX32

/** Central directory + (Zip64) end records, given entries and the offset where the directory starts. */
export function centralDirectory(state: ZipState): Uint8Array {
  const parts = state.entries.map(centralEntry)
  const cdSize = parts.reduce((n, p) => n + p.length, 0)
  const cdOffset = state.offset
  const count = state.entries.length
  const big = endIs64(count, cdOffset, cdSize)
  const out = new Uint8Array(cdSize + (big ? 76 : 0) + 22)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  const v = new DataView(out.buffer)
  if (big) {
    const z = at
    v.setUint32(z, 0x06064b50, true)
    u64(v, z + 4, 44)
    v.setUint16(z + 12, MADE_BY, true)
    v.setUint16(z + 14, 45, true)
    u64(v, z + 24, count)
    u64(v, z + 32, count)
    u64(v, z + 40, cdSize)
    u64(v, z + 48, cdOffset)
    v.setUint32(z + 56, 0x07064b50, true)
    u64(v, z + 64, cdOffset + cdSize)
    v.setUint32(z + 72, 1, true)
    at += 76
  }
  v.setUint32(at, 0x06054b50, true)
  v.setUint16(at + 8, Math.min(count, 0xffff), true)
  v.setUint16(at + 10, Math.min(count, 0xffff), true)
  v.setUint32(at + 12, Math.min(cdSize, MAX32), true)
  v.setUint32(at + 16, Math.min(cdOffset, MAX32), true)
  return out
}

/** Exact size of the zip this writer produces, given final names and sizes. */
export function predictZipSize(files: { name: string; size: number }[]): number {
  let offset = 0
  let cd = 0
  for (const f of files) {
    const n = enc.encode(f.name).length
    const z = needsZip64(f.size)
    cd += 46 + n + cdExtraLen(f.size, offset)
    offset += 30 + n + (z ? 20 : 0) + f.size + (descriptorIs64(z, f.size) ? 24 : 16)
  }
  return offset + cd + (endIs64(files.length, offset, cd) ? 76 : 0) + 22
}
