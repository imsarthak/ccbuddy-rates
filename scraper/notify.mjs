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
//                          "autopost": false }
//   }
//
// Environment variables override the file, for a host that would rather not
// keep one: BLINKDEAL_TELEGRAM_TOKEN, BLINKDEAL_TELEGRAM_CHANNEL,
// BLINKDEAL_WHATSAPP_CHANNEL_URL, BLINKDEAL_WHATSAPP_AUTOPOST=1.
//
// whatsappChannel.autopost (off by default) additionally broadcasts an Android
// intent on each edge for a Tasker profile on the phone to pick up and post
// unattended, as a spare admin number. Setup and risks: docs/whatsapp-tasker.md.
//
//   node scraper/notify.mjs --test       send a test message on every alert channel
//   node scraper/notify.mjs --preview    print the open and close channel posts
//                                        rendered from the captured window, send nothing
//   node scraper/notify.mjs --post-test  send those two posts to telegram.channelId
//                                        (point it at a private test channel first)
//
// Two different things go out of here. The ALERT is the private ping to
// Sarthak the moment a window opens (telegram chatId, sms, whatsapp, local).
// The POSTS are public: one when a window opens and one when it closes, to
// the Telegram channel (telegram.channelId — the bot must be an admin of it)
// and, one tap away, to the WhatsApp Channel: there is no API for those, so
// the local notification carries a "Post to channel" button that copies the
// post and opens the channel (whatsappChannel.url); an admin pastes and sends.
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

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 15000

async function loadConfig() {
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
  return out
}

async function sendTelegram(cfg, text) {
  if (!cfg?.token || !cfg?.chatId) return null
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    // Telegram says why in the body ("bot is not a member of the channel
    // chat", "chat not found"), and that is the whole diagnosis on a phone.
    const why = await res.json().then((j) => j.description).catch(() => '')
    throw new Error(`telegram HTTP ${res.status}${why ? `: ${why}` : ''}`)
  }
  return 'sent'
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

/**
 * The cheapest coin per gram in a SKU list, weight read from its name.
 * Shared by the alert and the channel posts so the two can never disagree.
 */
export function cheapestPerGram(skus) {
  const parseG = (s) => {
    const m = /(\d+(?:\.\d+)?)\s*(?:grams?|gms?|g)\b/i.exec(`${s.name} ${s.info ?? ''}`)
    return m ? parseFloat(m[1]) : null
  }
  const after = (s) => s.bestPrice ?? (s.discount != null ? s.price - s.discount : s.price)
  let best = null
  for (const s of skus ?? []) {
    const g = parseG(s)
    if (!g) continue
    const pg = Math.round(after(s) / g)
    if (!best || pg < best.pg) best = { pg, g, brand: s.brand, url: s.url }
  }
  return best
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
// follower reads is in TEMPLATES and nowhere else. The open post goes out
// from the coupon's first page (see onFirstPage in blinkdeal.mjs), so it
// knows the coverage count and has fifty real prices for the cheapest ₹/g.

export const APP_LINK = 'https://ccbuddy.app/blinkdeal'

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
  close: ({ code, duration, count }) =>
    [`${code} is over — lasted ${duration}${count ? `, ${count} coins` : ''}`, APP_LINK].join('\n'),
  // The phone's own notification: its title per edge, and the button.
  openTitle: 'BLINKDEAL is live',
  closeTitle: 'BLINKDEAL is over',
  button: 'Post to channel',
}

/**
 * The shell command behind the "Post to channel" button: copy the post, open
 * the channel. termux-notification hands it to `sh -c` with the environment
 * dropped ("most notably $PATH", per --help-actions), so PATH is set here and
 * nothing else is assumed. The text goes to termux-clipboard-set on stdin,
 * which is the one path that keeps its newlines. Pure, so the quoting can be
 * tested by running it under a real sh with stub commands.
 */
export function buttonAction(text, url) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  return [
    'export PATH=/data/data/com.termux/files/usr/bin:$PATH',
    `printf '%s' ${q(text)} | termux-clipboard-set`,
    `termux-open-url ${q(url)}`,
  ].join(' && ')
}

/**
 * The notification with the button, on the watcher phone. Without a channel
 * URL it is a plain notification carrying the post text.
 */
async function sendLocalPost(kind, text, cfg) {
  const url = cfg.whatsappChannel?.url
  const title = kind === 'close' ? TEMPLATES.closeTitle : TEMPLATES.openTitle
  const args = ['--id', NOTIFICATION_ID, '--title', title, '--content', text, '--priority', 'max']
  if (url) args.push('--button1', TEMPLATES.button, '--button1-action', buttonAction(text, url))
  try {
    await execFileAsync('termux-notification', args, { timeout: TIMEOUT_MS })
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

async function sendTaskerIntent(kind, w, text, cfg) {
  const wa = cfg.whatsappChannel
  if (!wa?.autopost) return null
  if (!wa.url) throw new Error('whatsappChannel.autopost is on but whatsappChannel.url is not set')
  await execFileAsync('am', intentArgs(kind, { code: w.code, text, url: wa.url }, { pkg: wa.taskerPackage }), {
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
 *   open   { code, discountPct, totalCount?, skus, source }
 *   close  { code, from, to, maxSkus? | skuCount? }
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
      duration: formatDuration(Date.parse(w.to) - Date.parse(w.from)),
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
 */
export async function postWindow(kind, w, { dryRun = false } = {}) {
  const text = composePost(kind, w)
  if (dryRun) {
    console.log(`DRY-RUN ${kind} post:\n${text}`)
    return { dryRun: 'printed' }
  }
  const cfg = await loadConfig()
  return fanOut([
    ['telegramChannel', () => sendTelegram({ token: cfg.telegram?.token, chatId: cfg.telegram?.channelId }, text)],
    ['local', () => sendLocalPost(kind, text, cfg)],
    ['tasker', () => sendTaskerIntent(kind, w, text, cfg)],
  ])
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
    // The fixture predates discountPct; the digits in the code are the same
    // fallback the watcher uses (blinkdeal.mjs imports this file, so it
    // cannot be imported back from here).
    const open = { ...fx, discountPct: fx.discountPct ?? (Number(/(\d+)\s*$/.exec(fx.code)?.[1]) || null) }
    const from = fx.lastLive?.from ?? fx.generated
    const close = { code: fx.code, from, to: new Date(Date.parse(from) + 36 * 60000).toISOString(), maxSkus: fx.totalCount }
    const dryRun = !process.argv.includes('--post-test')
    for (const [kind, w] of [['open', open], ['close', close]]) {
      const res = await postWindow(kind, w, { dryRun })
      if (!dryRun) console.log(`${kind}:`, JSON.stringify(res))
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
