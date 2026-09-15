// Alerting for the BLINKDEAL watcher.
//
// Detection speed is wasted if the alert is slow, so this fires the moment a
// window opens, on whichever channels are configured. Every channel is
// optional; missing config is skipped silently rather than failing the run.
//
// Config lives in a gitignored `.notify.env` at the repo root, as JSON:
//
//   {
//     "telegram": { "token": "123456:ABC...", "chatId": "987654321" },
//     "sms":      { "to": "+919876543210" },
//     "whatsapp": { "phone": "+919876543210", "apikey": "123456" }
//   }
//
//   node scraper/notify.mjs --test    send a test message on every channel
//
// Channel notes:
//   telegram  Free and instant, reaches any device. Make a bot with
//             @BotFather; get chatId by messaging the bot then opening
//             https://api.telegram.org/bot<token>/getUpdates
//   sms       Sent by the watcher phone itself through Termux, so it needs a
//             SIM with credit and the Termux:API app with SMS permission.
//             Costs whatever your plan charges. Works when data does not.
//   whatsapp  Routed through CallMeBot, a free third party. Meta's own API
//             needs a business account and template approval, which is far
//             more setup than this is worth. The trade-off is real: CallMeBot
//             sees the message text. Keep alerts free of anything private —
//             a coupon code is public information, so this is fine here.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 15000

async function loadConfig() {
  try {
    return JSON.parse(await readFile(join(ROOT, '.notify.env'), 'utf8'))
  } catch {
    return {}
  }
}

async function sendTelegram(cfg, text) {
  if (!cfg?.token || !cfg?.chatId) return null
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`)
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

/** Android notification on the watcher phone itself. Free, no config needed. */
async function sendLocal(text) {
  try {
    await execFileAsync(
      'termux-notification',
      ['--title', 'BLINKDEAL is live', '--content', text, '--priority', 'max'],
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
  const jobs = [
    ['telegram', () => sendTelegram(cfg.telegram, text)],
    ['sms', () => sendSms(cfg.sms, text)],
    ['whatsapp', () => sendWhatsapp(cfg.whatsapp, text)],
    ['local', () => sendLocal(text)],
  ]
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

/** The alert itself. Short, because SMS charges by the segment. */
export function composeAlert(feed) {
  const skus = feed.skus ?? []
  const parseG = (s) => {
    const m = /(\d+(?:\.\d+)?)\s*(?:grams?|gms?|g)\b/i.exec(`${s.name} ${s.info ?? ''}`)
    return m ? parseFloat(m[1]) : null
  }
  const after = (s) => s.bestPrice ?? (s.discount != null ? s.price - s.discount : s.price)
  let best = null
  for (const s of skus) {
    const g = parseG(s)
    if (!g) continue
    const pg = Math.round(after(s) / g)
    if (!best || pg < best.pg) best = { pg, g, brand: s.brand, url: s.url }
  }
  const lines = [
    `${feed.code} live on Myntra${feed.discountPct ? ` — ${feed.discountPct}% off` : ''}`,
    `${skus.length} gold coins covered`,
  ]
  if (best) lines.push(`Best: Rs ${best.pg.toLocaleString('en-IN')}/g (${best.brand} ${best.g}g)`)
  if (feed.source) lines.push(feed.source)
  return lines.join('\n')
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').toLowerCase().endsWith('/notify.mjs')) {
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
