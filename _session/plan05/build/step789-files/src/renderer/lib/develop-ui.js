// Filter › Camera Raw Filter… (see ARCHITECTURE.md "0.2 features: Camera Raw filter" and "0.5 features", S8.3).
// A pixel edit dialog (live preview on the canvas, limited to the selection) whose tabs and sections come from the
// Camera Raw registry (lib/develop/registry.js; 0.4's Basic, Detail, HSL and Effects are the builtins of
// lib/develop/tabs-04.js) over the develop stages of src/shared/pixels/develop.js. "Auto" derives a tone patch from
// the histogram (autoTone, the Auto Levels / Auto Contrast clipping logic), "Reset" returns every control to its
// neutral value. OK records one "Camera Raw" history entry; on a smart layer the smart-object module turns it into a
// smart filter through app.smartFilters (E55: a kind may bring its own `open`).
//
// 0.5 (skeleton; camera-raw-workspace owns this file afterwards and keeps this DOM and the session preview): the root
// `.camera-raw` inside a `.dialog`, `button[data-action="auto"|"reset"]`, tabs `.dialog-tab[data-tab=<id>]`, number
// inputs `input[type="number"][data-key=<param path>]`. When an active stage's margin becomes Infinity (it needs the
// whole layer) the dialog restarts its pixel session with ignoreSelection and the selection masks the result. Source
// 'action' or 'repeat' (Last Filter, S12.4) with params applies them without UI; any other source with params opens
// the dialog prefilled.
import { develop, developDefaults, developMargin, autoTone } from '../../shared/pixels/develop.js';
import { buildForm, frameThrottle } from './form.js';
import { getPath, setPath, beginPixelEdit, processed } from './adjust-ui.js';
import { developTabs, developTools, createFakeWorkspace } from './develop/registry.js';
import './develop/tabs-04.js'; // 0.4's four tabs (builtins)

const LABEL = 'Camera Raw';
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 0.4's fixed margin: clarity / sharpening / noise reduction read around each pixel, so a selection's edge blends. */
const BASE_MARGIN = 48;
const MAX_MARGIN = 400;

/** The session margin for these params: 0.4's 48 px, more for a stage that reads further, Infinity for the whole layer. */
function marginFor(params, w = 0, h = 0) {
  const m = developMargin(params, w, h);
  return m === Infinity ? Infinity : Math.min(MAX_MARGIN, Math.max(BASE_MARGIN, Math.ceil(m)));
}

/** Smart filter padding (lib/smart-object.js): how far the develop spreads; a whole-layer stage spreads no further. */
const paddingFor = (params) => {
  const m = marginFor(params);
  return m === Infinity ? BASE_MARGIN : m;
};

/**
 * Builds the tabbed editor from the registry: { element, set(params), get() }. `session` (the pixel edit, or a
 * getter for it) and `app` reach the sections' render / test ctx; the tools of the registry get a strip in the bar
 * and a DevelopWorkspace stand-in (createFakeWorkspace) over the session's pixels. Pointer input on the canvas goes
 * to tools from camera-raw-workspace's workspace, not from this dialog.
 */
export function developEditor(start, onChange, { onAuto = null, app = null, session = null } = {}) {
  let current = clone(start);
  const sessionOf = () => (typeof session === 'function' ? session() : session);
  const element = document.createElement('div');
  element.className = 'camera-raw';

  // toolbar: Auto / Reset (inside the editor so they do not close the dialog)
  const bar = document.createElement('div');
  bar.className = 'camera-raw-bar';
  bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin:0 0 10px';
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'btn';
  autoBtn.textContent = 'Auto';
  autoBtn.dataset.action = 'auto';
  autoBtn.hidden = !onAuto; // no source pixels to analyse (smart filter re-edit)
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn';
  resetBtn.textContent = 'Reset';
  resetBtn.dataset.action = 'reset';

  const forms = []; // { form, fields }
  const guarded = []; // { el, section } sections with a test(ctx)
  const sync = () => {
    for (const { form, fields } of forms) for (const f of fields) if (f.key) form.set(f.key, getPath(current, f.key) ?? 0, { silent: true });
    for (const g of guarded) g.el.hidden = !testSection(g.section);
  };
  const changed = () => {
    for (const g of guarded) g.el.hidden = !testSection(g.section);
    onChange(clone(current));
  };
  const ctx = {
    get params() {
      return clone(current);
    },
    get: (path) => getPath(current, path),
    set(path, value) {
      setPath(current, path, value);
      sync();
      changed();
    },
    app,
    get session() {
      return sessionOf();
    },
    workspace: null,
  };
  function testSection(section) {
    try {
      return section.test(ctx) !== false;
    } catch (err) {
      console.error(err);
      return true;
    }
  }

  // tools of the registry (none among 0.4's builtins, so 0.4's bar is unchanged until a package registers one)
  const tools = developTools();
  let workspace = null;
  if (tools.length) {
    const s = sessionOf();
    workspace = createFakeWorkspace(current, s?.base ?? null, {
      origin: s?.rect ? { x: s.rect.x, y: s.rect.y } : { x: 0, y: 0 },
      onSet: (path, value) => ctx.set(path, value),
    });
    Object.defineProperty(workspace, 'params', { get: () => clone(current), set: () => {} });
    ctx.workspace = workspace;
    const strip = document.createElement('div');
    strip.className = 'camera-raw-tools';
    strip.setAttribute('role', 'toolbar');
    strip.style.cssText = 'display:flex;gap:4px;margin-right:auto';
    const buttons = [];
    for (const tool of tools) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn camera-raw-tool';
      b.dataset.tool = tool.id;
      b.title = tool.key ? `${tool.label} (${tool.key})` : tool.label;
      b.textContent = tool.label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        const prev = tools.find((t) => t.id === workspace.activeTool);
        prev?.deactivate?.(workspace);
        workspace.activeTool = prev?.id === tool.id ? null : tool.id;
        if (workspace.activeTool) tool.activate?.(workspace);
        for (const x of buttons) x.setAttribute('aria-pressed', String(x.dataset.tool === workspace.activeTool));
      });
      buttons.push(b);
      strip.appendChild(b);
    }
    bar.appendChild(strip);
  }
  bar.append(autoBtn, resetBtn);
  element.appendChild(bar);

  const tabBar = document.createElement('div');
  tabBar.className = 'dialog-tabs';
  tabBar.setAttribute('role', 'tablist');
  element.appendChild(tabBar);
  const pages = document.createElement('div');
  pages.className = 'camera-raw-pages';
  element.appendChild(pages);

  const makeForm = (fields) => {
    const values = {};
    for (const f of fields) if (f.key) values[f.key] = getPath(current, f.key) ?? 0;
    const form = buildForm(fields, {
      values,
      app,
      onChange: (v, key) => {
        setPath(current, key, v[key]);
        changed();
      },
    });
    forms.push({ form, fields });
    return form;
  };
  // The sections of a tab (or of one mode of it) as elements. Consecutive plain sections share one form, their
  // labels as headings, which is 0.4's DOM exactly; a section that renders itself or has a test gets its own box.
  const buildSections = (sections, mode) => {
    const out = [];
    let pending = [];
    const flush = () => {
      if (pending.length) out.push(makeForm(pending).element);
      pending = [];
    };
    for (const section of sections) {
      const fields = typeof section.fields === 'function' ? section.fields(mode) : section.fields ?? [];
      const heading = section.label ? [{ type: 'section', label: section.label }] : [];
      if (!section.render && !section.test) {
        pending.push(...heading, ...fields);
        continue;
      }
      flush();
      const box = document.createElement('div');
      box.className = 'camera-raw-section';
      box.dataset.section = section.id;
      if (section.render) {
        if (section.label) {
          const h = document.createElement('div');
          h.className = 'section';
          h.textContent = section.label;
          box.appendChild(h);
        }
        try {
          const el = section.render(ctx);
          if (el) box.appendChild(el);
        } catch (err) {
          console.error(err);
        }
        if (fields.length) box.appendChild(makeForm(fields).element);
      } else box.appendChild(makeForm([...heading, ...fields]).element);
      if (section.test) {
        guarded.push({ el: box, section });
        box.hidden = !testSection(section);
      }
      out.push(box);
    }
    flush();
    return out;
  };

  const pageEls = [];
  for (const tab of developTabs()) {
    if (!tab.sections.length) continue;
    const page = document.createElement('div');
    page.className = 'camera-raw-page';
    page.dataset.tab = tab.id;
    page.hidden = true;
    if (tab.modes?.length) {
      const seg = document.createElement('div');
      seg.className = 'opt-segment';
      seg.setAttribute('role', 'radiogroup');
      seg.style.marginBottom = '10px';
      const modeEls = [];
      for (const mode of tab.modes) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-button';
        b.dataset.mode = mode;
        b.textContent = mode[0].toUpperCase() + mode.slice(1);
        const els = buildSections(tab.sections, mode);
        for (const el of els) el.hidden = mode !== tab.modes[0] || el.hidden;
        b.setAttribute('aria-pressed', String(mode === tab.modes[0]));
        b.addEventListener('click', () => {
          for (const [btn, list] of modeEls) {
            btn.setAttribute('aria-pressed', String(btn === b));
            for (const el of list) el.hidden = btn !== b || (guarded.find((g) => g.el === el) ? !testSection(guarded.find((g) => g.el === el).section) : false);
          }
        });
        modeEls.push([b, els]);
        seg.appendChild(b);
        page.append(...els);
      }
      page.prepend(seg);
    } else page.append(...buildSections(tab.sections, null));
    pages.appendChild(page);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dialog-tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.tab = tab.id;
    btn.textContent = tab.label;
    btn.addEventListener('click', () => show(tab.id));
    tabBar.appendChild(btn);
    pageEls.push({ id: tab.id, page, btn });
  }
  function show(id) {
    for (const t of pageEls) {
      t.page.hidden = t.id !== id;
      t.btn.setAttribute('aria-selected', String(t.id === id));
    }
  }
  const first = pageEls.find((t) => t.id === 'basic') ?? pageEls[0];
  if (first) show(first.id);

  const set = (params) => {
    current = clone(params);
    sync();
    changed();
  };
  resetBtn.addEventListener('click', () => set(developDefaults()));
  autoBtn.addEventListener('click', () => {
    const patch = onAuto?.();
    if (patch) set({ ...current, ...patch });
    if (first) show(first.id);
  });
  return { element, set, get: () => clone(current), workspace };
}

/** The selection's coverage (0..255) over a session's rect, or null when the session follows the selection itself. */
function selectionCoverage(d, rect) {
  const sel = d?.selection && !d.selection.isEmpty ? d.selection : null;
  if (!sel) return null;
  const out = new Uint8ClampedArray(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= d.height) continue;
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= d.width) continue;
      out[y * rect.width + x] = sel.mask[sy * d.width + sx];
    }
  }
  return out;
}

/** Develops a session's pixels; a whole-layer session (ignoreSelection) is masked by the selection afterwards. */
function runOn(session, params, d, coverage) {
  return processed(session, (img) => {
    develop(img, params, null, { docWidth: d?.width, docHeight: d?.height });
    if (!coverage) return;
    const base = session.base.data, o = img.data;
    for (let p = 0, i = 0; p < coverage.length; p++, i += 4) {
      const k = coverage[p] / 255;
      if (k === 1) continue;
      for (let c = 0; c < 4; c++) o[i + c] = base[i + c] + (o[i + c] - base[i + c]) * k;
    }
  });
}

/** A pixel session for these params: the selection plus 0.4's margin, or the whole layer for a whole-layer stage. */
function beginDevelop(app, params, { quiet = false } = {}) {
  const margin = marginFor(params);
  const whole = margin === Infinity;
  const session = beginPixelEdit(app, { label: LABEL, margin: whole ? 0 : margin, ignoreSelection: whole, quiet });
  if (!session) return null;
  return { session, margin, coverage: whole ? selectionCoverage(app.doc, session.rect) : null };
}

/**
 * The dialog: 0.4's pixelEditDialog (adjust-ui.js) for Camera Raw, which can restart its session when the margin the
 * params need changes (a whole-layer stage switched on or off, a stage reading further than the session took).
 * Resolves with the params (committed) or null.
 */
async function developDialog(app, { title, params, width }) {
  let run = beginDevelop(app, params);
  if (!run) return null;
  const d = app.doc;
  let current = params;
  let preview = app.settings.dialogPreview !== false;
  let done = false;
  const restartIfNeeded = () => {
    const need = marginFor(current);
    if (need === run.margin || (need !== Infinity && run.margin !== Infinity && need < run.margin)) return;
    run.session.cancel();
    run = beginDevelop(app, current, { quiet: true }) ?? run;
  };
  const refresh = frameThrottle(() => {
    if (done) return;
    if (!preview) return run.session.restore();
    try {
      run.session.show(runOn(run.session, current, d, run.coverage));
    } catch (err) {
      console.error(err);
    }
  });
  const ed = developEditor(params, (p) => {
    current = p;
    restartIfNeeded();
    refresh();
  }, { app, session: () => run.session, onAuto: () => autoTone(run.session.base) });
  const content = document.createElement('div');
  content.appendChild(ed.element);
  const pv = document.createElement('label');
  pv.className = 'checkbox';
  const pvInput = document.createElement('input');
  pvInput.type = 'checkbox';
  pvInput.checked = preview;
  pvInput.dataset.key = '__preview';
  pvInput.addEventListener('change', () => {
    preview = pvInput.checked;
    app.settings.dialogPreview = preview;
    app.saveSettingsSoon();
    refresh();
  });
  pv.append(pvInput, document.createTextNode('Preview'));
  content.appendChild(pv);
  const result = await app.dialogs.open({
    title,
    content,
    width,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: () => refresh(),
  });
  done = true;
  refresh.cancel();
  if (!result) {
    run.session.cancel();
    return null;
  }
  try {
    const img = await app.busy(`${title}…`, async () => runOn(run.session, current, d, run.coverage));
    run.session.commit(LABEL, img, {});
  } catch (err) {
    run.session.cancel();
    app.reportError(err, `${title} failed`);
    return null;
  }
  return current;
}

export function install(app) {
  const has = () => !!app.doc?.active;

  async function cameraRaw(arg, ctx = null) {
    app.tools.active?.commit?.();
    const d = app.doc;
    const layer = d?.active;
    if (!layer) return ctx?.cancel();
    const explicit = arg && typeof arg === 'object' ? clone(arg) : null;
    const start = { ...developDefaults(), ...(explicit ?? {}) };
    // S12.4: a played step (actions, lib/actions.js) or Last Filter ('repeat') applies its params without the dialog;
    // params from any other source open the dialog prefilled with them
    const quiet = !!explicit && (ctx?.source === 'action' || ctx?.source === 'repeat');
    // smart objects: the smart-object module owns the dialog flow (params null opens its dialog, or the kind's
    // `open`, prefilled from `start`) and appends a smart filter instead of editing pixels
    if (layer.type === 'smart' && typeof app.smartFilters?.intercept === 'function') {
      const handled = app.smartFilters.intercept(layer, 'camera-raw', quiet ? start : null, LABEL, explicit && !quiet ? { start } : undefined);
      if (handled) return handled.done; // resolves with the smart filter's params (null when cancelled)
    }
    if (quiet) {
      const run = beginDevelop(app, start);
      if (!run) return ctx.cancel();
      run.session.commit(LABEL, await app.busy(`${LABEL}…`, async () => runOn(run.session, start, d, run.coverage)));
      return start;
    }
    return developDialog(app, { title: 'Camera Raw Filter', params: start, width: 560 });
  }

  // shared with other modules; the smart-object module renders and re-edits Camera Raw smart filters
  // through the kind registered here (its module installs before this one, app:ready covers the rest)
  app.cameraRaw = { develop, defaults: developDefaults, autoTone, editor: developEditor, label: LABEL };
  const registerSmartKind = () =>
    app.smartFilters?.registerKind?.('camera-raw', {
      name: LABEL,
      defaults: developDefaults,
      apply: (img, params) => develop(img, params),
      editor: (params, onChange) => developEditor({ ...developDefaults(), ...(params ?? {}) }, onChange, { app }),
      padding: paddingFor,
      // E55 (S8.3): laid out on the object's bounds (the vignette is centred on it) and only recolours; 0.4 held both
      // in smart-object.js' GEOMETRIC_FILTERS and RECOLOUR_ONLY. camera-raw-workspace adds `open` and makes
      // recolourOnly false while a resample stage is active.
      geometric: true,
      recolourOnly: () => true,
    });
  registerSmartKind();
  app.on('app:ready', registerSmartKind);
  app.commands.registerAll({
    // actions (lib/actions.js): the dialog's settings (or null when cancelled) decide what is recorded
    'filter:camera-raw': { enabled: has, label: 'Camera Raw Filter…', dialog: true, run: (arg, ctx) => cameraRaw(arg, ctx).then((used) => (used ? ctx?.setReplayArg(clone(used)) : ctx?.cancel(), used)) },
  });
}
