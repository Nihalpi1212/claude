// The Adjustments panel's adjustment presets (adjust-color; Photoshop's "Adjustment Presets": Portraits, Landscape,
// Photo Repair, Creative, Black & White, Cinematic). A preset adds one or more adjustment layers above the active layer
// in one undo step; several layers go into a group named after the preset. Each layer gets a mask: the selection, or
// one that shows everything. Through the command `layer:adjustment-preset` (arg: '<group>/<preset>' or, as an action
// records nothing else, the same string), so actions record it.
import { AdjustmentLayer, GroupLayer, createCanvas, copyCanvas } from '../document.js';
import { structural } from '../layer-ops.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { ADJUSTMENT_PANEL_PRESETS } from '../adjust/color-formats.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The preset of an id '<group>/<preset>', or null. */
export function adjustmentPanelPreset(id) {
  const [g, p] = String(id ?? '').split('/');
  return ADJUSTMENT_PANEL_PRESETS.find((x) => x.id === g)?.presets.find((x) => x.id === p) ?? null;
}

function maskFor(d) {
  if (d.selection && !d.selection.isEmpty) return copyCanvas(d.selection.toCanvas());
  const c = createCanvas(d.width, d.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, d.width, d.height);
  return c;
}

/** Adds the layers of a preset (undoable, one step). Returns the new top layer or group, or null. */
export function addAdjustmentPanelPreset(app, preset) {
  const d = app.doc;
  if (!d || !preset?.layers?.length) return null;
  const layers = preset.layers.map((l) => {
    const def = app.adjustments?.[l.kind] ?? { name: ADJUSTMENTS[l.kind]?.name, defaults: ADJUSTMENTS[l.kind]?.defaults };
    const layer = new AdjustmentLayer({ name: l.name ?? def.name ?? l.kind, kind: l.kind, params: { ...clone(def.defaults ?? {}), ...clone(l.params ?? {}) } });
    layer.mask = { canvas: maskFor(d), enabled: true, linked: true };
    return layer;
  });
  let top = null;
  structural(app, `Adjustment preset: ${preset.name}`, () => {
    if (layers.length === 1) {
      d.add(layers[0]);
      top = layers[0];
    } else {
      const g = new GroupLayer({ name: preset.name });
      d.add(g);
      for (const l of layers) d.add(l, g, g.children.length);
      top = g;
    }
    d.setActive(top);
  });
  return top;
}

/** The command (registered by lib/adjust/color.js). */
export function adjustmentPresetCommand(app) {
  return {
    enabled: () => !!app.doc,
    label: 'Adjustment Preset',
    run: (arg, ctx) => {
      const preset = adjustmentPanelPreset(arg);
      if (!preset) {
        ctx?.cancel?.();
        return app.dialogs.toast('Unknown adjustment preset', { kind: 'error' });
      }
      addAdjustmentPanelPreset(app, preset);
    },
  };
}

/**
 * The panel section: one collapsible group per preset group, a button per preset ([data-preset="group/id"]) whose
 * tooltip lists the layers it adds. Open groups are remembered for the session.
 */
export function adjustmentPresetsSection(app) {
  const root = document.createElement('div');
  root.className = 'adjustment-presets';
  const head = document.createElement('div');
  head.className = 'panel-hint muted';
  head.textContent = 'Adjustment presets';
  root.appendChild(head);
  for (const group of ADJUSTMENT_PANEL_PRESETS) {
    const det = document.createElement('details');
    det.className = 'adjust-preset-group';
    det.dataset.group = group.id;
    const sum = document.createElement('summary');
    sum.textContent = group.name;
    det.appendChild(sum);
    const list = document.createElement('div');
    list.className = 'adjust-preset-list';
    for (const p of group.presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'adjust-preset';
      b.dataset.preset = `${group.id}/${p.id}`;
      b.textContent = p.name;
      b.title = `Adds: ${p.layers.map((l) => ADJUSTMENTS[l.kind]?.name ?? l.kind).join(', ')}`;
      b.addEventListener('click', () => app.commands.run('layer:adjustment-preset', `${group.id}/${p.id}`, 'panel'));
      list.appendChild(b);
    }
    det.appendChild(list);
    root.appendChild(det);
  }
  return root;
}
