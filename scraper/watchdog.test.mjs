// node scraper/watchdog.test.mjs
import { decide, issueBody, TITLE } from './watchdog.mjs'

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) passed++
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const at = (iso) => Date.parse(iso)
const feed = (checkedAt, heartbeatMs = 1200000) => ({ checkedAt, heartbeatMs })
const issue = { number: 7, title: TITLE }

// The real outage: last written 2026-10-04 12:59 UTC (18:29 IST).
const dead = feed('2026-10-04T12:59:00.301Z')
check('days old with no issue: open one', decide(dead, at('2026-10-09T10:00:00Z'), null).action === 'open')
check('days old with an issue already open: leave it', decide(dead, at('2026-10-09T10:00:00Z'), issue).action === 'none')
check('the reason names the IST time', decide(dead, at('2026-10-09T10:00:00Z'), null).reason.includes('18:29'))

// A quiet feed rewrites on a 20-minute heartbeat: 30 or 44 minutes is not dead.
check('30 min after a heartbeat: fine', decide(feed('2026-10-09T10:00:00Z'), at('2026-10-09T10:30:00Z'), null).action === 'none')
check('44 min: still fine', decide(feed('2026-10-09T10:00:00Z'), at('2026-10-09T10:44:00Z'), null).action === 'none')
check('46 min: down', decide(feed('2026-10-09T10:00:00Z'), at('2026-10-09T10:46:00Z'), null).action === 'open')

// While live the heartbeat is 2 minutes, but the limit never drops below the quiet one.
check('live heartbeat does not make it jumpy', decide(feed('2026-10-09T10:00:00Z', 120000), at('2026-10-09T10:20:00Z'), null).action === 'none')

// Recovery closes the issue; no issue and fresh means nothing.
check('fresh with an issue open: close it', decide(feed('2026-10-09T10:00:00Z'), at('2026-10-09T10:05:00Z'), issue).action === 'close')
check('fresh with none open: nothing', decide(feed('2026-10-09T10:00:00Z'), at('2026-10-09T10:05:00Z'), null).action === 'none')

// A broken feed counts as down.
check('no time in the feed: open', decide({}, at('2026-10-09T10:00:00Z'), null).action === 'open')

const body = issueBody(at('2026-10-04T12:59:00Z'))
check('the issue says how to restart it', body.includes('bash scraper/watch-termux.sh') && body.includes('18:29'))

console.log(`watchdog: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
