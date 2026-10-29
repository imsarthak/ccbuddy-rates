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

/**
 * The repo's issues and master's feed: what wa-post.mjs asks of GitHub, and
 * nothing more. An issue is the bot's unless it says otherwise. `latest` is
 * master's docs/blinkdeal.json (a value or a function); left out, reading it
 * fails, as the API can.
 */
function fakeGitHub(open = [], latest) {
  const issues = open.map((i) => ({ user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', ...i }))
  const calls = []
  let next = 40
  const gh = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method: init.method ?? 'GET', body })
    if (path === '/contents/docs/blinkdeal.json' && !init.method) {
      assert.equal(init.headers?.accept, 'application/vnd.github.raw+json')
      if (latest === undefined) throw new Error('GET /contents/docs/blinkdeal.json: 503 unavailable')
      return typeof latest === 'function' ? latest() : latest
    }
    if (path.startsWith('/issues?')) return issues
    if (path === '/issues' && init.method === 'POST') {
      const i = { number: ++next, title: body.title, body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' }
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
async function harness(t, { routes, issues, env, latest, timeoutMs = 3000 } = {}) {
  const wa = await fakeWhapi(routes)
  t.after(() => wa.close())
  const github = fakeGitHub(issues, latest)
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
    // Generous: these tests run in the posting job, and a slow runner must
    // not fail one and cost a real window its post.
    timeoutMs,
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
// The feed as the phone last wrote it before a window ended: a live feed is
// rewritten every 2 min, so its checkedAt is a minute or so before the end.
const liveTill = (from, end) => liveFeed(from, { checkedAt: new Date(Date.parse(end) - 60000).toISOString() })

const OPEN_TEXT = [
  'BLINKDEAL6 live on Myntra — 6% off gold coins',
  'Live since 5:00 pm.',
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
  const e = edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 20))
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

test('a first-ever push (no feed file before) opens a fresh window', () => {
  assert.ok(edge({}, liveFeed(W1), NOW).open)
})

test('a feed before the push that could not be read never opens: a heartbeat would look like the opening', () => {
  // The workflow writes { unreadable: true } when the old head cannot be
  // fetched; readJson gives null for a file that is not JSON.
  for (const before of [{ unreadable: true }, null, 'garbage', [], 42]) {
    const e = edge(before, liveFeed(W1, { checkedAt: 'hb' }), after(W1, 140))
    assert.deepEqual([e.open, e.close], [null, null], JSON.stringify(before))
    assert.match(e.notes.join(' '), /could not be read/)
  }
  // A before that says live but whose window is garbage: not a quiet feed either.
  const e = edge({ ok: true, live: true, lastLive: { code: 'BLINKDEAL6', from: 'x' } }, liveFeed(W1), NOW)
  assert.equal(e.open, null)
})

test('the end time is dropped when the watcher had stopped before it (the phone died mid-window)', () => {
  // Live feed last written 5:10 pm; the phone came back at 11:40 pm and the
  // detector stamped the close then. "Over at 11:40 pm, after 6 h" would be false.
  const before = liveFeed(W1, { checkedAt: '2026-10-29T11:40:00.000Z', heartbeatMs: 120000 })
  const late = ended(liveFeed(W1), '2026-10-29T18:10:00.000Z')
  const e = edge(before, late, Date.parse('2026-10-29T18:10:20.000Z'))
  assert.equal(e.close.key, `BLINKDEAL6-${Date.parse(W1)}`)
  assert.equal(e.close.to, null)
  assert.equal(renderOver(e.close.data, e.close.to).split('\n')[0], 'Over. These prices no longer apply.')
  // A watcher that was watching: the last live write 2 min before the close.
  const fresh = edge(liveFeed(W1, { checkedAt: '2026-10-29T12:03:30.000Z' }), ended(liveFeed(W1), W1_END), after(W1_END, 20))
  assert.equal(fresh.close.to, W1_END)
})

test('one push jumping from one window straight to the next closes the first and opens the second', () => {
  // Same code and same coupon id both times: only the start tells them apart.
  const history = { windows: [{ code: 'BLINKDEAL6', couponId: '135733', from: W1, to: W1_END }] }
  const e = edge(liveTill(W1, W1_END), liveFeed(W2), after(W2, 40), history)
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
  assert.equal(data.pct, null, "a code's digits are not its discount")
  assert.equal(data.source, null)
  const text = renderOpen(data) + renderOver(data, W1_END)
  assert.ok(!/null|undefined|NaN|javascript/.test(text), text)
  assert.ok(text.includes('2 g · ₹15,500/g · Bold Newline coin'), text)
  const bare = renderOpen(postData(liveFeed(W1, { skus: 'nope', source: undefined, totalCount: undefined })))
  assert.equal(bare, `BLINKDEAL6 live on Myntra — 6% off gold coins\nLive since 5:00 pm.\n\nCompare them all on CCBuddy: ${WA_LINK}`)
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

test('a missing token or a mistyped channel id means a dry run, whatever WA_DRY_RUN says', async (t) => {
  // A missing WHAPI_CHANNEL_ID is not one: the channel is then found (below).
  const h = await harness(t)
  const e = edge(quietFeed(), liveFeed(W1), NOW)
  for (const [extra, why] of [
    [{ WHAPI_TOKEN: undefined }, /WHAPI_TOKEN/],
    [{ WHAPI_TOKEN: '  ' }, /WHAPI_TOKEN/],
    [{ WHAPI_CHANNEL_ID: 'my channel' }, /WHAPI_CHANNEL_ID/],
    [{ WHAPI_CHANNEL_ID: '120363000000000001' }, /WHAPI_CHANNEL_ID/],
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
  await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), NOW), { WA_DRY_RUN: '' })
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
  const h = await harness(t, { routes: { 'POST /messages/text': { hang: true } }, timeoutMs: 300 })
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

test('a stranger cannot pause it: only an issue by the workflow, the owner or a collaborator is the switch', async (t) => {
  // The repo is public: anyone can open an issue with that title.
  const stranger = { number: 9, title: PAUSE_TITLE, user: { login: 'someone', type: 'User' }, author_association: 'NONE' }
  const h = await harness(t, { issues: [stranger] })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.ok(res.posted)
  assert.equal(res.paused, null)
  assert.ok(!h.github.comments().length, "nothing is written on the stranger's issue")
  for (const author_association of ['OWNER', 'COLLABORATOR']) {
    const own = await harness(t, { issues: [{ ...stranger, user: { login: 'owner', type: 'User' }, author_association }] })
    assert.equal((await own.run(edge(quietFeed(), liveFeed(W1), NOW))).paused, 'already', author_association)
    assert.equal(own.wa.requests.length, 0)
  }
})

test('a window master has already moved past is not posted (the run queued past a short window)', async (t) => {
  // Master's feed now: W1 has ended.
  const h = await harness(t, { latest: ended(liveFeed(W1), W1_END) })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(res.posted, null)
  assert.equal(h.wa.requests.length, 0)
  assert.match(h.lines.join('\n'), /moved on \(no window live\)/)
  // The same window still live on master posts, and so does a failed read
  // of master (the push said so) or no answer from the API at all.
  for (const latest of [liveFeed(W1, { checkedAt: 'later' }), { ...liveFeed(W1), ok: false, live: false }, undefined]) {
    const ok = await harness(t, { latest })
    assert.ok((await ok.run(edge(quietFeed(), liveFeed(W1), NOW))).posted, JSON.stringify(latest)?.slice(0, 40))
  }
})

test('a 401 on a read (session or role) is a reconnect too: retried, not a pause', async (t) => {
  const no = { status: 401, body: { error: { code: 401, message: 'Need channel authorization' } } }
  const h = await harness(t, {
    routes: {
      'GET /health': [no, { body: { status: { code: 4, text: 'AUTH' } } }],
      'GET /newsletters/:id': [no, no, { body: { id: CHANNEL, user_role: 'admin' } }],
    },
  })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.ok(res.posted)
  assert.equal(res.paused, null)
  // The watchdog's probe rides it out the same way.
  const probe = await harness(t, { routes: { 'GET /health': [no, { body: { status: { code: 4, text: 'AUTH' } } }] } })
  assert.equal(await runHealth({ env: probe.env(), deps: probe.deps }), 'AUTH')
  assert.equal(probe.github.opened().length, 0)
  // One that never clears still pauses, and says the watchdog opened it.
  const dead = await harness(t, { routes: { 'GET /health': no } })
  assert.equal(await runHealth({ env: dead.env(), deps: dead.deps }), 'unauthorised')
  assert.equal(dead.wa.requests.length, 4)
  assert.match(dead.github.opened()[0].body, /Opened by \.github\/workflows\/watchdog\.yml/)
})

// ---- The close ------------------------------------------------------------------------

test('the end edits the recorded post in place; no second post', async (t) => {
  const h = await harness(t)
  const open = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  const id = (await readLedger(h.dir, open.posted)).messageId
  const res = await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 20)))
  assert.equal(res.edited, id)
  const posts = h.wa.posts()
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1].body, { to: CHANNEL, edit: id, body: renderOver(postData(liveFeed(W1)), W1_END), no_link_preview: true })
})

test('an end with no post on record (dry, late or failed) calls nothing', async (t) => {
  const h = await harness(t)
  const res = await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), NOW))
  assert.equal(res.edited, null)
  assert.equal(h.wa.requests.length, 0)
  assert.equal(h.github.calls.length, 0)
})

test('WA_CLOSE=off leaves the post as it is', async (t) => {
  const h = await harness(t, { env: { WA_CLOSE: 'off' } })
  await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  const before = h.wa.requests.length
  const res = await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), NOW))
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
    [liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 20)], // W1 ends
    [ended(liveFeed(W1), W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 1200)], // quiet heartbeat
    [ended(liveFeed(W1), W1_END), liveFeed(W2), after(W2, 25)], // open W2: same code, same coupon id, same day
    [liveTill(W2, W2_END), ended(liveFeed(W2), W2_END), after(W2_END, 20)], // W2 ends
    [liveTill(W2, W2_END), ended(liveFeed(W2), W2_END), after(W2_END, 80)], // the same end again: an edit is idempotent anyway
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
  await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), NOW))
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
  // The real id mistyped: refused before any call. (Missing, it is found: below.)
  assert.equal(await runTestPost({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL, WHAPI_CHANNEL_ID: 'CCBuddy Deals' }), deps: h.deps }), false)
  assert.match(h.lines.join('\n'), /the WHAPI_CHANNEL_ID secret is set but is not a …@newsletter id/)
  const paused = await harness(t, { issues: [{ number: 3, title: PAUSE_TITLE }] })
  assert.equal(await runTestPost({ env: paused.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: paused.deps }), false)
  assert.equal(h.wa.requests.length + paused.wa.requests.length, 0)
})

// ---- No WHAPI_CHANNEL_ID: the channel finds itself ----------------------------------------
//
// GET /newsletters lists every Channel the linked number is in, with its role
// there. Unset, the channel is the one it admins, the test channel aside.

const OTHER = '120363000000000003@newsletter'
const OWNED = '120363000000000004@newsletter'
const REAL = { id: CHANNEL, name: 'CCBuddy Deals', user_role: 'admin', subscribers_count: 230 }
const TESTING = { id: TEST_CHANNEL, name: 'CCBuddy test', user_role: 'admin', subscribers_count: 1 }
const FOLLOWED = { id: OTHER, name: 'Gold news', role: 'subscriber', subscribers_count: 90000 }
const MINE = { id: OWNED, name: 'Mine', user_role: 'owner', subscribers_count: 3 }
const listed = (...newsletters) => ({ 'GET /newsletters': { body: { newsletters, count: 100, total: newsletters.length, offset: 0 } } })
const FIND = { WHAPI_CHANNEL_ID: undefined }
// Everything that must never be published, digits alone included.
const SECRETS = [TOKEN, LINKED_NUMBER, ...[CHANNEL, TEST_CHANNEL, OTHER, OWNED].flatMap((id) => [id, id.split('@')[0]])]
const leaks = (text) => SECRETS.filter((s) => text.includes(s))

test('no channel id: it posts to the one Channel this number admins, one list call in place of the role call', async (t) => {
  // The role read from user_role or from role, as Whapi has named it both ways.
  for (const real of [REAL, { ...REAL, user_role: undefined, role: 'admin' }]) {
    const h = await harness(t, { env: FIND, routes: listed(FOLLOWED, real) })
    const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
    assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters', 'POST /messages/text', 'GET /messages/:id'])
    assert.equal(h.wa.requests[1].url, '/newsletters?count=100')
    assert.deepEqual(h.wa.posts()[0].body, { to: CHANNEL, body: OPEN_TEXT, no_link_preview: true })
    assert.equal(res.posted, `BLINKDEAL6-${Date.parse(W1)}`)
    assert.match(h.lines.join('\n'), /session AUTH, role admin in "CCBuddy Deals" \(found by itself/)
    assert.deepEqual(leaks(h.published()), [])
  }
})

test('no channel id: the end edits the post in the channel found, with no extra call', async (t) => {
  const h = await harness(t, { env: FIND, routes: listed(REAL, FOLLOWED) })
  const open = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  const id = (await readLedger(h.dir, open.posted)).messageId
  const before = h.wa.requests.length
  const res = await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 20)))
  assert.equal(res.edited, id)
  assert.deepEqual(h.wa.requests.slice(before).map((r) => r.route), ['GET /health', 'GET /newsletters', 'POST /messages/text'])
  assert.deepEqual(h.wa.posts()[1].body, { to: CHANNEL, edit: id, body: renderOver(postData(liveFeed(W1)), W1_END), no_link_preview: true })
})

test('no channel id, and the number owns a Channel: nothing posted, the owner pause, even if it admins one too', async (t) => {
  // "creator" is the changelog's word for the owner (3 Aug 2024): the same thing.
  for (const newsletters of [
    [MINE],
    [{ ...REAL, user_role: 'owner' }, FOLLOWED],
    [REAL, { ...MINE, user_role: undefined, role: 'owner' }],
    [{ ...REAL, user_role: 'creator' }],
    [REAL, { ...MINE, user_role: 'creator' }],
  ]) {
    const h = await harness(t, { env: FIND, routes: listed(...newsletters) })
    const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
    assert.equal(h.wa.posts().length, 0, JSON.stringify(newsletters))
    assert.equal(res.paused, 'owner-linked')
    const [issue] = h.github.opened()
    assert.match(issue.body, /OWNER[\s\S]*log out the Whapi device[\s\S]*set the WHAPI_CHANNEL_ID secret/)
    assert.deepEqual(leaks(h.published()), [])
  }
})

test('no channel id, and admin of two Channels: nothing posted, paused asking for the id', async (t) => {
  const h = await harness(t, { env: FIND, routes: listed(REAL, TESTING, FOLLOWED) })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 0)
  assert.equal(res.paused, 'many-channels')
  const [issue] = h.github.opened()
  assert.match(issue.title, new RegExp(PAUSE_TITLE))
  assert.match(issue.body, /admin of 2 WhatsApp Channels[\s\S]*Add the repository secret WHAPI_CHANNEL_ID[\s\S]*WA_TEST_CHANNEL_ID/)
  assert.ok(!/CCBuddy|Gold news/.test(issue.body), 'no channel names in a public issue')
  assert.deepEqual(leaks(h.published()), [])
  // The test channel named in WA_TEST_CHANNEL_ID is left out, so the other one is the channel.
  const ok = await harness(t, { env: { ...FIND, WA_TEST_CHANNEL_ID: TEST_CHANNEL }, routes: listed(TESTING, REAL, FOLLOWED) })
  assert.ok((await ok.run(edge(quietFeed(), liveFeed(W1), NOW))).posted)
  assert.deepEqual(ok.wa.posts().map((p) => p.body.to), [CHANNEL])
})

test('no channel id, and no Channel it admins but the test one, or none at all: nothing posted, paused with the invite steps', async (t) => {
  for (const [env, newsletters, title] of [
    [{ ...FIND, WA_TEST_CHANNEL_ID: TEST_CHANNEL }, [TESTING, FOLLOWED], /not an admin of any WhatsApp Channel other than the test channel yet/],
    [FIND, [FOLLOWED, { ...REAL, user_role: 'guest' }], /not an admin of any WhatsApp Channel yet/],
    [FIND, [], /not an admin of any WhatsApp Channel yet/],
  ]) {
    const h = await harness(t, { env, routes: listed(...newsletters) })
    const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
    assert.equal(h.wa.posts().length, 0)
    assert.equal(res.paused, 'not-admin')
    assert.match(h.github.opened()[0].body, title)
    assert.match(h.github.opened()[0].body, /Channel info → Invite admins → the spare number, then accept the invitation on the spare phone/)
    assert.deepEqual(leaks(h.published()), [])
  }
})

test('no channel id, and a list that may run past one page: not trusted to hold only one, nothing posted', async (t) => {
  const crowd = Array.from({ length: 99 }, (_, i) => ({ id: `1203631${String(i).padStart(11, '0')}@newsletter`, name: `n${i}`, role: 'subscriber' }))
  for (const routes of [listed(REAL, ...crowd), { 'GET /newsletters': { body: { newsletters: [REAL], count: 100, total: 140, offset: 0 } } }]) {
    const h = await harness(t, { env: FIND, routes })
    const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
    assert.equal(h.wa.posts().length, 0)
    assert.equal(res.paused, 'many-channels')
    assert.match(h.github.opened()[0].body, /follows too many WhatsApp Channels/)
    assert.equal(h.wa.requests.filter((r) => r.route === 'GET /newsletters').length, 1, 'one page, never a crawl')
  }
})

test('no channel id is no reason to be dry, and a dry run still calls nothing at all', async (t) => {
  const live = { WA_DRY_RUN: '0', WHAPI_TOKEN: TOKEN, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1' }
  for (const WHAPI_CHANNEL_ID of [undefined, '', '  ']) assert.equal(settings({ ...live, WHAPI_CHANNEL_ID }).dry, null)
  const h = await harness(t, { env: FIND, routes: listed(REAL) })
  for (const extra of [{ WA_DRY_RUN: undefined }, { WA_DRY_RUN: '1' }, { WHAPI_TOKEN: undefined }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    assert.ok((await h.run(edge(quietFeed(), liveFeed(W1), NOW), extra)).dry, JSON.stringify(extra))
    assert.ok((await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), NOW), extra)).dry)
  }
  assert.equal(h.wa.requests.length, 0)
  assert.equal(h.github.calls.length, 0)
})

test('an explicit WHAPI_CHANNEL_ID works as before: its own role call, and the list is never read', async (t) => {
  // A list that would pause a search (an owned Channel, two admin ones) changes nothing.
  const h = await harness(t, { routes: listed(MINE, REAL, TESTING) })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.ok(res.posted)
  assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters/:id', 'POST /messages/text', 'GET /messages/:id'])
  assert.equal(h.wa.posts()[0].body.to, CHANNEL)
})

test('check with no channel id: the session, how many it admins, the name and role, and never an id', async (t) => {
  const h = await harness(t, { env: FIND, routes: listed(FOLLOWED, REAL, TESTING) })
  assert.equal(await runCheck({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: h.deps }), true)
  const out = h.lines.join('\n')
  assert.match(out, /^session: AUTH$/m)
  assert.match(out, /Channels this number admins, the test channel aside: 1$/m)
  assert.match(out, /^channel: "CCBuddy Deals" \(found by itself\), this number's role: admin$/m)
  assert.match(out, /^test channel: "CCBuddy test", this number's role: admin$/m)
  assert.ok(!out.includes('@newsletter'), out)
  assert.deepEqual(leaks(out), [])
  assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters'], 'one list call covers both channels')
  assert.ok(h.wa.requests.every((r) => r.route.startsWith('GET ')))
  // Two, none or an owner: not ready, and it says what to do.
  for (const [newsletters, why] of [[[REAL, TESTING], /admins: 2[\s\S]*admin of 2 WhatsApp Channels/], [[FOLLOWED], /admins: 0[\s\S]*Invite admins/], [[MINE], /OWNER[\s\S]*log out the Whapi device/]]) {
    const c = await harness(t, { env: FIND, routes: listed(...newsletters) })
    assert.equal(await runCheck({ env: c.env(), deps: c.deps }), false)
    const said = c.lines.join('\n')
    assert.match(said, why)
    assert.match(said, /Not ready/)
    assert.ok(!/\d@newsletter/.test(said), said)
    assert.deepEqual(leaks(said), [])
  }
  // A test id that is not an id is said so, and is not left out of the count.
  const typo = await harness(t, { env: FIND, routes: listed(REAL, TESTING) })
  assert.equal(await runCheck({ env: typo.env({ WA_TEST_CHANNEL_ID: 'CCBuddy test' }), deps: typo.deps }), false)
  assert.match(typo.lines.join('\n'), /admins: 2$[\s\S]*^test channel: set, but not a …@newsletter id, so it is not left out$/m)
})

test('test-post with no channel id: finds the real channel first, then posts to the test channel only', async (t) => {
  const h = await harness(t, { env: FIND, routes: listed(REAL, TESTING) })
  assert.equal(await runTestPost({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: h.deps }), true)
  assert.deepEqual(h.wa.requests.map((r) => r.route), ['GET /health', 'GET /newsletters', 'POST /messages/text', 'GET /messages/:id', 'POST /messages/text'])
  assert.deepEqual(h.wa.posts().map((p) => p.body.to), [TEST_CHANNEL, TEST_CHANNEL])
  assert.match(h.lines.join('\n'), /real channel: "CCBuddy Deals" \(found by itself\)/)
  assert.deepEqual(leaks(h.lines.join('\n')), [])
})

test('test-post with no channel id refuses unless exactly one real channel is found, and refuses ids that look swapped', async (t) => {
  for (const [newsletters, why] of [
    [[TESTING, FOLLOWED], /not an admin of any WhatsApp Channel other than the test channel/],
    [[REAL, TESTING, { ...REAL, id: OTHER, name: 'Other' }], /admin of 2 WhatsApp Channels/],
    [[REAL, TESTING, MINE], /OWNER/],
    [[REAL, { ...TESTING, user_role: 'subscriber' }], /not an admin of the test channel \(its role is subscriber\)/],
    [[REAL], /not an admin of the test channel \(the channel was not found\)/],
    [[REAL, { ...TESTING, subscribers_count: undefined }], /no follower counts/],
  ]) {
    const h = await harness(t, { env: FIND, routes: listed(...newsletters) })
    assert.equal(await runTestPost({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: h.deps }), false)
    assert.equal(h.wa.posts().length, 0)
    assert.match(h.lines.join('\n'), why)
  }
  // WA_TEST_CHANNEL_ID set to the REAL channel by mistake. Left out of the
  // search, it makes the test channel look like the real one; the follower
  // counts give it away, and no TEST POST reaches the real followers.
  const swapped = await harness(t, { env: FIND, routes: listed(REAL, TESTING) })
  assert.equal(await runTestPost({ env: swapped.env({ WA_TEST_CHANNEL_ID: CHANNEL }), deps: swapped.deps }), false)
  assert.equal(swapped.wa.posts().length, 0)
  assert.match(swapped.lines.join('\n'), /WA_TEST_CHANNEL_ID may be the real channel/)
  assert.deepEqual(leaks(swapped.lines.join('\n')), [])
})

// ---- Trying to make it post where it must not -------------------------------------------
//
// Each of these is a way a real run could reach the wrong Channel, the
// owner's number, or the real followers with a TEST POST.

// GET /newsletters/{id} answered per id, as Whapi does: 404 for one it does not know.
const byId = (...channels) => ({
  'GET /newsletters/:id': (req) => {
    const id = decodeURIComponent(req.url.split('?')[0].split('/')[2])
    const n = channels.find((c) => c.id === id)
    return n ? { body: n } : { status: 404, body: { error: { code: 404, message: 'newsletter not found' } } }
  },
})
const STRANGER = { id: OTHER, name: 'Someone else', user_role: 'admin', subscribers_count: 5000 }

test('test-post with both ids set but swapped refuses: the TEST POST never reaches the real followers', async (t) => {
  // WHAPI_CHANNEL_ID holds the test channel's id and WA_TEST_CHANNEL_ID the real one's.
  const h = await harness(t, { routes: { ...byId(REAL, TESTING), ...listed(REAL, TESTING) } })
  assert.equal(await runTestPost({ env: h.env({ WHAPI_CHANNEL_ID: TEST_CHANNEL, WA_TEST_CHANNEL_ID: CHANNEL }), deps: h.deps }), false)
  assert.equal(h.wa.posts().length, 0)
  assert.match(h.lines.join('\n'), /swapped/)
  assert.deepEqual(leaks(h.lines.join('\n')), [])
  // The right way round, it posts to the test channel, and only there.
  const right = await harness(t, { routes: { ...byId(REAL, TESTING), ...listed(REAL, TESTING) } })
  assert.equal(await runTestPost({ env: right.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: right.deps }), true)
  assert.deepEqual(right.wa.posts().map((p) => p.body.to), [TEST_CHANNEL, TEST_CHANNEL])
  // A test channel nobody follows reaches nobody, whichever id it is: allowed,
  // so a new real channel with no followers yet can still be tested.
  const empty = await harness(t, { routes: byId({ ...REAL, subscribers_count: 0 }, { ...TESTING, subscribers_count: 0 }) })
  assert.equal(await runTestPost({ env: empty.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: empty.deps }), true)
  // Whapi giving no counts: the two ids differ and both were checked, as before.
  const blind = await harness(t, { routes: byId({ ...REAL, subscribers_count: undefined }, { ...TESTING, subscribers_count: undefined }) })
  assert.equal(await runTestPost({ env: blind.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: blind.deps }), true)
})

test('test-post with WHAPI_CHANNEL_ID set refuses when the linked number owns the real channel, or is no admin of it', async (t) => {
  // The test channel made by someone else, the owner's own number linked.
  const h = await harness(t, { routes: byId({ ...REAL, user_role: 'owner' }, TESTING) })
  assert.equal(await runTestPost({ env: h.env({ WA_TEST_CHANNEL_ID: TEST_CHANNEL }), deps: h.deps }), false)
  assert.equal(h.wa.posts().length, 0)
  assert.match(h.lines.join('\n'), /OWNER/)
  // Two mistakes at once: WHAPI_CHANNEL_ID a channel that does not exist, and
  // the real id in WA_TEST_CHANNEL_ID. No counts to compare, so the real
  // channel has to be one this number admins, as a real post needs.
  const typo = await harness(t, { routes: { ...byId(REAL, TESTING), ...listed(REAL, TESTING) } })
  assert.equal(await runTestPost({ env: typo.env({ WHAPI_CHANNEL_ID: OTHER, WA_TEST_CHANNEL_ID: CHANNEL }), deps: typo.deps }), false)
  assert.equal(typo.wa.posts().length, 0)
  assert.match(typo.lines.join('\n'), /Refused: WHAPI_CHANNEL_ID: The linked number is not an admin of the channel \(the channel was not found\)/)
  assert.deepEqual(leaks(typo.lines.join('\n')), [])
})

test('a swapped test id never sends real windows to the test channel either: paused', async (t) => {
  // No WHAPI_CHANNEL_ID, WA_TEST_CHANNEL_ID set to the REAL channel: left out,
  // the test channel would look like the one to post to.
  const h = await harness(t, { env: { ...FIND, WA_TEST_CHANNEL_ID: CHANNEL }, routes: listed(REAL, TESTING) })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.equal(h.wa.posts().length, 0)
  assert.equal(res.paused, 'test-swapped')
  assert.match(h.github.opened()[0].body, /WA_TEST_CHANNEL_ID may be the real channel/)
  assert.deepEqual(leaks(h.published()), [])
  // check says so too, and names what the test id points at.
  const c = await harness(t, { env: { ...FIND, WA_TEST_CHANNEL_ID: CHANNEL }, routes: listed(REAL, TESTING) })
  assert.equal(await runCheck({ env: c.env(), deps: c.deps }), false)
  assert.match(c.lines.join('\n'), /channel: none picked\. WA_TEST_CHANNEL_ID may be the real channel[\s\S]*^test channel: "CCBuddy Deals", this number's role: admin$/m)
  assert.deepEqual(leaks(c.lines.join('\n')), [])
  // Counts that do not say so (equal, or missing) are no reason to stop.
  for (const testing of [{ ...TESTING, subscribers_count: 230 }, { ...TESTING, subscribers_count: undefined }]) {
    const ok = await harness(t, { env: { ...FIND, WA_TEST_CHANNEL_ID: TEST_CHANNEL }, routes: listed(REAL, testing) })
    assert.ok((await ok.run(edge(quietFeed(), liveFeed(W1), NOW))).posted)
    assert.deepEqual(ok.wa.posts().map((p) => p.body.to), [CHANNEL])
  }
})

test("the end is edited only in the Channel its post went to, never in the one found or set since", async (t) => {
  let channels = [REAL]
  const routes = { 'GET /newsletters': () => ({ body: { newsletters: channels, count: 100, total: channels.length, offset: 0 } }) }
  const h = await harness(t, { env: FIND, routes })
  const open = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.deepEqual(h.wa.posts().map((p) => p.body.to), [CHANNEL])
  // Mid-window the spare number stopped being an admin there and is one somewhere else.
  channels = [{ ...REAL, user_role: 'subscriber' }, STRANGER]
  const res = await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 20)))
  assert.equal(res.edited, null)
  assert.equal(h.wa.posts().length, 1, 'no edit sent to the other Channel')
  assert.match(h.lines.join('\n'), /its post was made in another Channel, or under another Whapi token, than this run's; not editing it/)
  assert.deepEqual(leaks(h.published()), [])
  // The same Channel, found again or now pinned by WHAPI_CHANNEL_ID: edited there.
  channels = [REAL]
  for (const env of [{}, { WHAPI_CHANNEL_ID: CHANNEL }]) {
    const again = await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 20)), env)
    assert.equal(again.edited, (await readLedger(h.dir, open.posted)).messageId)
  }
  // Pinned to another Channel since the post: not edited there.
  const pinned = await h.run(edge(liveTill(W1, W1_END), ended(liveFeed(W1), W1_END), after(W1_END, 20)), { WHAPI_CHANNEL_ID: OTHER })
  assert.equal(pinned.edited, null)
  assert.deepEqual(h.wa.posts().filter((p) => p.body.edit).map((p) => p.body.to), [CHANNEL, CHANNEL])
  // The ledger, kept in the Actions cache, never holds the channel id.
  const raw = await readFile(join(h.dir, `${open.posted}.json`), 'utf8')
  assert.deepEqual(leaks(raw), [])
})

test("an owner is an owner however Whapi spells it, in either field", async (t) => {
  for (const mine of [
    { ...MINE, user_role: 'OWNER' },
    { ...MINE, user_role: ' owner ' },
    { ...MINE, user_role: '', role: 'owner' },
    { ...MINE, user_role: 'admin', role: 'owner' },
    { ...MINE, user_role: 'Creator' },
  ]) {
    const h = await harness(t, { env: FIND, routes: listed(REAL, mine) })
    const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
    assert.equal(h.wa.posts().length, 0, JSON.stringify(mine))
    assert.equal(res.paused, 'owner-linked', JSON.stringify(mine))
  }
  // With WHAPI_CHANNEL_ID set: "creator" is the owner there too, not "not an admin".
  for (const role of ['creator', 'OWNER']) {
    const h = await harness(t, { routes: byId({ ...REAL, user_role: role }) })
    assert.equal((await h.run(edge(quietFeed(), liveFeed(W1), NOW))).paused, 'owner-linked', role)
    assert.equal(h.wa.posts().length, 0)
    const c = await harness(t, { routes: byId({ ...REAL, user_role: role }) })
    assert.equal(await runCheck({ env: c.env(), deps: c.deps }), false)
    assert.match(c.lines.join('\n'), /OWNER number is linked/)
  }
  // An admin spelled in capitals is still an admin.
  const caps = await harness(t, { env: FIND, routes: listed({ ...REAL, user_role: 'ADMIN' }) })
  assert.ok((await caps.run(edge(quietFeed(), liveFeed(W1), NOW))).posted)
})

test('a channel listed twice is still one channel', async (t) => {
  const h = await harness(t, { env: FIND, routes: listed(REAL, { ...REAL }, FOLLOWED) })
  const res = await h.run(edge(quietFeed(), liveFeed(W1), NOW))
  assert.ok(res.posted)
  assert.deepEqual(h.wa.posts().map((p) => p.body.to), [CHANNEL])
})

test('the channel list failing: 401 ridden out, 429 never retried and paused, 5xx fails the run', async (t) => {
  const no = (status) => ({ status, body: { error: { code: status, message: `nope ${CHANNEL} ${LINKED_NUMBER}` } } })
  // 401, 401, then the list: posts.
  const flaky = await harness(t, { env: FIND, routes: { 'GET /newsletters': [no(401), no(401), listed(REAL)['GET /newsletters']] } })
  assert.ok((await flaky.run(edge(quietFeed(), liveFeed(W1), NOW))).posted)
  assert.equal(flaky.wa.requests.filter((r) => r.route === 'GET /newsletters').length, 3)
  // 401 for good: four tries, paused, nothing posted.
  const dead = await harness(t, { env: FIND, routes: { 'GET /newsletters': no(401) } })
  assert.equal((await dead.run(edge(quietFeed(), liveFeed(W1), NOW))).paused, 'unauthorised')
  assert.equal(dead.wa.requests.filter((r) => r.route === 'GET /newsletters').length, 4)
  assert.equal(dead.wa.posts().length, 0)
  // 429: one try, no waiting, paused with the rest date.
  const banned = await harness(t, { env: FIND, routes: { 'GET /newsletters': no(429) } })
  assert.equal((await banned.run(edge(quietFeed(), liveFeed(W1), NOW))).paused, 'soft-ban')
  assert.equal(banned.wa.requests.filter((r) => r.route === 'GET /newsletters').length, 1)
  assert.equal(banned.wa.posts().length, 0)
  assert.deepEqual(banned.slept, [])
  // 5xx: one try, the run fails, no pause, nothing recorded.
  const down = await harness(t, { env: FIND, routes: { 'GET /newsletters': no(503) } })
  await assert.rejects(down.run(edge(quietFeed(), liveFeed(W1), NOW)), /Whapi channels: HTTP 503/)
  assert.equal(down.wa.requests.filter((r) => r.route === 'GET /newsletters').length, 1)
  assert.equal(down.wa.posts().length, 0)
  assert.equal(down.github.opened().length, 0)
  assert.equal(await readLedger(down.dir, `BLINKDEAL6-${Date.parse(W1)}`), null)
  for (const x of [flaky, dead, banned, down]) assert.deepEqual(leaks(x.published()), [])
})

test('test-post on a 429 pauses the poster, so the next window does not try again', async (t) => {
  const no = { status: 429, body: { error: { code: 429, message: 'Too many requests' } } }
  for (const [env, routes] of [
    [{ WA_TEST_CHANNEL_ID: TEST_CHANNEL }, { 'POST /messages/text': no }],
    [{ ...FIND, WA_TEST_CHANNEL_ID: TEST_CHANNEL }, { 'GET /newsletters': no }],
  ]) {
    const h = await harness(t, { routes })
    assert.equal(await runTestPost({ env: h.env(env), deps: h.deps }), false)
    assert.ok(h.wa.posts().length <= 1, 'never retried')
    assert.match(h.github.opened()[0]?.body ?? '', /429/)
    // The window that follows calls nothing.
    const before = h.wa.requests.length
    assert.equal((await h.run(edge(quietFeed(), liveFeed(W1), NOW))).paused, 'already')
    assert.equal(h.wa.requests.length, before)
  }
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
  // The token set and no channel id, as he will set it up: still dry until WA_DRY_RUN is 0.
  const d = await run(process.execPath, [script, '--post', '--edge-file', files.edge], { env: { ...env, WHAPI_TOKEN: TOKEN, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1' } })
  assert.match(d.stdout, /DRY RUN: the repo variable WA_DRY_RUN is not 0/)
  assert.ok(!d.stdout.includes(TOKEN))
  assert.equal(wa.requests.length, 0)
  assert.doesNotMatch(await readFile(files.out, 'utf8'), /posted_key/)
})

test('the posting step gets the test channel too, so a test channel the spare number admins is left out of the search', async () => {
  const yml = (await readFile(join(HERE, '..', '.github', 'workflows', 'wa-post.yml'), 'utf8')).replace(/\r\n/g, '\n')
  const start = yml.indexOf('      - name: Post\n')
  const end = yml.indexOf('      - name: Remember the post', start)
  assert.ok(start > 0 && end > start, 'the Post step is where it was')
  const step = yml.slice(start, end)
  for (const name of ['WHAPI_TOKEN', 'WHAPI_CHANNEL_ID', 'WA_TEST_CHANNEL_ID']) {
    assert.match(step, new RegExp(`^ +${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, 'm'), name)
  }
  // A variable is printed in clear in the step's log, which is public.
  assert.doesNotMatch(yml, /vars\.(WHAPI|WA_TEST)/)
})

test('BLINKDEAL60 with no measured discount posts no percentage', () => {
  const sixty = liveFeed(W1, {
    code: 'BLINKDEAL60', discountPct: null,
    lastLive: { code: 'BLINKDEAL60', couponId: '135733', from: W1, skuCount: 12 },
  })
  const data = postData(sixty)
  assert.equal(data.pct, null)
  assert.equal(renderOpen(data).split('\n')[0], 'BLINKDEAL60 live on Myntra')
})
