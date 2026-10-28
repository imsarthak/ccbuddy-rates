// The WhatsApp Channel poster: which pushes post, which edit, which do
// nothing, and what it does when Whapi says no.
//
//   node --test scraper/wa-post.test.mjs
//
// Nothing here reaches the internet. Whapi is a local fake (node:http on
// 127.0.0.1, scripted answers, every request recorded) and GitHub is a stub.
// fetch itself refuses every other host, so a test that forgot its fake
// fails instead of calling the real API.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  edge, windowKey, postData, renderOpen, renderOver, runEdge, runHealth, runCheck, runTestPost,
  settings, redact, readLedger, whapi, OPEN_MAX_AGE_MS, PAUSE_TITLE, WHAPI,
} from './wa-post.mjs'
import { bestByWeight, brandName, istClock, TEMPLATES, WA_LINK } from './notify.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'live-window-2026-09-15.json'), 'utf8'))
const run = promisify(execFile)

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const host = new URL(String(url)).hostname
  if (host !== '127.0.0.1') throw new Error(`a test tried to reach ${host}`)
  return realFetch(url, init)
}

const TOKEN = 'test-token-not-a-real-one'
const CHANNEL = '120363000000000001@newsletter'
const TEST_CHANNEL = '120363000000000002@newsletter'
// The fake session's own number, as /health reports it. It must never be printed.
const LINKED_NUMBER = '919800000000'

// ---- Fakes --------------------------------------------------------------------

/**
 * A local Whapi. `routes` maps 'METHOD /path' (ids collapsed to :id) to one
 * answer or a list served in order, the last repeating. An answer is
 * { status, body }, a function of the request, or { hang: true }.
 */
async function fakeWhapi(routes = {}) {
  const requests = []
  let sent = 0
  const defaults = {
    'GET /health': { body: { status: { code: 4, text: 'AUTH' }, user: { id: LINKED_NUMBER, name: 'Spare' }, uptime: 9, start_at: 1 } },
    'GET /newsletters/:id': (req) => ({ body: { id: req.url.split('/')[2], name: 'CCBuddy Deals', user_role: 'admin' } }),
    'GET /newsletters': { body: { newsletters: [], count: 0, total: 0 } },
    'POST /messages/text': (req) => ({
      body: { sent: true, message: { id: req.body.edit ?? `PsqXn5SAD5v7HRA-wHN2ziQ${String(++sent).padStart(4, '0')}`, chat_id: req.body.to, from_me: true } },
    }),
    'GET /messages/:id': { body: { id: 'x', status: 'sent' } },
  }
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const path = req.url.split('?')[0].replace(/^\/newsletters\/[^/]+$/, '/newsletters/:id').replace(/^\/messages\/(?!text$)[^/]+$/, '/messages/:id')
    const rec = { route: `${req.method} ${path}`, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null }
    requests.push(rec)
    let r = routes[rec.route] ?? defaults[rec.route]
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0]
    if (typeof r === 'function') r = r(rec)
    if (r?.hang) return
    res.writeHead(r ? r.status ?? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r ? r.body ?? {} : { error: { code: 404, message: 'no such route' } }))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    posts: () => requests.filter((r) => r.route === 'POST /messages/text'),
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(ok))),
  }
}

/** The repo's issues: what wa-post.mjs asks of GitHub, and nothing more. */
function fakeGitHub(open = []) {
  const issues = open.map((i) => ({ ...i }))
  const calls = []
  let next = 40
  const gh = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method: init.method ?? 'GET', body })
    if (path.startsWith('/issues?')) return issues
    if (path === '/issues' && init.method === 'POST') {
      const i = { number: ++next, title: body.title, body: body.body }
      issues.push(i)
      return i
    }
    if (/^\/issues\/\d+\/comments$/.test(path) && init.method === 'POST') return { id: 1 }
    throw new Error(`unexpected GitHub call ${init.method ?? 'GET'} ${path}`)
  }
  return {
    gh,
    calls,
    issues,
    opened: () => calls.filter((c) => c.path === '/issues' && c.method === 'POST').map((c) => c.body),
    comments: () => calls.filter((c) => c.path.endsWith('/comments')).map((c) => c.body.body),
  }
}

const NOW = Date.parse('2026-10-29T11:30:30.000Z') // 5:00:30 pm IST
const LIVE_ENV = { WA_DRY_RUN: '0', WHAPI_TOKEN: TOKEN, WHAPI_CHANNEL_ID: CHANNEL, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1' }

/** One fake Whapi, one fake GitHub, one ledger directory, shared by every run in a test. */
async function harness(t, { routes, issues, env } = {}) {
  const wa = await fakeWhapi(routes)
  t.after(() => wa.close())
  const github = fakeGitHub(issues)
  const lines = []
  const slept = []
  const outputs = {}
  const dir = await mkdtemp(join(tmpdir(), 'wa-ledger-'))
  const deps = {
    gh: github.gh,
    sleep: async (ms) => void slept.push(ms),
    log: (s) => lines.push(String(s)),
    now: () => NOW,
    output: async (k, v) => void (outputs[k] = v),
    timeoutMs: 300,
  }
  const fullEnv = (extra) => ({ ...LIVE_ENV, WHAPI_BASE: wa.base, ...env, ...extra })
  return {
    wa, github, lines, slept, outputs, dir, deps,
    run: (e, extra = {}) => runEdge(e, { env: fullEnv(extra), ledgerDir: dir, deps }),
    env: fullEnv,
    // Everything this run made public: the log, and every issue and comment.
    published: () => [...lines, ...github.calls.map((c) => JSON.stringify(c.body ?? ''))].join('\n'),
  }
}

// ---- Feeds --------------------------------------------------------------------

const W1 = '2026-10-29T11:30:00.000Z' // 5:00 pm IST
const W1_END = '2026-10-29T12:05:30.000Z' // 5:35 pm
const W2 = '2026-10-29T14:00:00.000Z' // 7:30 pm, the same day, same code, same coupon id
const W2_END = '2026-10-29T14:36:00.000Z'

function liveFeed(from, over = {}) {
  return {
    generated: from, checkedAt: from, ok: true, heartbeatMs: 120000, live: true,
    code: 'BLINKDEAL6', couponId: '135733', discountPct: 6, source: fixture.source, totalCount: 207,
    skus: fixture.skus, knownIds: ['135733'],
    lastLive: { code: 'BLINKDEAL6', couponId: '135733', from, skuCount: 12 },
    ...over,
  }
}
const quietFeed = (lastLive) => ({ generated: 'x', checkedAt: 'x', ok: true, heartbeatMs: 1200000, live: false, knownIds: ['135733'], ...(lastLive ? { lastLive } : {}) })
const ended = (live, to) => quietFeed({ ...live.lastLive, to })
const after = (iso, s) => Date.parse(iso) + s * 1000

const OPEN_TEXT = [
  'BLINKDEAL6 live on Myntra — 6% off gold coins',
  'Live since 5:00 pm. Windows have lasted about 35 min.',
  '',
  'Cheapest 24K per gram after the coupon:',
  '0.5 g · ₹15,620/g · Mia by Tanishq coin',
  '1 g · ₹15,409/g · P N Gadgil Jewellers coin',
  '20 g · ₹15,143/g · Kalyan Jewellers bar',
  '',
  `207 coins: ${fixture.source}`,
  `Compare them all on CCBuddy: ${WA_LINK}`,
].join('\n')

// ---- The edge -------------------------------------------------------------------

test('quiet → live opens the window, keyed on code and start, not the coupon id', () => {
  const e = edge(quietFeed(), liveFeed(W1), NOW)
  assert.equal(e.open.key, `BLINKDEAL6-${Date.parse(W1)}`)
  assert.equal(e.close, null)
})

test('the same window before and after (a heartbeat) is no edge', () => {
  const e = edge(liveFeed(W1), liveFeed(W1, { checkedAt: 'later' }), NOW)
  assert.equal(e.open, null)
  assert.equal(e.close, null)
})

test('live → quiet on a good read closes it, with the end time the feed recorded', () => {
  const e = edge(liveFeed(W1), ended(liveFeed(W1), W1_END), after(W1_END, 20))
  assert.equal(e.close.key, `BLINKDEAL6-${Date.parse(W1)}`)
  assert.equal(e.close.to, W1_END)
  assert.equal(e.open, null)
})

test('a failed read never opens or closes; the window closes on the next good one', () => {
  const failed = { ...liveFeed(W1), ok: false, stale: true, error: 'HTTP 500' }
  const e1 = edge(liveFeed(W1), failed, NOW)
  assert.equal(e1.open, null)
  assert.equal(e1.close, null)
  assert.match(e1.notes[0], /not a good read/)
  const e2 = edge(failed, ended(liveFeed(W1), W1_END), NOW)
  assert.equal(e2.close.key, `BLINKDEAL6-${Date.parse(W1)}`)
})

test('an opening seen too late (phone offline) is not posted', () => {
  const e = edge(quietFeed(), liveFeed(W1), Date.parse(W1) + OPEN_MAX_AGE_MS + 60000)
  assert.equal(e.open, null)
  assert.match(e.notes.join(' '), /too late to post/)
  assert.ok(edge(quietFeed(), liveFeed(W1), Date.parse(W1) + OPEN_MAX_AGE_MS - 1000).open, 'just inside the limit still posts')
})

test('a window that opened and closed between two pushes gets nothing', () => {
  // The phone was offline for the whole window; the history file grew by one
  // window inside a single push, and the feed went quiet → quiet.
  const before = quietFeed({ code: 'BLINKDEAL6', from: '2026-10-28T11:00:00.000Z', to: '2026-10-28T11:35:00.000Z' })
  const afterFeed = ended(liveFeed(W1), W1_END)
  const e = edge(before, afterFeed, after(W1_END, 30), { windows: [{ code: 'BLINKDEAL6', from: W1, to: W1_END }] })
  assert.deepEqual([e.open, e.close], [null, null])
})

test('a first-ever push (no feed before) opens a fresh window', () => {
  assert.ok(edge({}, liveFeed(W1), NOW).open)
  assert.ok(edge(null, liveFeed(W1), NOW).open)
})

test('one push jumping from one window straight to the next closes the first and opens the second', () => {
  // Same code and same coupon id both times: only the start tells them apart.
  const history = { windows: [{ code: 'BLINKDEAL6', couponId: '135733', from: W1, to: W1_END }] }
  const e = edge(liveFeed(W1), liveFeed(W2), after(W2, 40), history)
  assert.equal(e.close.key, `BLINKDEAL6-${Date.parse(W1)}`)
  assert.equal(e.close.to, W1_END, 'the end comes from the history file')
  assert.equal(e.open.key, `BLINKDEAL6-${Date.parse(W2)}`)
})

test('a reused coupon id is two windows, a day apart or the same day', () => {
  const keys = [W1, W2, '2026-10-30T11:30:00.000Z'].map((f) => windowKey(liveFeed(f)))
  assert.equal(new Set(keys).size, 3)
  assert.equal(windowKey(quietFeed()), null)
})

test('a malformed feed is no edge, never a crash', () => {
  for (const bad of [null, 'garbage', 42, [], {}, { ok: true, live: true }, liveFeed(W1, { lastLive: { code: 'BLINKDEAL6', from: 'soon' } })]) {
    const e = edge(quietFeed(), bad, NOW)
    assert.equal(e.open, null, JSON.stringify(bad))
    assert.equal(e.close, null)
  }
  assert.equal(edge(quietFeed(), liveFeed(W1, { code: '<b>', lastLive: { code: 'BLINK DEAL', from: W1 } }), NOW).open, null, 'a code that is not a code')
  const brokenBefore = edge({ ok: true, live: true, lastLive: { from: 'x' } }, quietFeed(), NOW)
  assert.equal(brokenBefore.close, null)
  assert.match(brokenBefore.notes.join(' '), /unreadable/)
  assert.equal(edge(quietFeed(), liveFeed('2026-10-29T12:30:00.000Z'), NOW).open, null, 'a start in the future')
})

// ---- The words ------------------------------------------------------------------

test('the open post, rendered from the captured window', () => {
  assert.equal(renderOpen(postData(liveFeed(W1))), OPEN_TEXT)
})

test('the edit when it ends: when, how long, past tense, no Myntra link', () => {
  const text = renderOver(postData(liveFeed(W1)), W1_END)
  const lines = text.split('\n')
  assert.equal(lines[0], 'Over at 5:35 pm, after 36 min. These prices no longer apply.')
  assert.equal(lines[2], 'BLINKDEAL6 was live on Myntra — 6% off gold coins')
  assert.equal(lines[3], 'Live from 5:00 pm to 5:35 pm.')
  assert.ok(!text.includes('myntra.com'), 'a dead coupon link is not left in the post')
  assert.equal(lines.at(-1), `Gold coin prices on CCBuddy: ${WA_LINK}`)
  assert.equal(renderOver(postData(liveFeed(W1)), null).split('\n')[0], 'Over. These prices no longer apply.')
})

test('a feed with junk in it renders without a null, a NaN or a foreign link', () => {
  const junk = liveFeed(W1, {
    discountPct: 'six', totalCount: -3, source: 'javascript:alert(1)',
    skus: [null, 7, { name: '24K coin 1 g', price: 'free', code: 'BLINKDEAL6' }, { brand: '*BOLD*\nNEWLINE', name: '24K Gold Coin 2 g', price: 32000, discount: 1000, code: 'BLINKDEAL6' }],
  })
  const data = postData(junk)
  assert.equal(data.pct, 6, 'the digits in the code stand in')
  assert.equal(data.source, null)
  const text = renderOpen(data) + renderOver(data, W1_END)
  assert.ok(!/null|undefined|NaN|javascript/.test(text), text)
  assert.ok(text.includes('2 g · ₹15,500/g · Bold Newline coin'), text)
  const bare = renderOpen(postData(liveFeed(W1, { skus: 'nope', source: undefined, totalCount: undefined })))
  assert.equal(bare, `BLINKDEAL6 live on Myntra — 6% off gold coins\nLive since 5:00 pm. Windows have lasted about 35 min.\n\nCompare them all on CCBuddy: ${WA_LINK}`)
})

test('cheapest by weight: 24K only, coins the code covers only, the common weights, lightest first', () => {
  const sku = (name, price, code = 'BLINKDEAL6') => ({ name, price, discount: 0, code, brand: 'B' })
  const rows = bestByWeight([
    sku('24K coin 1 g', 16000), sku('24K coin 1 g', 15000), sku('24K bar 1 g', 15500),
    sku('22K 916 coin 1 g', 9000), // not 24K
    sku('24K coin 1 g', 100, null), // the code does not cover it
    sku('995 coin 2 g', 31000), sku('995 coin 2 g', 30000),
    sku('24K coin 5 g', 76000), sku('24K coin 5 g', 75000),
    sku('24K coin 10 g', 150000), sku('24K coin 10 g', 151000),
    sku('24K coin 50 g', 700000), // one coin: the fifth weight drops out
    sku('24K coin', 15000), // no weight
  ])
  assert.deepEqual(rows.map((r) => [r.g, r.pg]), [[1, 15000], [2, 15000], [5, 15000], [10, 15000]])
  assert.equal(bestByWeight([sku('24K Gold Bar 20 g', 300000)])[0].kind, 'bar')
  assert.deepEqual(bestByWeight(undefined), [])
})

test('brands lose their capitals and company suffixes, keep their initials', () => {
  assert.equal(brandName('BHIMA'), 'Bhima')
  assert.equal(brandName('P N GADGIL JEWELLERS'), 'P N Gadgil Jewellers')
  assert.equal(brandName('C KRISHNIAH CHETTY JEWELLERS PVT LTD'), 'C Krishniah Chetty Jewellers')
  assert.equal(brandName('PMJ Jewels'), 'PMJ Jewels')
  assert.equal(brandName('Mia by Tanishq'), 'Mia by Tanishq')
  assert.equal(brandName(null), '')
})

test('IST clock times', () => {
  assert.equal(istClock(Date.parse('2026-10-29T12:52:00Z')), '6:22 pm')
  assert.equal(istClock(Date.parse('2026-10-29T18:35:00Z')), '12:05 am')
  assert.equal(istClock(Date.parse('2026-10-29T06:30:00Z')), '12:00 pm')
})

// ---- Dry run ---------------------------------------------------------------------

test('dry is the default: no WA_DRY_RUN means it prints the post and calls nothing', async (t) => {
  const h = await harness(t)
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW), { WA_DRY_RUN: undefined })
  assert.match(res.dry, /WA_DRY_RUN/)
  assert.equal(h.wa.requests.length, 0)
  assert.equal(h.github.calls.length, 0)
  assert.ok(h.lines.join('\n').includes(OPEN_TEXT))
  assert.equal(await readLedger(h.dir, `BLINKDEAL6-${Date.parse(W1)}`), null, 'a dry run never records a post')
})

test('missing or broken secrets mean a dry run, whatever WA_DRY_RUN says', async (t) => {
  const h = await harness(t)
  const e = edge(quietFeed(), liveFeed(W1), NOW)
  for (const [extra, why] of [
    [{ WHAPI_TOKEN: undefined }, /WHAPI_TOKEN/],
    [{ WHAPI_TOKEN: '  ' }, /WHAPI_TOKEN/],
    [{ WHAPI_CHANNEL_ID: undefined }, /WHAPI_CHANNEL_ID/],
    [{ WHAPI_CHANNEL_ID: 'my channel' }, /WHAPI_CHANNEL_ID/],
    [{ WA_DRY_RUN: '1' }, /WA_DRY_RUN/],
    [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, /push/],
    [{ GITHUB_RUN_ATTEMPT: '2' }, /re-run/],
  ]) {
    const res = await h.run(e, extra)
    assert.match(res.dry ?? '', why, JSON.stringify(extra))
  }
  assert.equal(h.wa.requests.length, 0)
  assert.equal(h.github.calls.length, 0)
})

test('a close in a dry run prints the edit it would make', async (t) => {
  const h = await harness(t)
  await h.run(edge(liveFeed(W1), ended(liveFeed(W1), W1_END), NOW), { WA_DRY_RUN: '' })
  assert.ok(h.lines.join('\n').includes('Over at 5:35 pm, after 36 min.'))
  assert.equal(h.wa.requests.length, 0)
})

// ---- Posting --------------------------------------------------------------------------

test('a live opening: session, role, then exactly one post, recorded', async (t) => {
  const h = await harness(t)
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters/:id', 'POST /messages/text', 'GET /messages/:id'])
  const [post] = h.wa.posts()
  assert.deepEqual(post.body, { to: CHANNEL, body: OPEN_TEXT, no_link_preview: true })
  assert.ok(h.wa.requests.every((r) => r.auth === `Bearer ${TOKEN}`), 'the token goes in the header')
  assert.ok(h.wa.requests.every((r) => !r.url.includes('token')), 'never in the URL')
  assert.equal(res.posted, `BLINKDEAL6-${Date.parse(W1)}`)
  assert.equal(h.outputs.posted_key, res.posted)
  const ledger = await readLedger(h.dir, res.posted)
  assert.equal(ledger.messageId, 'PsqXn5SAD5v7HRA-wHN2ziQ0001')
  assert.deepEqual(h.slept, [15000], 'one look at the delivery status, 15 s later')
  assert.equal(h.github.opened().length, 0)
})

test('the role is read from user_role, from role, or from the channel list', async (t) => {
  for (const routes of [
    { 'GET /newsletters/:id': { body: { id: CHANNEL, role: 'admin' } } },
    { 'GET /newsletters/:id': { status: 404, body: { error: { code: 404, message: 'not found' } } }, 'GET /newsletters': { body: { newsletters: [{ id: 'other@newsletter', role: 'owner' }, { id: CHANNEL, user_role: 'admin', name: 'CCBuddy Deals' }] } } },
  ]) {
    const h = await harness(t, { routes })
    const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
    assert.ok(res.posted, JSON.stringify(routes))
    assert.equal(h.wa.posts().length, 1)
  }
})

test('the OWNER number on the other end: nothing posted, paused with "unlink it now"', async (t) => {
  const h = await harness(t, { routes: { 'GET /newsletters/:id': { body: { id: CHANNEL, user_role: 'owner' } } } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 0)
  assert.equal(res.paused, 'owner-linked')
  const [issue] = h.github.opened()
  assert.equal(issue.title, PAUSE_TITLE)
  assert.match(issue.body, /OWNER/)
  assert.match(issue.body, /log out the Whapi device/)
})

test('a number that only follows the channel: nothing posted, paused', async (t) => {
  const h = await harness(t, { routes: { 'GET /newsletters/:id': { body: { id: CHANNEL, user_role: 'subscriber' } } } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 0)
  assert.equal(res.paused, 'not-admin')
})

test('a disconnected session (QR): nothing posted, paused with the re-link steps', async (t) => {
  const h = await harness(t, { routes: { 'GET /health': { body: { status: { code: 2, text: 'QR' }, user: { id: LINKED_NUMBER } } } } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 0)
  assert.equal(res.paused, 'logged-out')
  assert.match(h.github.opened()[0].body, /Linked devices → Link a device/)
  assert.ok(!h.published().includes(LINKED_NUMBER))
})

test('a session still reconnecting is waited for, briefly', async (t) => {
  const launching = { body: { status: { code: 1, text: 'LAUNCH' } } }
  const h = await harness(t, { routes: { 'GET /health': [launching, launching, { body: { status: { code: 4, text: 'AUTH' } } }] } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.ok(res.posted)
  assert.equal(h.wa.requests.filter((r) => r.route === 'GET /health').length, 3)
  assert.equal(h.wa.requests.find((r) => r.route === 'GET /health').url, '/health', 'a send wakes the session')
})

test('401, 401, 200: the reconnect is ridden out and it posts once', async (t) => {
  const no = { status: 401, body: { error: { code: 401, message: 'Need channel authorization for send message' } } }
  const h = await harness(t, { routes: { 'POST /messages/text': [no, no, { body: { sent: true, message: { id: 'PsqXn5SAD5v7HRA-wHN2ziQ0009' } } }] } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 3)
  assert.equal(res.posted, `BLINKDEAL6-${Date.parse(W1)}`)
  assert.equal((await readLedger(h.dir, res.posted)).messageId, 'PsqXn5SAD5v7HRA-wHN2ziQ0009')
  assert.deepEqual(h.slept.slice(0, 2), [3000, 3000])
})

test('401 that does not clear: four tries in all, then paused', async (t) => {
  const h = await harness(t, { routes: { 'POST /messages/text': { status: 401, body: { error: { code: 401, message: 'no' } } } } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 4)
  assert.equal(res.paused, 'unauthorised')
})

test('429 is a soft ban: one attempt, no retry, paused with a rest date; the next window only annotates the issue', async (t) => {
  const h = await harness(t, { routes: { 'POST /messages/text': { status: 429, body: { error: { code: 429, message: 'Too many requests' } } } } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 1, 'never retried')
  assert.equal(res.paused, 'soft-ban')
  assert.equal(h.slept.length, 0, 'no waiting around to try again either')
  const [issue] = h.github.opened()
  assert.match(issue.body, /429/)
  assert.match(issue.body, /until at least 31 Oct, 17:00 IST/)
  assert.equal(await readLedger(h.dir, `BLINKDEAL6-${Date.parse(W1)}`), null, 'nothing went out, so nothing is recorded')

  // The next window, with the issue still open: no Whapi call at all, one comment.
  const before = h.wa.requests.length
  const again = await h.run(edge(ended(liveFeed(W1), W1_END), liveFeed(W2), after(W2, 30)))
  assert.equal(again.paused, 'already')
  assert.equal(h.wa.requests.length, before)
  assert.equal(h.github.opened().length, 1, 'still one issue')
  assert.match(h.github.comments()[0], /Skipped BLINKDEAL6 live since 7:30 pm/)
})

test('a 5xx may have been sent: one attempt, the run fails, no pause, nothing recorded', async (t) => {
  const h = await harness(t, { routes: { 'POST /messages/text': { status: 500, body: { error: { code: 500, message: 'oops' } } } } })
  await assert.rejects(h.run(edge(quietFeed(), liveFeed(W1), NOW)), /Whapi send: HTTP 500/)
  assert.equal(h.wa.posts().length, 1)
  assert.equal(h.github.opened().length, 0)
  assert.equal(await readLedger(h.dir, `BLINKDEAL6-${Date.parse(W1)}`), null)
})

test('no answer at all: one attempt, the run fails, no retry', async (t) => {
  const h = await harness(t, { routes: { 'POST /messages/text': { hang: true } } })
  await assert.rejects(h.run(edge(quietFeed(), liveFeed(W1), NOW)), /no answer \(timed out\)/)
  assert.equal(h.wa.posts().length, 1)
  assert.equal(h.github.opened().length, 0)
})

test('402, 403, 404 each pause instead of failing the run again every push', async (t) => {
  for (const [status, kind] of [[402, 'plan-limit'], [403, 'forbidden'], [404, 'not-found']]) {
    const h = await harness(t, { routes: { 'POST /messages/text': { status, body: { error: { code: status, message: 'x' } } } } })
    const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
    assert.equal(res.paused, kind)
    assert.equal(h.wa.posts().length, 1)
  }
})

test('WhatsApp marking the post failed pauses the poster', async (t) => {
  const h = await harness(t, { routes: { 'GET /messages/:id': { body: { id: 'x', status: 'failed' } } } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.ok(res.posted)
  assert.equal(res.paused, 'failed')
})

test('while the pause issue is open, no Whapi call is made at all', async (t) => {
  const h = await harness(t, { issues: [{ number: 7, title: PAUSE_TITLE }] })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(res.paused, 'already')
  assert.equal(h.wa.requests.length, 0)
  assert.equal(h.github.calls.at(-1).path, '/issues/7/comments')
})

// ---- The close ------------------------------------------------------------------------

test('the end edits the recorded post in place; no second post', async (t) => {
  const h = await harness(t)
  const open = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  const id = (await readLedger(h.dir, open.posted)).messageId
  const res = await h.run(edge(liveFeed(W1), ended(liveFeed(W1), W1_END), after(W1_END, 20)))
  assert.equal(res.edited, id)
  const posts = h.wa.posts()
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1].body, { to: CHANNEL, edit: id, body: renderOver(postData(liveFeed(W1)), W1_END), no_link_preview: true })
})

test('an end with no post on record (dry, late or failed) calls nothing', async (t) => {
  const h = await harness(t)
  const res = await h.run(edge(liveFeed(W1), ended(liveFeed(W1), W1_END), NOW))
  assert.equal(res.edited, null)
  assert.equal(h.wa.requests.length, 0)
  assert.equal(h.github.calls.length, 0)
})

test('WA_CLOSE=off leaves the post as it is', async (t) => {
  const h = await harness(t, { env: { WA_CLOSE: 'off' } })
  await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  const before = h.wa.requests.length
  const res = await h.run(edge(liveFeed(W1), ended(liveFeed(W1), W1_END), NOW))
  assert.equal(res.edited, null)
  assert.equal(h.wa.requests.length, before)
})

test('two windows on one day under one reused coupon id: two posts, two edits, each to its own post, duplicates ignored', async (t) => {
  const h = await harness(t)
  // A workflow run per push, as the phone makes them.
  const pushes = [
    [quietFeed(), liveFeed(W1), after(W1, 25)], // open W1
    [liveFeed(W1), liveFeed(W1, { checkedAt: 'hb' }), after(W1, 145)], // heartbeat
    [quietFeed(), liveFeed(W1), after(W1, 200)], // W1's open again (a duplicate run, a lost before): the ledger stops it
    [liveFeed(W1), ended(liveFeed(W1), W1_END), after(W1_END, 20)], // W1 ends
    [ended(liveFeed(W1), W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 1200)], // quiet heartbeat
    [ended(liveFeed(W1), W1_END), liveFeed(W2), after(W2, 25)], // open W2: same code, same coupon id, same day
    [liveFeed(W2), ended(liveFeed(W2), W2_END), after(W2_END, 20)], // W2 ends
    [liveFeed(W2), ended(liveFeed(W2), W2_END), after(W2_END, 80)], // the same end again: an edit is idempotent anyway
  ]
  for (const [b, a, now] of pushes) await h.run(edge(b, a, now))
  const posts = h.wa.posts()
  const fresh = posts.filter((p) => !p.body.edit)
  const edits = posts.filter((p) => p.body.edit)
  assert.equal(fresh.length, 2, 'one post per window')
  assert.match(fresh[0].body.body, /Live since 5:00 pm/)
  assert.match(fresh[1].body.body, /Live since 7:30 pm/)
  assert.deepEqual(edits.map((p) => p.body.edit), [
    'PsqXn5SAD5v7HRA-wHN2ziQ0001', 'PsqXn5SAD5v7HRA-wHN2ziQ0002', 'PsqXn5SAD5v7HRA-wHN2ziQ0002',
  ])
  assert.match(edits[0].body.body, /^Over at 5:35 pm, after 36 min\./)
  assert.match(edits[1].body.body, /^Over at 8:06 pm, after 36 min\./)
  assert.ok(h.lines.some((l) => /already posted as PsqXn5SAD5v7HRA-wHN2ziQ0001/.test(l)))
})

test('a post Whapi gave no id for is still recorded (never posted twice) but cannot be edited', async (t) => {
  const h = await harness(t, { routes: { 'POST /messages/text': { body: { sent: true } } } })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal((await readLedger(h.dir, res.posted)).messageId, null)
  await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  await h.run(edge(liveFeed(W1), ended(liveFeed(W1), W1_END), NOW))
  assert.equal(h.wa.posts().length, 1)
})

// ---- What gets published ---------------------------------------------------------------

test('logs and issues never carry the token, the linked number or the channel id', async (t) => {
  // Whapi's own error text echoing both back is the worst case.
  const leak = { status: 403, body: { error: { code: 403, message: `token ${TOKEN} from ${LINKED_NUMBER} to ${CHANNEL}` } } }
  const h = await harness(t, { routes: { 'POST /messages/text': leak } })
  await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  await runHealth({ env: h.env(), deps: { ...h.deps, gh: fakeGitHub().gh } })
  await runCheck({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: h.deps })
  const out = h.published()
  assert.match(out, /Whapi send: HTTP 403 \(token <redacted> from <n> to <n>@newsletter\)/, "Whapi's reason is logged, redacted")
  for (const secret of [TOKEN, LINKED_NUMBER, CHANNEL, CHANNEL.split('@')[0]]) assert.ok(!out.includes(secret), `published ${secret}`)
  assert.equal(redact(`a ${TOKEN} b 9198000000001`, [TOKEN]), 'a <redacted> b <n>')
})

test('tests only ever talk to the local fake; the real host is the default and is blocked here', async (t) => {
  const h = await harness(t)
  assert.match(h.wa.base, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(settings({}).base, WHAPI)
  assert.equal(WHAPI, 'https://gate.whapi.cloud')
  const call = whapi({ token: TOKEN }) // the default base, i.e. the real host
  await assert.rejects(call('health', 'GET', '/health'), /network error/, 'the tripwire stops it before the network')
})

// ---- The hand-run modes -------------------------------------------------------------------

test('health probe (watchdog): pauses on QR, STOP and BANNED only, without waking the session', async (t) => {
  for (const [text, paused] of [['QR', 'logged-out'], ['STOP', 'stopped'], ['BANNED', 'banned'], ['AUTH', null], ['LAUNCH', null]]) {
    const h = await harness(t, { routes: { 'GET /health': { body: { status: { code: 0, text }, user: { id: LINKED_NUMBER } } } } })
    const res = await runHealth({ env: h.env(), deps: h.deps })
    assert.equal(h.wa.requests[0].url, '/health?wakeup=false')
    assert.equal(h.github.opened().length, paused ? 1 : 0, text)
    if (paused) assert.equal(res, paused)
  }
})

test('health probe: no token means not set up, and calls nothing', async (t) => {
  const h = await harness(t)
  assert.equal(await runHealth({ env: h.env({ WHAPI_TOKEN: undefined }), deps: h.deps }), null)
  assert.equal(h.wa.requests.length + h.github.calls.length, 0)
})

test('check: reports the session and the role in each channel, read-only', async (t) => {
  const h = await harness(t)
  assert.equal(await runCheck({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: h.deps }), true)
  assert.ok(h.wa.requests.every((r) => r.route.startsWith('GET ')))
  assert.match(h.lines.join('\n'), /session: AUTH[\s\S]*channel: "CCBuddy Deals", this number's role: admin/)
  const owner = await harness(t, { routes: { 'GET /newsletters/:id': { body: { user_role: 'owner', name: 'CCBuddy Deals' } } } })
  assert.equal(await runCheck({ env: owner.env(), deps: owner.deps }), false)
  assert.match(owner.lines.join('\n'), /OWNER number is linked/)
})

test('test-post goes only to the test channel: post, then the edit', async (t) => {
  const h = await harness(t)
  assert.equal(await runTestPost({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: h.deps }), true)
  const posts = h.wa.posts()
  assert.equal(posts.length, 2)
  assert.ok(posts.every((p) => p.body.to === TEST_CHANNEL))
  assert.ok(posts[0].body.body.startsWith(`${TEMPLATES.waTest}\n\n`))
  assert.equal(posts[1].body.edit, 'PsqXn5SAD5v7HRA-wHN2ziQ0001')
  assert.match(posts[1].body.body, /Over at/)
})

test('test-post refuses the real channel, a missing test channel, and a paused poster', async (t) => {
  const h = await harness(t)
  assert.equal(await runTestPost({ env: h.env({ WA_TEST_CHANNEL_ID: CHANNEL }), deps: h.deps }), false)
  assert.equal(await runTestPost({ env: h.env({ WA_TEST_CHANNEL_ID: undefined }), deps: h.deps }), false)
  const paused = await harness(t, { issues: [{ number: 3, title: PAUSE_TITLE }] })
  assert.equal(await runTestPost({ env: paused.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: paused.deps }), false)
  assert.equal(h.wa.requests.length + paused.wa.requests.length, 0)
})

// ---- The CLI the workflow runs ------------------------------------------------------------

test('the workflow steps end to end: --edge writes the outputs, --post with no secrets prints and calls nothing', async (t) => {
  const wa = await fakeWhapi()
  t.after(() => wa.close())
  const dir = await mkdtemp(join(tmpdir(), 'wa-cli-'))
  const files = { before: join(dir, 'before.json'), after: join(dir, 'after.json'), out: join(dir, 'gh-output'), edge: join(dir, 'edge.json') }
  await writeFile(files.before, JSON.stringify(quietFeed()))
  await writeFile(files.after, JSON.stringify(liveFeed(new Date(Date.now() - 30000).toISOString())))
  await writeFile(files.out, '')
  // A clean environment: whatever the shell running the tests holds, no token reaches the child.
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, GITHUB_OUTPUT: files.out, WHAPI_BASE: wa.base }
  const script = join(HERE, 'wa-post.mjs')
  const e = await run(process.execPath, [script, '--edge', '--before', files.before, '--after', files.after, '--out', files.edge], { env })
  assert.match(e.stdout, /edge: open BLINKDEAL6-\d+/)
  const outputs = await readFile(files.out, 'utf8')
  assert.match(outputs, /^open_key=BLINKDEAL6-\d+$/m)
  assert.match(outputs, /^close_key=$/m)
  assert.match(outputs, /^any=1$/m)
  const p = await run(process.execPath, [script, '--post', '--edge-file', files.edge], { env: { ...env, WA_DRY_RUN: '0', GITHUB_EVENT_NAME: 'push' } })
  assert.match(p.stdout, /DRY RUN: the WHAPI_TOKEN secret is not set/)
  assert.match(p.stdout, /BLINKDEAL6 live on Myntra — 6% off gold coins/)
  assert.equal(wa.requests.length, 0)
  assert.doesNotMatch(await readFile(files.out, 'utf8'), /posted_key/)
})
