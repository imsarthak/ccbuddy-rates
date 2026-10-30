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
  APP_LINK, TEMPLATES, INTENT_ACTION, TASKER_PACKAGE, TERMUX_BIN, TG_OPEN_PATH, TG_ADOPT_MAX_AGE_MS,
} from './notify.mjs'
import { step, inferDiscountPct } from './blinkdeal.mjs'
import { ADOPT_MAX_AGE_MS } from './wa-phone.mjs'
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
  assert.deepEqual(kinds(posts), ['open/sight', 'open/full'])
  // At sight: the code, the discount from the plain listing's coins, the coupon page. No coins, no count.
  assert.deepEqual(posts[0].w.skus, [])
  assert.equal(posts[0].w.totalCount, null)
  assert.equal(posts[0].w.discountPct, inferDiscountPct(LIVE.code, LIVE.skus.slice(0, 3)))
  assert.equal(posts[0].w.source, LIVE.source)
  assert.equal(posts[1].w.totalCount, 207)
  assert.equal(posts[1].w.discountPct, 6)
  assert.equal(posts[1].w.skus.length, 12)
  assert.equal(alerts.length, 1)
  assert.ok(feed.postedAt)
  assert.ok(feed.alertedAt)

  ;({ next: feed } = await run(feed, LIVE)) // live, same SKUs: no rewrite
  ;({ next: feed } = await run(stale(feed), LIVE)) // live heartbeat rewrite
  assert.equal(posts.length, 2, 'heartbeat rewrite must not repost')

  ;({ next: feed } = await run(feed, new Error('HTTP 500'))) // failed read mid-window
  assert.equal(feed.live, true)
  assert.equal(feed.ok, false)
  ;({ next: feed } = await run(feed, LIVE)) // recovers
  assert.equal(posts.length, 2, 'a failed read must not repost on recovery')

  let closed
  ;({ next: feed, closedWindow: closed } = await run(feed, QUIET)) // CLOSE edge
  assert.deepEqual(kinds(posts), ['open/sight', 'open/full', 'close'])
  assert.equal(posts[2].w.code, 'BLINKDEAL6')
  assert.equal(posts[2].w.maxSkus, fixture.skus.length)
  assert.ok(posts[2].w.from && posts[2].w.to)
  assert.ok(closed.postedAt)

  ;({ next: feed } = await run(feed, QUIET))
  ;({ next: feed } = await run(stale(feed), QUIET)) // quiet heartbeat rewrite
  assert.equal(posts.length, 3, 'quiet ticks after the close must not repost')

  ;({ next: feed } = await run(feed, LIVE)) // a NEW window, same code
  assert.deepEqual(kinds(posts).slice(3), ['open/sight', 'open/full'])
  assert.equal(alerts.length, 2)
})

test('a code change mid-window posts the new code once and does not close the old one', async () => {
  const posts = []
  const deps = { notify: async () => ({}), post: fakePost(posts) }
  let feed = { checkedAt: new Date().toISOString(), ok: true, live: false, knownIds: [] }
  feed = (await step(feed, { ...deps, detect: fakeDetect(LIVE) })).next
  feed = (await step(feed, { ...deps, detect: fakeDetect({ ...LIVE, code: 'BLINKDEAL' }) })).next
  assert.deepEqual(posts.map((p) => `${p.kind}/${p.stage} ${p.w.code}`), [
    'open/sight BLINKDEAL6',
    'open/full BLINKDEAL6',
    'open/sight BLINKDEAL',
    'open/full BLINKDEAL',
  ])
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

test('Telegram: a failed edit (400, 500, or one that hangs past the bound) costs the tick nothing and is never retried', async (t) => {
  for (const answer of [
    { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' } },
    { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } },
    { hang: true },
  ]) {
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
    // Later ticks of the window: no retry.
    const beat = (await c.tick(staleFeed(result.feed), LIVE)).feed
    await c.tick(beat, LIVE)
    assert.equal(c.tgf.requests.length, 2, what)
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
  // A lost feed write: not again.
  await c.tick(quietFeed(), LIVE)
  assert.equal(c.local().length, 1)
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

test('Telegram: a lost feed write after the first page: nothing at all on the next tick; quiet reads then end it once', async (t) => {
  const c = await channel(t)
  await c.tick(quietFeed(), LIVE) // posted and filled in; the feed write is lost
  const before = c.tgf.requests.length
  const { feed } = await c.tick(quietFeed(), LIVE)
  assert.equal(c.tgf.requests.length, before, 'no post and no edit')
  assert.equal(c.local().length, 1)
  assert.equal(c.tasker().length, 1)
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

test('Telegram: a code change replaces the record without a close, as before, and posts the new code at sight', async (t) => {
  const c = await channel(t)
  const { feed } = await c.tick(quietFeed(), LIVE)
  const B = { ...LIVE, code: 'BLINKDEAL', skus: LIVE.skus.map((s) => ({ ...s, code: 'BLINKDEAL' })) }
  await c.tick(feed, B)
  assert.deepEqual(c.tgf.sends().map((r) => r.body.text.split('\n')[0]), ['BLINKDEAL6 live on Myntra — 6% off gold coins', 'BLINKDEAL live on Myntra — 6% off gold coins'])
  assert.equal(c.tgf.edits().length, 2)
  assert.equal((await c.record.read()).code, 'BLINKDEAL')
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
