#!/bin/bash
# Run clean-target.py in a gap between builds: wait until no cargo, cargo-nextest or rustc process has run
# for 20 seconds, then clean. Gives up after the timeout the caller sets.
busy() { pgrep -f '(^|/)cargo( |$)|cargo-nextest|(^|/)rustc( |$)' >/dev/null; }
while :; do
  if ! busy; then
    sleep 20
    if ! busy; then break; fi
  fi
  sleep 5
done
date -u +%H:%M:%S
df -h /home/user | tail -1
python3 "$(dirname "$0")/clean-target.py" /home/user/claude/pigment/target/debug/deps 6
df -h /home/user | tail -1
