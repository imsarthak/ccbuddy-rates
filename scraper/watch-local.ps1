# CCBuddy BLINKDEAL watcher, home-connection edition.
#
# Myntra serves its real listing only to residential IPs (every datacenter
# egress measured on 2026-09-14 gets a maintenance page), so the watcher runs
# on a home machine as a Windows scheduled task, from a clone of this repo
# that nothing else touches. Each tick: rebase onto origin/master, run the
# detector, and push docs/blinkdeal.json when it changed. GitHub Pages then
# serves it to the app exactly like rates.json.
#
# Register (from an interactive shell, once):
#   schtasks /create /f /tn "CCBuddy BLINKDEAL watch" /sc minute /mo 5 ^
#     /tr "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\Admin\ccbuddy-rates-watch\scraper\watch-local.ps1"
# Remove:
#   schtasks /delete /f /tn "CCBuddy BLINKDEAL watch"
#
# Logs to logs\watch.log next to this script's repo root (git-ignored).

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir 'watch.log'

function Say([string]$msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
  Add-Content -Path $log -Value $line -Encoding utf8
}

# Keep the log from growing without bound: trim to the last 2000 lines weekly-ish.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
  Get-Content $log -Tail 2000 | Set-Content $log -Encoding utf8
}

# One tick at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Global\CCBuddyBlinkdealWatch')
if (-not $mutex.WaitOne(0)) { exit 0 }

try {
  Set-Location $root
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

  git fetch -q origin master 2>&1 | Out-Null
  # Anything this clone has that origin does not is a push that failed last
  # tick; rebase keeps it. A dirty tree here means something went wrong —
  # reset the two feed files rather than fight.
  git checkout -q -- docs/blinkdeal.json docs/blinkdeal-history.json 2>$null
  $rebase = git rebase -q origin/master 2>&1
  if ($LASTEXITCODE -ne 0) {
    git rebase --abort 2>$null
    git reset -q --hard origin/master
    Say "rebase failed, reset to origin/master: $rebase"
  }

  $out = & $node scraper/blinkdeal.mjs 2>&1
  $code = $LASTEXITCODE
  Say (($out | Out-String).Trim())
  if ($code -ne 0) { Say "detector exit $code"; exit 0 }

  $dirty = git status --porcelain -- docs/blinkdeal.json docs/blinkdeal-history.json
  if (-not $dirty) { exit 0 }

  # git add refuses the whole call if one pathspec is missing, and the history
  # file only exists once a window has closed — so add what is there.
  foreach ($f in @('docs/blinkdeal.json', 'docs/blinkdeal-history.json')) {
    if (Test-Path $f) { git add -- $f }
  }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm') + ' UTC'
  $commit = git commit -q -m "BLINKDEAL $stamp" 2>&1
  if ($LASTEXITCODE -ne 0) { Say "commit failed: $commit"; exit 0 }
  $push = git push -q origin HEAD:master 2>&1
  if ($LASTEXITCODE -ne 0) { Say "push failed (kept for next tick): $push" } else { Say "pushed $stamp" }
}
finally {
  $mutex.ReleaseMutex() | Out-Null
}
