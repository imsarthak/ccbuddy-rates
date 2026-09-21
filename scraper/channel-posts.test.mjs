// Channel posts: the templates, and the promise that each window posts
// exactly once on open and once on close whatever the ticks in between do.
//
//   node --test scraper/channel-posts.test.mjs
//
// Nothing here touches the network: detect and the senders are injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  composePost, formatDuration, applyEnv, cheapestPerGram, buttonAction, intentArgs,
  APP_LINK, TEMPLATES, INTENT_ACTION, TASKER_PACKAGE, TERMUX_BIN,
} from './notify.mjs'
import { step, inferDiscountPct } from './blinkdeal.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'live-window-2026-09-15.json'), 'utf8'))
const run = promisify(execFile)

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
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['button', 'close', 'closeTitle', 'open', 'openTitle'])
  assert.equal(TEMPLATES.button, 'Post to channel')
})

test('the button action sets PATH itself, pipes the text on stdin, then opens the channel', () => {
  const cmd = buttonAction("it's live\nline 2", 'https://whatsapp.com/channel/abc')
  assert.equal(TERMUX_BIN, '/data/data/com.termux/files/usr/bin')
  assert.ok(cmd.startsWith(`export PATH=${TERMUX_BIN}:$PATH && `), 'the phone default must be the Termux bin')
  assert.ok(cmd.includes("| termux-clipboard-set && termux-open-url 'https://whatsapp.com/channel/abc'"))
  assert.ok(cmd.includes(`'it'\\''s live\nline 2'`), 'single quotes inside the text are escaped for sh')
})

// Run the real command under a real sh with stub termux-* commands on PATH,
// so the quoting is proven rather than eyeballed. The Termux bin dir does not
// exist here, so PATH falls through to the stubs.
// The stub bin is passed as binDir, NOT prepended to the environment's PATH:
// the command exports its own PATH first, so an environment prefix loses to
// it. On Termux that meant the REAL termux-clipboard-set ran — it overwrote
// the phone's clipboard and opened the fake URL, and the stub file it was
// asserting on never appeared (caught on Sarthak's phone, 2026-09-21).
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
const fakeDetect = (result) => async (previous, onLive, onFirstPage) => {
  if (result instanceof Error) throw result
  if (result.live) {
    await onLive({ code: result.code, couponId: result.couponId, source: result.source, skus: result.skus.slice(0, 3) })
    await onFirstPage({ code: result.code, couponId: result.couponId, source: result.source, totalCount: result.totalCount, skus: result.skus.slice(0, 12) })
  }
  return result
}

test('one open post and one close post per window, whatever the ticks between do', async () => {
  const posts = []
  const alerts = []
  const deps = {
    notify: async (text) => (alerts.push(text), { telegram: 'sent' }),
    post: async (kind, w) => (posts.push({ kind, w }), { telegramChannel: 'sent' }),
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
  assert.equal(posts.length, 1)
  assert.equal(posts[0].kind, 'open')
  assert.equal(posts[0].w.totalCount, 207)
  assert.equal(posts[0].w.discountPct, 6)
  assert.equal(alerts.length, 1)
  assert.ok(feed.postedAt)
  assert.ok(feed.alertedAt)

  ;({ next: feed } = await run(feed, LIVE)) // live, same SKUs: no rewrite
  ;({ next: feed } = await run(stale(feed), LIVE)) // live heartbeat rewrite
  assert.equal(posts.length, 1, 'heartbeat rewrite must not repost')

  ;({ next: feed } = await run(feed, new Error('HTTP 500'))) // failed read mid-window
  assert.equal(feed.live, true)
  assert.equal(feed.ok, false)
  ;({ next: feed } = await run(feed, LIVE)) // recovers
  assert.equal(posts.length, 1, 'a failed read must not repost on recovery')

  let closed
  ;({ next: feed, closedWindow: closed } = await run(feed, QUIET)) // CLOSE edge
  assert.equal(posts.length, 2)
  assert.equal(posts[1].kind, 'close')
  assert.equal(posts[1].w.code, 'BLINKDEAL6')
  assert.equal(posts[1].w.maxSkus, fixture.skus.length)
  assert.ok(posts[1].w.from && posts[1].w.to)
  assert.ok(closed.postedAt)

  ;({ next: feed } = await run(feed, QUIET))
  ;({ next: feed } = await run(stale(feed), QUIET)) // quiet heartbeat rewrite
  assert.equal(posts.length, 2, 'quiet ticks after the close must not repost')

  ;({ next: feed } = await run(feed, LIVE)) // a NEW window, same code
  assert.equal(posts.length, 3)
  assert.equal(posts[2].kind, 'open')
  assert.equal(alerts.length, 2)
})

test('a code change mid-window posts the new code once and does not close the old one', async () => {
  const posts = []
  const deps = { notify: async () => ({}), post: async (kind, w) => (posts.push({ kind, code: w.code }), {}) }
  let feed = { checkedAt: new Date().toISOString(), ok: true, live: false, knownIds: [] }
  feed = (await step(feed, { ...deps, detect: fakeDetect(LIVE) })).next
  feed = (await step(feed, { ...deps, detect: fakeDetect({ ...LIVE, code: 'BLINKDEAL' }) })).next
  assert.deepEqual(posts, [
    { kind: 'open', code: 'BLINKDEAL6' },
    { kind: 'open', code: 'BLINKDEAL' },
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
