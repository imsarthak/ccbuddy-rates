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

To have it survive a reboot, install **Termux:Boot** from F-Droid and create
`~/.termux/boot/watch` containing:

```bash
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/ccbuddy-rates && bash scraper/watch-termux.sh
```

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

A quiet tick is one request of about 121 KB gzipped, so roughly 35 MB a day on
Wi-Fi. When a window opens the watcher collects all the covered coins, about
1.5 MB, and publishes the feed within a minute.

Every BLINKDEAL sighting we have a timestamp for landed between 12:34 and
22:52 IST, so an always-on phone comfortably covers the hours that have
historically mattered.

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
  "whatsapp": { "phone": "+919876543210", "apikey": "123456" }
}
```

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

# Cadence

Twenty seconds between 11:00 and 23:00 IST, five minutes overnight, plus a few
seconds of jitter so requests do not land on the same second of every minute.
Every BLINKDEAL sighting we have a timestamp for landed between 12:34 and
22:52 IST, which is where that window comes from.

Treat that with some suspicion — nine of those ten are tweet times and people
tweet when they are awake, so an overnight window might simply never have been
posted. To poll hard around the clock:

```bash
FAST=20 SLOW=20 FAST_FROM=0 FAST_TO=24 bash scraper/watch-termux.sh
```

Around the top of every active hour — from thirty seconds before to two
minutes after — it drops to five seconds and skips the git sync on those
ticks, so the interval is really five seconds and not five plus a fetch over
mobile data. The one exact window start we have is 17:00:43 IST, the other
was about 18:00, and on 16 Sep the flip fell inside the ~25 s between two
twenty-second ticks; the burst bounds that to about seven. It costs roughly
thirty requests an hour on top of the hundred and eighty. `BURST=0` turns it
off; `BURST_BEFORE` and `BURST_AFTER` are in seconds.

Twenty seconds puts you roughly forty seconds ahead of every competitor we
measured; the paid Telegram bot polls at ninety seconds and the tracker site
rebuilds about once a minute.

**Do not push this much below ten seconds.** Myntra already blocks every
datacenter we tested, so your home connection is the only vantage point that
works. Twelve requests a minute forever from one address is an obvious
signature, and if they blacklist it there is nothing to fall back to. The
watcher defends against this on its own: three maintenance stubs in a row and
it backs off fifteen minutes and says so in the log.
