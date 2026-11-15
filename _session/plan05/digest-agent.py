#!/usr/bin/env python3
"""Digest of a stopped workflow agent's transcript, for the agent that continues its package.

Usage: python3 digest-agent.py <agent-*.jsonl> <out.md> <package> <agent id> <run id>

Lists, in order: every Write (path and size: the file is on disk), every Edit (path, old and new text), every Bash
command that changed files (full text), every test run with the tail of its output, and the agent's own notes
(its text between tool calls). Read-only commands are counted, not listed.
"""
import json, re, sys
from datetime import datetime

src, out, package, agent_id, run_id = sys.argv[1:6]

evs = []
for line in open(src):
    try:
        evs.append(json.loads(line))
    except Exception:
        pass

def hhmmss(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).strftime('%H:%M:%S')
    except Exception:
        return ts or '?'

# tool_use id -> result text
results = {}
for e in evs:
    m = e.get('message') or {}
    c = m.get('content')
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                cc = b.get('content')
                if isinstance(cc, list):
                    cc = '\n'.join(x.get('text', '') for x in cc if isinstance(x, dict))
                results[b.get('tool_use_id')] = str(cc or '')

WRITES = re.compile(r"(^|[^0-9&>])>{1,2}\s*(?!/dev/null|&)[^\s|&;]+|\btee\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\bmv\s|\bcp\s|\brm\s|\bmkdir\b|"
                    r"open\([^)]*['\"][wa]b?['\"]|write_text|write_bytes|writeFileSync|\bnpm\s+(install|i|ci|uninstall)\b|"
                    r"\bgit\s+(checkout|restore|reset|apply|stash|add|commit|mv|rm)\b|(^|[;&|]\s*)patch\s|\bunzip\b|\btar\s+-?x|\bln\s")
TESTS = re.compile(r"playwright test|node --test|xvfb-run")
SMOKE = re.compile(r"smoke\.mjs")

def is_scratch_only(cmd):
    """A command whose only writes are to /tmp scratch or log files (test logs, smoke checks)."""
    targets = re.findall(r"(?:^|[^0-9&>])>{1,2}\s*([^\s|&;]+)", cmd)
    if targets and all(t.startswith('/tmp/') or t.startswith('$') or t.endswith('.log') or 'scratchpad' in t for t in targets):
        rest = re.sub(r"(?:^|[^0-9&>])>{1,2}\s*[^\s|&;]+", ' ', cmd)
        return not WRITES.search(rest)
    return False

items, reads, notes = [], 0, []
first_ts = last_ts = None
for e in evs:
    ts = e.get('timestamp')
    if ts:
        first_ts = first_ts or ts
        last_ts = ts
    m = e.get('message') or {}
    if m.get('role') != 'assistant':
        continue
    c = m.get('content')
    if not isinstance(c, list):
        continue
    for b in c:
        if not isinstance(b, dict):
            continue
        t = b.get('type')
        if t == 'text' and b.get('text', '').strip():
            items.append(('note', ts, b['text'].strip()))
            notes.append((ts, b['text'].strip()))
        elif t == 'tool_use':
            name, inp, rid = b.get('name'), b.get('input') or {}, b.get('id')
            res = results.get(rid, '')
            if name == 'Write':
                items.append(('write', ts, inp.get('file_path'), len(inp.get('content') or ''), res))
            elif name == 'Edit':
                items.append(('edit', ts, inp.get('file_path'), inp.get('old_string') or '', inp.get('new_string') or '', inp.get('replace_all'), res))
            elif name == 'Bash':
                cmd = inp.get('command') or ''
                if TESTS.search(cmd):
                    items.append(('test', ts, cmd, res))
                elif SMOKE.search(cmd):
                    items.append(('smoke', ts, cmd, res))
                elif WRITES.search(cmd) and not is_scratch_only(cmd):
                    items.append(('bash', ts, cmd, res))
                else:
                    reads += 1
            else:
                reads += 1

def clip(s, n):
    s = s or ''
    return s if len(s) <= n else s[:n] + f'\n… [{len(s) - n} more characters]'

def tail(s, n_lines=40, n_chars=4000):
    lines = (s or '').splitlines()
    t = '\n'.join(lines[-n_lines:])
    return t[-n_chars:]

files = {}
for it in items:
    if it[0] in ('write', 'edit'):
        files.setdefault(it[2], set()).add('created or rewritten' if it[0] == 'write' else 'edited')

o = []
o.append(f'# {package}: what the stopped engineer did\n')
o.append(f'Agent {agent_id} (workflow {run_id}), {hhmmss(first_ts)} to {hhmmss(last_ts)} UTC. It stopped on the 5-hour usage limit, '
         f'without a report and without finishing. Everything below is from its transcript, in order: its notes (its text between '
         f'tool calls), every Write (the file is on disk: read it), every Edit (old and new text), every Bash command that changed a '
         f'file (full text), and every test or smoke run with the end of its output. {reads} read-only commands are left out.\n')
o.append('## Files it wrote or edited\n')
for p, kinds in files.items():
    o.append(f'- `{p}` ({", ".join(sorted(kinds))})')
o.append('\n(Files changed through Bash are in the steps below; check each against the tree.)\n')
o.append('## Steps\n')
n = 0
for it in items:
    kind, ts = it[0], hhmmss(it[1])
    n += 1
    if kind == 'note':
        o.append(f'### {n}. {ts} note\n\n{clip(it[2], 6000)}\n')
    elif kind == 'write':
        o.append(f'### {n}. {ts} Write `{it[2]}` ({it[3]} characters)\n\nResult: {clip(it[4], 300)}\n')
    elif kind == 'edit':
        o.append(f'### {n}. {ts} Edit `{it[2]}`{" (replace all)" if it[5] else ""}\n\nOld:\n```\n{clip(it[3], 3000)}\n```\nNew:\n```\n{clip(it[4], 5000)}\n```\nResult: {clip(it[6], 300)}\n')
    elif kind == 'bash':
        o.append(f'### {n}. {ts} Bash (changes files)\n\n```bash\n{clip(it[2], 12000)}\n```\nOutput (end):\n```\n{tail(it[3], 25, 2500)}\n```\n')
    elif kind in ('test', 'smoke'):
        o.append(f'### {n}. {ts} {"test run" if kind == "test" else "smoke check"}\n\n```bash\n{clip(it[2], 3000)}\n```\nOutput (end):\n```\n{tail(it[3])}\n```\n')

o.append('## Its last notes\n')
for ts, t in notes[-6:]:
    o.append(f'- {hhmmss(ts)}: {clip(t, 2000)}')
open(out, 'w').write('\n'.join(o) + '\n')
print(f'{out}: {len(items)} items, {len(files)} files, {reads} read-only commands left out, {sum(len(x) for x in o)} characters')
