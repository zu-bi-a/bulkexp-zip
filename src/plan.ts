import type { ResolvedFile } from './checkpoint'
import { nameResolver } from './names'
import { hasFSA } from './sinks/fsa'
import { freeQuota, opfsUsable } from './sinks/opfs'
import { hasSW } from './sinks/sw'
import type { FileInput, Plan, PlanOptions, Tier, UseServerReason } from './types'
import { dosTime, needsZip64, predictZipSize } from './zip'

export const DEFAULT_TIERS: Tier[] = ['fsa', 'sw', 'opfs', 'blob']
export const DEFAULT_BLOB_MAX = 500 * 1024 * 1024
/** OPFS needs a little headroom beyond the zip itself. */
const quotaNeeded = (zip: number) => zip * 1.02 + (16 << 20)

export function resolveFiles(files: FileInput[], now = new Date()) {
  const resolve = nameResolver()
  const resolved: ResolvedFile[] = files.map((input) => {
    const lm = input.lastModified
    return {
      input,
      zipName: resolve(input.name),
      dosTime: dosTime(lm === undefined ? now : new Date(lm)),
      zip64: needsZip64(input.size),
    }
  })
  return { resolved, errorsName: resolve('errors.txt') }
}

export function predictSize(resolved: ResolvedFile[]): number | undefined {
  if (!resolved.every((f) => typeof f.input.size === 'number')) return undefined
  return predictZipSize(resolved.map((f) => ({ name: f.zipName, size: f.input.size as number })))
}

/** Decide, before any bytes move, which tier will run or whether the app should use its server path. */
export async function plan(files: FileInput[], options: PlanOptions = {}): Promise<Plan> {
  const zipSize = predictSize(resolveFiles(files).resolved)
  return planForSize(zipSize, options)
}

export async function planForSize(zipSize: number | undefined, options: PlanOptions = {}): Promise<Plan> {
  const warnings: string[] = []
  if (zipSize === undefined) warnings.push('Some files have no size: progress total and quota checks are unavailable.')
  const blobMax = options.blobMaxBytes ?? DEFAULT_BLOB_MAX
  let reason: UseServerReason = 'no-supported-tier'
  let quotaFree: number | undefined

  for (const tier of options.tiers ?? DEFAULT_TIERS) {
    if (tier === 'fsa' && hasFSA()) return { ok: true, tier, zipSize, warnings }
    if (tier === 'sw' && options.serviceWorker && hasSW()) return { ok: true, tier, zipSize, warnings }
    if (tier === 'opfs' && (await opfsUsable())) {
      quotaFree = await freeQuota()
      if (zipSize === undefined || quotaFree === undefined || quotaNeeded(zipSize) <= quotaFree) {
        if (zipSize !== undefined && quotaFree === undefined) warnings.push('Storage quota is unknown.')
        return { ok: true, tier, zipSize, quotaFree, warnings }
      }
      reason = 'opfs-quota'
    }
    if (tier === 'blob') {
      if (zipSize === undefined) {
        if (reason === 'no-supported-tier') reason = 'size-unknown'
      } else if (zipSize <= blobMax) {
        return { ok: true, tier, zipSize, quotaFree, warnings }
      } else if (reason === 'no-supported-tier') {
        reason = 'too-large-for-blob'
      }
    }
  }
  return { ok: false, useServer: true, reason, zipSize, quotaFree, warnings }
}
