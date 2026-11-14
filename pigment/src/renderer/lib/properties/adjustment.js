// Properties section 'adjustment' of an adjustment layer (ARCHITECTURE.md "0.4 features", L.1; owned by adjust-color):
// the toolbar (clip, view previous state, reset, visibility, delete) and the layer's editor inside the adjustment frame
// in panel mode (I.1): presets, eyedroppers and the on-image tool sampling the full-resolution composite below the
// layer, Auto computing from that composite. Edits are live and undoable, consecutive edits merging into one entry.
//
// While the layer, its kind and its params object stay the same (our own edits keep `params` identical), the section
// returns the element it built last time, so a drag in the editor survives the re-render setLayerProps causes.
//
// View previous state (Photoshop's button, and its "\" key while the panel has focus): shows the layer with the settings
// it had when it was selected, without a history entry, until pressed again, an edit, any command, or the section goes
// away.
import { icon } from '../icons.js';
import { buildAdjustmentEditor, adjustmentSource } from '../adjust-ui.js';
import { setLayerProps } from '../layer-ops.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { buildAdjustmentFrame, sampleBelow } from '../adjust/frame.js';
import { h, button } from './ui.js';
import { registerIcons } from '../icons.js';

registerIcons({
  'previous-state': '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
});

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** JSON with sorted keys: two params objects that hold the same settings give the same text. */
const canonical = (v) => JSON.stringify(v ?? null, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const FRAMES = new WeakMap(); // element -> { frame, end() }
/** The settings each adjustment layer had when the section first showed it (its "previous state"). */
const INITIAL = new WeakMap(); // layer -> { params, docVersion }

let built = null; // { element, toolbar, docId, layerId, kind, params }
let lastLayer = null;

function render(layer, doc, { app, keep }) {
  const same = keep(`${doc.id}:${layer.id}:${layer.kind}`) && built && built.params === layer.params;
  if (same) {
    built.toolbar.querySelector('[data-act="clip"]')?.classList.toggle('active', !!layer.clip);
    const eye = built.toolbar.querySelector('[data-act="eye"]');
    if (eye) eye.innerHTML = icon(layer.visible ? 'eye' : 'eye-off');
    return built.element;
  }
  // a layer selected anew starts a new "previous state"
  if (lastLayer !== layer || !INITIAL.has(layer)) INITIAL.set(layer, { params: clone(layer.params) });
  lastLayer = layer;
  const element = h('div', 'props-adjust-section');
  const toolbar = h('div', 'panel-toolbar props-adjust-bar');
  const tb = (act, ic, title, fn) => {
    const b = button('', ic, title, fn, { cls: 'pbtn' });
    b.dataset.act = act;
    toolbar.appendChild(b);
    return b;
  };
  const state = { element, toolbar, docId: doc.id, layerId: layer.id, kind: layer.kind, params: layer.params };
  // ---- view previous state (no history: the layer shows other params for a moment)
  let previewing = null; // { current } while the previous state is shown
  const endPrevious = () => {
    if (!previewing) return;
    const { current: cur, shown, unobserve } = previewing;
    previewing = null;
    unobserve?.();
    prevBtn.setAttribute('aria-pressed', 'false');
    prevBtn.classList.remove('active');
    // only while the layer still shows the previous state (an undo meanwhile replaced it: keep what the undo set)
    if (layer.params === shown) {
      layer.params = cur;
      state.params = cur;
      layer.touch();
      doc.changed('props', { layer });
    }
  };
  const startPrevious = () => {
    const init = INITIAL.get(layer)?.params;
    if (!init || previewing) return;
    const shown = clone(init);
    // the previous state is a display only: any command (Save, Duplicate, Merge, Undo...) first puts the layer's own
    // settings back, so it never saves, copies or merges the settings that are only being shown
    const offCommand = app.commands?.observe?.({ before: () => endPrevious() });
    const offSaving = app.on?.('doc:saving', () => endPrevious()); // a save outside a command (the quit prompt)
    const unobserve = () => {
      offCommand?.();
      offSaving?.();
    };
    previewing = { current: layer.params, shown, unobserve };
    prevBtn.setAttribute('aria-pressed', 'true');
    prevBtn.classList.add('active');
    state.params = shown; // keep this element through the re-render
    layer.params = shown;
    layer.touch();
    doc.changed('props', { layer });
  };
  tb('clip', 'link', 'Clip to the layer below (only it is affected)', () => app.commands.run('layer:clip', undefined, 'panel')).classList.toggle('active', !!layer.clip);
  const prevBtn = tb('previous', 'previous-state', 'View previous state (\\)', () => (previewing ? endPrevious() : startPrevious()));
  prevBtn.setAttribute('aria-pressed', 'false');
  tb('reset', 'refresh', 'Reset to adjustment defaults', () => {
    endPrevious();
    setLayerProps(app, layer, { params: clone(ADJUSTMENTS[layer.kind]?.defaults ?? {}) }, `Reset ${layer.name}`);
  });
  tb('eye', layer.visible ? 'eye' : 'eye-off', 'Toggle layer visibility', () => app.commands.run('layer:visibility', layer.id, 'panel'));
  toolbar.appendChild(h('span', 'props-spacer'));
  tb('delete', 'trash', 'Delete this adjustment layer', () => {
    endPrevious();
    app.commands.run('layer:delete', undefined, 'panel');
  });
  element.appendChild(toolbar);
  element.tabIndex = -1;
  element.addEventListener('keydown', (e) => {
    if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey || e.target?.matches?.('input, select, textarea')) return;
    e.preventDefault();
    if (previewing) endPrevious();
    else startPrevious();
  });
  let source = null;
  try {
    if (layer.kind === 'levels' || layer.kind === 'curves') source = adjustmentSource(app, layer);
  } catch (err) {
    console.warn('adjustment histogram unavailable', err);
  }
  // Auto of the other kinds computes from the composite below on demand (it costs a composite)
  const autoSource = () => {
    if (source) return source;
    try {
      return adjustmentSource(app, layer);
    } catch {
      return null;
    }
  };
  let frame = null;
  // Only a run of this section's own continuous edits (a drag, typing) merges into one entry: not into a Reset or
  // another entry on top, and an eyedropper pick, a preset or Auto (`discrete`) is a step of its own
  // A run that ends where it began (a value typed and taken back with Escape) leaves no entry: `run` is the history
  // as it was before the run's entry and the params it started from
  let lastEdit = null, discrete = false, run = null;
  const commit = (params, label = `Edit ${layer.name}`) => {
    if (app.doc !== doc || doc.active !== layer) return;
    endPrevious();
    const top = doc.history.entries[doc.history.index];
    const start = { mark: doc.history.mark(), params: canonical(layer.params) };
    setLayerProps(app, layer, { params: clone(params) }, label, { merge: !discrete && !!lastEdit && top === lastEdit });
    const now = doc.history.entries[doc.history.index];
    if (now !== top) run = discrete ? null : start;
    else if (run && canonical(layer.params) === run.params) {
      doc.history.rollback(run.mark); // the layer already holds the params of before the run
      run = null;
    }
    lastEdit = discrete || now !== doc.history.entries[doc.history.index] ? null : now;
    discrete = false;
    state.params = layer.params; // our own edit: keep the editor (and the user's drag) alive
    frame?.paramsChanged?.(params);
  };
  const editor = buildAdjustmentEditor(layer.kind, layer.params, (params) => commit(params), { source, app });
  frame = buildAdjustmentFrame(app, layer.kind, editor, {
    mode: 'panel',
    sample: sampleBelow(app, layer),
    source: autoSource,
    getParams: () => clone(layer.params),
    onDiscrete: () => {
      discrete = true; // an eyedropper pick: its edit is a step of its own
    },
    setParams: (params) => {
      editor.setParams?.(params);
      discrete = true;
      commit(params);
      if (!editor.setParams) state.params = null; // the editor cannot show new params: rebuild it on the next render
    },
    onReset: () => {
      endPrevious();
      setLayerProps(app, layer, { params: clone(ADJUSTMENTS[layer.kind]?.defaults ?? {}) }, `Reset ${layer.name}`);
    },
  });
  const body = h('div', 'props-adjust');
  body.appendChild(frame.element);
  element.appendChild(body);
  FRAMES.set(element, { frame, end: endPrevious });
  built = state;
  return element;
}

export const adjustmentSection = {
  id: 'adjustment',
  order: 10,
  region: 'main',
  test: (layer) => layer?.type === 'adjustment',
  // 0.3 rebuilt the editor when the params changed from elsewhere (an undo) even while a field had focus
  keepWhileTyping: false,
  render,
  dispose(element) {
    const f = FRAMES.get(element);
    // the previous state is only shown: put the layer's own settings back before the section goes
    f?.end?.();
    f?.frame?.dispose();
    FRAMES.delete(element);
    if (built?.element === element) built = null;
  },
};
