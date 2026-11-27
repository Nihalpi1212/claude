#!/usr/bin/env python3
"""Free disk in pigment/target/debug/deps without a cold rebuild.

Deletes the older builds of a crate (other hashes) that no build touched in the last HOURS hours
(default 6), keeping each crate's newest build. Cargo rebuilds a deleted one if a later build
needs it. Run it between builds when possible: a build running at the same moment may fail once
on a vanished artifact and then succeed when run again.
Usage: python3 clean-target.py [/home/user/claude/pigment/target/debug/deps] [hours]
"""
import collections, os, re, sys, time
deps = sys.argv[1] if len(sys.argv) > 1 else '/home/user/claude/pigment/target/debug/deps'
hours = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
os.chdir(deps)
groups = collections.defaultdict(list)
for f in os.listdir('.'):
    if not os.path.isfile(f):
        continue
    m = re.match(r'^(lib)?(.+?)-([0-9a-f]{16})(\..+)?$', f)
    if m:
        st = os.stat(f)
        groups[m.group(2)].append((st.st_mtime, m.group(3), f, st.st_size))
cut = time.time() - hours * 3600
freed = n = 0
for items in groups.values():
    byhash = collections.defaultdict(list)
    for mt, h, f, sz in items:
        byhash[h].append((mt, f, sz))
    if len(byhash) <= 1:
        continue
    for _, lst in sorted(byhash.items(), key=lambda kv: max(x[0] for x in kv[1]), reverse=True)[1:]:
        if max(x[0] for x in lst) >= cut:
            continue
        for _, f, sz in lst:
            try:
                os.remove(f); freed += sz; n += 1
            except FileNotFoundError:
                pass
print(f'removed {n} files, {freed / 1e9:.1f} GB')
