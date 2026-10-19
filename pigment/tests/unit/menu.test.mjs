import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate } from '../../src/main/menu.js';

function collect(template) {
  const cmds = [];
  const accels = [];
  const walk = (items) => {
    for (const it of items) {
      if (it.submenu) walk(it.submenu);
      if (it.accelerator) accels.push(it.accelerator);
      if (it.click) it.click();
    }
  };
  walk(template);
  return { cmds, accels };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`menu builds for ${platform} and every item runs a command`, () => {
    const ran = [];
    const template = buildMenuTemplate({ platform, state: { hasDocument: true, hasLayer: true, hasSelection: true, lastFilter: 'Gaussian Blur' }, recent: [{ path: '/tmp/a.png', name: 'a.png' }], run: (cmd, arg) => ran.push([cmd, arg]), isPackaged: false });
    const { accels } = collect(template);
    assert.ok(ran.length > 150, `expected many menu commands, got ${ran.length}`);
    for (const [cmd] of ran) assert.match(cmd, /^[a-z]+:[A-Za-z0-9-]+$/);
    const dup = accels.filter((a, i) => accels.indexOf(a) !== i);
    assert.deepEqual(dup, [], `duplicate accelerators: ${dup.join(', ')}`);
    assert.equal(template.some((m) => m.label === 'Pigment'), platform === 'darwin');
  });
}

test('document items are disabled without a document', () => {
  const template = buildMenuTemplate({ platform: 'linux', state: {}, recent: [], run: () => {} });
  const file = template.find((m) => m.label === '&File');
  assert.equal(file.submenu.find((i) => i.label === '&Save').enabled, false);
  assert.equal(file.submenu.find((i) => i.label === '&Open…').enabled, true);
});
