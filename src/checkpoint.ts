import type { FileError, FileInput } from './types'
import type { ZipState } from './zip'

/** A resolved file: the user's input plus everything needed to reproduce its zip entry. */
export interface ResolvedFile {
  input: FileInput
  /** Final, unique path inside the zip. */
  zipName: string
  dosTime: number
  zip64: boolean
}

export interface Checkpoint {
  id: string
  version: 1
  createdAt: number
  updatedAt: number
  name: string
  handle: FileSystemFileHandle
  files: ResolvedFile[]
  errorsName: string
  /** Next file to write. */
  nextIndex: number
  /** Zip writer state at the last commit. Bytes up to state.offset are on disk. */
  state: ZipState
  errors: FileError[]
  total?: number
  options: {
    concurrency?: number
    maxBufferBytes?: number
    retries?: number
    retryDelayMs?: number
    onFileError?: 'fail' | 'skip'
    sizeMismatch?: 'error' | 'allow'
    checkpointBytes?: number
  }
}

const DB = 'bulkexp-zip'
const STORE = 'jobs'

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' })
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  try {
    return await new Promise<T>((res, rej) => {
      const t = d.transaction(STORE, mode)
      const r = fn(t.objectStore(STORE))
      t.oncomplete = () => res(r.result)
      t.onerror = t.onabort = () => rej(t.error ?? r.error)
    })
  } finally {
    d.close()
  }
}

export const saveCheckpoint = (c: Checkpoint) => tx('readwrite', (s) => s.put(c)).then(() => {})
export const loadCheckpoint = (id: string) => tx<Checkpoint | undefined>('readonly', (s) => s.get(id))
export const deleteCheckpoint = (id: string) => tx('readwrite', (s) => s.delete(id)).then(() => {})
export const allCheckpoints = () => tx<Checkpoint[]>('readonly', (s) => s.getAll())

export const hasIDB = () => typeof indexedDB !== 'undefined'
