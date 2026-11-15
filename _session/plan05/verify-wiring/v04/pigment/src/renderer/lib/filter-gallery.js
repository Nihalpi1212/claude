// Filter > Filter Gallery… (builder "gallery-a"): the dialog that edits a stack of gallery effects.
// The composite kind 'filter-gallery' (src/shared/pixels/gallery-artistic.js) runs params.effects
// ([{ kind, params, enabled }]) in order; this module is its custom opener
// (app.filterEditor.register('filter-gallery', { open })), so filter:filter-gallery, Last Filter,
// actions and smart filters all go through the same params.
//
// Layout, like Photoshop's: the preview (zoom, pan, fit) on the left, the six group accordions with
// thumbnails (each effect applied to a built-in 80x60 sample) in the middle, the selected effect's
// fields on the right with the effect layer stack below them (eye toggles, drag or buttons to reorder,
// new and delete). The preview runs the stack on a downscaled copy of the edited region while editing;
// OK runs it at full size under app.busy and commits one history entry through beginPixelEdit.
// Sketch kinds (and any kind with a `colors` parameter) paint with the current foreground/background.
import { FILTERS, GALLERY_GROUPS, applyFilter } from '../../shared/pixels/filters.js';
import { sampleImage } from '../../shared/pixels/gallery-artistic.js';
import { resize } from '../../shared/pixels/transform.js';
import { buildForm, frameThrottle } from './form.js';
import { beginPixelEdit, processed, getPath, setPath } from './adjust-ui.js';
import { icon } from './icons.js';

const KIND = 'filter-gallery';
/** Longest side of the copy the preview runs on (keeps every effect well under a frame's worth of work). */
const PREVIEW_MAX = 720;
const ZOOMS = [0.125, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8];
const clone = (v) => JSON.parse(JSON.stringify(v));
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

const isGalleryKind = (k) => typeof k === 'string' && !!FILTERS[k] && FILTERS[k].category === 'gallery';
const available = (k) => isGalleryKind(k) && !FILTERS[k].placeholder;
/** Kinds that paint with the foreground/background colours: the Sketch group and anything declaring `colors`. */
const usesColors = (k) => isGalleryKind(k) && (FILTERS[k].gallery === 'Sketch' || Object.prototype.hasOwnProperty.call(FILTERS[k].defaults, 'colors'));
const colorsFor = (app, k) => (usesColors(k) ? [app.settings.foreground, app.settings.background] : null);

/** A stack entry for `kind` with its defaults, the given params over them and the current colours when it paints with them. */
function newEffect(app, kind, params = null, enabled = true) {
  const p = { ...clone(FILTERS[kind].defaults), ...(params ? clone(params) : {}) };
  const colors = colorsFor(app, kind);
  if (colors) p.colors = colors;
  return { kind, params: p, enabled: enabled !== false };
}

/** Drops entries of unknown kinds and refreshes the colours (the dialog always paints with the current ones). */
function normalizeEffects(app, list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) if (e && isGalleryKind(e.kind)) out.push(newEffect(app, e.kind, e.params, e.enabled));
  return out;
}

const firstAvailableKind = () => {
  for (const g of GALLERY_GROUPS) for (const k of g.kinds) if (available(k)) return k;
  return null;
};

// ---- thumbnails ----------------------------------------------------------------------------------------------

let SAMPLE = null;
const THUMBS = new Map();

/** The effect applied to the sample image, as an 80x60 canvas (cached per kind and colours; placeholders show the plain sample). */
function thumbnail(app, kind) {
  SAMPLE ??= sampleImage(80, 60);
  const colors = colorsFor(app, kind);
  const key = `${kind}|${colors ? colors.join(',') : ''}`;
  if (THUMBS.has(key)) return THUMBS.get(key);
  const img = { width: SAMPLE.width, height: SAMPLE.height, data: new Uint8ClampedArray(SAMPLE.data) };
  if (available(kind)) {
    try {
      const params = colors ? { colors } : {};
      FILTERS[kind].apply(img, params);
    } catch (err) {
      console.warn(`Filter Gallery thumbnail failed for ${kind}`, err);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  THUMBS.set(key, canvas);
  return canvas;
}

// ---- the dialog ----------------------------------------------------------------------------------------------

/**
 * Opener contract (lib/filter-ui.js): open(kind, { params, def, ctx }) -> Promise<params | null>. Owns a pixel edit
 * session of the active layer (limited to the selection), commits once on OK and resolves with the params used.
 */
async function openGallery(app, { params, def }) {
  const session = beginPixelEdit(app, { label: def.name, margin: 64 });
  if (!session) return null;
  let effects = normalizeEffects(app, params?.effects);
  if (!effects.length) {
    const k = firstAvailableKind();
    if (k) effects.push(newEffect(app, k));
  }
  let selected = effects.length - 1;
  // per-kind settings used in this session, so switching an effect back to a kind restores what was set for it
  const lastParams = {};
  for (const e of effects) lastParams[e.kind] = clone(e.params);

  // -- preview copy: the edited region, downscaled while editing
  const base = session.base;
  const scale = Math.min(1, PREVIEW_MAX / Math.max(1, base.width, base.height));
  const previewBase = scale < 1 ? resize(base, Math.max(1, Math.round(base.width * scale)), Math.max(1, Math.round(base.height * scale)), { method: 'area' }) : base;
  const pvCanvas = document.createElement('canvas');
  pvCanvas.width = previewBase.width;
  pvCanvas.height = previewBase.height;
  const pvCtx = pvCanvas.getContext('2d');

  // -- DOM
  const root = el('div', 'fg-root');
  const previewPane = el('div', 'fg-preview');
  const viewport = el('div', 'fg-viewport');
  const canvas = el('canvas', 'fg-canvas');
  viewport.appendChild(canvas);
  const zoomBar = el('div', 'fg-zoombar');
  const zoomOut = el('button', 'btn quiet fg-zoom-btn');
  zoomOut.type = 'button';
  zoomOut.dataset.action = 'zoom-out';
  zoomOut.title = 'Zoom out';
  zoomOut.innerHTML = icon('minus');
  const zoomSel = el('select', 'select fg-zoom');
  for (const z of ZOOMS) {
    const o = el('option', null, `${Math.round(z * 100)}%`);
    o.value = String(z);
    zoomSel.appendChild(o);
  }
  const fitOpt = el('option', null, 'Fit');
  fitOpt.value = 'fit';
  zoomSel.appendChild(fitOpt);
  const zoomIn = el('button', 'btn quiet fg-zoom-btn');
  zoomIn.type = 'button';
  zoomIn.dataset.action = 'zoom-in';
  zoomIn.title = 'Zoom in';
  zoomIn.innerHTML = icon('plus');
  const note = el('span', 'muted fg-note', scale < 1 ? `Preview at ${Math.round(scale * 100)}% of full size while editing` : '');
  zoomBar.append(zoomOut, zoomSel, zoomIn, note);
  previewPane.append(viewport, zoomBar);

  const groupsPane = el('div', 'fg-groups');
  const menuLabel = el('label', 'checkbox fg-menu-option');
  const menuInput = document.createElement('input');
  menuInput.type = 'checkbox';
  menuInput.dataset.key = 'showGalleryInMenu';
  menuInput.checked = !!app.settings.showGalleryInMenu;
  menuInput.addEventListener('change', () => {
    // the native menu lists the six groups when this is on (src/main/menu.js reads state.showGalleryInMenu)
    app.saveSettingsSoon({ showGalleryInMenu: menuInput.checked });
    app.syncUiState();
    app.menuRefresh?.();
  });
  menuLabel.append(menuInput, document.createTextNode('Show all groups in Filter menu'));
  groupsPane.appendChild(menuLabel);
  const groupEls = new Map();
  for (const g of GALLERY_GROUPS) {
    const group = el('div', 'fg-group');
    group.dataset.group = g.id;
    const head = el('button', 'fg-group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.innerHTML = `${icon('chevron-right')}<span>${g.name}</span>`;
    const thumbs = el('div', 'fg-thumbs');
    thumbs.hidden = true;
    head.addEventListener('click', () => toggleGroup(g.id, thumbs.hidden));
    group.append(head, thumbs);
    groupsPane.appendChild(group);
    groupEls.set(g.id, { group, head, thumbs, rendered: false, kinds: g.kinds });
  }

  const side = el('div', 'fg-side');
  const kindSel = el('select', 'select fg-kind');
  for (const g of GALLERY_GROUPS) {
    if (!g.kinds.length) continue;
    const og = document.createElement('optgroup');
    og.label = g.name;
    for (const k of g.kinds) {
      const o = el('option', null, FILTERS[k].name);
      o.value = k;
      o.disabled = !available(k);
      og.appendChild(o);
    }
    kindSel.appendChild(og);
  }
  kindSel.addEventListener('change', () => setKind(kindSel.value));
  const fieldsBox = el('div', 'fg-fields');
  const stackHead = el('div', 'fg-stack-head');
  stackHead.appendChild(el('span', 'fg-stack-title', 'Effect layers'));
  const stackButtons = el('div', 'fg-stack-buttons');
  const mkBtn = (action, name, title) => {
    const b = el('button', 'btn quiet fg-stack-btn');
    b.type = 'button';
    b.dataset.action = action;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon(name);
    stackButtons.appendChild(b);
    return b;
  };
  const upBtn = mkBtn('up', 'chevron-up', 'Move effect layer up');
  const downBtn = mkBtn('down', 'chevron-down', 'Move effect layer down');
  const newBtn = mkBtn('new', 'plus', 'New effect layer');
  const delBtn = mkBtn('delete', 'trash', 'Delete effect layer');
  stackHead.appendChild(stackButtons);
  const stack = el('div', 'fg-stack');
  stack.setAttribute('role', 'listbox');
  stack.setAttribute('aria-label', 'Effect layers');
  side.append(kindSel, fieldsBox, stackHead, stack);
  root.append(previewPane, groupsPane, side);

  // -- state helpers
  let done = false;
  const current = () => (selected >= 0 && selected < effects.length ? effects[selected] : null);

  const refresh = frameThrottle(() => {
    if (done) return;
    const img = { width: previewBase.width, height: previewBase.height, data: new Uint8ClampedArray(previewBase.data) };
    try {
      applyFilter(img, KIND, { effects });
    } catch (err) {
      console.error(err);
    }
    pvCtx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    paint();
  });

  // -- preview view: zoom is document px -> css px; pan is the css offset of the region's top-left
  let zoom = 1, fit = true, panX = 0, panY = 0;
  const viewSize = () => ({ w: viewport.clientWidth || 1, h: viewport.clientHeight || 1 });
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = viewSize();
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
  }
  function fitZoom() {
    const { w, h } = viewSize();
    zoom = Math.min(w / base.width, h / base.height);
    fit = true;
    center();
  }
  function center() {
    const { w, h } = viewSize();
    panX = (w - base.width * zoom) / 2;
    panY = (h - base.height * zoom) / 2;
  }
  function syncZoomSelect() {
    if (fit) zoomSel.value = 'fit';
    else {
      const near = ZOOMS.find((z) => Math.abs(z - zoom) < 1e-6);
      if (near !== undefined) zoomSel.value = String(near);
      else {
        let custom = zoomSel.querySelector('option[data-custom]');
        if (!custom) {
          custom = el('option');
          custom.dataset.custom = '1';
          zoomSel.insertBefore(custom, fitOpt);
        }
        custom.value = String(zoom);
        custom.textContent = `${Math.round(zoom * 100)}%`;
        zoomSel.value = custom.value;
      }
    }
    zoomOut.disabled = zoom <= ZOOMS[0] + 1e-6;
    zoomIn.disabled = zoom >= ZOOMS[ZOOMS.length - 1] - 1e-6;
  }
  function paint() {
    sizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = zoom / scale;
    ctx.imageSmoothingEnabled = k < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pvCanvas, panX, panY, pvCanvas.width * k, pvCanvas.height * k);
    syncZoomSelect();
  }
  /** Zooms to z keeping the document point under (cx, cy) css px fixed (defaults to the viewport centre). */
  function setZoom(z, cx = null, cy = null) {
    const { w, h } = viewSize();
    const px = cx ?? w / 2, py = cy ?? h / 2;
    const dx = (px - panX) / zoom, dy = (py - panY) / zoom;
    zoom = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));
    fit = false;
    panX = px - dx * zoom;
    panY = py - dy * zoom;
    paint();
  }
  zoomIn.addEventListener('click', () => setZoom(ZOOMS.find((z) => z > zoom + 1e-6) ?? ZOOMS[ZOOMS.length - 1]));
  zoomOut.addEventListener('click', () => setZoom([...ZOOMS].reverse().find((z) => z < zoom - 1e-6) ?? ZOOMS[0]));
  zoomSel.addEventListener('change', () => {
    if (zoomSel.value === 'fit') {
      fitZoom();
      paint();
    } else setZoom(Number(zoomSel.value));
  });
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    setZoom(zoom * Math.pow(1.1, -e.deltaY / 100), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, panX, panY };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    panX = drag.panX + (e.clientX - drag.x);
    panY = drag.panY + (e.clientY - drag.y);
    fit = false;
    paint();
  });
  const endDrag = () => {
    drag = null;
    viewport.classList.remove('dragging');
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (done) return;
    if (fit) fitZoom();
    paint();
  }) : null;

  // -- groups and thumbnails
  function renderGroup(id) {
    const g = groupEls.get(id);
    if (!g || g.rendered) return;
    g.rendered = true;
    for (const k of g.kinds) {
      const b = el('button', 'fg-thumb');
      b.type = 'button';
      b.dataset.kind = k;
      b.title = available(k) ? FILTERS[k].name : `${FILTERS[k].name} (not available yet)`;
      b.disabled = !available(k);
      b.appendChild(thumbnail(app, k));
      b.appendChild(el('span', 'fg-thumb-name', FILTERS[k].name));
      b.addEventListener('click', () => setKind(k));
      g.thumbs.appendChild(b);
    }
  }
  function toggleGroup(id, open) {
    const g = groupEls.get(id);
    if (!g) return;
    if (open) renderGroup(id);
    g.thumbs.hidden = !open;
    g.head.setAttribute('aria-expanded', String(open));
    g.head.firstElementChild.outerHTML = icon(open ? 'chevron-down' : 'chevron-right');
  }
  function markThumbs() {
    const kind = current()?.kind ?? null;
    for (const b of groupsPane.querySelectorAll('.fg-thumb')) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
  }
  const groupOf = (kind) => GALLERY_GROUPS.find((g) => g.kinds.includes(kind))?.id ?? null;

  // -- fields of the selected effect
  function renderFields() {
    fieldsBox.replaceChildren();
    const e = current();
    kindSel.disabled = !e;
    if (!e) {
      fieldsBox.appendChild(el('p', 'muted fg-empty', 'No effect layers. Click a thumbnail or the + button to add one.'));
      return;
    }
    kindSel.value = e.kind;
    const fields = (app.filterEditor.fields(e.kind) ?? []).filter((f) => !/^colors(\.|$)/.test(String(f.key)));
    if (!fields.length) {
      fieldsBox.appendChild(el('p', 'muted fg-empty', `${FILTERS[e.kind].name} has no options.`));
      return;
    }
    const values = {};
    for (const f of fields) if (f.key) values[f.key] = getPath(e.params, f.key) ?? (f.type === 'checkbox' ? false : f.type === 'color' ? '#000000' : 0);
    const form = buildForm(fields, {
      values,
      onChange: (v) => {
        const cur = current();
        if (!cur) return;
        for (const f of fields) if (f.key) setPath(cur.params, f.key, v[f.key]);
        lastParams[cur.kind] = clone(cur.params);
        refresh();
      },
    });
    form.element.classList.add('fg-form');
    fieldsBox.appendChild(form.element);
  }

  // -- the effect layer stack (top row = applied last)
  function renderStack() {
    stack.replaceChildren();
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const row = el('div', 'fg-effect');
      row.dataset.kind = e.kind;
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === selected));
      row.draggable = true;
      row.tabIndex = -1;
      const eye = el('button', 'fg-eye');
      eye.type = 'button';
      eye.title = e.enabled ? 'Hide effect layer' : 'Show effect layer';
      eye.setAttribute('aria-pressed', String(e.enabled));
      eye.innerHTML = icon(e.enabled ? 'eye' : 'eye-off');
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        e.enabled = !e.enabled;
        renderStack();
        refresh();
      });
      const name = el('span', 'fg-effect-name', FILTERS[e.kind].name);
      if (!e.enabled) row.classList.add('disabled');
      row.append(eye, name);
      row.addEventListener('click', () => select(i));
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', String(i));
        ev.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        row.classList.remove('drop-target');
        const from = Number(ev.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from)) moveEffect(from, i);
      });
      stack.appendChild(row);
    }
    const e = current();
    upBtn.disabled = !e || selected >= effects.length - 1;
    downBtn.disabled = !e || selected <= 0;
    delBtn.disabled = !e;
    newBtn.disabled = !e && !firstAvailableKind();
  }
  function select(i) {
    selected = i;
    renderStack();
    renderFields();
    markThumbs();
    const e = current();
    if (e) {
      const gid = groupOf(e.kind);
      if (gid && groupEls.get(gid)?.thumbs.hidden) toggleGroup(gid, true);
      markThumbs();
    }
  }
  function setKind(kind) {
    if (!available(kind)) return;
    const e = current();
    if (!e) {
      effects.push(newEffect(app, kind, lastParams[kind]));
      select(effects.length - 1);
    } else {
      const was = e.enabled;
      effects[selected] = newEffect(app, kind, lastParams[kind], was);
      select(selected);
    }
    refresh();
  }
  function moveEffect(from, to) {
    if (from === to || from < 0 || to < 0 || from >= effects.length || to >= effects.length) return;
    const [e] = effects.splice(from, 1);
    effects.splice(to, 0, e);
    selected = to;
    renderStack();
    refresh();
  }
  upBtn.addEventListener('click', () => moveEffect(selected, selected + 1));
  downBtn.addEventListener('click', () => moveEffect(selected, selected - 1));
  newBtn.addEventListener('click', () => {
    // like Photoshop, a new effect layer starts as a copy of the selected one
    const e = current();
    const kind = e?.kind ?? firstAvailableKind();
    if (!kind) return;
    effects.push(newEffect(app, kind, e?.params ?? lastParams[kind]));
    select(effects.length - 1);
    refresh();
  });
  delBtn.addEventListener('click', () => {
    if (!current()) return;
    effects.splice(selected, 1);
    select(Math.min(selected, effects.length - 1));
    refresh();
  });

  // -- open
  select(selected);
  const result = await app.dialogs.open({
    title: 'Filter Gallery',
    content: root,
    className: 'gallery-dialog',
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: () => {
      // the viewport has its size only once the dialog is laid out
      requestAnimationFrame(() => {
        if (done) return;
        fitZoom();
        refresh();
        observer?.observe(viewport);
      });
    },
  });
  done = true;
  refresh.cancel();
  observer?.disconnect();
  if (!result) {
    session.cancel();
    return null;
  }
  const used = { effects: effects.map((e) => ({ kind: e.kind, params: clone(e.params), enabled: e.enabled })) };
  try {
    const img = await app.busy('Filter Gallery…', async () => processed(session, (x) => applyFilter(x, KIND, used)));
    session.commit(def.name, img, { filter: { kind: KIND, params: clone(used) } });
  } catch (err) {
    session.cancel();
    app.reportError(err, 'Filter Gallery failed');
    return null;
  }
  return used;
}

export function install(app) {
  if (!app.filterEditor?.register || !FILTERS[KIND]) return;
  app.filterEditor.register(KIND, { open: (kind, opts) => openGallery(app, opts) });
  /** Hooks for other modules and tests: open the dialog with params, the colours a kind paints with, a kind's thumbnail. */
  app.filterGallery = {
    open: (params = null) => openGallery(app, { params: params ?? { effects: [] }, def: FILTERS[KIND] }),
    colorsFor: (kind) => colorsFor(app, kind),
    thumbnail: (kind) => thumbnail(app, kind),
    sample: () => sampleImage(80, 60),
    newEffect: (kind, params) => newEffect(app, kind, params),
  };
}
