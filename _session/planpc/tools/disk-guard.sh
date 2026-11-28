#!/bin/bash
# Keep free disk above a floor while the engineers build.
# When free space falls below FLOOR GB (default 7), wait for a gap between builds (20 s with no cargo
# or rustc process) and run clean-target.py on builds untouched for HOURS hours (default 2).
# If no gap comes and free space falls below HARD GB (default 4), clean at once with 1 hour: a build
# may then fail once on a vanished artifact, which is better than a full disk.
# If that clean leaves it below FLOOR, it cleans again at once with 1 hour, still only while nothing compiles.
# After a clean it waits 10 minutes (5 below the hard floor) before cleaning again.
# Runs until the caller's timeout. Log: planpc/tools/disk-guard.log
# Usage: disk-guard.sh [FLOOR] [HOURS] [HARD]
floor=${1:-7}; hours=${2:-2}; hard=${3:-4}
here="$(cd "$(dirname "$0")" && pwd)"
log="$here/disk-guard.log"
deps=/home/user/claude/pigment/target/debug/deps
free_mb() { df -BM --output=avail /home/user | tail -1 | tr -dc 0-9; }
free_gb() { awk -v m="$(free_mb)" 'BEGIN{printf "%.1f", m/1024}'; }
# Busy means compiling: a cargo or rustc process. A nextest run that has finished building (only cargo-nextest
# and test binaries left) does not count, since the tests no longer read the build's older artifacts.
busy() { pgrep -f '(^|/)cargo( |$)|(^|/)rustc( |$)' >/dev/null; }
stamp() { date -u +%m-%dT%H:%M:%S; }
clean() { # $1 = hours, $2 = why
  local before after out
  before=$(free_gb)
  out=$(python3 "$here/clean-target.py" "$deps" "$1" 2>&1)
  after=$(free_gb)
  echo "$(stamp) $2: ${before} GB free -> ${after} GB (${out}, hours=$1)" >> "$log"
}
echo "$(stamp) start: floor ${floor} GB, hours ${hours}, hard ${hard} GB, $(free_gb) GB free" >> "$log"
last=0
while :; do
  f=$(free_mb); now=$(date +%s)
  if [ "$f" -lt $((hard * 1024)) ] && [ $((now - last)) -ge 300 ]; then
    clean 1 "below the hard floor"; last=$(date +%s)
  elif [ "$f" -lt $((floor * 1024)) ] && [ $((now - last)) -ge 600 ] && ! busy; then
    sleep 20
    if ! busy; then
      clean "$hours" "below the floor, idle"; last=$(date +%s)
      # Still below the floor (everything was rebuilt lately): while nothing compiles, go down to 1 hour.
      if [ "$(free_mb)" -lt $((floor * 1024)) ] && [ "$hours" != 1 ] && ! busy; then clean 1 "still below the floor, idle"; fi
    fi
  fi
  sleep 15
done
