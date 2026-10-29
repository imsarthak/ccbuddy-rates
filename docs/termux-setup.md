# Running the BLINKDEAL watcher on an old Android phone

Myntra only serves its real listing to residential addresses. Every datacenter
we measured — GitHub runners, Cloudflare, Oracle and DigitalOcean in India,
Firecrawl's proxy pool — gets a 483-byte "Site Maintenance" stub instead. So
the watcher has to sit on a home connection, and a spare Android phone on the
house Wi-Fi is the cheapest thing that can do that around the clock.

Roughly fifteen minutes to set up. Everything below is typed on the phone.

## 0. Before you start

- Any Android 7 or newer phone with a working battery.
- Leave it plugged in, on your home Wi-Fi.
- A GitHub fine-grained token, made at
  https://github.com/settings/personal-access-tokens/new
  - Repository access: **only** `imsarthak/ccbuddy-rates`
  - Permissions: **Contents → Read and write**. Nothing else.
  - Keep the token; you paste it once in step 3.

Do not use the Play Store build of Termux. It was abandoned years ago and its
packages no longer install.

## 1. Install Termux

Get F-Droid from https://f-droid.org, open it, search Termux, install. Then
open Termux and run:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs git termux-api
```

Also install **Termux:API** from F-Droid — the `termux-api` package above is
only the bridge; the wake lock needs the companion app too.

## 2. Stop Android from killing it

This is the step people skip, and then the watcher dies quietly overnight.

- Settings → Apps → Termux → Battery → **Unrestricted**
- Settings → Apps → Termux:API → Battery → **Unrestricted**
- Settings → Battery → whatever your phone calls adaptive battery → exclude Termux
- Keep the phone on the charger. Doze is far more aggressive on battery.

Samsung, Xiaomi, Oppo and OnePlus each bury this differently. If the log stops
overnight, this is why.

## 3. Clone the repo

```bash
cd ~
git clone https://github.com/imsarthak/ccbuddy-rates.git
cd ccbuddy-rates
git config user.name "ccbuddy-rates-bot"
git config user.email "actions@users.noreply.github.com"
```

Then point the remote at your token so pushes work unattended. Replace
`YOUR_TOKEN`:

```bash
git remote set-url origin https://YOUR_TOKEN@github.com/imsarthak/ccbuddy-rates.git
```

The token now sits in `.git/config` on the phone. That is why it is scoped to
one repository and to contents only — if the phone is ever lost, revoke it at
the link in step 0 and nothing else is exposed.

## 4. Check it works

```bash
node scraper/blinkdeal.mjs --probe
```

You want `__myx ok` and a product count. If you get `__myx MISSING` with a
"Site Maintenance" page, the phone is on mobile data through a carrier proxy
rather than home Wi-Fi — switch networks and try again.

## 5. Start it

```bash
bash scraper/watch-termux.sh
```

It takes the wake lock and starts polling. Leave Termux open; a notification
will show the lock is held. Cadence and how to change it are in the Cadence
section at the end.

It will refuse to start if that clone has uncommitted changes, because it
resets the tree on a failed rebase. On a dedicated watcher clone that never
happens.

**Not optional: make it survive a reboot.** On 2026-10-04 the phone switched
off, came back, and the loop did not: windows went unseen for days. Install
**Termux:Boot** from F-Droid, **open it once** (Android only lets it start
things after that), set its battery use to Unrestricted like Termux's, and
create `~/.termux/boot/watch` containing:

```bash
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/ccbuddy-rates && bash scraper/watch-termux.sh
```

then make it runnable with `chmod +x ~/.termux/boot/watch`. Reboot the phone
once to check the wake-lock notification comes back by itself.

If the loop stops anyway, `.github/workflows/watchdog.yml` opens a "BLINKDEAL
watcher is down" issue on this repo about 45 to 50 minutes after the last
write, and closes it within a minute of the phone's next push. That timing
needs the ccbuddy Worker's secret `BD_WATCHDOG_DISPATCH_TOKEN` (a fine-grained
token with Actions read and write on this repo only): the Worker's cron is
what starts the check on time. Without it, only GitHub's own schedule does,
and that has run 3 to 7 hours apart.

With two repository secrets on this repo (Settings, Secrets and variables,
Actions), the same check also sends you a private Telegram message when it
opens the issue and another when it closes it, from the same bot as the
channel posts:

- `BLINKDEAL_TELEGRAM_TOKEN`: `telegram.token` from `.notify.env`
- `BLINKDEAL_TELEGRAM_CHAT`: `telegram.chatId` from `.notify.env`

To test them, run the "BLINKDEAL watchdog" workflow by hand with mode
`test-dm`.

## 6. Confirm it is alive

On the phone:

```bash
tail -20 ~/ccbuddy-rates/logs/watch.log
```

From anywhere, check the published feed is moving — `checkedAt` should be
within the last few minutes:

```bash
curl -s https://imsarthak.github.io/ccbuddy-rates/blinkdeal.json
```

## What to expect

A quiet tick is one request of about 121 KB gzipped. The default cadence is
about 2,000 ticks a day, so roughly 240 MB a day on Wi-Fi. When a window opens
the watcher collects all the covered coins, about 1.5 MB, and publishes the
feed within a minute.

September's BLINKDEAL sightings landed between 12:34 and 22:52 IST, and
October's 63 starts between 12:28 and 23:52, three of them after 23:00. The
phone polls every twenty seconds from 11:00 to midnight, and past midnight
while a window is still live, because October's windows ran a median of only
four minutes: see [Cadence](#cadence).

## If the feed goes stale

In order of likelihood: the phone dropped off Wi-Fi, Android killed Termux
despite step 2, the token expired, or Myntra changed its markup. The log
distinguishes all four.

---

# Alerting

Detection speed is wasted if the alert is slow. The watcher fires the instant a
window opens — on the opening edge only, never every tick, or you would get a
text every twenty seconds for the life of the window.

Create `.notify.env` in the repo root on the phone. Every channel is optional;
whatever you leave out is skipped. The file is gitignored.

```json
{
  "telegram": { "token": "123456:ABC...", "chatId": "987654321" },
  "sms":      { "to": "+919876543210" },
  "whatsapp": { "phone": "+919876543210", "apikey": "123456" },
  "whapi":    { "token": "…", "dryRun": false }
}
```

The `whapi` block posts to the WhatsApp Channel; one command writes it for
you: see [WhatsApp Channel — unattended](#whatsapp-channel--unattended).

Test it before you rely on it:

```bash
node scraper/notify.mjs --test
```

## Telegram — easiest, do this one first

1. Message **@BotFather** on Telegram, send `/newbot`, follow the prompts.
2. It gives you a token like `123456:ABC...`. That is `telegram.token`.
3. Send your new bot any message.
4. Open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read
   `message.chat.id` out of the JSON. That is `telegram.chatId`.

Free, instant, and it reaches your iPhone, which is the point — the watcher
phone can sit in a drawer.

## SMS — the one that works when data does not

Sent by the watcher phone itself, so it needs a SIM with credit, and Termux
needs SMS permission:

```bash
termux-setup-storage
termux-sms-send -n +919876543210 "test"
```

Android will prompt for SMS permission the first time. If that prompt never
appears, the Termux:API app is not installed — see step 1 of the setup above.

Costs whatever your plan charges per message. Windows are rare, so this is
pennies, but it is not free like the other two.

## WhatsApp — works, with a caveat worth reading

Meta's own API needs a business account, a dedicated number and template
approval, which is far more setup than this deserves. So this goes through
**CallMeBot**, a free third party:

1. Save **+34 644 51 95 23** to your contacts.
2. WhatsApp it: `I allow callmebot to send me messages`
3. It replies with your `apikey`.

The caveat: CallMeBot sees the message text. A coupon code is public
information so nothing sensitive leaks here, but do not extend these alerts to
carry anything private later without changing this channel first.

## Android notification

No configuration. If the watcher is running under Termux it also raises a
local notification on the phone itself.

---

# Channel posts

The alert above is private. The watcher also posts publicly, twice per
window: when it opens (code, discount, how many coins it covers, the cheapest
₹/g on the first page, the coupon page, the app link) and when it closes (how
long it lasted, how many coins; if the phone was off or offline when it
ended, only that it is over, because its length is not known). Once each —
a heartbeat rewrite, a failed read mid-window or a restart never repeats a
post, because both edges are keyed on what the previous feed said.

To see the exact wording without sending anything:

```bash
node scraper/notify.mjs --preview
```

## Telegram channel

Same bot as the alert, one more key:

1. Create the channel in Telegram (public, with a username, or private).
2. Channel → Administrators → Add admin → your bot. It needs **Post messages**.
3. Add `channelId` next to the bot token in `.notify.env`: the `@username`
   of a public channel, or the numeric `-100…` id of a private one (forward
   any post from it to @userinfobot, or read `channel_post.chat.id` from
   `getUpdates` after posting once).

```json
{
  "telegram": { "token": "123456:ABC...", "chatId": "987654321",
                "channelId": "@ccbuddy_blinkdeal" }
}
```

Environment variables work instead of the file: `BLINKDEAL_TELEGRAM_TOKEN`
and `BLINKDEAL_TELEGRAM_CHANNEL`.

**Test on a private test channel first**, never on the real one:

```bash
node scraper/notify.mjs --post-test
```

That sends the captured 2026-09-15 window's open and close posts to whatever
`channelId` says. Read them, then switch `channelId` to the real channel.
`telegram HTTP 403: bot is not a member` means step 2 was skipped;
`400: chat not found` means the id is wrong or the bot was never added.

To rehearse the whole watcher without a channel seeing anything:

```bash
node scraper/blinkdeal.mjs --dry-run
```

prints the alert and both posts to the log instead of sending them
(`BLINKDEAL_DRY_RUN=1` does the same for the loop).

## WhatsApp Channel — one tap from the phone

Meta's own API cannot post to a WhatsApp Channel. The "channels APIs" on the
market, Whapi.Cloud among them, are linked-device sessions of a number, and
WhatsApp's help pages say linking can get that number banned. So your own
number, the channel's owner, is never linked. Unattended posting goes through
a **spare admin number** on Whapi, from GitHub Actions: see
[whatsapp-poster.md](whatsapp-poster.md). This section is the manual route,
which needs nothing linked. On both edges the phone's own notification carries
a **Post to channel** button. Tapping it copies the post to the clipboard and
opens the channel; whoever holds the phone pastes and sends.

**While the Whapi poster is live (`WA_DRY_RUN` = `0`, or this phone set up
to post), don't tap the button.** The window has already been posted, and
tapping would post it a second time.

Add the channel's invite link (Channel info → share icon, or the link under
Channel info → Invite link):

```json
{
  "whatsappChannel": { "url": "https://whatsapp.com/channel/0029Va..." }
}
```

or `BLINKDEAL_WHATSAPP_CHANNEL_URL` in the environment. No URL, no button —
the notification then just shows the post text.

The button runs a shell command from a notification action. Termux drops the
environment for those (no PATH), so the command sets its own; nothing else to
configure. Three things to check once, on the phone:

1. `termux-notification --help` lists `--button1`, `--button1-action` and
   `--id`. It does on termux-api-package 0.60.0 (read from its source
   2026-09-21); `pkg upgrade termux-api` if yours does not.
2. Tapping the button opens WhatsApp on the channel. If it copies the text
   but nothing opens, Android is refusing a background activity start:
   Settings → Apps → Termux → **Display over other apps** → allow.
3. Long-press the composer → Paste shows the whole post, newlines included.

Rehearse without a window:

```bash
node scraper/notify.mjs --post-test
```

raises the notification with the button (and posts to `telegram.channelId`,
so point that at a test channel or leave it unset). The WhatsApp side is
inert until you tap, and the link only opens the channel; nothing is sent
until you press send.

## WhatsApp Channel — unattended

The route chosen on 2026-10-28 is the **Whapi poster**, as a spare admin
number: [whatsapp-poster.md](whatsapp-poster.md). This phone posts each
window itself, about 3 seconds after the Telegram alert, and GitHub Actions
posts any window it did not take. The phone's part is one command, once the
spare number is linked on Whapi (steps 2-5 there). Copy the token in the
Whapi dashboard (the copy icon after `Token:`), then:

```bash
cd ~/ccbuddy-rates && node scraper/wa-phone.mjs --setup
```

It reads the token from the clipboard (the Termux:API app, step 1), checks
the session and the channel, read-only, and adds a `whapi` block to
`.notify.env`. `"dryRun": false` is written only when the check says
`Ready`; the watcher picks it up at its next tick. The block, which you can
also write by hand:

```json
{
  "whapi": { "token": "…", "dryRun": false }
}
```

`"channelId": "…@newsletter"` goes in it only if the spare number admins
more than one Channel. Environment variables work instead of the file:
`BLINKDEAL_WHAPI_TOKEN`, `BLINKDEAL_WHAPI_CHANNEL_ID`, and
`BLINKDEAL_WA_DRY_RUN=0` to post. `node scraper/wa-phone.mjs --check` shows
the saved state, the same check, and whether the pause issue is open.

The phone keeps its record of each post in `.wa-ledger/` in the clone
(gitignored, like `.notify.env`). It is what ends each post with "Over" and
stops a window being posted twice, so it must survive a re-clone: copy it
into the new clone, and don't re-clone while a window is live.
Once the token is saved, `node scraper/blinkdeal.mjs --dry-run` prints the
WhatsApp post with the others and calls nothing.

The older alternative drives the WhatsApp app with a robot thumb
(Tasker + AutoInput), as a spare admin number. It is optional and off by
default; `"autopost": true` next to the URL turns it on. Setup, the intent
the watcher emits, the risks, and the checklist are in
[whatsapp-tasker.md](whatsapp-tasker.md). **Never run it and the Whapi poster
together:** each window would be posted twice.

---

# Cadence

Twenty seconds from 11:00 IST to midnight, five minutes overnight, plus a few
seconds of jitter so requests do not land on the same second of every minute.
September's BLINKDEAL sightings landed between 12:34 and 22:52 IST, and
October's 63 starts between 12:28 and 23:52, three of them after 23:00. That
is where the span comes from. A window still live at midnight keeps the
twenty seconds until it closes. October's ran a median of four minutes,
shorter than the overnight interval, so five-minute polling would see a close
up to five minutes late.

Treat that with some suspicion — those are post times, nine of September's
ten from tweets and October's from two rival channels, and people post when
they are awake, so an overnight window might simply never have been posted.
To poll hard around the clock:

```bash
FAST=20 SLOW=20 FAST_FROM=0 FAST_TO=24 bash scraper/watch-termux.sh
```

With `BURST=5`, around the top of every active hour — from thirty seconds
before to two minutes after — it drops to five seconds and skips the git sync
on those ticks, so the interval is really five seconds and not five plus a
fetch over mobile data. September's one exact window start was 17:00:43 IST,
the other was about 18:00, and on 16 Sep the flip fell inside the ~25 s
between two twenty-second ticks; the burst bounds that to about seven. It
costs roughly thirty requests an hour on top of the hundred and eighty. It is
off by default: none of October's 63 starts fell inside those minutes.
`BURST_BEFORE` and `BURST_AFTER` are in seconds.

Twenty seconds puts you roughly forty seconds ahead of every competitor we
measured; the paid Telegram bot polls at ninety seconds and the tracker site
rebuilds about once a minute.

**Do not push this much below ten seconds.** Myntra already blocks every
datacenter we tested, so your home connection is the only vantage point that
works. Twelve requests a minute forever from one address is an obvious
signature, and if they blacklist it there is nothing to fall back to. The
watcher defends against this on its own: three maintenance stubs in a row and
it backs off fifteen minutes and says so in the log.
