/** Make a zip path safe: forward slashes, no empty, '.', or '..' segments, no control chars. */
export function sanitizeName(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
    .replace(/[\x00-\x1f\x7f]/g, '_')
}

/**
 * Returns a function that turns raw names into unique zip paths:
 * `a.jpg`, `a (1).jpg`, `a (2).jpg`. Comparison ignores case, because
 * Windows and macOS extract case-insensitively.
 */
export function nameResolver(): (raw: string) => string {
  const used = new Set<string>()
  return (raw) => {
    let name = sanitizeName(raw) || 'file'
    if (used.has(name.toLowerCase())) {
      const slash = name.lastIndexOf('/') + 1
      const dot = name.lastIndexOf('.')
      const cut = dot > slash ? dot : name.length
      const stem = name.slice(0, cut)
      const ext = name.slice(cut)
      let i = 1
      while (used.has(`${stem} (${i})${ext}`.toLowerCase())) i++
      name = `${stem} (${i})${ext}`
    }
    used.add(name.toLowerCase())
    return name
  }
}
