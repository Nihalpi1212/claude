// Properties section 'adjustment' of an adjustment layer (ARCHITECTURE.md "0.4 features", L.1): the toolbar (clip,
// reset, visibility, delete) and the layer's editor inside the adjustment frame in panel mode (I.1), sampling the
// full-resolution composite below the layer. Edits are live and undoable, consecutive edits merging into one entry.
// Moved out of panels/properties.js by the 0.4 skeleton, unchanged in output; owned by adjust-color afterwards.
//
// While the layer, its kind and its params object stay the same (our own edits keep `params` identical), the section
// returns the element it built last time, so a drag in the editor survives the re-render setLayerProps causes.
import { icon } from '../icons.js';
import { buildAdjustmentEditor, adjustmentSource } from '../adjust-ui.js';
import { setLayerProps } from '../layer-ops.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { buildAdjustmentFrame, sampleBelow } from '../adjust/frame.js';
import { h, button } from './ui.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const FRAMES = new WeakMap(); // element -> frame

let built = null; // { element, toolbar, docId, layerId, kind, params }

function render(layer, doc, { app, keep }) {
  const same = keep(`${doc.id}:${layer.id}:${layer.kind}`) && built && built.params === layer.params;
  if (same) {
    built.toolbar.querySelector('[data-act="clip"]')?.classList.toggle('active', !!layer.clip);
    const eye = built.toolbar.querySelector('[data-act="eye"]');
    if (eye) eye.innerHTML = icon(layer.visible ? 'eye' : 'eye-off');
    return built.element;
  }
  const element = h('div', 'props-adjust-section');
  const toolbar = h('div', 'panel-toolbar props-adjust-bar');
  const tb = (act, ic, title, fn) => {
    const b = button('', ic, title, fn, { cls: 'pbtn' });
    b.dataset.act = act;
    toolbar.appendChild(b);
    return b;
  };
  tb('clip', 'link', 'Clip to the layer below (only it is affected)', () => app.commands.run('layer:clip', undefined, 'panel')).classList.toggle('active', !!layer.clip);
  tb('reset', 'refresh', 'Reset to adjustment defaults', () => {
    setLayerProps(app, layer, { params: clone(ADJUSTMENTS[layer.kind]?.defaults ?? {}) }, `Reset ${layer.name}`);
  });
  tb('eye', layer.visible ? 'eye' : 'eye-off', 'Toggle layer visibility', () => app.commands.run('layer:visibility', layer.id, 'panel'));
  toolbar.appendChild(h('span', 'props-spacer'));
  tb('delete', 'trash', 'Delete this adjustment layer', () => app.commands.run('layer:delete', undefined, 'panel'));
  element.appendChild(toolbar);
  let source = null;
  try {
    if (layer.kind === 'levels' || layer.kind === 'curves') source = adjustmentSource(app, layer);
  } catch (err) {
    console.warn('adjustment histogram unavailable', err);
  }
  const state = { element, toolbar, docId: doc.id, layerId: layer.id, kind: layer.kind, params: layer.params };
  const commit = (params, label = `Edit ${layer.name}`) => {
    if (app.doc !== doc || doc.active !== layer) return;
    setLayerProps(app, layer, { params: clone(params) }, label, { merge: true });
    state.params = layer.params; // our own edit: keep the editor (and the user's drag) alive
  };
  const editor = buildAdjustmentEditor(layer.kind, layer.params, (params) => commit(params), { source });
  const frame = buildAdjustmentFrame(app, layer.kind, editor, {
    mode: 'panel',
    sample: sampleBelow(app, layer),
    source,
    getParams: () => clone(layer.params),
    setParams: (params) => {
      editor.setParams?.(params);
      commit(params);
      if (!editor.setParams) state.params = null; // the editor cannot show new params: rebuild it on the next render
    },
    onReset: () => setLayerProps(app, layer, { params: clone(ADJUSTMENTS[layer.kind]?.defaults ?? {}) }, `Reset ${layer.name}`),
  });
  const body = h('div', 'props-adjust');
  body.appendChild(frame.element);
  element.appendChild(body);
  FRAMES.set(element, frame);
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
    FRAMES.get(element)?.dispose();
    FRAMES.delete(element);
    if (built?.element === element) built = null;
  },
};
