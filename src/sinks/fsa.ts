import type { Sink } from './sink'

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts?: {
    suggestedName?: string
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle>
}

export const hasFSA = () =>
  typeof window !== 'undefined' && typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function'

/** Must run inside a user gesture (click). */
export function pickFile(name: string): Promise<FileSystemFileHandle> {
  return (window as SaveFilePickerWindow).showSaveFilePicker!({
    suggestedName: name,
    types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
  })
}

type PermHandle = FileSystemFileHandle & {
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>
}

export async function ensureWritePermission(h: FileSystemFileHandle) {
  const p = h as PermHandle
  if ((await p.queryPermission?.({ mode: 'readwrite' })) === 'granted') return
  const r = await p.requestPermission?.({ mode: 'readwrite' })
  if (r && r !== 'granted') throw new DOMException('Write permission denied', 'NotAllowedError')
}

/**
 * Streams into a user-chosen file.
 *
 * Chromium writes to a hidden swap file and only replaces the real file on close().
 * So `commit()` closes and reopens the stream: that is the only way to make bytes
 * survive a crash. Reopening with keepExistingData copies the file into a new swap
 * file, so commits are spaced out (see `checkpointBytes`).
 */
export async function fsaSink(handle: FileSystemFileHandle, resumeAt?: number): Promise<Sink> {
  let pos = resumeAt ?? 0
  let w = await handle.createWritable({ keepExistingData: resumeAt !== undefined })
  if (resumeAt !== undefined) {
    await w.truncate(pos)
    await w.seek(pos)
  }
  return {
    async write(c) {
      await w.write(c as Uint8Array<ArrayBuffer>)
      pos += c.length
    },
    async truncate(size) {
      await w.truncate(size)
      await w.seek(size)
      pos = size
    },
    async commit() {
      await w.close()
      w = await handle.createWritable({ keepExistingData: true })
      await w.seek(pos)
    },
    async close() {
      await w.close()
    },
    async abort(reason) {
      await w.abort(reason).catch(() => {})
    },
  }
}
