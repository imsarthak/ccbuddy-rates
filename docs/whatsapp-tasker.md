# Unattended WhatsApp Channel posts with Tasker + AutoInput

Stage 3 of the channel route (research: `GC Management/docs/research/
whatsapp-channel-autopost.md`, 2026-09-21). Stages 1 and 2 — the Telegram
channel and the one-tap notification — are in `docs/termux-setup.md` and work
without anything on this page.

This page makes the watcher phone post to the WhatsApp Channel by itself. There
is no API for that, so it drives the official WhatsApp app the way a thumb
would: Tasker catches an intent from the watcher, opens the channel, AutoInput
types the post and taps send. It posts **as a spare number that is an admin of
the channel, never as Sarthak's own number** — the channel dies with its owner,
so the owner is never automated.

**None of this was run by the author.** Tasker and AutoInput cannot be
installed or driven from a PC; everything below was written from their
documentation and the watcher's side was tested only as far as the exact `am`
command it emits. The checklist at the end is the test. Do it on the phone,
in order, and stop at the first step that does not show what it says.

## Read this first: what can go wrong

- **Terms of service.** WhatsApp's help pages say linking your account to
  unofficial apps can get the number banned; the ToS bans automated or bulk
  messaging. This is not an unofficial client — it is the real app with a
  robot thumb — but it is auto-messaging. Two posts per window is behaviourally
  invisible, and a spare SIM is the blast radius: if it is banned, the owner
  dismisses that admin and invites another. Do not raise the volume beyond the
  two posts.
- **Screen on and unlocked.** AutoInput acts through Android's accessibility
  service, which cannot type into a locked or dark screen. The phone needs no
  screen lock and must not sleep. That phone must therefore stay somewhere
  only you can reach it.
- **WhatsApp UI changes.** The task finds the composer and the send button by
  their view ids. A WhatsApp update that renames them silently breaks posting
  — the intent still arrives, the notification with the button still shows,
  nothing is sent. Re-run the checklist after WhatsApp updates; turn off
  Play Store auto-updates for WhatsApp on this phone if you can.
- **Accessibility service dies.** Android kills or disables AutoInput's
  accessibility service after app updates, some reboots, and under battery
  optimisation. Step 2 of the checklist has the settings; check them after
  every update.
- **Paid one-time apps.** Tasker is a one-off purchase; AutoInput has a trial
  then a one-off unlock. Prices were not verified.
- **Race with a human.** If you also tap "Post to channel" on the notification
  and paste, the channel gets the post twice. Once autopost is on, leave the
  button alone.

## Parts

| Where | What |
|---|---|
| Watcher (`scraper/notify.mjs`) | On each edge, with `whatsappChannel.autopost` true, runs `am broadcast` with the post as an extra. Off by default. |
| Tasker profile | Event → Intent Received on the watcher's action; runs the task below. |
| Tasker task | Opens the channel link in WhatsApp, waits, AutoInput sets the composer text and clicks send, goes home. |
| AutoInput | Tasker plugin; provides the accessibility actions and the UI Query tool that finds the view ids. |

## What the watcher emits

Exactly this, once per edge (`node --test scraper/channel-posts.test.mjs`
pins it):

```
am broadcast --user 0 -a app.ccbuddy.blinkdeal.POST -p net.dinglisch.android.taskerm \
  --es kind open|close \
  --es code BLINKDEAL6 \
  --es text "<the full post, newlines included>" \
  --es url  "https://whatsapp.com/channel/<id>"
```

| Name | Value |
|---|---|
| Intent action | `app.ccbuddy.blinkdeal.POST` |
| Target package | `net.dinglisch.android.taskerm` (Tasker; override with `whatsappChannel.taskerPackage`) |
| Extra `kind` | `open` or `close` |
| Extra `code` | the coupon code, e.g. `BLINKDEAL6` |
| Extra `text` | the post, identical to the Telegram post and the notification |
| Extra `url` | `whatsappChannel.url` from `.notify.env` |

Tasker turns extras into local variables by lower-casing the name, so inside
the task they are `%kind`, `%code`, `%text`, `%url`. The names are all
letters and three or more characters on purpose; Tasker renames anything
shorter.

`am` here is Termux's own (TermuxAm), which termux-tools depends on, so it is
present on any Termux. `--user 0` mirrors what `termux-open-url` itself does.
The broadcast is addressed to Tasker's package because Android 8+ drops
implicit broadcasts to other apps.

## Config

In `.notify.env` on the phone (gitignored):

```json
{
  "whatsappChannel": {
    "url": "https://whatsapp.com/channel/0029Va...",
    "autopost": true
  }
}
```

or `BLINKDEAL_WHATSAPP_AUTOPOST=1` in the environment (`0` turns it off again,
overriding the file). Leave it off until the checklist passes; with it off the
watcher emits nothing and everything else works as before.

## Phone setup

### 1. The spare number

- A second SIM in the watcher phone, or WhatsApp registered to it. This is
  the only number the phone will ever post from.
- On Sarthak's phone (the channel owner): Channel → Channel info → Admins →
  add the spare number. Admins can create updates without owner approval.
- On the watcher phone, open the channel link once by hand and confirm the
  composer is there at the bottom (admins see it; followers do not).

### 2. Apps and permissions

1. Install **Tasker** and **AutoInput** from the Play Store.
2. Settings → Accessibility → AutoInput → on. Android will warn; accept.
3. Settings → Apps → Tasker → Battery → **Unrestricted**. Same for AutoInput
   and (already done for the watcher) Termux.
4. Settings → Apps → Tasker → **Display over other apps** → allow. Tasker
   needs it to bring WhatsApp to the front from the background.
5. Tasker → Menu → Preferences → Monitor → turn **off** "Run in foreground"
   only if it bothers you; leaving it on is the reliable choice.
6. No screen lock: Settings → Security → Screen lock → **None**. And
   Settings → Developer options → **Stay awake** (screen never sleeps while
   charging). The phone is on the charger anyway.

### 3. Find WhatsApp's view ids

WhatsApp's ids are not guaranteed; these are the two the task needs, found on
this phone, not copied from a page.

1. Tasker → Tasks → + → name it `WA ids` → + → Plugin → AutoInput →
   **Action** → tap the pencil → **Easy Setup**. AutoInput tells you to go to
   the screen you want, then to tap the element.
2. Switch to WhatsApp, open the channel so the composer is visible, and tap
   the text field at the bottom. AutoInput shows the element it found, with
   its **Id** (historically `com.whatsapp:id/entry`; hint text "Type an
   update" or "Message"). Write the id down.
3. Repeat for the send button (historically `com.whatsapp:id/send`; it may
   only appear once the field has text, so type a character first and delete
   it afterwards without sending).
4. Those two ids are what actions A4 and A6 below use, and what to re-check
   after any WhatsApp update. Delete the `WA ids` task or keep it for next
   time. The menu names above are AutoInput's at the time of writing and
   were not checked on a phone; the goal is the same whatever they are
   called: the view id of the composer and of the send button.

### 4. The task

Tasker → Tasks → + → name `BLINKDEAL post`. Actions, in order:

| # | Action | Settings |
|---|---|---|
| A1 | Task → If | `%text` **Set** (skip everything if the intent came without text) |
| A2 | System → Send Intent | Action `android.intent.action.VIEW`; Data `%url`; Package `com.whatsapp`; Target **Activity** |
| A3 | Task → Wait | 4 seconds (raise on a slow phone) |
| A4 | Plugin → AutoInput → Action | Type **Id**; Value: the composer id from step 3; Action **Set Text**; Text `%text` |
| A5 | Task → Wait | 1 second |
| A6 | Plugin → AutoInput → Action | Type **Id**; Value: the send id from step 3; Action **Click** |
| A7 | Task → Wait | 2 seconds |
| A8 | App → Go Home | — |
| A9 | Task → End If | — |

If AutoInput's Set Text leaves the field empty on your WhatsApp version, swap
A4 for two actions: System → Set Clipboard `%text`, then AutoInput → Action on
the composer id with Action **Paste** (or Click, then a Keyboard action
Paste).

### 5. The profile

Tasker → Profiles → + → **Event** → **System** → **Intent Received**:

- Action:

```
app.ccbuddy.blinkdeal.POST
```

- Cat, Scheme, Mime Type: leave empty.

Link it to the task `BLINKDEAL post`. Back out of Tasker so it saves (the
tick at top).

## Checklist — do these in order on the phone

Each step says what you should see. Stop at the first one that does not.

1. **Watcher still fine with autopost off.** In Termux:

   ```
   cd ~/ccbuddy-rates && git pull && node --test scraper/channel-posts.test.mjs
   ```

   See: every line starts with ✔ and the summary says `fail 0`.

2. **Termux can broadcast.** In Termux, with `<id>` replaced by your test
   channel's id (not the real channel):

   ```
   am broadcast --user 0 -a app.ccbuddy.blinkdeal.POST -p net.dinglisch.android.taskerm --es kind test --es code TEST --es text "hello from termux" --es url "https://whatsapp.com/channel/<id>"
   ```

   See: a line ending `Broadcast completed: result=0`. Anything about
   "permission" or "not found" means `am` is not TermuxAm: `pkg install
   termux-am` and retry.

3. **Tasker hears it.** Temporarily put a Task → Alert → **Flash** with text
   `%kind %text` as A0 of the task. Re-run the command from step 2. See: a
   toast saying `test hello from termux`. If nothing appears: open Tasker,
   make sure the profile is on (green), that Tasker's monitor is running
   (its own persistent notification), and re-run. If still nothing, in the
   profile change nothing and instead run the command without `-p ...`; if
   THAT works, note it, and set `"taskerPackage"` in `.notify.env` to
   whatever `pm list packages | grep tasker` shows.

4. **WhatsApp opens on the channel.** Leave the Flash in. Run step 2 again.
   See: WhatsApp comes to the front on the channel with the composer visible
   within a few seconds. If a chooser appears asking which app should open
   the link, pick WhatsApp and Always. If nothing comes to the front, step 2.4
   (Display over other apps) is missing.

5. **The text lands.** Same run. See: `hello from termux` appears in the
   composer, then is sent to the test channel, then the home screen. If the
   composer stays empty, the composer id in A4 is wrong — repeat step 3 of
   setup. If the text is there but nothing sends, the send id in A6 is wrong.
   If it sends but the app stays open, A8 failed; harmless.

6. **A multi-line post.** From Termux:

   ```
   am broadcast --user 0 -a app.ccbuddy.blinkdeal.POST -p net.dinglisch.android.taskerm --es kind test --es code TEST --es text "line one
   line two ₹15,143/g" --es url "https://whatsapp.com/channel/<id>"
   ```

   See: two lines in the test channel, the rupee sign intact. A single line
   means Set Text collapsed the newlines — use the clipboard variant of A4.

7. **The real emitter, still to the test channel.** In `.notify.env` set
   `whatsappChannel.url` to the TEST channel and `autopost` to `true`. Then:

   ```
   node scraper/notify.mjs --post-test
   ```

   See: two posts in the test channel a few seconds apart — the 2026-09-15
   window's open post (`BLINKDEAL6 live on Myntra — 6% off gold coins` …) and
   its close post (`BLINKDEAL6 is over — lasted 36 min, 207 coins` …). Also
   `open: {... "tasker":"broadcast"}` in Termux. (This also posts to
   `telegram.channelId` if set — keep that at a test channel too, or unset it
   for this run.)

8. **Screen off.** Let the screen go dark or turn it off by hand, then repeat
   step 7. See: it still posts. If it does not, "Stay awake" (setup 2.6) is
   not on, or the phone has a lock screen.

9. **Switch to the real channel.** Set `whatsappChannel.url` to the real
   channel, remove the Flash action, restart the watcher
   (`bash scraper/watch-termux.sh`). Nothing posts until a real window
   opens. Watch the log on the next one: `POST open telegramChannel:sent
   local:sent+button tasker:broadcast`.

10. **After any WhatsApp update:** steps 3 of setup and 5 of this list.

## Turning it off

`"autopost": false` (or `BLINKDEAL_WHATSAPP_AUTOPOST=0`) and restart the
watcher. The Tasker profile can stay; nothing will trigger it. The one-tap
button keeps working.
