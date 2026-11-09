# bulkexp-zip

Stream hundreds of remote files into one zip on the user's disk in any browser, with flat memory, parallel downloads and resume after a crash.

- Zero dependencies, ~8 kB gzipped, ESM + TypeScript.
- Zip64, UTF-8 names, duplicates renamed `a (1).jpg`. No compression (store mode).
- Tells you up front when an export should use your server instead.

## Install

```sh
npm install bulkexp-zip
```

## Usage

```ts
import { plan, exportZip, resume, listResumable } from 'bulkexp-zip'

const files = rows.map((r) => ({ url: r.presignedUrl, name: r.fileName, size: r.bytes }))

const p = await plan(files)
if (!p.ok) return startServerExport(files) // p.reason says why

// Call from a click handler (Chrome opens a save dialog)
button.onclick = () => {
  const job = exportZip(files, {
    name: 'export.zip',
    onProgress: ({ bytes, total }) => setPct(bytes / total),
  })
  // await job.done → { tier, bytes, errors }   ·   job.cancel()
}

// After a crash (Chrome/Edge), from a click handler
for (const r of await listResumable()) resume(r.id)
```

Pass each file's `size` when you can: it gives exact progress and lets `plan()` check storage space.

## How it saves

| Tier | Used by | Resume |
| --- | --- | --- |
| `fsa`: writes to a file the user picks | Chrome, Edge | Yes |
| `sw`: streams to Downloads via a Service Worker | Firefox (optional setup) | No |
| `opfs`: writes to browser storage, then downloads | Safari, Firefox | No |
| `blob`: in memory, up to 500 MB | Fallback | No |

If none fits, `plan()` returns `{ ok: false, useServer: true, reason }`.

## Options

| Option | Default | |
| --- | --- | --- |
| `concurrency` | `4` | Parallel downloads |
| `retries` | `3` | Retries per file, continuing from the last byte |
| `onFileError` | `'fail'` | `'skip'` leaves failed files out and adds `errors.txt` |
| `getUrl(file, attempt)` | | Re-sign expired presigned URLs |
| `sizeMismatch` | `'error'` | `'allow'` if your sizes are approximate |
| `checkpointBytes` | 1 GiB | How often resume saves progress; `0` turns resume off |
| `serviceWorker` | | `{ url }` to enable the `sw` tier |
| `tiers` | all | Limit or reorder tiers |

Also: `maxBufferBytes`, `blobMaxBytes`, `fetchInit`, `fetch`, `autoSave`, `fileHandle`, `opfsWorkerUrl`, `signal`. Other exports: `discard(id)`, `cleanup()`.

## Setup notes

**Service Worker (optional).** Lets Firefox stream straight to Downloads instead of going through browser storage. It must be served from your own domain:

```sh
npx bulkexp-zip copy public
```

Then pass `serviceWorker: { url: '/bulkexp-zip-sw.js' }`. If you already have a Service Worker, add `importScripts('/bulkexp-zip-sw.js')` to it instead of registering a second one.

**Vite.** Add `optimizeDeps: { exclude: ['bulkexp-zip'] }`. Other bundlers need nothing.

**CORS (S3, CDNs).** Allow `GET` and the `Range` header (used by retries), and expose `Content-Range`:

```json
[{ "AllowedOrigins": ["https://yourapp.com"], "AllowedMethods": ["GET"], "AllowedHeaders": ["Range"], "ExposeHeaders": ["Content-Range"] }]
```

**Resume.** Chrome only writes to disk when a file is closed, so progress is saved every `checkpointBytes`. Each checkpoint keeps your file list, URLs included, in IndexedDB until the export ends.

## Browser support

| Browser | Status |
| --- | --- |
| Chrome, Edge, Firefox | Tested (Playwright) |
| Safari macOS / iOS | Pending real-device testing |
| Safari private mode | No browser storage: uses `blob` or routes to server |

## Development

```sh
npm test           # unit tests
npm run test:e2e   # Chromium, Firefox, WebKit
npm run demo       # demo at localhost:4173, spike harness at /spike/
```

## License

MIT
