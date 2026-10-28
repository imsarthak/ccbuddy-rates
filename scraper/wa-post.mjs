// BLINKDEAL windows to the WhatsApp Channel, through Whapi.Cloud, from
// GitHub Actions.
//
// Meta's Cloud API cannot post to Channels. Whapi can: it holds a linked-device
// session of a WhatsApp number and posts as that number. The number linked is
// a SPARE one that the owner made a channel admin. The owner's own number is
// never linked — a ban there would take the channel with it — and the poster
// refuses to post if it ever finds the owner on the other end. Setup, and the
// steps only the owner can do: docs/whatsapp-poster.md.
//
// .github/workflows/wa-post.yml runs this on every phone push that touches
// docs/blinkdeal.json, and compares the feed before the push with after it:
//   a window opening   one post
//   a window ending    that post edited in place ("Over at 6:58 pm …"), so
//                      followers are pinged once per window, not twice
//   anything else      nothing (most pushes are heartbeats)
//
// A window is `${code}-${lastLive.from}`, never the coupon id: Myntra reuses
// one id across windows, days apart and twice in a day. Each opening is in
// exactly one push, so the diff alone posts once; the ledger (one Actions
// cache entry per window, written only after a real post) is what makes a
// duplicate run harmless and what the close needs to find the post to edit.
//
// Posting is OFF until the repo variable WA_DRY_RUN is 0 and both secrets
// exist. Until then every run prints the exact post and calls nothing.
//
//   --edge --before <f> --after <f> [--history <f>] [--out <f>]
//                         work out the edge; open_key/close_key/any to $GITHUB_OUTPUT
//   --post --edge-file <f>   post or edit it (print it, when dry)
//   --mode preview        print both posts from the captured window; no network
//   --mode check          session status and this number's role; read-only
//   --mode test-post      post the captured window to WA_TEST_CHANNEL_ID, then
//                         edit it; refuses the real channel
//   --mode health         the watchdog's probe: pause if the session dropped
//
// Environment: WHAPI_TOKEN, WHAPI_CHANNEL_ID (secrets); WA_DRY_RUN, WA_CLOSE,
// WA_TEST_CHANNEL_ID (repo variables); GITHUB_TOKEN, GITHUB_REPOSITORY,
// GITHUB_EVENT_NAME, GITHUB_RUN_ATTEMPT, GITHUB_OUTPUT (Actions); WHAPI_BASE
// (tests point it at a local fake).
//
// The repo is public, and so are its Actions logs and issues. Nothing here
// prints the token, the channel id, the linked number or a raw Whapi
// response; the token travels only in the Authorization header.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEMPLATES, bestByWeight, brandName, istClock, formatDuration } from './notify.mjs'
import { gh as githubApi, ist } from './watchdog.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const WHAPI = 'https://gate.whapi.cloud'
export const LEDGER_DIR = join(ROOT, '.wa-ledger')
export const PAUSE_TITLE = 'WhatsApp poster is paused'

// A post more than this long after the window opened is news about a deal
// that is nearly over (they run ~35 min): the phone was offline, or the
// runner queued. Say nothing rather than say it late.
export const OPEN_MAX_AGE_MS = 15 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000
const TIMEOUT_MS = 15000
// Whapi: a session reconnects "once or several times a day" for 2-3 s, and
// sends in that gap answer 401. A few spaced retries ride it out. Nothing
// else is ever retried: a 429 is a soft ban, and a 5xx may have been sent.
const RETRY_401 = 3
const RETRY_GAP_MS = 3000
const VERIFY_AFTER_MS = 15000
const TEST_EDIT_AFTER_MS = 20000
const REST_MS = 2 * 24 * 3600 * 1000 // Whapi's advice after a 429: rest "a day or two"

const CODE_OK = /^[A-Z0-9]{3,30}$/i
const KEY_OK = /^[A-Z0-9]{3,30}-\d{10,16}$/i
const NEWSLETTER_OK = /^\d{10,18}@newsletter$/
// Whapi's MessageID pattern (OpenAPI 1.8.7, `edit` on POST /messages/text).
const MESSAGE_ID_OK = /^[A-Za-z0-9._]{4,30}-[A-Za-z0-9._]{4,30}(-[A-Za-z0-9._]{2,30})?(-[A-Za-z0-9._]{2,30})?$/
// Session states that settle by themselves in seconds; anything else needs a hand.
const SETTLING = new Set(['NOT_INIT', 'INIT', 'LAUNCH'])
// States the watchdog probe pauses on: each needs the owner, none fixes itself.
const DROPPED = new Set(['QR', 'STOP', 'BANNED'])

// ---- The edge ---------------------------------------------------------------

/** The window a feed is showing, as `${code}-${fromMs}`; null when not live or unusable. */
export function windowKey(feed) {
  if (!feed || typeof feed !== 'object' || feed.live !== true) return null
  const code = feed.lastLive?.code ?? feed.code
  const from = Date.parse(feed.lastLive?.from ?? '')
  if (typeof code !== 'string' || !CODE_OK.test(code) || !Number.isFinite(from)) return null
  return `${code}-${from}`
}

/**
 * What a post needs from a live feed, checked: anything malformed is dropped
 * rather than printed, and the only link taken from the feed is a Myntra one.
 * This is also what the ledger keeps, so the edit re-renders the same rows.
 */
export function postData(feed) {
  const code = feed.lastLive?.code ?? feed.code
  const skus = Array.isArray(feed.skus) ? feed.skus : []
  const pct = Number(feed.discountPct) || Number(/(\d+)\s*$/.exec(code)?.[1]) || null
  const count = Number.isInteger(feed.totalCount) && feed.totalCount > 0 ? feed.totalCount : skus.length || null
  const source = typeof feed.source === 'string' && /^https:\/\/www\.myntra\.com\/\S*$/.test(feed.source) ? feed.source : null
  return {
    code,
    pct: pct > 0 && pct < 100 ? pct : null,
    count,
    from: new Date(Date.parse(feed.lastLive.from)).toISOString(),
    rows: bestByWeight(skus).map((r) => ({ ...r, brand: brandName(r.brand) })),
    source,
  }
}

export function renderOpen(data) {
  return TEMPLATES.waOpen({ ...data, since: istClock(Date.parse(data.from)) })
}

export function renderOver(data, to) {
  const from = Date.parse(data.from)
  const end = Date.parse(to ?? '')
  const known = Number.isFinite(end) && end >= from
  return TEMPLATES.waOver({
    ...data,
    since: istClock(from),
    until: known ? istClock(end) : null,
    duration: known ? formatDuration(end - from) : null,
  })
}

// When the window in `before` ended: the feed after the push, or the history
// file, records it when the close is in this push.
function endOf(before, after, history) {
  const code = before.lastLive?.code ?? before.code
  const from = Date.parse(before.lastLive.from)
  const seen = [after?.lastLive, ...[...(Array.isArray(history?.windows) ? history.windows : [])].reverse()]
  const w = seen.find((x) => x && x.code === code && Date.parse(x.from) === from && x.to)
  const to = Date.parse(w?.to ?? '')
  return Number.isFinite(to) ? new Date(to).toISOString() : null
}

/**
 * The edge one push makes, from the feed before it and after it. Pure.
 *   open   the feed now shows a window it did not show before, opened at most
 *          OPEN_MAX_AGE_MS ago
 *   close  the feed showed a window that it no longer shows, on a good read
 * Both at once when a push jumps from one window straight to another (the
 * phone was offline across a quiet spell). A failed read (ok: false) never
 * opens or closes anything, as in blinkdeal.mjs, and a window that opened and
 * closed between two pushes gets nothing: it is over before anyone could act.
 */
export function edge(before, after, nowMs = Date.now(), history = null) {
  const out = { open: null, close: null, notes: [] }
  if (!after || typeof after !== 'object' || after.ok !== true) {
    out.notes.push('the feed after this push is not a good read; a failed read never opens or closes a window')
    return out
  }
  const was = windowKey(before)
  const now = windowKey(after)
  if (before?.live === true && !was) out.notes.push('the feed before this push says live but its window is unreadable; nothing to close')
  if (after.live === true && !now) out.notes.push('the feed says live but its window is unreadable; not posting')
  if (was && was !== now) out.close = { key: was, data: postData(before), to: endOf(before, after, history) }
  if (now && now !== was) {
    const age = nowMs - Date.parse(after.lastLive.from)
    if (age > OPEN_MAX_AGE_MS) out.notes.push(`${now} opened ${Math.round(age / 60000)} min before this run; too late to post`)
    else if (age < -CLOCK_SKEW_MS) out.notes.push(`${now} opens in the future; not posting a feed that says so`)
    else out.open = { key: now, data: postData(after) }
  }
  return out
}

// ---- The ledger ---------------------------------------------------------------

export async function readLedger(dir, key) {
  if (!KEY_OK.test(key ?? '')) return null
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function writeLedger(dir, key, entry) {
  if (!KEY_OK.test(key)) throw new Error(`refusing ledger key ${key}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${key}.json`), `${JSON.stringify(entry, null, 1)}\n`)
}

// ---- Whapi ----------------------------------------------------------------------

export class WhapiError extends Error {
  constructor(what, status, detail) {
    super(`Whapi ${what}: ${status ? `HTTP ${status}` : 'no answer'}${detail ? ` (${detail})` : ''}`)
    this.status = status
  }
}

/** Strip anything that could be a secret or a number out of text from outside. */
export function redact(text, secrets = []) {
  let s = String(text ?? '')
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join('<redacted>')
  return s.replace(/\d{6,}/g, '<n>').replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * A minimal client. `what` names the call in errors and logs, so neither ever
 * carries a path with the channel or message id in it.
 */
export function whapi({ token, base = WHAPI, fetch: fetchFn, timeoutMs = TIMEOUT_MS }) {
  const doFetch = fetchFn ?? ((...a) => globalThis.fetch(...a))
  return async function call(what, method, path, body) {
    let res
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new WhapiError(what, 0, e?.name === 'TimeoutError' ? 'timed out' : 'network error')
    }
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new WhapiError(what, res.status, redact(json?.error?.message, [token]))
    return json ?? {}
  }
}

async function sessionStatus(call, sleep, { wakeup }) {
  let status = 'UNKNOWN'
  for (let i = 0; i < 3; i++) {
    const h = await call('health', 'GET', wakeup ? '/health' : '/health?wakeup=false')
    status = /^[A-Z_]{1,20}$/.test(h?.status?.text ?? '') ? h.status.text : 'UNKNOWN'
    if (!SETTLING.has(status) || !wakeup) break
    if (i < 2) await sleep(RETRY_GAP_MS)
  }
  return status
}

/** This number's role in a channel. Whapi renamed role to user_role (changelog 2026-04-21); read both. */
async function roleIn(call, channelId) {
  const pick = (n) => (n && typeof n === 'object' ? n.user_role ?? n.role ?? null : null)
  try {
    // `@` is legal in a path segment; every caller has checked the id's shape.
    const one = await call('channel', 'GET', `/newsletters/${channelId}`)
    if (pick(one)) return { role: String(pick(one)), name: typeof one.name === 'string' ? one.name : null }
  } catch (e) {
    if (!(e instanceof WhapiError) || (e.status !== 400 && e.status !== 404)) throw e
  }
  const list = await call('channels', 'GET', '/newsletters?count=100')
  const n = (Array.isArray(list?.newsletters) ? list.newsletters : []).find((x) => x?.id === channelId)
  return { role: pick(n) ? String(pick(n)) : null, name: typeof n?.name === 'string' ? n.name : null }
}

/** Is it safe to post to this channel right now? Every refusal is a pause reason. */
async function preflight(call, channelId, sleep) {
  const status = await sessionStatus(call, sleep, { wakeup: true })
  if (status !== 'AUTH') return { reason: REASONS.session(status) }
  const { role, name } = await roleIn(call, channelId)
  if (role === 'owner') return { reason: REASONS.owner() }
  if (role !== 'admin') return { reason: REASONS.notAdmin(role) }
  return { status, role, name }
}

async function send(call, body, { sleep, log }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(body.edit ? 'edit' : 'send', 'POST', '/messages/text', body)
    } catch (e) {
      if (e instanceof WhapiError && e.status === 401 && attempt <= RETRY_401) {
        log(`Whapi 401, the session may be reconnecting: retry ${attempt} of ${RETRY_401} in ${RETRY_GAP_MS / 1000} s`)
        await sleep(RETRY_GAP_MS)
        continue
      }
      throw e
    }
  }
}

/** A 200 is not delivery (Whapi: unsupported posts sit in `pending`). Look once. */
async function verify(call, id, { sleep, log }) {
  await sleep(VERIFY_AFTER_MS)
  try {
    const m = await call('status', 'GET', `/messages/${encodeURIComponent(id)}`)
    const status = /^[a-z_]{1,20}$/.test(m?.status ?? '') ? m.status : 'unknown'
    log(`status of ${id}: ${status}`)
    return status
  } catch (e) {
    if (e instanceof WhapiError && e.status === 429) throw e
    log(`could not read the post's status (${e.message}); Whapi accepted it with a 200`)
    return null
  }
}

// ---- Pausing ----------------------------------------------------------------------
//
// One GitHub issue is the off switch. Any answer that needs the owner opens
// it; while it is open the poster calls Whapi not at all and only notes each
// window it skipped. Closing it is the only way back on, on purpose: after a
// 429 the number needs a day or two of rest, and only a person knows when.
// Issues are public here, so the bodies carry no names and no numbers.

const CLOSE_TO_RESUME = 'Close this issue to resume posting.'

export const REASONS = {
  softBan: (nowMs) => ({
    kind: 'soft-ban',
    title: 'Whapi answered 429 Too Many Requests: WhatsApp has soft-blocked the spare number.',
    steps: [
      `Rest the number: no posts and no test runs until at least ${ist(nowMs + REST_MS)} IST.`,
      'Then open WhatsApp on the spare phone and use it normally for a few minutes.',
      CLOSE_TO_RESUME,
    ],
  }),
  session: (status) =>
    status === 'QR'
      ? {
          kind: 'logged-out',
          title: "The spare number's Whapi session is logged out (status QR).",
          steps: [
            'On the spare phone: WhatsApp → Linked devices → Link a device, and scan the QR code in the Whapi dashboard.',
            'Open WhatsApp on the spare phone at least every 10 days: WhatsApp drops linked devices after 14 days without the phone.',
            CLOSE_TO_RESUME,
          ],
        }
      : status === 'STOP'
        ? {
            kind: 'stopped',
            title: 'The Whapi channel is stopped (status STOP): the plan or trial has ended.',
            steps: ['Renew it in the Whapi dashboard.', CLOSE_TO_RESUME],
          }
        : status === 'BANNED'
          ? {
              kind: 'banned',
              title: 'WhatsApp has banned the spare number (status BANNED).',
              steps: [
                'From your own number: Channel info → Admins → dismiss the spare number.',
                'Set up a new spare SIM as in docs/whatsapp-poster.md, and update the WHAPI_TOKEN secret if the Whapi channel changed.',
                CLOSE_TO_RESUME,
              ],
            }
          : {
              kind: 'not-connected',
              title: `The Whapi session is not connected (status ${status}).`,
              steps: [
                'Open the Whapi dashboard and look at the channel; restart it there if it offers to.',
                'Run the "BLINKDEAL to WhatsApp Channel" workflow with mode check: it should report AUTH.',
                CLOSE_TO_RESUME,
              ],
            },
  owner: () => ({
    kind: 'owner-linked',
    title: 'The number linked to Whapi is the channel OWNER. It must never be.',
    steps: [
      'On the phone with the owner number: WhatsApp → Linked devices → log out the Whapi device. Do it now: a ban on that number takes the channel with it.',
      'Link the spare admin number instead (docs/whatsapp-poster.md).',
      CLOSE_TO_RESUME,
    ],
  }),
  notAdmin: (role) => ({
    kind: 'not-admin',
    title: `The linked number is not an admin of the channel (${role ? `its role is ${String(role).replace(/[^a-z_]/gi, '').slice(0, 20)}` : 'the channel was not found'}).`,
    steps: [
      'From your own number: Channel info → Invite admins → the spare number, then accept on the spare phone within 7 days.',
      "Check the WHAPI_CHANNEL_ID secret is the real channel's …@newsletter id.",
      CLOSE_TO_RESUME,
    ],
  }),
  http: (status) =>
    status === 401
      ? {
          kind: 'unauthorised',
          title: 'Whapi kept answering 401: the token or the session is not authorised.',
          steps: [
            'Check the WHAPI_TOKEN secret matches the token in the Whapi dashboard.',
            'If it does, look for a QR code in the dashboard: the spare phone needs re-linking.',
            CLOSE_TO_RESUME,
          ],
        }
      : status === 402
        ? {
            kind: 'plan-limit',
            title: 'Whapi answered 402: the plan or trial limit is used up.',
            steps: ['Check the plan in the Whapi dashboard.', CLOSE_TO_RESUME],
          }
        : status === 403
          ? {
              kind: 'forbidden',
              title: 'Whapi answered 403: this number may not post to the channel.',
              steps: [
                'From your own number: check the spare number is still a channel admin; invite it again if not.',
                CLOSE_TO_RESUME,
              ],
            }
          : status === 404
            ? {
                kind: 'not-found',
                title: 'Whapi answered 404: the channel was not found.',
                steps: ["Check the WHAPI_CHANNEL_ID secret is the real channel's …@newsletter id.", CLOSE_TO_RESUME],
              }
            : {
                kind: `http-${status}`,
                title: `Whapi refused the request (HTTP ${status}).`,
                steps: ["Whapi's reason is in the run's log, on the line before PAUSED.", CLOSE_TO_RESUME],
              },
  failed: () => ({
    kind: 'failed',
    title: 'WhatsApp marked the post as failed.',
    steps: [
      'Open the channel on your phone. If the post is missing, the spare number may be restricted on linked devices.',
      'Wait a day, then run the workflow with mode test-post.',
      CLOSE_TO_RESUME,
    ],
  }),
}

export function pauseBody(reason, nowMs) {
  return [
    reason.title,
    '',
    '**The WhatsApp poster is paused.** While this issue is open it posts nothing and does not call Whapi.',
    '',
    ...reason.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `_Opened by .github/workflows/wa-post.yml, ${ist(nowMs)} IST._`,
  ].join('\n')
}

async function findPause(gh) {
  const open = await gh('/issues?state=open&per_page=100')
  return (Array.isArray(open) ? open : []).find((i) => !i.pull_request && i.title === PAUSE_TITLE) ?? null
}

async function pause(gh, reason, nowMs, log) {
  const open = await findPause(gh)
  if (open) {
    const body = [`Also: ${reason.title}`, '', ...reason.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n')
    await gh(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
  } else {
    await gh('/issues', { method: 'POST', body: JSON.stringify({ title: PAUSE_TITLE, body: pauseBody(reason, nowMs) }) })
  }
  log(`PAUSED: ${reason.title}`)
  return reason.kind
}

// ---- Acting on the edge -------------------------------------------------------------

/** Trimmed config, and why this run may not post (null when it may). */
export function settings(env) {
  const token = (env.WHAPI_TOKEN ?? '').trim()
  const channelId = (env.WHAPI_CHANNEL_ID ?? '').trim()
  let dry = null
  if ((env.WA_DRY_RUN ?? '').trim() !== '0') dry = 'the repo variable WA_DRY_RUN is not 0'
  else if (!token) dry = 'the WHAPI_TOKEN secret is not set'
  else if (!NEWSLETTER_OK.test(channelId)) dry = 'the WHAPI_CHANNEL_ID secret is not a …@newsletter id'
  else if (env.GITHUB_EVENT_NAME !== 'push') dry = 'only a push run posts'
  else if ((env.GITHUB_RUN_ATTEMPT ?? '1') !== '1') dry = 'a re-run never posts: the first attempt may already have'
  return { token, channelId, dry, close: (env.WA_CLOSE ?? '').trim().toLowerCase() !== 'off', base: env.WHAPI_BASE || WHAPI }
}

const describe = (e) => `${e.data.code} live since ${istClock(Date.parse(e.data.from))}`

/**
 * Post, edit or print the edge. `deps`: { fetch, gh, sleep, log, now, output }.
 * Returns what happened, for the workflow and the tests:
 *   { posted: key|null, edited: messageId|null, paused: kind|null, dry: reason|null }
 * Throws only on what nobody can know the outcome of (a 5xx, a timeout), so
 * the run fails and GitHub emails about it; the post is never retried.
 */
export async function runEdge(e, { env, ledgerDir = LEDGER_DIR, deps = {} }) {
  const log = deps.log ?? console.log
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const result = { posted: null, edited: null, paused: null, dry: null }
  for (const n of e.notes ?? []) log(n)
  if (!e.open && !e.close) {
    log('no edge: nothing to post')
    return result
  }
  const cfg = settings(env)

  if (cfg.dry) {
    result.dry = cfg.dry
    log(`DRY RUN: ${cfg.dry}. Nothing is sent; this is what would go out.`)
    if (e.open) log(`\nwould post (${e.open.key}):\n${renderOpen(e.open.data)}`)
    if (e.close) {
      log(`\nwould edit the post for ${e.close.key}${cfg.close ? '' : ' (but WA_CLOSE is off, so it would not)'} to:\n${renderOver(e.close.data, e.close.to)}`)
    }
    return result
  }

  const openDone = e.open ? await readLedger(ledgerDir, e.open.key) : null
  const closeOf = e.close ? await readLedger(ledgerDir, e.close.key) : null
  if (openDone) log(`${e.open.key} was already posted as ${openDone.messageId ?? '(no id)'}; not posting it again`)
  if (e.close && !closeOf) log(`${e.close.key}: no post on record (the run was dry, late, or failed); nothing to edit`)
  if (e.close && closeOf && !closeOf.messageId) log(`${e.close.key}: Whapi gave no message id for it; cannot edit in the end`)
  if (e.close && closeOf?.messageId && !cfg.close) log('WA_CLOSE is off: leaving the post as it is')
  const doOpen = e.open && !openDone
  const doClose = e.close && closeOf?.messageId && cfg.close
  if (!doOpen && !doClose) return result

  const gh = deps.gh ?? githubApi
  const held = await findPause(gh)
  if (held) {
    const what = [doOpen && describe(e.open), doClose && `the end of ${describe(e.close)}`].filter(Boolean).join(' and ')
    await gh(`/issues/${held.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `Skipped ${what}, ${ist(now())} IST: the poster is paused.` }),
    })
    log(`PAUSED (issue #${held.number}): skipped ${what}`)
    result.paused = 'already'
    return result
  }

  const call = whapi({ token: cfg.token, base: cfg.base, fetch: deps.fetch, timeoutMs: deps.timeoutMs })
  try {
    const ok = await preflight(call, cfg.channelId, sleep)
    if (ok.reason) {
      result.paused = await pause(gh, ok.reason, now(), log)
      return result
    }
    log(`session ${ok.status}, role ${ok.role}${ok.name ? ` in "${redact(ok.name)}"` : ''}`)

    // The opening first: it is the news. The end of an older window can wait.
    if (doOpen) {
      const body = renderOpen(e.open.data)
      const sent = await send(call, { to: cfg.channelId, body, no_link_preview: true }, { sleep, log })
      const id = typeof sent?.message?.id === 'string' && MESSAGE_ID_OK.test(sent.message.id) ? sent.message.id : null
      // Record it before anything else can fail: a second post of the same
      // window is the one outcome this must never produce.
      await writeLedger(ledgerDir, e.open.key, { key: e.open.key, messageId: id, data: e.open.data, body, postedAt: new Date(now()).toISOString() })
      result.posted = e.open.key
      await deps.output?.('posted_key', e.open.key)
      log(`POSTED ${id ?? '(Whapi returned no message id, so the end cannot be edited in)'}:\n${body}`)
      if (id && (await verify(call, id, { sleep, log })) === 'failed') {
        result.paused = await pause(gh, REASONS.failed(), now(), log)
        return result
      }
    }
    if (doClose) {
      const body = renderOver(closeOf.data, e.close.to)
      await send(call, { to: cfg.channelId, edit: closeOf.messageId, body, no_link_preview: true }, { sleep, log })
      result.edited = closeOf.messageId
      log(`EDITED ${closeOf.messageId} to:\n${body}`)
    }
  } catch (err) {
    if (err instanceof WhapiError && err.status >= 400 && err.status < 500) {
      log(err.message)
      result.paused = await pause(gh, err.status === 429 ? REASONS.softBan(now()) : REASONS.http(err.status), now(), log)
      return result
    }
    throw err
  }
  return result
}

// ---- Modes run by hand from the Actions tab, and by the watchdog -----------------------

async function captured() {
  const fx = JSON.parse(await readFile(join(ROOT, 'scraper', 'fixtures', 'live-window-2026-09-15.json'), 'utf8'))
  return { ...fx, discountPct: fx.discountPct ?? (Number(/(\d+)\s*$/.exec(fx.code)?.[1]) || null) }
}

/** Both posts from the captured 2026-09-15 window, closed after 36 min, the one exact duration measured. */
export async function runPreview({ log = console.log } = {}) {
  const data = postData(await captured())
  log(`--- open post ---\n${renderOpen(data)}\n`)
  log(`--- the same post, edited when the window ends ---\n${renderOver(data, new Date(Date.parse(data.from) + 36 * 60000).toISOString())}`)
}

/** Read-only: is the session up, and is this number an admin (not the owner) of each channel? */
export async function runCheck({ env, deps = {} }) {
  const log = deps.log ?? console.log
  const cfg = settings(env)
  if (!cfg.token) {
    log('The WHAPI_TOKEN secret is not set.')
    return false
  }
  const call = whapi({ token: cfg.token, base: cfg.base, fetch: deps.fetch, timeoutMs: deps.timeoutMs })
  const status = await sessionStatus(call, deps.sleep, { wakeup: false })
  log(`session: ${status}${status === 'AUTH' ? '' : ' (AUTH is connected)'}`)
  let ready = status === 'AUTH'
  const test = (env.WA_TEST_CHANNEL_ID ?? '').trim()
  for (const [label, id] of [['channel', cfg.channelId], ['test channel', test]]) {
    if (!NEWSLETTER_OK.test(id)) {
      log(`${label}: not set (needs a …@newsletter id)`)
      if (label === 'channel') ready = false
      continue
    }
    const { role, name } = await roleIn(call, id)
    log(`${label}: ${name ? `"${redact(name)}"` : 'not found'}, this number's role: ${role ?? 'none'}`)
    if (label === 'channel' && role !== 'admin') ready = false
    if (role === 'owner') log(`  The OWNER number is linked. Unlink it now: docs/whatsapp-poster.md.`)
  }
  log(ready ? 'Ready: connected, and an admin of the channel.' : 'Not ready: see above.')
  return ready
}

/**
 * The first proof that an admin can post through Whapi: the captured window,
 * headed "TEST POST", to the test channel, then the edit. Never the real one.
 */
export async function runTestPost({ env, deps = {} }) {
  const log = deps.log ?? console.log
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const gh = deps.gh ?? githubApi
  const cfg = settings(env)
  const test = (env.WA_TEST_CHANNEL_ID ?? '').trim()
  const refuse = (why) => {
    log(`Refused: ${why}`)
    return false
  }
  if (!cfg.token) return refuse('the WHAPI_TOKEN secret is not set.')
  if (!NEWSLETTER_OK.test(test)) return refuse("set the repo variable WA_TEST_CHANNEL_ID to the test channel's …@newsletter id.")
  if (test === cfg.channelId) return refuse('WA_TEST_CHANNEL_ID is the real channel. A test only ever goes to a test channel.')
  if (await findPause(gh)) return refuse('the poster is paused. Close the pause issue first.')
  const call = whapi({ token: cfg.token, base: cfg.base, fetch: deps.fetch, timeoutMs: deps.timeoutMs })
  const ok = await preflight(call, test, sleep)
  if (ok.reason) return refuse(ok.reason.title)
  const fx = await captured()
  const data = postData({ ...fx, lastLive: { ...fx.lastLive, from: new Date(now()).toISOString() } })
  const body = `${TEMPLATES.waTest}\n\n${renderOpen(data)}`
  const sent = await send(call, { to: test, body, no_link_preview: true }, { sleep, log })
  const id = typeof sent?.message?.id === 'string' && MESSAGE_ID_OK.test(sent.message.id) ? sent.message.id : null
  log(`POSTED to the test channel as ${id ?? '(no id)'}:\n${body}`)
  if (!id) return false
  const status = await verify(call, id, { sleep, log })
  await sleep(TEST_EDIT_AFTER_MS)
  const over = `${TEMPLATES.waTest}\n\n${renderOver(data, new Date(Date.parse(data.from) + 36 * 60000).toISOString())}`
  await send(call, { to: test, edit: id, body: over, no_link_preview: true }, { sleep, log })
  log(`EDITED ${id} to:\n${over}`)
  log(status === 'failed' ? 'WhatsApp marked the test post failed: see docs/whatsapp-poster.md.' : 'Look at the test channel: the post, then the edit.')
  return status !== 'failed'
}

/** The watchdog's probe, read-only on Whapi. Pauses only on states that need the owner. */
export async function runHealth({ env, deps = {} }) {
  const log = deps.log ?? console.log
  const now = deps.now ?? Date.now
  const gh = deps.gh ?? githubApi
  const cfg = settings(env)
  if (!cfg.token) {
    log('WhatsApp poster: no WHAPI_TOKEN, not set up; skipping')
    return null
  }
  if (await findPause(gh)) {
    log('WhatsApp poster: paused; not probing')
    return 'paused'
  }
  const call = whapi({ token: cfg.token, base: cfg.base, fetch: deps.fetch, timeoutMs: deps.timeoutMs })
  let status
  try {
    status = await sessionStatus(call, deps.sleep, { wakeup: false })
  } catch (err) {
    if (err instanceof WhapiError && err.status >= 400 && err.status < 500) {
      log(err.message)
      return pause(gh, err.status === 429 ? REASONS.softBan(now()) : REASONS.http(err.status), now(), log)
    }
    throw err
  }
  log(`WhatsApp session: ${status}`)
  if (DROPPED.has(status)) return pause(gh, REASONS.session(status), now(), log)
  return status
}

// ---- CLI ----------------------------------------------------------------------------

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function main(argv, env) {
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? null : argv[i + 1] ?? null
  }
  const output = async (k, v) => {
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${k}=${v}\n`)
  }

  if (argv.includes('--edge')) {
    const e = edge(await readJson(flag('--before')), await readJson(flag('--after')), Date.now(), flag('--history') ? await readJson(flag('--history')) : null)
    for (const n of e.notes) console.log(n)
    console.log(`edge: ${[e.open && `open ${e.open.key}`, e.close && `close ${e.close.key}`].filter(Boolean).join(', ') || 'none'}`)
    if (flag('--out')) await writeFile(flag('--out'), `${JSON.stringify(e, null, 1)}\n`)
    await output('open_key', e.open?.key ?? '')
    await output('close_key', e.close?.key ?? '')
    await output('any', e.open || e.close ? '1' : '0')
    return 0
  }
  if (argv.includes('--post')) {
    const e = await readJson(flag('--edge-file'))
    if (!e) throw new Error('--post needs --edge-file from a --edge run')
    await runEdge(e, { env, deps: { output } })
    return 0
  }
  const mode = flag('--mode')
  if (mode === 'preview') {
    await runPreview()
    return 0
  }
  if (mode === 'check') return (await runCheck({ env })) ? 0 : 1
  if (mode === 'test-post') return (await runTestPost({ env })) ? 0 : 1
  if (mode === 'health') {
    await runHealth({ env })
    return 0
  }
  console.error('usage: wa-post.mjs --edge … | --post --edge-file <f> | --mode preview|check|test-post|health')
  return 2
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').toLowerCase().endsWith('/wa-post.mjs')) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(redact(e?.message ?? e, [process.env.WHAPI_TOKEN?.trim()]))
      process.exit(1)
    },
  )
}
