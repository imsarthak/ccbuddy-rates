// The watcher phone posts each BLINKDEAL window's opening to the WhatsApp
// Channel itself, through Whapi.Cloud, and edits it "Over" when it ends.
//
// From GitHub Actions (wa-post.mjs) the post lands 30-40 s after the phone sees
// the window: the whole crawl, the push, the runner's queue and its setup.
// October's windows lasted a median 4 min. From here it goes out the moment
// the plain listing shows the code, beside the Telegram alert and the Telegram
// channel post, once the pause check and the session check (both started
// then) pass: about 1-2 s after the alert on mobile data. It says what is
// known then (the code, its discount, the coupon page). About 3 s after the
// sight, the coupon's first page has the count and the cheapest coins, and
// the post is edited to say them; an edit pings nobody. If the checks are
// still running when the first page comes, the post goes out whole instead,
// with no edit. The words are the same: renderOpen and renderOver from
// wa-post.mjs, TEMPLATES in notify.mjs.
//
// Actions stays the fallback, with no grace period. The send is awaited
// (bounded) before step() returns, so the push that carries a window's opening
// already says who took it: while a window the phone posted (or may have) is
// live, every feed it writes carries `waAt`, and the Actions job stands down
// for that window (edge() in wa-post.mjs). Without `waAt` it posts as it always
// has. Whoever posted a window also ends it: the phone from its own ledger
// here, Actions from its cache.
//
// Bounded. A post not yet at its send when the crawl ends gets SETTLE_MS more
// to reach it. If it does not, it is cut off then, every call it had started
// with it, and Actions takes the window up to SETTLE_MS later than it would
// with no phone. A send, once started, gets PHONE_TIMEOUT_MS of its own. So
// the feed waits at most SETTLE_MS + PHONE_TIMEOUT_MS (about 16 s) after the
// crawl; in a 20-25 s crawl the post is usually out well before it ends.
// Everything else a tick does with Whapi or GitHub after the crawl (the full
// crawl's edit, an "Over" edit, a status read) shares one deadline of
// PHONE_TIMEOUT_MS, so the feed is written, and pushed, soon after.
//
// Exactly once. The ledger is `.wa-ledger/` at the clone root, on the phone
// only (gitignored; nothing in the watcher loop touches ignored files):
//   open.json      the one post that is out and not yet ended. Created
//                  atomically and exclusively BEFORE the send, updated after
//                  it. A post that may have gone out is never sent again.
//                  Every good read that does not show its code live ends it,
//                  so one still on file at an opening of the same code is
//                  that window, not posted again, unless it was posted over
//                  ADOPT_MAX_AGE_MS ago: no window lasts that long, so it is
//                  ended (an "Over" with no time) and the new one is posted.
//                  `stage` is 'first' while the post says only what was known
//                  at sight, 'full' once it carries the coins (none: 'full').
//                  A post adopted at its 'first' stage (its first page never
//                  came, or that tick was cut short) is filled in from this
//                  tick's first page, else by the crawl's edit, else on the
//                  next live ticks (`fill`: EDIT_RETRIES more tries at most,
//                  EDIT_RETRY_GAP_MS apart, each after a pause check).
//                  The Telegram channel's opening keeps its own record beside
//                  it, telegram-open.json (notify.mjs).
//   <key>.json     each ended post, with its edit's state; kept 30 days
//   due.json       the keys of ended posts whose "Over" edit is still owed
//   check.json     the last post, until its status is read once, 15 s or more
//                  after the send (a 200 is not delivery)
//   channel.json   the channel found for this token and the number linked;
//                  found again when it is a day old, the number changes, the
//                  pause issue is seen open, or Whapi answers 401/403/404
//   hold.json      after a 429, or a post WhatsApp marked failed: no Whapi
//                  call before `until` (2 days)
//
// One loop per clone: watch-termux.sh refuses to start a second. Two runs on
// one clone anyway (a hand run beside the loop) still post a window once, and
// both feeds carry `waAt`: the ledger matches a window by its code.
//
// Config: the `whapi` block of .notify.env (notify.mjs), written by --setup.
// No block: nothing at all happens here, not a single call. A block without
// "dryRun": false prints the post it would send. The pause issue on GitHub
// (read without a credential) stops it as it stops Actions; the phone never
// opens or comments on one, it leaves the window to Actions, which does.
//
//   node scraper/wa-phone.mjs --setup   read the token from the clipboard,
//                                       check it read-only, write the block
//   node scraper/wa-phone.mjs --check   the same check with the saved token
//
// Nothing here prints the token, a channel id, a message id or the linked
// number. Docs: docs/whatsapp-poster.md, docs/termux-setup.md.

import { readFile, writeFile, mkdir, rename, unlink, link, readdir, stat } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  whapi, WhapiError, redact, postData, renderOpen, renderOver, endOf, windowKey, findPause, findChannel, roleIn,
  sessionStatus, verify, channelTag, readLedger, writeLedger, REASONS, MESSAGE_ID_OK, NEWSLETTER_OK, KEY_OK,
  REST_MS, VERIFY_AFTER_MS, LEDGER_DIR, WHAPI,
} from './wa-post.mjs'
import { loadConfig } from './notify.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)

export const REPO = 'imsarthak/ccbuddy-rates'
export const GITHUB_API = 'https://api.github.com'
// Every call from the phone, and the one deadline for a tick's WhatsApp work
// after the crawl. A send that has not answered in 8 s is treated as one that
// may have gone out: never sent again.
export const PHONE_TIMEOUT_MS = 8000
// How long step() waits after the crawl for a WhatsApp job that has not yet
// reached its send. Then the job is cut off: the feed is about to be written
// without `waAt`, and Actions will post.
export const SETTLE_MS = 8000
// A post on file of the code now opening is that window only while it is
// younger than this. Every window seen ran well under an hour, and one code
// (BLINKDEAL6) names window after window, so an older one is an earlier
// window whose end nobody saw (its feed lost, then the phone off or every read
// failed): it is ended, and the new window posted.
export const ADOPT_MAX_AGE_MS = 2 * 3600 * 1000
export const CHANNEL_MAX_AGE_MS = 24 * 3600 * 1000
export const EDIT_RETRIES = 3
export const EDIT_RETRY_GAP_MS = 20 * 1000
export const EDIT_MAX_AGE_MS = 24 * 3600 * 1000
export const ARCHIVE_MAX_AGE_MS = 30 * 24 * 3600 * 1000
const TOKEN_OK = /^[A-Za-z0-9_-]{20,200}$/

const OPEN = 'open.json'
const DUE = 'due.json'
const CHECK = 'check.json'
const CHANNEL = 'channel.json'
const HOLD = 'hold.json'

const iso = (ms) => new Date(ms).toISOString()
// A sleep that a deadline ends early, timer and all, so it never holds the process open.
const realSleep = (ms, signal) =>
  new Promise((ok, no) => {
    if (signal?.aborted) return no(signal.reason)
    const stop = () => {
      clearTimeout(t)
      no(signal.reason)
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      ok()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
const roleText = (role) => (role ? String(role).replace(/[^a-z_]/gi, '').slice(0, 20) : 'none')
// The code of the window a feed shows live, or null.
const liveCode = (feed) => (windowKey(feed) ? feed.lastLive?.code ?? feed.code : null)

/** The number linked to the token, as a fingerprint keyed with it: never the number itself. '' when Whapi did not say. */
export const userTag = (token, id) => (id ? createHmac('sha256', token).update(`user:${id}`).digest('hex').slice(0, 16) : '')

/** One GET /health: the session's status and the number linked (kept in memory only). */
async function readHealth(call, path) {
  const h = await call('health', 'GET', path)
  const id = h?.user?.id
  return {
    status: /^[A-Z_]{1,20}$/.test(h?.status?.text ?? '') ? h.status.text : 'UNKNOWN',
    user: typeof id === 'string' || typeof id === 'number' ? String(id) : '',
  }
}

/** What step() calls when the phone path is not wired in: nothing happens, ever. */
export const INERT = Object.freeze({
  onLive() {},
  onFirstPage() {},
  async settle() {},
  async refresh() {},
  async close() {},
  async idle() {},
  async marker() {
    return null
  },
})

/**
 * The phone's WhatsApp config, from .notify.env's `whapi` block.
 *   dormant  no block or no token: no call of any kind, no `waAt`
 *   dry      prints what it would post (no "dryRun": false, --dry-run, or a
 *            channelId that is not one); a post already out is still ended
 *   live     posts
 */
export function phoneSettings(cfg, { forceDry = false } = {}) {
  const w = cfg?.whapi
  const token = typeof w?.token === 'string' ? w.token.trim() : ''
  if (!w || typeof w !== 'object' || !token) return { mode: 'dormant', why: 'no whapi token in .notify.env' }
  const channelId = typeof w.channelId === 'string' ? w.channelId.trim() : ''
  let why = null
  if (forceDry) why = '--dry-run'
  else if (w.dryRun !== false) why = 'whapi.dryRun in .notify.env is not false'
  else if (channelId && !NEWSLETTER_OK.test(channelId)) why = 'whapi.channelId in .notify.env is not a …@newsletter id'
  return { mode: why ? 'dry' : 'live', token, channelId: NEWSLETTER_OK.test(channelId) ? channelId : '', forced: forceDry, why }
}

/**
 * Is the poster paused? One GET of the repo's open issues, with no
 * credential, through the same rule as Actions (findPause): the title, and an
 * author that is the bot, the owner or a collaborator. 'paused' or 'clear';
 * throws when it cannot tell.
 */
export async function pauseCheck({ fetch: fetchFn, repo = REPO, base = GITHUB_API, timeoutMs = PHONE_TIMEOUT_MS, signal } = {}) {
  const doFetch = fetchFn ?? ((...a) => globalThis.fetch(...a))
  const gh = async (path) => {
    const res = await doFetch(`${base}/repos/${repo}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ccbuddy-blinkdeal-watcher' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`GitHub issues: HTTP ${res.status}`)
    return res.json()
  }
  return (await findPause(gh)) ? 'paused' : 'clear'
}

// ---- The ledger on the phone ----------------------------------------------------

function phoneLedger(dir, { now, forced = false }) {
  const path = (name) => join(dir, name)
  const text = (v) => `${JSON.stringify(v, null, 1)}\n`
  const readJson = async (name) => {
    try {
      return JSON.parse(await readFile(path(name), 'utf8'))
    } catch {
      return null
    }
  }
  // Written beside it, then renamed over it: a reader never sees half a file.
  const replace = async (name, v) => {
    if (forced) return
    await mkdir(dir, { recursive: true })
    const tmp = path(`${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(tmp, text(v))
    await rename(tmp, path(name))
  }
  const remove = async (name) => {
    if (!forced) await unlink(path(name)).catch(() => {})
  }
  /** { until, why } while the phone holds off Whapi, else null. */
  const held = async () => {
    const h = await readJson(HOLD)
    const until = Date.parse(h?.until ?? '')
    return Number.isFinite(until) && until > now() ? { until, why: h.why === 'failed' ? 'failed' : '429' } : null
  }
  return {
    readJson,
    replace,
    remove,
    /** The post that is out, or null. A file that cannot be read is moved aside: every write here is whole. */
    async readOpen() {
      let raw
      try {
        raw = await readFile(path(OPEN), 'utf8')
      } catch {
        return null
      }
      try {
        const o = JSON.parse(raw)
        if (o && typeof o === 'object' && KEY_OK.test(o.key ?? '') && typeof o.code === 'string') return o
      } catch {
        /* below */
      }
      if (!forced) await rename(path(OPEN), path(`open.bad-${now()}.json`)).catch(() => {})
      return null
    },
    /**
     * open.json, created only if there is none: whole, in one step (a hard
     * link of a finished file), so a second watcher loop on this clone gets
     * EEXIST and never a torn file. Returns false when one already exists.
     */
    async createOpen(entry) {
      await mkdir(dir, { recursive: true })
      const tmp = path(`open.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
      await writeFile(tmp, text(entry))
      try {
        await link(tmp, path(OPEN))
        return true
      } catch (e) {
        if (e?.code === 'EEXIST') return false
        // A filesystem without hard links: the exclusive create still refuses a second.
        try {
          await writeFile(path(OPEN), text(entry), { flag: 'wx' })
          return true
        } catch (e2) {
          if (e2?.code === 'EEXIST') return false
          throw e2
        }
      } finally {
        await unlink(tmp).catch(() => {})
      }
    },
    archived: async (key) => !!(await readLedger(dir, key)),
    async dueKeys() {
      const d = await readJson(DUE)
      return Array.isArray(d) ? [...new Set(d.filter((k) => typeof k === 'string' && KEY_OK.test(k)))] : []
    },
    async setDue(keys) {
      if (keys.length) await replace(DUE, [...new Set(keys)])
      else await remove(DUE)
    },
    held,
    heldUntil: async () => (await held())?.until ?? null,
    hold: (why = '429') => replace(HOLD, { until: iso(now() + REST_MS), why }),
    async saveChannel(token, channelId, user = '') {
      await replace(CHANNEL, { channelId, tag: channelTag(token, channelId), user, checkedAt: iso(now()) })
    },
    /** The cached channel for this token (and this pin, if any), or null. */
    async cachedChannel(token, pinned) {
      const c = await readJson(CHANNEL)
      if (!c || !NEWSLETTER_OK.test(c.channelId ?? '') || c.tag !== channelTag(token, c.channelId)) return null
      if (pinned && c.channelId !== pinned) return null
      return c
    },
  }
}

// ---- The poster ---------------------------------------------------------------------

/**
 * One tick's WhatsApp poster: the hooks step() calls. Every method is safe to
 * call in any order and never throws; every network call goes through `fetch`.
 *   onLive(sight)     at an opening, beside the Telegram alert: starts the
 *                     pause check, then (when clear) the session check, and
 *                     the post, which step() does not wait for. It says what
 *                     is known at sight, or the first page when that has come
 *                     by the send
 *   onFirstPage(p)    at the coupon's first page: the post filled in from it
 *                     (an edit), off the crawl's path; the post itself starts
 *                     here only when onLive could not start it
 *   settle()          after the crawl: waits for that post (bounded), and
 *                     starts the tick's one deadline
 *   refresh(next)     the post again, edited, if the full crawl's rows differ
 *                     (after the first page's edit, never before it)
 *   close({previous, next})   a window ended: its post edited "Over"
 *   idle(next)        any other tick: a good read ends a post whose code it
 *                     does not show live, or fills in one still at its first
 *                     stage that it does; then the status read and the
 *                     "Over" edits still owed, if any
 *   marker(next)      `waAt` for the feed, or null
 */
export function phonePoster({
  settings: s,
  dir = LEDGER_DIR,
  fetch: fetchFn,
  whapiBase = WHAPI,
  githubBase = GITHUB_API,
  repo = REPO,
  now = Date.now,
  sleep = realSleep,
  log = console.log,
  timeoutMs = PHONE_TIMEOUT_MS,
  settleMs = SETTLE_MS,
}) {
  if (!s || s.mode === 'dormant') {
    return {
      ...INERT,
      onFirstPage() {
        log('WA: not set up on this phone; the Actions poster posts this window')
      },
    }
  }
  const L = phoneLedger(dir, { now, forced: s.forced })
  const say = (m) => log(`WA ${m}`)
  const short = (e) => redact(e?.message ?? e, [s.token])

  // The tick's one deadline. Every Whapi and GitHub call but the send carries
  // it; it ends PHONE_TIMEOUT_MS after the crawl (settle), or at once when a
  // post is cut off before its send. A send, once started, keeps its own
  // timeout: cut short, it would be a post that may have gone out.
  const tick = new AbortController()
  const cut = () => {
    if (!tick.signal.aborted) tick.abort(new DOMException('the WhatsApp time for this tick is up', 'TimeoutError'))
  }
  let deadline = null
  const budget = () => {
    if (deadline) return
    deadline = setTimeout(cut, timeoutMs)
    deadline.unref?.()
  }
  const nap = (ms) => (tick.signal.aborted ? Promise.reject(tick.signal.reason) : sleep(ms, tick.signal))

  const client = { token: s.token, base: whapiBase, fetch: fetchFn, timeoutMs, sleep: nap, retries401: 0 }
  // After a 429 no call leaves this phone, in this run (`rested`) or any other
  // before hold.json says; a post WhatsApp marked failed holds it the same way.
  let rested = false
  const guarded = (raw) => async (what, ...a) => {
    if (rested || (await L.heldUntil())) {
      const e = new WhapiError(what, 0, 'not called: this phone is holding off Whapi')
      e.unsent = true
      throw e
    }
    try {
      return await raw(what, ...a)
    } catch (e) {
      if (e instanceof WhapiError && e.status === 429) {
        rested = true
        await L.hold('429').catch(() => {})
        say('Whapi answered 429: no call from this phone for 2 days')
      } else if (e instanceof WhapiError && [401, 403, 404].includes(e.status)) {
        // The session or the channel is not what the cache says: found again at the next opening.
        await L.remove(CHANNEL)
      }
      throw e
    }
  }
  const call = guarded(whapi({ ...client, signal: tick.signal }))
  const sendCall = guarded(whapi(client))
  const checkPause = async () => {
    const p = await pauseCheck({ fetch: fetchFn, repo, base: githubBase, timeoutMs, signal: tick.signal })
    // Something needs the owner: whatever the cache says is checked again after.
    if (p === 'paused') await L.remove(CHANNEL)
    return p
  }
  // Off an opening: asked at most once a tick, and only when a Whapi call is ready to be made.
  let pauseMemo = null
  const pausedNow = () =>
    (pauseMemo ??= checkPause().then(
      (p) => p === 'paused',
      (e) => {
        say(`could not read the pause issue (${short(e)})`)
        return null
      },
    ))

  let pre = null // this tick's pause check, then the session check, started at onLive
  let job = null
  let phase = 'pre' // 'pre' → 'sending' → 'done'; settle() waits only for a job past 'pre'
  let cutoff = false
  let opened = null // { entry, adopted? } once this tick's post went out, or one on file is this window's
  let firstPage = null // the coupon's first page, once it came
  let fill = null // the first page's edit, chained on the post
  let dryShown = null // what a dry run printed it would post

  /** At an opening: held? paused? and, when clear, the session and the number linked. No Whapi call while paused. */
  const prepare = () =>
    (pre ??= (async () => {
      const h = await L.held()
      if (h) return { pause: 'held', why: h.why }
      const pause = await checkPause()
      if (pause !== 'clear') return { pause }
      try {
        return { pause, health: await readHealth(call, '/health') }
      } catch (e) {
        return { pause, health: { error: e } }
      }
    })())

  /** The post on file, or null; one whose retire stopped between its two writes is cleared. */
  async function current() {
    const cur = await L.readOpen()
    if (cur && (await L.archived(cur.key))) {
      await L.remove(OPEN)
      return null
    }
    return cur
  }

  /** Where a post goes: found (or the pin checked), never from the cache. */
  async function locate() {
    if (s.channelId) {
      const r = await roleIn(call, s.channelId)
      if (r.owner) return { reason: REASONS.owner().title }
      if (r.role !== 'admin') return { reason: REASONS.notAdmin(r.role).title }
      return { channelId: s.channelId }
    }
    const f = await findChannel(call)
    return f.reason ? { reason: f.reason.title } : { channelId: f.channel.id }
  }
  /**
   * Where this post goes: the cache, while it is under a day old and the
   * session is connected to the number it was found with; else found again
   * and cached. A session re-linked to another number (the owner's, say) is
   * checked by the same rules as Actions before anything is posted.
   */
  async function channelFor(health) {
    if (health?.error) return { reason: `the session check failed: ${short(health.error)}` }
    let h = health
    if (h.status !== 'AUTH') {
      const status = await sessionStatus(call, nap, { wakeup: true })
      h = status === 'AUTH' ? await readHealth(call, '/health') : { status, user: '' }
    }
    if (h.status !== 'AUTH') {
      await L.remove(CHANNEL)
      return { reason: REASONS.session(h.status).title }
    }
    const user = userTag(s.token, h.user)
    const c = await L.cachedChannel(s.token, s.channelId)
    if (c && user && c.user === user && now() - Date.parse(c.checkedAt) < CHANNEL_MAX_AGE_MS) return { channelId: c.channelId }
    const found = await locate()
    if (found.reason) await L.remove(CHANNEL)
    else await L.saveChannel(s.token, found.channelId, user)
    return found
  }

  /** Move the post on file to its archive; its "Over" edit, if it can have one, is then owed. */
  async function retire(cur, to) {
    const editable = cur.state === 'sent' && MESSAGE_ID_OK.test(cur.messageId ?? '')
    const edit = editable
      ? { state: 'due', to: to ?? null, tries: 0, lastTry: null, since: now(), reason: null }
      : { state: 'none', why: 'Whapi gave no message id for it' }
    await writeLedger(dir, cur.key, { ...cur, endedAt: iso(now()), edit })
    if (editable) await L.setDue([...(await L.dueKeys()), cur.key])
    await L.remove(OPEN)
  }

  async function editPost(entry, body) {
    // The channel the post went to, and no other.
    const to = NEWSLETTER_OK.test(entry.channelId ?? '') && channelTag(s.token, entry.channelId) === entry.channelTag ? entry.channelId : null
    if (!to) return false
    await call('edit', 'POST', '/messages/text', { to, edit: entry.messageId, body, no_link_preview: true })
    return true
  }

  /**
   * Make the "Over" edits that are owed, after one look at the pause issue
   * (asked only if an edit is ready to try). Off an edge, an edit waits
   * EDIT_RETRY_GAP_MS between tries, and one held back by the pause waits for
   * the next end.
   */
  async function runDue({ atEdge }) {
    const keys = await L.dueKeys()
    if (!keys.length) return
    const until = await L.heldUntil()
    const keep = []
    for (const key of keys) {
      const a = await readLedger(dir, key)
      const e = a?.edit
      if (!a || e?.state !== 'due') continue
      const save = (edit) => writeLedger(dir, key, { ...a, edit: { ...e, ...edit } })
      if (now() - e.since > EDIT_MAX_AGE_MS) {
        await save({ state: 'dropped' })
        say(`edit for ${a.code} dropped: not made within 24 h`)
        continue
      }
      if (until || rested || (!atEdge && e.reason === 'paused') || (!atEdge && e.lastTry && now() - e.lastTry < EDIT_RETRY_GAP_MS)) {
        keep.push(key)
        continue
      }
      const pz = await pausedNow()
      if (pz === true) {
        await save({ reason: 'paused' })
        keep.push(key)
        continue
      }
      const tries = e.tries + 1
      if (pz === null) {
        // Could not tell: counts as a try, so a GitHub outage cannot become a call every tick.
        if (tries > EDIT_RETRIES) {
          await save({ state: 'failed', tries, lastTry: now() })
        } else {
          await save({ tries, lastTry: now(), reason: 'transient' })
          keep.push(key)
        }
        continue
      }
      try {
        if (await editPost(a, renderOver(a.data, e.to))) {
          await save({ state: 'done', tries, lastTry: now() })
          say(`edit made at ${iso(now())}: ${a.code} is over`)
        } else {
          await save({ state: 'failed', tries, why: 'another Channel or token now' })
          say(`edit for ${a.code} not made: its post was made in another Channel, or under another Whapi token`)
        }
      } catch (err) {
        if (err instanceof WhapiError && err.status >= 400 && err.status < 500) {
          await save({ state: 'failed', tries, lastTry: now() })
          say(`edit for ${a.code} refused (${short(err)}); not tried again`)
        } else if (tries > EDIT_RETRIES) {
          await save({ state: 'failed', tries, lastTry: now() })
          say(`edit for ${a.code} failed (${short(err)}), ${tries} tries; given up`)
        } else {
          await save({ tries, lastTry: now(), reason: 'transient' })
          keep.push(key)
          say(`edit for ${a.code} failed (${short(err)}); tried again on a later tick`)
        }
      }
    }
    await L.setDue(keep)
  }

  /**
   * A 200 is not delivery. The last post's status is read once, on the first
   * tick VERIFY_AFTER_MS or more after its send, by the same rule as Actions.
   * "failed" holds the phone off Whapi for 2 days: each window then goes to
   * Actions, which meets the same failure and opens the pause issue.
   */
  async function checkStatus() {
    const c = await L.readJson(CHECK)
    if (!c) return
    const sentAt = Date.parse(c.sentAt ?? '')
    if (Number.isFinite(sentAt) && now() - sentAt < VERIFY_AFTER_MS) return
    // Looked at once, whatever the answer, as Actions does; not at all a day on.
    await L.remove(CHECK)
    if (!(now() - sentAt <= EDIT_MAX_AGE_MS) || !MESSAGE_ID_OK.test(c.messageId ?? '') || rested || (await L.heldUntil())) return
    if ((await pausedNow()) !== false) return
    // A 429 here is already held by the call itself.
    const status = await verify(call, c.messageId, { sleep: async () => {}, log: () => {} }).catch(() => null)
    say(`status of the last post: ${status ?? 'not read'}`)
    if (status !== 'failed') return
    await L.hold('failed')
    say('WhatsApp marked the last post as failed: no call from this phone for 2 days; the Actions poster takes each window')
  }

  // ---- The opening ----------------------------------------------------------------

  async function openJob(seed) {
    const code = seed.code
    const key = `${code}-${Date.parse(seed.from)}`
    // A window no ledger can name could never be ended; Actions refuses it too.
    if (!KEY_OK.test(key)) {
      say('open: this code cannot name a window; not posting')
      return 'deferred'
    }
    // What the post says at its send: the first page if it has come by then,
    // else what was known at sight (no coins: no count and no rows).
    const render = () => {
      const src = firstPage?.code === code ? firstPage : seed
      const data = postData({ ...src, lastLive: { code, from: seed.from } })
      return { data, body: renderOpen(data), stage: src === firstPage ? 'full' : 'first' }
    }
    const cur = await current()
    // The same code on file, posted under ADOPT_MAX_AGE_MS ago: no good read
    // has seen that window end, so this is it again (a tick whose first page
    // or feed write never came posted it, or another run on this clone is
    // posting it). Not posted twice, but filled in if it needs to be. A post
    // time that cannot be read counts as recent, for the same reason.
    if (cur && cur.code === code && !(now() - Date.parse(cur.postedAt) >= ADOPT_MAX_AGE_MS)) {
      say(`open: ${code} was posted at ${cur.postedAt} by an earlier tick that did not publish it; not posting it again`)
      if (s.mode === 'live' && cur.state === 'sent' && MESSAGE_ID_OK.test(cur.messageId ?? '')) opened = { entry: cur, adopted: true }
      return 'adopted'
    }
    // Another code on file, or this code posted too long ago to be this
    // window, ended unseen: its end is owed ("Over", with no time), and made
    // on a later tick, never in the way of this post.
    if (cur && s.forced) {
      say(`DRY (${s.why}): would edit the post for ${cur.code} to:\n${renderOver(cur.data, null)}`)
    } else if (cur) {
      await retire(cur, null)
    }
    if (s.mode !== 'live') {
      dryShown = render()
      say(`DRY (${s.why}): would post:\n${dryShown.body}`)
      return 'dry'
    }
    let p
    try {
      p = await prepare()
    } catch (e) {
      if (cutoff) return late()
      say(`open: could not read the pause issue (${short(e)}); the Actions poster takes this window`)
      return 'deferred'
    }
    if (p.pause === 'held') {
      say(
        p.why === 'failed'
          ? 'open: WhatsApp marked an earlier post from this phone as failed; the Actions poster takes this window'
          : 'open: resting the number after a 429; the Actions poster takes this window',
      )
      return 'held'
    }
    if (p.pause === 'paused') {
      say('open: the poster is paused; the Actions poster notes the window')
      return 'paused'
    }
    if (cutoff) return late()
    const ch = await channelFor(p.health)
    // The last moment to back out: past here the feed must say the phone took it.
    if (cutoff) return late()
    if (ch.reason) {
      say(`open: no channel to post to (${ch.reason}); the Actions poster takes this window`)
      return 'deferred'
    }
    phase = 'sending'
    const { data, body, stage } = render()
    const entry = { v: 1, key, code, from: seed.from, state: 'sending', messageId: null, channelId: ch.channelId, channelTag: channelTag(s.token, ch.channelId), data, body, stage, postedAt: iso(now()) }
    if (!(await L.createOpen(entry))) {
      say(`open: another run on this clone is posting ${code}; not posting it twice`)
      return 'taken'
    }
    try {
      const res = await sendCall('send', 'POST', '/messages/text', { to: ch.channelId, body, no_link_preview: true })
      const id = typeof res?.message?.id === 'string' && MESSAGE_ID_OK.test(res.message.id) ? res.message.id : null
      const sent = { ...entry, state: 'sent', messageId: id }
      await L.replace(OPEN, sent)
      if (id) await L.replace(CHECK, { messageId: id, sentAt: iso(now()) })
      opened = { entry: sent }
      say(`open sent at ${iso(now())}${id ? '' : ' (Whapi gave no message id, so its end cannot be edited in)'}`)
      return 'sent'
    } catch (e) {
      if (e instanceof WhapiError && ((e.status >= 400 && e.status < 500) || e.unsent)) {
        // It never went out: the Actions poster takes the window.
        await L.remove(OPEN)
        say(`open not sent (${short(e)}); the Actions poster takes this window`)
        return 'unsent'
      }
      await L.replace(OPEN, { ...entry, state: 'unknown' })
      say(`open may have gone out (${short(e)}); never sent twice, and its end cannot be edited in`)
      return 'unknown'
    }
  }
  function late() {
    say('open: not at the send by the end of the crawl; the Actions poster takes this window')
    return 'late'
  }
  const start = (seed) =>
    openJob(seed)
      .catch((e) => {
        if (cutoff) return late()
        say(`open failed: ${short(e)}`)
        return 'error'
      })
      .finally(() => {
        phase = 'done'
      })

  // ---- Filling it in ------------------------------------------------------------------

  /** May a post on file be edited now? One this tick sent, yes; one adopted, only when this tick's checks are clear. */
  async function clearToEdit() {
    if (!opened?.adopted) return true
    try {
      return (await prepare()).pause === 'clear'
    } catch {
      return false
    }
  }

  /**
   * The post on file edited to the opening `src` gives, keeping its own "Live
   * since". Its ledger entry is then 'full'. True when an edit was made, false
   * when none was needed, null when it cannot be edited from here.
   */
  async function editOpen(entry, src) {
    const data = postData({ ...src, lastLive: { code: entry.code, from: entry.from } })
    const body = renderOpen(data)
    const changed = body !== entry.body
    if (changed && !(await editPost(entry, body))) return null
    const { fill: _done, ...rest } = entry
    const done = { ...rest, data, body, stage: 'full' }
    const cur = await L.readOpen()
    if (cur?.key === entry.key) {
      const { fill: _f, ...kept } = cur
      await L.replace(OPEN, { ...kept, data, body, stage: 'full' })
    }
    if (opened?.entry.key === entry.key) opened = { ...opened, entry: done }
    return changed
  }

  /** A fill that failed, on file: `counted` for the idle tries; a 4xx (a 429 too) ends them. */
  async function fillFailed(entry, err, counted) {
    const refused = err instanceof WhapiError && err.status >= 400 && err.status < 500
    const f = entry.fill ?? {}
    const fill = { tries: (f.tries ?? 0) + (counted ? 1 : 0), lastTry: now(), ...(refused || f.state === 'refused' ? { state: 'refused' } : {}) }
    const cur = await L.readOpen()
    if (cur?.key === entry.key) await L.replace(OPEN, { ...cur, fill })
    if (opened?.entry.key === entry.key) opened = { ...opened, entry: { ...entry, fill } }
    return refused
  }

  /** At the first page: the post sent at sight, edited to the full opening. */
  async function fillIn() {
    const page = firstPage
    if (!page) return
    if (s.mode !== 'live') {
      if (dryShown?.stage === 'first') {
        const body = renderOpen(postData({ ...page, lastLive: { code: page.code, from: dryShown.data.from } }))
        if (body !== dryShown.body) say(`DRY (${s.why}): would edit it to:\n${body}`)
      }
      return
    }
    const entry = opened?.entry
    if (!entry || entry.code !== page.code || (entry.stage ?? 'full') !== 'first' || entry.fill?.state === 'refused') return
    if (!(await clearToEdit())) return
    try {
      const r = await editOpen(entry, page)
      if (r === null) {
        await fillFailed(entry, new WhapiError('edit', 400, 'another Channel or token now'), false)
        say(`open for ${entry.code} not filled in: it was made in another Channel, or under another Whapi token`)
      } else say(`open filled in from the first page at ${iso(now())}`)
    } catch (e) {
      const refused = await fillFailed(entry, e, false).catch(() => false)
      say(`open not filled in (${short(e)})${refused ? '; not tried again' : '; the crawl\'s edit tries again'}`)
    }
  }

  /**
   * A post still at its first stage, on a later live tick (its first page and
   * the crawl's edit both failed): filled in from this read, at most
   * EDIT_RETRIES times, EDIT_RETRY_GAP_MS apart, each after a pause check.
   * A paused or unknown answer spends a try too: a long pause costs at most
   * EDIT_RETRIES GitHub reads, and leaves the post as first sent.
   */
  async function owedFill(next) {
    if (s.mode !== 'live' || next?.ok !== true) return
    const code = liveCode(next)
    if (!code) return
    const cur = await current()
    if (!cur || cur.code !== code || cur.state !== 'sent' || !MESSAGE_ID_OK.test(cur.messageId ?? '')) return
    if ((cur.stage ?? 'full') !== 'first') return
    const f = cur.fill ?? {}
    if (f.state === 'refused' || (f.tries ?? 0) >= EDIT_RETRIES) return
    if (f.lastTry && now() - f.lastTry < EDIT_RETRY_GAP_MS) return
    if (rested || (await L.heldUntil())) return
    const pz = await pausedNow()
    if (pz !== false) {
      // Paused, or could not tell: counts as a try, so neither becomes a GitHub call every tick.
      await fillFailed(cur, null, true)
      return
    }
    try {
      const r = await editOpen(cur, next)
      if (r === null) {
        await fillFailed(cur, new WhapiError('edit', 400, 'another Channel or token now'), true)
        say(`open for ${code} not filled in: it was made in another Channel, or under another Whapi token`)
      } else say(`open filled in at ${iso(now())}, on a later tick`)
    } catch (e) {
      const refused = await fillFailed(cur, e, true)
      say(`open not filled in (${short(e)})${refused ? '; not tried again' : '; tried again on a later tick'}`)
    }
  }

  return {
    onLive(sight) {
      // Not for a code no ledger can name: that window is never posted from here.
      if (job || !KEY_OK.test(`${sight?.code}-${Date.parse(sight?.from)}`)) return
      if (s.mode === 'live') prepare().catch(() => {}) // read, and reported, when the post awaits it
      job = start(sight)
    },
    onFirstPage(page) {
      firstPage = page
      // onLive could not start the post (it threw, or the code could not name a window): the first page does, as before.
      if (!job) job = start(page)
      fill ??= job.then(fillIn).catch((e) => say(`open not filled in: ${short(e)}`))
    },
    async settle() {
      budget()
      if (!job) {
        // Asked at onLive, and no post followed (the read failed): nothing needs the answer.
        if (pre) cut()
        return
      }
      let t
      await Promise.race([job, new Promise((r) => (t = setTimeout(r, settleMs)))])
      clearTimeout(t)
      cutoff = true
      // Not at its send: cut off now, every call it started with it, so
      // nothing it does holds this process, and so the push, open.
      if (phase === 'pre') return cut()
      await job
      // No post of this tick's (or adopted by it) to fill in or refresh: nothing left in flight is needed.
      if (!opened) cut()
    },
    async refresh(next) {
      // The post went out at sight (or from the first page's 50 coins); the crawl has them all.
      if (!opened?.entry.messageId) return
      budget()
      try {
        // The first page's edit lands first: a late one must never overwrite the crawl's rows.
        await fill
        const entry = opened.entry
        if (s.mode !== 'live' || liveCode(next) !== entry.code || entry.fill?.state === 'refused') return
        if (!(await clearToEdit())) return
        const r = await editOpen(entry, next)
        if (r === null) await fillFailed(entry, new WhapiError('edit', 400, 'another Channel or token now'), false)
        else if (r) say(`open refreshed with the full crawl at ${iso(now())}`)
      } catch (e) {
        const entry = opened?.entry
        if (entry && (entry.stage ?? 'full') === 'first') await fillFailed(entry, e, false).catch(() => {})
        say(`open not refreshed (${short(e)}); it stays as it was`)
      }
    },
    async close({ previous, next }) {
      if (s.forced) {
        try {
          const cur = await current()
          if (cur) {
            const to = cur.code === liveCode(previous) ? safeEnd(previous, next) : null
            say(`DRY (${s.why}): would edit the post for ${cur.code} to:\n${renderOver(cur.data, to)}`)
          }
        } catch (e) {
          say(`close failed: ${short(e)}`)
        }
        return
      }
      budget()
      try {
        const cur = await current()
        if (cur) await retire(cur, cur.code === liveCode(previous) ? safeEnd(previous, next) : null)
        await checkStatus()
        await runDue({ atEdge: true })
        await prune(dir, now)
      } catch (e) {
        say(`close failed: ${short(e)}`)
      }
    },
    async idle(next) {
      if (s.forced) return
      budget()
      try {
        // Every good read settles the ledger: a post whose code this read does
        // not show live ended unseen (its tick's feed was lost, or the phone
        // was off at the end), and its "Over" is owed now.
        if (next?.ok === true) {
          const cur = await current()
          if (cur && cur.code !== liveCode(next)) await retire(cur, null)
        }
        await owedFill(next)
        await checkStatus()
        await runDue({ atEdge: false })
      } catch (e) {
        say(`edit retry failed: ${short(e)}`)
      }
    },
    async marker(next) {
      try {
        const code = liveCode(next)
        if (!code) return null
        // By code, not key: two feeds of one window (a lost write, or two runs
        // on this clone) can name it with different start times.
        const cur = await current()
        if (!cur || cur.code !== code) return null
        // Never before the window's start, so Actions cannot read it as left over.
        return iso(Math.max(Date.parse(cur.postedAt) || 0, Date.parse(next.lastLive.from)))
      } catch {
        return null
      }
    },
  }
}

/** When the window `previous` showed ended, as `next` and the rules of endOf say; null when unknown. */
function safeEnd(previous, next) {
  try {
    return endOf(previous, next, null)
  } catch {
    return null
  }
}

/** Ended posts more than 30 days old, with no edit owed, are deleted. */
async function prune(dir, now) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const due = new Set(((await readJson(join(dir, DUE))) ?? []).filter((k) => typeof k === 'string'))
  for (const n of names) {
    const key = n.replace(/\.json$/, '')
    if (n === key || !KEY_OK.test(key) || due.has(key)) continue
    try {
      if (now() - (await stat(join(dir, n))).mtimeMs > ARCHIVE_MAX_AGE_MS) await unlink(join(dir, n))
    } catch {
      /* gone already */
    }
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** The poster for blinkdeal.mjs's main(): from .notify.env (or the `config` it already read), never throwing. */
export async function phoneFromConfig({ forceDry = false, log = console.log, config } = {}) {
  try {
    const cfg = config ?? (await loadConfig())
    return phonePoster({ settings: phoneSettings(cfg, { forceDry }), repo: process.env.BLINKDEAL_REPO || REPO, log })
  } catch (e) {
    log(`WA: config unreadable (${redact(e?.message)}); nothing posted from this phone`)
    return INERT
  }
}

// ---- Setup and check, run by hand on the phone ----------------------------------------

/**
 * Read-only: is the session up, and which one Channel does this number admin
 * (or is the pinned one admined)? The same rules as wa-post.mjs mode check.
 * When ready, the channel is cached for the first opening. Returns { ready }.
 */
export async function phoneCheck({ token, channelId = '', dir = LEDGER_DIR, fetch: fetchFn, base = WHAPI, sleep = realSleep, log = console.log, now = Date.now, timeoutMs = PHONE_TIMEOUT_MS }) {
  const L = phoneLedger(dir, { now })
  const call = whapi({ token, base, fetch: fetchFn, timeoutMs, sleep, log })
  const short = (e) => redact(e?.message ?? e, [token])
  let channel = null
  let user = ''
  let ready
  try {
    const { status, user: id } = await readHealth(call, '/health?wakeup=false')
    user = userTag(token, id)
    log(`session: ${status}${status === 'AUTH' ? '' : ' (AUTH is connected)'}`)
    ready = status === 'AUTH'
    if (channelId) {
      if (!NEWSLETTER_OK.test(channelId)) {
        log('channel: whapi.channelId in .notify.env is set, but is not a …@newsletter id')
        ready = false
      } else {
        const r = await roleIn(call, channelId)
        log(`channel: ${r.name ? `"${redact(r.name)}"` : 'not found'} (whapi.channelId), this number's role: ${roleText(r.role)}`)
        if (r.owner) log('  The OWNER number is linked. Unlink it now: docs/whatsapp-poster.md.')
        if (r.role === 'admin' && !r.owner) channel = channelId
      }
    } else {
      const f = await findChannel(call)
      log(`Channels this number admins: ${f.admins}${f.partial ? ' or more' : ''}`)
      if (f.channel) {
        log(`channel: ${f.channel.name ? `"${redact(f.channel.name)}"` : 'a Channel with no name'} (found by itself), this number's role: admin`)
        channel = f.channel.id
      } else {
        log(`channel: none picked. ${f.reason.title}`)
        if (f.reason.kind === 'many-channels' || f.reason.kind === 'owner-linked') {
          log("  To pin it on this phone, put the real channel's …@newsletter id in .notify.env as whapi.channelId, then run this again.")
        }
      }
    }
  } catch (e) {
    if (e instanceof WhapiError && e.status === 429) await L.hold().catch(() => {})
    log(`Whapi: ${short(e)}`)
    ready = false
  }
  ready = !!(ready && channel)
  if (ready) await L.saveChannel(token, channel, user)
  log(ready ? 'Ready: connected, and an admin of the channel.' : 'Not ready: see above.')
  return { ready }
}

const NOTIFY_PATH = join(ROOT, '.notify.env')
const termuxClipboard = async () => (await execFileAsync('termux-clipboard-get', [], { timeout: 10000 })).stdout

/**
 * The one step on the phone: the token from the clipboard, checked, and the
 * `whapi` block written to .notify.env, with "dryRun": false only when the
 * check says Ready. Every other key in the file is kept.
 */
export async function runSetup({ readClipboard = termuxClipboard, configPath = NOTIFY_PATH, log = console.log, ...rest } = {}) {
  let token = ''
  try {
    token = String(await readClipboard()).trim()
  } catch {
    token = ''
  }
  if (!TOKEN_OK.test(token)) {
    log('The clipboard holds no Whapi token. In the Whapi dashboard, copy the token (the copy icon after Token:), then run this again.')
    return false
  }
  log('Token read from the clipboard.')
  let file = {}
  try {
    file = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      log('.notify.env is not valid JSON, so it was left as it is. Fix it, then run this again.')
      return false
    }
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) file = {}
  const pinned = typeof file.whapi?.channelId === 'string' ? file.whapi.channelId.trim() : ''
  const { ready } = await phoneCheck({ ...rest, token, channelId: pinned, log })
  file.whapi = { ...(file.whapi && typeof file.whapi === 'object' ? file.whapi : {}), token, dryRun: !ready }
  // Whole or not at all: the watcher loop reads this file every tick, for Telegram too.
  const tmp = `${configPath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, configPath)
  log(
    ready
      ? 'Saved to .notify.env, posting on: this phone posts the next window to the WhatsApp Channel. The Actions poster stays the fallback.'
      : 'Saved to .notify.env, posting off ("dryRun": true): nothing is posted from this phone, and the Actions poster keeps posting. Fix the above and run this again.',
  )
  return ready
}

/** --check: the saved config, the same read-only check, and the pause issue. */
export async function runPhoneCheck({ cfg, log = console.log, ...rest } = {}) {
  const s = phoneSettings(cfg ?? (await loadConfig()))
  if (s.mode === 'dormant') {
    log('No whapi token in .notify.env: run node scraper/wa-phone.mjs --setup')
    return false
  }
  log(s.mode === 'live' ? 'Posting: on.' : `Posting: off (${s.why}).`)
  const { ready } = await phoneCheck({ ...rest, token: s.token, channelId: s.channelId, log })
  try {
    log((await pauseCheck({ fetch: rest.fetch, repo: process.env.BLINKDEAL_REPO || REPO })) === 'paused' ? 'The pause issue is open: nothing is posted until it is closed.' : 'No pause issue open.')
  } catch (e) {
    log(`Could not read the pause issue (${redact(e?.message)}).`)
  }
  return ready
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').toLowerCase().endsWith('/wa-phone.mjs')) {
  const argv = process.argv.slice(2)
  const run = argv.includes('--setup') ? runSetup() : argv.includes('--check') ? runPhoneCheck() : null
  if (!run) {
    console.error('usage: node scraper/wa-phone.mjs --setup | --check')
    process.exit(2)
  }
  run.then(
    (ok) => process.exit(ok ? 0 : 1),
    (e) => {
      console.error(redact(e?.message ?? e))
      process.exit(1)
    },
  )
}
