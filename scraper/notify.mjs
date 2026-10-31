// Alerting for the BLINKDEAL watcher.
//
// Detection speed is wasted if the alert is slow, so this fires the moment a
// window opens, on whichever channels are configured. Every channel is
// optional; missing config is skipped silently rather than failing the run.
//
// Config lives in a gitignored `.notify.env` at the repo root, as JSON:
//
//   {
//     "telegram": { "token": "123456:ABC...", "chatId": "987654321",
//                   "channelId": "@ccbuddy_blinkdeal" },
//     "sms":      { "to": "+919876543210" },
//     "whatsapp": { "phone": "+919876543210", "apikey": "123456" },
//     "whatsappChannel": { "url": "https://whatsapp.com/channel/0029Va...",
//                          "autopost": false },
//     "whapi":    { "token": "…the WHAPI_TOKEN secret's value…", "dryRun": false }
//   }
//
// Environment variables override the file, for a host that would rather not
// keep one: BLINKDEAL_TELEGRAM_TOKEN, BLINKDEAL_TELEGRAM_CHANNEL,
// BLINKDEAL_WHATSAPP_CHANNEL_URL, BLINKDEAL_WHATSAPP_AUTOPOST=1,
// BLINKDEAL_WHAPI_TOKEN, BLINKDEAL_WHAPI_CHANNEL_ID, BLINKDEAL_WA_DRY_RUN
// (0 posts; anything else is dry).
//
// whapi makes the phone post each window's opening to the WhatsApp Channel
// itself, through Whapi.Cloud, the moment it sees the window (about 1-2 s
// after the Telegram alert), fill it in from the coupon's first page seconds
// later, and edit it "Over" at the end (scraper/wa-phone.mjs). It is dry unless dryRun is false;
// without the block the phone does nothing for WhatsApp and the GitHub
// Actions poster posts instead, as it always has. `node scraper/wa-phone.mjs
// --setup` writes the block. Optional whapi.channelId (…@newsletter) pins the
// channel, as the WHAPI_CHANNEL_ID secret does for Actions.
//
// whatsappChannel.autopost (off by default) additionally broadcasts an Android
// intent on each edge for a Tasker profile on the phone to pick up and post
// unattended, as a spare admin number. Setup and risks: docs/whatsapp-tasker.md.
//
//   node scraper/notify.mjs --test       send a test message on every alert channel
//   node scraper/notify.mjs --preview    print the channel posts rendered from the
//                                        captured window (the opening at first sight,
//                                        that post filled in, the close), send nothing
//   node scraper/notify.mjs --post-test  send them to telegram.channelId: the opening,
//                                        then the edit that fills it in, then the close
//                                        (point it at a private test channel first)
//
// Two different things go out of here. The ALERT is the private ping to
// Sarthak the moment a window opens (telegram chatId, sms, whatsapp, local).
// The POSTS are public: one when a window opens and one when it closes, to
// the Telegram channel (telegram.channelId — the bot must be an admin of it)
// and, one tap away, to the WhatsApp Channel: the local notification carries a
// "Post to channel" button that copies the post and opens the channel
// (whatsappChannel.url); an admin pastes and sends. The Telegram opening goes
// out the moment the window is seen and is edited, seconds later, into the
// full post (channelPoster, below); the notification and Tasker wait for the
// full post, as they cannot be edited.
//
// The WhatsApp Channel can also be posted unattended through Whapi.Cloud, as a
// spare admin number: by this phone itself (scraper/wa-phone.mjs, the `whapi`
// block above), and otherwise by scraper/wa-post.mjs from GitHub Actions on
// each phone push (docs/whatsapp-poster.md). Its words are TEMPLATES.wa*, below.
//
// Channel notes:
//   telegram  Free and instant, reaches any device. Make a bot with
//             @BotFather; get chatId by messaging the bot then opening
//             https://api.telegram.org/bot<token>/getUpdates
//             channelId is the channel's @username, or its numeric id
//             (-100…) for a private channel; the bot must be an admin.
//   sms       Sent by the watcher phone itself through Termux, so it needs a
//             SIM with credit and the Termux:API app with SMS permission.
//             Costs whatever your plan charges. Works when data does not.
//   whatsapp  Routed through CallMeBot, a free third party. Meta's own API
//             needs a business account and template approval, which is far
//             more setup than this is worth. The trade-off is real: CallMeBot
//             sees the message text. Keep alerts free of anything private —
//             a coupon code is public information, so this is fine here.

import { readFile, writeFile, mkdir, rename, unlink, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 15000
export const TELEGRAM_API = 'https://api.telegram.org'

/** .notify.env with the environment on top. Shared with wa-phone.mjs. */
export async function loadConfig() {
  let cfg = {}
  try {
    cfg = JSON.parse(await readFile(join(ROOT, '.notify.env'), 'utf8'))
  } catch {
    // no file: every channel is optional
  }
  return applyEnv(cfg, process.env)
}

/** Environment overrides on top of the file. Exported so it can be tested. */
export function applyEnv(cfg, env) {
  const out = { ...cfg }
  if (env.BLINKDEAL_TELEGRAM_TOKEN || env.BLINKDEAL_TELEGRAM_CHANNEL) {
    out.telegram = { ...out.telegram }
    if (env.BLINKDEAL_TELEGRAM_TOKEN) out.telegram.token = env.BLINKDEAL_TELEGRAM_TOKEN
    if (env.BLINKDEAL_TELEGRAM_CHANNEL) out.telegram.channelId = env.BLINKDEAL_TELEGRAM_CHANNEL
  }
  if (env.BLINKDEAL_WHATSAPP_CHANNEL_URL) {
    out.whatsappChannel = { ...out.whatsappChannel, url: env.BLINKDEAL_WHATSAPP_CHANNEL_URL }
  }
  if (env.BLINKDEAL_WHATSAPP_AUTOPOST != null) {
    out.whatsappChannel = { ...out.whatsappChannel, autopost: env.BLINKDEAL_WHATSAPP_AUTOPOST === '1' }
  }
  if (env.BLINKDEAL_WHAPI_TOKEN || env.BLINKDEAL_WHAPI_CHANNEL_ID || env.BLINKDEAL_WA_DRY_RUN != null) {
    out.whapi = { ...out.whapi }
    if (env.BLINKDEAL_WHAPI_TOKEN) out.whapi.token = env.BLINKDEAL_WHAPI_TOKEN
    if (env.BLINKDEAL_WHAPI_CHANNEL_ID) out.whapi.channelId = env.BLINKDEAL_WHAPI_CHANNEL_ID
    // As WA_DRY_RUN for Actions: only 0 posts.
    if (env.BLINKDEAL_WA_DRY_RUN != null) out.whapi.dryRun = env.BLINKDEAL_WA_DRY_RUN.trim() !== '0'
  }
  return out
}

async function sendTelegram(cfg, text, { base = TELEGRAM_API } = {}) {
  if (!cfg?.token || !cfg?.chatId) return null
  const res = await fetch(`${base}/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
    // cfg.signal (a tick's bound) cuts it short beside its own 15 s.
    signal: cfg.signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), cfg.signal]) : AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    // Telegram says why in the body ("bot is not a member of the channel
    // chat", "chat not found"), and that is the whole diagnosis on a phone.
    const why = await res.json().then((j) => j.description).catch(() => '')
    throw new Error(`telegram HTTP ${res.status}${why ? `: ${why}` : ''}`)
  }
  return 'sent'
}

/**
 * A Bot API call that says how it failed. `status` is the HTTP status (0 when
 * no answer came); `unsent` is true only when no connection was ever made, so
 * the request cannot have reached Telegram. The token is never in the message.
 */
export class TelegramError extends Error {
  constructor(status, description = '', { unsent = false, why = '' } = {}) {
    super(status ? `telegram HTTP ${status}${description ? `: ${description}` : ''}` : `telegram: no answer (${why})`)
    this.status = status
    this.description = description
    this.unsent = unsent
  }
}

// Errors from before a connection exists (the same list as wa-post.mjs, which
// cannot be imported from here: it imports this file).
const NEVER_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'])
const neverConnected = (e) => {
  const c = e?.cause ?? e
  if (NEVER_CONNECTED.has(c?.code)) return true
  const all = Array.isArray(c?.errors) ? c.errors : []
  return all.length > 0 && all.every((x) => NEVER_CONNECTED.has(x?.code))
}

/** One Bot API call: its `result`, or a TelegramError. `signal` cuts it short beside its own 15 s. */
export async function telegramApi(token, method, payload, { base = TELEGRAM_API, signal } = {}) {
  let res
  try {
    res = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]) : AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const stopped = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw new TelegramError(0, '', { unsent: !stopped && neverConnected(e), why: stopped ? 'timed out' : 'network error' })
  }
  const j = await res.json().catch(() => null)
  if (!res.ok || j?.ok !== true) {
    // Nothing token-like, and no long number (a chat or message id), is repeated into the log.
    const why = typeof j?.description === 'string' ? j.description.replace(/(bot)?\d+:[\w-]+/g, '<token>').replace(/\d{5,}/g, '<n>') : ''
    throw new TelegramError(res.status, why.replace(/\s+/g, ' ').slice(0, 120))
  }
  return j.result
}

async function sendSms(cfg, text) {
  if (!cfg?.to) return null
  // termux-sms-send exists only on the watcher phone.
  await execFileAsync('termux-sms-send', ['-n', cfg.to, text], { timeout: TIMEOUT_MS })
  return 'sent'
}

async function sendWhatsapp(cfg, text) {
  if (!cfg?.phone || !cfg?.apikey) return null
  const url = new URL('https://api.callmebot.com/whatsapp.php')
  url.searchParams.set('phone', cfg.phone)
  url.searchParams.set('text', text)
  url.searchParams.set('apikey', cfg.apikey)
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`callmebot HTTP ${res.status}`)
  return 'sent'
}

// One notification slot for the whole window. The alert takes it first; the
// open post replaces it a few seconds later with the same text plus the
// button; the close post replaces that. `--id` is what makes termux-notification
// overwrite instead of stack (termux-api-package 0.60.0 --help: "notification
// id (will overwrite any previous notification with the same id)").
const NOTIFICATION_ID = 'ccbuddy-blinkdeal'

/** Android notification on the watcher phone itself. Free, no config needed. */
async function sendLocal(text) {
  try {
    await execFileAsync(
      'termux-notification',
      ['--id', NOTIFICATION_ID, '--title', TEMPLATES.openTitle, '--content', text, '--priority', 'max'],
      { timeout: TIMEOUT_MS },
    )
    return 'sent'
  } catch {
    return null // not on Termux
  }
}

/**
 * Fan out to every configured channel. Never throws and never blocks the
 * watcher: a dead channel must not stop the others or lose the detection.
 * Returns a per-channel result for the log.
 */
export async function notify(text) {
  const cfg = await loadConfig()
  return fanOut([
    ['telegram', () => sendTelegram(cfg.telegram, text)],
    ['sms', () => sendSms(cfg.sms, text)],
    ['whatsapp', () => sendWhatsapp(cfg.whatsapp, text)],
    ['local', () => sendLocal(text)],
  ])
}

async function fanOut(jobs) {
  const out = {}
  await Promise.all(
    jobs.map(async ([name, run]) => {
      try {
        const r = await run()
        if (r) out[name] = r
      } catch (e) {
        // Redact anything that could carry a token.
        out[name] = `failed: ${String(e.message ?? e).replace(/bot\d+:[\w-]+/g, 'bot<token>').slice(0, 80)}`
      }
    }),
  )
  return out
}

/** A per-channel result, for the log. */
export const fmtResults = (res) => Object.entries(res ?? {}).map(([k, v]) => `${k}:${v}`).join(' ') || '(no channels configured)'

/** A coin's weight in grams, read from its name or info line; null if neither says. */
export function gramsOf(s) {
  const m = /(\d+(?:\.\d+)?)\s*(?:grams?|gms?|g)\b/i.exec(`${s?.name} ${s?.info ?? ''}`)
  const g = m ? parseFloat(m[1]) : null
  return g > 0 ? g : null
}

/** What a coin costs with the coupon applied. */
export function afterCoupon(s) {
  return s.bestPrice ?? (s.discount != null ? s.price - s.discount : s.price)
}

/**
 * The cheapest coin per gram in a SKU list, weight read from its name.
 * Shared by the alert and the channel posts so the two can never disagree.
 */
export function cheapestPerGram(skus) {
  let best = null
  for (const s of skus ?? []) {
    const g = gramsOf(s)
    if (!g) continue
    const pg = Math.round(afterCoupon(s) / g)
    if (!best || pg < best.pg) best = { pg, g, brand: s.brand, url: s.url }
  }
  return best
}

// 24K, as the app's coin list counts it: 995 is sold as 24K too.
const PURE_24K = /24\s*K|99[59]/i

/**
 * The cheapest coin per gram at each of the weights most coins come in:
 * 24K only, coins carrying the coupon only, lightest first. One price per
 * weight because ₹/g is only comparable within a weight: a 0.5 g coin
 * always costs more per gram than a 20 g bar. Rows are { g, pg, brand, kind }
 * with kind 'bar' or 'coin', read from the product name. Malformed SKUs are
 * skipped, never printed.
 */
export function bestByWeight(skus, { limit = 4 } = {}) {
  const at = new Map()
  for (const s of Array.isArray(skus) ? skus : []) {
    if (!s || typeof s !== 'object') continue
    // The coupon page can list a coin the code does not discount (code null).
    if (s.code !== undefined && !/BLINK/i.test(s.code ?? '')) continue
    if (!PURE_24K.test(`${s.name ?? ''} ${s.info ?? ''}`)) continue
    const g = gramsOf(s)
    const price = Number(afterCoupon(s))
    if (!g || !(price > 0)) continue
    const pg = Math.round(price / g)
    const w = at.get(g) ?? { n: 0, best: null }
    w.n++
    if (!w.best || pg < w.best.pg) w.best = { g, pg, brand: s.brand, kind: /\bbar\b/i.test(s.name ?? '') ? 'bar' : 'coin' }
    at.set(g, w)
  }
  return [...at.values()]
    .sort((a, b) => b.n - a.n || a.best.g - b.best.g)
    .slice(0, limit)
    .map((w) => w.best)
    .sort((a, b) => a.g - b.g)
}

/**
 * A brand as a post should print it. Myntra sends some in capitals
 * ("BHIMA", "P N GADGIL JEWELLERS"), which reads as shouting; those are
 * title-cased, except vowel-less words that are initials (PMJ, MMTC). Company
 * suffixes go, and so do WhatsApp's formatting marks and line breaks, since
 * the name comes from a third party and lands in a public post.
 */
export function brandName(raw) {
  let b = String(raw ?? '').replace(/[\r\n*_~`]/g, ' ').replace(/\s+/g, ' ').trim()
  b = b.replace(/\s+(pvt\.?\s+ltd\.?|private\s+limited|ltd\.?)$/i, '')
  if (/[A-Z]{3}/.test(b) && b === b.toUpperCase()) {
    b = b.split(' ').map((w) => (/[AEIOU]/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(' ')
  }
  return b.slice(0, 40).trim()
}

/** "4:44 pm", IST. Arithmetic rather than Intl, so every Node build agrees. */
export function istClock(ms) {
  const d = new Date(ms + 330 * 60000)
  const h = d.getUTCHours()
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** "2026-10-04", the IST calendar date: a new day at 18:30 UTC. Arithmetic, as istClock is. */
export function istDate(ms) {
  return new Date(ms + 330 * 60000).toISOString().slice(0, 10)
}

/** The alert itself. Short, because SMS charges by the segment. */
export function composeAlert(feed) {
  const best = cheapestPerGram(feed.skus)
  const lines = [
    `${feed.code} live on Myntra${feed.discountPct ? ` — ${feed.discountPct}% off` : ''}`,
  ]
  if (best) lines.push(`Best: Rs ${best.pg.toLocaleString('en-IN')}/g (${best.brand} ${best.g}g)`)
  if (feed.source) lines.push(feed.source)
  return lines.join('\n')
}

// ---- Channel posts ---------------------------------------------------------
//
// Public, two per window: one when it opens, one when it closes. Every word a
// follower reads is in TEMPLATES and nowhere else. The open post goes out the
// moment the plain listing shows the code (onLive in blinkdeal.mjs), with what
// is known then: the code, its discount and the coupon page; TEMPLATES.open
// leaves out the count and the cheapest ₹/g it does not have yet. About 3 s
// later the coupon's first page (onFirstPage) knows the coverage count and has
// fifty real prices for the cheapest ₹/g, and the post is edited to say them.
// An edit pings nobody, so followers hear of the window once, at first sight.

export const APP_LINK = 'https://ccbuddy.app/blinkdeal'

// The WhatsApp Channel's link: the BLINKDEAL screen, as Telegram's is (his
// pick, 2026-10-29, over the /wa arrival link, which opens the app home).
export const WA_LINK = APP_LINK

// Blank-line-separated blocks; empty lines and empty blocks drop out, so a
// missing value never leaves a gap, a "null" or a dangling heading.
const blocks = (...bs) => bs.map((b) => b.filter(Boolean).join('\n')).filter(Boolean).join('\n\n')

export const TEMPLATES = {
  open: ({ code, pct, count, best, source }) =>
    [
      `${code} live on Myntra${pct ? ` — ${pct}% off gold coins` : ''}`,
      count ? `${count} coins covered` : null,
      best ? `Best: ₹${best.pg.toLocaleString('en-IN')}/g (${best.brand} ${best.g}g)` : null,
      source || null,
      APP_LINK,
    ]
      .filter(Boolean)
      .join('\n'),
  // `duration` is null when nothing watched the window end (closeWindow in
  // blinkdeal.mjs): how long it ran is not known then, so it is not said.
  close: ({ code, duration, count }) =>
    [duration ? `${code} is over — lasted ${duration}${count ? `, ${count} coins` : ''}` : `${code} is over`, APP_LINK].join('\n'),
  // The phone's own notification: its title per edge, and the button.
  openTitle: 'BLINKDEAL is live',
  closeTitle: 'BLINKDEAL is over',
  button: 'Post to channel',
  // The WhatsApp Channel (scraper/wa-post.mjs). One post per window, edited in
  // place when it ends, so followers are pinged once and anyone opening it
  // later sees it is over. `since`/`until` are IST clock times ("4:44 pm").
  waOpen: ({ code, pct, count, since, rows, source }) =>
    blocks(
      [`${code} live on Myntra${pct ? ` — ${pct}% off gold coins` : ''}`, since ? `Live since ${since}.` : null],
      rows?.length ? ['Cheapest 24K per gram after the coupon:', ...rows.map(TEMPLATES.waRow)] : [],
      [source ? `${count ? `${count} coins` : 'The coins'}: ${source}` : null, `Compare them all on CCBuddy: ${WA_LINK}`],
    ),
  waOver: ({ code, pct, since, until, duration, rows }) =>
    blocks(
      [`Over${until ? ` at ${until}` : ''}${duration ? `, after ${duration}` : ''}. These prices no longer apply.`],
      [`${code} was live on Myntra${pct ? ` — ${pct}% off gold coins` : ''}`, since ? `Live from ${since}${until ? ` to ${until}` : ''}.` : null],
      rows?.length ? ['Cheapest 24K per gram it gave:', ...rows.map(TEMPLATES.waRow)] : [],
      [`Gold coin prices on CCBuddy: ${WA_LINK}`],
    ),
  waRow: ({ g, pg, brand, kind }) => `${g} g · ₹${pg.toLocaleString('en-IN')}/g · ${brand ? `${brand} ` : ''}${kind === 'bar' ? 'bar' : 'coin'}`,
  // Heads the test-post on the private test channel, so a test can never pass
  // for a live deal wherever it ends up.
  waTest: 'TEST POST — not a live deal',
}

/**
 * The shell command behind the "Post to channel" button: copy the post, open
 * the channel. termux-notification hands it to `sh -c` with the environment
 * dropped ("most notably $PATH", per --help-actions), so PATH is set here and
 * nothing else is assumed. The text goes to termux-clipboard-set on stdin,
 * which is the one path that keeps its newlines. Pure, so the quoting can be
 * tested by running it under a real sh with stub commands.
 */
export const TERMUX_BIN = '/data/data/com.termux/files/usr/bin'

export function buttonAction(text, url, { binDir = TERMUX_BIN } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  return [
    `export PATH=${binDir}:$PATH`,
    `printf '%s' ${q(text)} | termux-clipboard-set`,
    `termux-open-url ${q(url)}`,
  ].join(' && ')
}

/**
 * The notification with the button, on the watcher phone. Without a channel
 * URL it is a plain notification carrying the post text.
 */
async function sendLocalPost(kind, text, cfg, { exec = execFileAsync, signal } = {}) {
  const url = cfg.whatsappChannel?.url
  const title = kind === 'close' ? TEMPLATES.closeTitle : TEMPLATES.openTitle
  const args = ['--id', NOTIFICATION_ID, '--title', title, '--content', text, '--priority', 'max']
  if (url) args.push('--button1', TEMPLATES.button, '--button1-action', buttonAction(text, url))
  try {
    await exec('termux-notification', args, signal ? { timeout: TIMEOUT_MS, signal } : { timeout: TIMEOUT_MS })
    return url ? 'sent+button' : 'sent'
  } catch {
    return null // not on Termux
  }
}

// ---- Unattended WhatsApp via Tasker ------------------------------------------
//
// Behind whatsappChannel.autopost, off by default. The watcher broadcasts one
// intent per edge; a Tasker profile on the phone (docs/whatsapp-tasker.md)
// catches it, opens the channel, types the text and presses send as a spare
// admin number. The broadcast is addressed to Tasker's package so Android 8+
// delivers it (implicit broadcasts to other apps are dropped there).

export const INTENT_ACTION = 'app.ccbuddy.blinkdeal.POST'
export const TASKER_PACKAGE = 'net.dinglisch.android.taskerm'

/**
 * Arguments for Termux's `am` (TermuxAm, a termux-tools dependency, so it is
 * always there). Extras are what Tasker turns into %kind %code %text %url —
 * lower-case names of three letters or more, exactly as Tasker's variable
 * rule wants them. Pure, exported, so the doc and the test share the truth.
 */
export function intentArgs(kind, { code, text, url }, { pkg = TASKER_PACKAGE, user = process.env.TERMUX__USER_ID } = {}) {
  const u = /^[1-9]\d*$|^0$/.test(user ?? '') ? user : '0'
  return [
    'broadcast', '--user', u,
    '-a', INTENT_ACTION,
    '-p', pkg,
    '--es', 'kind', kind,
    '--es', 'code', String(code ?? ''),
    '--es', 'text', text,
    '--es', 'url', String(url ?? ''),
  ]
}

async function sendTaskerIntent(kind, w, text, cfg, { exec = execFileAsync, signal } = {}) {
  const wa = cfg.whatsappChannel
  if (!wa?.autopost) return null
  if (!wa.url) throw new Error('whatsappChannel.autopost is on but whatsappChannel.url is not set')
  await exec('am', intentArgs(kind, { code: w.code, text, url: wa.url }, { pkg: wa.taskerPackage }), signal ? { timeout: TIMEOUT_MS, signal } : {
    timeout: TIMEOUT_MS,
  })
  return 'broadcast'
}

/** "36 min", "1 h 05 min". Windows have run 33-36 min; never show seconds. */
export function formatDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/**
 * Render one post from the window as the watcher knows it at that moment.
 *   open   { code, discountPct, totalCount?, skus, source }: at first sight
 *          skus is [] and totalCount null, so there is no count and no Best line
 *   close  { code, from, to, approx?, maxSkus? | skuCount? }
 * An `approx` close is one the watcher did not see happen: its `to` is the
 * last time the window was seen live, so to − from is only a lower bound,
 * and the post leaves the length out rather than state it.
 */
export function composePost(kind, w) {
  if (kind === 'open') {
    const skus = w.skus ?? []
    return TEMPLATES.open({
      code: w.code,
      pct: w.discountPct,
      count: w.totalCount ?? (skus.length || null),
      best: cheapestPerGram(skus),
      source: w.source,
    })
  }
  if (kind === 'close') {
    return TEMPLATES.close({
      code: w.code,
      duration: w.approx === true ? null : formatDuration(Date.parse(w.to) - Date.parse(w.from)),
      count: w.maxSkus ?? w.skuCount ?? null,
    })
  }
  throw new Error(`unknown post kind ${kind}`)
}

/**
 * Publish one post on every configured public channel. Same contract as
 * notify(): never throws, never blocks the watcher, returns a per-channel
 * result for the log. `dryRun` prints the post and sends nothing — the way
 * to exercise this anywhere without a real channel ever seeing it.
 *
 * An opening comes in stages, sharing `tg` ({ state, messageId, full }, the
 * Telegram post of this window so far):
 *   'sight'  the Telegram channel alone: sendMessage, then tg.state is 'sent'
 *            (with messageId when Telegram gave an integer one), 'unknown' (no
 *            answer, or a 5xx: it may have gone out) or 'unsent' (a 4xx, or no
 *            connection at all). Unset when no channel is configured.
 *   'full'   the Telegram channel alone: the post edited to this text when it
 *            has a message id ("message is not modified" counts as done);
 *            else sent, once, when none went out ('unsent' or unset); else
 *            left as it is ('unknown': it may be out, and a second could never
 *            be taken back). tg.full then says how it went: 'done' (this text
 *            is on Telegram), 'refused' (a 4xx other than 429: not worth a
 *            retry) or 'failed'.
 *   'local'  the local notification and the Tasker intent, which cannot be
 *            edited, so they carry the full text, once, at the first page.
 *   'notification'  the local notification alone, put back on a tick that
 *            sees an opening already filled in (its feed write was lost): the
 *            alert's own notification, under the same id, took its place.
 *            The Tasker intent is never sent twice.
 *   none     the single post: 'full' and 'local' together.
 * A close at stage 'sight' is the Telegram channel alone too: the end of an
 * opening that never got past its first sight, which no notification or
 * Tasker ever carried. `signal` cuts the opening's calls short (step()'s
 * bound), and a close at stage 'sight' too. `config`, `base` and `exec` are
 * for tests.
 */
export async function postWindow(kind, w, { dryRun = false, stage = null, tg = {}, config, base = TELEGRAM_API, signal, exec = execFileAsync } = {}) {
  const text = composePost(kind, w)
  if (dryRun) {
    const how = kind !== 'open' ? '' : stage === 'local' ? ', to the notification and Tasker' : stage === 'notification' ? ', to the notification again' : stage !== 'sight' && tg.state === 'dry' ? ', edited to' : ''
    console.log(`DRY-RUN ${kind} post${how}:\n${text}`)
    if (kind === 'open' && stage === 'sight') tg.state = 'dry'
    return { dryRun: 'printed' }
  }
  const cfg = config ?? (await loadConfig())
  const channel = { token: cfg.telegram?.token, chatId: cfg.telegram?.channelId, base, signal }
  if (stage === 'sight') {
    return fanOut([['telegramChannel', () => (kind === 'open' ? openAtSight(channel, text, tg) : sendTelegram(channel, text, { base }))]])
  }
  if (kind === 'open' && stage === 'notification') {
    return fanOut([['local', () => sendLocalPost(kind, text, cfg, { exec, signal })]])
  }
  if (kind === 'open') {
    return fanOut([
      ...(stage === 'local' ? [] : [['telegramChannel', () => openInFull(channel, text, tg)]]),
      ...(stage === 'full'
        ? []
        : [
            ['local', () => sendLocalPost(kind, text, cfg, { exec, signal })],
            ['tasker', () => sendTaskerIntent(kind, w, text, cfg, { exec, signal })],
          ]),
    ])
  }
  return fanOut([
    ['telegramChannel', () => sendTelegram(channel, text, { base })],
    ['local', () => sendLocalPost(kind, text, cfg, { exec })],
    ['tasker', () => sendTaskerIntent(kind, w, text, cfg, { exec })],
  ])
}

/** The opening, sent to the Telegram channel; `tg` says how it went. */
async function openAtSight({ token, chatId, base, signal }, text, tg) {
  if (!token || !chatId) return null
  try {
    const result = await telegramApi(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, { base, signal })
    tg.state = 'sent'
    tg.messageId = Number.isInteger(result?.message_id) ? result.message_id : null
    return 'sent'
  } catch (e) {
    tg.state = e?.unsent || (e?.status >= 400 && e?.status < 500) ? 'unsent' : 'unknown'
    throw e
  }
}

/** The opening in full: the post edited, or sent once when none is out, or left as it is. tg.full says how. */
async function openInFull({ token, chatId, base, signal }, text, tg) {
  if (!token || !chatId) return null
  if (Number.isInteger(tg.messageId)) {
    try {
      await telegramApi(token, 'editMessageText', { chat_id: chatId, message_id: tg.messageId, text, disable_web_page_preview: true }, { base, signal })
    } catch (e) {
      if (!(e?.status === 400 && /message is not modified/i.test(e.description ?? ''))) {
        tg.full = e?.status >= 400 && e.status < 500 && e.status !== 429 ? 'refused' : 'failed'
        throw e
      }
    }
    tg.full = 'done'
    return 'edited'
  }
  if (tg.state && tg.state !== 'unsent') return 'not sent again'
  const r = await openAtSight({ token, chatId, base, signal }, text, tg)
  tg.full = 'done'
  return r
}

// ---- The Telegram opening, once per window --------------------------------------
//
// Posting at first sight makes an opening that never reaches its first page
// (the fetch failed, or the phone restarted) post again on the next tick: that
// tick's feed was never live, so it is an opening too. A record on the phone,
// beside the WhatsApp ledger, stops it: telegram-open.json, the one opening
// out and not yet ended
// { v, code, from, state, messageId, filled, edited, retry, postedAt }.
//   state   'sending' (written before the send), 'sent', 'unknown' (may be
//           out), 'none' (no Telegram post: no channel, or it was refused)
//   filled  the notification and Tasker are made (or under way): never twice
//   edited  the full text is on Telegram (the edit made, or the post sent
//           whole); until then a good live read makes the edit, at most
//           TG_EDIT_RETRIES times, TG_EDIT_RETRY_GAP_MS apart
//   retry   { tries, lastTry, refused } of those edits; a 4xx other than 429
//           ends them. None of them is ever a new message.
// Created exclusively (one run posts), each write whole. Every good read that
// does not show its code live ends it; one never published then gets its
// "is over" (TEMPLATES.close with no length), as WhatsApp gets its "Over.".
// One older than TG_ADOPT_MAX_AGE_MS is never taken for the window opening now.
// One younger, of another code, makes an opening a code change whatever the
// feed says (the write that showed it live may have been lost): it is left as
// it is, and nothing is posted at sight, until the new code's own page
// confirms it, so a code the plain listing names for a moment cannot replace
// it and have its window posted again on the next tick. When that page does
// confirm it, an opening on record that never got its own first page was
// never published (a sight is made only when the feed shows nothing live),
// so it gets its "is over" then, beside the new opening, as a good read would
// give it; one that got its page is a code change, ended without a post.

export const TG_OPEN_PATH = join(ROOT, '.wa-ledger', 'telegram-open.json')
// The same bound as wa-phone.mjs ADOPT_MAX_AGE_MS: no window lasts that long.
export const TG_ADOPT_MAX_AGE_MS = 2 * 3600 * 1000
// The same as wa-phone.mjs EDIT_RETRIES and EDIT_RETRY_GAP_MS, which bound the
// WhatsApp fill the same way (that file cannot be imported from here).
export const TG_EDIT_RETRIES = 3
export const TG_EDIT_RETRY_GAP_MS = 20 * 1000
// Each such edit's bound: the phone's own deadline for a tick's WhatsApp work
// (wa-phone.mjs PHONE_TIMEOUT_MS), which it runs beside, so a live tick is
// held no longer than that work may already hold it.
const TG_RETRY_MS = 8000
// How long a tick whose coupon page failed still waits for its sight's send
// to be answered, from the failure. That tick publishes no window, and the
// next one, which crawls it, starts only when this one ends; before the first
// sight posts, such a tick ended at once. A send cut off here may be out: it
// is never sent again, nor filled in, and its close comes as ever.
export const TG_SIGHT_GRACE_MS = 2000

/** The record at `path`, or (null) one in memory only, for tests, dry runs and replays. */
export function telegramRecord(path = null) {
  if (!path) {
    let held = null
    const copy = (v) => (v ? JSON.parse(JSON.stringify(v)) : null)
    return {
      read: async () => copy(held),
      create: async (rec) => (held ? false : ((held = copy(rec)), true)),
      replace: async (rec) => {
        held = copy(rec)
      },
      remove: async () => {
        held = null
      },
    }
  }
  const dir = dirname(path)
  const text = (v) => `${JSON.stringify(v, null, 1)}\n`
  const tmpName = () => `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  return {
    /** The record, or null. One that cannot be read is moved aside: every write here is whole. */
    async read() {
      let raw
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return null
      }
      try {
        const o = JSON.parse(raw)
        if (o && typeof o === 'object' && typeof o.code === 'string') return o
      } catch {
        /* below */
      }
      await rename(path, path.replace(/\.json$/, `.bad-${Date.now()}.json`)).catch(() => {})
      return null
    },
    /** Created only if there is none, whole, in one step (a hard link of a finished file). False when one exists. */
    async create(rec) {
      await mkdir(dir, { recursive: true })
      const tmp = tmpName()
      await writeFile(tmp, text(rec))
      try {
        await link(tmp, path)
        return true
      } catch (e) {
        if (e?.code === 'EEXIST') return false
        try {
          await writeFile(path, text(rec), { flag: 'wx' })
          return true
        } catch (e2) {
          if (e2?.code === 'EEXIST') return false
          throw e2
        }
      } finally {
        await unlink(tmp).catch(() => {})
      }
    },
    /** Written beside it, then renamed over it. */
    async replace(rec) {
      await mkdir(dir, { recursive: true })
      const tmp = tmpName()
      await writeFile(tmp, text(rec))
      await rename(tmp, path)
    },
    async remove() {
      await unlink(path).catch(() => {})
    },
  }
}

const liveCodeOf = (feed) => (feed?.live === true ? feed.lastLive?.code ?? feed.code ?? null : null)

/**
 * One tick's Telegram channel opening, for step() in blinkdeal.mjs:
 *   sight(w)   at the plain listing: the opening as known then, sent now;
 *              nothing, when the record holds another code's opening posted
 *              under TG_ADOPT_MAX_AGE_MS ago (a code change the feed may not
 *              show: its write lost), until the first page confirms this code
 *   page(w)    at the coupon's first page: the notification and Tasker at
 *              once, as before, and the Telegram post edited to the full
 *              opening once sight's send is answered (or sent whole, when
 *              none went out, or this tick had no sight, or sight waited for
 *              this page: a code change). When sight waited for it, the other
 *              code's opening, if it never got its own first page, is told
 *              over beside this one ("is over", Telegram alone), as idle()
 *              would tell it. On a tick that sees an opening already filled
 *              in, the notification alone is put back: the alert took its place
 *   settle()   before the feed is written: waits for all of it, until boundMs
 *              after the first page, then cuts whatever is still in flight.
 *              When no page came (its fetch failed), the sight's send gets
 *              only TG_SIGHT_GRACE_MS more (never past boundMs after the sight)
 *   posted()   whether any stage was made (the feed's postedAt)
 *   idle({ previous, next })   any tick that is not an opening: a good read
 *              that does not show the record's code live ends it, posting "is
 *              over" for one never published; one that shows it live makes
 *              the edit still owed, if any (TG_EDIT_RETRIES at most,
 *              TG_EDIT_RETRY_GAP_MS apart, each cut at TG_RETRY_MS)
 * Nothing is awaited by the caller but settle() and idle(), and nothing
 * throws. `record` is telegramRecord(); `post` is postWindow or a test's fake.
 */
export function channelPoster({ post = postWindow, record = telegramRecord(null), dryRun = false, log = console.log, error = console.error, boundMs = TIMEOUT_MS, now = Date.now } = {}) {
  const ctrl = new AbortController()
  const tg = {}
  let claim = null // the record read and this window claimed in it: file work only, no network
  let sending = null // sight's send, and its outcome written
  let chain = null // all this tick posts: settle() waits for it
  let sightAt = null
  let pageAt = null
  let made = false
  let taken = false // another run on this clone holds the record: this one posts nothing
  let rec = null // this tick's record, as it stands; every write is of it as it is then
  let owed = null // the record this tick's opening replaced, still owed its "is over"
  let io = Promise.resolve()
  const stamp = () => new Date().toISOString()
  const short = (e) => String(e?.message ?? e).slice(0, 80)
  // A record that cannot be read or written never stops a post.
  const safely = async (what, fn) => {
    try {
      return await fn()
    } catch (e) {
      error(`POST open: the record could not be ${what} (${short(e)})`)
      return undefined
    }
  }
  // The record's writes, one at a time, so sight's outcome and the first
  // page's `filled` land in either order and neither undoes the other.
  const serial = (fn) => {
    const p = io.then(fn)
    io = p.catch(() => {})
    return p
  }
  const save = () => serial(() => (rec ? safely('written', () => record.replace(rec)) : undefined))
  const send = async (stage, w) => {
    try {
      const res = await post('open', w, { dryRun, stage, tg, signal: ctrl.signal })
      // The notification put back is no post of this tick's.
      if (stage !== 'notification') made = true
      log(`POST open${stage === 'sight' ? '' : stage === 'notification' ? ': the notification put back,' : ' filled in'} ${fmtResults(res)} at ${stamp()}`)
    } catch (e) {
      // A channel failing must never cost the window its crawl and publish.
      error(`POST open failed: ${short(e)}`)
    }
  }
  const outcome = () => (tg.state === 'sent' || tg.state === 'unknown' ? tg.state : null)
  const entry = (w) => ({ v: 1, code: w.code, from: w.from ?? null, state: 'sending', messageId: null, filled: false, edited: false, postedAt: stamp() })

  /**
   * This window in the record: 'adopted' (an earlier tick posted it), 'taken'
   * (another run holds it), 'unconfirmed' (another code's opening is on
   * record and this code is not yet confirmed by its page) or 'new'.
   */
  const claimFor = (w, { confirmed = false, held = false } = {}) =>
    serial(async () => {
      const r = await safely('read', () => record.read())
      // Posted under TG_ADOPT_MAX_AGE_MS ago (a time that cannot be read counts as recent).
      const recent = r && !(now() - Date.parse(r.postedAt) >= TG_ADOPT_MAX_AGE_MS)
      if (recent && r.code === w.code) {
        // This window, posted by an earlier tick whose first page or feed write never came: not again.
        rec = r
        tg.state = r.state === 'sending' ? 'unknown' : r.state
        if (Number.isInteger(r.messageId)) tg.messageId = r.messageId
        log(`POST open: ${w.code} was posted at ${r.postedAt} by an earlier tick that did not publish it; not posting it again`)
        return 'adopted'
      }
      // Another code, recent, and this one seen only on the plain listing: a
      // code change for this phone, whatever the feed says (the write that
      // showed the other code live may have been lost). The plain listing can
      // name another code for a moment, so the record stays as it is, and
      // nothing is posted, until this code's own page confirms it: a flicker
      // whose page fails then leaves the other code's opening on record, and
      // the next tick that sees that code adopts it rather than posting it again.
      if (recent && !confirmed) {
        log(`POST open: ${w.code} waits for its coupon page: ${r.code}, posted at ${r.postedAt}, is on record and no good read has ended it`)
        return 'unconfirmed'
      }
      // Another code (confirmed by this code's page), or too old to be this
      // window: ended without a post, as a code change always was.
      if (r) await safely('removed', () => record.remove())
      const first = entry(w)
      const ok = await safely('written', () => record.create(first))
      if (ok === false) {
        taken = true
        log(`POST open: another run on this clone is posting ${w.code}; not posting it twice`)
        return 'taken'
      }
      rec = ok ? first : null
      // But the opening this tick's sight waited for (`held`: the feed on
      // file showed nothing live, so no feed ever published it), when it never
      // got its own first page: a sight whose page failed, not a code change.
      // It is owed its "is over", as a good read would end it.
      if (held && recent && r.code !== w.code && !r.filled) owed = r
      return 'new'
    })

  /** The opening this tick's opening replaced, never published: "is over" on Telegram alone (TEMPLATES.close, no length), cut at settle()'s bound. */
  async function endOwed(code) {
    const r = owed
    owed = null
    if (!r || !['sent', 'unknown', 'sending'].includes(r.state)) return
    try {
      const res = await post('close', { code: r.code, approx: true }, { dryRun, stage: 'sight', signal: ctrl.signal })
      log(`POST close ${fmtResults(res)} at ${stamp()} (${r.code}: posted at ${r.postedAt}, never published; ${code}'s page replaced it)`)
    } catch (e) {
      error(`POST close failed: ${short(e)}`)
    }
  }

  /**
   * The edit a good live read of the record's window still owes (the first
   * page's failed, or the phone stopped before it), from this read. Its try
   * is written before the call, so a restart never makes it one more.
   */
  async function refill(r, next) {
    if (r.edited !== false || r.state !== 'sent' || !Number.isInteger(r.messageId)) return
    const f = r.retry ?? {}
    if (f.refused || (f.tries ?? 0) >= TG_EDIT_RETRIES || (f.lastTry && now() - f.lastTry < TG_EDIT_RETRY_GAP_MS)) return
    const retry = { tries: (f.tries ?? 0) + 1, lastTry: now() }
    await record.replace({ ...r, retry })
    const t = { state: 'sent', messageId: r.messageId }
    const res = await post('open', next, { dryRun, stage: 'full', tg: t, signal: AbortSignal.timeout(Math.min(boundMs, TG_RETRY_MS)) })
    log(`POST open filled in ${fmtResults(res)} at ${stamp()} (on a later tick, try ${retry.tries} of ${TG_EDIT_RETRIES})`)
    if (t.full === 'done') await record.replace({ ...r, retry, edited: true })
    else if (t.full === 'refused') await record.replace({ ...r, retry: { ...retry, refused: true } })
  }

  return {
    sight(w) {
      if (claim) return
      sightAt = now()
      claim = claimFor(w)
      sending = claim.then(async (how) => {
        if (how !== 'new') return
        await send('sight', w)
        const state = outcome()
        if (state) {
          if (!rec) return
          rec = { ...rec, state, messageId: tg.messageId ?? null }
          await save()
        } else if (rec && !rec.filled) {
          // Nothing went out, and the first page has not come: it posts the opening whole, as before.
          rec = null
          await serial(() => safely('removed', () => record.remove()))
        }
      })
      chain = sending
    },
    page(w) {
      pageAt = now()
      // No sight on this tick (a code change), or the sight waited for this
      // page (another code on record): claimed here, and posted whole.
      claim = claim ? claim.then((how) => (how === 'unconfirmed' ? claimFor(w, { confirmed: true, held: true }) : how)) : claimFor(w, { confirmed: true })
      const sighted = sending ?? Promise.resolve()
      let again = false // the notification and Tasker were made by an earlier tick
      // Written first: the notification and Tasker go once, whatever happens next.
      const marked = claim.then(async () => {
        if (taken) return false
        if (rec?.filled) {
          again = true
          log(`POST open: ${w.code} was filled in by an earlier tick; not again`)
          return true
        }
        if (rec) {
          rec = { ...rec, filled: true }
          await save()
          return true
        }
        const full = { ...entry(w), filled: true }
        const ok = await serial(() => safely('written', () => record.create(full)))
        if (ok === false) {
          taken = true
          log(`POST open: another run on this clone is posting ${w.code}; not posting it twice`)
          return false
        }
        if (ok) rec = full
        return true
      })
      // They cannot be edited, so they carry the full text: now, beside sight's send, as before.
      // Made by an earlier tick, Tasker is not sent again; the notification is
      // put back, since this tick's alert took its place (the same id).
      const local = marked.then((go) => (go ? send(again ? 'notification' : 'local', w) : undefined))
      // The Telegram post once sight's send is answered: edited in full, or sent whole when none went out.
      const telegram = Promise.all([sighted, marked]).then(async ([, go]) => {
        if (!go || rec?.edited || (again && !Number.isInteger(tg.messageId))) return
        const fresh = !Number.isInteger(tg.messageId) && (!tg.state || tg.state === 'unsent')
        await send('full', w)
        if (!rec) return
        rec = {
          ...rec,
          ...(fresh ? { state: outcome() ?? 'none', messageId: tg.messageId ?? null } : {}),
          ...(tg.full === 'done' ? { edited: true } : {}),
          ...(tg.full === 'refused' ? { retry: { ...rec.retry, refused: true } } : {}),
        }
        await save()
      })
      // The opening this one replaced, if it is owed its end: beside this one,
      // never behind it, so a slow send of either cannot cost the other its time.
      chain = Promise.all([local, telegram, marked.then(() => endOwed(w.code))])
    },
    async settle() {
      try {
        if (!chain) return
        const wait = (ms) => {
          let t
          return [new Promise((r) => (t = setTimeout(() => r(false), Math.max(0, ms)))), () => clearTimeout(t)]
        }
        // No first page (its fetch failed): this tick publishes no window, and
        // the next one, which crawls it, waits for this one to end.
        const until = pageAt != null ? pageAt + boundMs : Math.min(sightAt + boundMs, now() + TG_SIGHT_GRACE_MS)
        const [timer, stop] = wait(until - now())
        const done = await Promise.race([chain.then(() => true), timer])
        stop()
        if (done) return
        ctrl.abort(new DOMException('the channel post time for this tick is up', 'TimeoutError'))
        error(pageAt != null ? `POST open: not done ${boundMs / 1000} s after the first page; cut off` : 'POST open: no first page, and the post at sight still unanswered; cut off')
        // What is left is the record's last write, on this phone.
        const [grace, stop2] = wait(1000)
        await Promise.race([chain, grace])
        stop2()
      } catch (e) {
        error(`POST open: settle failed (${short(e)})`)
      }
    },
    posted: () => made,
    async idle({ previous, next } = {}) {
      try {
        if (next?.ok !== true) return
        const r = await record.read()
        if (!r) return
        if (liveCodeOf(next) === r.code) {
          await refill(r, next).catch((e) => error(`POST open: the edit owed was not made (${short(e)})`))
          return
        }
        await record.remove()
        // Shown live by the feed before: that window's close is step()'s own close post.
        if (liveCodeOf(previous) === r.code) return
        if (!['sent', 'unknown', 'sending'].includes(r.state)) return
        const res = await post('close', { code: r.code, approx: true }, { dryRun, stage: r.filled ? null : 'sight' })
        log(`POST close ${fmtResults(res)} at ${stamp()} (${r.code}: posted at ${r.postedAt}, never published)`)
      } catch (e) {
        error(`POST close failed: ${short(e)}`)
      }
    },
  }
}

/**
 * Fill in telegram.chatId by asking the bot who has messaged it, and write it
 * back to .notify.env. Saves reading raw JSON off a getUpdates URL on a phone.
 */
async function resolveChat() {
  const path = join(ROOT, '.notify.env')
  const cfg = await loadConfig()
  const token = cfg.telegram?.token
  if (!token) {
    console.error('Put your bot token in .notify.env first, as telegram.token.')
    process.exitCode = 2
    return
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const j = await res.json().catch(() => ({}))
  if (!j.ok) {
    console.error(`Telegram refused the token (HTTP ${res.status}). Check it was copied whole.`)
    process.exitCode = 1
    return
  }
  const chats = new Map()
  for (const u of j.result ?? []) {
    const c = u.message?.chat ?? u.channel_post?.chat
    if (c?.id) chats.set(String(c.id), [c.first_name, c.username && `@${c.username}`].filter(Boolean).join(' ') || c.type)
  }
  if (chats.size === 0) {
    console.error('The bot has no messages yet. Open Telegram, find your bot, send it any message, then run this again.')
    process.exitCode = 1
    return
  }
  const [id, who] = [...chats][chats.size - 1]
  cfg.telegram.chatId = id
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`)
  console.log(`chatId ${id} (${who}) saved to .notify.env`)
  if (chats.size > 1) {
    console.log(`note: ${chats.size} chats have messaged this bot; picked the most recent.`)
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').toLowerCase().endsWith('/notify.mjs')) {
  if (process.argv.includes('--resolve-chat')) {
    await resolveChat()
    process.exit(process.exitCode ?? 0)
  }
  if (process.argv.includes('--preview') || process.argv.includes('--post-test')) {
    // The captured 2026-09-15 window stands in for a live one. Its close is
    // synthetic: the fixture predates the history file, so give it 36 min,
    // the one exact duration measured (2026-09-16).
    const fx = JSON.parse(await readFile(join(ROOT, 'scraper', 'fixtures', 'live-window-2026-09-15.json'), 'utf8'))
    // The fixture predates discountPct; its coins were 6% off.
    const open = { ...fx, discountPct: fx.discountPct ?? 6 }
    const from = fx.lastLive?.from ?? fx.generated
    const close = { code: fx.code, from, to: new Date(Date.parse(from) + 36 * 60000).toISOString(), maxSkus: fx.totalCount }
    // What the plain listing knows: the code, its discount, the coupon page.
    const sight = { code: fx.code, couponId: fx.couponId, source: fx.source, discountPct: open.discountPct, skus: [], totalCount: null }
    const dryRun = !process.argv.includes('--post-test')
    // One opening, as a window has it: sent at first sight, then edited in full (the bot needs
    // to be able to edit its own channel posts) beside the notification and Tasker, then the close.
    const tg = {}
    for (const [kind, w, stage] of [['open', sight, 'sight'], ['open', open, 'local'], ['open', open, 'full'], ['close', close, null]]) {
      if (!dryRun && stage === 'local') await new Promise((r) => setTimeout(r, 3000))
      const res = await postWindow(kind, w, { dryRun, stage, tg })
      if (!dryRun) console.log(`${kind}${stage ? ` (${stage})` : ''}:`, JSON.stringify(res))
    }
    process.exit(0)
  }
  const cfg = await loadConfig()
  const configured = ['telegram', 'sms', 'whatsapp'].filter((k) => cfg[k])
  console.log('configured channels:', configured.join(', ') || '(none — add .notify.env)')
  const res = await notify(
    process.argv.includes('--test')
      ? 'CCBuddy test: BLINKDEAL watcher alerting works.'
      : 'CCBuddy BLINKDEAL watcher.',
  )
  console.log('result:', JSON.stringify(res, null, 1))
}
