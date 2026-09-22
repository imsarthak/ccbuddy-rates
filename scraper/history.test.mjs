// The history file the app reads for "Past windows": what appendWindow puts
// in it, and the two rules the app depends on — every write is stamped, and
// the list is bounded.
//
//   node --test scraper/history.test.mjs
//
// Nothing here touches the network or the filesystem.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendWindow } from './blinkdeal.mjs'

const AT = '2026-09-22T10:00:00.000Z'
const W = {
  code: 'BLINKDEAL6',
  couponId: '135733',
  from: '2026-09-16T11:30:43.347Z',
  to: '2026-09-16T12:06:16.538Z',
  skuCount: 211,
  maxSkus: 211,
}

test('a window is appended to the end, newest last', () => {
  const first = appendWindow(null, W, AT)
  const second = appendWindow(first, { ...W, from: '2026-09-20T11:00:00.000Z' }, AT)
  assert.equal(second.windows.length, 2)
  assert.equal(second.windows[0].from, W.from)
  assert.equal(second.windows[1].from, '2026-09-20T11:00:00.000Z')
})

test('every write is stamped with generated', () => {
  assert.equal(appendWindow(null, W, AT).generated, AT)
  // Including a rewrite of a file that never had the field: this is the
  // migration, and it happens on the first window to close after the change.
  const legacy = { windows: [W] }
  assert.equal(appendWindow(legacy, W, AT).generated, AT)
})

test('generated leads the file, as it does in blinkdeal.json', () => {
  assert.deepEqual(Object.keys(appendWindow(null, W, AT)), ['generated', 'windows'])
})

test('a stamp already in the file is replaced, never carried forward', () => {
  const older = { generated: '2026-09-01T00:00:00.000Z', windows: [W] }
  assert.equal(appendWindow(older, W, AT).generated, AT)
})

test('the history stays bounded at 100 windows, dropping the oldest', () => {
  const many = { windows: Array.from({ length: 100 }, (_, i) => ({ ...W, skuCount: i })) }
  const out = appendWindow(many, { ...W, skuCount: 999 }, AT)
  assert.equal(out.windows.length, 100)
  assert.equal(out.windows[0].skuCount, 1, 'the oldest window is the one dropped')
  assert.equal(out.windows[99].skuCount, 999)
})

test('the input is not mutated', () => {
  const history = { windows: [W] }
  appendWindow(history, { ...W, skuCount: 7 }, AT)
  assert.equal(history.windows.length, 1)
  assert.equal(history.generated, undefined)
})

test('the stamp defaults to now when the caller does not pass one', () => {
  const before = Date.now()
  const { generated } = appendWindow(null, W)
  const t = Date.parse(generated)
  assert.ok(Number.isFinite(t), 'generated parses as a date')
  assert.ok(t >= before && t <= Date.now())
})
