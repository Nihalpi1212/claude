// Select > Subject, Sky, Focus Area…, Select and Mask… and the Object Selection tool (see
// ARCHITECTURE.md "Select Subject, Sky, Focus Area, Select and Mask").
//
//   select:subject       the most salient object of the layer becomes the selection
//   select:sky           the sky of the layer becomes the selection
//   select:focus-area    dialog: In-Focus Range (with Auto), Image Noise Level, Soften Edge, Output To;
//                        "Select and Mask…" hands the result to the workspace
//   select:select-mask   the Select and Mask workspace (select-mask/workspace.js)
//   tool:object-select   the Object Selection tool in the wand slot (tools/object-select.js)
//
// The pixel work is src/shared/pixels/segment.js and matte.js. It runs in a module worker
// (select-mask/engine.js): a step takes 0.3 - 2.5 s on a 2000 x 1500 layer. Every result goes
// through app.applySelection or select-mask/output.js, so it is one undoable history entry, and the
// dialog commands name the argument that replays them without a dialog (actions).
import { formDialog } from './form.js';
import { Selection } from './selection.js';
import { segmentEngine } from './select-mask/engine.js';
import { sourceImage, outputMask, maskOfLayer, constrainPixels, OUTPUTS, PIXEL_OUTPUTS, isOutput } from './select-mask/output.js';
import { MaskPreview } from './select-mask/preview.js';
import { installWorkspace, normaliseRefine, refineOptions, changesMask } from './select-mask/workspace.js';
import { registerObjectSelect } from './tools/object-select.js';

const NOISE_LEVELS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
/** The views the Focus Area dialog offers (the canvas shows them behind the dialog). */
const FOCUS_VIEWS = [['overlay', 'Overlay'], ['black', 'On Black'], ['white', 'On White'], ['bw', 'Black & White'], ['onion', 'Onion Skin'], ['none', 'None']];
const FOCUS_DEFAULTS = Object.freeze({ range: 50, autoRange: true, noise: 'auto', soften: true, output: 'selection' });

const anySelected = (mask) => {
  for (let p = 0; p < mask.length; p++) if (mask[p]) return true;
  return false;
};

export function install(app) {
  const engine = segmentEngine();
  const workspace = installWorkspace(app, engine);
  const objectTool = registerObjectSelect(app);
  /** Milliseconds the last run of each step took in the engine (shown in the status bar; tests and reports read it). */
  const timings = {};
  let working = false;

  const hasLayer = () => !!app.doc?.active && !working && !workspace.session;
  const hasDoc = () => !!app.doc && !working && !workspace.session;

  // ---- Select Subject / Select Sky ----------------------------------------------------------------------------

  /** One-step selections: the mask of `op` replaces the selection. Resolves true when something was selected. */
  async function autoSelect(op, label, nothing, arg) {
    const doc = app.doc;
    if (!doc || working) return false;
    working = true;
    try {
      const src = sourceImage(app, { sampleAll: !!arg?.sampleAll });
      const res = await app.busy(`${label}…`, () => engine.once(op, src.img, { hardEdge: !!arg?.hardEdge }));
      timings[op] = res.ms;
      if (app.doc !== doc || res.mask.length !== doc.width * doc.height) return false;
      const sel = Selection.fromMask(doc.width, doc.height, res.mask);
      if (sel.isEmpty) {
        app.dialogs.toast(nothing, { timeout: 3000 });
        return false;
      }
      app.applySelection(sel, 'replace', label);
      app.statusbar.set('hint', `${label}: ${sel.bounds.width} × ${sel.bounds.height} px in ${Math.round(res.ms)} ms`);
      return true;
    } finally {
      working = false;
      app.commands.invalidate();
    }
  }

  // ---- Focus Area ----------------------------------------------------------------------------------------------

  const focusArgs = (v) => ({ range: v.range, autoRange: !!v.autoRange, noise: v.noise, hardEdge: !v.soften });
  function normaliseFocus(arg) {
    const v = { ...FOCUS_DEFAULTS };
    if (arg && typeof arg === 'object') {
      if (Number.isFinite(+arg.range)) {
        v.range = Math.max(0, Math.min(100, +arg.range));
        v.autoRange = false;
      }
      if ('autoRange' in arg) v.autoRange = !!arg.autoRange;
      if (NOISE_LEVELS.some(([id]) => id === arg.noise)) v.noise = arg.noise;
      if ('soften' in arg) v.soften = !!arg.soften;
      if (isOutput(arg.output)) v.output = arg.output;
    }
    return v;
  }

  /**
   * Select > Focus Area…. With an argument ({ range, autoRange, noise, soften, output }) it runs without
   * the dialog (actions); the dialog reports the values it ended with as that argument.
   */
  async function focusArea(arg, ctx) {
    const doc = app.doc;
    if (!doc || working) return null;
    working = true;
    const src = sourceImage(app);
    const key = engine.addImage(src.img);
    let preview = null;
    try {
      if (arg && typeof arg === 'object') {
        const v = normaliseFocus(arg);
        const res = await app.busy('Focus Area…', () => engine.run('focus', key, focusArgs(v)));
        timings.focus = res.ms;
        if (app.doc !== doc) return null;
        if (!anySelected(res.mask)) app.dialogs.toast('Nothing in this layer is in focus at that range', { timeout: 3000 });
        return outputMask(app, { mask: res.mask, output: v.output, label: 'Focus Area', source: src });
      }

      const remembered = normaliseFocus(app.settings.tools?.['focus-area']);
      const viewPref = app.settings.tools?.['focus-area']?.view;
      const start = { ...remembered, view: FOCUS_VIEWS.some(([id]) => id === viewPref) ? viewPref : 'overlay' };
      if (!doc.active) start.output = 'selection';
      preview = new MaskPreview(app, doc, { layer: doc.active });
      const showView = (view) => preview.set({ enabled: view !== 'none', view: view === 'none' ? 'overlay' : view, opacity: view === 'overlay' ? 50 : 100, onion: 75 });
      showView(start.view);
      preview.setMask(new Uint8ClampedArray(doc.width * doc.height));

      // latest request wins: the slider keeps moving while the worker cuts
      const state = { running: false, queued: false, closed: false, result: null, waiters: [] };
      let form = null, info = null;
      const compute = async () => {
        if (state.running) {
          state.queued = true;
          return;
        }
        state.running = true;
        try {
          do {
            state.queued = false;
            const v = { ...form.values };
            const res = await engine.run('focus', key, focusArgs(v));
            timings.focus = res.ms;
            if (state.closed) break;
            state.result = { mask: res.mask, range: res.range, values: v };
            preview.setMask(res.mask);
            // Auto shows the range it picked
            if (v.autoRange && form.values.autoRange && form.values.range !== res.range) form.set('range', res.range, { silent: true });
            if (info) info.textContent = anySelected(res.mask) ? `In-focus area found in ${Math.round(res.ms)} ms` : 'Nothing is in focus at this range';
          } while (state.queued && !state.closed);
        } catch (err) {
          app.reportError(err, 'Focus Area failed');
        } finally {
          state.running = false;
          for (const w of state.waiters.splice(0)) w();
        }
      };
      const settled = () => (state.running ? new Promise((resolve) => state.waiters.push(resolve)) : Promise.resolve());

      const values = await formDialog(app, {
        title: 'Focus Area',
        width: 420,
        className: 'focus-area-dialog',
        okLabel: 'OK',
        values: start,
        fields: [
          { key: 'view', label: 'View', type: 'select', options: FOCUS_VIEWS },
          { type: 'section', label: 'Parameters' },
          { key: 'range', label: 'In-Focus Range', type: 'slider', min: 0, max: 100, step: 1, help: 'Higher values keep only the sharpest areas.' },
          { key: 'autoRange', label: 'Auto', type: 'checkbox' },
          { key: 'noise', label: 'Image Noise Level', type: 'select', options: NOISE_LEVELS },
          { type: 'section', label: 'Output' },
          { key: 'soften', label: 'Soften Edge', type: 'checkbox' },
          { key: 'output', label: 'Output To', type: 'select', options: doc.active ? OUTPUTS : OUTPUTS.slice(0, 1) },
        ],
        extra: () => {
          info = document.createElement('p');
          info.className = 'muted focus-area-info';
          info.textContent = 'Finding the area in focus…';
          return info;
        },
        buttons: [
          { label: 'Select and Mask…', value: 'refine' },
          { label: 'Cancel', value: null },
          { label: 'OK', value: true, primary: true },
        ],
        onChange: (v, changedKey, f) => {
          if (changedKey === 'view') return showView(v.view);
          // moving the slider is a manual choice
          if (changedKey === 'range' && v.autoRange) f.set('autoRange', false, { silent: true });
          if (changedKey !== 'output') compute();
        },
        onOpen: (_dialog, f) => {
          form = f;
          compute();
        },
        // OK waits for the cut of the final values
        validate: async () => {
          await settled();
          return true;
        },
      });
      state.closed = true;
      await settled();
      preview.destroy();
      preview = null;
      if (!values || !state.result || app.doc !== doc) {
        ctx?.cancel();
        return null;
      }
      const v = state.result.values;
      const replay = { range: state.result.range, autoRange: false, noise: v.noise, soften: !!v.soften, output: values.output };
      app.tools.setOpt('focus-area', 'view', values.view, { silent: true });
      for (const k of ['autoRange', 'noise', 'soften', 'output']) app.tools.setOpt('focus-area', k, values[k], { silent: true });
      if (!values.autoRange) app.tools.setOpt('focus-area', 'range', values.range, { silent: true });
      const mask = state.result.mask;
      if (values.__button === 'refine') {
        engine.dropImage(key);
        working = false;
        ctx?.cancel(); // what the workspace does is its own step
        return app.commands.run('select:select-mask', { interactive: true, mask, output: values.output }, 'api');
      }
      ctx?.setReplayArg(replay);
      if (!anySelected(mask)) app.dialogs.toast('Nothing in this layer is in focus at that range', { timeout: 3000 });
      return outputMask(app, { mask, output: values.output, label: 'Focus Area', source: src });
    } finally {
      preview?.destroy();
      engine.dropImage(key);
      working = false;
      app.commands.invalidate();
    }
  }

  // ---- Select and Mask ------------------------------------------------------------------------------------------

  /**
   * The refinement of the current selection (or the layer's mask) with recorded settings, without the
   * workspace: what an action replays. Tool strokes made in the workspace are not part of it.
   */
  async function refineDirect(arg) {
    const doc = app.doc;
    if (!doc || working) return null;
    const layer = doc.active;
    const params = normaliseRefine(arg);
    const hasSel = !!doc.selection && !doc.selection.isEmpty;
    const base = hasSel ? new Uint8ClampedArray(doc.selection.mask) : layer?.mask?.canvas ? maskOfLayer(doc, layer) : null;
    if (!base) {
      app.dialogs.toast('Make a selection first', { kind: 'error' });
      return null;
    }
    working = true;
    const src = sourceImage(app, { sampleAll: !!arg.sampleAll });
    const key = engine.addImage(src.img);
    try {
      return await app.busy('Select and Mask…', async () => {
        let mask = base;
        if (changesMask(params)) {
          const res = await engine.run('refine', key, { mask: base, options: refineOptions(params) });
          timings.refine = res.ms;
          mask = res.mask;
        }
        let pixels = null;
        if (params.decontaminate && PIXEL_OUTPUTS.has(params.output)) pixels = constrainPixels(app, doc, layer, (await engine.run('decontaminate', key, { alpha: mask, amount: params.amount / 100 })).data);
        if (app.doc !== doc) return null;
        return outputMask(app, { mask, output: params.output, label: 'Select and Mask', source: src, pixels });
      });
    } finally {
      engine.dropImage(key);
      working = false;
      app.commands.invalidate();
    }
  }

  async function selectAndMask(arg, ctx) {
    if (arg && typeof arg === 'object' && !arg.interactive) return refineDirect(arg);
    const result = await workspace.open({ mask: arg?.mask, params: arg ? { output: arg.output, ...(arg.params ?? {}) } : undefined });
    if (!result) {
      ctx?.cancel();
      return null;
    }
    ctx?.setReplayArg({ ...result.params });
    return result;
  }

  app.commands.registerAll({
    'select:subject': { enabled: hasLayer, run: (arg) => autoSelect('subject', 'Select Subject', 'No subject stands out in this layer', arg), label: 'Subject' },
    'select:sky': { enabled: hasLayer, run: (arg) => autoSelect('sky', 'Select Sky', 'No sky found in this layer', arg), label: 'Sky' },
    'select:focus-area': { enabled: hasLayer, dialog: true, run: (arg, ctx) => focusArea(arg, ctx), label: 'Focus Area…' },
    'select:select-mask': { enabled: hasDoc, dialog: true, run: (arg, ctx) => selectAndMask(arg, ctx), label: 'Select and Mask…' },
  });

  /** For other modules and tests: the workspace's state and the engine's timings. */
  app.selectMask = {
    engine,
    timings,
    objectTool,
    get active() {
      return !!workspace.session;
    },
    get tool() {
      return workspace.session?.tool ?? null;
    },
    /** Refinement settings plus the view of the open workspace (a copy). */
    get params() {
      return workspace.session ? { ...workspace.formValues() } : null;
    },
    get busy() {
      const s = workspace.session;
      return !!s && (s.refine.stale || s.refine.running || s.applying || !!s.working);
    },
    open: (opts) => workspace.open(opts ?? {}),
    set: (key, value) => workspace.setParam(key, value),
    setTool: (id) => workspace.setTool(id),
    selectSubject: () => workspace.selectSubject(),
    clear: () => workspace.clear(),
    invert: () => workspace.invert(),
    reset: () => workspace.reset(),
    undo: () => workspace.undo(),
    redo: () => workspace.redo(),
    whenIdle: () => workspace.idle(),
    ok: () => workspace.commit(),
    cancel: () => workspace.cancel({ force: true }),
    /** The mask the workspace shows (a copy), or null. */
    mask: () => (workspace.session ? new Uint8ClampedArray(workspace.session.refined ?? workspace.session.base) : null),
    /** Numbers about the shown mask: selected pixels (>= 128), partly selected pixels and its bounds. */
    stats() {
      const s = workspace.session;
      if (!s) return null;
      const m = s.refined ?? s.base;
      let selected = 0, soft = 0, x0 = s.W, y0 = s.H, x1 = -1, y1 = -1;
      for (let p = 0; p < m.length; p++) {
        const v = m[p];
        if (!v) continue;
        if (v >= 128) selected++;
        if (v < 255) soft++;
        const x = p % s.W, y = (p - x) / s.W;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      return { selected, soft, bounds: x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, refineMs: s.refine.ms, refines: s.refine.count, engine: engine.mode, undo: s.undo.length };
    },
  };
}
