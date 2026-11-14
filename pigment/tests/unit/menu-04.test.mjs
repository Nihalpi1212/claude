// The 0.4 menu template (ARCHITECTURE.md "0.4 features", M.1–M.3): the Type menu, every new item with its command
// and argument, no accelerator twice on any platform, the state-dependent labels, and clicks reporting whether the
// accelerator triggered them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate } from '../../src/shared/menu-template.js';
import * as reexport from '../../src/main/menu.js';
import { parseAccelerator } from '../../src/shared/keymap.js';
import { ADJUSTMENTS } from '../../src/shared/pixels/adjust.js';

const FULL = { hasDocument: true, hasLayer: true, hasSelection: true, hasVectorMask: true, layerType: 'text', lastFilter: 'Gaussian Blur' };
const build = (platform = 'linux', state = FULL, run = () => {}) => buildMenuTemplate({ platform, state, recent: [], run, isPackaged: false });

/** Every item that runs a command: its path of labels (without &), the command, the argument and the item. */
function commands(platform = 'linux', state = FULL) {
  let last = null;
  const t = build(platform, state, (cmd, arg) => (last = [cmd, arg]));
  const out = [];
  const walk = (xs, path) => {
    for (const it of xs) {
      if (it.submenu) walk(it.submenu, [...path, it.label.replace(/&/g, '')]);
      else if (it.click) {
        last = null;
        it.click(it, null, undefined);
        if (last) out.push({ path: [...path, it.label.replace(/&/g, '')], cmd: last[0], arg: last[1], item: it });
      }
    }
  };
  walk(t, []);
  return out;
}

test('src/main/menu.js re-exports the shared template', () => {
  assert.equal(reexport.buildMenuTemplate, buildMenuTemplate);
  for (const k of ['PANELS', 'IMAGE_MODES', 'STACK_MODES']) assert.ok(Array.isArray(reexport[k]), k);
});

test('the Type menu sits between Layer and Select; Layer > Type and Layer > Edit Text are gone', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const labels = build(platform).map((m) => m.label);
    const iLayer = labels.indexOf('&Layer'), iType = labels.indexOf('T&ype'), iSelect = labels.indexOf('&Select');
    assert.ok(iLayer >= 0 && iType === iLayer + 1 && iSelect === iType + 1, labels.join(' | '));
  }
  const layer = build().find((m) => m.label === '&Layer').submenu;
  assert.ok(!layer.some((i) => i.label === '&Type'), 'Layer > Type is gone');
  assert.ok(!layer.some((i) => i.label === 'Edit &Text'), 'Layer > Edit Text is gone');
  const all = commands();
  const layerCmds = all.filter((x) => x.path[0] === 'Layer').map((x) => x.cmd);
  for (const gone of ['layer:edit-text', 'text:orientation', 'text:on-path', 'text:release-path', 'text:flip-path']) assert.ok(!layerCmds.includes(gone), gone);
});

// [path (labels without &), command, argument]
const EXPECTED = [
  // M.2: the Type menu
  [['Type', 'Panels', 'Character Panel'], 'window:panel-character'],
  [['Type', 'Panels', 'Paragraph Panel'], 'window:panel-paragraph'],
  [['Type', 'Orientation', 'Horizontal'], 'text:orientation', 'horizontal'],
  [['Type', 'Orientation', 'Vertical'], 'text:orientation', 'vertical'],
  [['Type', 'Orientation', 'Vertical, Stacked (CJK)'], 'text:orientation', 'vertical-stacked'],
  [['Type', 'Text on Path'], 'text:on-path'],
  [['Type', 'Release from Path'], 'text:release-path'],
  [['Type', 'Flip Text on Path'], 'text:flip-path'],
  [['Type', 'Edit Text'], 'layer:edit-text'],
  [['Type', 'Rasterize Type Layer'], 'layer:rasterize', 'type'],
  // M.3
  [['File', 'Export', 'Quick Export as PNG'], 'file:export-quick'],
  [['File', 'Export', 'Export As…'], 'file:export'],
  [['File', 'Export', 'Save for Web (Legacy)…'], 'file:save-for-web'],
  [['Edit', 'Toggle Last State'], 'edit:toggle-last-state'],
  [['Edit', 'Step Forward'], 'edit:step-forward'],
  [['Edit', 'Step Backward'], 'edit:step-backward'],
  [['Edit', 'Paste Special', 'Paste Without Formatting'], 'edit:paste-without-formatting'],
  [['Edit', 'Search…'], 'edit:search'],
  [['Edit', 'Define Pattern…'], 'edit:define-pattern'],
  [['Edit', 'Keyboard Shortcuts…'], 'help:shortcuts'],
  [['Edit', 'Menus…'], 'edit:menus'],
  [['Image', 'Adjustments', 'Color and Vibrance…'], 'image:adjust-color-vibrance'],
  [['Image', 'Adjustments', 'Clarity and Dehaze…'], 'image:adjust-clarity-dehaze'],
  [['Image', 'Adjustments', 'Grain…'], 'image:adjust-grain'],
  [['Layer', 'New Adjustment Layer', 'Color and Vibrance…'], 'layer:new-adjustment', 'color-vibrance'],
  [['Layer', 'New Adjustment Layer', 'Clarity and Dehaze…'], 'layer:new-adjustment', 'clarity-dehaze'],
  [['Layer', 'New Adjustment Layer', 'Grain…'], 'layer:new-adjustment', 'grain'],
  [['Layer', 'New', 'Layer…'], 'layer:new'],
  [['Layer', 'New', 'Group…'], 'layer:new-group'],
  [['Layer', 'Duplicate Layer…'], 'layer:duplicate'],
  [['Layer', 'Layer Style', 'Create Layers'], 'layer:style-create-layers'],
  [['Layer', 'Layer Style', 'Hide All Effects'], 'layer:style-toggle-all'],
  [['Layer', 'Layer Style', 'Scale Effects…'], 'layer:style-scale'],
  [['Layer', 'Vector Mask', 'Reveal All'], 'layer:vector-mask', 'reveal-all'],
  [['Layer', 'Vector Mask', 'Hide All'], 'layer:vector-mask', 'hide-all'],
  [['Layer', 'Vector Mask', 'Current Path'], 'layer:vector-mask', 'current-path'],
  [['Layer', 'Vector Mask', 'Delete'], 'layer:vector-mask', 'delete'],
  [['Layer', 'Vector Mask', 'Disable / Enable'], 'layer:vector-mask', 'toggle'],
  [['Layer', 'Vector Mask', 'Link / Unlink'], 'layer:vector-mask', 'link'],
  [['Layer', 'Rasterize', 'Type'], 'layer:rasterize', 'type'],
  [['Layer', 'Rasterize', 'Shape'], 'layer:rasterize', 'shape'],
  [['Layer', 'Rasterize', 'Fill Content'], 'layer:rasterize', 'fill'],
  [['Layer', 'Rasterize', 'Vector Mask'], 'layer:vector-mask', 'rasterize'],
  [['Layer', 'Rasterize', 'Smart Object'], 'layer:smart-rasterize'],
  [['Layer', 'Rasterize', 'Layer'], 'layer:rasterize'],
  [['Layer', 'Rasterize', 'All Layers'], 'layer:rasterize-all'],
  [['Layer', 'Rasterize', 'Layer Style'], 'layer:rasterize-style'],
  [['Layer', 'Hide / Show Layers'], 'layer:visibility'],
  [['Layer', 'Arrange', 'Reverse'], 'layer:arrange-reverse'],
  ...[['Top Edges', 'top'], ['Vertical Centers', 'vcenter'], ['Bottom Edges', 'bottom'], ['Left Edges', 'left'], ['Horizontal Centers', 'hcenter'], ['Right Edges', 'right'], ['Horizontally', 'horizontal'], ['Vertically', 'vertical']]
    .map(([label, arg]) => [['Layer', 'Distribute', label], 'layer:distribute', arg]),
  [['Layer', 'Lock Layers…'], 'layer:lock-dialog'],
  [['Layer', 'Lock All Layers in Group…'], 'layer:lock-group'],
  [['Layer', 'Merge Down'], 'layer:merge'],
  [['Select', 'Similar Layers'], 'layer:select-similar'],
  [['Filter', 'Last Filter: Gaussian Blur'], 'filter:last'],
  [['View', 'Proof Colors (CMYK)'], 'view:proof'],
  [['View', 'Show', 'Smart Guides'], 'view:smart-guides'],
  [['View', 'Pattern Preview'], 'view:pattern-preview'],
  ...[['Guides', 'guides'], ['Grid', 'grid'], ['Layers', 'layers'], ['Document Bounds', 'bounds'], ['Artboards', 'artboards'], ['Slices', 'slices'], ['All', 'all'], ['None', 'none']]
    .map(([label, arg]) => [['View', 'Snap To', label], 'view:snap-to', arg]),
  [['View', 'Guides', 'Lock Guides'], 'view:lock-guides'],
  [['View', 'Guides', 'Clear Canvas Guides'], 'view:clear-guides'],
  [['View', 'Guides', 'Clear Selected Artboard Guides'], 'view:clear-artboard-guides'],
  [['View', 'Guides', 'Clear Selected Guides'], 'view:clear-selected-guides'],
  [['View', 'Guides', 'New Guide…'], 'view:new-guide'],
  [['View', 'Guides', 'New Guide Layout…'], 'view:new-guide-layout'],
  [['View', 'Guides', 'New Guides From Shape'], 'view:guides-from-shape'],
  [['View', 'Guides', 'Edit Selected Guides…'], 'view:edit-selected-guides'],
  [['Window', 'Paragraph'], 'window:panel-paragraph'],
  [['Window', 'Gradients'], 'window:panel-gradients'],
  [['Window', 'Patterns'], 'window:panel-patterns'],
];

test('every item of M.2 and M.3 is present with its command and argument', () => {
  const all = commands();
  for (const [path, cmd, arg] of EXPECTED) {
    const hit = all.find((x) => x.path.join(' > ') === path.join(' > '));
    assert.ok(hit, `missing: ${path.join(' > ')}`);
    assert.equal(hit.cmd, cmd, path.join(' > '));
    assert.deepEqual(hit.arg, arg, path.join(' > '));
  }
  // the top-level New Guide… and Clear Guides moved into View > Guides; Merge Down's 0.3 item became layer:merge
  assert.ok(!all.some((x) => x.path.length === 2 && x.path[0] === 'View' && ['view:new-guide', 'view:clear-guides'].includes(x.cmd)));
  assert.ok(!all.some((x) => x.cmd === 'layer:merge-down'));
  // the Window order: Gradients and Patterns after Swatches, Paragraph after Character
  const win = all.filter((x) => x.path[0] === 'Window').map((x) => x.cmd);
  assert.deepEqual(win.slice(win.indexOf('window:panel-swatches'), win.indexOf('window:panel-swatches') + 3), ['window:panel-swatches', 'window:panel-gradients', 'window:panel-patterns']);
  assert.equal(win[win.indexOf('window:panel-character') + 1], 'window:panel-paragraph');
  // the new adjustment kinds follow Color Lookup after a separator
  const adj = build().find((m) => m.label === '&Image').submenu.find((m) => m.label === '&Adjustments').submenu;
  const iLookup = adj.findIndex((i) => i.label === 'Color Lookup…');
  assert.equal(adj[iLookup + 1].type, 'separator');
  assert.deepEqual(adj.slice(iLookup + 2, iLookup + 5).map((i) => i.label), ['Color and Vibrance…', 'Clarity and Dehaze…', 'Grain…']);
});

test('items whose command is a stub or a placeholder kind are disabled', () => {
  const all = commands('linux', { ...FULL, stubs: 'edit:search,layer:vector-mask' });
  for (const x of all.filter((y) => y.cmd === 'edit:search' || y.cmd === 'layer:vector-mask')) assert.equal(x.item.enabled, false, x.path.join(' > '));
  // a placeholder kind's items are disabled; once adjust-color makes the kind real they follow the layer state again
  const kindOf = (y) => (y.cmd === 'layer:new-adjustment' ? y.arg : y.cmd.replace(/^image:adjust-/, ''));
  for (const x of all.filter((y) => /^image:adjust-(color-vibrance|clarity-dehaze|grain)$/.test(y.cmd) || (y.cmd === 'layer:new-adjustment' && ['color-vibrance', 'clarity-dehaze', 'grain'].includes(y.arg)))) {
    assert.equal(x.item.enabled, !ADJUSTMENTS[kindOf(x)].placeholder, x.path.join(' > '));
  }
  // Rasterize kinds only for their layer kind
  const shape = commands('linux', { ...FULL, layerType: 'shape', hasVectorMask: false });
  const ras = (label) => shape.find((x) => x.path.join(' > ') === `Layer > Rasterize > ${label}`).item.enabled;
  assert.deepEqual(['Type', 'Shape', 'Fill Content', 'Vector Mask', 'Smart Object'].map(ras), [false, true, false, false, false]);
});

test('state labels: Merge Down / Merge Layers / Merge Group, Hide / Show All Effects', () => {
  const label = (state, path) => commands('linux', { ...FULL, ...state })
    .filter((x) => x.cmd === path).map((x) => x.path.at(-1));
  assert.deepEqual(label({ selectedCount: 1, layerType: 'raster' }, 'layer:merge'), ['Merge Down']);
  assert.deepEqual(label({ selectedCount: 3, layerType: 'raster' }, 'layer:merge'), ['Merge Layers']);
  assert.deepEqual(label({ selectedCount: 1, layerType: 'group' }, 'layer:merge'), ['Merge Group']);
  assert.deepEqual(label({ effectsHidden: false }, 'layer:style-toggle-all'), ['Hide All Effects']);
  assert.deepEqual(label({ effectsHidden: true }, 'layer:style-toggle-all'), ['Show All Effects']);
  // the Snap To checkmarks come from state.snapTo
  const snap = commands('linux', { ...FULL, snapTo: 'guides,layers' })
    .filter((x) => x.cmd === 'view:snap-to' && x.item.type === 'checkbox');
  assert.deepEqual(snap.filter((x) => x.item.checked).map((x) => x.arg), ['guides', 'layers']);
});

/** The key combination an accelerator stands for on a platform (CmdOrCtrl resolved). */
function combo(accel, platform) {
  const d = parseAccelerator(accel);
  const mac = platform === 'darwin';
  const ctrl = d.ctrl || (d.cmdOrCtrl && !mac);
  const meta = d.meta || (d.cmdOrCtrl && mac);
  return `${ctrl ? 'C' : ''}${meta ? 'M' : ''}${d.alt ? 'A' : ''}${d.shift ? 'S' : ''}+${d.key}`;
}

test('no accelerator is used twice in the template, on any platform and with any state', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const state of [FULL, { ...FULL, showGalleryInMenu: true }, {}]) {
      const seen = new Map();
      const walk = (list) => {
        for (const it of list) {
          if (it.submenu) walk(it.submenu);
          if (!it.accelerator) continue;
          const k = combo(it.accelerator, platform);
          assert.ok(!seen.has(k), `${platform}: ${it.accelerator} on "${it.label}" and "${seen.get(k)}"`);
          seen.set(k, it.label);
        }
      };
      walk(buildMenuTemplate({ platform, state, recent: [], run: () => {}, isPackaged: false }));
    }
  }
});

test('the macOS Settings item uses Cmd+K; Cmd+, is Hide / Show Layers; Keyboard Shortcuts… has its key in Edit only', () => {
  const t = build('darwin');
  const app = t.find((m) => m.label === 'Pigment').submenu.find((i) => i.label === 'Settings…');
  assert.equal(combo(app.accelerator, 'darwin'), 'M+k');
  const hide = commands('darwin').find((x) => x.cmd === 'layer:visibility');
  assert.equal(combo(hide.item.accelerator, 'darwin'), 'M+,');
  const sc = commands('darwin').filter((x) => x.cmd === 'help:shortcuts');
  assert.deepEqual(sc.map((x) => [x.path[0], !!x.item.accelerator]), [['Edit', true], ['Help', false]]);
});

test('a click reports whether the accelerator triggered it', () => {
  const ran = [];
  const t = buildMenuTemplate({ platform: 'win32', state: FULL, recent: [], run: (...a) => ran.push(a), isPackaged: false });
  let n = 0;
  const walk = (xs) => {
    for (const it of xs) {
      if (it.submenu) walk(it.submenu);
      else if (it.click && it.label !== 'No Recent Files') {
        n++;
        // Electron calls click(menuItem, focusedWindow, event); event.triggeredByAccelerator is true for a key
        it.click(it, null, { triggeredByAccelerator: true });
        it.click(it, null, undefined);
        it.click(it, null, { triggeredByAccelerator: false });
      }
    }
  };
  walk(t);
  assert.ok(n > 200, `items: ${n}`);
  assert.equal(ran.length, n * 3);
  for (let i = 0; i < ran.length; i += 3) assert.deepEqual([ran[i][2], ran[i + 1][2], ran[i + 2][2]], [true, false, false], ran[i][0]);
});
