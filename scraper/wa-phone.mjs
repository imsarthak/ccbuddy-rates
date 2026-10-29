// The watcher phone posts each BLINKDEAL window's opening to the WhatsApp
// Channel itself, through Whapi.Cloud, and edits it "Over" when it ends.
//
// From GitHub Actions (wa-post.mjs) the post lands 30-40 s after the phone sees
// the window: the whole crawl, the push, the runner's queue and its setup.
// October's windows lasted a median 4 min. From here it goes out at the
// coupon's first page, beside the Telegram channel post, about 3 s after the
// Telegram alert. The words are the same: renderOpen and renderOver from
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
// Exactly once. The ledger is `.wa-ledger/` at the clone root, on the phone
// only (gitignored; nothing in the watcher loop touches ignored files):
//   open.json      the one post that is out and not yet ended. Created
//                  atomically and exclusively BEFORE the send, updated after
//                  it. A post that may have gone out is never sent again.
//   <key>.json     each ended post, with its edit's state; kept 30 days
//   due.json       the keys of ended posts whose "Over" edit is still owed
//   channel.json   the channel found for this token, rechecked daily and
//                  after each end
//   hold.json      after a 429: no Whapi call before `until` (2 days)
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  whapi, WhapiError, redact, postData, renderOpen, renderOver, endOf, windowKey, findPause, findChannel, roleIn,
  sessionStatus, channelTag, readLedger, writeLedger, REASONS, MESSAGE_ID_OK, NEWSLETTER_OK, KEY_OK,
  OPEN_MAX_AGE_MS, REST_MS, LEDGER_DIR, WHAPI,
} from './wa-post.mjs'
import { loadConfig } from './notify.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)

export const REPO = 'imsarthak/ccbuddy-rates'
export const GITHUB_API = 'https://api.github.com'
// Every call from the phone. A send that has not answered in 8 s is treated
// as one that may have gone out: never sent again.
export const PHONE_TIMEOUT_MS = 8000
// How long step() waits after the crawl for a WhatsApp job that has not yet
// reached its send. After that the job may not start one: the feed is about
// to be written without `waAt`, and Actions will post.
export const SETTLE_MS = 8000
export const CHANNEL_MAX_AGE_MS = 24 * 3600 * 1000
export const EDIT_RETRIES = 3
export const EDIT_RETRY_GAP_MS = 20 * 1000
export const EDIT_MAX_AGE_MS = 24 * 3600 * 1000
export const ARCHIVE_MAX_AGE_MS = 30 * 24 * 3600 * 1000
const TOKEN_OK = /^[A-Za-z0-9_-]{20,200}$/

const OPEN = 'open.json'
const DUE = 'due.json'
const CHANNEL = 'channel.json'
const HOLD = 'hold.json'

const iso = (ms) => new Date(ms).toISOString()
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
const roleText = (role) => (role ? String(role).replace(/[^a-z_]/gi, '').slice(0, 20) : 'none')

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
export async function pauseCheck({ fetch: fetchFn, repo = REPO, base = GITHUB_API, timeoutMs = PHONE_TIMEOUT_MS } = {}) {
  const doFetch = fetchFn ?? ((...a) => globalThis.fetch(...a))
  const gh = async (path) => {
    const res = await doFetch(`${base}/repos/${repo}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ccbuddy-blinkdeal-watcher' },
      signal: AbortSignal.timeout(timeoutMs),
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
    async heldUntil() {
      const until = Date.parse((await readJson(HOLD))?.until ?? '')
      return Number.isFinite(until) && until > now() ? until : null
    },
    hold: () => replace(HOLD, { until: iso(now() + REST_MS) }),
    async saveChannel(token, channelId) {
      await replace(CHANNEL, { channelId, tag: channelTag(token, channelId), checkedAt: iso(now()) })
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
 *   onLive()          at an opening, beside the Telegram alert: starts the pause check
 *   onFirstPage(p)    at an opening, before the Telegram channel post: starts
 *                     the post, which step() does not wait for
 *   settle()          after the crawl: waits for that post (bounded)
 *   refresh(next)     the post again, edited, if the full crawl's rows differ
 *   close({previous, next})   a window ended: its post edited "Over"
 *   idle()            any other tick: an "Over" edit still owed, if one is
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
  const raw = whapi({ token: s.token, base: whapiBase, fetch: fetchFn, timeoutMs, sleep, retries401: 0 })
  // A 429 rests the number: no call from here before hold.json says.
  const call = async (...a) => {
    try {
      return await raw(...a)
    } catch (e) {
      if (e instanceof WhapiError && e.status === 429) {
        await L.hold().catch(() => {})
        say('Whapi answered 429: no call from this phone for 2 days')
      }
      throw e
    }
  }
  const checkPause = () => pauseCheck({ fetch: fetchFn, repo, base: githubBase, timeoutMs })

  let pause = null // this tick's pause check, started at onLive
  let job = null
  let phase = 'pre' // 'pre' → 'sending' → 'done'; settle() waits only for a job past 'pre'
  let cutoff = false
  let opened = null // { entry, channelId } once this tick's post went out

  /** Where a post goes: the cache, else found (or the pin checked) and cached. */
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
  async function channelFor() {
    const c = await L.cachedChannel(s.token, s.channelId)
    if (c && now() - Date.parse(c.checkedAt) < CHANNEL_MAX_AGE_MS) return { channelId: c.channelId }
    const status = await sessionStatus(call, sleep, { wakeup: true })
    if (status !== 'AUTH') {
      await L.remove(CHANNEL)
      return { reason: REASONS.session(status).title }
    }
    const found = await locate()
    if (found.reason) await L.remove(CHANNEL)
    else await L.saveChannel(s.token, found.channelId)
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
   * Make the "Over" edits that are owed. `paused`: true/false when this tick
   * already knows, undefined to ask GitHub (once, and only if an edit is
   * ready to try). Off an edge, an edit waits EDIT_RETRY_GAP_MS between tries,
   * and one held back by the pause waits for the next edge.
   */
  async function runDue({ atEdge, paused }) {
    const keys = await L.dueKeys()
    if (!keys.length) return
    const until = await L.heldUntil()
    let p = paused
    const isPaused = async () => {
      if (p === undefined) {
        try {
          p = (await checkPause()) === 'paused'
        } catch (e) {
          say(`edit: could not read the pause issue (${short(e)})`)
          p = null
        }
      }
      return p
    }
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
      if (until || (!atEdge && e.reason === 'paused') || (!atEdge && e.lastTry && now() - e.lastTry < EDIT_RETRY_GAP_MS)) {
        keep.push(key)
        continue
      }
      const pz = await isPaused()
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

  // ---- The opening ----------------------------------------------------------------

  async function openJob(page) {
    const key = `${page.code}-${Date.parse(page.from)}`
    // A window no ledger can name could never be ended; Actions refuses it too.
    if (!KEY_OK.test(key)) {
      say('open: this code cannot name a window; not posting')
      return 'deferred'
    }
    const data = postData({ ...page, lastLive: { code: page.code, from: page.from } })
    const body = renderOpen(data)
    let cur = await L.readOpen()
    if (cur && (await L.archived(cur.key))) {
      // A retire that stopped between its two writes.
      await L.remove(OPEN)
      cur = null
    }
    // The same code posted less than 15 min ago and never ended: this is that
    // window again, seen by a tick whose previous feed lost the post's write.
    if (cur && cur.code === page.code && now() - Date.parse(cur.postedAt) < OPEN_MAX_AGE_MS) {
      if (cur.key !== key) await L.replace(OPEN, { ...cur, key, from: page.from })
      say(`open: ${page.code} was posted at ${cur.postedAt} by an earlier tick whose feed was lost; not posting it again`)
      return 'adopted'
    }
    // Anything else on file ended unseen (or the code changed): its end is owed.
    let stale = false
    if (cur && s.forced) {
      say(`DRY (${s.why}): would edit the post for ${cur.code} to:\n${renderOver(cur.data, null)}`)
    } else if (cur) {
      await retire(cur, null)
      stale = true
    }
    if (s.mode !== 'live') {
      say(`DRY (${s.why}): would post:\n${body}`)
      return 'dry'
    }
    if (await L.heldUntil()) {
      say('open: resting the number after a 429; the Actions poster takes this window')
      return 'held'
    }
    let pz
    try {
      pz = await (pause ?? checkPause())
    } catch (e) {
      say(`open: could not read the pause issue (${short(e)}); the Actions poster takes this window`)
      return 'deferred'
    }
    if (pz === 'paused') {
      say('open: the poster is paused; the Actions poster notes the window')
      if (stale) await runDue({ atEdge: true, paused: true })
      return 'paused'
    }
    if (cutoff) return late()
    const ch = await channelFor()
    if (ch.reason) {
      say(`open: no channel to post to (${ch.reason}); the Actions poster takes this window`)
      return 'deferred'
    }
    // The last moment to back out: past here the feed must say the phone took it.
    if (cutoff) return late()
    phase = 'sending'
    const entry = { v: 1, key, code: page.code, from: page.from, state: 'sending', messageId: null, channelId: ch.channelId, channelTag: channelTag(s.token, ch.channelId), data, body, postedAt: iso(now()) }
    if (!(await L.createOpen(entry))) {
      say(`open: another watcher loop on this clone is posting ${page.code}; not posting it twice`)
      return 'taken'
    }
    let outcome
    try {
      const res = await call('send', 'POST', '/messages/text', { to: ch.channelId, body, no_link_preview: true })
      const id = typeof res?.message?.id === 'string' && MESSAGE_ID_OK.test(res.message.id) ? res.message.id : null
      const sent = { ...entry, state: 'sent', messageId: id }
      await L.replace(OPEN, sent)
      opened = { entry: sent }
      say(`open sent at ${iso(now())}${id ? '' : ' (Whapi gave no message id, so its end cannot be edited in)'}`)
      outcome = 'sent'
    } catch (e) {
      if (e instanceof WhapiError && ((e.status >= 400 && e.status < 500) || e.unsent)) {
        // It never went out: the Actions poster takes the window.
        await L.remove(OPEN)
        say(`open not sent (${short(e)}); the Actions poster takes this window`)
        outcome = 'unsent'
      } else {
        await L.replace(OPEN, { ...entry, state: 'unknown' })
        say(`open may have gone out (${short(e)}); never sent twice, and its end cannot be edited in`)
        outcome = 'unknown'
      }
    }
    // The news is out; now the end of the window before it, if one is owed.
    await runDue({ atEdge: true, paused: false })
    return outcome
  }
  function late() {
    say('open: not at the send by the end of the crawl; the Actions poster takes this window')
    return 'late'
  }

  return {
    onLive() {
      if (s.mode !== 'live' || pause) return
      pause = (async () => ((await L.heldUntil()) ? 'held' : checkPause()))()
      pause.catch(() => {}) // read, and reported, when the post awaits it
    },
    onFirstPage(page) {
      if (job) return
      job = openJob(page).catch((e) => {
        say(`open failed: ${short(e)}`)
        return 'error'
      }).finally(() => {
        phase = 'done'
      })
    },
    async settle() {
      if (!job) return
      let t
      await Promise.race([job, new Promise((r) => (t = setTimeout(r, settleMs)))])
      clearTimeout(t)
      cutoff = true
      if (phase !== 'pre') await job
    },
    async refresh(next) {
      // The post went out from the first page's 50 coins; the crawl has them all.
      if (!opened?.entry.messageId) return
      try {
        if (windowKey(next) !== opened.entry.key) return
        const data = postData(next)
        const body = renderOpen(data)
        if (body === opened.entry.body) return
        if (!(await editPost(opened.entry, body))) return
        const entry = { ...opened.entry, data, body }
        const cur = await L.readOpen()
        if (cur?.key === entry.key) await L.replace(OPEN, { ...cur, data, body })
        opened = { entry }
        say(`open refreshed with the full crawl at ${iso(now())}`)
      } catch (e) {
        say(`open not refreshed (${short(e)}); it keeps the first page's rows`)
      }
    },
    async close({ previous, next }) {
      try {
        const cur = await L.readOpen()
        if (cur) {
          let to = null
          if (cur.key === windowKey(previous)) {
            try {
              to = endOf(previous, next, null)
            } catch {
              to = null
            }
          }
          if (s.forced) {
            say(`DRY (${s.why}): would edit the post for ${cur.code} to:\n${renderOver(cur.data, to)}`)
            return
          }
          await retire(cur, to)
        }
        const mine = cur?.state === 'sent'
        if (!mine && !(await L.dueKeys()).length) return
        // One look at the pause issue for this edge: while it is open, no Whapi call at all.
        let paused
        if (await L.heldUntil()) paused = undefined
        else {
          try {
            paused = (await checkPause()) === 'paused'
          } catch (e) {
            say(`close: could not read the pause issue (${short(e)})`)
            paused = null
          }
        }
        await runDue({ atEdge: true, paused })
        // After a post of ours ends, look again at where the next one would go.
        if (mine && paused === false && !(await L.heldUntil())) {
          try {
            const found = await locate()
            const c = await L.cachedChannel(s.token, s.channelId)
            if (found.reason || (c && c.channelId !== found.channelId)) {
              await L.remove(CHANNEL)
              say(`channel check: ${found.reason ?? 'the channel has changed'}; the next opening finds it again`)
            } else await L.saveChannel(s.token, found.channelId)
          } catch (e) {
            say(`channel check skipped (${short(e)})`)
          }
        }
        await prune(dir, now)
      } catch (e) {
        say(`close failed: ${short(e)}`)
      }
    },
    async idle() {
      if (s.forced) return
      try {
        await runDue({ atEdge: false, paused: undefined })
      } catch (e) {
        say(`edit retry failed: ${short(e)}`)
      }
    },
    async marker(next) {
      try {
        const key = windowKey(next)
        if (!key) return null
        const cur = await L.readOpen()
        if (!cur || cur.key !== key || (await L.archived(cur.key))) return null
        // Never before the window's start, so Actions cannot read it as left over.
        return iso(Math.max(Date.parse(cur.postedAt) || 0, Date.parse(next.lastLive.from)))
      } catch {
        return null
      }
    },
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

/** The poster for blinkdeal.mjs's main(): from .notify.env, never throwing. */
export async function phoneFromConfig({ forceDry = false, log = console.log } = {}) {
  try {
    const cfg = await loadConfig()
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
  let ready
  try {
    const status = await sessionStatus(call, sleep, { wakeup: false })
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
  if (ready) await L.saveChannel(token, channel)
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
