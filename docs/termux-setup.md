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

It takes the wake lock and loops every five minutes. Leave Termux open; a
notification will show the lock is held. To poll every three minutes instead:

```bash
INTERVAL=180 bash scraper/watch-termux.sh
```

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
