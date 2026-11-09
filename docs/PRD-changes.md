# PRD changes (Nov 9, 2026)

Edits to apply to "PRD: Browser bulk-download library" so it matches what was built.

1. **Name.** "bulkzip" → **bulkexp-zip** (free on npm as of Nov 8, 2026).

2. **Zip engine: own writer instead of client-zip.**
   - Prior art / "What bulkzip adds": replace "streams client-zip output" with "streams a built-in store-mode zip writer".
   - Tech stack, "Zip engine" row: "Own store-only writer (~150 lines). Resume needs the writer's state (byte offset + central-directory entries) saved and restored; client-zip keeps that state internal."
   - Non-functional: "No dependencies except client-zip" → "No runtime dependencies".
   - Requirement 2: predicted size comes from the writer's own `predictZipSize`, not client-zip's `predictLength`.

3. **Resume checkpoints are per commit, not per file (requirement 6).** Chromium writes to a hidden `.crswap` file and only replaces the real file on `close()`, so bytes written since the last close are lost in a crash. The library closes and reopens the file every `checkpointBytes` (default 1 GiB) and checkpoints at each commit. Each reopen copies the file so far; the cost at 10 GB must be measured (add to the risks table).

4. **API: `resume(id)` returns a job** (`{ id, tier, done, cancel() }`), like `exportZip`. Use `await resume(id).done`. Also added: `listResumable()`, `discard(id)`, `cleanup()`.

5. **Service Worker tier is optional.** Without it, Firefox uses the OPFS tier. The SW file must be served from the app's origin; the package ships `npx bulkexp-zip copy public` for that.

6. **Service Worker tier is excluded on WebKit with a `navigator.vendor` check** (Safari buffers SW downloads in memory; not feature-detectable). Exception to "tier probe at runtime, not version sniffing".

7. **New option `sizeMismatch`** (`'error'` default | `'allow'`): a file whose bytes don't match its declared `size` fails, since layout and progress use declared sizes.

8. **Risks table, add:**
   | Risk | Impact | Mitigation |
   | --- | --- | --- |
   | Cross-origin `Range` retries blocked by CORS | Retries fail on S3/CDN | Document CORS: allow `Range`, expose `Content-Range` |
   | Checkpoints store presigned URLs in IndexedDB | URLs readable on the device until they expire | Document; `getUrl` + short-lived URLs; `checkpointBytes: 0` |
   | Chromium commit copies for resume | Extra disk I/O on big exports | Measure at 10 GB; tune default `checkpointBytes` |
   | SW killed during very long downloads | Firefox export stops | Keep-alive pings; test a 10 GB Firefox export |

9. **Build plan status.** Steps 2–7 were built before the spike. The spike (step 1) still decides whether the Safari OPFS tier ships; until then publish as `0.1.0-beta` on the `next` tag.

10. **Playwright WebKit note.** Its default context is ephemeral, where OPFS throws (like Safari private browsing). Tests use a persistent profile, plus one test for the ephemeral case.
