import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { allCheckpoints, deleteCheckpoint, loadCheckpoint, saveCheckpoint } from '../src/checkpoint'

it('stores, lists and deletes checkpoints in IndexedDB', async () => {
  const cp: any = { id: 'j1', version: 1, state: { offset: 5, entries: [] }, files: [], nextIndex: 2 }
  await saveCheckpoint(cp)
  cp.state.offset = 999 // later mutation must not leak into the stored copy
  expect((await loadCheckpoint('j1'))?.state.offset).toBe(5)
  expect((await allCheckpoints()).map((c) => c.id)).toEqual(['j1'])
  await deleteCheckpoint('j1')
  expect(await loadCheckpoint('j1')).toBeUndefined()
})
