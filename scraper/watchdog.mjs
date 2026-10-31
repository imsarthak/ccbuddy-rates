// A dead-man's switch for the BLINKDEAL watcher.
//
// The watcher runs on a phone, and its alerts run on that same phone, so when
// the phone dies nothing says so. On 2026-10-04 at 18:29 IST it went quiet,
// and two windows on 2026-10-09 passed unseen. The feed is rewritten at
// least once per heartbeat (20 min when quiet, 2 min while live), so a feed
// older than two heartbeats and a bit means the loop has stopped.
//
// It opens one issue when the feed goes stale (GitHub notifies the repo
// owner) and closes it when the feed moves again. It reads only the committed
// docs/blinkdeal.json and needs nothing from the phone.
//
// With two repository secrets it also messages the owner privately on Telegram,
// never the public channel: once when it opens the issue ("went quiet") and
// once when it closes it ("back"). The same bot the phone posts with:
//
//   BLINKDEAL_TELEGRAM_TOKEN  the bot token (telegram.token in the phone's .notify.env)
//   BLINKDEAL_TELEGRAM_CHAT   the owner's chat id (telegram.chatId there)
//
// Without either, it does everything else and sends nothing. The issue body
// carries a hidden marker saying whether "went quiet" has gone out yet, so a
// failed message is retried on the next run and "back" goes only to someone
// who was told the phone had stopped.
//
// What runs it (.github/workflows/watchdog.yml). GitHub's own schedule alone
// is not a clock: set to every 15 minutes, it ran 3 to 7 hours apart in
// October, and the issue for the 4 Oct outage opened on 9 Oct.
//   - The ccbuddy Worker's cron (ccbuddy repo, worker/bdWatch.ts) dispatches
//     it every 5 minutes for the first hour the feed is past its limit, and
//     once an hour whatever the feed says. "Went quiet" lands about 45 to 50
//     minutes after the phone's last update.
//   - Every phone push of docs/blinkdeal.json, so "back" goes out within a
//     minute of the phone's first update after an outage.
//   - GitHub's schedule, as the slow backstop.
// The workflow's concurrency group runs one at a time, so each outage gets
// one issue, one "went quiet" and one "back".
//
// The repo is public and so are its Actions logs. Nothing here prints the
// token, the chat id or anything Telegram answers with (its reply names the owner).
//
//   node scraper/watchdog.mjs              check, open or close the issue, message the owner
//   node scraper/watchdog.mjs --dry-run    check and print what it would do, send nothing
//   node scraper/watchdog.mjs --preview    print the messages for the October outage, send nothing
//   node scraper/watchdog.mjs --test-dm    send the owner the test message, nothing else
//                                          (MODE=test-dm in the workflow does the same)
//   node scraper/watchdog.mjs --wa-health-day
//                                          key=… and due=… for $GITHUB_OUTPUT: whether
//                                          this run may make the day's WhatsApp
//                                          session probe (waHealthDay); no network

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { istClock, istDate } from './notify.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const TITLE = 'BLINKDEAL watcher is down'
/** The account this workflow's token acts as. Anyone can open an issue on a
 *  public repo, so an issue with the right title from anyone else is not
 *  ours: it must not stand in for an outage, or silence one. */
export const BOT = 'github-actions[bot]'
const GRACE_MS = 5 * 60 * 1000
const DEFAULT_HEARTBEAT_MS = 20 * 60 * 1000
const TELEGRAM_TIMEOUT_MS = 15000
const TELEGRAM_TRIES = 3
/** The longest a 429's retry_after is honoured; the job has 3 minutes. */
const MAX_WAIT_S = 30

/** IST, as the issue reads it: "9 Oct, 18:29". */
export function ist(ms) {
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** How old the feed may be before the phone counts as stopped. The ccbuddy
 *  Worker (worker/bdWatch.ts, limitMs) mirrors this to know when to call. */
export function limitMs(feed) {
  const heartbeat = Number(feed?.heartbeatMs) > 0 ? Number(feed.heartbeatMs) : DEFAULT_HEARTBEAT_MS
  return 2 * Math.max(heartbeat, DEFAULT_HEARTBEAT_MS) + GRACE_MS
}

/** What to do about the feed, given the time now and the open issue, if any. */
export function decide(feed, nowMs, openIssue) {
  const checked = Date.parse(feed?.checkedAt ?? feed?.generated ?? '')
  if (Number.isNaN(checked)) return { action: openIssue ? 'none' : 'open', reason: 'the feed has no time in it', checked: null }
  const stale = nowMs - checked > limitMs(feed)
  if (stale) return { action: openIssue ? 'none' : 'open', reason: `last written ${ist(checked)} IST`, checked }
  return { action: openIssue ? 'close' : 'none', reason: `written ${ist(checked)} IST`, checked }
}

export function issueBody(checked) {
  const since = checked == null ? 'a feed with no time in it' : `${ist(checked)} IST`
  return [
    `The phone has not updated \`docs/blinkdeal.json\` since ${since}, so BLINKDEAL windows are being missed.`,
    '',
    'On the phone, open Termux and run:',
    '',
    '```',
    'cd ~/ccbuddy-rates && bash scraper/watch-termux.sh',
    '```',
    '',
    'This issue closes itself when the feed moves again.',
  ].join('\n')
}

/** The watchdog's own open issue in a page of open issues, or null. */
export function findIssue(issues) {
  return (issues ?? []).find((i) => !i.pull_request && i.title === TITLE && i.user?.login === BOT) ?? null
}

// ---- the marker: what the issue remembers between runs ----
//
// One hidden line at the end of the issue body:
//   <!-- bd-watch {"from":"2026-10-04T12:59:00.301Z","dm":"due"} -->
// `from` is the feed's last time when the issue opened (null for a feed with
// no time in it); `dm` is whether "went quiet" still has to go out ("due") or
// has ("sent"). Only this workflow's bot, the owner and collaborators can
// edit an issue the bot opened, so nobody else can rewrite it.

const MARKER = /<!-- bd-watch (\{[^\n]*?\}) -->/

/** { from: ms | null, dm: 'due' | 'sent' }, or null when the body has no
 *  marker or a broken one (an issue from before the marker: "legacy"). */
export function readMarker(body) {
  const m = typeof body === 'string' ? body.match(MARKER) : null
  if (!m) return null
  let v
  try {
    v = JSON.parse(m[1])
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object') return null
  if (v.dm !== 'due' && v.dm !== 'sent') return null
  if (v.from === null) return { from: null, dm: v.dm }
  const from = typeof v.from === 'string' ? Date.parse(v.from) : NaN
  return Number.isNaN(from) ? null : { from, dm: v.dm }
}

/** The body with its marker set to this one, replacing any it had. */
export function withMarker(body, marker) {
  const tag = `<!-- bd-watch ${JSON.stringify({
    from: marker.from == null ? null : new Date(marker.from).toISOString(),
    dm: marker.dm,
  })} -->`
  const rest = String(body ?? '').replace(MARKER, '').replace(/\s+$/, '')
  return rest ? `${rest}\n\n${tag}` : tag
}

// ---- the words ----
//
// Times in IST, as the phone's own posts give them: "6:29 pm" (istClock in
// notify.mjs), with the day when it is not the same day: "4 Oct". The words
// are the owner's call: change them here and in watchdog.test.mjs together.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const IST_MS = 330 * 60000
const istDayNumber = (ms) => Math.floor((ms + IST_MS) / 86400000)

/** "4 Oct", IST. Arithmetic rather than Intl, as istClock is. */
export function istDay(ms) {
  const d = new Date(ms + IST_MS)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

// The WhatsApp poster's session probe (wa-post.mjs --mode health) runs once
// a day, not on every scheduled run: Whapi's Sandbox allows 1,000 calls a
// month. The workflow makes it on the first scheduled run at or after this
// hour IST whose day has no Actions cache entry under `key` yet, then saves
// one. Windows have opened from about 12:30 IST, so it still comes hours
// before the day's first.
export const WA_HEALTH_FROM_IST_HOUR = 6

/** The probe's day at `ms`: its cache key, by the IST date (istDate, as the phone's daily checks), and whether a run then may make it. */
export function waHealthDay(ms) {
  return { key: `wa-health-${istDate(ms)}`, due: new Date(ms + IST_MS).getUTCHours() >= WA_HEALTH_FROM_IST_HOUR }
}

export const DM = {
  /** The phone's last update was `fromMs` (null: the feed has no time). */
  down(fromMs, nowMs) {
    if (fromMs == null) return 'BLINKDEAL phone went quiet.'
    return istDayNumber(fromMs) === istDayNumber(nowMs)
      ? `BLINKDEAL phone went quiet at ${istClock(fromMs)}.`
      : `BLINKDEAL phone went quiet on ${istDay(fromMs)} at ${istClock(fromMs)}.`
  },
  /** Quiet from `fromMs` (its last update before) to `toMs` (its first after). */
  back(fromMs, toMs) {
    if (fromMs == null || toMs == null) return 'BLINKDEAL phone is back.'
    return istDayNumber(fromMs) === istDayNumber(toMs)
      ? `BLINKDEAL phone is back. Quiet ${istClock(fromMs)} to ${istClock(toMs)}.`
      : `BLINKDEAL phone is back. Quiet ${istDay(fromMs)}, ${istClock(fromMs)} to ${istDay(toMs)}, ${istClock(toMs)}.`
  },
  test: 'Test: BLINKDEAL pings reach you here.',
}

// ---- Telegram ----

/** The DM's bot token and chat id from the environment, or null when either
 *  is missing: then nothing is sent and everything else still runs. */
export function telegramFrom(env) {
  const token = String(env?.BLINKDEAL_TELEGRAM_TOKEN ?? '').trim()
  const chatId = String(env?.BLINKDEAL_TELEGRAM_CHAT ?? '').trim()
  return token && chatId ? { token, chatId } : null
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Send one message to the owner's chat. Up to three tries when Telegram is
 * unreachable, busy (429, waiting as long as it asks, up to 30 s) or failing
 * (5xx); a 4xx is an answer, not a hiccup, and is not retried.
 *
 * The reply is never read on success and never printed: it carries the
 * owner's name and username, and these logs are public. A failure says the
 * status and Telegram's own one-line reason ("Bad Request: chat not found"),
 * with the token cut out of anything that could hold it.
 */
export async function sendDm(cfg, text, { fetch: fetchFn = globalThis.fetch, sleep = sleepFor } = {}) {
  const redact = (s) => String(s).split(cfg.token).join('<token>')
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= TELEGRAM_TRIES
    let res
    try {
      res = await fetchFn(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      })
    } catch (err) {
      const code = err?.cause?.code ? ` ${err.cause.code}` : ''
      if (last) throw new Error(redact(`telegram unreachable: ${err?.name ?? 'Error'}${code}`))
      await sleep(attempt * 2000)
      continue
    }
    if (res.ok) {
      await res.body?.cancel?.().catch(() => {})
      return 'sent'
    }
    let answer = null
    try {
      answer = await res.json()
    } catch {
      // no reason given: the status says enough
    }
    const why = typeof answer?.description === 'string' ? `: ${answer.description}` : ''
    const retry = res.status === 429 || res.status >= 500
    if (!retry || last) throw new Error(redact(`telegram HTTP ${res.status}${why}`))
    const after = Number(answer?.parameters?.retry_after)
    await sleep(after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : attempt * 2000)
  }
}

// ---- one run ----

/**
 * Decide, act on the issue, then message the owner. The issue always comes first:
 * a message that fails is logged and retried on a later run, and never stops
 * the issue opening or closing.
 *
 *   feed   the committed docs/blinkdeal.json
 *   gh     (path, init) => the repo's GitHub API, as gh() below
 *   dm     (text) => sends the owner one message, or null when there are no secrets
 *
 * Returns { action, dm }: dm is 'none' (nothing owed), 'sent', 'failed',
 * 'skipped' (owed, but no secrets) or 'legacy' (an issue from before the
 * marker, closed without a message).
 */
export async function run({ feed, nowMs, gh: api, dm = null, log = console.log }) {
  const mine = findIssue(await api('/issues?state=open&per_page=100'))
  const d = decide(feed, nowMs, mine)
  log(`watchdog: ${d.action} (${d.reason})`)

  const deliver = async (kind, text) => {
    if (!dm) {
      log(`watchdog: ${kind} message skipped: no secrets`)
      return 'skipped'
    }
    try {
      await dm(text)
    } catch (err) {
      log(`watchdog: ${kind} message failed: ${err?.message ?? err}`)
      return 'failed'
    }
    log(`watchdog: ${kind} message sent`)
    return 'sent'
  }

  // "Went quiet", then the marker says so. If the marker cannot be written
  // after a send, this throws and the next run sends it again: a duplicate
  // is better than silence.
  const quiet = async (issue, marker) => {
    const sent = await deliver('quiet', DM.down(marker.from, nowMs))
    if (sent === 'sent') {
      await api(`/issues/${issue.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: withMarker(issue.body, { ...marker, dm: 'sent' }) }),
      })
    }
    return sent
  }

  if (d.action === 'open') {
    const marker = { from: d.checked, dm: 'due' }
    const body = withMarker(issueBody(d.checked), marker)
    const created = await api('/issues', { method: 'POST', body: JSON.stringify({ title: TITLE, body }) })
    return { action: d.action, dm: await quiet({ number: created.number, body }, marker) }
  }

  if (d.action === 'close') {
    const marker = readMarker(mine.body)
    await api(`/issues/${mine.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Back up: the feed was ${d.reason}.` }) })
    await api(`/issues/${mine.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) })
    if (!marker) return { action: d.action, dm: 'legacy' }
    if (marker.dm !== 'sent') return { action: d.action, dm: 'none' }
    return { action: d.action, dm: await deliver('back', DM.back(marker.from, d.checked)) }
  }

  // Still down with the issue open: send "went quiet" if it is still owed.
  if (mine) {
    const marker = readMarker(mine.body)
    if (marker?.dm === 'due') return { action: d.action, dm: await quiet(mine, marker) }
  }
  return { action: d.action, dm: 'none' }
}

/** The repo's own GitHub API, as the workflow's token. Shared with wa-post.mjs. */
export async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

/** The real October outage, for --preview and the tests: the feed before it
 *  (commit 5f0a029) and the first one after (d37272e). */
export async function outageFixtures() {
  const read = async (name) => JSON.parse(await readFile(join(ROOT, 'scraper', 'fixtures', name), 'utf8'))
  return { before: await read('watchdog-outage-before.json'), after: await read('watchdog-outage-after.json') }
}

async function preview() {
  const { before, after } = await outageFixtures()
  const from = Date.parse(before.checkedAt)
  const to = Date.parse(after.checkedAt)
  const onTime = from + limitMs(before) + 2 * 60000
  const late = from + 86400000
  const rows = [
    [`went quiet, on time (${ist(onTime)} IST)`, DM.down(from, onTime)],
    [`went quiet, a day late (${ist(late)} IST)`, DM.down(from, late)],
    ['went quiet, a feed with no time', DM.down(null, onTime)],
    [`back (${ist(to)} IST)`, DM.back(from, to)],
    ['back, the same day (example: 1 h 12 min)', DM.back(from, from + 72 * 60000)],
    ['back, a feed with no time', DM.back(null, to)],
    ['test', DM.test],
  ]
  for (const [what, text] of rows) console.log(`${what}\n  ${text}\n`)
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--wa-health-day')) {
    const { key, due } = waHealthDay(Date.now())
    console.log(`key=${key}\ndue=${due}`)
    return
  }
  if (argv.includes('--preview')) return preview()
  const mode = argv.includes('--test-dm') ? 'test-dm' : (env.MODE || 'check')
  const tg = telegramFrom(env)
  if (mode === 'test-dm') {
    if (!tg) {
      console.log('watchdog: test message skipped: no secrets')
      return
    }
    await sendDm(tg, DM.test)
    console.log('watchdog: test message sent')
    return
  }
  if (mode !== 'check') throw new Error('MODE must be check or test-dm')

  const feed = JSON.parse(await readFile(join(ROOT, 'docs', 'blinkdeal.json'), 'utf8'))
  if (argv.includes('--dry-run')) {
    const nowMs = Date.now()
    const d = decide(feed, nowMs, null)
    console.log(`watchdog: ${d.action} (${d.reason})`)
    if (d.action === 'open') console.log(`watchdog: would message: ${DM.down(d.checked, nowMs)}`)
    return
  }
  const out = await run({ feed, nowMs: Date.now(), gh, dm: tg ? (text) => sendDm(tg, text) : null })
  // A message that failed turns the run red, after the issue work is done:
  // a silent failure here is the very thing this file exists to prevent.
  if (out.dm === 'failed') process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
