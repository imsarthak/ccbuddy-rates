// When a BLINKDEAL window ended, and what the history says when nothing was
// watching at the time: the phone died, lost its connection, or could not
// read Myntra. Windows run 33-36 min; a close stamped when the phone came
// back would record one as 6 h 40 min.
//
//   node --test scraper/window-end.test.mjs
//
// Nothing here touches the network: detect and the senders are injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { step, closeWindow, appendWindow, GAP_MS } from './blinkdeal.mjs'
import { composePost, APP_LINK } from './notify.mjs'
import { edge } from './wa-post.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'live-window-2026-09-15.json'), 'utf8'))
const published = JSON.parse(await readFile(join(HERE, '..', 'docs', 'blinkdeal-history.json'), 'utf8'))

// ---- The app's guard, as shipped --------------------------------------------
//
// Copied from the CCBuddy app (GC Management f35dd6d, src/data/blinkdeal.ts:
// isWindow, isBlinkdealHistory, isBlinkdealFeed, windowMinutes). The app drops
// a WHOLE file over one row it refuses, so whatever the watcher writes must
// pass these exactly as the live app has them. If the app changes them,
// copy them again.
const isStr = (v) => typeof v === 'string'
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isDatetime = (v) => isStr(v) && !Number.isNaN(Date.parse(v))
const opt = (v, ok) => v === undefined || v === null || ok(v)
const isSku = (s) => !!s && typeof s === 'object'
  && isNum(s.id) && isStr(s.name) && isStr(s.brand) && isNum(s.price) && isNum(s.mrp)
  && opt(s.info, isStr) && opt(s.discount, isNum) && opt(s.bestPrice, isNum) && opt(s.code, isStr)
  && isStr(s.url) && s.url.startsWith('https://www.myntra.com/')
const isWindow = (w) => !!w && typeof w === 'object'
  && isStr(w.code) && isDatetime(w.from) && opt(w.to, isDatetime) && isNum(w.skuCount)
  && opt(w.maxSkus, isNum) && opt(w.approx, (v) => typeof v === 'boolean')
function isBlinkdealHistory(h) {
  if (!h || typeof h !== 'object') return false
  if (h.generated !== undefined && !isDatetime(h.generated)) return false
  return Array.isArray(h.windows) && h.windows.every((w) => isWindow(w) && isDatetime(w.to))
}
function isBlinkdealFeed(f) {
  if (!f || typeof f !== 'object') return false
  if (!isDatetime(f.generated) || !isDatetime(f.checkedAt) || typeof f.ok !== 'boolean' || typeof f.live !== 'boolean') return false
  if (!opt(f.lastLive, isWindow) || !opt(f.discountPct, isNum) || !opt(f.code, isStr)) return false
  if (!f.live) return true
  return isStr(f.code) && Array.isArray(f.skus) && f.skus.length > 0 && f.skus.every(isSku)
}
function windowMinutes(w) {
  if (!w.to) return null
  const from = Date.parse(w.from)
  const to = Date.parse(w.to)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.max(0, Math.round((to - from) / 60_000))
}

test('the copied guard is the strict one: it refuses what the app refuses', () => {
  const row = published.windows.at(-1)
  assert.ok(isBlinkdealHistory(published), 'the published file passes')
  assert.ok(!isBlinkdealHistory({ windows: [{ ...row, to: undefined }] }), 'a row with no end sinks the file')
  assert.ok(!isBlinkdealHistory({ windows: [{ ...row, approx: 'yes' }] }), 'approx must be a boolean')
  assert.ok(!isBlinkdealHistory({ windows: [{ ...row, to: 'later' }] }), 'to must be a datetime')
})

// ---- closeWindow, with the times pinned -------------------------------------

const FROM = '2026-10-29T11:30:00.000Z' // 5:00 pm IST, the window is first seen
const SEEN = '2026-10-29T11:40:00.000Z' // 5:10 pm, the last live write before the phone went quiet
const BACK = '2026-10-29T18:10:00.000Z' // 11:40 pm, the phone is back and finds it over
const iso = (ms) => new Date(ms).toISOString()
const plus = (at, ms) => iso(Date.parse(at) + ms)
const MIN = 60 * 1000

// The feed as the phone last wrote it while the window was live.
const liveFeed = (over = {}, lastLive = {}) => ({
  generated: SEEN, checkedAt: SEEN, ok: true, heartbeatMs: 2 * MIN, live: true,
  code: 'BLINKDEAL6', couponId: '135733', skus: fixture.skus, knownIds: ['135733'],
  lastLive: { code: 'BLINKDEAL6', couponId: '135733', from: FROM, skuCount: 207, lastSeen: SEEN, ...lastLive },
  ...over,
})

test('a gap is two live heartbeats and a bit, the bound wa-post.mjs puts on a close', () => {
  assert.equal(GAP_MS, 9 * MIN)
})

test('the phone died mid-window: the end is the last sighting, marked approximate, not the restart', () => {
  const w = closeWindow(liveFeed(), BACK)
  assert.deepEqual(w, {
    code: 'BLINKDEAL6', couponId: '135733', from: FROM, skuCount: 207,
    to: SEEN, approx: true, endedBy: BACK,
  })
  assert.equal(windowMinutes(w), 10, 'at least 10 min, where the restart made it 400')
  assert.equal(windowMinutes({ from: FROM, to: BACK }), 400)
})

test('a watched close is the read that found it over, exactly as before: no new keys', () => {
  const end = plus(SEEN, 2.5 * MIN) // a heartbeat and a tick after the last write
  assert.deepEqual(closeWindow(liveFeed(), end), { code: 'BLINKDEAL6', couponId: '135733', from: FROM, skuCount: 207, to: end })
})

test('overnight the phone ticks every five minutes, and that is still watching', () => {
  const end = plus(SEEN, 5.6 * MIN)
  const w = closeWindow(liveFeed(), end)
  assert.equal(w.to, end)
  assert.equal(w.approx, undefined)
})

test('the boundary: exactly GAP_MS is watched, a millisecond more is not', () => {
  assert.equal(closeWindow(liveFeed(), plus(SEEN, GAP_MS)).approx, undefined)
  const late = closeWindow(liveFeed(), plus(SEEN, GAP_MS + 1))
  assert.equal(late.approx, true)
  assert.equal(late.to, SEEN)
})

test('a feed from before lastSeen: a good live read stands in for it', () => {
  const legacy = liveFeed({ checkedAt: SEEN }, { lastSeen: undefined })
  delete legacy.lastLive.lastSeen
  const w = closeWindow(legacy, BACK)
  assert.equal(w.to, SEEN)
  assert.equal(w.approx, true)
  assert.equal('lastSeen' in w, false)
})

test('a feed from before lastSeen whose last read failed knows no sighting, so it closes as it always did', () => {
  // A minute before the close, and hours before it: a failed read's time is
  // never taken for a sighting, or the second would record an end at a
  // moment nobody saw the window live.
  for (const failedAt of [plus(BACK, -MIN), plus(SEEN, 20 * MIN)]) {
    const legacy = liveFeed({ ok: false, stale: true, checkedAt: failedAt })
    delete legacy.lastLive.lastSeen
    assert.deepEqual(closeWindow(legacy, BACK), { code: 'BLINKDEAL6', couponId: '135733', from: FROM, skuCount: 207, to: BACK }, failedAt)
  }
})

test('last seen is never before first seen', () => {
  const w = closeWindow(liveFeed({}, { lastSeen: '2026-10-29T11:00:00.000Z' }), BACK)
  assert.equal(w.to, FROM)
  assert.equal(w.approx, true)
})

test('a feed with no lastLive at all still makes a row the app accepts', () => {
  const old = liveFeed()
  delete old.lastLive
  const w = closeWindow(old, plus(SEEN, MIN))
  assert.deepEqual(w, { code: 'BLINKDEAL6', from: SEEN, skuCount: fixture.skus.length, to: plus(SEEN, MIN) })
  assert.ok(isBlinkdealHistory({ windows: [w] }))
})

test('closeWindow does not touch the feed it is given', () => {
  const feed = liveFeed()
  const copy = structuredClone(feed)
  closeWindow(feed, BACK)
  assert.deepEqual(feed, copy)
})

// ---- step(): the watcher's ticks, on the real clock ---------------------------

const LIVE = {
  live: true, code: 'BLINKDEAL6', couponId: '135733', discountPct: 6,
  source: fixture.source, totalCount: 207, skus: fixture.skus, knownIds: ['135733'],
}
const QUIET = { live: false, knownIds: ['135733'] }
const fakeDetect = (result) => async (previous, onLive, onFirstPage) => {
  if (result instanceof Error) throw result
  if (result.live) {
    await onLive({ code: result.code, couponId: result.couponId, source: result.source, skus: result.skus.slice(0, 3) })
    await onFirstPage({ code: result.code, couponId: result.couponId, source: result.source, totalCount: result.totalCount, skus: result.skus })
  }
  return result
}
function watcher() {
  const posts = []
  const tick = (previous, result) => step(previous, {
    detect: fakeDetect(result),
    notify: async () => ({}),
    post: async (kind, w) => (posts.push({ kind, text: composePost(kind, w) }), { telegramChannel: 'sent' }),
  })
  return { posts, tick }
}
const ago = (ms) => iso(Date.now() - ms)

test('every good live read that is written stamps lastSeen; a failed read leaves it where it was', async () => {
  const { tick } = watcher()
  const opened = (await tick({ checkedAt: ago(MIN), ok: true, live: false, knownIds: [] }, LIVE)).next
  assert.equal(opened.lastLive.lastSeen, opened.checkedAt)
  assert.equal(opened.lastLive.from, opened.checkedAt)

  const beat = (await tick({ ...opened, checkedAt: ago(3 * MIN) }, LIVE)).next // the live heartbeat is due
  assert.equal(beat.lastLive.from, opened.lastLive.from)
  assert.equal(beat.lastLive.lastSeen, beat.checkedAt)

  const failed = (await tick({ ...beat, lastLive: { ...beat.lastLive, lastSeen: ago(4 * MIN) } }, new Error('fetch failed'))).next
  assert.equal(failed.ok, false)
  assert.notEqual(failed.checkedAt, failed.lastLive.lastSeen, 'checkedAt moves on a failed read')
  assert.equal(Date.now() - Date.parse(failed.lastLive.lastSeen) >= 4 * MIN, true, 'lastSeen does not')
})

test('lastSeen alone never makes a write: a live tick between heartbeats still writes nothing', async () => {
  const { tick } = watcher()
  const opened = (await tick({ checkedAt: ago(MIN), ok: true, live: false, knownIds: [] }, LIVE)).next
  const { next } = await tick(opened, LIVE)
  assert.equal(next, null, 'each write is a push over mobile data and a workflow run')
})

// The same coins with every count moved, as the next read of a live window has them.
const stocked = (stock) => ({ ...LIVE, skus: LIVE.skus.map((s) => ({ ...s, stock })) })

test('stock alone never makes a write either: the heartbeat carries the new counts', async () => {
  const { tick } = watcher()
  const opened = (await tick({ checkedAt: ago(MIN), ok: true, live: false, knownIds: [] }, stocked(752))).next
  assert.equal((await tick(opened, stocked(9))).next, null, 'every coin moved, none came or went')
  const beat = (await tick({ ...opened, checkedAt: ago(3 * MIN) }, stocked(9))).next
  assert.ok(beat.skus.every((s) => s.stock === 9))
})

test('the phone died 10 min into a window and came back 6 h 40 min after it opened', async () => {
  const { posts, tick } = watcher()
  const from = ago(400 * MIN)
  const seen = ago(390 * MIN)
  const { next, closedWindow } = await tick(liveFeed({ generated: seen, checkedAt: seen }, { from, lastSeen: seen }), QUIET)

  assert.equal(closedWindow.from, from)
  assert.equal(closedWindow.to, seen)
  assert.equal(closedWindow.approx, true)
  assert.equal(closedWindow.endedBy, next.checkedAt)
  assert.equal(windowMinutes(closedWindow), 10)
  assert.equal(closedWindow.maxSkus, fixture.skus.length)
  assert.ok(closedWindow.postedAt)
  assert.equal('lastSeen' in closedWindow, false)

  // The feed's lastLive is the same row, so "Last open" on the app agrees with "Past windows".
  const { maxSkus, postedAt, ...row } = closedWindow
  assert.deepEqual(next.lastLive, row)

  // The channel post says it is over and leaves out a length nobody measured.
  assert.deepEqual(posts.map((p) => p.kind), ['close'])
  assert.equal(posts[0].text, `BLINKDEAL6 is over\n${APP_LINK}`)
})

test('offline but alive: failed reads all through the end, then a good one finds it over', async () => {
  // The feed before the close was written seconds ago by a watcher that could
  // not see Myntra, so its own time says nothing about the window. lastSeen does.
  const { tick } = watcher()
  const from = ago(45 * MIN)
  const seen = ago(40 * MIN)
  let feed = liveFeed({ generated: seen, checkedAt: seen }, { from, lastSeen: seen })
  feed = (await tick(feed, new Error('fetch failed'))).next
  feed = (await tick({ ...feed, checkedAt: ago(3 * MIN) }, new Error('fetch failed'))).next // a failed heartbeat
  assert.equal(feed.ok, false)
  assert.ok(Date.now() - Date.parse(feed.checkedAt) < MIN)

  const { closedWindow } = await tick(feed, QUIET)
  assert.equal(closedWindow.to, seen)
  assert.equal(closedWindow.approx, true)
  assert.equal(windowMinutes(closedWindow), 5)
})

test('a watched close through step: the quiet read is the end, and the post says how long', async () => {
  const { posts, tick } = watcher()
  const from = ago(36 * MIN)
  const seen = ago(90 * 1000)
  const { next, closedWindow } = await tick(liveFeed({ generated: seen, checkedAt: seen }, { from, lastSeen: seen }), QUIET)
  assert.equal(closedWindow.to, next.checkedAt)
  assert.equal(closedWindow.approx, undefined)
  assert.equal(closedWindow.endedBy, undefined)
  assert.equal(windowMinutes(closedWindow), 36)
  assert.deepEqual(Object.keys(next.lastLive), ['code', 'couponId', 'from', 'skuCount', 'to'])
  assert.equal(posts[0].text, `BLINKDEAL6 is over — lasted 36 min, ${fixture.skus.length} coins\n${APP_LINK}`)
})

// ---- What the app reads ---------------------------------------------------------

test('the live app accepts every file the watcher now writes, gap rows included', async () => {
  const { tick } = watcher()
  const opened = (await tick({ checkedAt: ago(MIN), ok: true, live: false, knownIds: [] }, LIVE)).next
  assert.ok(isBlinkdealFeed(opened), 'a live feed carrying lastSeen')

  const seen = ago(390 * MIN)
  const { next, closedWindow } = await tick(liveFeed({ generated: seen, checkedAt: seen }, { from: ago(400 * MIN), lastSeen: seen }), QUIET)
  assert.ok(isBlinkdealFeed(next), 'the quiet feed whose lastLive is a gap row')
  const failed = (await tick(opened, new Error('fetch failed'))).next
  assert.ok(isBlinkdealFeed(failed), 'a failed read')

  const history = appendWindow(published, closedWindow, iso(Date.now()))
  assert.ok(isBlinkdealHistory(history), 'the published history with a gap row appended')
  assert.equal(history.windows.length, published.windows.length + 1)
  assert.deepEqual(history.windows.slice(0, -1), published.windows, 'past rows are never rewritten')
})

test('the live app accepts coins carrying stock, as a count or as null', async () => {
  // isSku names no stock field, and the app ignores keys it does not name.
  const { tick } = watcher()
  for (const stock of [752, 0, null]) {
    const opened = (await tick({ checkedAt: ago(MIN), ok: true, live: false, knownIds: [] }, stocked(stock))).next
    assert.ok(opened.skus.every((s) => s.stock === stock))
    assert.ok(isBlinkdealFeed(opened), String(stock))
  }
  const mixed = liveFeed({ skus: fixture.skus.map((s, i) => ({ ...s, stock: i % 2 ? null : i })) })
  assert.ok(isBlinkdealFeed(mixed), 'counts and nulls in one feed')
})

// ---- The channel post -------------------------------------------------------------

test('the close post drops the length only when the end was not seen', () => {
  const w = { code: 'BLINKDEAL6', from: FROM, to: '2026-10-29T12:06:00.000Z', maxSkus: 211 }
  assert.equal(composePost('close', w), `BLINKDEAL6 is over — lasted 36 min, 211 coins\n${APP_LINK}`)
  const gap = closeWindow(liveFeed(), BACK)
  const text = composePost('close', { ...gap, maxSkus: 211 })
  assert.equal(text, `BLINKDEAL6 is over\n${APP_LINK}`)
  assert.ok(!/lasted|null|undefined|NaN/.test(text))
})

// ---- The WhatsApp edit ------------------------------------------------------------
//
// wa-post.mjs doubts a close stamped long after the feed before the push was
// written, and then edits the post to "Over." with no time. A gap close now
// carries the last sighting instead, which is about when that feed was
// written, so the doubt no longer trips and the edit would print the last
// sighting as the end. endOf there reads `approx` as an unknown end, so the
// edit says "Over." with no time, as it did before the gap fix.

test('the WhatsApp edit on a gap close does not print the last sighting as the end', async () => {
  const { tick } = watcher()
  const seen = ago(390 * MIN)
  const before = liveFeed({ generated: seen, checkedAt: seen }, { from: ago(400 * MIN), lastSeen: seen })
  const { next, closedWindow } = await tick(before, QUIET)
  const e = edge(before, next, Date.now(), appendWindow(published, closedWindow))
  assert.equal(e.close.key.startsWith('BLINKDEAL6-'), true)
  assert.equal(e.close.to, null)
})

// ---- waAt: the phone posted the WhatsApp opening ----------------------------------
//
// While a window the phone posted to WhatsApp is live, every feed it writes
// carries `waAt` (wa-phone.mjs), so the Actions poster stands down. The app
// ignores keys it does not name; this proves the shipped guard agrees.

test('the live app accepts every feed carrying waAt, and no history row or lastLive ever carries it', async () => {
  // Stands in for the phone's poster: only the marker matters here.
  const wa = { onLive() {}, onFirstPage() {}, async settle() {}, async refresh() {}, async close() {}, async idle() {}, marker: async (next) => (next.live ? next.lastLive.from : null) }
  const tick = (previous, result) => step(previous, { detect: fakeDetect(result), notify: async () => ({}), post: async () => ({}), wa })
  const opened = (await tick({ checkedAt: ago(MIN), ok: true, live: false, knownIds: [] }, LIVE)).next
  const beat = (await tick({ ...opened, checkedAt: ago(3 * MIN) }, LIVE)).next
  const failed = (await tick(beat, new Error('fetch failed'))).next
  for (const [what, f] of [['opening', opened], ['heartbeat', beat], ['failed read', failed]]) {
    assert.equal(f.waAt, f.lastLive.from, what)
    assert.ok(isBlinkdealFeed(f), what)
    assert.equal('waAt' in f.lastLive, false, what)
  }
  const { next, closedWindow } = await tick(failed, QUIET)
  assert.equal(next.waAt, undefined)
  assert.ok(isBlinkdealFeed(next))
  assert.equal('waAt' in closedWindow, false)
  assert.ok(isBlinkdealHistory(appendWindow(published, closedWindow, iso(Date.now()))))
})
