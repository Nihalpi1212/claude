// Channels panel (bottom group): the channels of the document's image mode (lib/modes.js) as thumbnails of the
// flattened image, the active layer's mask, and saved alpha channels (doc.channels).
//   RGB: the composite and Red / Green / Blue        CMYK: the composite and Cyan / Magenta / Yellow / Black
//   Lab: the composite and Lightness / a / b         Grayscale, Bitmap, Duotone, Indexed Color: one channel
//   Multichannel: the spot channels the conversion made (saved channels flagged `spot`), nothing else
// CMYK and Lab channels are derived planes (shared/pixels/modes.js channelPlanes): the document stores RGBA.
// Ctrl/Cmd-click a thumbnail loads that channel as a selection (+Shift adds, +Alt subtracts).
// Single-channel viewing is not implemented: the canvas always shows the composite.
import { icon } from '../icons.js';
import { createCanvas } from '../document.js';
import { Selection } from '../selection.js';
import { MODES, channelPlanes } from '../../../shared/pixels/modes.js';

const TW = 34, TH = 26;

export function install(app) {
  const el = document.createElement('div');
  el.className = 'channels-panel';
  el.innerHTML = `
    <ul class="channel-list" role="listbox" aria-label="Channels"></ul>
    <div class="panel-footer">
      <span class="muted channels-hint" title="Ctrl/Cmd-click a channel to load it as a selection (Shift adds, Alt subtracts); the composite loads its luminosity">Ctrl-click: load selection</span>
      <span style="flex:1"></span>
      <button class="pbtn" data-act="load" title="Load the channel as a selection">${icon('marquee-ellipse')}</button>
      <button class="pbtn" data-act="save" title="Save the selection as a channel">${icon('mask')}</button>
      <button class="pbtn" data-act="new" title="New empty channel">${icon('plus')}</button>
      <button class="pbtn" data-act="delete" title="Delete the channel">${icon('trash')}</button>
    </div>`;
  const list = el.querySelector('.channel-list');
  const btn = (a) => el.querySelector(`[data-act="${a}"]`);
  let selectedId = null; // saved alpha channel id
  let pending = 0;
  let thumbTimer = 0;
  let thumbs = null; // { key, rgb: composite canvas, planes: { channel id: canvas } }
  const alphaThumbs = new WeakMap(); // channel object -> canvas
  const maskThumbs = new WeakMap(); // layer -> { version, canvas }

  const visible = () => app.panels.isVisible('channels');
  const schedule = () => {
    if (pending || !visible()) return;
    pending = requestAnimationFrame(render);
  };

  function thumbSize(doc) {
    const dpr = window.devicePixelRatio || 1;
    const s = Math.min((TW * dpr) / doc.width, (TH * dpr) / doc.height);
    return { w: Math.max(1, Math.round(doc.width * s)), h: Math.max(1, Math.round(doc.height * s)) };
  }

  /**
   * The rows a mode puts above the mask and the saved channels: `composite` (RGB, CMYK, Lab) and the mode's
   * colour channels. A single-channel mode has no separate composite: its one channel is the picture.
   */
  function modeRows(doc) {
    const info = MODES[doc.mode] ?? MODES.rgb;
    const single = !info.composite && info.channels.length === 1;
    return {
      // `rgb` stays the id of the RGB composite; other composites are named after their mode
      composite: info.composite ? { type: doc.mode === 'rgb' ? 'rgb' : doc.mode, label: info.composite } : single ? { type: info.channels[0].id, label: info.channels[0].name } : null,
      channels: single ? [] : info.channels.map((c) => ({ type: c.id, label: c.name, plane: c.id })),
    };
  }

  function compositeThumbs(doc) {
    const key = `${doc.id}:${doc.version}:${doc.mode}`;
    if (thumbs?.key === key) return thumbs;
    const { w, h } = thumbSize(doc);
    const rgb = createCanvas(w, h);
    const ctx = rgb.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'medium';
    try {
      ctx.drawImage(doc.view.compositor.composite(doc), 0, 0, w, h);
    } catch (err) {
      console.warn('channel thumbnails', err);
    }
    const img = ctx.getImageData(0, 0, w, h);
    const planes = {};
    for (const plane of modeRows(doc).channels.length ? channelPlanes(img, doc.mode) : []) {
      const c = createCanvas(w, h);
      const out = new ImageData(w, h);
      const d = out.data, s = plane.data;
      for (let p = 0, i = 0; p < s.length; p++, i += 4) {
        d[i] = d[i + 1] = d[i + 2] = s[p];
        d[i + 3] = 255;
      }
      c.getContext('2d').putImageData(out, 0, 0);
      planes[plane.id] = c;
    }
    thumbs = { key, rgb, planes };
    return thumbs;
  }

  function maskThumb(doc, layer) {
    const c0 = maskThumbs.get(layer);
    if (c0 && c0.version === layer.version) return c0.canvas;
    const { w, h } = thumbSize(doc);
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (layer.mask?.canvas) ctx.drawImage(layer.mask.canvas, 0, 0, w, h);
    maskThumbs.set(layer, { version: layer.version, canvas: c });
    return c;
  }

  function alphaThumb(doc, ch) {
    const cached = alphaThumbs.get(ch);
    if (cached) return cached;
    const full = createCanvas(doc.width, doc.height);
    const img = new ImageData(doc.width, doc.height);
    const m = ch.mask, d = img.data;
    if (m && m.length === doc.width * doc.height) {
      for (let i = 0, j = 0; i < m.length; i++, j += 4) {
        d[j] = d[j + 1] = d[j + 2] = m[i];
        d[j + 3] = 255;
      }
    }
    full.getContext('2d').putImageData(img, 0, 0);
    const { w, h } = thumbSize(doc);
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(full, 0, 0, w, h);
    alphaThumbs.set(ch, c);
    return c;
  }

  function thumbBox(canvas) {
    const t = document.createElement('span');
    t.className = 'layer-thumb channel-thumb';
    const c = createCanvas(canvas.width, canvas.height);
    c.getContext('2d').drawImage(canvas, 0, 0);
    t.appendChild(c);
    return t;
  }

  // ---- channel data as selection masks ----------------------------------------------------------------------
  function channelMask(doc, which) {
    if (which.type === 'alpha') return new Uint8ClampedArray(which.channel.mask);
    if (which.type === 'mask') {
      const img = which.layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
      const out = new Uint8ClampedArray(doc.width * doc.height);
      for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4 + 3];
      return out;
    }
    const comp = doc.view.compositor.composite(doc);
    const img = comp.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    // a colour channel of the mode (Red, Cyan, Lightness ...): its plane as the panel shows it, white = selected
    if (which.plane) {
      const plane = channelPlanes(img, doc.mode).find((p) => p.id === which.plane);
      if (plane) return plane.data;
    }
    // the composite (or the one channel of a grey mode): its luminosity
    const data = img.data;
    const out = new Uint8ClampedArray(doc.width * doc.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) * (data[j + 3] / 255);
    return out;
  }

  function loadAsSelection(which, e) {
    const doc = app.doc;
    if (!doc) return;
    const mode = e?.shiftKey && e?.altKey ? 'intersect' : e?.shiftKey ? 'add' : e?.altKey ? 'subtract' : 'replace';
    const sel = Selection.fromMask(doc.width, doc.height, channelMask(doc, which));
    app.applySelection(sel, mode, `Load ${which.label ?? 'channel'}`);
  }

  // ---- undoable channel list changes --------------------------------------------------------------------------
  function setChannels(doc, after, label) {
    const before = doc.channels.slice();
    const set = (listNow) => {
      doc.channels = listNow.slice();
      doc.changed('channels');
      app.emit('channels:changed', doc);
    };
    set(after);
    const bytes = after.filter((c) => !before.includes(c)).reduce((n, c) => n + (c.mask?.length ?? 0), 0);
    doc.history.push({ label, undo: () => set(before), redo: () => set(after), bytes, at: Date.now() });
    doc.changed('history');
  }

  async function renameChannel(id) {
    const doc = app.doc;
    const ch = doc?.channels.find((c) => c.id === id);
    if (!ch) return;
    const name = await app.dialogs.prompt('Channel name', { title: 'Rename Channel', value: ch.name });
    if (!name || !name.trim() || name.trim() === ch.name) return;
    setChannels(doc, doc.channels.map((c) => (c.id === id ? { ...c, name: name.trim() } : c)), 'Rename channel');
  }

  function deleteChannel(id = selectedId) {
    const doc = app.doc;
    const ch = doc?.channels.find((c) => c.id === id);
    if (!ch) return;
    setChannels(doc, doc.channels.filter((c) => c.id !== id), `Delete ${ch.name}`);
    if (selectedId === id) selectedId = null;
  }

  function duplicateChannel(id) {
    const doc = app.doc;
    const ch = doc?.channels.find((c) => c.id === id);
    if (!ch) return;
    // the copy of a spot channel is a plain alpha channel: it prints nothing
    const copy = { id: `C${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `${ch.name} copy`, mask: new Uint8ClampedArray(ch.mask) };
    setChannels(doc, [...doc.channels, copy], 'Duplicate channel');
    selectedId = copy.id;
  }

  function newChannel() {
    const doc = app.doc;
    if (!doc) return;
    const ch = { id: `C${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `Alpha ${doc.channels.length + 1}`, mask: new Uint8ClampedArray(doc.width * doc.height) };
    setChannels(doc, [...doc.channels, ch], 'New channel');
    selectedId = ch.id;
  }

  // ---- rendering --------------------------------------------------------------------------------------------
  function channelRow({ label, canvas, which, selected, onClick, onDblClick, menu, hint, ink }) {
    const li = document.createElement('li');
    li.className = 'channel-row' + (selected ? ' selected' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(!!selected));
    li.dataset.channel = which.type === 'alpha' ? which.channel.id : which.type;
    const t = thumbBox(canvas);
    t.title = 'Ctrl/Cmd-click: load as selection (Shift adds, Alt subtracts)';
    li.appendChild(t);
    if (ink) {
      // spot channels (Multichannel) carry the colour of their ink
      const chip = document.createElement('span');
      chip.className = 'channel-ink';
      chip.style.background = `rgb(${ink.join(',')})`;
      chip.title = 'Spot channel';
      li.appendChild(chip);
    }
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = label;
    li.appendChild(name);
    if (hint) {
      const k = document.createElement('span');
      k.className = 'kbd-hint muted';
      k.textContent = hint;
      li.appendChild(k);
    }
    li.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) return loadAsSelection({ ...which, label }, e);
      onClick?.(e);
    });
    if (onDblClick) li.addEventListener('dblclick', onDblClick);
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [{ label: 'Load as Selection', icon: 'marquee-ellipse', onSelect: () => loadAsSelection({ ...which, label }) }, ...(menu ?? [])];
      app.dialogs.popover(li, items, { at: { x: e.clientX, y: e.clientY } });
    });
    return li;
  }

  function render() {
    pending = 0;
    const doc = app.doc;
    list.replaceChildren();
    for (const b of el.querySelectorAll('[data-act]')) b.disabled = !doc;
    if (!doc) {
      list.innerHTML = '<li class="panel-empty">No document open</li>';
      return;
    }
    if (selectedId && !doc.channels.some((c) => c.id === selectedId)) selectedId = null;
    const t = compositeThumbs(doc);
    const layer = doc.active;
    const editingMask = !!app.ui.editingMask && !!layer?.mask;
    const compositeOn = !editingMask && !selectedId;
    const pick = () => {
      selectedId = null;
      app.setEditingMask(false);
      schedule();
    };
    const rows = modeRows(doc);
    list.dataset.mode = doc.mode;
    // the Index channel of an indexed document stands for its colour table: the row says how many colours it has
    // and opens the Color Table editor
    const table = doc.mode === 'indexed' ? { hint: `${doc.colorTable?.length ?? 0} colors`, onDblClick: () => app.commands.run('image:color-table', undefined, 'panel'), menu: [{ label: 'Color Table…', icon: 'grid-add', onSelect: () => app.commands.run('image:color-table', undefined, 'panel') }] } : {};
    if (rows.composite) list.appendChild(channelRow({ label: rows.composite.label, canvas: t.rgb, which: { type: rows.composite.type }, selected: compositeOn, onClick: pick, ...table }));
    for (const c of rows.channels) list.appendChild(channelRow({ label: c.label, canvas: t.planes[c.plane] ?? t.rgb, which: { type: c.type, plane: c.plane }, selected: compositeOn, onClick: pick }));
    if (layer?.mask?.canvas) {
      list.appendChild(channelRow({
        label: `${layer.name} Mask`,
        canvas: maskThumb(doc, layer),
        which: { type: 'mask', layer },
        selected: editingMask,
        onClick: () => {
          selectedId = null;
          app.setEditingMask(true);
          schedule();
        },
        menu: [{ label: 'Edit Mask', icon: 'brush', onSelect: () => app.setEditingMask(true) }],
      }));
    }
    for (const ch of doc.channels) {
      list.appendChild(channelRow({
        label: ch.name,
        canvas: alphaThumb(doc, ch),
        which: { type: 'alpha', channel: ch },
        ink: ch.spot ? ch.spot.color ?? [128, 128, 128] : null,
        selected: selectedId === ch.id,
        onClick: () => {
          selectedId = ch.id;
          schedule();
        },
        onDblClick: (e) => {
          if (e.target.closest('.layer-name')) renameChannel(ch.id);
        },
        menu: [
          { label: 'Rename Channel…', icon: 'edit', onSelect: () => renameChannel(ch.id) },
          { label: 'Duplicate Channel', icon: 'copy', onSelect: () => duplicateChannel(ch.id) },
          { type: 'separator' },
          { label: 'Delete Channel', icon: 'trash', onSelect: () => deleteChannel(ch.id) },
        ],
      }));
    }
    btn('load').disabled = !doc.channels.length;
    btn('save').disabled = !(doc.selection && !doc.selection.isEmpty);
    btn('delete').disabled = !selectedId;
  }

  btn('load').addEventListener('click', () => app.commands.run('select:load', selectedId ?? undefined, 'panel'));
  btn('save').addEventListener('click', () => app.commands.run('select:save', undefined, 'panel'));
  btn('new').addEventListener('click', newChannel);
  btn('delete').addEventListener('click', () => deleteChannel());

  app.on('doc:activated', () => {
    selectedId = null;
    schedule();
  });
  app.on('layer:activated', schedule);
  app.on('mask:editing', schedule);
  app.on('selection:changed', schedule);
  app.on('channels:changed', schedule);
  app.on('mode:changed', schedule);
  app.on('doc:change', (e) => {
    if (['tree', 'active', 'canvas', 'channels', 'props', 'history', 'mask-edit'].includes(e.kind)) {
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(schedule, 120);
    } else if (e.kind === 'pixels' || e.kind === 'mask') {
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(schedule, 350);
    }
  });

  app.panels.register({ id: 'channels', title: 'Channels', icon: 'channels', element: el, group: 'bottom', onShow: render });
  render();
  return { render };
}
