// node scraper/watchdog.test.mjs
import { readFile } from 'node:fs/promises'
import {
  BOT, DM, TITLE, decide, findIssue, issueBody, limitMs, outageFixtures, readMarker, run, sendDm, telegramFrom, withMarker,
} from './watchdog.mjs'

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

// ---- the limit, which the ccbuddy Worker mirrors (worker/bdWatch.ts) ----
check('limit: 45 min on the quiet heartbeat', limitMs(feed('x')) === 45 * 60000)
check('limit: still 45 min while live (2-min heartbeat)', limitMs(feed('x', 120000)) === 45 * 60000)
check('limit: a longer heartbeat carries through', limitMs(feed('x', 30 * 60000)) === 65 * 60000)
check('limit: no heartbeat at all is the quiet one', limitMs({}) === 45 * 60000)

// ---- whose issue it is ----
const theirs = { number: 3, title: TITLE, user: { login: 'someone' }, body: '' }
const ours = { number: 4, title: TITLE, user: { login: BOT }, body: '' }
check('an issue with the title from someone else is not ours', findIssue([theirs]) === null)
check('…nor a pull request with it', findIssue([{ ...ours, pull_request: {} }]) === null)
check('…while the bot\'s own is', findIssue([theirs, ours])?.number === 4)
check('…and an empty page is none', findIssue([]) === null && findIssue(undefined) === null)

// ---- the marker ----
{
  const from = at('2026-10-04T12:59:00.301Z')
  const b = withMarker(issueBody(from), { from, dm: 'due' })
  check('marker: round-trips', JSON.stringify(readMarker(b)) === JSON.stringify({ from, dm: 'due' }), b.split('\n').pop())
  check('marker: is an HTML comment, hidden on the page', /<!-- bd-watch \{.*\} -->$/.test(b))
  check('marker: the body above it is untouched', b.startsWith(issueBody(from)))
  const again = withMarker(b, { from, dm: 'sent' })
  check('marker: rewriting it replaces it, never a second one', (again.match(/bd-watch/g) ?? []).length === 1 && readMarker(again)?.dm === 'sent')
  check('marker: a feed with no time keeps from null', JSON.stringify(readMarker(withMarker('x', { from: null, dm: 'due' }))) === JSON.stringify({ from: null, dm: 'due' }))
  for (const [what, bad] of [
    ['no marker', issueBody(from)],
    ['broken JSON', 'x\n\n<!-- bd-watch {"from":"2026-10-04T12:59:00Z","dm":"due" -->'],
    ['an unknown dm', '<!-- bd-watch {"from":null,"dm":"maybe"} -->'],
    ['a from that is not a time', '<!-- bd-watch {"from":"soon","dm":"due"} -->'],
    ['a from that is a number', '<!-- bd-watch {"from":5,"dm":"due"} -->'],
    ['no body at all', null],
  ]) check(`marker: ${what} reads as none`, readMarker(bad) === null)
}

// ---- the words, on the real outage ----
const { before, after } = await outageFixtures()
check('fixture: the feed before is 5f0a029\'s', before.checkedAt === '2026-10-04T12:59:00.301Z')
check('fixture: the feed after is d37272e\'s', after.checkedAt === '2026-10-29T07:39:21.107Z')
{
  const from = Date.parse(before.checkedAt)
  const to = Date.parse(after.checkedAt)
  const onTime = from + limitMs(before) + 2 * 60000
  check('quiet, on time', DM.down(from, onTime) === 'BLINKDEAL phone went quiet at 6:29 pm.', DM.down(from, onTime))
  check('quiet, a day late, names the day', DM.down(from, from + 86400000) === 'BLINKDEAL phone went quiet on 4 Oct at 6:29 pm.', DM.down(from, from + 86400000))
  check('quiet, no time', DM.down(null, onTime) === 'BLINKDEAL phone went quiet.')
  const back = DM.back(from, to)
  check('back: both ends, both days', back === 'BLINKDEAL phone is back. Quiet 4 Oct, 6:29 pm to 29 Oct, 1:09 pm.', back)
  check('back: has 6:29 pm, 4 Oct, 1:09 pm and 29 Oct', ['6:29 pm', '4 Oct', '1:09 pm', '29 Oct'].every((s) => back.includes(s)))
  check('back, the same day: times only', DM.back(from, from + 72 * 60000) === 'BLINKDEAL phone is back. Quiet 6:29 pm to 7:41 pm.')
  check('back, no start: plain', DM.back(null, to) === 'BLINKDEAL phone is back.')
  // The day is IST's, not UTC's: 23:50 IST and 00:10 IST are two days.
  const late = at('2026-10-04T18:20:00Z')
  check('IST midnight splits the day', DM.down(late, at('2026-10-04T18:40:00Z')) === 'BLINKDEAL phone went quiet on 4 Oct at 11:50 pm.')
  check('…and UTC midnight does not', DM.down(at('2026-10-04T23:50:00Z'), at('2026-10-05T00:10:00Z')) === 'BLINKDEAL phone went quiet at 5:20 am.')
  check('test message', DM.test === 'Test: BLINKDEAL pings reach you here.')
}

// ---- the secrets ----
check('secrets: both present', JSON.stringify(telegramFrom({ BLINKDEAL_TELEGRAM_TOKEN: ' 1:abc ', BLINKDEAL_TELEGRAM_CHAT: '42\n' })) === '{"token":"1:abc","chatId":"42"}')
check('secrets: token only is none', telegramFrom({ BLINKDEAL_TELEGRAM_TOKEN: '1:abc' }) === null)
check('secrets: chat only is none', telegramFrom({ BLINKDEAL_TELEGRAM_CHAT: '42' }) === null)
check('secrets: blank is none', telegramFrom({ BLINKDEAL_TELEGRAM_TOKEN: '', BLINKDEAL_TELEGRAM_CHAT: ' ' }) === null)
check('secrets: the phone\'s channel name is not the chat', telegramFrom({ BLINKDEAL_TELEGRAM_TOKEN: '1:abc', BLINKDEAL_TELEGRAM_CHANNEL: '@ccbuddy_blinkdeal' }) === null)

// ---- one run, against a stubbed GitHub and Telegram ----

/** An in-memory issues API that answers what run() asks and records it. */
function fakeGitHub(issues = []) {
  const calls = []
  let next = 100
  const api = async (path, init = {}) => {
    const method = init.method ?? 'GET'
    const req = init.body ? JSON.parse(init.body) : null
    calls.push({ method, path, req })
    if (method === 'GET' && path === '/issues?state=open&per_page=100') return issues.filter((i) => i.state === 'open').map((i) => ({ ...i }))
    if (method === 'POST' && path === '/issues') {
      const i = { number: next++, title: req.title, body: req.body, state: 'open', user: { login: BOT } }
      issues.push(i)
      return { ...i }
    }
    let m = path.match(/^\/issues\/(\d+)$/)
    if (method === 'PATCH' && m) {
      const i = issues.find((x) => x.number === Number(m[1]))
      Object.assign(i, req)
      return { ...i }
    }
    m = path.match(/^\/issues\/(\d+)\/comments$/)
    if (method === 'POST' && m) return { id: 1 }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { api, calls, issues }
}

const TOKEN = '123456:NOT-A-REAL-TOKEN'
const CHAT = '987654321'
const outFrom = Date.parse(before.checkedAt)
const outTo = Date.parse(after.checkedAt)
const STALE_AT = outFrom + 47 * 60000 // the first Worker nudge, 13:46 UTC
const logs = []
const log = (line) => logs.push(line)
const messages = []
const okDm = async (text) => { messages.push(text) }
const badDm = async () => { throw new Error('telegram HTTP 502: Bad Gateway') }

{
  // No secrets: the issue opens as it always has, owing the message.
  const g = fakeGitHub()
  const out = await run({ feed: before, nowMs: STALE_AT, gh: g.api, dm: null, log })
  check('no secrets: the issue opens', out.action === 'open' && g.issues.length === 1)
  check('no secrets: no message, marked owed', out.dm === 'skipped' && messages.length === 0 && readMarker(g.issues[0].body)?.dm === 'due')
  check('no secrets: the marker holds the last update', readMarker(g.issues[0].body)?.from === outFrom)
  check('no secrets: the issue still says how to restart', g.issues[0].body.includes('bash scraper/watch-termux.sh'))
}
{
  // One outage, end to end: a failed message, its retry, no repeat, then back.
  const g = fakeGitHub()
  const first = await run({ feed: before, nowMs: STALE_AT, gh: g.api, dm: badDm, log })
  check('a failed message still opens the issue', first.action === 'open' && first.dm === 'failed' && g.issues.length === 1)
  check('…marked owed', readMarker(g.issues[0].body)?.dm === 'due')
  check('…and the failure is logged without a body', logs.at(-1) === 'watchdog: quiet message failed: telegram HTTP 502: Bad Gateway', logs.at(-1))

  const second = await run({ feed: before, nowMs: STALE_AT + 5 * 60000, gh: g.api, dm: okDm, log })
  check('the next stale run sends it', second.action === 'none' && second.dm === 'sent' && messages.length === 1)
  check('…the words of the day', messages[0] === 'BLINKDEAL phone went quiet at 6:29 pm.', messages[0])
  check('…and marks it sent', readMarker(g.issues[0].body)?.dm === 'sent')
  check('…without opening a second issue', g.issues.length === 1 && g.calls.filter((c) => c.method === 'POST' && c.path === '/issues').length === 1)

  const third = await run({ feed: before, nowMs: STALE_AT + 65 * 60000, gh: g.api, dm: okDm, log })
  check('the run after sends nothing more', third.dm === 'none' && messages.length === 1)

  const fourth = await run({ feed: after, nowMs: outTo + 40 * 1000, gh: g.api, dm: okDm, log })
  check('fresh again: the issue closes', fourth.action === 'close' && g.issues[0].state === 'closed')
  check('…with the comment it always had', g.calls.some((c) => c.path === `/issues/${g.issues[0].number}/comments` && c.req.body.startsWith('Back up: the feed was written')))
  check('…and "back" goes out', fourth.dm === 'sent' && messages.at(-1) === 'BLINKDEAL phone is back. Quiet 4 Oct, 6:29 pm to 29 Oct, 1:09 pm.', messages.at(-1))
  check('…the issue closes before the message is sent', g.calls.at(-1).method === 'PATCH' && g.calls.at(-1).req.state === 'closed')

  const fifth = await run({ feed: after, nowMs: outTo + 5 * 60000, gh: g.api, dm: okDm, log })
  check('after that, nothing', fifth.action === 'none' && fifth.dm === 'none' && messages.length === 2)
}
{
  // Open and message in one run.
  const g = fakeGitHub()
  const before2 = messages.length
  const out = await run({ feed: before, nowMs: STALE_AT, gh: g.api, dm: okDm, log })
  check('secrets and Telegram up: opened and told in one run', out.action === 'open' && out.dm === 'sent' && messages.length === before2 + 1)
  check('…and the marker says sent', readMarker(g.issues[0].body)?.dm === 'sent')
}
{
  // "Back" only to someone who was told it stopped.
  const due = { number: 9, title: TITLE, state: 'open', user: { login: BOT }, body: withMarker(issueBody(outFrom), { from: outFrom, dm: 'due' }) }
  const g = fakeGitHub([due])
  const n = messages.length
  const out = await run({ feed: after, nowMs: outTo + 60000, gh: g.api, dm: okDm, log })
  check('never told: closes without "back"', out.action === 'close' && out.dm === 'none' && messages.length === n && due.state === 'closed')
}
{
  // An issue from before the marker closes as it always did, silently.
  const legacy = { number: 1, title: TITLE, state: 'open', user: { login: BOT }, body: issueBody(outFrom) }
  const g = fakeGitHub([legacy])
  const n = messages.length
  const stale = await run({ feed: before, nowMs: STALE_AT + 3600000, gh: g.api, dm: okDm, log })
  check('legacy, still down: left alone, no message', stale.action === 'none' && stale.dm === 'none' && messages.length === n && g.calls.length === 1)
  const out = await run({ feed: after, nowMs: outTo + 60000, gh: g.api, dm: okDm, log })
  check('legacy, back: closed with no message', out.action === 'close' && out.dm === 'legacy' && messages.length === n && legacy.state === 'closed')
}
{
  // Someone else's issue with the title neither stands in for an outage nor silences one.
  const fake = { number: 2, title: TITLE, state: 'open', user: { login: 'someone' }, body: '' }
  const g = fakeGitHub([fake])
  const out = await run({ feed: before, nowMs: STALE_AT, gh: g.api, dm: okDm, log })
  check('their issue does not silence an outage', out.action === 'open' && g.issues.filter((i) => i.user.login === BOT).length === 1)
  const g2 = fakeGitHub([{ ...fake }])
  const fresh = await run({ feed: after, nowMs: outTo + 60000, gh: g2.api, dm: okDm, log })
  check('…and is never closed by the watchdog', fresh.action === 'none' && g2.issues[0].state === 'open' && g2.calls.length === 1)
}
{
  // Sent, then the marker write fails: the run fails, and the next one sends again.
  const due = { number: 11, title: TITLE, state: 'open', user: { login: BOT }, body: withMarker(issueBody(outFrom), { from: outFrom, dm: 'due' }) }
  const g = fakeGitHub([due])
  const flaky = async (path, init = {}) => {
    if (init.method === 'PATCH') throw new Error('PATCH: 502')
    return g.api(path, init)
  }
  const n = messages.length
  let threw = false
  try { await run({ feed: before, nowMs: STALE_AT, gh: flaky, dm: okDm, log }) } catch { threw = true }
  check('a marker that cannot be written fails the run', threw && messages.length === n + 1 && readMarker(due.body)?.dm === 'due')
  await run({ feed: before, nowMs: STALE_AT + 5 * 60000, gh: g.api, dm: okDm, log })
  check('…and the next run sends it again (a duplicate, never silence)', messages.length === n + 2 && readMarker(due.body)?.dm === 'sent')
}
check('no log line names the token or the chat', logs.every((l) => !l.includes(TOKEN) && !l.includes(CHAT)), logs.find((l) => l.includes(TOKEN) || l.includes(CHAT)))

// ---- sendDm against a stubbed Telegram ----
{
  const cfg = { token: TOKEN, chatId: CHAT }
  const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  const stub = (answers) => {
    const calls = []
    const fn = async (url, init) => {
      calls.push({ url, init })
      const a = answers[Math.min(calls.length - 1, answers.length - 1)]
      if (a instanceof Error) throw a
      return typeof a === 'function' ? a() : a
    }
    return { fn, calls }
  }
  const sleeps = []
  const sleep = async (ms) => { sleeps.push(ms) }

  let readOk = false
  const okReply = { ok: true, status: 200, json: async () => { readOk = true; return {} }, text: async () => { readOk = true; return '' }, body: { cancel: async () => {} } }
  const s = stub([okReply])
  check('sendDm: sent', (await sendDm(cfg, 'hello', { fetch: s.fn, sleep })) === 'sent' && s.calls.length === 1)
  check('sendDm: to sendMessage with the bot token', s.calls[0].url === `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  check('sendDm: POST, JSON', s.calls[0].init.method === 'POST' && s.calls[0].init.headers['content-type'] === 'application/json')
  check('sendDm: the body is the chat, the text, no preview', s.calls[0].init.body === JSON.stringify({ chat_id: CHAT, text: 'hello', disable_web_page_preview: true }), s.calls[0].init.body)
  check('sendDm: a timeout on every try', s.calls[0].init.signal instanceof AbortSignal)
  check('sendDm: the reply, which names the owner, is never read', readOk === false)

  sleeps.length = 0
  const busy = stub([reply(429, { ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }), okReply])
  check('sendDm: a 429 waits as asked, then sends', (await sendDm(cfg, 'x', { fetch: busy.fn, sleep })) === 'sent' && busy.calls.length === 2 && sleeps[0] === 7000, JSON.stringify(sleeps))

  sleeps.length = 0
  const greedy = stub([reply(429, { parameters: { retry_after: 999 } }), okReply])
  await sendDm(cfg, 'x', { fetch: greedy.fn, sleep })
  check('sendDm: …but never more than 30 s', sleeps[0] === 30000, JSON.stringify(sleeps))

  const down = stub([() => reply(502, { description: 'Bad Gateway' })])
  let err = null
  try { await sendDm(cfg, 'x', { fetch: down.fn, sleep }) } catch (e) { err = e }
  check('sendDm: three tries at most', down.calls.length === 3 && err?.message === 'telegram HTTP 502: Bad Gateway', `${down.calls.length} ${err?.message}`)

  const flaky = stub([new TypeError('fetch failed'), () => reply(500, {}), okReply])
  check('sendDm: a network error and a 5xx are retried', (await sendDm(cfg, 'x', { fetch: flaky.fn, sleep })) === 'sent' && flaky.calls.length === 3)

  const gone = stub([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })])
  err = null
  try { await sendDm(cfg, 'x', { fetch: gone.fn, sleep }) } catch (e) { err = e }
  check('sendDm: unreachable says so, by name and code', gone.calls.length === 3 && err?.message === 'telegram unreachable: TypeError ENOTFOUND', err?.message)

  const wrong = stub([reply(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })])
  err = null
  try { await sendDm(cfg, 'x', { fetch: wrong.fn, sleep }) } catch (e) { err = e }
  check('sendDm: a 4xx is an answer, not retried', wrong.calls.length === 1 && err?.message === 'telegram HTTP 400: Bad Request: chat not found', err?.message)

  const leaky = stub([reply(401, { description: `Unauthorized: bot${TOKEN} rejected` })])
  err = null
  try { await sendDm(cfg, 'x', { fetch: leaky.fn, sleep }) } catch (e) { err = e }
  check('sendDm: the token never appears in an error', err && !err.message.includes(TOKEN) && err.message.includes('<token>'), err?.message)
  check('sendDm: nor the chat id', err && !err.message.includes(CHAT))
}

// ---- the workflow ----
{
  // A Windows checkout may hand this CRLF; Actions hands it LF.
  const yml = (await readFile(new URL('../.github/workflows/watchdog.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  const steps = yml.split(/\n(?=\s+- (?:uses|run|name):)/)
  check('workflow: runs on a phone push of the feed', /\n {2}push:\n {4}branches: \[master\]\n {4}paths: \[docs\/blinkdeal\.json\]\n/.test(yml))
  check('workflow: still on a schedule', /\n {2}schedule:\n {4}- cron: /.test(yml))
  check('workflow: a dispatch can ask for the test message', /workflow_dispatch:\n {4}inputs:\n {6}mode:/.test(yml) && /options: \[check, test-dm\]/.test(yml) && /default: check/.test(yml))
  const watch = steps.find((s) => s.includes('node scraper/watchdog.mjs')) ?? ''
  check('workflow: the watchdog step gets both secrets', watch.includes('BLINKDEAL_TELEGRAM_TOKEN: ${{ secrets.BLINKDEAL_TELEGRAM_TOKEN }}') && watch.includes('BLINKDEAL_TELEGRAM_CHAT: ${{ secrets.BLINKDEAL_TELEGRAM_CHAT }}'), watch)
  check('workflow: …and the mode', watch.includes("MODE: ${{ inputs.mode || 'check' }}"))
  check('workflow: …and its own token', watch.includes('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'))
  const whapi = steps.find((s) => s.includes('wa-post.mjs --mode health')) ?? ''
  check('workflow: the Whapi check runs on the schedule only', whapi.includes("if: github.event_name == 'schedule'"), whapi)
  const code = yml.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n')
  check('workflow: the secrets go to the watchdog step alone', (code.match(/BLINKDEAL_TELEGRAM_/g) ?? []).length === 4 && !whapi.includes('BLINKDEAL_TELEGRAM'))
  check('workflow: one run at a time, none cancelled', /concurrency:\n {2}group: watchdog\n {2}cancel-in-progress: false/.test(yml))
  check('workflow: a time limit', /timeout-minutes: 3/.test(yml))
  check('workflow: no wider permissions than before', /permissions:\n {2}contents: read\n {2}issues: write\n\n/.test(yml))
}

console.log(`watchdog: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
