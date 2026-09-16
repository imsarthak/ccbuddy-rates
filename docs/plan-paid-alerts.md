# Paid BLINKDEAL alerts — plan

Drafted 2026-09-16 on `feature/paid-alerts`. Sarthak's decisions so far: sell all
three channels (Telegram, WhatsApp, SMS); payment pluggable, not yet chosen;
phone stays the only watcher for v1; price undercuts GoldBlink's ₹149/month; a
free tier exists. Open decisions are in §H. Every user-facing string is in §I
for his approval before anything ships.

Competitor reference: GoldBlink Alerts Bot, Telegram only, ₹149/month or
₹1,499/year, polls every 90 seconds. Ours detects within 20 seconds.

## A. Architecture

| Component | Where | Job |
|---|---|---|
| Detector (unchanged core) | phone, `scraper/blinkdeal.mjs` | detect → emit one signed event per edge |
| Emitter (new) | phone, `scraper/emit.mjs` | POST `{type: open\|closed\|test, key, summary}` to the Worker, HMAC-signed, 3 retries; fallback = direct Telegram to Sarthak + local notification |
| Alerts Worker (new) | this repo, `worker/` → separate Worker `ccbuddy-alerts` on `alerts.ccbuddy.app` | ingest, idempotency, subscriber/plan/payment state, Telegram bot webhook, fan-out outbox, cron (drain, delayed free tier, watchdog, daily health ping) |
| D1 `ccbuddy-alerts` | Cloudflare | all state |
| Channel adapters | Worker | `telegram.ts` (Bot API), `whatsapp.ts` (Meta Cloud API template), `sms.ts` (MSG91, DLT template) |
| Payment providers | Worker `payments/` | `manual-upi.ts` now; `razorpay.ts`, `stars.ts` later |
| App (optional, phase 5) | app repo, `feature/paid-alerts` | a "Get alerts" link on the gold board → the bot. No data leaves the app |

**Why a separate Worker in this repo:** an alerts bug must never force an app
redeploy or vice versa; the phone's shared secret and bot token belong with the
watcher's config; the repo is public, so code is public and every secret is a
`wrangler secret`. Free tier fits: ~10 windows/month × 500 subscribers × 3
channels ≈ 15k D1 writes/month against 100k/day allowed.

**Why D1, not KV:** "never alert twice" and quota counters need read-after-write
consistency and a UNIQUE constraint. KV is eventually consistent (up to 60 s) —
a phone retry 2 s later could double-send. Same reasoning as the OTP plan.

**The phone stays dumb:** detect, emit, done. Fan-out, state, payments and rate
limits live in the Worker. The phone never waits on fan-out.

### Data model (`worker/schema.sql`)

- `subscribers` — id, tg_chat_id UNIQUE, tg_username, status (active|stopped|deleted), is_admin, is_test, consent_at, consent_version, free_used, free_period_start, created_at
- `destinations` — id, subscriber_id, channel (telegram|whatsapp|sms), address, opt_in_at, verified_at, status (pending|active|paused|dead), last_error; UNIQUE(subscriber_id, channel)
- `subscriptions` — id, subscriber_id, plan_id, status (active|expired|cancelled|refunded), starts_at, ends_at, payment_id, created_at
- `payments` — id, ref (short human code e.g. `CCB-7Q2X`, UNIQUE), subscriber_id, plan_id, provider (manual|razorpay|stars), amount_inr, status (pending|paid|rejected|refunded), external_id (UTR / provider id), created_at, paid_at, approved_by
- `windows` — key PK (`code:couponId:from`), code, coupon_id, opened_at, closed_at, discount_pct, sku_count, best_json, source, received_at
- `deliveries` — id, window_key, destination_id, tier (paid|free|test), due_at, status (queued|sent|failed|dead|dry), attempts, next_attempt_at, provider_msg_id, error, sent_at; **UNIQUE(window_key, destination_id) is the idempotency guarantee**
- `admin_log` — at, actor, action, target, detail (internal ids only)
- Plans are config, not rows: `worker/src/plans.ts` — `{ id, name, priceInr, days, channels[], delayMin }`. The single place prices live.

### Event flow

1. Phone `step()` sees the opening edge → `emit()` POSTs `{type:'open', key, code, couponId, from, discountPct, skuCount, best:{pg,brand,g,url}, source, ts}` to `POST /event` with `X-CCBuddy-Signature: HMAC-SHA256(secret, ts + '.' + body)`; Worker rejects `|now − ts| > 5 min`.
2. Worker: `INSERT OR IGNORE windows`; if the row existed → `200 {duplicate:true}`, stop. Otherwise insert one `deliveries` row per active destination whose owner is entitled to that channel (paid → due now; free → due now + `FREE_DELAY_MIN`; test subscribers always). Respond 200 immediately.
3. Fan-out via an outbox drain: ingest kicks `ctx.waitUntil(fetch('/internal/drain'))`; each drain claims ≤50 due `queued` rows (paid first), sends, updates status, re-invokes while work remains. A cron every minute also drains — retries, the delayed free tier, and any invocation that died.
4. Close edge: phone emits `{type:'closed', key, to}` → Worker sets `closed_at`, **cancels any still-queued deliveries** (a free-tier alert must never arrive after the window closed), and optionally sends a "closed" notice (§A, below).

Latency budget: detect ≤20 s + POST ~1 s + 500 Telegram sends at 25/s ≈ 20 s
worst case for the last paid subscriber. Still ahead of a 90 s poller.

### Idempotency, precisely

- The key uses `lastLive.from`, which survives ticks and phone restarts (previous state is read from the repo-tracked feed after rebase). Code change mid-window = new key = new alert, which is correct.
- Worker guard on top: a second `open` for the same `couponId` within 10 min of a still-open window is a duplicate even if `from` differs (covers a reset clone). Coupon ids are reused across days, so the guard is time-bounded, not id-only.
- Retries reuse the same body, so the phone's 3 retries are safe by construction.

### Close edge — recommendation

**No "closed" push to paid users by default.** Windows run ~35 min and the alert
says so; a second message costs real money on WhatsApp/SMS and trains people to
mute the bot. Offer `/closed on` as a Telegram-only opt-in (₹0). The close event
is still essential server-side: it cancels queued free-tier deliveries and closes
the window record for the health ping.

## B. Telegram bot

- Webhook mode: `setWebhook` to `/tg/<random-path>` with `secret_token`; Worker checks `X-Telegram-Bot-Api-Secret-Token`. A **new** bot for the service; the personal alert bot stays as the phone's fallback.
- `/start` upserts `subscribers` by chat id, creates the telegram destination (verified by construction), records consent, enrols in the free tier immediately. The chat id is the identity; no form.
- User commands: `/start`, `/plan`, `/pay [plan]`, `/status`, `/whatsapp +91…`, `/sms +91…`, `/closed on|off`, `/stop` (pause), `/delete` (erase — DPDP), `/help`. Unknown text → help.
- Number ownership + opt-in proof: `/sms +91…` sends a 4-digit code through the gateway itself (doubles as the channel test); `/whatsapp +91…` sends the approved template with a code. `opt_in_at` on verification — Meta and DLT both want an opt-in record.
- Manual payment: `/pay` → `payments` row pending with `ref` → bot shows UPI id + amount + "put `CCB-7Q2X` in the note, then reply with the UTR" → user replies → admin gets inline **Approve / Reject** → approve = `activate()` → user told; `/status` shows it. `/approve <ref>` and `/reject <ref> <reason>` do the same by hand.
- Admin commands (gated on `is_admin`, all logged): `/approve`, `/reject`, `/extend <ref|all> <days>` (outage compensation), `/broadcast <text>` (confirms first, Telegram only), `/stats`, `/dry on|off`, `/test` (synthetic window to `is_test` subscribers only), `/find <@username|last4>`.
- Renewal: daily cron flags subscriptions ending in 3 days → one reminder; on expiry the subscriber drops to the free tier, not to nothing.

## C. WhatsApp and SMS — prerequisites and honest timeline

These gate "all three". They are paperwork, not code, and they need a
business identity.

**WhatsApp — Meta WhatsApp Business Cloud API**
1. Meta Business Portfolio + business verification (GST/CIN/Udyam or proprietor docs + address proof). 2 days to 3 weeks; individuals without a business identity get stuck here.
2. A phone number not registered on consumer WhatsApp; display-name approval.
3. A **Marketing** template (a deal alert is marketing; "utility" gets reclassified): `blinkdeal_live` with code, discount, coin count, best ₹/g, and a URL button. Approval minutes to 24 h; first submissions are often rejected.
4. ~₹0.5–0.8 per marketing conversation in India; one window = one conversation.
5. Adapter: `POST graph.facebook.com/v*/PHONE_ID/messages` with a permanent system-user token as a secret. A BSP (Interakt/AiSensy/Wati) fronts the same API for a monthly fee and does not skip verification.
Timeline: 1–4 weeks, dominated by verification.

**SMS — TRAI DLT + gateway**
1. DLT registration as Principal Entity on one operator portal (Jio TrueConnect / Airtel / Vi Vilpower): PAN, business proof or proprietor docs, authorisation letter. 1–7 days, sometimes weeks.
2. Sender header (6 letters, e.g. `CCBUDY`): 1–3 days.
3. Content template, **Service-Explicit** (consented), not Promotional — promotional is blocked 21:00–10:00 IST and to DND numbers, and windows run to 22:52 IST. Register the consent template too. Text is fixed verbatim with `{#var#}` slots: 1–3 days.
4. Gateway: **MSG91** (Indian, DLT-native, template-id mapping, plain REST from a Worker, ~₹0.15–0.20/SMS). Keep the alert to one 160-char segment.
Timeline: 2–6 weeks.

**Sequencing:** ship Telegram first under the same subscription model. A
`CHANNELS_ENABLED` var goes `telegram` → `telegram,whatsapp` → all three. Plans
may list channels not yet enabled; `/status` shows "WhatsApp: coming" and the
bot messages those subscribers when a channel flips on. Start Meta
verification, DLT and Razorpay KYC on day 1 in parallel — they are the critical
path, not the code.

## D. Payments — pluggable

```
interface PaymentProvider {
  id: 'manual' | 'razorpay' | 'stars'
  createCheckout(subscriber, plan, ref) → { kind: 'instructions' | 'url' | 'invoice', text?, url? }
  handleWebhook?(request) → PaymentEvent | null   // verifies signature → {ref, externalId, amount, status}
}
activate(paymentId) — the one function every provider ends in: marks paid, creates/extends the subscription, notifies the user.
```
- Manual UPI (now): `createCheckout` returns UPI id/QR text + ref; the "webhook" is the admin Approve button. Nothing else knows it is manual.
- Razorpay (later): Payment Links with `notes.ref`; `POST /pay/razorpay` verifies `X-Razorpay-Signature` and calls `activate` by ref. Individual KYC with PAN + bank works; 2% + GST. Auto-renew subscriptions are a later phase.
- Telegram Stars: `sendInvoice` in XTR → `successful_payment` → `activate`. Zero integration cost but payout is via Fragment in TON with a hold — awkward from India. Listed, not recommended.
- A subscription needs: starts_at, ends_at (extending an active one from its current end), plan_id → channel entitlements, payment_id, status. Entitlement at fan-out = active subscription whose plan includes the destination's channel.

## E. Free tier — evaluation

| Option | Product effect | Code |
|---|---|---|
| N free alerts/year (his idea) | Quota is burned by windows the user slept through; the cliff after N is "nothing", which demonstrates loss, not speed; needs a yearly reset and "what counts as used"; every free alert is full-speed, so free equals paid for the first N windows. | ~40 lines |
| Delayed-free forever (e.g. 10 min) | Sells exactly the thing on offer: the free user sees the alert, then "paid subscribers got this 10 minutes ago" while the good coins are gone. ₹0 marginal cost. No cliff, no reset, the free list stays engaged to upsell. | ~15 lines |
| Hybrid | First N full-speed (N = 2, lifetime), then delayed forever. The user feels the real speed once; the downgrade is to "late", not to "nothing". | both, lifetime counter |

**Recommendation: hybrid, N = 2 lifetime, delay 10 min** (`FREE_INSTANT_COUNT`,
`FREE_DELAY_MIN` in config). If one knob is preferred, delayed-only is the safer
single choice; "N per year" alone is the weakest. Free tier is Telegram-only
regardless — WhatsApp and SMS cost money per alert.

## F. Ops

- Dedupe: `windows` PK + `deliveries` UNIQUE + the 10-min same-coupon guard.
- Retry: attempts + exponential `next_attempt_at` (30 s, 2 min, 10 min, then dead); Telegram 429 → honour `retry_after`; 403 blocked / 400 chat not found → destination dead, no retry; Meta/MSG91 4xx → dead with code, 5xx → retry. Deliveries for a window older than 60 min are never sent.
- Rate limits: Telegram batches at 25/s (limit ~30/s, 1/s per chat); WhatsApp and MSG91 far exceed 500. Paid rows claimed before free.
- Logging without PII: internal ids only; never chat ids, numbers or message text; reuse the `bot\d+:[\w-]+` redaction from `notify.mjs`; `deliveries.error` holds status codes. `/find` to the admin chat is the only place a number appears, masked to last 4.
- Daily health ping (09:00 IST → admin chat): feed age, windows in 24 h, deliveries sent/failed/dead per channel, active/expiring/pending-payment counts, channel flags.
- Watchdog (every 5 min): GET the public feed, apply the app's 3-beat `isFresh` rule → "watcher down since …" once, "watcher back" on recovery. No phone change.
- Phone dies: terms line "Alerts are best-effort — the watcher runs on one device and outages happen." `/extend all <days>` compensates; `/broadcast` if an outage crosses the active hours.
- Refunds: manual for now (UPI back, mark refunded, subscription cancelled); Razorpay refund API later. Suggested policy: no refunds for missed windows; a paid month with zero windows delivered is extended by a month.
- Failure modes: Worker down → phone retries 3×, then direct Telegram to Sarthak + local notification; the feed still publishes via git so the app is unaffected; `node scraper/emit.mjs --replay` once the Worker is back (idempotent). WhatsApp template rejected → channel stays off, subscribers told, Telegram delivers. DLT delayed → same. D1 error on ingest → 500 → phone retries.

## G. Verification

- Unit (plain `node --test`): idempotency key, entitlement/quota, `due_at`, signature verify, Telegram error classification, `composeAlert` per channel (SMS ≤160 chars).
- `DRY_RUN` var: deliveries written as `dry`; only `is_test` subscribers actually receive; `/dry on|off` flips it live.
- Replay: `node scraper/emit.mjs --fixture scraper/fixtures/live-window-2026-09-15.json --dry` → full pipeline, real Worker, real Telegram, one test subscriber (Sarthak). Then `--closed`.
- Adapter stubbing: `TELEGRAM_API_BASE`, `WA_API_BASE`, `SMS_API_BASE` default to the real hosts; `wrangler dev` points them at a local mock that returns 200 (and 429 on demand).
- Load: insert 500 test subscribers on telegram against the mock; fire one event; assert all 500 sent in < 30 s and no duplicates on a second identical event; delete them.
- Manual end to end before selling: /start → /pay → UTR → Approve → /status paid → replay fixture → alert within seconds; free test account gets it 10 min later; a closed event cancels a queued free delivery.

## H. Open decisions

1. Free tier: hybrid (rec.) / delayed-only / N per year — and the numbers.
2. Plans: one all-channels plan under ₹149, or two (Telegram-only cheaper; all-channels under ₹149) — rec. two, since WA + SMS cost ~₹1/alert/subscriber. Yearly price?
3. Selling before WA/SMS are live: sell only the Telegram plan until approvals land (rec.), or sell all-channels now with "coming" copy.
4. Business identity for Meta verification and DLT: does a proprietorship/GST exist? Decides whether WA/SMS are weeks or months.
5. Payment v1: UPI manual (rec.), or wait for Razorpay KYC.
6. Closed notice: off by default with Telegram opt-in (rec.) / on for everyone / never.
7. Privacy scope: the bot is a separate server-side product; the app's free-tier "never leaves device" promise is untouched; consent at `/start` covers chat id + any number added; `/delete` honours erasure. A privacy policy page ships with it.
8. Bot identity: new username; the personal alert bot stays as the phone's fallback.
9. Tax: GST threshold and invoicing — his CA's call.

## I. Copy to approve (drafts; every line is his call)

- `/start` welcome + consent: "CCBuddy BLINKDEAL alerts. When Myntra's BLINKDEAL gold-coin coupon goes live, you'll hear it here. Free: alerts 10 min late. Paid: the instant we see it — /plan. By continuing you agree that CCBuddy stores your Telegram chat ID, and any phone number you add, only to send these alerts. /delete removes everything. Alerts are best-effort; the watcher runs on one device."
- Alert (paid, Telegram/WA): existing `composeAlert` lines + "Usually lasts ~35 min." Free variant footer: "Paid subscribers got this 10 min ago. /plan"
- SMS (DLT verbatim): "CCBuddy: {#var#} live on Myntra, {#var#}% off gold coins. Best Rs {#var#}/g. myntra.com/gold-coins"
- WhatsApp template body: "{{1}} is live on Myntra — {{2}}% off {{3}} gold coins. Best Rs {{4}}/g. Usually lasts ~35 min." + button "Open listing"
- `/plan`; `/pay` instructions (UPI id, ref, "reply with the UTR"); "Payment noted — approved within a few hours"; "Approved — active until {date}"; "Rejected: {reason}"; `/status` block; `/stop` → "Paused. /start to resume"; `/delete` confirm + done; `/whatsapp` and `/sms` prompts; verification code message; "Verified"; `/closed` on/off; help; unknown command; renewal reminder; expiry → free notice; channel-now-live notice; outage broadcast template; admin approve/reject notifications; health ping; watcher down/back.

## Phases

0. Prereqs, day 1, all in parallel and all slow: BotFather bot; `wrangler d1 create ccbuddy-alerts`; secrets; DNS `alerts.ccbuddy.app`; Meta business verification; DLT registration; MSG91 account; Razorpay KYC.
1. Worker core + phone emit: `worker/` skeleton, schema, `/event` ingest with signature + idempotency, outbox drain, Telegram adapter, watchdog cron; `scraper/emit.mjs`; `blinkdeal.mjs` calls emit on both edges; Sarthak as the only (test) subscriber → parity with today, via the Worker.
2. Bot + free tier + manual payment: commands, consent, free delay, `/pay` manual, admin approve, health ping, `/stop` and `/delete`. Ship: start selling Telegram.
3. WhatsApp, then SMS: adapters behind `CHANNELS_ENABLED`; number verification; flip on as approvals land.
4. Razorpay webhook; renewal reminders.
5. App link (app repo `feature/paid-alerts`, one line on the gold board) — optional.

## Files

- `scraper/blinkdeal.mjs` — `step()`: opening-edge `notify()` and `closedWindow` are the two hook points for `emit()`
- `scraper/notify.mjs` — `composeAlert()` and `sendTelegram()` reused; becomes the phone-local fallback; `.notify.env` gains `"worker": {url, secret}`; or split into `scraper/emit.mjs`
- `worker/src/index.ts` (new) — router: `/event`, `/tg/<path>`, `/pay/razorpay`, `/internal/drain`, `scheduled()`
- `worker/schema.sql` (new)
- `worker/src/copy.ts`, `worker/src/plans.ts` (new) — every string and every price in one place
- `docs/termux-setup.md` — worker block; `README.md` — a "user data" section, since "no user data in this repo" stops being true for the Worker
- Reference: app repo `docs/plan-otp-login.md` (Worker/D1/secrets conventions) and `src/data/blinkdeal.ts` (`isFresh` rule the watchdog mirrors)

---

# Decisions taken 2026-09-16

These supersede the open questions in §H where they overlap.

## Pricing: credits, not a subscription

**Per-window credits in packs of 10 / 25 / 60**, larger packs cheaper per alert,
**credits never expire**, **1 credit per window with all channels included**.

Why credits beat a subscription here: we do not yet know how often windows
happen. Two in two days is not a rate, and the ten historical sightings span
months. A ₹149/month subscription is poor value if windows turn out to be
twice a month, and generates refund arguments. Credits are robust to an unknown
frequency and kill the refund problem outright — a quiet month costs the user
nothing. Credits also suit manual UPI approval: one approval buys many alerts.

Cost to serve one window to one subscriber on all three channels is about
₹0.85, so any sane credit price is almost pure margin. Prices are Sarthak's;
they live in `worker/src/plans.ts`.

Implications for the data model: `subscribers` gains `credits` (int);
`payments` records a pack rather than a plan; `subscriptions` becomes
`credit_ledger` (id, subscriber_id, delta, reason, window_key?, payment_id?,
at) so a balance is auditable and a wrongly-charged alert can be reversed.
Entitlement at fan-out = `credits > 0`; decrement once per window, not per
channel, inside the same transaction that inserts the deliveries.

## Free tier: first 5 at full speed, then 10 minutes late forever

`FREE_INSTANT_COUNT = 5` (lifetime, not yearly), `FREE_DELAY_MIN = 10`.
Telegram only — WhatsApp and SMS cost money per alert. After the fifth, every
alert still arrives, carrying "paid subscribers got this 10 minutes ago".
No cliff, no reset, and the free list stays as an upsell audience.

## WhatsApp: official Cloud API, direct messages, no groups

Rejected: WhatsApp Channels (Meta's API cannot manage them; a public channel
cannot be gated) and admin-only Groups/Communities (the API cannot manage those
either, so it needs an unofficial web-protocol library with real ban risk —
and **every member of a WhatsApp group can see every other member's phone
number**, which is an unacceptable leak for a paid subscriber list).

Paid WhatsApp is one approved template message per subscriber. Gating is
inherent: we simply do not send to someone with no credits. Cost per recipient
is the same as a group would have been, so the group bought nothing.

Unofficial libraries stay away from anything paid. If a public WhatsApp channel
is ever wanted for marketing, it runs on a throwaway number where a ban costs
reach, not customers.

## Affiliate links: a separate digest message

The alert stays short and fast. A follow-up digest carries the top coins by
₹/gram with affiliate links. Two prerequisites, both outstanding:

- Myntra campaign at Cuelinks is `access_status: pending` (id 101, 7.5%).
- The watcher's Cuelinks key deliberately lacks `write:links`. Create a
  **second** key with `read:campaigns` + `write:links` for link generation and
  keep the watcher key read-only. Store as `.cuelinks-links.env`, gitignored.

Link generation: `POST /pub_api/v3/links/convert` per coin URL.

## Branded short links: our own domain, not a look-alike

Everyone in this market posts `myntr.in` / `myntr.cc` / `myntr.store` links.
Those are **not Myntra's** — the TLS certificate on `myntr.in` also covers
`fkrt.co` and `ajiio.co`, and the roots redirect to haulpack.com and
extrape.com. They are third-party affiliate operators running brand
look-alikes. We are not registering a Myntra look-alike: it is a trademark
risk with no upside, under Sarthak's name on a public product.

What they actually have is a branded short domain in front of an affiliate
link, and that is worth copying. The alerts Worker gets a `/g/:code` route that
302s to the stored affiliate URL:

```
<short-domain>/g/x7k2  →  clnk.in/…  →  myntra.com/gold-coin/…
```

A subdomain of ccbuddy.app costs nothing; a dedicated short domain is a few
hundred rupees a year. This also gives click tracking, which the feed-only
approach would not have. New table `links` (code PK, window_key, sku_id,
target_url, created_at, clicks).

## Payment: UPI now, approved in the bot

As in §D. Razorpay slots in behind the same `PaymentProvider` interface once
KYC is done, without touching fan-out or credits.

## Still open

- Credit pack prices and the pack sizes' per-alert taper.
- Short domain: subdomain of ccbuddy.app, or buy one.
- Business identity for Meta verification (WhatsApp) and DLT (SMS) — decides
  whether those channels are weeks or months away. Telegram sells regardless.
- Whether the free tier's 5 instant alerts are per person or per device — a
  Telegram chat id is the identity and is cheap to re-create, so some abuse is
  inevitable; recommend accepting it rather than adding friction at signup.
