// The watcher phone's own WhatsApp Channel post (wa-phone.mjs): once per
// window whatever the ticks do, never in the way of the Telegram alert, the
// crawl or the publish, and handed to the Actions poster whenever it did not
// (or may not have) gone out.
//
//   node --test scraper/wa-phone.test.mjs
//
// Nothing here reaches the internet. Whapi is a local fake on 127.0.0.1
// (test-fakes.mjs), GitHub's API is answered by an injected fetch, and fetch
// itself refuses every other host, so a test that forgot its fake fails
// instead of calling a real API. The real Whapi, GitHub and Telegram are never
// called from this machine.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { step, inferDiscountPct } from './blinkdeal.mjs'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  phonePoster, phoneSettings, pauseCheck, runSetup, runPhoneCheck, INERT, userTag,
  EDIT_RETRIES, CHANNEL_MAX_AGE_MS, SETTLE_MS, PHONE_TIMEOUT_MS, ADOPT_MAX_AGE_MS,
} from './wa-phone.mjs'
import { postData, renderOpen, renderOver, edge, windowKey, channelTag, PAUSE_TITLE, OPEN_MAX_AGE_MS, REST_MS, VERIFY_AFTER_MS } from './wa-post.mjs'
import { applyEnv } from './notify.mjs'
import { fakeWhapi, LINKED_NUMBER } from './test-fakes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'live-window-2026-09-15.json'), 'utf8'))

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const host = new URL(String(url)).hostname
  if (host !== '127.0.0.1') throw new Error(`a test tried to reach ${host}`)
  return realFetch(url, init)
}

const TOKEN = 'test-token-not-a-real-one-0123'
const CHANNEL = '120363000000000001@newsletter'
const OTHER = '120363000000000003@newsletter'
const OWNED = '120363000000000004@newsletter'
const REAL = { id: CHANNEL, name: 'CCBuddy Deals', user_role: 'admin', subscribers_count: 230 }
const SECOND = { id: OTHER, name: 'Another', user_role: 'admin', subscribers_count: 4 }
const MINE = { id: OWNED, name: 'Mine', user_role: 'owner', subscribers_count: 3 }
const listed = (...newsletters) => ({ 'GET /newsletters': { body: { newsletters, count: 100, total: newsletters.length, offset: 0 } } })
const SECRETS = [TOKEN, LINKED_NUMBER, ...[CHANNEL, OTHER, OWNED].flatMap((id) => [id, id.split('@')[0]])]
const leaks = (text) => SECRETS.filter((s) => text.includes(s))
const LIVE_CFG = { whapi: { token: TOKEN, dryRun: false } }
const ISSUES_URL = 'https://api.github.com/repos/imsarthak/ccbuddy-rates/issues?state=open&per_page=100'
const BOT_PAUSE = { number: 7, title: PAUSE_TITLE, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' }
const MIN = 60 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return null
  }
}

// ---- Fakes ---------------------------------------------------------------------

const LIVE = {
  live: true, code: 'BLINKDEAL6', couponId: '135733', discountPct: 6,
  source: fixture.source, totalCount: 207, skus: fixture.skus, knownIds: ['135733'],
}
const LIVE_B = { ...LIVE, code: 'BLINKDEAL', skus: fixture.skus.map((s) => ({ ...s, code: 'BLINKDEAL' })) }
const QUIET = { live: false, knownIds: ['135733'] }
const quiet = () => ({ generated: ago(MIN), checkedAt: ago(MIN), ok: true, live: false, knownIds: [] })
const stale = (feed) => ({ ...feed, checkedAt: ago(3 * MIN) })

/**
 * A detect that behaves like the real one: the plain listing (onLive), the
 * coupon's first page `firstPageMs` later (onFirstPage, with its first
 * `first` coins), then `brands` brand pages of `brandMs` each. `events` gets
 * the time of each. `failFirstPage` throws where the first page would come.
 */
const fakeDetect = (result, { first = 12, firstPageMs = 0, failFirstPage = false, brands = 0, brandMs = 0, events } = {}) => async (previous, onLive, onFirstPage) => {
  if (result instanceof Error) throw result
  if (result.live) {
    await onLive({ code: result.code, couponId: result.couponId, source: result.source, skus: result.skus.slice(0, 3) })
    events?.push(['sight', Date.now()])
    if (firstPageMs) await pause(firstPageMs)
    // The coupon's own page did not load: the tick fails after the sight.
    if (failFirstPage) throw new Error(`HTTP 503 for ${result.source}`)
    events?.push(['first page', Date.now()])
    await onFirstPage({ code: result.code, couponId: result.couponId, source: result.source, totalCount: result.totalCount, skus: result.skus.slice(0, first) })
    for (let i = 1; i <= brands; i++) {
      await pause(brandMs)
      events?.push([`brand ${i}`, Date.now()])
    }
    events?.push(['crawl done', Date.now()])
  }
  return result
}

/** GitHub's issues, answered without a network; every call recorded. */
function github({ issues = [], fail = false, status = 200, delayMs = 0 } = {}) {
  const g = { issues, fail, status, delayMs, calls: [] }
  g.fetch = async (url, init = {}) => {
    if (new URL(String(url)).hostname !== 'api.github.com') return globalThis.fetch(url, init)
    g.calls.push({ url: String(url), headers: { ...(init.headers ?? {}) }, at: Date.now() })
    if (g.delayMs) await pause(g.delayMs)
    if (g.fail) throw new TypeError('fetch failed')
    const body = g.status === 200 ? g.issues : { message: 'API rate limit exceeded' }
    return new Response(JSON.stringify(body), { status: g.status, headers: { 'content-type': 'application/json' } })
  }
  return g
}

/** The channel as an earlier tick cached it: for this token, found with the fake's linked number. */
async function warmCache(dir, { token = TOKEN, channelId = CHANNEL, checkedAt = new Date().toISOString(), user = userTag(TOKEN, LINKED_NUMBER) } = {}) {
  await writeFile(join(dir, 'channel.json'), JSON.stringify({ channelId, tag: channelTag(token, channelId), user, checkedAt }))
}

/**
 * One fake Whapi, one fake GitHub, one ledger directory and one Telegram stub,
 * shared by every tick in a test. Each tick gets a fresh poster, as each tick
 * on the phone is a fresh node process. `advance` moves the poster's clock.
 */
async function phone(t, { routes = {}, gh = {}, cfg = LIVE_CFG, warm = true, timeoutMs = 1500, settleMs = 3000 } = {}) {
  const wa = await fakeWhapi({ ...listed(REAL), ...routes })
  t.after(() => wa.close())
  const g = github(gh)
  const dir = await mkdtemp(join(tmpdir(), 'wa-phone-'))
  if (warm) await warmCache(dir)
  const lines = []
  const out = { alerts: [], posts: [] }
  let offset = 0
  const poster = (opt = {}) =>
    phonePoster({
      settings: phoneSettings(opt.cfg ?? cfg, { forceDry: !!opt.forced }),
      dir, fetch: g.fetch, whapiBase: opt.base ?? wa.base, now: () => Date.now() + offset,
      sleep: async () => {}, log: (s) => lines.push(String(s)), timeoutMs: opt.timeoutMs ?? timeoutMs, settleMs: opt.settleMs ?? settleMs,
    })
  const tick = async (previous, result, opt = {}) => {
    const r = await step(previous, {
      detect: fakeDetect(result, opt),
      notify: async (text) => (out.alerts.push({ text, at: Date.now() }), { telegram: 'sent' }),
      post: async (kind, w, o = {}) => (out.posts.push({ kind, stage: o.stage ?? null, w, at: Date.now() }), { telegramChannel: 'sent' }),
      wa: 'wa' in opt ? opt.wa : poster(opt),
    })
    return { ...r, feed: r.next ?? previous }
  }
  return {
    wa, g, dir, lines, out, poster, tick,
    advance: (ms) => (offset += ms),
    ledger: (name) => readJson(join(dir, name)),
    calls: () => wa.requests.length + g.calls.length,
    fresh: () => wa.posts().filter((p) => !p.body.edit),
    edits: () => wa.posts().filter((p) => p.body.edit),
    overEdits: () => wa.posts().filter((p) => p.body.edit && p.body.body.startsWith('Over')),
    fillEdits: () => wa.posts().filter((p) => p.body.edit && !p.body.body.startsWith('Over')),
    tgKinds: () => out.posts.map((p) => `${p.kind}${p.stage ? `/${p.stage}` : ''}`),
  }
}

/** What the phone posts at the first page: the window as the fake detect hands it over. */
function firstPageBody(result, from, first = 12) {
  const skus = result.skus.slice(0, first)
  const page = { code: result.code, couponId: result.couponId, source: result.source, totalCount: result.totalCount, skus, discountPct: inferDiscountPct(result.code, skus) }
  return renderOpen(postData({ ...page, lastLive: { code: result.code, from } }))
}

/** What the phone posts at first sight: the code, the discount from the plain listing's coins, the coupon page; no coins. */
function sightBody(result, from) {
  const page = { code: result.code, couponId: result.couponId, source: result.source, totalCount: null, skus: [], discountPct: inferDiscountPct(result.code, result.skus.slice(0, 3)) }
  return renderOpen(postData({ ...page, lastLive: { code: result.code, from } }))
}

/** A post as the ledger holds it. */
function openEntry({ code = 'BLINKDEAL6', from, postedAt = from, state = 'sent', messageId = 'PsqXn5SAD5v7HRA-wHN2ziQ0777' } = {}) {
  const data = postData({ ...LIVE, code, lastLive: { code, from } })
  return { v: 1, key: `${code}-${Date.parse(from)}`, code, from, state, messageId, channelId: CHANNEL, channelTag: channelTag(TOKEN, CHANNEL), data, body: renderOpen(data), postedAt }
}

/** A post already on file, as an earlier tick left it. */
async function seedOpen(dir, opts) {
  const entry = openEntry(opts)
  await writeFile(join(dir, 'open.json'), JSON.stringify(entry))
  return entry
}

/** Ended posts whose "Over" edit is still owed, as earlier ticks left them. */
async function seedDue(dir, codes) {
  const keys = []
  for (const [i, code] of codes.entries()) {
    const e = openEntry({ code, from: ago((40 + i) * MIN), messageId: `PsqXn5SAD5v7HRA-wHN2ziQ080${i}` })
    const edit = { state: 'due', to: null, tries: 0, lastTry: null, since: Date.now() - 30 * MIN, reason: null }
    await writeFile(join(dir, `${e.key}.json`), JSON.stringify({ ...e, endedAt: ago(30 * MIN), edit }))
    keys.push(e.key)
  }
  await writeFile(join(dir, 'due.json'), JSON.stringify(keys))
  return keys
}

// ---- 1. Dormant ------------------------------------------------------------------

test('dormant: no whapi block means no call of any kind, no waAt, and the very feed a run without the phone writes', async (t) => {
  const h = await phone(t, { cfg: {}, warm: false })
  const bare = await phone(t, { warm: false })
  const same = (a, b) => {
    // Each run stamps its own clock: compare everything but the times.
    const norm = (r) => JSON.stringify(r.next).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'T')
    assert.equal(norm(a), norm(b))
  }
  let a = quiet()
  let b = quiet()
  for (const result of [QUIET, LIVE, 'stale', new Error('HTTP 500'), LIVE, QUIET]) {
    const ra = result === 'stale' ? await h.tick(stale(a), LIVE) : await h.tick(a, result)
    const rb = result === 'stale' ? await bare.tick(stale(b), LIVE, { wa: undefined }) : await bare.tick(b, result, { wa: undefined })
    same(ra, rb)
    assert.equal(ra.feed.waAt, undefined)
    ;[a, b] = [ra.feed, rb.feed]
  }
  assert.equal(h.calls(), 0, 'not one call')
  assert.equal(h.out.alerts.length, 1)
  assert.deepEqual((await readdir(h.dir)).length, 0, 'nothing written to the ledger')
  assert.match(h.lines.join('\n'), /WA: not set up on this phone; the Actions poster posts this window/)
  assert.deepEqual(phoneSettings({}).mode, 'dormant')
  assert.deepEqual(phoneSettings({ whapi: { dryRun: false } }).mode, 'dormant')
  assert.deepEqual(phoneSettings({ whapi: { token: '  ', dryRun: false } }).mode, 'dormant')
})

test('the default in step() is inert: an importer or a test can never reach Whapi', async () => {
  for (const k of ['onLive', 'onFirstPage', 'settle', 'refresh', 'close', 'idle', 'marker']) assert.equal(typeof INERT[k], 'function')
  assert.equal(await INERT.marker({ live: true }), null)
  assert.ok(Object.isFrozen(INERT))
  // A tick without a Whapi token does not even load this module.
  const src = await readFile(join(HERE, 'blinkdeal.mjs'), 'utf8')
  assert.doesNotMatch(src, /^import[^\n]*wa-phone/m, 'no static import')
  assert.match(src, /if \(typeof token !== 'string' \|\| !token\.trim\(\)\) return undefined\s+const \{ phoneFromConfig \} = await import\('\.\/wa-phone\.mjs'\)/, 'imported only with a token')
})

// ---- 2. Dry ---------------------------------------------------------------------------

test('dry: a token without "dryRun": false prints the exact post and calls nothing', async (t) => {
  for (const cfg of [{ whapi: { token: TOKEN } }, { whapi: { token: TOKEN, dryRun: true } }, { whapi: { token: TOKEN, dryRun: 'false' } }, { whapi: { token: TOKEN, dryRun: false, channelId: 'CCBuddy Deals' } }]) {
    const h = await phone(t, { cfg })
    const { next } = await h.tick(quiet(), LIVE)
    assert.equal(next.waAt, undefined, JSON.stringify(cfg))
    assert.ok(h.lines.join('\n').includes(`would post:\n${firstPageBody(LIVE, next.lastLive.from)}`), h.lines.join('\n'))
    const { next: closed } = await h.tick(next, QUIET)
    assert.equal(closed.waAt, undefined)
    assert.equal(h.calls(), 0, JSON.stringify(cfg))
    assert.equal(h.out.alerts.length, 1, 'Telegram as ever')
    assert.deepEqual(await readdir(h.dir), ['channel.json'], 'no post, so no ledger')
  }
})

test('--dry-run prints the post and the edit it would make, and writes nothing', async (t) => {
  const h = await phone(t)
  const from = ago(2 * MIN)
  await seedOpen(h.dir, { from })
  const before = await readFile(join(h.dir, 'open.json'), 'utf8')
  const feed = { ...quiet(), live: true, code: 'BLINKDEAL6', ok: true, skus: fixture.skus, lastLive: { code: 'BLINKDEAL6', from, skuCount: 12, lastSeen: ago(MIN) } }
  const { next } = await h.tick(feed, QUIET, { forced: true })
  assert.match(h.lines.join('\n'), /DRY \(--dry-run\): would edit the post for BLINKDEAL6 to:\nOver at /)
  const { next: opened } = await h.tick(quiet(), LIVE_B, { forced: true })
  assert.match(h.lines.join('\n'), /DRY \(--dry-run\): would post:\nBLINKDEAL live on Myntra/)
  assert.equal(opened.waAt, undefined)
  assert.equal(next.waAt, undefined)
  assert.equal(h.calls(), 0)
  assert.equal(await readFile(join(h.dir, 'open.json'), 'utf8'), before, 'the ledger untouched')
  assert.deepEqual((await readdir(h.dir)).sort(), ['channel.json', 'open.json'])
})

test('dry still ends a post the phone already made: dryRun stops new posts only', async (t) => {
  const h = await phone(t, { cfg: { whapi: { token: TOKEN, dryRun: true } } })
  const live = (await (await phone(t)).tick(quiet(), LIVE)).feed
  await seedOpen(h.dir, { from: live.lastLive.from })
  const { closedWindow, next } = await h.tick(live, QUIET)
  assert.ok(closedWindow)
  assert.equal(h.edits().length, 1)
  assert.equal(h.edits()[0].body.body, renderOver(postData({ ...LIVE, lastLive: { code: 'BLINKDEAL6', from: live.lastLive.from } }), next.lastLive.to))
})

// ---- 3. A live opening ------------------------------------------------------------------

test('a live opening: one post of the exact text, written ahead, the Telegram alert and post as ever, and waAt', async (t) => {
  let during = null
  const h = await phone(t, {
    routes: {
      'POST /messages/text': (req) => {
        during = JSON.parse(readFileSync(join(h.dir, 'open.json'), 'utf8')).state
        return { body: { sent: true, message: { id: 'PsqXn5SAD5v7HRA-wHN2ziQ0001' } } }
      },
    },
  })
  const { next } = await h.tick(quiet(), LIVE)
  const [post] = h.wa.posts()
  assert.equal(h.wa.posts().length, 1)
  assert.deepEqual(post.body, { to: CHANNEL, body: renderOpen(postData(next)), no_link_preview: true })
  assert.equal(post.body.body, firstPageBody(LIVE, next.lastLive.from))
  assert.equal(post.auth, `Bearer ${TOKEN}`)
  assert.equal(during, 'sending', 'open.json is on disk before the request')
  const open = await h.ledger('open.json')
  assert.equal(open.state, 'sent')
  assert.equal(open.messageId, 'PsqXn5SAD5v7HRA-wHN2ziQ0001')
  assert.equal(open.key, windowKey(next))
  assert.equal(next.waAt, next.lastLive.from <= open.postedAt ? open.postedAt : next.lastLive.from)
  assert.ok(Date.parse(next.waAt) >= Date.parse(next.lastLive.from), 'never before the window started')
  assert.equal(h.out.alerts.length, 1)
  assert.deepEqual(h.tgKinds(), ['open/sight', 'open/full'])
  assert.ok(next.alertedAt && next.postedAt)
  assert.equal(open.stage, 'full', 'the first page came before the checks were done: sent whole, nothing to fill in')
  assert.equal(h.edits().length, 0)
  assert.match(h.lines.join('\n'), /^WA open sent at /m)
  // Actions, on this push: stands down.
  const e = edge(quiet(), next, Date.now())
  assert.equal(e.open, null)
  assert.match(e.notes.join(' '), /the phone posted this window/)
  assert.deepEqual(h.g.calls.map((c) => c.url), [ISSUES_URL])
})

test('the post goes out at the first page, before the crawl, while the crawl goes on', async (t) => {
  const h = await phone(t)
  const events = []
  const started = Date.now()
  const { next } = await h.tick(quiet(), LIVE, { brands: 4, brandMs: 150, events })
  const at = Object.fromEntries(events)
  const [post] = h.wa.posts()
  assert.ok(post.at < at['brand 1'], `the post reached Whapi ${post.at - at['first page']} ms after the first page, before the first brand page came back`)
  assert.ok(post.at < at['crawl done'])
  assert.ok(h.out.posts[0].at <= at['brand 1'], 'and the Telegram channel post was not held up by it')
  assert.ok(Date.now() - started < 600 + 1000, 'the tick took the crawl, not the crawl plus the post')
  assert.ok(next.waAt)
})

// ---- 4. Whapi slow, hung or throwing ---------------------------------------------------------

test('Whapi hangs: the alert, the Telegram post and the crawl are untouched, the tick ends at the timeout, and it is never sent again', async (t) => {
  const h = await phone(t, { routes: { 'POST /messages/text': { hang: true } }, timeoutMs: 400 })
  const events = []
  const started = Date.now()
  const { next } = await h.tick(quiet(), LIVE, { brands: 2, brandMs: 50, events })
  const took = Date.now() - started
  assert.ok(took >= 400 && took < 400 + 1200, `the tick took ${took} ms: the timeout and some slack`)
  assert.equal(h.out.alerts.length, 1)
  assert.ok(h.out.alerts[0].at - started < 200, 'the alert went at once')
  assert.ok(h.out.posts[0].at - started < 200, 'the Telegram channel post went at once')
  assert.ok(events.find(([e]) => e === 'crawl done')[1] - started < 400, 'the crawl ran beside it')
  assert.equal(next.live, true)
  assert.ok(next.waAt, 'it may have gone out: Actions must not post it too')
  assert.equal((await h.ledger('open.json')).state, 'unknown')
  assert.match(h.lines.join('\n'), /WA open may have gone out \(Whapi send: no answer \(timed out\)\)/)
  // The next ticks never try again.
  await h.tick(stale(next), LIVE)
  await h.tick(next, new Error('fetch failed'))
  assert.equal(h.wa.posts().length, 1)
})

test('Whapi slow: the publish waits for the send, no longer', async (t) => {
  const h = await phone(t, { routes: { 'POST /messages/text': { delay: 300, body: { sent: true, message: { id: 'PsqXn5SAD5v7HRA-wHN2ziQ0001' } } } } })
  const started = Date.now()
  const { next } = await h.tick(quiet(), LIVE)
  assert.ok(Date.now() - started >= 300)
  assert.ok(Date.now() - started < 300 + 1000)
  assert.ok(next.waAt)
  assert.equal((await h.ledger('open.json')).state, 'sent')
})

test('a post not at its send by the end of the crawl is left to Actions, and never sent after the feed is written', async (t) => {
  const h = await phone(t, { gh: { delayMs: 600 }, settleMs: 100 })
  const started = Date.now()
  const { next } = await h.tick(quiet(), LIVE)
  assert.ok(Date.now() - started < 500, 'the tick did not wait for the slow pause check')
  assert.equal(next.waAt, undefined, 'so the feed says Actions posts it')
  assert.ok(edge(quiet(), next, Date.now()).open, 'and Actions does')
  await pause(900)
  assert.equal(h.wa.posts().length, 0, 'and the phone never does')
  assert.match(h.lines.join('\n'), /not at the send by the end of the crawl/)
})

test('a WhatsApp poster that throws everywhere costs the tick nothing', async (t) => {
  const h = await phone(t)
  const boom = () => {
    throw new Error('boom')
  }
  const wa = { onLive: boom, onFirstPage: boom, settle: async () => boom(), refresh: async () => boom(), close: async () => boom(), idle: async () => boom(), marker: async () => boom() }
  const { next } = await h.tick(quiet(), LIVE, { wa })
  assert.equal(next.live, true)
  assert.equal(next.ok, true)
  assert.equal(next.waAt, undefined)
  assert.equal(h.out.alerts.length, 1)
  assert.deepEqual(h.tgKinds(), ['open/sight', 'open/full'])
  const { closedWindow, next: closed } = await h.tick(next, QUIET, { wa })
  assert.ok(closedWindow.postedAt, 'the Telegram close still posts')
  assert.equal(closed.live, false)
  assert.ok((await h.tick(closed, QUIET, { wa })).feed)
})

// ---- 5 and 6. Sent or not ----------------------------------------------------------------------

const refuse = (status) => ({ status, body: { error: { code: status, message: `no ${TOKEN} ${LINKED_NUMBER} ${CHANNEL}` } } })

test('a code no ledger can name is not posted, as Actions would not post it: no call, no waAt, nothing on file', async (t) => {
  const h = await phone(t)
  const odd = { ...LIVE, code: 'BLINK_DEAL6', skus: fixture.skus.map((s) => ({ ...s, code: 'BLINK_DEAL6' })) }
  const { next } = await h.tick(quiet(), odd)
  assert.equal(h.wa.requests.length, 0)
  assert.equal(next.waAt, undefined)
  assert.equal(await h.ledger('open.json'), null)
  assert.match(h.lines.join('\n'), /cannot name a window; not posting/)
  assert.equal(h.out.alerts.length, 1, 'the Telegram alert as ever')
  assert.equal(edge(quiet(), next, Date.now()).open, null, 'Actions refuses it too')
})

test('definitely not sent (401, 402, 403, 404, or no connection at all): no retry, no waAt, nothing on file, Actions posts', async (t) => {
  for (const status of [401, 402, 403, 404]) {
    const h = await phone(t, { routes: { 'POST /messages/text': refuse(status) } })
    const { next } = await h.tick(quiet(), LIVE)
    assert.equal(h.wa.posts().length, 1, `${status}: never retried`)
    assert.equal(next.waAt, undefined, String(status))
    assert.equal(await h.ledger('open.json'), null)
    assert.ok(edge(quiet(), next, Date.now()).open, 'Actions takes the window')
    assert.match(h.lines.join('\n'), new RegExp(`WA open not sent \\(Whapi send: HTTP ${status}`))
    assert.deepEqual(leaks(h.lines.join('\n')), [])
    assert.equal(await h.ledger('hold.json'), null)
  }
  // Whapi not even reachable: the request never left the phone.
  const closed = await fakeWhapi()
  const base = closed.base
  await closed.close()
  const h = await phone(t)
  const { next } = await h.tick(quiet(), LIVE, { base })
  assert.equal(next.waAt, undefined)
  assert.equal(await h.ledger('open.json'), null)
})

test('429: not retried, no waAt, the number rests 2 days: the next window makes no call at all', async (t) => {
  const h = await phone(t, { routes: { 'POST /messages/text': [refuse(429), { body: { sent: true, message: { id: 'PsqXn5SAD5v7HRA-wHN2ziQ0002' } } }] } })
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.wa.posts().length, 1)
  assert.equal(next.waAt, undefined)
  const hold = await h.ledger('hold.json')
  assert.ok(Math.abs(Date.parse(hold.until) - (Date.now() + REST_MS)) < 5000)
  const calls = h.calls()
  const { next: over } = await h.tick(next, QUIET)
  const { next: again } = await h.tick(over, LIVE_B)
  assert.equal(h.calls(), calls, 'no Whapi call and no GitHub call')
  assert.equal(again.waAt, undefined)
  assert.match(h.lines.join('\n'), /resting the number after a 429; the Actions poster takes this window/)
  // Two days on, it posts again.
  h.advance(REST_MS + MIN)
  const { next: later } = await h.tick((await h.tick(again, QUIET)).feed, LIVE)
  assert.ok(later.waAt)
  assert.equal(h.fresh().length, 2)
})

test('a 5xx may have gone out: no retry, waAt set, and its end cannot be edited in', async (t) => {
  const h = await phone(t, { routes: { 'POST /messages/text': refuse(503) } })
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.wa.posts().length, 1)
  assert.ok(next.waAt)
  assert.equal((await h.ledger('open.json')).state, 'unknown')
  const calls = h.calls()
  const { next: over } = await h.tick(next, QUIET)
  assert.equal(h.calls(), calls, 'no edit, no check, no call')
  assert.equal(over.waAt, undefined)
  assert.equal((await h.ledger(`${windowKey(next)}.json`)).edit.state, 'none')
  assert.equal(await h.ledger('open.json'), null)
})

// ---- 7. The pause issue ----------------------------------------------------------------------------

test('an open pause issue (the bot\'s or the owner\'s) stops the phone: no Whapi call, no waAt', async (t) => {
  const owner = { ...BOT_PAUSE, user: { login: 'someone', type: 'User' }, author_association: 'OWNER' }
  for (const issue of [BOT_PAUSE, owner]) {
    const h = await phone(t, { gh: { issues: [issue] } })
    const { next } = await h.tick(quiet(), LIVE)
    assert.equal(h.wa.requests.length, 0)
    assert.equal(next.waAt, undefined)
    assert.ok(edge(quiet(), next, Date.now()).open, 'Actions meets the same issue and notes the window')
    assert.match(h.lines.join('\n'), /the poster is paused/)
    assert.equal(h.g.calls.filter((c) => c.headers?.authorization).length, 0)
  }
  // A stranger's issue with the same title is not the switch.
  const h = await phone(t, { gh: { issues: [{ ...BOT_PAUSE, user: { login: 'someone', type: 'User' }, author_association: 'NONE' }] } })
  assert.ok((await h.tick(quiet(), LIVE)).next.waAt)
  assert.equal(h.fresh().length, 1)
})

test('a pause check that fails leaves the window to Actions: no Whapi call, no waAt', async (t) => {
  for (const gh of [{ fail: true }, { status: 403 }, { status: 404 }]) {
    const h = await phone(t, { gh })
    const { next } = await h.tick(quiet(), LIVE)
    assert.equal(h.wa.requests.length, 0, JSON.stringify(gh))
    assert.equal(next.waAt, undefined)
    assert.match(h.lines.join('\n'), /could not read the pause issue/)
  }
})

test('the pause check starts beside the alert, uses no credential, and never runs on a quiet tick', async (t) => {
  const h = await phone(t)
  let feed = (await h.tick(quiet(), QUIET)).feed
  feed = (await h.tick(stale(feed), QUIET)).feed
  assert.equal(h.g.calls.length, 0, 'quiet ticks ask nothing')
  const events = []
  await h.tick(feed, LIVE, { firstPageMs: 150, events })
  assert.equal(h.g.calls.length, 1)
  assert.ok(h.g.calls[0].at < Object.fromEntries(events)['first page'], 'asked at onLive, read at the first page')
  assert.equal(h.g.calls[0].url, ISSUES_URL)
  assert.equal(h.g.calls[0].headers.authorization, undefined)
  // pauseCheck itself, through findPause.
  assert.equal(await pauseCheck({ fetch: github({ issues: [BOT_PAUSE] }).fetch }), 'paused')
  assert.equal(await pauseCheck({ fetch: github().fetch }), 'clear')
  await assert.rejects(pauseCheck({ fetch: github({ status: 500 }).fetch }), /HTTP 500/)
})

// ---- 8. Restarts and lost writes ------------------------------------------------------------------

test('a lost feed write: the same window seen again is not posted again, and the feed says the phone took it', async (t) => {
  const h = await phone(t)
  const { next: first } = await h.tick(quiet(), LIVE)
  assert.equal(h.fresh().length, 1)
  await pause(5)
  // The push never happened (a failed rebase reset the clone): the next tick reads the old quiet feed.
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.fresh().length, 1, 'no second post')
  const open = await h.ledger('open.json')
  assert.equal(open.key, windowKey(first), 'left as it was: the ledger matches a window by its code')
  assert.equal(open.messageId, 'PsqXn5SAD5v7HRA-wHN2ziQ0001')
  assert.ok(next.waAt)
  assert.ok(Date.parse(next.waAt) >= Date.parse(next.lastLive.from), 'not mistaken by Actions for a left-over one')
  assert.equal(edge(quiet(), next, Date.now()).open, null, 'Actions stands down')
  assert.notEqual(windowKey(first), windowKey(next))
  assert.match(h.lines.join('\n'), /was posted at .* by an earlier tick that did not publish it; not posting it again/)
  // And its end is still edited in.
  await h.tick(next, QUIET)
  assert.equal(h.edits().length, 1)
})

test('a send the phone died in (sending left on file) is never sent again', async (t) => {
  const h = await phone(t)
  await seedOpen(h.dir, { from: ago(MIN), state: 'sending', messageId: null })
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.wa.posts().length, 0)
  assert.ok(next.waAt, 'it may have gone out')
  await h.tick(next, QUIET)
  assert.equal(h.wa.posts().length, 0, 'and with no id there is nothing to edit')
})

test('back more than 15 min later, the window still live and its feed lost: not posted again, and never edited "Over"', async (t) => {
  const h = await phone(t)
  await h.tick(quiet(), LIVE) // posted; the feed write is lost (killed mid-tick, or Ctrl-C)
  h.advance(OPEN_MAX_AGE_MS + MIN)
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.fresh().length, 1, 'one post for one window')
  assert.equal(h.edits().length, 0, 'and the live post is not called over')
  assert.ok(next.waAt)
  assert.equal(edge(quiet(), next, Date.now()).open, null, 'Actions stands down')
  assert.match(h.lines.join('\n'), /not posting it again/)
})

test('a lost feed write, 3 h with no good read, then the same code live: a new window, posted, and the old post ended with no time', async (t) => {
  assert.ok(ADOPT_MAX_AGE_MS < 3 * 60 * MIN && ADOPT_MAX_AGE_MS > OPEN_MAX_AGE_MS + MIN, 'between a restart in one window and the next window')
  const h = await phone(t)
  await h.tick(quiet(), LIVE) // posted; the feed write is lost, then the phone is off (or every read fails)
  const old = await h.ledger('open.json')
  await pause(5)
  h.advance(3 * 60 * MIN)
  // Another BLINKDEAL6 window is live; the feed on file is still the quiet one from before the first.
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.fresh().length, 2, 'the new window is posted')
  assert.equal(h.fresh()[1].body.body, firstPageBody(LIVE, next.lastLive.from))
  assert.ok(next.waAt)
  assert.equal(edge(quiet(), next, Date.now()).open, null, 'posted once, by the phone')
  assert.equal((await h.ledger('open.json')).key, windowKey(next))
  assert.deepEqual(await h.ledger('due.json'), [old.key])
  assert.equal(h.edits().length, 0, 'nothing in the way of the post')
  // The old post's end is made on the next tick: "Over." with no time, never the new window's.
  await h.tick(next, LIVE)
  assert.equal(h.edits().length, 1)
  assert.deepEqual(h.edits()[0].body, { to: CHANNEL, edit: old.messageId, body: renderOver(old.data, null), no_link_preview: true })
  assert.match(h.edits()[0].body.body, /^Over\. These prices no longer apply\./)
  assert.equal((await h.ledger('open.json')).key, windowKey(next), 'the new post stays open')
})

test('a lost feed write, then quiet reads: the first good read ends the post, and the same code reopening is a new window, posted', async (t) => {
  const h = await phone(t)
  await h.tick(quiet(), LIVE) // posted; the feed write is lost
  const old = await h.ledger('open.json')
  h.advance(3 * MIN)
  // Back 3 min later: the window is over. The feed on file is still the quiet one from before it.
  let feed = (await h.tick(stale(quiet()), QUIET)).feed
  assert.equal(await h.ledger('open.json'), null, 'the first good read ended it')
  assert.equal(h.edits().length, 1)
  assert.deepEqual(h.edits()[0].body, { to: CHANNEL, edit: old.messageId, body: renderOver(old.data, null), no_link_preview: true })
  assert.match(h.edits()[0].body.body, /^Over\. These prices no longer apply\./, 'an end nobody watched: no time')
  for (let i = 0; i < 3; i++) {
    h.advance(MIN)
    feed = (await h.tick(stale(feed), QUIET)).feed
  }
  assert.equal(h.edits().length, 1, 'once')
  // The same code opens again, 8 min after the first post: a new window, and the phone posts it.
  h.advance(MIN)
  const { next } = await h.tick(feed, LIVE)
  assert.equal(h.fresh().length, 2)
  assert.ok(next.waAt)
  assert.equal(edge(feed, next, Date.now()).open, null, 'posted once, by the phone')
  // A failed read settles nothing: a post stays on file through it.
  const failed = (await h.tick(next, new Error('fetch failed'))).feed
  assert.ok(await h.ledger('open.json'))
  assert.ok(failed.waAt)
})

test('a post on file of another code ended unseen: the new one is posted at once, and the old one ended on the next tick', async (t) => {
  const h = await phone(t)
  const old = await seedOpen(h.dir, { code: 'BLINKDEAL', from: ago(OPEN_MAX_AGE_MS + 5 * MIN) })
  const started = Date.now()
  const { next } = await h.tick(quiet(), LIVE)
  assert.ok(Date.now() - started < 1000)
  assert.equal(h.wa.posts().length, 1, 'the news, and nothing in its way')
  assert.equal(h.wa.posts()[0].body.body, renderOpen(postData(next)))
  assert.ok(next.waAt)
  assert.deepEqual(await h.ledger('due.json'), [old.key])
  await h.tick(next, LIVE)
  const posts = h.wa.posts()
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1].body, { to: CHANNEL, edit: old.messageId, body: renderOver(old.data, null), no_link_preview: true })
  assert.equal((await h.ledger(`${old.key}.json`)).edit.state, 'done')
  assert.equal((await h.ledger('open.json')).key, windowKey(next))
})

test('two runs on one clone (a hand run beside the loop): one post, and both feeds carry waAt', async (t) => {
  for (const gapMs of [5, 60]) {
    const h = await phone(t)
    // Each run is a whole step() with its own clock, so each names the window with its own start.
    const a = h.tick(quiet(), LIVE, { brands: 2, brandMs: 100 })
    await pause(gapMs)
    const b = h.tick(quiet(), LIVE, { brands: 2, brandMs: 100 })
    const [ra, rb] = await Promise.all([a, b])
    assert.notEqual(windowKey(ra.next), windowKey(rb.next))
    assert.equal(h.fresh().length, 1, `${gapMs} ms apart`)
    assert.ok(ra.next.waAt && rb.next.waAt, `${gapMs} ms apart: whichever feed is pushed, Actions stands down`)
    for (const [x, y] of [[ra.next, rb.next], [rb.next, ra.next]]) {
      assert.equal(edge(quiet(), x, Date.now()).open, null)
      const e = edge(x, y, Date.now())
      assert.deepEqual([e.open, e.close], [null, null])
    }
  }
  const script = await readFile(join(HERE, 'watch-termux.sh'), 'utf8')
  assert.match(script, /Refusing to start: a watcher loop is already running in this clone/, 'and the loop refuses a second one')
})

// ---- 9 and 10. Mid-window ticks and the end ------------------------------------------------------------

test('mid-window ticks make no call; waAt is on every live feed written, and in no history row or lastLive', async (t) => {
  const h = await phone(t)
  let { feed } = await h.tick(quiet(), LIVE)
  assert.ok(feed.waAt)
  const calls = h.calls()
  const r1 = await h.tick(feed, LIVE)
  assert.equal(r1.next, null, 'nothing new: not written')
  const beat = (await h.tick(stale(feed), LIVE)).next
  assert.ok(beat.waAt, 'the heartbeat carries it')
  const failed = (await h.tick(beat, new Error('fetch failed'))).next
  assert.equal(failed.ok, false)
  assert.ok(failed.waAt, 'so does a failed read')
  const back = (await h.tick(failed, LIVE)).next
  assert.ok(back.waAt, 'and the recovery')
  assert.equal(h.calls(), calls, 'not one call in between')
  for (const f of [feed, beat, failed, back]) assert.equal('waAt' in (f.lastLive ?? {}), false)
  const { next: over, closedWindow } = await h.tick(back, QUIET)
  assert.equal(over.waAt, undefined, 'gone with the window')
  assert.equal('waAt' in closedWindow, false)
  assert.equal('waAt' in over.lastLive, false)
  assert.equal(edge(back, over, Date.now()).close, null, 'Actions leaves the end to the phone')
  const quietAgain = (await h.tick({ ...over, checkedAt: ago(30 * MIN) }, QUIET)).next
  assert.equal(quietAgain.waAt, undefined)
})

test('the end: exactly one edit, "Over at …" with the watched end time', async (t) => {
  const h = await phone(t)
  const { feed } = await h.tick(quiet(), LIVE)
  const open = await h.ledger('open.json')
  await pause(5)
  const { next } = await h.tick(feed, QUIET)
  const [edit] = h.edits()
  assert.equal(h.edits().length, 1)
  assert.deepEqual(edit.body, { to: CHANNEL, edit: open.messageId, body: renderOver(open.data, next.lastLive.to), no_link_preview: true })
  assert.match(edit.body.body, /^Over at \d+:\d\d [ap]m, after 0 min\. These prices no longer apply\./)
  assert.equal(await h.ledger('open.json'), null)
  assert.equal((await h.ledger(`${open.key}.json`)).edit.state, 'done')
  assert.match(h.lines.join('\n'), /WA edit made at .*: BLINKDEAL6 is over/)
  // Quiet ticks after it: nothing.
  const calls = h.calls()
  await h.tick(stale(next), QUIET)
  await h.tick(next, QUIET)
  assert.equal(h.calls(), calls)
})

test('an end nobody watched (the phone was off) is edited to "Over." with no time', async (t) => {
  const h = await phone(t)
  const from = ago(400 * MIN)
  const seen = ago(390 * MIN)
  const open = await seedOpen(h.dir, { from })
  const previous = { generated: seen, checkedAt: seen, ok: true, heartbeatMs: 2 * MIN, live: true, code: 'BLINKDEAL6', couponId: '135733', skus: fixture.skus, knownIds: ['135733'], lastLive: { code: 'BLINKDEAL6', couponId: '135733', from, skuCount: 12, lastSeen: seen } }
  const { closedWindow } = await h.tick(previous, QUIET)
  assert.equal(closedWindow.approx, true)
  const [edit] = h.edits()
  assert.equal(edit.body.body, renderOver(open.data, null))
  assert.match(edit.body.body, /^Over\. These prices no longer apply\./)
})

test('a code change mid-window: the new code is posted, then the old post is ended with no time, as Actions would', async (t) => {
  const h = await phone(t)
  const { feed } = await h.tick(quiet(), LIVE)
  const old = await h.ledger('open.json')
  const { next } = await h.tick(feed, LIVE_B)
  assert.equal(h.wa.posts().length, 2, 'the opening tick makes the post and nothing else')
  await h.tick(next, LIVE_B)
  const posts = h.wa.posts()
  assert.equal(posts.length, 3)
  assert.match(posts[1].body.body, /^BLINKDEAL live on Myntra/)
  assert.equal(posts[1].body.edit, undefined)
  assert.deepEqual(posts[2].body, { to: CHANNEL, edit: old.messageId, body: renderOver(old.data, null), no_link_preview: true })
  assert.ok(next.waAt)
  assert.equal((await h.ledger('open.json')).code, 'BLINKDEAL')
  // What Actions makes of the same push: nothing, both were the phone's.
  const e = edge(feed, next, Date.now())
  assert.deepEqual([e.open, e.close], [null, null])
  // Telegram as before: one opening per code, each sent at sight and filled in at the first page.
  assert.deepEqual(h.out.posts.map((p) => `${p.kind}/${p.stage} ${p.w.code}`), ['open/sight BLINKDEAL6', 'open/full BLINKDEAL6', 'open/sight BLINKDEAL', 'open/full BLINKDEAL'])
})

// ---- 11. An edit that fails ----------------------------------------------------------------------

// The "Over" edits fail; the post, and any edit that fills it in, go through.
const editFails = (answer) => ({
  'POST /messages/text': (req) =>
    req.body.edit && req.body.body.startsWith('Over') ? answer : { body: { sent: true, message: { id: req.body.edit ?? 'PsqXn5SAD5v7HRA-wHN2ziQ0001' } } },
})

test('an edit that fails for a moment is tried again on later ticks: 3 more tries at most, 20 s apart, each after a pause check', async (t) => {
  const h = await phone(t, { routes: editFails({ status: 502, body: {} }) })
  const { feed } = await h.tick(quiet(), LIVE)
  let { feed: q } = await h.tick(feed, QUIET)
  assert.equal(h.edits().length, 1)
  assert.deepEqual(await h.ledger('due.json'), [windowKey(feed)])
  const gh = h.g.calls.length
  h.advance(5000)
  q = (await h.tick(q, QUIET)).feed
  assert.equal(h.edits().length, 1, 'not before 20 s')
  assert.equal(h.g.calls.length, gh, 'and no pause check either')
  for (let i = 2; i <= 1 + EDIT_RETRIES; i++) {
    h.advance(21000)
    q = (await h.tick(q, QUIET)).feed
    assert.equal(h.edits().length, i)
  }
  assert.equal(h.g.calls.length, gh + EDIT_RETRIES, 'one pause check before each')
  h.advance(21000)
  await h.tick(q, QUIET)
  assert.equal(h.edits().length, 1 + EDIT_RETRIES, 'then it stops')
  assert.equal((await h.ledger(`${windowKey(feed)}.json`)).edit.state, 'failed')
  assert.equal(await h.ledger('due.json'), null)
})

test('an edit refused with a 4xx is not tried again', async (t) => {
  const h = await phone(t, { routes: editFails(refuse(403)) })
  const { feed } = await h.tick(quiet(), LIVE)
  let { feed: q } = await h.tick(feed, QUIET)
  for (let i = 0; i < 3; i++) {
    h.advance(21000)
    q = (await h.tick(q, QUIET)).feed
  }
  assert.equal(h.edits().length, 1)
  assert.equal((await h.ledger(`${windowKey(feed)}.json`)).edit.state, 'failed')
  assert.deepEqual(leaks(h.lines.join('\n')), [])
})

test('while paused no edit is made and no call is spent on it; the first end after the issue closes makes it', async (t) => {
  const h = await phone(t)
  const { feed } = await h.tick(quiet(), LIVE)
  h.g.issues.push(BOT_PAUSE)
  const whapiCalls = h.wa.requests.length
  let { feed: q } = await h.tick(feed, QUIET)
  assert.equal(h.wa.requests.length, whapiCalls, 'no edit, and no channel check, while paused')
  const gh = h.g.calls.length
  for (let i = 0; i < 3; i++) {
    h.advance(21000)
    q = (await h.tick(q, QUIET)).feed
  }
  h.g.issues.length = 0 // the owner closes it
  h.advance(21000)
  q = (await h.tick(q, QUIET)).feed
  assert.equal(h.wa.requests.length, whapiCalls, 'off an edge it keeps waiting, and the status read is not made while paused')
  assert.equal(h.g.calls.length, gh + 1, 'and asks GitHub nothing but the status read\'s one look')
  const { next } = await h.tick(q, LIVE_B)
  assert.equal(h.wa.posts().at(-1).body.edit, undefined, 'the new window, and nothing else on its tick')
  assert.ok(next.waAt)
  await h.tick(next, QUIET)
  const edits = h.edits().map((p) => p.body.edit)
  assert.deepEqual(edits, ['PsqXn5SAD5v7HRA-wHN2ziQ0001', 'PsqXn5SAD5v7HRA-wHN2ziQ0002'], 'at its end, the end owed from before the pause too')
})

test('an edit still owed after 24 h is dropped without a call', async (t) => {
  const h = await phone(t)
  const { feed } = await h.tick(quiet(), LIVE)
  h.g.issues.push(BOT_PAUSE)
  const { feed: q } = await h.tick(feed, QUIET)
  const calls = h.calls()
  h.advance(25 * 3600 * 1000)
  await h.tick(q, QUIET)
  assert.equal(h.calls(), calls)
  assert.equal((await h.ledger(`${windowKey(feed)}.json`)).edit.state, 'dropped')
})

test('after a 429 on an owed edit, no other call leaves the phone: not the next owed edit, nor anything on later ticks', async (t) => {
  const h = await phone(t, {
    routes: { 'POST /messages/text': (req) => (req.body.edit && req.body.body.startsWith('Over') ? refuse(429) : { body: { sent: true, message: { id: req.body.edit ?? 'PsqXn5SAD5v7HRA-wHN2ziQ0009' } } }) },
  })
  const [first, second] = await seedDue(h.dir, ['BLINKDEALA', 'BLINKDEALB'])
  const { feed } = await h.tick(quiet(), LIVE)
  assert.equal(h.edits().length, 0, 'the opening makes its post and leaves owed edits to later ticks')
  h.advance(21000)
  const mid = (await h.tick(feed, LIVE)).feed ?? feed
  h.advance(21000)
  await h.tick(stale(mid), LIVE)
  await h.tick(mid, QUIET)
  const routes = h.wa.requests.map((r) => (r.body?.edit ? 'edit' : r.route))
  assert.deepEqual(routes, ['GET /health', 'POST /messages/text', 'GET /messages/:id', 'edit'], 'nothing after the 429')
  assert.equal((await h.ledger('hold.json')).why, '429')
  assert.equal((await h.ledger(`${first}.json`)).edit.state, 'failed')
  assert.deepEqual(await h.ledger('due.json'), [second, windowKey(feed)], 'the others kept, never tried')
  assert.equal((await h.ledger(`${second}.json`)).edit.tries, 0)
})

test('a post WhatsApp marks failed: read once 15 s on, then the phone holds off and the next window goes to Actions', async (t) => {
  const h = await phone(t, { routes: { 'GET /messages/:id': { body: { id: 'x', status: 'failed' } } } })
  const { feed } = await h.tick(quiet(), LIVE)
  const status = () => h.wa.requests.filter((r) => r.route === 'GET /messages/:id')
  const mid = (await h.tick(feed, LIVE)).feed ?? feed
  assert.equal(status().length, 0, 'not before 15 s')
  h.advance(VERIFY_AFTER_MS + 1000)
  const { feed: over } = await h.tick(mid, QUIET)
  assert.equal(status().length, 1, 'read once')
  assert.ok(!status()[0].url.includes('undefined'))
  assert.equal((await h.ledger('hold.json')).why, 'failed')
  assert.equal(await h.ledger('check.json'), null)
  h.advance(MIN)
  const calls = h.wa.requests.length
  const { next } = await h.tick(over, LIVE_B)
  assert.equal(h.wa.requests.length, calls, 'no call from the phone')
  assert.equal(next.waAt, undefined)
  assert.ok(edge(over, next, Date.now()).open, 'Actions posts it, and pauses on the same failure')
  assert.match(h.lines.join('\n'), /marked the last post as failed/)
  assert.deepEqual(leaks(h.lines.join('\n')), [])
  assert.ok(!h.lines.join('\n').includes('PsqXn5SAD5v7HRA'), 'no message id in the log')
  // A post that was delivered is read once and changes nothing.
  const ok = await phone(t)
  const f = (await ok.tick(quiet(), LIVE)).feed
  ok.advance(VERIFY_AFTER_MS + 1000)
  const q = (await ok.tick(f, QUIET)).feed
  await ok.tick(stale(q), QUIET)
  assert.equal(ok.wa.requests.filter((r) => r.route === 'GET /messages/:id').length, 1)
  assert.equal(await ok.ledger('hold.json'), null)
})

test('one deadline a tick: a hanging Whapi and a slow GitHub hold the end, a retry or an opening\'s owed edits to it', async (t) => {
  const T = 400
  const h = await phone(t, {
    timeoutMs: T,
    routes: { 'POST /messages/text': (req) => (req.body.edit && req.body.body.startsWith('Over') ? { hang: true } : { body: { sent: true, message: { id: req.body.edit ?? 'PsqXn5SAD5v7HRA-wHN2ziQ0001' } } }) },
  })
  const { feed } = await h.tick(quiet(), LIVE)
  h.g.delayMs = 300
  let started = Date.now()
  const { feed: q } = await h.tick(feed, QUIET)
  const closeMs = Date.now() - started
  assert.ok(closeMs < T + 250, `the end took ${closeMs} ms: one deadline, not a call's timeout each`)
  assert.equal(h.out.posts.at(-1).kind, 'close')
  assert.ok(h.out.posts.at(-1).at - started < 100, 'the Telegram close post went at once')
  h.advance(21000)
  started = Date.now()
  await h.tick(q, QUIET)
  assert.ok(Date.now() - started < T + 250, 'and so did the retry')
  // An opening with edits owed makes its post and leaves them to later ticks.
  h.g.delayMs = 0
  h.advance(21000)
  started = Date.now()
  const before = h.edits().length
  const { next } = await h.tick(q, LIVE_B)
  assert.ok(Date.now() - started < T, 'the opening waited for its post only')
  assert.equal(h.edits().length, before)
  assert.ok(next.waAt)
})

test('a post cut off before its send stops at once: nothing it started keeps the process, or the push, waiting', async () => {
  // A fresh node process, as on the phone: the cache is cold and the session is
  // settling, so the post would sleep 3 s between session checks. Whapi and
  // GitHub are answered in the process itself; nothing reaches the network.
  const url = (f) => JSON.stringify(pathToFileURL(join(HERE, f)).href)
  const code = `
    const { step } = await import(${url('blinkdeal.mjs')})
    const { phonePoster, phoneSettings } = await import(${url('wa-phone.mjs')})
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const t0 = Date.now()
    const after = []
    let returned = null
    const fetch = (u, init = {}) => new Promise((ok, no) => {
      const { hostname, pathname } = new URL(String(u))
      if (returned !== null) after.push(pathname)
      const body = hostname === 'api.github.com' ? [] : { status: { code: 1, text: 'INIT' } }
      const t = setTimeout(() => ok(new Response(JSON.stringify(body), { status: 200 })), hostname === 'api.github.com' ? 10 : 50)
      init.signal?.addEventListener('abort', () => { clearTimeout(t); no(init.signal.reason) })
    })
    const wa = phonePoster({
      settings: phoneSettings({ whapi: { token: ${JSON.stringify(TOKEN)}, dryRun: false } }),
      dir: await mkdtemp(join(tmpdir(), 'wa-cut-')), fetch, whapiBase: 'http://whapi.invalid', settleMs: 300, log: () => {},
    })
    const live = ${JSON.stringify({ ...LIVE, skus: LIVE.skus.slice(0, 3) })}
    const detect = async (prev, onLive, onFirstPage) => {
      await onLive({ code: live.code, couponId: live.couponId, source: live.source, skus: live.skus })
      await onFirstPage({ code: live.code, couponId: live.couponId, source: live.source, totalCount: live.totalCount, skus: live.skus })
      return live
    }
    const r = await step({ ok: true, live: false }, { detect, notify: async () => ({}), post: async () => ({}), wa })
    returned = Date.now() - t0
    process.on('exit', () => console.log(JSON.stringify({ returned, exited: Date.now() - t0, after, waAt: r.next.waAt ?? null })))
  `
  const out = await new Promise((ok, no) =>
    execFile(process.execPath, ['--input-type=module', '-e', code], { timeout: 20000 }, (e, stdout) => (e ? no(e) : ok(stdout))),
  )
  const r = JSON.parse(out.trim().split('\n').at(-1))
  assert.equal(r.waAt, null, 'the feed leaves the window to Actions')
  assert.ok(r.returned >= 300 && r.returned < 1500, `step() returned at ${r.returned} ms`)
  assert.ok(r.exited - r.returned < 500, `and the process exited ${r.exited - r.returned} ms later, not after the 3 s sleep`)
  assert.deepEqual(r.after, [], 'no call after the cutoff')
})

// ---- 12. The channel cache -------------------------------------------------------------------------

test('the channel: found once (session + list), then a session check and the post; nothing but the edit at the end', async (t) => {
  const h = await phone(t, { warm: false })
  const routes = () => h.wa.requests.map((r) => r.route)
  const { feed } = await h.tick(quiet(), LIVE)
  assert.deepEqual(routes(), ['GET /health', 'GET /newsletters', 'POST /messages/text'])
  assert.equal(h.wa.requests[0].url, '/health', 'a post wakes the session')
  const cache = await h.ledger('channel.json')
  assert.equal(cache.channelId, CHANNEL)
  assert.equal(cache.tag, channelTag(TOKEN, CHANNEL))
  assert.equal(cache.user, userTag(TOKEN, LINKED_NUMBER), 'kept with the number it was found with, as a keyed fingerprint')
  assert.ok(!JSON.stringify(cache).includes(LINKED_NUMBER))
  const { feed: q } = await h.tick(feed, QUIET)
  assert.deepEqual(routes().slice(3), ['POST /messages/text'], 'the end: the edit alone')
  await h.tick(q, LIVE_B)
  assert.deepEqual(routes().slice(4), ['GET /health', 'POST /messages/text'])
})

test('the session re-linked to another number (the owner\'s): the cache does not hold, the channel is found again, and nothing is posted', async (t) => {
  const OWNER_VIEW = { ...REAL, user_role: 'owner' }
  const h = await phone(t, {
    routes: {
      'GET /health': { body: { status: { code: 4, text: 'AUTH' }, user: { id: '910000000002', name: 'Owner' } } },
      ...listed(OWNER_VIEW),
    },
  })
  const { next } = await h.tick(quiet(), LIVE)
  assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters'])
  assert.equal(h.wa.posts().length, 0)
  assert.equal(next.waAt, undefined, 'Actions meets the owner too, and pauses')
  assert.equal(await h.ledger('channel.json'), null)
  assert.match(h.lines.join('\n'), /no channel to post to \(The number linked to Whapi is the channel OWNER/)
  assert.deepEqual(leaks(h.lines.join('\n')), [])
})

test('the cache is dropped when the pause issue is seen, and when Whapi answers 401, 403 or 404', async (t) => {
  const h = await phone(t, { gh: { issues: [BOT_PAUSE] } })
  await h.tick(quiet(), LIVE)
  assert.equal(h.wa.requests.length, 0)
  assert.equal(await h.ledger('channel.json'), null, 'paused: found again after')
  for (const status of [401, 403, 404]) {
    const r = await phone(t, { routes: { 'POST /messages/text': refuse(status) } })
    await r.tick(quiet(), LIVE)
    assert.equal(await r.ledger('channel.json'), null, String(status))
  }
  const ok = await phone(t, { routes: { 'POST /messages/text': refuse(503) } })
  await ok.tick(quiet(), LIVE)
  assert.ok(await ok.ledger('channel.json'), 'a 5xx says nothing about the channel')
})

test('a new token, or a cache a day old, finds the channel again', async (t) => {
  for (const warm of [{ token: 'another-token-that-is-long-enough' }, { checkedAt: new Date(Date.now() - CHANNEL_MAX_AGE_MS - MIN).toISOString() }]) {
    const h = await phone(t, { warm: false })
    await warmCache(h.dir, warm)
    const { next } = await h.tick(quiet(), LIVE)
    assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters', 'POST /messages/text'], JSON.stringify(warm))
    assert.ok(next.waAt)
    assert.equal((await h.ledger('channel.json')).tag, channelTag(TOKEN, CHANNEL))
  }
})

test('a number that owns a Channel, admins two, or admins none: no post, no cache, no waAt', async (t) => {
  for (const newsletters of [[MINE], [REAL, MINE], [REAL, SECOND], [], [{ ...REAL, user_role: 'subscriber' }]]) {
    const h = await phone(t, { warm: false, routes: listed(...newsletters) })
    const { next } = await h.tick(quiet(), LIVE)
    assert.equal(h.wa.posts().length, 0, JSON.stringify(newsletters))
    assert.equal(next.waAt, undefined)
    assert.equal(await h.ledger('channel.json'), null)
    assert.match(h.lines.join('\n'), /no channel to post to .*; the Actions poster takes this window/)
    assert.deepEqual(leaks(h.lines.join('\n')), [])
  }
  // A session that is not connected: the same.
  const h = await phone(t, { warm: false, routes: { 'GET /health': { body: { status: { code: 2, text: 'QR' } } } } })
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.wa.posts().length, 0)
  assert.equal(next.waAt, undefined)
})

test('a cache a day old is found again at the opening; one that no longer holds leaves the window to Actions', async (t) => {
  let channels = [REAL]
  const h = await phone(t, { routes: { 'GET /newsletters': () => ({ body: { newsletters: channels, count: 100, total: channels.length } }) } })
  const { feed } = await h.tick(quiet(), LIVE)
  const { feed: q } = await h.tick(feed, QUIET)
  assert.equal(h.edits().length, 1)
  channels = [REAL, SECOND]
  h.advance(CHANNEL_MAX_AGE_MS + MIN)
  const { next } = await h.tick(q, LIVE_B)
  assert.equal(h.fresh().length, 1)
  assert.equal(next.waAt, undefined)
  assert.equal(await h.ledger('channel.json'), null)
})

test('a pinned whapi.channelId is checked with its own role call, and an owner there never posts', async (t) => {
  const cfg = { whapi: { token: TOKEN, dryRun: false, channelId: CHANNEL } }
  const h = await phone(t, { warm: false, cfg })
  const { next } = await h.tick(quiet(), LIVE)
  assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters/:id', 'POST /messages/text'])
  assert.ok(next.waAt)
  const own = await phone(t, { warm: false, cfg, routes: { 'GET /newsletters/:id': { body: { id: CHANNEL, user_role: 'owner' } } } })
  assert.equal((await own.tick(quiet(), LIVE)).next.waAt, undefined)
  assert.equal(own.wa.posts().length, 0)
})

// ---- D1: the full crawl's rows ------------------------------------------------------------------------

test('the post from the first page is edited once, silently, with the full crawl, only when its rows differ', async (t) => {
  const h = await phone(t)
  const { next } = await h.tick(quiet(), LIVE, { first: 3 })
  const posts = h.wa.posts()
  assert.equal(posts.length, 2)
  assert.equal(posts[0].body.body, firstPageBody(LIVE, next.lastLive.from, 3))
  assert.deepEqual(posts[1].body, { to: CHANNEL, edit: 'PsqXn5SAD5v7HRA-wHN2ziQ0001', body: renderOpen(postData(next)), no_link_preview: true })
  assert.notEqual(posts[0].body.body, posts[1].body.body)
  assert.deepEqual((await h.ledger('open.json')).data, postData(next), 'its end shows the same rows')
  await h.tick(next, QUIET)
  assert.equal(h.edits().at(-1).body.body, renderOver(postData(next), (await h.ledger(`${windowKey(next)}.json`)).edit.to))
  // The same rows: no edit.
  const same = await phone(t)
  await same.tick(quiet(), LIVE)
  assert.equal(same.wa.posts().length, 1)
})

// ---- First sight, then the edit ---------------------------------------------------------------------------
//
// The post starts at onLive with what the plain listing knows, and is edited
// to the full opening at the coupon's first page. The fake detect's first page
// comes at once unless firstPageMs says otherwise, which is the case where the
// checks are slower than the first page: one post, whole.

const OK_POST = { body: { sent: true, message: { id: 'PsqXn5SAD5v7HRA-wHN2ziQ0001' } } }
/** The post goes through, "Over" edits go through, and edits that fill it in get these answers in turn, the last repeating. */
const fillAnswers = (...answers) => ({
  'POST /messages/text': (req) => {
    if (!req.body.edit) return OK_POST
    if (req.body.body.startsWith('Over')) return { body: { sent: true, message: { id: req.body.edit } } }
    return answers.length > 1 ? answers.shift() : answers[0]
  },
})

test('at first sight: the post says what the plain listing knows, before the first page comes; one edit then fills it in', async (t) => {
  const h = await phone(t)
  const events = []
  const { next } = await h.tick(quiet(), LIVE, { firstPageMs: 150, events })
  const at = Object.fromEntries(events)
  const from = next.lastLive.from
  assert.equal(h.fresh().length, 1)
  const [post] = h.fresh()
  assert.deepEqual(post.body, { to: CHANNEL, body: sightBody(LIVE, from), no_link_preview: true })
  assert.ok(post.at < at['first page'], 'it reached Whapi before the first page came')
  assert.doesNotMatch(post.body.body, /Cheapest|\d coins/, 'no rows and no count yet')
  assert.match(post.body.body, /\nThe coins: https:\/\/www\.myntra\.com\/gold-coins\?f=Coupons:BLINKDEAL6_135733\n/)
  assert.deepEqual(h.edits().map((e) => e.body), [{ to: CHANNEL, edit: 'PsqXn5SAD5v7HRA-wHN2ziQ0001', body: firstPageBody(LIVE, from), no_link_preview: true }])
  assert.ok(h.edits()[0].at >= at['first page'])
  const open = await h.ledger('open.json')
  assert.equal(open.stage, 'full')
  assert.equal(open.body, firstPageBody(LIVE, from))
  assert.ok(next.waAt)
  assert.equal(edge(quiet(), next, Date.now()).open, null, 'Actions stands down')
  assert.match(h.lines.join('\n'), /^WA open filled in from the first page at /m)
  // Telegram beside it: its opening at sight, filled in at the first page.
  assert.deepEqual(h.tgKinds(), ['open/sight', 'open/full'])
  assert.ok(h.out.posts[0].at < at['first page'])
  // The end: "Over", with the coins the post came to carry.
  await h.tick(next, QUIET)
  assert.equal(h.overEdits().length, 1)
  assert.match(h.overEdits()[0].body.body, /^Over at .*\n\nBLINKDEAL6 was live on Myntra — 6% off gold coins\nLive from .*\n\nCheapest 24K per gram it gave:\n/)
})

test('checks slower than the first page: one post, sent whole, and no edit; slower than the crawl: none at all', async (t) => {
  const h = await phone(t, { gh: { delayMs: 300 } })
  const events = []
  const { next } = await h.tick(quiet(), LIVE, { firstPageMs: 100, events })
  assert.ok(h.g.calls[0].at < Object.fromEntries(events)['first page'], 'the checks started at sight')
  assert.equal(h.wa.posts().length, 1)
  assert.equal(h.fresh()[0].body.body, firstPageBody(LIVE, next.lastLive.from))
  assert.equal((await h.ledger('open.json')).stage, 'full')
  assert.equal(h.edits().length, 0)
  assert.ok(next.waAt)
  // Past the crawl and SETTLE_MS: cut off, never sent, and the feed leaves the window to Actions.
  const slow = await phone(t, { gh: { delayMs: 600 }, settleMs: 100 })
  const { next: left } = await slow.tick(quiet(), LIVE, { firstPageMs: 50 })
  assert.equal(left.waAt, undefined)
  assert.ok(edge(quiet(), left, Date.now()).open, 'Actions posts it')
  await pause(800)
  assert.equal(slow.wa.posts().length, 0)
})

test('the first page fails, then the window is read live: not posted again; the next tick fills it in, keeping its first "Live since"', async (t) => {
  const h = await phone(t)
  const { feed: failed } = await h.tick(quiet(), LIVE, { failFirstPage: true })
  assert.equal(failed.ok, false)
  assert.equal(failed.live, false, 'the feed never said live')
  assert.equal(failed.waAt, undefined, 'and carries no waAt')
  const first = await h.ledger('open.json')
  assert.equal(first.stage, 'first')
  assert.deepEqual(h.fresh().map((p) => p.body.body), [sightBody(LIVE, first.from)])
  assert.equal(h.edits().length, 0)
  const e1 = edge(quiet(), failed, Date.now())
  assert.deepEqual([e1.open, e1.close], [null, null], 'Actions: a failed read opens nothing')
  await pause(5)
  const { next } = await h.tick(failed, LIVE)
  assert.notEqual(next.lastLive.from, first.from)
  assert.equal(h.fresh().length, 1, 'not posted again')
  assert.deepEqual(h.edits().map((e) => e.body), [{ to: CHANNEL, edit: first.messageId, body: firstPageBody(LIVE, first.from), no_link_preview: true }])
  assert.equal((await h.ledger('open.json')).stage, 'full')
  assert.ok(next.waAt)
  assert.equal(edge(failed, next, Date.now()).open, null, 'Actions stands down')
  // The end: "Over", with the coins.
  await h.tick(next, QUIET)
  assert.equal(h.overEdits().length, 1)
  assert.match(h.overEdits()[0].body.body, /Cheapest 24K per gram it gave:/)
  assert.equal(h.fresh().length, 1)
})

test('the first page fails, then quiet reads: "Over." with no time, from what was known at sight; Actions does nothing', async (t) => {
  for (const fails of [1, 3]) {
    const h = await phone(t)
    let f = quiet()
    for (let i = 0; i < fails; i++) f = (await h.tick(f, LIVE, { failFirstPage: true })).feed
    const first = await h.ledger('open.json')
    const { next, closedWindow } = await h.tick(f, QUIET)
    assert.equal(closedWindow, null)
    assert.equal(h.fresh().length, 1, `${fails} failed first pages: one post`)
    assert.deepEqual(h.edits().map((e) => e.body), [{ to: CHANNEL, edit: first.messageId, body: renderOver(first.data, null), no_link_preview: true }])
    assert.match(h.edits()[0].body.body, /^Over\. These prices no longer apply\.\n\nBLINKDEAL6 was live on Myntra — 6% off gold coins\nLive from .*\.\n\nGold coin prices on CCBuddy: /)
    assert.equal(await h.ledger('open.json'), null)
    const e = edge(f, next, Date.now())
    assert.deepEqual([e.open, e.close], [null, null])
    await h.tick(next, QUIET)
    assert.equal(h.edits().length, 1, 'once')
  }
})

test('a restart between the sight and the first page: the post is out, and the next tick fills it in, never posts it again', async (t) => {
  const h = await phone(t)
  const url = (f) => JSON.stringify(pathToFileURL(join(HERE, f)).href)
  // The phone dies after its post went out, before the coupon's first page: a fresh node process, killed there.
  const code = `
    const { step } = await import(${url('blinkdeal.mjs')})
    const { phonePoster, phoneSettings } = await import(${url('wa-phone.mjs')})
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const dir = ${JSON.stringify(h.dir)}
    const fetch = async (u, init) => (new URL(String(u)).hostname === 'api.github.com' ? new Response('[]', { status: 200 }) : globalThis.fetch(u, init))
    const wa = phonePoster({ settings: phoneSettings({ whapi: { token: ${JSON.stringify(TOKEN)}, dryRun: false } }), dir, fetch, whapiBase: ${JSON.stringify(h.wa.base)}, log: () => {} })
    const live = ${JSON.stringify({ ...LIVE, skus: LIVE.skus.slice(0, 3) })}
    const detect = async (prev, onLive) => {
      await onLive({ code: live.code, couponId: live.couponId, source: live.source, skus: live.skus })
      for (let i = 0; i < 500; i++) {
        const o = await readFile(join(dir, 'open.json'), 'utf8').then(JSON.parse, () => null)
        if (o?.state === 'sent') process.exit(0)
        await new Promise((r) => setTimeout(r, 10))
      }
      process.exit(3)
    }
    await step({ ok: true, live: false }, { detect, notify: async () => ({}), post: async () => ({}), wa })
    process.exit(4)
  `
  // How it dies does not matter (on Windows an exit with a socket closing can abort): only that it is gone.
  await new Promise((ok) => execFile(process.execPath, ['--input-type=module', '-e', code], { timeout: 20000 }, () => ok()))
  assert.equal(h.fresh().length, 1, 'the dead tick posted at sight')
  const left = await h.ledger('open.json')
  assert.deepEqual([left.state, left.stage], ['sent', 'first'])
  // The next tick: a fresh process again, and the feed on file still the quiet one.
  const { next } = await h.tick(quiet(), LIVE)
  assert.equal(h.fresh().length, 1, 'not posted again')
  assert.deepEqual(h.edits().map((e) => e.body.body), [firstPageBody(LIVE, left.from)])
  assert.ok(next.waAt)
  assert.equal(edge(quiet(), next, Date.now()).open, null, 'Actions stands down')
})

test('a post adopted at its first stage is not filled in while the poster is paused; the first live tick after the issue closes fills it in', async (t) => {
  const h = await phone(t)
  const { feed: failed } = await h.tick(quiet(), LIVE, { failFirstPage: true })
  const first = await h.ledger('open.json')
  h.g.issues.push(BOT_PAUSE)
  const calls = h.wa.requests.length
  const { next } = await h.tick(failed, LIVE)
  assert.equal(h.wa.requests.length, calls, 'no Whapi call while paused: no edit, no session check')
  assert.ok(next.waAt, "the post is the phone's: Actions still stands down")
  assert.equal((await h.ledger('open.json')).stage, 'first')
  h.g.issues.length = 0 // the owner closes it
  h.advance(21000)
  await h.tick(stale(next), LIVE)
  assert.deepEqual(h.fillEdits().map((e) => e.body.body), [firstPageBody(LIVE, first.from)])
  assert.equal((await h.ledger('open.json')).stage, 'full')
})

test("a fill that fails: the crawl's edit puts the coins in; failing too, later live ticks try 3 more times, 20 s apart, a pause check each; a 4xx or a 429 ends it", async (t) => {
  // The fill fails once; the crawl's edit after it goes through.
  const once = await phone(t, { routes: fillAnswers({ status: 502, body: {} }, OK_POST) })
  const { next } = await once.tick(quiet(), LIVE, { firstPageMs: 150 })
  assert.equal(once.fillEdits().length, 2)
  assert.equal((await once.ledger('open.json')).stage, 'full')
  assert.equal((await once.ledger('open.json')).body, renderOpen(postData(next)))
  assert.match(once.lines.join('\n'), /WA open not filled in \(Whapi edit: HTTP 502\); the crawl's edit tries again/)
  assert.match(once.lines.join('\n'), /WA open refreshed with the full crawl/)
  // Both fail: the later live ticks.
  const h = await phone(t, { routes: fillAnswers({ status: 502, body: {} }) })
  let { feed } = await h.tick(quiet(), LIVE, { firstPageMs: 150 })
  assert.equal(h.fillEdits().length, 2)
  assert.equal((await h.ledger('open.json')).stage, 'first')
  const gh = h.g.calls.length
  h.advance(5000)
  feed = (await h.tick(feed, LIVE)).feed
  assert.equal(h.fillEdits().length, 2, 'not before 20 s')
  assert.equal(h.g.calls.length, gh, 'and no pause check either')
  for (let i = 1; i <= EDIT_RETRIES; i++) {
    h.advance(21000)
    feed = (await h.tick(stale(feed), LIVE)).feed
    assert.equal(h.fillEdits().length, 2 + i)
    assert.equal(h.g.calls.length, gh + i, 'one pause check before each')
  }
  h.advance(21000)
  await h.tick(stale(feed), LIVE)
  assert.equal(h.fillEdits().length, 2 + EDIT_RETRIES, 'then it stops')
  assert.equal((await h.ledger('open.json')).fill.tries, EDIT_RETRIES)
  // A 4xx: not tried again, by the crawl's edit or any later tick.
  const no = await phone(t, { routes: fillAnswers(refuse(403)) })
  let f = (await no.tick(quiet(), LIVE, { firstPageMs: 150 })).feed
  no.advance(21000)
  f = (await no.tick(stale(f), LIVE)).feed
  assert.equal(no.fillEdits().length, 1)
  assert.equal((await no.ledger('open.json')).fill.state, 'refused')
  assert.deepEqual(leaks(no.lines.join('\n')), [])
  // A 429: the number rests, and nothing else leaves the phone, the end included.
  const rest = await phone(t, { routes: fillAnswers(refuse(429)) })
  const r1 = (await rest.tick(quiet(), LIVE, { firstPageMs: 150 })).feed
  const calls = rest.calls()
  assert.equal((await rest.ledger('hold.json')).why, '429')
  rest.advance(21000)
  await rest.tick(stale(r1), LIVE)
  await rest.tick(r1, QUIET)
  assert.equal(rest.calls(), calls)
  assert.equal(rest.fillEdits().length, 1)
})

test('a fill owed while the poster is paused spends its tries, one pause check each, and makes no Whapi call', async (t) => {
  const h = await phone(t, { routes: fillAnswers({ status: 502, body: {} }) })
  let { feed } = await h.tick(quiet(), LIVE, { firstPageMs: 150 })
  assert.equal((await h.ledger('open.json')).stage, 'first')
  h.g.issues.push(BOT_PAUSE)
  const gh = h.g.calls.length
  const calls = h.wa.requests.length
  for (let i = 1; i <= EDIT_RETRIES + 2; i++) {
    h.advance(21000)
    feed = (await h.tick(stale(feed), LIVE)).feed
    assert.equal(h.g.calls.length, gh + Math.min(i, EDIT_RETRIES), 'a pause check per try, none after the last')
  }
  assert.equal(h.wa.requests.length, calls, 'no edit, no session check')
  assert.equal((await h.ledger('open.json')).fill.tries, EDIT_RETRIES)
  assert.equal((await h.ledger('open.json')).stage, 'first', 'left as first sent')
})

test("the crawl's edit waits for the first page's: a slow fill never lands over the crawl's rows", async (t) => {
  const h = await phone(t, {
    routes: { 'POST /messages/text': (req) => (req.body.edit ? { delay: 250, body: { sent: true, message: { id: req.body.edit } } } : OK_POST) },
  })
  const { next } = await h.tick(quiet(), LIVE, { firstPageMs: 50, first: 3 })
  const from = next.lastLive.from
  const edits = h.fillEdits()
  assert.deepEqual(edits.map((e) => e.body.body), [firstPageBody(LIVE, from, 3), renderOpen(postData(next))])
  assert.notEqual(edits[0].body.body, edits[1].body.body)
  assert.ok(edits[1].at - edits[0].at >= 240, 'the second was sent after the first was answered')
  assert.equal((await h.ledger('open.json')).body, renderOpen(postData(next)))
})

test('dry, with the first page after the sight: prints the post at sight and the edit it would make, and calls nothing', async (t) => {
  const h = await phone(t, { cfg: { whapi: { token: TOKEN } } })
  const { next } = await h.tick(quiet(), LIVE, { firstPageMs: 150 })
  const said = h.lines.join('\n')
  assert.ok(said.includes(`would post:\n${sightBody(LIVE, next.lastLive.from)}`), said)
  assert.ok(said.includes(`would edit it to:\n${firstPageBody(LIVE, next.lastLive.from)}`), said)
  assert.equal(h.calls(), 0)
  assert.equal(next.waAt, undefined)
  assert.deepEqual(await readdir(h.dir), ['channel.json'])
})

// ---- 13. Never in the output -----------------------------------------------------------------------------

test('the token, the channel id, the linked number and the message id never reach the log, the console or the feed', async (t) => {
  const printed = []
  const [log, error] = [console.log, console.error]
  console.log = (...a) => printed.push(a.join(' '))
  console.error = (...a) => printed.push(a.join(' '))
  const feeds = []
  try {
    const echo = { status: 403, body: { error: { code: 403, message: `token ${TOKEN} from ${LINKED_NUMBER} to ${CHANNEL}` } } }
    const h = await phone(t, { warm: false, routes: editFails(echo) })
    let { feed } = await h.tick(quiet(), LIVE, { first: 3 })
    feeds.push(feed)
    const r = await h.tick(feed, QUIET)
    feeds.push(r.feed, r.closedWindow)
    const bad = await phone(t, { warm: false, routes: { 'POST /messages/text': echo } })
    feeds.push((await bad.tick(quiet(), LIVE)).feed)
    const dry = await phone(t, { cfg: { whapi: { token: TOKEN } } })
    feeds.push((await dry.tick(quiet(), LIVE)).feed)
    printed.push(...h.lines, ...bad.lines, ...dry.lines)
  } finally {
    console.log = log
    console.error = error
  }
  const all = [...printed, ...feeds.map((f) => JSON.stringify(f))].join('\n')
  assert.ok(all.includes('WA open sent'), 'the log was captured')
  assert.deepEqual(leaks(all), [])
  assert.ok(!all.includes('PsqXn5SAD5v7HRA'), 'no message id')
})

// ---- Setup and check on the phone ---------------------------------------------------------------------------

async function setupHarness(t, { routes = {}, file } = {}) {
  const wa = await fakeWhapi({ ...listed(REAL), ...routes })
  t.after(() => wa.close())
  const dir = await mkdtemp(join(tmpdir(), 'wa-setup-'))
  const configPath = join(dir, '.notify.env')
  if (file !== undefined) await writeFile(configPath, typeof file === 'string' ? file : JSON.stringify(file))
  const lines = []
  const opts = (clip = `${TOKEN}\n`) => ({ readClipboard: async () => clip, configPath, dir: join(dir, '.wa-ledger'), base: wa.base, sleep: async () => {}, log: (s) => lines.push(String(s)) })
  return { wa, dir, configPath, lines, opts, config: () => readJson(configPath), ledger: (n) => readJson(join(dir, '.wa-ledger', n)) }
}

test('--setup: the token from the clipboard, checked, saved with posting on only when Ready; every other key kept', async (t) => {
  const telegram = { token: '123456:ABC', chatId: '987654321' }
  const h = await setupHarness(t, { file: { telegram } })
  assert.equal(await runSetup(h.opts()), true)
  assert.deepEqual(await h.config(), { telegram, whapi: { token: TOKEN, dryRun: false } })
  assert.equal((await h.ledger('channel.json')).channelId, CHANNEL)
  const said = h.lines.join('\n')
  assert.match(said, /^Token read from the clipboard\.$/m)
  assert.match(said, /^session: AUTH$/m)
  assert.match(said, /^channel: "CCBuddy Deals" \(found by itself\), this number's role: admin$/m)
  assert.match(said, /^Ready: connected, and an admin of the channel\.$/m)
  assert.match(said, /posting on: this phone posts the next window/)
  assert.ok(h.wa.requests.every((r) => r.route.startsWith('GET ')), 'read-only')
  assert.deepEqual(leaks(said), [])
  // What the watcher then reads.
  assert.equal(phoneSettings(await h.config()).mode, 'live')
  // Swapped in whole: no temporary copy of the token is left beside it.
  assert.deepEqual((await readdir(h.dir)).sort(), ['.notify.env', '.wa-ledger'])
})

test('--setup when not ready: saved dry, says why and how to pin the channel on the phone', async (t) => {
  const h = await setupHarness(t, { routes: listed(REAL, SECOND), file: {} })
  assert.equal(await runSetup(h.opts()), false)
  assert.deepEqual(await h.config(), { whapi: { token: TOKEN, dryRun: true } })
  const said = h.lines.join('\n')
  assert.match(said, /admin of 2 WhatsApp Channels/)
  assert.match(said, /whapi\.channelId/)
  assert.match(said, /posting off/)
  assert.equal(await h.ledger('channel.json'), null)
  assert.deepEqual(leaks(said), [])
  assert.equal(phoneSettings(await h.config()).mode, 'dry')
})

test('--setup with whapi.channelId already pinned checks that channel', async (t) => {
  const h = await setupHarness(t, { file: { whapi: { channelId: CHANNEL, dryRun: true } } })
  assert.equal(await runSetup(h.opts()), true)
  assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters/:id'])
  assert.deepEqual(await h.config(), { whapi: { channelId: CHANNEL, dryRun: false, token: TOKEN } })
})

test('--setup refuses an empty clipboard or a broken .notify.env, and writes nothing', async (t) => {
  const h = await setupHarness(t, { file: { telegram: { chatId: '1' } } })
  for (const clip of ['', '  \n', 'hello', 'x'.repeat(10)]) assert.equal(await runSetup(h.opts(clip)), false)
  assert.deepEqual(await h.config(), { telegram: { chatId: '1' } })
  assert.match(h.lines.join('\n'), /The clipboard holds no Whapi token/)
  const broken = await setupHarness(t, { file: '{ "telegram": ' })
  assert.equal(await runSetup(broken.opts()), false)
  assert.equal(await readFile(broken.configPath, 'utf8'), '{ "telegram": ')
  assert.equal(broken.wa.requests.length, 0)
})

test('--check: the saved token, the same read-only check, and whether the pause issue is open', async (t) => {
  const h = await setupHarness(t)
  const gh = github({ issues: [BOT_PAUSE] })
  const ready = await runPhoneCheck({ cfg: LIVE_CFG, ...h.opts(), fetch: gh.fetch })
  assert.equal(ready, true)
  const said = h.lines.join('\n')
  assert.match(said, /^Posting: on\.$/m)
  assert.match(said, /The pause issue is open/)
  assert.deepEqual(leaks(said), [])
  const none = await setupHarness(t)
  assert.equal(await runPhoneCheck({ cfg: {}, ...none.opts() }), false)
  assert.match(none.lines.join('\n'), /run node scraper\/wa-phone\.mjs --setup/)
  assert.equal(none.wa.requests.length, 0)
})

// ---- Config ---------------------------------------------------------------------------------------------

test('the whapi block from the environment: only 0 posts', () => {
  assert.deepEqual(applyEnv({}, { BLINKDEAL_WHAPI_TOKEN: TOKEN, BLINKDEAL_WA_DRY_RUN: '0' }).whapi, { token: TOKEN, dryRun: false })
  assert.equal(applyEnv({ whapi: { token: TOKEN, dryRun: false } }, { BLINKDEAL_WA_DRY_RUN: '1' }).whapi.dryRun, true)
  assert.equal(applyEnv({ whapi: { token: TOKEN, dryRun: false } }, { BLINKDEAL_WA_DRY_RUN: '' }).whapi.dryRun, true)
  assert.equal(applyEnv({}, { BLINKDEAL_WHAPI_CHANNEL_ID: CHANNEL }).whapi.channelId, CHANNEL)
  assert.equal(applyEnv({ telegram: { token: 't' } }, {}).whapi, undefined)
  assert.equal(phoneSettings(applyEnv({ whapi: { token: TOKEN, dryRun: false } }, {})).mode, 'live')
  assert.equal(phoneSettings({ whapi: { token: TOKEN, dryRun: false } }, { forceDry: true }).mode, 'dry')
  assert.ok(PHONE_TIMEOUT_MS <= 8000 && SETTLE_MS <= 8000, 'the stated bounds')
})
