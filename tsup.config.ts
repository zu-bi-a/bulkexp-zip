import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    minify: true,
    sourcemap: true,
    target: 'es2022',
    treeshake: true,
  },
  {
    // Dedicated worker that owns the OPFS file. Plain script, no imports.
    entry: { 'opfs-worker': 'src/opfs-worker.ts' },
    format: ['esm'],
    minify: true,
    target: 'es2022',
    outExtension: () => ({ js: '.js' }),
  },
  {
    // Classic Service Worker script so apps can importScripts() it into an existing SW.
    entry: { sw: 'src/sw.ts' },
    format: ['iife'],
    minify: true,
    target: 'es2020',
    outExtension: () => ({ js: '.js' }),
  },
])
