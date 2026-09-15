#!/data/data/com.termux/files/usr/bin/bash
# CCBuddy BLINKDEAL watcher — Android / Termux edition.
#
# Myntra serves its real listing only to residential IPs. Every datacenter
# egress measured gets a 483-byte "Site Maintenance" stub, so the watcher has
# to sit on a home connection. An old Android phone on the house Wi-Fi is the
# cheapest thing that can hold one around the clock.
#
# Each tick: rebase onto origin/master, run the detector (one ~121 KB request
# when quiet), and push docs/blinkdeal.json only when something changed.
# GitHub Pages then serves it to the app exactly like rates.json.
#
#   bash scraper/watch-termux.sh              20s during the active hours
#   FAST=10 bash scraper/watch-termux.sh      poll harder
#   FAST=20 SLOW=20 FAST_FROM=0 FAST_TO=24 …  no quiet period at all
#
# Setup lives in docs/termux-setup.md.

set -u
cd "$(dirname "$0")/.." || exit 1

# Adaptive cadence. Every BLINKDEAL sighting we have a timestamp for landed
# between 12:34 and 22:52 IST, so poll hard across that span and idle
# overnight. Treat the pattern with some suspicion — most of those are tweet
# times, and people tweet when they are awake — but it halves the load for no
# measured loss, and the bounds below widen it if that ever proves wrong.
FAST="${FAST:-20}"           # seconds, during the active hours
SLOW="${SLOW:-300}"          # seconds, overnight
FAST_FROM="${FAST_FROM:-11}" # IST hour, inclusive
FAST_TO="${FAST_TO:-23}"     # IST hour, exclusive

# If Myntra starts refusing this address, the worst possible response is to
# keep hammering it. Losing the home IP loses the whole capability, because
# every datacenter is already blocked and there is no second vantage point.
BLOCK_BACKOFF="${BLOCK_BACKOFF:-900}"
blocked_streak=0

LOG_DIR="logs"
LOG="$LOG_DIR/watch.log"
mkdir -p "$LOG_DIR"

say() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG"; }

# THIS SCRIPT RESETS THE WORKING TREE when a rebase fails, which is correct on
# a dedicated watcher clone and destructive anywhere else. It cost me an hour
# of uncommitted work on a dev machine on 2026-09-15, so: refuse to start if
# anything is modified outside the two feed files.
dirty=$(git status --porcelain -- . ':!docs/blinkdeal.json' ':!docs/blinkdeal-history.json' 2>/dev/null | grep -v '^??' || true)
if [ -n "$dirty" ]; then
  echo "Refusing to start: this clone has uncommitted changes, and this script"
  echo "resets the tree on a failed rebase. Commit or stash them first."
  echo "$dirty"
  exit 1
fi

# Keep the CPU awake. Without this Android's doze mode suspends the loop
# within minutes of the screen going off, which is most of the time.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
trap 'command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock; say "stopped"; exit 0' INT TERM

ist_hour() { TZ='Asia/Kolkata' date +%-H; }

interval_now() {
  h=$(ist_hour)
  if [ "$h" -ge "$FAST_FROM" ] && [ "$h" -lt "$FAST_TO" ]; then echo "$FAST"; else echo "$SLOW"; fi
}

# Spread requests out slightly. Landing on the same second of every minute is
# a signature in itself.
jitter() { echo $(( RANDOM % 5 )); }

say "started — ${FAST}s during ${FAST_FROM}:00-${FAST_TO}:00 IST, ${SLOW}s otherwise"

while true; do
  # Trim the log rather than let it grow without bound on a small device.
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi

  if git fetch -q origin master 2>/dev/null; then
    # Anything local that origin lacks is a push that failed last tick, so
    # rebase keeps it. Only the feed files are ever discarded.
    git checkout -q -- docs/blinkdeal.json docs/blinkdeal-history.json 2>/dev/null
    if ! git rebase -q origin/master 2>/dev/null; then
      git rebase --abort 2>/dev/null
      git reset -q --hard origin/master
      say "rebase failed, reset to origin/master"
    fi
  else
    say "offline, skipping fetch"
  fi

  OUT="$(node scraper/blinkdeal.mjs 2>&1)"
  say "$(printf '%s' "$OUT" | tr '\n' ' ')"

  # A maintenance stub means this address is being refused, not that the
  # coupon is off. Slow right down instead of digging the hole deeper.
  if printf '%s' "$OUT" | grep -qi 'window.__myx\|Site Maintenance'; then
    blocked_streak=$((blocked_streak + 1))
    if [ "$blocked_streak" -ge 3 ]; then
      say "BLOCKED x${blocked_streak} — backing off ${BLOCK_BACKOFF}s. If this persists, the home IP is refused."
      sleep "$BLOCK_BACKOFF"
      continue
    fi
  else
    blocked_streak=0
  fi

  if [ -n "$(git status --porcelain -- docs/blinkdeal.json docs/blinkdeal-history.json)" ]; then
    for f in docs/blinkdeal.json docs/blinkdeal-history.json; do
      [ -f "$f" ] && git add -- "$f"
    done
    if git commit -q -m "BLINKDEAL $(date -u +'%Y-%m-%d %H:%M UTC')" 2>/dev/null; then
      if git push -q origin HEAD:master 2>/dev/null; then
        say "pushed"
      else
        say "push failed, kept for next tick"
      fi
    else
      say "commit failed"
    fi
  fi

  sleep $(( $(interval_now) + $(jitter) ))
done
