// README.md and ARCHITECTURE.md describe behaviour that lives in code. These checks tie the claims
// that drifted before to the code that makes them true, so a change on either side shows up here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freesMedia } from '../../core/schedule.js';
import { reportDue } from '../../worker/jobs/reports.mjs';
import { dayRange } from '../../core/time.js';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const README = read('README.md');
const ARCH = read('ARCHITECTURE.md');

/** The Markdown section that starts with `heading` (a line prefix), up to the next heading of the same or a higher level. */
function section(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  assert.ok(start >= 0, `no section "${heading}"`);
  const level = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)[0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** Text between two markers of a source file (a function body, roughly). */
function between(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `no "${from}"`);
  const b = src.indexOf(to, a + from.length);
  return src.slice(a, b < 0 ? undefined : b);
}

test('README setup asks for a public repository before anything is scheduled', () => {
  // The worker refuses to expose media from a private repository (every automatic post fails).
  assert.match(read('worker/context.mjs'), /code: 'repo_private'/);
  const beforePages = between(section(README, '## One-time setup'), 'You need:', '### 2.');
  assert.match(beforePages, /\*\*public\*\*/);
  assert.match(beforePages, /Change\s+visibility/);
});

test('README step 6 matches what Connect worker does', () => {
  const step = section(README, '### 6.');
  const onboarding = read('js/views/onboarding.js');
  for (const [, label] of step.matchAll(/\*\*([^*]+)\*\*/g)) assert.ok(onboarding.includes(label), `"${label}" is not a button in the worker setup`);
  const connect = between(onboarding, 'async function connect(', 'async function runNow(');
  if (!/dispatchWorker\(/.test(connect)) {
    assert.doesNotMatch(step, /starts the first run/i);
    assert.match(step, /\*\*Run worker now\*\*/);
  }
});

test('README keep-alive interval matches the maintenance job', () => {
  const days = Number(read('worker/jobs/maintenance.mjs').match(/KEEPALIVE_EVERY_DAYS = (\d+)/)[1]);
  for (const doc of [README, ARCH]) {
    assert.doesNotMatch(doc, /monthly keep-alive/i);
    assert.match(doc, new RegExp(`keep-alive[^.]*every ~${days} days`));
  }
});

test('copy that sends the owner to Settings → AI names the "Use AI features" switch too', () => {
  // AI stays off with a key alone: the app and the worker both need settings.ai.enabled.
  assert.match(read('js/ai-client.js'), /!a\.enabled \|\| !a\.apiKey/);
  assert.match(read('js/views/settings.js'), /label="Use AI features"/);
  const files = ['README.md', 'js/views/onboarding.js', 'js/views/reports.js', 'js/ui/rule-editor.js', 'js/views/automations.js'];
  for (const file of files) {
    const lines = read(file).split('\n').filter((l) => /Anthropic/.test(l) && /Settings/.test(l));
    for (const line of lines) assert.match(line, /Use AI features|Turn it on/, `${file}: ${line.trim()}`);
  }
  assert.match(section(README, '### 7.'), /Anthropic API key and turn on \*\*Use AI features\*\*/);
});

test('every "no App Review needed" note carries the DM Advanced Access caveat', () => {
  assert.match(read('core/ig.js'), /needsAdvancedAccess/);
  const chunks = [
    ...README.split(/\n\s*\n/).map((p) => ['README.md', p]),
    ...read('js/ui/connect-instagram.js').split('<li>').map((p) => ['js/ui/connect-instagram.js', p]),
  ];
  for (const [file, text] of chunks) {
    if (/App Review/.test(text)) assert.match(text, /Advanced Access/, `${file}: ${text.trim().slice(0, 80)}`);
  }
  // The feature table marks the DM features and explains the mark right below it.
  const table = README.split('\n').filter((l) => l.startsWith('| **Automate**') || l.startsWith('| **Engage**'));
  assert.equal(table.length, 2);
  for (const row of table) assert.match(row, /†/);
  assert.match(README, /\n† [^\n]*\n[^\n]*\*\*Advanced Access\*\*/);
});

test('README phone flows point to "Remember this device" (a new window has no session by default)', () => {
  assert.match(read('js/session.js'), /sessionStorage\.setItem/);
  assert.match(read('js/views/lock.js'), /label="Remember this device"/);
  const step = section(README, '### 7.');
  assert.match(step, /Share into Postpilot/);
  assert.match(step, /\*\*Remember this device\*\*[^]*reminder notification or a share/);
});

test('ARCHITECTURE post lifecycle and report timing match the code', () => {
  // The app's "Mark as posted" takes every status in post-now.js OPEN, scheduled included.
  const open = read('js/views/post-now.js').match(/const OPEN = \[([^\]]*)\]/)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
  assert.ok(open.includes('scheduled'));
  assert.doesNotMatch(ARCH, /Only the worker moves a post out of `scheduled`/);
  const lifecycle = between(ARCH, 'Post lifecycle:', '## 5.');
  const accepts = between(lifecycle, 'which accepts', ';');
  for (const s of open) assert.ok(accepts.includes(`\`${s}\``), `ARCHITECTURE.md: Mark as posted also takes ${s}`);
  // A post deleted from Instagram keeps its media "used".
  assert.match(lifecycle, /deletedFromInstagramAt`; its media stays "used"/);
  assert.equal(freesMedia({ status: 'canceled', deletedFromInstagramAt: '2026-10-01T00:00:00Z' }), false);

  // Reports: checked on days 1-3, never made on the 1st (the month's last day has only been read once).
  assert.match(ARCH, /`reports` monthly report, checked on days 1-3[^\n]*\n[^\n]*never the 1st/);
  const days = Object.fromEntries(dayRange('2026-09-01', '2026-09-30').map((k) => [k, { reach: 5, capturedAt: '2026-10-01T23:50:00Z' }]));
  assert.deepEqual(reportDue({ today: '2026-10-01', lastMonth: null, days }), { skipped: 'not_due' });
  assert.deepEqual(reportDue({ today: '2026-10-03', lastMonth: null, days }), { month: '2026-09' });
});
