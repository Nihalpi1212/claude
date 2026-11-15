// preset-files-manager (ARCHITECTURE.md "0.5 features", package 10; port 8860): the Preset Manager, Export/Import
// Presets (.pigment-bundle), Migrate Presets, and Photoshop's preset files opened, dropped, imported and exported
// through the panels: .grd, .pat, .aco / .ase, .csh, .asl, .tpl. Every file is built by the test (no Photoshop file is
// used). .asl / .csh content gates on psdFeatures() (psd-layers), .tpl dynamics on ABR_REAL (brush-settings-panel).
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run } from './helpers.mjs';

/** Page helpers: the format modules, a canvas, file bytes put where the bridge reads them. */
async function helpers(page) {
  await page.evaluate(async () => {
    const mods = {
      F: await import('/lib/preset-formats.js'),
      M: await import('/lib/preset-manager.js'),
      ACO: await import('/lib/preset-files/aco-ase.js'),
      PAT: await import('/lib/preset-files/pat.js'),
      GRD: await import('/lib/preset-files/grd.js'),
      CSH: await import('/lib/preset-files/csh.js'),
      ASL: await import('/lib/preset-files/asl.js'),
      TPL: await import('/lib/preset-files/tpl.js'),
      B: await import('/lib/preset-files/bundle.js'),
      psd: await import('/lib/psd/registry.js'),
      abr: await import('/lib/brush/abr.js'),
    };
    window.__pm = {
      ...mods,
      put(path, bytes) {
        window.__pigmentTest.files[path] = bytes;
        return path;
      },
      canvas(w, h, color) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        x.fillStyle = color;
        x.fillRect(0, 0, w, h);
        return c;
      },
      async ready(...kinds) {
        for (const k of kinds) await window.pigmentApp.presets.ready(k);
      },
      names: (kind) => window.pigmentApp.presets.list(kind).map((p) => p.name),
      closeDialogs: () => window.pigmentApp.dialogs.closeAll(),
    };
  });
}

const dialogText = (page) => page.evaluate(() => [...document.querySelectorAll('.dialog')].map((d) => d.textContent).join('\n'));

test('the commands land: Edit > Presets runs the Preset Manager, Export/Import Presets and Migrate Presets', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(() => {
    const app = window.pigmentApp;
    const ids = ['edit:preset-manager', 'edit:export-import-presets', 'edit:migrate-presets'];
    return { stubbed: ids.filter((id) => app.stubbed.includes(id)), enabled: ids.map((id) => app.commands.isEnabled(id)), record: ids.map((id) => app.commands.commands.get(id)?.record) };
  });
  expect(r).toEqual({ stubbed: [], enabled: [true, true, true], record: [false, false, false] });
  await run(page, 'edit:export-import-presets');
  await expect(page.locator('.dialog .pm-exim')).toBeVisible();
  await expect(page.locator('.pm-exim [data-tab="export"]')).toHaveText('Export Presets');
  await page.locator('.pm-exim [data-tab="import"]').click();
  await expect(page.locator('.pm-exim [data-pane="import"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await run(page, 'edit:migrate-presets');
  await expect(page.locator('.dialog', { hasText: 'Bring presets from an older Pigment' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Preset Manager: kinds, views, select with Shift and Ctrl, rename, delete, drag to reorder, Reset, Save Set', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await window.__pm.ready('gradients');
    for (const n of ['One', 'Two', 'Three']) app.presets.add('gradients', { name: n, data: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }] } });
  });
  await run(page, 'edit:preset-manager', { kind: 'gradients' });
  const pm = page.locator('.preset-manager');
  await expect(pm.locator('select[data-k="kind"]')).toHaveValue('gradients');
  // Photoshop's eight types first
  const kinds = await pm.locator('select[data-k="kind"] option').evaluateAll((os) => os.map((o) => o.value));
  expect(kinds.slice(0, 8)).toEqual(['brushes', 'swatches', 'gradients', 'styles', 'patterns', 'contours', 'shapes', 'tool-presets']);
  const item = (name) => pm.locator('.pm-item', { has: page.locator('.pm-name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(item('Three')).toHaveCount(1);
  // views: Text Only shows names only, Large List thumbnails and names
  await pm.locator('[data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Large List' }).click();
  await expect(pm.locator('.pm-list')).toHaveAttribute('data-view', 'large-list');
  await expect.poll(() => item('One').locator('.pm-thumb canvas').count()).toBe(1);
  // click, Shift-click, Ctrl-click
  await item('One').click();
  await item('Three').click({ modifiers: ['Shift'] });
  await expect(pm.locator('.pm-item.selected')).toHaveCount(3);
  await item('Two').click({ modifiers: ['ControlOrMeta'] });
  await expect(pm.locator('.pm-item.selected')).toHaveCount(2);
  await expect(pm.locator('.pm-status')).toContainText('2 selected');
  // rename one
  await item('One').click();
  await pm.locator('[data-act="rename"]').click();
  const prompt = page.locator('.dialog', { hasText: 'Name:' });
  await prompt.locator('input').fill('Uno');
  await prompt.locator('.btn.primary').click();
  await expect(item('Uno')).toHaveCount(1);
  // drag Three before Uno
  await item('Three').dragTo(item('Uno'));
  await expect.poll(() => page.evaluate(() => window.__pm.names('gradients').filter((n) => ['Uno', 'Two', 'Three'].includes(n)))).toEqual(['Three', 'Uno', 'Two']);
  // Delete key removes the selection
  await item('Two').click();
  await page.keyboard.press('Delete');
  await expect(item('Two')).toHaveCount(0);
  // Save Set… exports the selection (.pigment-presets by default)
  await item('Uno').click();
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/Selected.pigment-presets'));
  await pm.locator('[data-act="save"]').click();
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/Selected.pigment-presets'])).toBe(true);
  const saved = await page.evaluate(() => JSON.parse(new TextDecoder().decode(window.__pigmentTest.written['mem:/Selected.pigment-presets'])).items.map((i) => i.name));
  expect(saved).toEqual(['Uno']);
  // Reset Gradients… back to the built-ins
  await pm.locator('[data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Reset Gradients' }).click();
  await page.locator('.dialog', { hasText: 'Replace the current gradients' }).locator('.btn.primary').click();
  await expect(item('Uno')).toHaveCount(0);
  await expect(item('Three')).toHaveCount(0);
  // switch kinds: the swatches show colour chips; the choice is remembered
  await pm.locator('select[data-k="kind"]').selectOption('swatches');
  await expect.poll(() => pm.locator('.pm-item').count()).toBeGreaterThan(5);
  await page.locator('.dialog .btn.primary', { hasText: 'Done' }).click();
  expect(await page.evaluate(() => window.pigmentApp.settings.presetManager)).toMatchObject({ kind: 'swatches', view: 'large-list' });
  expect(errors).toEqual([]);
});

test('Photoshop files opened and dropped: .grd lands in Gradients, .pat in Patterns, .aco / .ase in Swatches, .csh in Shapes; no document opens', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { GRD, PAT, ACO, CSH, put, canvas, ready, names } = window.__pm;
    await ready('gradients', 'patterns', 'swatches', 'shapes');
    await app.patterns.ready();
    const docs0 = app.docs.list().length;
    // .grd: dropped on the window
    const grd = GRD.writeGrdFile([{ name: 'Dropped Sunset', data: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#ff8800' }, { pos: 1, mid: 0.5, color: '#220044' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] } }]).bytes;
    const dt = new DataTransfer();
    dt.items.add(new File([grd], 'Sunsets.grd'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const t0 = Date.now();
    while (!names('gradients').includes('Dropped Sunset') && Date.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 50));
    // .pat, .aco, .ase, .csh: File > Open
    const pix = canvas(3, 2, '#3366cc').getContext('2d').getImageData(0, 0, 3, 2);
    const pat = (await PAT.writePatFile([{ name: 'Blue tile', data: { width: 3, height: 2, blob: 'x.png' } }], { readBlob: async () => new Uint8Array(await (await new Promise((res) => canvas(3, 2, '#3366cc').toBlob(res, 'image/png'))).arrayBuffer()) })).bytes;
    void pix;
    const aco = ACO.writeAco({ colors: [{ name: 'Aco Teal', color: { space: 'rgb', values: [0, 128, 128] } }] }).bytes;
    const ase = ACO.writeAse({ groups: [{ name: 'Brand', colors: [{ name: 'Ase Plum', color: { space: 'rgb', values: [142, 69, 133] } }] }] }).bytes;
    const csh = CSH.writeCshFile([{ name: 'Wedge', data: { path: { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }] }] }, width: 80, height: 40 } }]).bytes;
    await app.commands.run('file:open-paths', [put('mem:/Tiles.pat', pat), put('mem:/Teal.aco', aco), put('mem:/Brand.ase', ase), put('mem:/Wedges.csh', csh)], 'api');
    const patternPreset = app.presets.list('patterns').find((p) => p.name === 'Blue tile');
    const entry = patternPreset ? await app.patterns.get(patternPreset.id) : null;
    const px = entry?.canvas ? Array.from(entry.canvas.getContext('2d').getImageData(1, 1, 1, 1).data) : null;
    const plum = app.presets.list('swatches').find((p) => p.name === 'Ase Plum');
    const groupOf = (kind, p) => app.presets.groups(kind).find((g) => g.id === p?.group);
    return {
      docs: app.docs.list().length - docs0,
      gradient: names('gradients').includes('Dropped Sunset'),
      gradientGroup: groupOf('gradients', app.presets.list('gradients').find((p) => p.name === 'Dropped Sunset'))?.name,
      px,
      teal: app.presets.list('swatches').find((p) => p.name === 'Aco Teal')?.data.color,
      plumGroup: groupOf('swatches', plum)?.name,
      plumParent: app.presets.groups('swatches').find((g) => g.id === groupOf('swatches', plum)?.parent)?.name,
      wedge: app.presets.list('shapes').find((p) => p.name === 'Wedge')?.data ?? null,
      vectorMasks: window.__pm.psd.psdFeatures().vectorMasks,
    };
  });
  expect(r.docs).toBe(0);
  expect(r.gradient).toBe(true);
  expect(r.gradientGroup).toBe('Sunsets');
  expect(r.px).toEqual([0x33, 0x66, 0xcc, 255]);
  expect(r.teal).toEqual({ space: 'rgb', values: [0, 128, 128] });
  expect([r.plumGroup, r.plumParent]).toEqual(['Brand', 'Brand']);
  if (r.vectorMasks) expect(r.wedge).toMatchObject({ width: 80, height: 40, path: { subpaths: [{ closed: true }] } });
  await page.evaluate(() => window.__pm.closeDialogs());
  expect(errors).toEqual([]);
});

test('the Gradients panel exports .grd and the Swatches kind .ase when the typed name says so; the default stays .pigment-presets', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { GRD, ACO, F, ready } = window.__pm;
    await ready('gradients', 'swatches');
    app.presets.add('gradients', { name: 'Export me', data: { stops: [{ pos: 0, color: '#00ff00' }, { pos: 1, color: '#0000ff' }] } });
    const { exportPresets } = await import('/lib/gradient-editor.js');
    await exportPresets(app, null, 'mem:/All.grd');
    await exportPresets(app, null, 'mem:/All');
    const grd = await GRD.readGrdFile(window.__pigmentTest.written['mem:/All.grd'], { name: 'All.grd' });
    const aseFile = await F.exportPresetsDialog(app, 'swatches', null, { path: 'mem:/Swatches.ase' });
    const ase = ACO.parseAse(window.__pigmentTest.written['mem:/Swatches.ase']);
    return { names: grd.presets.map((p) => p.name), report: grd.report, plain: !!window.__pigmentTest.written['mem:/All.pigment-presets'], aseFile, ase: ase.all.length, swatches: app.presets.list('swatches').length };
  });
  expect(r.names).toContain('Export me');
  expect(r.report).toEqual([]);
  expect(r.plain).toBe(true);
  expect(r.aseFile).toBe('mem:/Swatches.ase');
  expect(r.ase).toBe(r.swatches);
  expect(errors).toEqual([]);
});

test('.asl: a style with a pattern overlay brings its pattern; the stored style names the pattern preset', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { ASL, put, ready, canvas } = window.__pm;
    await ready('styles', 'patterns');
    const pix = canvas(4, 4, '#cc3300').getContext('2d').getImageData(0, 0, 4, 4);
    const styles = {
      dropShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.5, angle: 120, distance: 4, spread: 0, size: 6 },
      patternOverlay: { enabled: true, blend: 'normal', opacity: 1, pattern: { presetId: 'fake', name: 'Rust' }, scale: 1, angle: 0, link: true, origin: [0, 0] },
    };
    const { bytes } = await ASL.writeAslFile([{ name: 'Rusty', data: { styles } }], { patternPixels: async () => ({ width: 4, height: 4, data: pix.data }) });
    await app.commands.run('file:open-paths', [put('mem:/Rusty.asl', bytes)], 'api');
    const style = app.presets.list('styles').find((p) => p.name === 'Rusty');
    const pattern = app.presets.list('patterns').find((p) => p.name === 'Rust');
    const ref = pattern ? await app.patterns.refFor(pattern.id) : null;
    const decoded = ref ? await app.patterns.canvasOf(ref) : null;
    return {
      effects: window.__pm.psd.psdFeatures().effects,
      style: style?.data ?? null,
      patternId: pattern?.id ?? null,
      group: app.presets.groups('styles').find((g) => g.id === style?.group)?.name,
      px: decoded ? Array.from(decoded.getContext('2d').getImageData(0, 0, 1, 1).data) : null,
    };
  });
  expect(r.group).toBe('Rusty');
  if (r.effects) {
    expect(r.style.styles.dropShadow).toMatchObject({ enabled: true, distance: 4, size: 6 });
    expect(r.style.styles.patternOverlay.pattern).toEqual({ presetId: r.patternId, name: 'Rust' });
    expect(r.px).toEqual([0xcc, 0x33, 0x00, 255]);
  }
  await page.evaluate(() => window.__pm.closeDialogs());
  expect(errors).toEqual([]);
});

test('.tpl: a tool preset with a sampled brush tip imports the tip into Brushes and the preset into Tool Presets; export reads back', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TPL, F, put, ready, canvas, abr } = window.__pm;
    await ready('tool-presets', 'brushes', 'patterns');
    // a grey tip as the brushes kind stores it
    const tipCanvas = canvas(8, 8, '#808080');
    const png = new Uint8Array(await (await new Promise((res) => tipCanvas.toBlob(res, 'image/png'))).arrayBuffer());
    const brush = { tip: { kind: 'sampled', size: 24, sample: { blob: 'tip-src.png', hash: 'src', width: 8, height: 8 } }, scattering: { enabled: true, scatter: 1.5, count: 2 } };
    const { bytes } = await TPL.writeTplFile([{ name: 'Scatter Stamp', data: { tool: 'brush', options: { opacity: 0.7 }, brush } }, { name: 'Headline', data: { tool: 'type', options: {}, type: { char: { size: 64 }, para: {} } } }], { readBlob: async (k, n) => (n === 'tip-src.png' ? png : null) });
    await app.commands.run('file:open-paths', [put('mem:/Mine.tpl', bytes)], 'api');
    const scatter = app.presets.list('tool-presets').find((p) => p.name === 'Scatter Stamp');
    const head = app.presets.list('tool-presets').find((p) => p.name === 'Headline');
    const blob = scatter?.data.brush?.tip.sample?.blob;
    const stored = blob ? await app.presets.readBlob('brushes', blob) : null;
    // export both through the registered format and read the file back
    await F.exportPresetsDialog(app, 'tool-presets', [scatter.id, head.id], { path: 'mem:/Out.tpl' });
    const back = await TPL.readTplFile(window.__pigmentTest.written['mem:/Out.tpl'], { name: 'Out.tpl' });
    return {
      abrReal: abr.ABR_REAL,
      options: scatter?.data.options,
      tipKind: scatter?.data.brush?.tip.kind,
      stored: !!stored?.length,
      scatter: scatter?.data.brush?.scattering,
      type: head?.data.type,
      back: back.items.filter((i) => i.kind === 'tool-presets').map((i) => i.name),
      backTip: back.items.find((i) => i.name === 'Scatter Stamp')?.data.brush.tip.kind,
    };
  });
  expect(r.options).toEqual({ opacity: 0.7 });
  expect(r.tipKind).toBe('sampled');
  expect(r.stored).toBe(true);
  expect(r.type).toEqual({ char: { size: 64 }, para: {} });
  expect(r.back).toEqual(['Scatter Stamp', 'Headline']);
  expect(r.backTip).toBe('sampled');
  if (r.abrReal) expect(r.scatter).toMatchObject({ enabled: true, scatter: 1.5, count: 2 });
  await page.evaluate(() => window.__pm.closeDialogs());
  expect(errors).toEqual([]);
});

test('Export/Import Presets: a bundle round trip with groups, pattern pixels and settings; importing it again adds nothing', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { ready, canvas } = window.__pm;
    await ready('gradients', 'patterns', 'swatches');
    await app.patterns.ready();
    const g = app.presets.addGroup('gradients', { name: 'Bundle group' });
    app.presets.add('gradients', { name: 'Bundled', group: g.id, data: { stops: [{ pos: 0, color: '#123456' }, { pos: 1, color: '#654321' }] } });
    await app.patterns.define(canvas(5, 5, '#00aa55'), { name: 'Bundled pattern' });
    app.saveSettingsSoon({ tools: { ...(app.settings.tools ?? {}), brush: { ...(app.settings.tools?.brush ?? {}), size: 77 } } });
  });
  // the dialog: Export lists the kinds that hold the user's presets and the settings
  await run(page, 'edit:export-import-presets');
  const exim = page.locator('.pm-exim');
  await expect(exim.locator('.pm-export-kinds label', { hasText: 'Gradients (1)' })).toBeVisible();
  await expect(exim.locator('.pm-export-kinds label', { hasText: 'Settings:' })).toBeVisible();
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/Everything'));
  await exim.locator('[data-act="export"]').click();
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/Everything.pigment-bundle'])).toBe(true);
  await page.evaluate(() => window.__pm.closeDialogs());
  // a fresh library: the user's presets gone, another brush size
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.presets.reset('gradients');
    const own = app.presets.list('patterns').filter((p) => !p.builtin).map((p) => p.id);
    await app.patterns.remove(own);
    app.saveSettingsSoon({ tools: { ...(app.settings.tools ?? {}), brush: { ...(app.settings.tools?.brush ?? {}), size: 5 } } });
  });
  const res = await runAwait(page, 'edit:export-import-presets', { mode: 'import', path: 'mem:/Everything.pigment-bundle' });
  expect(res.added).toMatchObject({ gradients: 1, patterns: 1 });
  expect(res.settings).toBe(true);
  await expect(page.locator('.dialog', { hasText: 'Restart Pigment to apply the imported settings' })).toBeVisible();
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const p = app.presets.list('gradients').find((x) => x.name === 'Bundled');
    const pat = app.presets.list('patterns').find((x) => x.name === 'Bundled pattern');
    const e = pat ? await app.patterns.get(pat.id) : null;
    return { group: app.presets.groups('gradients').find((g) => g.id === p?.group)?.name, px: e?.canvas ? Array.from(e.canvas.getContext('2d').getImageData(2, 2, 1, 1).data) : null, size: app.settings.tools.brush.size };
  });
  expect(r).toEqual({ group: 'Bundle group', px: [0, 0xaa, 0x55, 255], size: 77 });
  await page.evaluate(() => window.__pm.closeDialogs());
  // again: nothing is added, the report says why
  const again = await runAwait(page, 'edit:export-import-presets', { mode: 'import', path: 'mem:/Everything.pigment-bundle', settings: false });
  expect(again.added).toEqual({});
  expect(again.report.join('\n')).toMatch(/already in the library/);
  await page.evaluate(() => window.__pm.closeDialogs());
  expect(errors).toEqual([]);
});

test('Migrate Presets: from an older Pigment\'s settings folder; a second migration adds nothing', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  await page.evaluate(async () => {
    const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
    const { put } = window.__pm;
    put('mem:/OldPigment/settings.json', enc({ theme: 'dark' }));
    put('mem:/OldPigment/presets/gradients.json', enc({ format: 'pigment-presets', version: 1, kind: 'gradients', kindVersion: 1, groups: [{ id: 'g-old', name: 'From 0.4', parent: null }], items: [{ ref: 'black-white' }, { id: 'u-old', name: 'Old Fade', group: 'g-old', data: { stops: [{ pos: 0, color: '#ff00ff' }, { pos: 1, color: '#00ffff' }] }, builtin: false }], hidden: [] }));
    put('mem:/OldPigment/presets/patterns.json', enc({ format: 'pigment-presets', version: 1, kind: 'patterns', kindVersion: 1, groups: [], items: [{ id: 'u-p', name: 'Old Tile', group: null, data: { width: 2, height: 2, blob: 'p-old.png', mode: 'rgb' }, builtin: false }], hidden: [] }));
    const c = window.__pm.canvas(2, 2, '#ffcc00');
    put('mem:/OldPigment/presets/patterns/p-old.png', new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer()));
  });
  const res = await runAwait(page, 'edit:migrate-presets', 'mem:/OldPigment');
  expect(res.added).toEqual({ gradients: 1, patterns: 1 });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const fade = app.presets.list('gradients').find((p) => p.name === 'Old Fade');
    const tile = app.presets.list('patterns').find((p) => p.name === 'Old Tile');
    const e = tile ? await app.patterns.get(tile.id) : null;
    return { group: app.presets.groups('gradients').find((g) => g.id === fade?.group)?.name, px: e?.canvas ? Array.from(e.canvas.getContext('2d').getImageData(0, 0, 1, 1).data) : null };
  });
  expect(r).toEqual({ group: 'From 0.4', px: [255, 0xcc, 0, 255] });
  await page.evaluate(() => window.__pm.closeDialogs());
  const again = await runAwait(page, 'edit:migrate-presets', { path: 'mem:/OldPigment' });
  expect(again.added).toEqual({});
  await expect(page.locator('.dialog', { hasText: 'No presets were migrated' })).toBeVisible();
  await page.evaluate(() => window.__pm.closeDialogs());
  expect(errors).toEqual([]);
});

test('paths: a failed store write is reported, a file over 64 MB is refused with a message, a damaged file reports', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  await page.evaluate(() => window.__pm.ready('gradients', 'patterns'));
  // a damaged .pat: what could be read, and a report
  await page.evaluate(async () => {
    const { PAT, put } = window.__pm;
    const pat = (await PAT.writePatFile([{ name: 'Checker', data: { builtin: 'checkerboard', width: 16, height: 16 } }], {})).bytes;
    await window.pigmentApp.commands.run('file:open-paths', [put('mem:/Broken.pat', pat.slice(0, pat.length - 40))], 'api');
  });
  await expect(page.locator('.dialog', { hasText: 'No presets were imported' })).toContainText('truncated');
  await page.evaluate(() => window.__pm.closeDialogs());
  // over 64 MB
  await page.evaluate(async () => {
    const big = new Uint8Array(64 * 1024 * 1024 + 16);
    big.set([56, 66, 71, 82, 0, 5]);
    await window.pigmentApp.commands.run('file:open-paths', [window.__pm.put('mem:/Huge.grd', big)], 'api');
  });
  await expect(page.locator('.dialog', { hasText: 'No presets were imported' })).toContainText('over 64 MB');
  await page.evaluate(() => {
    delete window.__pigmentTest.files['mem:/Huge.grd'];
    window.__pm.closeDialogs();
  });
  // the store refuses the write: the user is told, the session keeps the presets
  await page.evaluate(async () => {
    const { GRD, put } = window.__pm;
    window.__pigmentTest.failPresetWrite = 'quota';
    const grd = GRD.writeGrdFile([{ name: 'Unsaved', data: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] } }]).bytes;
    await window.pigmentApp.commands.run('file:open-paths', [put('mem:/Unsaved.grd', grd)], 'api');
  });
  await expect(page.locator('.toast.error', { hasText: 'Presets could not be saved' })).toBeVisible();
  expect(await page.evaluate(() => window.__pm.names('gradients').includes('Unsaved'))).toBe(true);
  // once the storage takes writes again the next change saves the library (IndexedDB), which a reload reads back
  await page.evaluate(async () => {
    const { GRD, put } = window.__pm;
    window.__pigmentTest.failPresetWrite = null;
    const grd = GRD.writeGrdFile([{ name: 'Saved later', data: { stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#ffffff' }] } }]).bytes;
    await window.pigmentApp.commands.run('file:open-paths', [put('mem:/Later.grd', grd)], 'api');
    await window.pigmentApp.presets.flush();
  });
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  const kept = await page.evaluate(async () => {
    await window.pigmentApp.presets.ready('gradients');
    return window.pigmentApp.presets.list('gradients').map((p) => p.name);
  });
  expect(kept).toEqual(expect.arrayContaining(['Unsaved', 'Saved later']));
  expect(errors).toEqual([]);
});

test('Pigment libraries load from the Preset Manager menu; 16-bit and Lab documents are untouched by preset work', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  await newDoc(page, { width: 64, height: 48 });
  await runAwait(page, 'image:depth', 16);
  await runAwait(page, 'image:mode', 'lab');
  const before = await page.evaluate(() => ({ mode: window.pigmentApp.doc.mode, depth: window.pigmentApp.doc.depth, history: window.pigmentApp.doc.history.index }));
  expect(before).toMatchObject({ mode: 'lab', depth: 16 });
  await run(page, 'edit:preset-manager', { kind: 'swatches' });
  const pm = page.locator('.preset-manager');
  await expect(pm.locator('select[data-k="kind"]')).toHaveValue('swatches');
  const n0 = await page.evaluate(() => window.pigmentApp.presets.list('swatches').length);
  await pm.locator('[data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Web Safe Colors' }).click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.presets.list('swatches').length)).toBe(n0 + 216);
  await expect(pm.locator('.pm-group', { hasText: 'Web Safe Colors' })).toBeVisible();
  const libs = await page.evaluate(async () => (await window.__pm.M.pigmentLibraries()).map((l) => `${l.kind}:${l.name}`));
  expect(libs).toEqual(expect.arrayContaining(['swatches:Web Safe Colors', 'gradients:Pigment Gradients', 'patterns:Pigment Patterns', 'shapes:Pigment Shapes', 'styles:Pigment Styles', 'brushes:Dry Media']));
  await page.locator('.dialog .btn.primary', { hasText: 'Done' }).click();
  // preset work is not document history
  const after = await page.evaluate(() => ({ mode: window.pigmentApp.doc.mode, depth: window.pigmentApp.doc.depth, history: window.pigmentApp.doc.history.index }));
  expect(after).toEqual(before);
  expect(errors).toEqual([]);
});
