// Channel posts: the templates, and the promise that each window posts
// exactly once on open and once on close whatever the ticks in between do.
//
//   node --test scraper/channel-posts.test.mjs
//
// Nothing here touches the network: detect and the senders are injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { composePost, formatDuration, applyEnv, cheapestPerGram, buttonAction, APP_LINK, TEMPLATES } from './notify.mjs'
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
  assert.ok(cmd.startsWith('export PATH=/data/data/com.termux/files/usr/bin:$PATH && '))
  assert.ok(cmd.includes("| termux-clipboard-set && termux-open-url 'https://whatsapp.com/channel/abc'"))
  assert.ok(cmd.includes(`'it'\\''s live\nline 2'`), 'single quotes inside the text are escaped for sh')
})

// Run the real command under a real sh with stub termux-* commands on PATH,
// so the quoting is proven rather than eyeballed. The Termux bin dir does not
// exist here, so PATH falls through to the stubs.
test('the button action delivers the post byte-for-byte to the clipboard and the URL to the opener', async (t) => {
  let sh
  try {
    sh = (await run('sh', ['-c', 'echo ok'])).stdout.trim()
  } catch {
    sh = null
  }
  if (sh !== 'ok') return t.skip('no sh on this machine')
  const dir = await mkdtemp(join(tmpdir(), 'ccbuddy-btn-'))
  const clip = join(dir, 'clip.txt').replace(/\\/g, '/')
  const opened = join(dir, 'url.txt').replace(/\\/g, '/')
  for (const [name, body] of [
    ['termux-clipboard-set', `#!/bin/sh\ncat > '${clip}'\n`],
    ['termux-open-url', `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`],
  ]) {
    await writeFile(join(dir, name), body)
    await chmod(join(dir, name), 0o755)
  }
  const text = composePost('open', { ...fixture, discountPct: 6 }) + "\nit's ₹ & \"quotes\" $HOME `x`"
  const url = 'https://whatsapp.com/channel/0029VaTest'
  await run('sh', ['-c', buttonAction(text, url)], { env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` } })
  assert.equal(await readFile(clip, 'utf8'), text)
  assert.equal(await readFile(opened, 'utf8'), url)
})

test('environment overrides the config file without touching other channels', () => {
  const cfg = { telegram: { token: 'file', chatId: '1' }, sms: { to: '+91' } }
  const out = applyEnv(cfg, { BLINKDEAL_TELEGRAM_CHANNEL: '@test_channel' })
  assert.deepEqual(out.telegram, { token: 'file', chatId: '1', channelId: '@test_channel' })
  assert.deepEqual(out.sms, cfg.sms)
  assert.deepEqual(applyEnv(cfg, {}), cfg)
  assert.equal(applyEnv({}, { BLINKDEAL_TELEGRAM_TOKEN: 't' }).telegram.token, 't')
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
