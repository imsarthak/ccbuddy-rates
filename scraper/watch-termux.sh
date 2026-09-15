#!/data/data/com.termux/files/usr/bin/bash
# CCBuddy BLINKDEAL watcher — Android / Termux edition.
#
# Myntra serves its real listing only to residential IPs. Every datacenter
# egress measured gets a 483-byte "Site Maintenance" stub, so the watcher has
# to sit on a home connection. An old Android phone on the house Wi-Fi is the
# cheapest thing that can do that around the clock.
#
# Each tick: rebase onto origin/master, run the detector (one ~121 KB request
# when quiet), and push docs/blinkdeal.json only when something changed.
# GitHub Pages then serves it to the app exactly like rates.json.
#
#   bash scraper/watch-termux.sh              every 5 minutes
#   INTERVAL=180 bash scraper/watch-termux.sh every 3 minutes
#
# Setup lives in docs/termux-setup.md.

set -u
cd "$(dirname "$0")/.." || exit 1

INTERVAL="${INTERVAL:-300}"
LOG_DIR="logs"
LOG="$LOG_DIR/watch.log"
mkdir -p "$LOG_DIR"

say() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"; }

# Keep the CPU awake. Without this Android's doze mode suspends the loop
# within minutes of the screen going off, which is most of the time.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
trap 'command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock; say "stopped"; exit 0' INT TERM

say "started, interval ${INTERVAL}s"

while true; do
  # Trim the log rather than let it grow without bound on a small device.
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi

  if git fetch -q origin master 2>/dev/null; then
    # Anything local that origin lacks is a push that failed last tick; rebase
    # keeps it. A dirty tree means something went wrong, so reset just the two
    # feed files rather than fight with it.
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

  sleep "$INTERVAL"
done
