# BLINKDEAL to the WhatsApp Channel, unattended

When a BLINKDEAL window opens, a GitHub Actions job posts it to the WhatsApp
Channel; when the window ends, the job edits that same post to say it is
over. It posts through [Whapi.Cloud](https://whapi.cloud) as a **spare number
that is an admin of the channel**. Your own number stays the channel's owner
and is never linked to anything.

Code: `scraper/wa-post.mjs`. Workflow: `.github/workflows/wa-post.yml`. Tests:
`node --test scraper/wa-post.test.mjs` (a local fake Whapi; nothing leaves the
machine).

**It ships switched off.** Until you set the repo variable `WA_DRY_RUN` to
`0`, every run on a phone push prints the post it would send and calls
nothing. Before that, Whapi is only called by the runs you start by hand
(step 6) and by the watchdog's read-only session check, and only once the
`WHAPI_TOKEN` secret exists.

## What followers see

One post when a window opens:

```
BLINKDEAL6 live on Myntra — 6% off gold coins
Live since 6:22 pm. Windows have lasted about 35 min.

Cheapest 24K per gram after the coupon:
0.5 g · ₹15,620/g · Mia by Tanishq coin
1 g · ₹15,409/g · P N Gadgil Jewellers coin
20 g · ₹15,143/g · Kalyan Jewellers bar

207 coins: https://www.myntra.com/gold-coins?f=Coupons:BLINKDEAL6_135733
Compare them all on CCBuddy: https://ccbuddy.app/blinkdeal
```

The same post, edited when the window ends. An edit does not ping followers
again, and anyone opening the post later sees it is over:

```
Over at 6:58 pm, after 36 min. These prices no longer apply.

BLINKDEAL6 was live on Myntra — 6% off gold coins
Live from 6:22 pm to 6:58 pm.

Cheapest 24K per gram it gave:
…the same rows…

Gold coin prices on CCBuddy: https://ccbuddy.app/blinkdeal
```

The words live in `TEMPLATES` in `scraper/notify.mjs`, next to the Telegram
ones. To print both from the captured 15 Sep window:

```bash
node scraper/wa-post.mjs --mode preview
```

Nothing is posted for a window first seen more than 15 minutes after it
opened (the phone was offline), for one that opened and closed between two
pushes, or for one that has already ended by the time the job runs. A post
more than 15 minutes late is news about a deal that is nearly over.

If the phone was off or offline when a window ended, the time it recorded is
when it came back, so the edit says just `Over. These prices no longer
apply.` with no time.

## How it stays safe

- **It finds the channel itself.** You give it only the Whapi token. Before
  every post it asks Whapi which Channels the linked number is in, and posts to
  the one where it is an admin (your test channel aside, if you made one). If
  it is an admin of none, or of more than one, or the test channel has more
  followers than the one it found (the test id is then the real one), it
  posts nothing and opens an issue saying what to do. The `WHAPI_CHANNEL_ID`
  secret pins the channel instead; you need it only if the spare number
  admins more than one Channel.
- **Your number is never linked.** The same question tells it the linked
  number's role. If that number owns any Channel, it may be your own number:
  it posts nothing and opens an issue telling you to unlink it.
- **Once per window.** A window is its code plus its start time, never the
  coupon id (Myntra reuses one id across windows, even twice in a day). Each
  opening is in exactly one phone push. A record of each real post is kept in
  the Actions cache, so a duplicate run cannot post twice, and the end knows
  which post to edit. It edits it only in the Channel the post went to: if
  the channel has changed since, the post is left as it is. Re-running a
  workflow run never posts. If the job cannot read the feed as it was before
  the push, it posts nothing: it could not tell the opening from a heartbeat.
- **One off switch.** An issue titled **WhatsApp poster is paused** stops it
  completely: while the issue is open, the job does not call Whapi at all and
  only comments on each window it skipped. The job opens it itself when
  something needs you; you can also open one with that exact title to pause
  it by hand. Close it to resume. The repo is public, so an issue with that
  title counts only if the workflow, you, or a collaborator opened it.
- **No retry storms.** A 429 from Whapi means WhatsApp has soft-blocked the
  number. The job never retries it: it pauses and says how long to rest the
  number. A 401 (a session reconnecting for 2-3 seconds) is retried three
  times, 3 seconds apart, on every call. A server error is never retried,
  because the post may already have gone out. The run fails instead, and
  GitHub emails you.
- **Public logs.** This repo is public, so its Actions logs and issues are
  too. The job prints the post text, the session status, the channel name and
  role, and message ids. It never prints the token, either channel id, the
  linked number or a raw Whapi response. That is why all three ids are
  secrets: GitHub prints a step's settings in its log and masks only secrets.
- **Session watch.** The watchdog workflow also asks Whapi, read-only, whether
  the session is still connected. It opens the pause issue if the spare phone
  was logged out, so you find out hours before a window rather than at one.

## Setup: your steps, in order

**1. Restart the watcher.** It has been down since 4 Oct, 18:29 IST (issue #1
is open). Nothing gets posted until the phone pushes again. In Termux:

```bash
cd ~/ccbuddy-rates && bash scraper/watch-termux.sh
```

Set up Termux:Boot as in [termux-setup.md](termux-setup.md) so it survives a
reboot. Issue #1 closes itself when the feed moves.

**2. A spare SIM.** Get a prepaid SIM and keep it recharged. Register
WhatsApp on it, on any phone (the watcher phone is fine). Name it `CCBuddy`
and give it a profile photo. Then **wait at least a day before linking it**,
and use it normally for 3 to 10 days: a few real chats. New numbers that go
straight onto an API get banned first.

**3. Make it an admin.** Never use your own number for anything below except
this invitation.

1. In the channel: Channel info → Invite admins → the spare number. It has
   to be one of your contacts or a follower.
2. On the spare phone, accept the invitation within 7 days.

Make the spare number an admin of this one Channel only: that is how the
poster knows where to post. (A test channel is optional; see step 6.)

Admins and the owner can see each other's numbers, so the spare account (and
through it, Whapi) will be able to see yours. Followers never see either.

**4. Whapi.Cloud.** Create the account. Whapi calls a connected number a
"channel".

- Plan: the free **Sandbox** may not post to WhatsApp Channels (its page does
  not say), so a `test-post` (step 6) settles it, or, with no test channel,
  the first real post. **Developer Premium** lists Channels and has a 5-day
  trial: $35 a month, or $29 a month billed yearly. Its India page shows
  ₹2,900 / ₹2,400.
- Optional: set an Indian proxy in the channel settings **before** scanning.
  That avoids WhatsApp's "This may be a scam" warning about a device abroad.
- On the **spare** phone: WhatsApp → Linked devices → Link a device, then scan
  the QR in the Whapi dashboard. If WhatsApp asks for a passkey, follow
  Whapi's "Manual Paste" steps in Chrome.

**5. The token: the one secret.** In the Whapi dashboard
(panel.whapi.cloud), open the channel the spare number is linked to. The
token is on that page, in the middle card: the `Token:` line under
`API URL:`. Click the copy icon after it.

On GitHub, open ccbuddy-rates → Settings → Secrets and variables → Actions →
Secrets tab → New repository secret. Name:

```
WHAPI_TOKEN
```

Value: the token you copied. That is all the poster needs: it finds the
channel by itself (step 6 shows which one it found).

Do **not** create the variable `WA_DRY_RUN` yet.

Only if the spare number admins more than one Channel (a test channel with
its own secret, step 6, does not count), also add the secret below, with the
real channel's id, ending `@newsletter`. Whapi's API docs (API Docs, at the
top of its dashboard) can run GET /newsletters for you: each Channel's `id`
is in the answer.

```
WHAPI_CHANNEL_ID
```

**6. Check it.** Open Actions → **BLINKDEAL to WhatsApp Channel** → Run
workflow, mode `check`. It only reads. Expect `session: AUTH`, a count of
`1` Channels this number admins, and your channel's name with
`(found by itself), this number's role: admin`. If it found none, or more
than one, it says what to do. It never prints an id.

Optional, to watch a post land before going live: a **test channel**.

1. From your own number, create a private channel, invite the spare number
   as its admin, and accept on the spare phone.
2. Add its id, ending `@newsletter`, as the secret below. Do this as soon as
   the spare number is its admin: without it the poster sees two Channels and
   posts to neither. With it, the poster leaves the test channel out.

```
WA_TEST_CHANNEL_ID
```

3. Run the workflow with mode `test-post` and open the test channel on your
   phone. A post headed `TEST POST — not a live deal` appears, and about 35
   seconds later it is edited to the "Over" version. It never posts to the
   real channel: it refuses if the test channel id is the real one, or if the
   follower counts say `WA_TEST_CHANNEL_ID` holds the real channel's id. It
   also refuses if the linked number owns either channel.

**7. One real window, still dry.** When the next window opens, open that
push's run and read the **Post** step. It shows the exact post, then the edit
when the window ends. Change the words if you want to (they are in
`TEMPLATES`) before going live.

**8. Go live.** On the Variables tab, add:

```
WA_DRY_RUN
```

with the value:

```
0
```

To switch it off again, delete the variable or set it to anything else.

**9. Ongoing.**

- Open WhatsApp on the spare phone at least every 10 days. WhatsApp logs out
  linked devices after 14 days without the phone.
- Keep Tasker autopost off, and don't tap **Post to channel** on the phone's
  notification while this is live. Either would post every window twice.
- If **WhatsApp poster is paused** opens, do what its body says, then close
  it.

## When the pause issue opens

| It says | Do this |
|---|---|
| 429, soft-blocked | Rest the number until the date given: no posts, no test runs. Then use WhatsApp on the spare phone normally for a few minutes, and close the issue. |
| logged out (QR) | Re-link: spare phone → Linked devices → Link a device → scan the QR in the Whapi dashboard. |
| stopped (STOP) | The Whapi plan or trial ended. Renew it. |
| banned (BANNED) | From your own number, dismiss the spare number as admin, then set up a new spare SIM (steps 2-5). |
| the OWNER is linked | Log out the Whapi device on your own phone **now**. Link the spare number instead. (If the linked number really is the spare one and it owns a Channel of its own, set `WHAPI_CHANNEL_ID`.) |
| not an admin | Invite the spare number as admin (again) and accept on the spare phone. |
| admin of 2 or more Channels, or follows too many | Add the `WHAPI_CHANNEL_ID` secret (step 5). If the other one is your test channel, its `WA_TEST_CHANNEL_ID` secret (step 6) does instead. |
| `WA_TEST_CHANNEL_ID` may be the real channel | Check the `WA_TEST_CHANNEL_ID` secret holds the test channel's id, not the real one's. Or add `WHAPI_CHANNEL_ID` (step 5). |
| 401 | Check `WHAPI_TOKEN` matches the dashboard. If it does, re-link (QR). |
| 402 | The plan's limit is used up. Check the plan. |
| 403 / 404 | Check the spare number is still an admin, and that `WHAPI_CHANNEL_ID` is right if you set it. |
| marked failed | Look at the channel. If the post is missing, wait a day and run `test-post`. |

Closing the issue is the only way to resume. That is deliberate: after a 429
only a person knows when the number has rested.

## Switches

| Setting | Effect |
|---|---|
| Variable `WA_DRY_RUN` = `0` | Posts for real. Unset or anything else: prints only. |
| Variable `WA_CLOSE` = `off` | No "Over" edit. The open post stays as it is. |
| Secret `WHAPI_CHANNEL_ID` | Optional. Only if the spare number admins more than one Channel: the one to post to. Unset, it posts to the one Channel the spare number admins. |
| Secret `WA_TEST_CHANNEL_ID` | Where `test-post` posts. Never the real channel. Also left out when the poster looks for the real one. |

## Not yet known

- Whether an admin, rather than the owner, can post through Whapi. A
  `test-post` (step 6) settles it before anything goes live; without a test
  channel, the first real post does, and a refusal pauses the poster.
- Whether Whapi's channel list shows a Channel the number admins (but does not
  own) with the role `admin`. Its API reference says the list holds "your own
  WhatsApp Channel and followed Channels"; its blog says it lists the Channels
  the number administers. `check` shows which: if it reports
  `Channels this number admins: 0` though the spare number is an admin, set
  `WHAPI_CHANNEL_ID`.
- Whether the free Sandbox plan can post to Channels, and whether the session
  checks count against its 1,000 requests a month (about 7 per window: 4 for
  the post, 3 for the edit; plus the watchdog's check 4-8 times a day, about
  180 a month).
- Whapi renamed the role field `user_role`; its API reference still says
  `role`. The job reads both.
- Speed: the post lands about 30-40 seconds after the phone sees the window.
  The Telegram post goes out in about 3 seconds. A window lasts about 35
  minutes.
