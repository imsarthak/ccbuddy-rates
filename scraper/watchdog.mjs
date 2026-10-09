// A dead-man's switch for the BLINKDEAL watcher.
//
// The watcher runs on a phone, and its alerts run on that same phone, so when
// the phone dies nothing says so. On 2026-10-04 at 18:29 IST it went quiet,
// and two windows on 2026-10-09 passed unseen. The feed is rewritten at
// least once per heartbeat (20 min when quiet, 2 min while live), so a feed
// older than two heartbeats and a bit means the loop has stopped.
//
// Run from .github/workflows/watchdog.yml on a schedule, it opens one issue
// when the feed goes stale (GitHub notifies the repo owner) and closes it
// when the feed moves again. It reads only the committed docs/blinkdeal.json
// and needs nothing from the phone.
//
//   node scraper/watchdog.mjs            check, and open or close the issue
//   node scraper/watchdog.mjs --dry-run  check and print what it would do

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TITLE = 'BLINKDEAL watcher is down'
const GRACE_MS = 5 * 60 * 1000
const DEFAULT_HEARTBEAT_MS = 20 * 60 * 1000

/** IST, as the issue reads it: "9 Oct, 18:29". */
export function ist(ms) {
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** What to do about the feed, given the time now and the open issue, if any. */
export function decide(feed, nowMs, openIssue) {
  const checked = Date.parse(feed?.checkedAt ?? feed?.generated ?? '')
  if (Number.isNaN(checked)) return { action: openIssue ? 'none' : 'open', reason: 'the feed has no time in it', checked: null }
  const heartbeat = Number(feed.heartbeatMs) > 0 ? Number(feed.heartbeatMs) : DEFAULT_HEARTBEAT_MS
  const limit = 2 * Math.max(heartbeat, DEFAULT_HEARTBEAT_MS) + GRACE_MS
  const stale = nowMs - checked > limit
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

async function gh(path, init = {}) {
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

async function main() {
  const dry = process.argv.includes('--dry-run')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const feed = JSON.parse(await readFile(join(root, 'docs', 'blinkdeal.json'), 'utf8'))
  const open = dry ? [] : await gh('/issues?state=open&per_page=100')
  const mine = open.find((i) => !i.pull_request && i.title === TITLE) ?? null
  const d = decide(feed, Date.now(), mine)
  console.log(`watchdog: ${d.action} (${d.reason})`)
  if (dry) return
  if (d.action === 'open') {
    await gh('/issues', { method: 'POST', body: JSON.stringify({ title: TITLE, body: issueBody(d.checked) }) })
  } else if (d.action === 'close') {
    await gh(`/issues/${mine.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Back up: the feed was ${d.reason}.` }) })
    await gh(`/issues/${mine.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
