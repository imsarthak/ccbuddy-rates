// Channel posts: the templates, and the promise that each window posts
// exactly once on open and once on close whatever the ticks in between do.
// The opening goes out at first sight and is edited, at the coupon's first
// page, into the full post.
//
//   node --test scraper/channel-posts.test.mjs
//
// Nothing here touches the network: detect and the senders are injected, and
// where the real postWindow runs, Telegram is a local fake on 127.0.0.1
// (test-fakes.mjs) and fetch refuses every other host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  composePost, formatDuration, applyEnv, cheapestPerGram, buttonAction, intentArgs, postWindow, telegramRecord,
  APP_LINK, TEMPLATES, INTENT_ACTION, TASKER_PACKAGE, TERMUX_BIN, TG_OPEN_PATH, TG_ADOPT_MAX_AGE_MS, TG_EDIT_RETRIES, TG_EDIT_RETRY_GAP_MS, TG_SIGHT_GRACE_MS,
} from './notify.mjs'
import { step, inferDiscountPct } from './blinkdeal.mjs'
import { ADOPT_MAX_AGE_MS, EDIT_RETRIES, EDIT_RETRY_GAP_MS } from './wa-phone.mjs'
import { fakeTelegram, fakePost } from './test-fakes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'live-window-2026-09-15.json'), 'utf8'))
const run = promisify(execFile)

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const host = new URL(String(url)).hostname
  if (host !== '127.0.0.1') throw new Error(`a test tried to reach ${host}`)
  return realFetch(url, init)
}

test('open post carries code, discount, count, cheapest ₹/g, coupon page and app link', () => {
  const text = composePost('open', { ...fixture, discountPct: inferDiscountPct(fixture.code, fixture.skus) })
  const lines = text.split('\n')
  assert.equal(lines[0], 'BLINKDEAL6 live on Myntra — 6% off gold coins')
  assert.equal(lines[1], '207 coins covered')
  const best = cheapestPerGram(fixture.skus)
  assert.match(lines[2], /^Best: ₹[\d,]+\/g \(.+ [\d.]+g\)$/)
  assert.ok(lines[2].includes(best.pg.toLocaleString('en-IN')))
  assert.equal(lines[3], fixture.source)
  assert.equal(lines[4], APP_LINK)
  assert.equal(lines.length, 5)
})

test('open post drops lines it has no data for, never prints null', () => {
  const text = composePost('open', { code: 'BLINKDEAL', skus: [], source: null })
  assert.equal(text, `BLINKDEAL live on Myntra\n${APP_LINK}`)
  assert.ok(!/null|undefined|NaN/.test(text))
})

test('close post carries duration and coin count', () => {
  const text = composePost('close', {
    code: 'BLINKDEAL6',
    from: '2026-09-16T11:30:43.347Z',
    to: '2026-09-16T12:06:16.538Z',
    maxSkus: 211,
  })
  assert.equal(text, `BLINKDEAL6 is over — lasted 36 min, 211 coins\n${APP_LINK}`)
})

test('formatDuration never shows seconds and rolls into hours', () => {
  assert.equal(formatDuration(36 * 60000 - 20000), '36 min')
  assert.equal(formatDuration(0), '0 min')
  assert.equal(formatDuration(65 * 60000), '1 h 05 min')
  assert.equal(formatDuration(-5000), '0 min')
})

test('every follower-facing string is in TEMPLATES', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), [
    'button', 'close', 'closeTitle', 'open', 'openTitle',
    // the WhatsApp Channel, scraper/wa-post.mjs
    'waOpen', 'waOver', 'waRow', 'waTest',
  ])
  assert.equal(TEMPLATES.button, 'Post to channel')
})

test('the button action sets PATH itself, pipes the text on stdin, then opens the channel', () => {
  const cmd = buttonAction("it's live\nline 2", 'https://whatsapp.com/channel/abc')
  assert.equal(TERMUX_BIN, '/data/data/com.termux/files/usr/bin')
  assert.ok(cmd.startsWith(`export PATH=${TERMUX_BIN}:$PATH && `), 'the phone default must be the Termux bin')
  assert.ok(cmd.includes("| termux-clipboard-set && termux-open-url 'https://whatsapp.com/channel/abc'"))
  assert.ok(cmd.includes(`'it'\\''s live\nline 2'`), 'single quotes inside the text are escaped for sh')
})

// Run the real command under a real sh with stub termux-* commands, so the
// quoting is proven rather than eyeballed. The stub bin is passed as binDir,
// NOT prepended to the environment's PATH: the command exports its own PATH
// first, so an environment prefix loses to it. On Termux that meant the REAL
// termux-clipboard-set ran — it overwrote the phone's clipboard and opened the
// fake URL, and the stub file this asserts on never appeared (caught on
// Sarthak's phone, 2026-09-21).
test('the button action delivers the post byte-for-byte to the clipboard and the URL to the opener', async (t) => {
  let sh
  try {
    // Absolute path, because the stubs need a shebang that works here: on
    // Termux there is no /bin/sh, and on Windows sh lives under the msys root.
    sh = (await run('sh', ['-c', 'command -v sh'])).stdout.trim()
  } catch {
    sh = ''
  }
  if (!sh) return t.skip('no sh on this machine')
  // What sh sees: on Windows a `C:/…` path cannot go in a colon-separated
  // PATH, so hand msys its own form. On the phone this is already a no-op.
  const shPath = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
  const dir = await mkdtemp(join(tmpdir(), 'ccbuddy-btn-'))
  const clip = shPath(join(dir, 'clip.txt'))
  const opened = shPath(join(dir, 'url.txt'))
  for (const [name, body] of [
    ['termux-clipboard-set', `#!${sh}\ncat > '${clip}'\n`],
    ['termux-open-url', `#!${sh}\nprintf '%s' "$1" > '${opened}'\n`],
  ]) {
    await writeFile(join(dir, name), body)
    await chmod(join(dir, name), 0o755)
  }
  const text = composePost('open', { ...fixture, discountPct: 6 }) + "\nit's ₹ & \"quotes\" $HOME `x`"
  const url = 'https://whatsapp.com/channel/0029VaTest'
  const cmd = buttonAction(text, url, { binDir: shPath(dir) })
  await run('sh', ['-c', cmd])
  assert.equal(await readFile(join(dir, 'clip.txt'), 'utf8'), text)
  assert.equal(await readFile(join(dir, 'url.txt'), 'utf8'), url)
})

test('environment overrides the config file without touching other channels', () => {
  const cfg = { telegram: { token: 'file', chatId: '1' }, sms: { to: '+91' } }
  const out = applyEnv(cfg, { BLINKDEAL_TELEGRAM_CHANNEL: '@test_channel' })
  assert.deepEqual(out.telegram, { token: 'file', chatId: '1', channelId: '@test_channel' })
  assert.deepEqual(out.sms, cfg.sms)
  assert.deepEqual(applyEnv(cfg, {}), cfg)
  assert.equal(applyEnv({}, { BLINKDEAL_TELEGRAM_TOKEN: 't' }).telegram.token, 't')
  const wa = applyEnv({}, { BLINKDEAL_WHATSAPP_CHANNEL_URL: 'https://whatsapp.com/channel/x', BLINKDEAL_WHATSAPP_AUTOPOST: '1' })
  assert.deepEqual(wa.whatsappChannel, { url: 'https://whatsapp.com/channel/x', autopost: true })
  assert.equal(applyEnv({ whatsappChannel: { autopost: true } }, { BLINKDEAL_WHATSAPP_AUTOPOST: '0' }).whatsappChannel.autopost, false)
})

test('autopost is off unless the config says so', () => {
  assert.notEqual(applyEnv({}, {}).whatsappChannel?.autopost, true)
  assert.notEqual(applyEnv({ whatsappChannel: { url: 'x' } }, {}).whatsappChannel.autopost, true)
})

test('the Tasker intent is the documented action, package and extras, in that order', () => {
  const args = intentArgs('open', { code: 'BLINKDEAL6', text: 'line 1\nline 2', url: 'https://whatsapp.com/channel/abc' }, { user: undefined })
  assert.equal(INTENT_ACTION, 'app.ccbuddy.blinkdeal.POST')
  assert.equal(TASKER_PACKAGE, 'net.dinglisch.android.taskerm')
  assert.deepEqual(args, [
    'broadcast', '--user', '0',
    '-a', 'app.ccbuddy.blinkdeal.POST',
    '-p', 'net.dinglisch.android.taskerm',
    '--es', 'kind', 'open',
    '--es', 'code', 'BLINKDEAL6',
    '--es', 'text', 'line 1\nline 2',
    '--es', 'url', 'https://whatsapp.com/channel/abc',
  ])
  // Every extra name is what Tasker will accept unchanged: lower-case, 3+ chars.
  for (const name of ['kind', 'code', 'text', 'url']) assert.match(name, /^[a-z]{3,}$/)
  assert.equal(intentArgs('close', { code: 'X', text: 't', url: 'u' }, { user: '10' })[2], '10')
  assert.equal(intentArgs('close', { code: 'X', text: 't', url: 'u' }, { user: 'junk' })[2], '0')
  assert.equal(intentArgs('close', { code: 'X', text: 't', url: 'u' }, { pkg: 'com.example' })[6], 'com.example')
})

// A fake detect that behaves like the real one: fires the two hooks when the
// window is live, returns the shape step() expects.
const LIVE = {
  live: true,
  code: 'BLINKDEAL6',
  couponId: '135733',
  discountPct: 6,
  source: fixture.source,
  totalCount: 207,
  skus: fixture.skus,
  knownIds: ['135733'],
}
const QUIET = { live: false, knownIds: ['135733'] }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * A fake detect that behaves like the real one: fires the two hooks when the
 * window is live, returns the shape step() expects. `firstPageMs` delays the
 * first page; `failFirstPage` fires onLive, then throws as a failed fetch of
 * the coupon's page does.
 */
const fakeDetect = (result, { firstPageMs = 0, failFirstPage = false, events } = {}) => async (previous, onLive, onFirstPage) => {
  if (result instanceof Error) throw result
  if (result.live) {
    await onLive({ code: result.code, couponId: result.couponId, source: result.source, skus: result.skus.slice(0, 3) })
    events?.push(['sight', Date.now()])
    if (firstPageMs) await pause(firstPageMs)
    if (failFirstPage) throw new Error(`HTTP 503 for ${result.source}`)
    events?.push(['first page', Date.now()])
    await onFirstPage({ code: result.code, couponId: result.couponId, source: result.source, totalCount: result.totalCount, skus: result.skus.slice(0, 12) })
    events?.push(['crawl', Date.now()])
  }
  return result
}
const kinds = (posts) => posts.map((p) => `${p.kind}${p.stage ? `/${p.stage}` : ''}`)

test('one opening (sent at first sight, filled in at the first page) and one close per window, whatever the ticks between do', async () => {
  const posts = []
  const alerts = []
  const deps = {
    notify: async (text) => (alerts.push(text), { telegram: 'sent' }),
    post: fakePost(posts),
  }
  const run = async (previous, result) => {
    const { next, closedWindow } = await step(previous, { ...deps, detect: fakeDetect(result) })
    return { next: next ?? previous, closedWindow }
  }
  const stale = (feed) => ({ ...feed, checkedAt: '2000-01-01T00:00:00.000Z' })

  let feed = { generated: 'x', checkedAt: new Date().toISOString(), ok: true, live: false, knownIds: [] }
  ;({ next: feed } = await run(feed, QUIET)) // quiet → quiet
  assert.equal(posts.length, 0)

  ;({ next: feed } = await run(feed, LIVE)) // OPEN edge
  assert.deepEqual(kinds(posts), ['open/sight', 'open/local', 'open/full'])
  // At sight: the code, the discount from the plain listing's coins, the coupon page. No coins, no count.
  assert.deepEqual(posts[0].w.skus, [])
  assert.equal(posts[0].w.totalCount, null)
  assert.equal(posts[0].w.discountPct, inferDiscountPct(LIVE.code, LIVE.skus.slice(0, 3)))
  assert.equal(posts[0].w.source, LIVE.source)
  // At the first page: the notification and Tasker, and the Telegram edit, from the coupon's own page.
  for (const p of posts.slice(1)) {
    assert.equal(p.w.totalCount, 207)
    assert.equal(p.w.discountPct, 6)
    assert.equal(p.w.skus.length, 12)
  }
  assert.equal(alerts.length, 1)
  assert.ok(feed.postedAt)
  assert.ok(feed.alertedAt)

  ;({ next: feed } = await run(feed, LIVE)) // live, same SKUs: no rewrite
  ;({ next: feed } = await run(stale(feed), LIVE)) // live heartbeat rewrite
  assert.equal(posts.length, 3, 'heartbeat rewrite must not repost')

  ;({ next: feed } = await run(feed, new Error('HTTP 500'))) // failed read mid-window
  assert.equal(feed.live, true)
  assert.equal(feed.ok, false)
  ;({ next: feed } = await run(feed, LIVE)) // recovers
  assert.equal(posts.length, 3, 'a failed read must not repost on recovery')

  let closed
  ;({ next: feed, closedWindow: closed } = await run(feed, QUIET)) // CLOSE edge
  assert.deepEqual(kinds(posts), ['open/sight', 'open/local', 'open/full', 'close'])
  assert.equal(posts[3].w.code, 'BLINKDEAL6')
  assert.equal(posts[3].w.maxSkus, fixture.skus.length)
  assert.ok(posts[3].w.from && posts[3].w.to)
  assert.ok(closed.postedAt)

  ;({ next: feed } = await run(feed, QUIET))
  ;({ next: feed } = await run(stale(feed), QUIET)) // quiet heartbeat rewrite
  assert.equal(posts.length, 4, 'quiet ticks after the close must not repost')

  ;({ next: feed } = await run(feed, LIVE)) // a NEW window, same code
  assert.deepEqual(kinds(posts).slice(4), ['open/sight', 'open/local', 'open/full'])
  assert.equal(alerts.length, 2)
})

test('a code change mid-window posts the new code once, from its first page, and does not close the old one', async () => {
  const posts = []
  const alerts = []
  const deps = { notify: async (text) => (alerts.push(text), {}), post: fakePost(posts) }
  let feed = { checkedAt: new Date().toISOString(), ok: true, live: false, knownIds: [] }
  feed = (await step(feed, { ...deps, detect: fakeDetect(LIVE) })).next
  // The plain listing names another code, and its coupon page fails: only the private alert, no post.
  const flicker = await step(feed, { ...deps, detect: fakeDetect({ ...LIVE, code: 'BLINKDEAL' }, { failFirstPage: true }) })
  assert.equal(posts.length, 3, 'nothing posted at sight for a code change')
  assert.equal(alerts.length, 2, 'the private alert as ever')
  assert.equal(flicker.next.live, true, 'the feed still says BLINKDEAL6 live')
  // Confirmed by its coupon page: posted whole at the first page, as before.
  feed = (await step(feed, { ...deps, detect: fakeDetect({ ...LIVE, code: 'BLINKDEAL' }) })).next
  assert.deepEqual(posts.map((p) => `${p.kind}/${p.stage} ${p.w.code}`), [
    'open/sight BLINKDEAL6',
    'open/local BLINKDEAL6',
    'open/full BLINKDEAL6',
    'open/local BLINKDEAL',
    'open/full BLINKDEAL',
  ])
  assert.equal(posts[4].w.totalCount, 207, 'the full post')
})

test('a post channel failing never fails the tick or loses the window', async () => {
  let feed = { checkedAt: new Date().toISOString(), ok: true, live: false, knownIds: [] }
  const deps = {
    notify: async () => ({}),
    post: async () => {
      throw new Error('telegram HTTP 403')
    },
  }
  const { next } = await step(feed, { ...deps, detect: fakeDetect(LIVE) })
  assert.equal(next.live, true)
  assert.equal(next.ok, true)
  assert.equal(next.postedAt, undefined)
})

test("the discount comes from the coins, never from the digits in the code", () => {
  assert.equal(inferDiscountPct('BLINKDEAL60', []), null, 'BLINKDEAL60 is 6%, not 60%')
  assert.equal(inferDiscountPct('BLINKDEAL60', [{ discount: 1000, price: 16652 }]), 6)
  assert.equal(inferDiscountPct('BLINKDEAL6', [{ discount: null, price: 16652 }]), null)
})

test('the discount counts only coins carrying the BLINK coupon', () => {
  // The 2026-09-28 opening tick: 111 coins on BLINKDEAL6, 100 on MYNTRA300.
  const blink = Array.from({ length: 111 }, () => ({ code: 'BLINKDEAL6', discount: 1000, price: 16652 }))
  const flat = Array.from({ length: 100 }, () => ({ code: 'MYNTRA300', discount: 300, price: 16652 }))
  assert.equal(inferDiscountPct('BLINKDEAL6', [...flat, ...blink]), 6)
  assert.equal(inferDiscountPct('BLINKDEAL6', [...flat, ...blink.slice(0, 40)]), 6)
  assert.equal(inferDiscountPct('BLINKDEAL6', flat), null)
  // A discount that rounds to 0% is no discount.
  const zero = Array.from({ length: 5 }, () => ({ code: 'BLINKDEAL6', discount: 50, price: 16652 }))
  assert.equal(inferDiscountPct('BLINKDEAL6', [...zero, blink[0]]), 6)
  assert.equal(inferDiscountPct('BLINKDEAL6', [{ code: 'BLINKDEAL6', discount: 0, price: 16652 }]), null)
  // Hand-built coins carry no code, or a null one; they still count.
  assert.equal(inferDiscountPct('BLINKDEAL6', [{ code: null, discount: 1000, price: 16652 }]), 6)
})

// ---- The Telegram opening through the real postWindow -------------------------------
//
// Telegram is a local fake (test-fakes.mjs); the notification and Tasker are a
// recorded exec. The record is shared by every tick of a test, as the phone's
// file is; it lives in memory here and never touches the phone's.

const TG_TOKEN = '123456:TEST-not-a-real-token_0123456789'
const TG_CFG = {
  telegram: { token: TG_TOKEN, chatId: '42', channelId: '@test_channel' },
  whatsappChannel: { url: 'https://whatsapp.com/channel/0029VaTest', autopost: true },
}
const MIN = 60000
const iso = (ms) => new Date(ms).toISOString()
const quietFeed = () => ({ generated: iso(Date.now() - MIN), checkedAt: iso(Date.now() - MIN), ok: true, live: false, knownIds: [] })
const staleFeed = (feed) => ({ ...feed, checkedAt: iso(Date.now() - 3 * MIN) })
/** What the plain listing knows, as step() hands it to the post. */
const sightOf = (r) => ({ code: r.code, couponId: r.couponId, source: r.source, discountPct: inferDiscountPct(r.code, r.skus.slice(0, 3)), skus: [], totalCount: null })
/** What the coupon's first page knows. */
const fullOf = (r) => {
  const skus = r.skus.slice(0, 12)
  return { code: r.code, couponId: r.couponId, source: r.source, totalCount: r.totalCount, skus, discountPct: inferDiscountPct(r.code, skus) }
}
const SIGHT_TEXT = composePost('open', sightOf(LIVE))
const FULL_TEXT = composePost('open', fullOf(LIVE))

async function channel(t, { routes = {}, cfg = TG_CFG, boundMs, record = telegramRecord(null) } = {}) {
  const tgf = await fakeTelegram(routes)
  t.after(() => tgf.close())
  const execs = []
  const exec = async (file, args) => (execs.push({ file, args, at: Date.now() }), { stdout: '', stderr: '' })
  const alerts = []
  const tick = async (previous, result, opt = {}) => {
    const r = await step(previous, {
      detect: fakeDetect(result, opt),
      notify: async (text) => (alerts.push(text), { telegram: 'sent' }),
      post: (kind, w, o) => postWindow(kind, w, { ...o, config: cfg, base: tgf.base, exec }),
      tgRecord: record,
      ...(boundMs ? { postBoundMs: boundMs } : {}),
    })
    return { ...r, feed: r.next ?? previous }
  }
  return {
    tgf, execs, alerts, record, tick,
    local: () => execs.filter((e) => e.file === 'termux-notification'),
    tasker: () => execs.filter((e) => e.file === 'am'),
  }
}

/** console.log and console.error, captured while `fn` runs. */
async function captured(fn) {
  const lines = []
  const [log, error] = [console.log, console.error]
  console.log = (...a) => lines.push(a.join(' '))
  console.error = (...a) => lines.push(a.join(' '))
  try {
    return { result: await fn(), text: lines.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

const pick = (o, ...keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]))

test('the opening at first sight says only what the plain listing knows: no count, no Best line, no new words', () => {
  assert.equal(SIGHT_TEXT, `BLINKDEAL6 live on Myntra — 6% off gold coins\n${LIVE.source}\n${APP_LINK}`)
  assert.equal(SIGHT_TEXT, TEMPLATES.open({ code: 'BLINKDEAL6', pct: 6, count: null, best: null, source: LIVE.source }))
  assert.match(FULL_TEXT, /^BLINKDEAL6 live on Myntra — 6% off gold coins\n207 coins covered\nBest: ₹/)
  // The close of an opening never published: the template's own "is over", with no length.
  assert.equal(composePost('close', { code: 'BLINKDEAL6', approx: true }), `BLINKDEAL6 is over\n${APP_LINK}`)
})

test('Telegram: sent at first sight, then edited in place with the same message id at the first page, then the close', async (t) => {
  const c = await channel(t)
  const events = []
  const { feed } = await c.tick(quietFeed(), LIVE, { firstPageMs: 150, events })
  const at = Object.fromEntries(events)
  const [sent] = c.tgf.sends()
  assert.equal(c.tgf.sends().length, 1)
  assert.deepEqual(sent.body, { chat_id: '@test_channel', text: SIGHT_TEXT, disable_web_page_preview: true })
  assert.ok(sent.at < at['first page'], 'it reached Telegram before the first page came')
  assert.equal(sent.token, TG_TOKEN, 'the bot token, in the path only')
  const [edit] = c.tgf.edits()
  assert.equal(c.tgf.edits().length, 1)
  assert.deepEqual(edit.body, { chat_id: '@test_channel', message_id: 101, text: FULL_TEXT, disable_web_page_preview: true })
  // The notification and Tasker cannot be edited: they carry the full post, once, at the first page.
  assert.equal(c.local().length, 1)
  assert.equal(c.tasker().length, 1)
  assert.ok(c.local()[0].args.includes(FULL_TEXT))
  assert.ok(c.tasker()[0].args.includes(FULL_TEXT))
  assert.ok(c.local()[0].at >= at['first page'])
  assert.equal(c.alerts.length, 1)
  assert.ok(feed.postedAt && feed.alertedAt)
  assert.deepEqual(pick(await c.record.read(), 'code', 'state', 'messageId', 'filled'), { code: 'BLINKDEAL6', state: 'sent', messageId: 101, filled: true })
  // Mid-window ticks: nothing.
  const beat = (await c.tick(staleFeed(feed), LIVE)).feed
  await c.tick(beat, new Error('HTTP 500'))
  assert.equal(c.tgf.requests.length, 2)
  // The end: the close post, and the record gone.
  const { closedWindow } = await c.tick(beat, QUIET)
  assert.equal(c.tgf.sends().length, 2)
  assert.equal(c.tgf.sends()[1].body.text, composePost('close', closedWindow))
  assert.equal(c.tgf.edits().length, 1)
  assert.equal(await c.record.read(), null)
  await c.tick(quietFeed(), QUIET)
  assert.equal(c.tgf.requests.length, 3, 'quiet ticks after it: nothing')
})

test('Telegram: "message is not modified" counts as the edit made', async (t) => {
  const c = await channel(t, { routes: { editMessageText: { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' } } } })
  const { text, result } = await captured(() => c.tick(quietFeed(), LIVE))
  assert.match(text, /^POST open filled in .*telegramChannel:edited/m)
  assert.match(text, /^POST open filled in .*local:sent\+button/m)
  assert.match(text, /^POST open filled in .*tasker:broadcast/m)
  assert.equal(c.tgf.sends().length, 1)
  assert.ok(result.feed.postedAt)
})

test('Telegram: a failed edit costs the tick nothing; later live reads make it, 3 tries at most, 20 s apart; a 4xx (not 429) ends them; never a second message', async (t) => {
  const NOT_FOUND = { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' } }
  for (const answer of [NOT_FOUND, { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } }, { hang: true }]) {
    const c = await channel(t, { routes: { editMessageText: answer }, boundMs: 300 })
    const started = Date.now()
    const { text, result } = await captured(() => c.tick(quietFeed(), LIVE, { firstPageMs: 20 }))
    const took = Date.now() - started
    const what = JSON.stringify(answer)
    assert.ok(took < 300 + 800, `${what}: the tick took ${took} ms`)
    assert.equal(result.next.live, true, what)
    assert.equal(result.next.ok, true)
    assert.ok(result.next.postedAt, `${what}: the post at sight went out`)
    assert.equal(c.tgf.sends().length, 1, `${what}: never sent a second time`)
    assert.equal(c.tgf.edits().length, 1)
    assert.equal(c.local().length, 1, `${what}: the notification and Tasker as ever`)
    assert.equal(c.tasker().length, 1)
    assert.match(text, /telegramChannel:failed: telegram[: ]/)
    if (answer.hang) assert.match(text, /telegramChannel:failed: telegram: no answer \(timed out\)/, 'cut off at the bound')
    assert.deepEqual(pick(await c.record.read(), 'state', 'filled', 'edited'), { state: 'sent', filled: true, edited: false })
    // The window's later live ticks. `back` moves the last try 20 s into the past.
    const back = async () => {
      const r = await c.record.read()
      if (r.retry?.lastTry) await c.record.replace({ ...r, retry: { ...r.retry, lastTry: r.retry.lastTry - TG_EDIT_RETRY_GAP_MS } })
    }
    let feed = result.feed
    if (answer === NOT_FOUND) {
      assert.equal((await c.record.read()).retry.refused, true)
      for (let i = 0; i < 3; i++) {
        feed = (await c.tick(staleFeed(feed), LIVE)).feed
        await back()
      }
      assert.equal(c.tgf.requests.length, 2, `${what}: never tried again`)
      continue
    }
    const s2 = Date.now()
    feed = (await c.tick(staleFeed(feed), LIVE)).feed
    assert.ok(Date.now() - s2 < 300 + 800, `${what}: a try is cut at its bound`)
    assert.equal(c.tgf.edits().length, 2, `${what}: the next live tick tries again`)
    feed = (await c.tick(staleFeed(feed), LIVE)).feed
    assert.equal(c.tgf.edits().length, 2, `${what}: not before 20 s`)
    for (let i = 2; i <= TG_EDIT_RETRIES; i++) {
      await back()
      feed = (await c.tick(staleFeed(feed), LIVE)).feed
      assert.equal(c.tgf.edits().length, 1 + i, what)
    }
    await back()
    await c.tick(staleFeed(feed), LIVE)
    assert.equal(c.tgf.edits().length, 1 + TG_EDIT_RETRIES, `${what}: then it stops`)
    assert.deepEqual(new Set(c.tgf.edits().map((r) => r.body.message_id)), new Set([101]), 'always the post at sight')
    assert.equal(c.tgf.sends().length, 1, `${what}: never a second message`)
    assert.deepEqual([c.local().length, c.tasker().length], [1, 1])
    assert.equal((await c.record.read()).retry.tries, TG_EDIT_RETRIES)
  }
})

test('Telegram: an edit that fails once is made on the next live tick, from the full crawl, and then never again', async (t) => {
  const c = await channel(t, { routes: { editMessageText: [{ status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } }, { body: { ok: true, result: true } }] } })
  const { feed } = await c.tick(quietFeed(), LIVE)
  const { result, text } = await captured(() => c.tick(staleFeed(feed), LIVE))
  assert.equal(c.tgf.sends().length, 1)
  assert.deepEqual(c.tgf.edits().map((r) => r.body), [
    { chat_id: '@test_channel', message_id: 101, text: FULL_TEXT, disable_web_page_preview: true },
    { chat_id: '@test_channel', message_id: 101, text: composePost('open', result.next), disable_web_page_preview: true },
  ])
  assert.match(text, /^POST open filled in telegramChannel:edited .*\(on a later tick, try 1 of 3\)$/m)
  assert.deepEqual(pick(await c.record.read(), 'state', 'filled', 'edited'), { state: 'sent', filled: true, edited: true })
  let f = result.feed
  for (let i = 0; i < 3; i++) f = (await c.tick(staleFeed(f), LIVE)).feed
  assert.equal(c.tgf.requests.length, 3, 'made: nothing more')
  assert.deepEqual([c.local().length, c.tasker().length], [1, 1])
  // The same failure with the feed write lost: the next opening tick makes the edit, and nothing else.
  const d = await channel(t, { routes: { editMessageText: [{ status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } }, { body: { ok: true, result: true } }] } })
  await d.tick(quietFeed(), LIVE)
  await d.tick(quietFeed(), LIVE)
  assert.equal(d.tgf.sends().length, 1)
  assert.deepEqual(d.tgf.edits().map((r) => r.body.text), [FULL_TEXT, FULL_TEXT])
  assert.deepEqual([d.local().length, d.tasker().length], [2, 1], 'Tasker once; the notification put back over the alert')
  assert.equal((await d.record.read()).edited, true)
})

test('the notification and Tasker go at the first page, beside the Telegram post at sight, however long that takes', async (t) => {
  for (const send of [{ delay: 400, body: { ok: true, result: { message_id: 101 } } }, { hang: true }]) {
    const c = await channel(t, { routes: { sendMessage: send }, boundMs: 600 })
    const events = []
    const { feed } = await c.tick(quietFeed(), LIVE, { firstPageMs: 50, events })
    const at = Object.fromEntries(events)
    const what = JSON.stringify(send)
    assert.ok(c.local()[0].at - at['first page'] < 100, `${what}: the notification ${c.local()[0].at - at['first page']} ms after the first page`)
    assert.ok(c.tasker()[0].at - at['first page'] < 100, `${what}: and Tasker`)
    assert.ok(feed.postedAt)
    if (send.hang) {
      assert.equal(c.tgf.edits().length, 0, 'no answer to the send: no id to edit, and never sent twice')
      assert.equal(c.tgf.sends().length, 1)
      assert.deepEqual(pick(await c.record.read(), 'state', 'filled'), { state: 'unknown', filled: true })
    } else {
      assert.equal(c.tgf.edits().length, 1)
      assert.ok(c.tgf.edits()[0].at >= c.tgf.sends()[0].at + 400, 'the edit waits for the send to be answered')
      assert.deepEqual(pick(await c.record.read(), 'state', 'messageId', 'filled', 'edited'), { state: 'sent', messageId: 101, filled: true, edited: true })
    }
  }
})

test('Telegram: a sight post definitely not sent is sent whole, once, at the first page', async (t) => {
  const c = await channel(t, {
    routes: { sendMessage: [{ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: need administrator rights in the channel chat' } }, { body: { ok: true, result: { message_id: 555 } } }] },
  })
  const { feed } = await c.tick(quietFeed(), LIVE)
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, FULL_TEXT])
  assert.equal(c.tgf.edits().length, 0)
  assert.ok(feed.postedAt)
  assert.deepEqual(pick(await c.record.read(), 'state', 'messageId', 'filled'), { state: 'sent', messageId: 555, filled: true })
})

test('Telegram: a sight post that may have gone out (5xx) is never sent again nor edited; the notification and Tasker still go', async (t) => {
  const c = await channel(t, { routes: { sendMessage: [{ status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } }, { body: { ok: true, result: { message_id: 556 } } }] } })
  const { feed } = await c.tick(quietFeed(), LIVE)
  assert.equal(c.tgf.sends().length, 1)
  assert.equal(c.tgf.edits().length, 0)
  assert.equal(c.local().length, 1)
  assert.equal(c.tasker().length, 1)
  assert.equal((await c.record.read()).state, 'unknown')
  // Its end is the close post, as for any window.
  await c.tick(feed, QUIET)
  assert.equal(c.tgf.sends().length, 2)
  assert.match(c.tgf.sends()[1].body.text, /^BLINKDEAL6 is over/)
})

test('Telegram: no channel configured: nothing at sight, the notification and Tasker at the first page, once', async (t) => {
  const c = await channel(t, { cfg: { whatsappChannel: TG_CFG.whatsappChannel } })
  const { feed } = await c.tick(quietFeed(), LIVE)
  assert.equal(c.tgf.requests.length, 0)
  assert.equal(c.local().length, 1)
  assert.equal(c.tasker().length, 1)
  assert.ok(feed.postedAt)
  // A lost feed write: Tasker not again; the notification put back over the alert, which took its place.
  await c.tick(quietFeed(), LIVE)
  assert.equal(c.local().length, 2)
  assert.equal(c.tasker().length, 1)
})

test('Telegram: the first page fails, then the window is read live: no second post, the edit and Tasker once', async (t) => {
  const c = await channel(t)
  const { feed: failed } = await c.tick(quietFeed(), LIVE, { failFirstPage: true })
  assert.equal(failed.ok, false)
  assert.equal(failed.live, false, 'the feed never said live')
  assert.equal(c.tgf.sends().length, 1, 'the sight post went out')
  assert.deepEqual([c.tgf.edits().length, c.local().length, c.tasker().length], [0, 0, 0])
  assert.deepEqual(pick(await c.record.read(), 'state', 'messageId', 'filled'), { state: 'sent', messageId: 101, filled: false })
  const { text, result } = await captured(() => c.tick(failed, LIVE))
  assert.equal(c.tgf.sends().length, 1, 'not posted again')
  assert.equal(c.tgf.edits().length, 1)
  assert.deepEqual(c.tgf.edits()[0].body, { chat_id: '@test_channel', message_id: 101, text: FULL_TEXT, disable_web_page_preview: true })
  assert.equal(c.local().length, 1)
  assert.equal(c.tasker().length, 1)
  assert.equal(c.alerts.length, 2, 'the private alert repeats, as it always has')
  assert.ok(result.feed.postedAt)
  assert.match(text, /POST open: BLINKDEAL6 was posted at .* by an earlier tick that did not publish it; not posting it again/)
  // Three failed first pages, then live: still one post.
  const d = await channel(t)
  let f = quietFeed()
  for (let i = 0; i < 3; i++) f = (await d.tick(f, LIVE, { failFirstPage: true })).feed
  await d.tick(f, LIVE)
  assert.deepEqual([d.tgf.sends().length, d.tgf.edits().length, d.tasker().length], [1, 1, 1])
})

test('Telegram: the first page fails, then quiet reads: one "is over" with no length, on Telegram alone', async (t) => {
  for (const fails of [1, 3]) {
    const c = await channel(t)
    let f = quietFeed()
    for (let i = 0; i < fails; i++) f = (await c.tick(f, LIVE, { failFirstPage: true })).feed
    const { closedWindow, feed } = await c.tick(f, QUIET)
    assert.equal(closedWindow, null, 'no window was ever published, so none closes')
    assert.deepEqual(c.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, `BLINKDEAL6 is over\n${APP_LINK}`], `${fails} failed first pages`)
    assert.equal(c.local().length, 0, 'no notification or Tasker ever carried it')
    assert.equal(c.tasker().length, 0)
    assert.equal(await c.record.read(), null)
    await c.tick(feed, QUIET)
    await c.tick(staleFeed(feed), QUIET)
    assert.equal(c.tgf.sends().length, 2, 'once')
  }
})

test('Telegram: a restart between the sight and the first page: the next tick edits, never sends', async (t) => {
  const record = telegramRecord(null)
  await record.create({ v: 1, code: 'BLINKDEAL6', from: iso(Date.now() - 30000), state: 'sent', messageId: 555, filled: false, postedAt: iso(Date.now() - 30000) })
  const c = await channel(t, { record })
  await c.tick(quietFeed(), LIVE)
  assert.equal(c.tgf.sends().length, 0)
  assert.deepEqual(c.tgf.edits().map((r) => r.body.message_id), [555])
  assert.equal(c.tasker().length, 1)
  // Killed in the send itself: it may be out, with no id to edit. Nothing on Telegram; the rest once.
  const r2 = telegramRecord(null)
  await r2.create({ v: 1, code: 'BLINKDEAL6', from: null, state: 'sending', messageId: null, filled: false, postedAt: iso(Date.now() - 30000) })
  const d = await channel(t, { record: r2 })
  await d.tick(quietFeed(), LIVE)
  assert.equal(d.tgf.requests.length, 0)
  assert.deepEqual([d.local().length, d.tasker().length], [1, 1])
  // Over 2 hours old: not this window. Removed with no close, as a code change always was, and posted.
  const r3 = telegramRecord(null)
  await r3.create({ v: 1, code: 'BLINKDEAL6', from: null, state: 'sent', messageId: 554, filled: true, postedAt: iso(Date.now() - TG_ADOPT_MAX_AGE_MS - MIN) })
  const e = await channel(t, { record: r3 })
  await e.tick(quietFeed(), LIVE)
  assert.deepEqual(e.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT])
  assert.deepEqual(e.tgf.edits().map((r) => r.body.message_id), [101])
})

test('Telegram: a lost feed write after the first page: nothing posted on the next tick, the notification put back; quiet reads then end it once', async (t) => {
  const c = await channel(t)
  await c.tick(quietFeed(), LIVE) // posted and filled in; the feed write is lost
  const before = c.tgf.requests.length
  const { text, result: { feed } } = await captured(() => c.tick(quietFeed(), LIVE))
  assert.equal(c.tgf.requests.length, before, 'no post and no edit')
  assert.equal(c.tasker().length, 1, 'Tasker once')
  // This tick's alert, a notification under the same id, took the post's place: it is put back, button and all.
  assert.equal(c.local().length, 2)
  assert.deepEqual(c.local()[1].args, c.local()[0].args)
  assert.ok(c.local()[1].args.includes('--button1') && c.local()[1].args.includes(FULL_TEXT))
  assert.match(text, /^POST open: the notification put back, local:sent\+button at /m)
  assert.equal(feed.postedAt, undefined, 'nothing was posted on this tick')
  // Its end is the step's own close post.
  await c.tick(feed, QUIET)
  assert.equal(c.tgf.sends().length, 2)
  // Lost again, then quiet: the record still ends it once, with its notification and Tasker (they carried it).
  const d = await channel(t)
  await d.tick(quietFeed(), LIVE)
  await d.tick(quietFeed(), QUIET)
  assert.deepEqual(d.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, `BLINKDEAL6 is over\n${APP_LINK}`])
  assert.equal(d.tasker().length, 2)
  assert.equal(d.tasker()[1].args[d.tasker()[1].args.indexOf('kind') + 1], 'close')
})

test('Telegram: a code change replaces the record without a close, as before, and posts the new code whole at its first page, never at sight', async (t) => {
  const c = await channel(t)
  const { feed } = await c.tick(quietFeed(), LIVE)
  const B = { ...LIVE, code: 'BLINKDEAL', skus: LIVE.skus.map((s) => ({ ...s, code: 'BLINKDEAL' })) }
  // The plain listing names the other code for a moment and its page fails: nothing posted, nothing ended.
  const flicker = await c.tick(feed, B, { failFirstPage: true })
  assert.equal(c.tgf.requests.length, 2, 'no Telegram call at all')
  assert.equal(c.alerts.length, 2, 'the private alert as ever')
  assert.equal((await c.record.read()).code, 'BLINKDEAL6')
  // The next read shows BLINKDEAL6 again: not an opening, and its post untouched.
  await c.tick(flicker.feed, LIVE)
  assert.equal(c.tgf.requests.length, 2)
  assert.deepEqual(pick(await c.record.read(), 'code', 'state', 'messageId'), { code: 'BLINKDEAL6', state: 'sent', messageId: 101 })
  // The code really changes: posted whole at its first page, the notification and Tasker beside it.
  await c.tick(feed, B)
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, composePost('open', fullOf(B))])
  assert.equal(c.tgf.edits().length, 1)
  assert.deepEqual([c.local().length, c.tasker().length], [2, 2])
  assert.deepEqual(pick(await c.record.read(), 'code', 'state', 'messageId', 'filled', 'edited'), { code: 'BLINKDEAL', state: 'sent', messageId: 102, filled: true, edited: true })
})

test('Telegram: a lost feed write, then a code the plain listing names for a moment whose page fails: the opening is neither replaced nor posted again', async (t) => {
  const B = { ...LIVE, code: 'BLINKDEAL', skus: LIVE.skus.map((s) => ({ ...s, code: 'BLINKDEAL' })) }
  const c = await channel(t)
  await c.tick(quietFeed(), LIVE) // posted and filled in; the feed write is lost, so the feed on file stays quiet
  const before = await c.record.read()
  // The other code for one tick, its page failing. For the feed, an opening; for the record, a code change.
  const started = Date.now()
  const { text, result: flicker } = await captured(() => c.tick(quietFeed(), B, { failFirstPage: true }))
  assert.ok(Date.now() - started < 1000, 'the failed tick waits for no page')
  assert.equal(flicker.feed.ok, false)
  assert.equal(c.tgf.requests.length, 2, 'no Telegram call at all')
  assert.equal(c.alerts.length, 2, 'the private alert as ever')
  assert.deepEqual(await c.record.read(), before, 'the record as it was')
  assert.match(text, /^POST open: BLINKDEAL waits for its coupon page: BLINKDEAL6, posted at .*, is on record/m)
  // Again the next tick, then BLINKDEAL6 again: adopted, nothing sent or edited, the notification and Tasker once.
  const again = (await c.tick(flicker.feed, B, { failFirstPage: true })).feed
  const back = await captured(() => c.tick(again, LIVE))
  assert.equal(c.tgf.requests.length, 2, 'not posted again')
  assert.deepEqual([c.local().length, c.tasker().length], [2, 1], 'Tasker once; the notification put back over the alert')
  assert.equal(back.result.feed.postedAt, undefined, 'nothing was posted on this tick')
  assert.match(back.text, /POST open: BLINKDEAL6 was posted at .* by an earlier tick that did not publish it; not posting it again/)
  // Its end is the step's own close post, once.
  const { closedWindow } = await c.tick(back.result.feed, QUIET)
  assert.equal(closedWindow.code, 'BLINKDEAL6')
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, composePost('close', closedWindow)])
  assert.equal(await c.record.read(), null)
  // The same flicker, then a read with no window at all: one "is over" with no length; nothing for the other code.
  const d = await channel(t)
  await d.tick(quietFeed(), LIVE)
  const f = (await d.tick(quietFeed(), B, { failFirstPage: true })).feed
  await d.tick(f, QUIET)
  await d.tick(staleFeed(f), QUIET)
  assert.deepEqual(d.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, `BLINKDEAL6 is over\n${APP_LINK}`])
})

test('Telegram: a lost feed write, then another code confirmed by its own page: posted whole from that page, never at sight', async (t) => {
  const B = { ...LIVE, code: 'BLINKDEAL', skus: LIVE.skus.map((s) => ({ ...s, code: 'BLINKDEAL' })) }
  const c = await channel(t)
  await c.tick(quietFeed(), LIVE) // posted and filled in; the feed write is lost
  const events = []
  const { feed } = await c.tick(quietFeed(), B, { firstPageMs: 150, events })
  const at = Object.fromEntries(events)
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, composePost('open', fullOf(B))])
  assert.ok(c.tgf.sends()[1].at >= at['first page'], 'never at sight')
  assert.equal(c.tgf.edits().length, 1, 'the first window\'s fill-in only')
  assert.deepEqual([c.local().length, c.tasker().length], [2, 2], 'the notification and Tasker beside it')
  assert.ok(feed.postedAt)
  assert.deepEqual(pick(await c.record.read(), 'code', 'state', 'messageId', 'filled', 'edited'), { code: 'BLINKDEAL', state: 'sent', messageId: 102, filled: true, edited: true })
  // BLINKDEAL6 got its page (filled in): a code change, so no "is over" for it, as at any code change.
})

test('Telegram: a code posted at first sight whose page fails, then another code confirmed by its own page: the first is told over, on Telegram alone, beside the new opening', async (t) => {
  const A = { ...LIVE, code: 'BLINKDEAL', skus: LIVE.skus.map((s) => ({ ...s, code: 'BLINKDEAL' })) }
  const SIGHT_A = composePost('open', sightOf(A))
  const OVER_A = `BLINKDEAL is over\n${APP_LINK}`
  const c = await channel(t)
  const { feed: failed } = await c.tick(quietFeed(), A, { failFirstPage: true })
  assert.equal(failed.live, false, 'no feed ever showed BLINKDEAL live')
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text), [SIGHT_A])
  // The next tick sees BLINKDEAL6: it waits for its page, which confirms it.
  const { text, result } = await captured(() => c.tick(failed, LIVE))
  const texts = c.tgf.sends().map((r) => r.body.text)
  assert.equal(texts[0], SIGHT_A)
  assert.deepEqual(texts.slice(1).sort(), [FULL_TEXT, OVER_A].sort())
  assert.equal(c.tgf.edits().length, 0)
  assert.deepEqual([c.local().length, c.tasker().length], [1, 1], "the notification and Tasker carry BLINKDEAL6's opening alone")
  assert.ok(c.local()[0].args.includes(FULL_TEXT))
  assert.match(text, /^POST close telegramChannel:sent at \S+ \(BLINKDEAL: posted at \S+, never published; BLINKDEAL6's page replaced it\)$/m)
  assert.ok(result.feed.postedAt)
  assert.deepEqual(pick(await c.record.read(), 'code', 'state', 'filled', 'edited'), { code: 'BLINKDEAL6', state: 'sent', filled: true, edited: true })
  // BLINKDEAL6's own window: its close, once, and nothing more for BLINKDEAL.
  const beat = (await c.tick(staleFeed(result.feed), LIVE)).feed
  const { closedWindow, feed } = await c.tick(beat, QUIET)
  await c.tick(feed, QUIET)
  await c.tick(staleFeed(feed), QUIET)
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text).slice(3), [composePost('close', closedWindow)])
  // The new opening's send hanging to the bound does not hold the "is over" back.
  const d = await channel(t, {
    boundMs: 300,
    routes: { sendMessage: (req) => (req.body.text === FULL_TEXT ? { hang: true } : { body: { ok: true, result: { message_id: 201 } } }) },
  })
  const f = (await d.tick(quietFeed(), A, { failFirstPage: true })).feed
  await d.tick(f, LIVE)
  assert.deepEqual(d.tgf.sends().map((r) => r.body.text).sort(), [SIGHT_A, FULL_TEXT, OVER_A].sort())
  assert.equal((await d.record.read()).state, 'unknown', 'the hung opening: never sent again')
})

test('a tick whose coupon page fails waits 2 s at most for the post at sight: cut off, it is never sent again nor filled in, and its close comes as ever', async (t) => {
  const c = await channel(t, { routes: { sendMessage: [{ delay: 3000, body: { ok: true, result: { message_id: 101 } } }, { body: { ok: true, result: { message_id: 102 } } }] } })
  const started = Date.now()
  const { text, result: { feed: failed } } = await captured(() => c.tick(quietFeed(), LIVE, { failFirstPage: true, firstPageMs: 100 }))
  const took = Date.now() - started
  assert.ok(took >= 100 + TG_SIGHT_GRACE_MS - 50 && took < 100 + TG_SIGHT_GRACE_MS + 700, `the tick took ${took} ms`)
  assert.equal(failed.ok, false)
  assert.match(text, /^POST open: no first page, and the post at sight still unanswered; cut off$/m)
  assert.deepEqual(pick(await c.record.read(), 'state', 'messageId', 'filled'), { state: 'unknown', messageId: null, filled: false })
  // The next tick sees the window live: nothing sent again, no id to edit; the notification and Tasker once.
  const { feed } = await c.tick(failed, LIVE)
  assert.equal(c.tgf.sends().length, 1)
  assert.equal(c.tgf.edits().length, 0)
  assert.deepEqual([c.local().length, c.tasker().length], [1, 1])
  const { closedWindow } = await c.tick(feed, QUIET)
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text), [SIGHT_TEXT, composePost('close', closedWindow)])
  // Answered inside those 2 s: the id is on record, and the next tick fills the post in.
  const d = await channel(t, { routes: { sendMessage: { delay: 300, body: { ok: true, result: { message_id: 101 } } } } })
  const s2 = Date.now()
  const f = (await d.tick(quietFeed(), LIVE, { failFirstPage: true })).feed
  assert.ok(Date.now() - s2 < 300 + 400, 'held only until the answer')
  assert.deepEqual(pick(await d.record.read(), 'state', 'messageId'), { state: 'sent', messageId: 101 })
  await d.tick(f, LIVE)
  assert.deepEqual(d.tgf.edits().map((r) => r.body.message_id), [101])
})

test('the wait for the Telegram opening is bounded after the first page, and cuts what is in flight', async (t) => {
  // The edit hangs: the tick ends at the bound, not at Telegram's 15 s.
  const c = await channel(t, { routes: { editMessageText: { hang: true } }, boundMs: 250 })
  const events = []
  const started = Date.now()
  await c.tick(quietFeed(), LIVE, { events })
  const took = Date.now() - started
  assert.ok(took >= 250 && took < 250 + 700, `${took} ms`)
  // The crawl never waited for either post.
  const at = Object.fromEntries(events)
  assert.ok(at.crawl - at['first page'] < 50, 'the crawl started at the first page')
  // No first page at all: the bound runs from the sight.
  const d = await channel(t, { routes: { sendMessage: { hang: true } }, boundMs: 250 })
  const s2 = Date.now()
  const { feed } = await d.tick(quietFeed(), LIVE, { failFirstPage: true })
  assert.ok(Date.now() - s2 < 250 + 700)
  assert.equal(feed.ok, false)
  assert.equal((await d.record.read()).state, 'unknown', 'cut short, it may have gone out: never sent again')
})

test('the record: one opening at a time, written whole, a broken one moved aside; dry and replay runs never touch the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-record-'))
  const path = join(dir, '.wa-ledger', 'telegram-open.json')
  const r = telegramRecord(path)
  assert.equal(await r.read(), null)
  const rec = { v: 1, code: 'BLINKDEAL6', from: null, state: 'sending', messageId: null, filled: false, postedAt: iso(Date.now()) }
  assert.equal(await r.create(rec), true)
  assert.equal(await r.create({ ...rec, code: 'OTHER' }), false, 'a second run gets EEXIST')
  await r.replace({ ...rec, state: 'sent', messageId: 9 })
  assert.equal((await r.read()).messageId, 9)
  assert.deepEqual(await readdir(join(dir, '.wa-ledger')), ['telegram-open.json'], 'no temporary file left')
  await writeFile(path, '{ "code": ')
  assert.equal(await r.read(), null)
  assert.equal((await readdir(join(dir, '.wa-ledger'))).filter((n) => n.startsWith('telegram-open.bad-')).length, 1)
  await r.remove()
  await r.remove()
  assert.equal(await r.read(), null)
  // The phone's file sits beside the WhatsApp ledger, and the two agree on how old an opening can be.
  assert.equal(TG_OPEN_PATH, join(HERE, '..', '.wa-ledger', 'telegram-open.json'))
  assert.equal(TG_ADOPT_MAX_AGE_MS, ADOPT_MAX_AGE_MS)
  assert.deepEqual([TG_EDIT_RETRIES, TG_EDIT_RETRY_GAP_MS], [EDIT_RETRIES, EDIT_RETRY_GAP_MS], 'and on how an owed edit is tried again')
  // step() keeps the record in memory unless it is handed one; main() hands the file only to a real run.
  const read = async () => readFile(TG_OPEN_PATH, 'utf8').catch(() => null)
  const was = await read()
  const posts = []
  let f = quietFeed()
  for (const result of [LIVE, QUIET]) f = (await step(f, { detect: fakeDetect(result), notify: async () => ({}), post: fakePost(posts) })).next ?? f
  assert.equal(await read(), was, 'the phone\'s record untouched')
  const src = await readFile(join(HERE, 'blinkdeal.mjs'), 'utf8')
  assert.match(src, /const tgRecord = SILENT \|\| DRY_RUN \? undefined : telegramRecord\(TG_OPEN_PATH\)/)
})

test('the Telegram token and message ids never reach the log', async (t) => {
  const c = await channel(t, {
    routes: {
      sendMessage: { body: { ok: true, result: { message_id: 73915 } } },
      editMessageText: { status: 400, body: { ok: false, error_code: 400, description: `Bad Request: bot${TG_TOKEN} cannot edit 73915 in -1001234567890` } },
    },
  })
  const { text } = await captured(async () => {
    const { feed } = await c.tick(quietFeed(), LIVE)
    await c.tick(feed, QUIET)
  })
  assert.ok(text.includes('POST open'), 'the log was captured')
  for (const secret of [TG_TOKEN, TG_TOKEN.split(':')[1], '73915', '1001234567890']) assert.ok(!text.includes(secret), secret)
})
