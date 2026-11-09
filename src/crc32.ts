let T: Uint32Array | undefined

function table(): Uint32Array {
  const t = new Uint32Array(256 * 8)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  for (let i = 0; i < 256; i++) {
    for (let s = 1; s < 8; s++) {
      const p = t[(s - 1) * 256 + i]
      t[s * 256 + i] = (p >>> 8) ^ t[p & 0xff]
    }
  }
  return t
}

/** CRC-32 (zip polynomial), slicing-by-8. Pass the previous result to continue. */
export function crc32(data: Uint8Array, crc = 0): number {
  const t = (T ??= table())
  let c = ~crc
  let i = 0
  const n = data.length
  const end8 = n - (n & 7)
  for (; i < end8; i += 8) {
    const a = c ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))
    c =
      t[1792 + (a & 0xff)] ^
      t[1536 + ((a >>> 8) & 0xff)] ^
      t[1280 + ((a >>> 16) & 0xff)] ^
      t[1024 + (a >>> 24)] ^
      t[768 + data[i + 4]] ^
      t[512 + data[i + 5]] ^
      t[256 + data[i + 6]] ^
      t[data[i + 7]]
  }
  for (; i < n; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
