// Tiny static server for ./site (localhost counts as a secure context, so SW/OPFS work).
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import './build-site.mjs'

const root = fileURLToPath(new URL('../site/', import.meta.url))
const port = Number(process.env.PORT || 4173)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.map': 'application/json', '.ts': 'text/plain' }

createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(root, path)
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, () => console.log(`http://localhost:${port}/  (spike: http://localhost:${port}/spike/)`))
