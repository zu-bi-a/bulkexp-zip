// Assembles the static site (demo + spike + built library) into ./site for local serving and GitHub Pages.
import { cpSync, mkdirSync, rmSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const site = new URL('site/', root)
rmSync(site, { recursive: true, force: true })
mkdirSync(site)
cpSync(new URL('demo/', root), site, { recursive: true })
cpSync(new URL('spike/', root), new URL('spike/', site), { recursive: true })
cpSync(new URL('dist/', root), new URL('bulkexp-zip/', site), { recursive: true })
console.log('site/ ready')
