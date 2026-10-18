import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonStore } from '../../src/main/settings-store.js';
import { addRecent, removeRecent, normalizeRecent } from '../../src/main/recent.js';
import { resolveAppUrl, mimeFor, APP_ORIGIN } from '../../src/main/protocol.js';
import { filesFromArgv } from '../../src/main/startup-files.js';
import { buildMenuTemplate } from '../../src/main/menu.js';
import { withDefaults } from '../../src/shared/defaults.js';
import { MENU_KEYS } from '../../src/shared/keymap.js';

test('JsonStore loads defaults, persists patches atomically and survives corrupt files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'folio-store-'));
  try {
    const file = join(dir, 'settings.json');
    const store = new JsonStore(file, withDefaults);
    await store.load();
    assert.equal(store.get().theme, 'system');
    await store.patch({ theme: 'dark' });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).theme, 'dark');
    const again = new JsonStore(file, withDefaults);
    await again.load();
    assert.equal(again.get().theme, 'dark');
    writeFileSync(file, '{not json');
    const corrupt = new JsonStore(file, withDefaults);
    await corrupt.load();
    assert.equal(corrupt.get().theme, 'system');
    await Promise.all([corrupt.patch({ a: 1 }), corrupt.patch({ b: 2 })]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).b, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recent list: add, dedupe, limit, remove, normalize', () => {
  let list = [];
  list = addRecent(list, { path: '/a.pdf' }, 3, 100);
  list = addRecent(list, { path: '/b.pdf', page: 4 }, 3, 200);
  list = addRecent(list, { path: '/a.pdf', page: 2 }, 3, 300);
  assert.deepEqual(list.map((e) => e.path), ['/a.pdf', '/b.pdf']);
  assert.equal(list[0].page, 2);
  assert.equal(list[0].name, 'a.pdf');
  list = addRecent(list, { path: '/c.pdf' }, 3, 400);
  list = addRecent(list, { path: '/d.pdf' }, 3, 500);
  assert.deepEqual(list.map((e) => e.path), ['/d.pdf', '/c.pdf', '/a.pdf']);
  list = removeRecent(list, '/c.pdf');
  assert.deepEqual(list.map((e) => e.path), ['/d.pdf', '/a.pdf']);
  assert.deepEqual(normalizeRecent([{ path: '' }, null, { path: '/x.pdf', lastOpened: 'bad' }, { path: '/x.pdf' }]), [{ path: '/x.pdf', name: 'x.pdf', lastOpened: 0 }]);
});

test('folio:// url resolution stays inside the app directories', () => {
  const root = resolve('/app/src/renderer');
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/index.html`, root), join(root, 'index.html'));
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/`, root), join(root, 'index.html'));
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/lib/app.js?x=1`, root), join(root, 'lib', 'app.js'));
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/shared/engine.js`, root), resolve('/app/src/shared/engine.js'));
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/build/icon.png`, root), resolve('/app/build/icon.png'));
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/../../etc/passwd`, root), join(root, 'etc', 'passwd'), 'URL parsing collapses dot segments inside the root');
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/lib/%2e%2e/%2e%2e/secret`, root), join(root, 'secret'), 'encoded dot segments are collapsed by the URL parser');
  const bs = resolveAppUrl(`${APP_ORIGIN}/..%5C..%5Csecret`, root);
  assert.ok(bs === null || bs.startsWith(root + '/') || bs.startsWith(root + '\\'), 'backslash traversal never escapes the root');
  assert.equal(resolveAppUrl(`${APP_ORIGIN}/shared/../main/main.js`, root), join(root, 'main', 'main.js'), 'parent segments resolve against the renderer root, never src/');
  assert.equal(resolveAppUrl('folio://other/index.html', root), null);
  assert.equal(resolveAppUrl('http://app/index.html', root), null);
  assert.equal(mimeFor('a.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('x.bcmap'), 'application/octet-stream');
  assert.equal(mimeFor('x.unknown'), 'application/octet-stream');
});

test('startup files from argv', () => {
  const exists = (p) => !p.includes('missing');
  // expected paths go through resolve() so the test holds on Windows (drive letters, backslashes) too
  assert.deepEqual(filesFromArgv(['electron', '.', '--inspect', 'a.pdf', '/tmp/b.PDF', 'c.txt', 'missing.pdf'], { isPackaged: false, cwd: '/x', exists }), [resolve('/x', 'a.pdf'), '/tmp/b.PDF']); // '/tmp/b.PDF' counts as absolute on every platform and is kept as given
  assert.deepEqual(filesFromArgv(['Folio.exe', 'C:\\docs\\a.pdf'], { isPackaged: true, cwd: 'C:\\', exists }), [resolve('C:\\', 'C:\\docs\\a.pdf')]);
  assert.deepEqual(filesFromArgv(['Folio', 'a.pdf', 'a.pdf'], { isPackaged: true, cwd: '/x', exists }), [resolve('/x', 'a.pdf')]);
});

test('menu template references known commands and accelerators', () => {
  const seen = new Set();
  const run = (cmd) => seen.add(cmd);
  const walk = (items, fn) => {
    for (const item of items) {
      fn(item);
      if (item.submenu) walk(item.submenu, fn);
    }
  };
  for (const platform of ['darwin', 'win32', 'linux']) {
    const template = buildMenuTemplate({ platform, state: { hasDocument: true }, recent: [{ path: '/r.pdf', name: 'r.pdf' }], run, isPackaged: true });
    walk(template, (item) => {
      if (item.click) item.click();
      if (item.accelerator) assert.ok(Object.values(MENU_KEYS).includes(item.accelerator), `accelerator ${item.accelerator} comes from the keymap`);
    });
    assert.equal(template[0].label, platform === 'darwin' ? 'Folio PDF' : '&File');
  }
  for (const cmd of ['file:open', 'file:save', 'file:print', 'edit:find', 'view:zoom-in', 'tool:highlight', 'pages:organize', 'help:shortcuts', 'file:open-recent']) assert.ok(seen.has(cmd), `menu runs ${cmd}`);
  const noDoc = buildMenuTemplate({ platform: 'win32', state: { hasDocument: false }, recent: [], run, isPackaged: true });
  const save = noDoc[0].submenu.find((i) => i.label === '&Save');
  assert.equal(save.enabled, false);
});
