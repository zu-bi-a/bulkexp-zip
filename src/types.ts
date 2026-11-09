export type Tier = 'fsa' | 'sw' | 'opfs' | 'blob'

/** One file to put in the zip. Extra fields are kept and passed back to `getUrl`. */
export interface FileInput {
  /** URL to fetch (presigned or same-origin). Either `url` or `blob` is required. */
  url?: string
  /** Local data instead of a URL. */
  blob?: Blob
  /** Path inside the zip. Slashes create folders. Duplicates are renamed `a (1).jpg`. */
  name: string
  /** Size in bytes. Optional but recommended: exact progress and quota checks need it. */
  size?: number
  /** Modification time stored in the zip. Defaults to the export start time. */
  lastModified?: Date | number
  [key: string]: unknown
}

export type UseServerReason =
  | 'opfs-quota'
  | 'too-large-for-blob'
  | 'size-unknown'
  | 'no-supported-tier'

export type Plan =
  | {
      ok: true
      tier: Tier
      /** Predicted zip size in bytes; undefined when any file has no `size`. */
      zipSize?: number
      /** Free bytes reported by `navigator.storage.estimate()` (OPFS tier). */
      quotaFree?: number
      warnings: string[]
    }
  | {
      ok: false
      useServer: true
      reason: UseServerReason
      zipSize?: number
      quotaFree?: number
      warnings: string[]
    }

export interface ServiceWorkerOptions {
  /** URL of the self-hosted service worker (`bulkexp-zip/sw.js`, or your own SW that importScripts it). */
  url: string
  /** Registration scope. Defaults to the browser default (the SW file's folder). */
  scope?: string
}

export interface PlanOptions {
  /** Tiers to try, in order. Default: ['fsa', 'sw', 'opfs', 'blob']. */
  tiers?: Tier[]
  /** Enables the Service Worker tier. */
  serviceWorker?: ServiceWorkerOptions
  /** Largest zip the in-memory Blob tier may build. Default 500 MB. */
  blobMaxBytes?: number
}

export interface Progress {
  id: string
  tier: Tier
  /** Zip bytes written so far. */
  bytes: number
  /** Predicted zip size, when every file has a `size`. */
  total?: number
  filesDone: number
  filesTotal: number
  currentFile?: string
  errors: number
}

export interface FileError {
  index: number
  name: string
  message: string
  /** True when part of the file was already streamed and could not be removed (Service Worker tier). */
  truncated?: boolean
}

export interface RunOptions {
  /** Parallel fetches. Default 4. */
  concurrency?: number
  /** Max bytes held in memory for files fetched ahead of the writer. Default 64 MB. */
  maxBufferBytes?: number
  /** Retries per file after the first attempt. Default 3. */
  retries?: number
  /** Base backoff in ms; doubles each retry. Default 500. */
  retryDelayMs?: number
  /** 'fail' (default) stops the export; 'skip' leaves the file out and adds errors.txt. */
  onFileError?: 'fail' | 'skip'
  onProgress?: (p: Progress) => void
  /**
   * What to do when a file's bytes don't match its declared `size`.
   * 'error' (default) treats it as a failed file (a short body is retried first):
   * the zip layout and progress total are computed from declared sizes.
   * 'allow' accepts whatever arrives.
   */
  sizeMismatch?: 'error' | 'allow'
  /** Re-sign URLs, e.g. when presigned URLs expire on long exports. Called for every attempt. */
  getUrl?: (file: FileInput, attempt: number) => string | Promise<string>
  /** Extra fetch options (headers, credentials...). */
  fetchInit?: RequestInit
  /** Custom fetch implementation. */
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface ExportOptions extends PlanOptions, RunOptions {
  /** File name of the zip. Default 'export.zip'. */
  name?: string
  /** Result of an earlier `plan()` call, to skip re-planning. */
  plan?: Plan
  /** A handle you obtained yourself (FSA tier). Skips the save picker. */
  fileHandle?: FileSystemFileHandle
  /** FSA tier: commit to disk and checkpoint at least this often. Default 1 GiB. 0 disables resume. */
  checkpointBytes?: number
  /** OPFS/Blob tiers: trigger the browser download when done. Default true. */
  autoSave?: boolean
  /** Override the URL of opfs-worker.js (for CSP or unusual bundlers). */
  opfsWorkerUrl?: string | URL
  /** Job id. Default: random. */
  id?: string
}

export interface ExportResult {
  id: string
  tier: Tier
  bytes: number
  files: number
  errors: FileError[]
  /** OPFS/Blob tiers: the finished zip (disk-backed for OPFS). */
  file?: Blob
}

export interface ExportJob {
  id: string
  /** Tier in use once chosen. */
  readonly tier: Tier | undefined
  done: Promise<ExportResult>
  cancel(): void
}
