// History panel (bottom group): snapshots, the initial state and every history entry of the active
// document. Click a state to go back or forward to it (later states are greyed until a new change
// replaces them). Snapshots hold a flattened copy of the image: clicking one restores it as a new,
// undoable step that replaces the layers with a single layer; "New Document from Snapshot" opens
// it in a new tab instead.
import { icon } from '../icons.js';
import { createCanvas, copyCanvas, RasterLayer, Document } from '../document.js';
import { flattenDocument } from '../compositor.js';
import { structural } from '../layer-ops.js';

const THUMB = 30;

export function install(app) {
  const el = document.createElement('div');
  el.className = 'history-panel';
  el.innerHTML = `
    <ul class="history-list history-snapshots" aria-label="Snapshots"></ul>
    <ul class="history-list history-states" role="listbox" aria-label="History states"></ul>
    <div class="panel-footer">
      <span class="muted history-count"></span>
      <span style="flex:1"></span>
      <button class="pbtn" data-act="new-doc" title="New document from the current state">${icon('file')}</button>
      <button class="pbtn" data-act="snapshot" title="Create a new snapshot">${icon('snapshot')}</button>
      <button class="pbtn" data-act="delete" title="Delete the selected snapshot">${icon('trash')}</button>
    </div>`;
  const snapList = el.querySelector('.history-snapshots');
  const states = el.querySelector('.history-states');
  const count = el.querySelector('.history-count');
  const btn = (a) => el.querySelector(`[data-act="${a}"]`);
  let selectedSnap = null;
  let pending = 0;

  const visible = () => app.panels.isVisible('history');
  const schedule = () => {
    if (pending || !visible()) return;
    pending = requestAnimationFrame(render);
  };

  function thumb(canvas) {
    const box = document.createElement('span');
    box.className = 'layer-thumb history-thumb';
    const s = Math.min((THUMB * 2) / canvas.width, (THUMB * 2) / canvas.height);
    const c = createCanvas(Math.max(1, Math.round(canvas.width * s)), Math.max(1, Math.round(canvas.height * s)));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    box.appendChild(c);
    return box;
  }

  function stateIcon(label = '') {
    const l = label.toLowerCase();
    if (/brush|pencil|eraser|stamp|heal|dodge|burn|sponge|smudge|blur|sharpen|paint/.test(l)) return 'brush';
    if (/select|marquee|lasso|wand|deselect/.test(l)) return 'marquee-rect';
    if (/move|nudge|align|transform|rotate|flip/.test(l)) return 'move';
    if (/layer|group|merge|flatten|duplicate/.test(l)) return 'layers';
    if (/mask/.test(l)) return 'mask';
    if (/text|type/.test(l)) return 'text';
    if (/fill|gradient|bucket/.test(l)) return 'fill';
    if (/crop|canvas|image size|trim/.test(l)) return 'crop';
    if (/adjust|curves|levels|hue|brightness|exposure|balance|filter|blur|noise/.test(l)) return 'adjust';
    if (/style|shadow|glow|stroke/.test(l)) return 'fx';
    if (/guide/.test(l)) return 'ruler';
    if (/snapshot/.test(l)) return 'snapshot';
    return 'history';
  }

  function item({ label, iconName, canvas, current, future, onClick, menu, title }) {
    const li = document.createElement('li');
    li.className = 'history-item' + (current ? ' current' : '') + (future ? ' future' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(!!current));
    if (canvas) li.appendChild(thumb(canvas));
    else li.insertAdjacentHTML('beforeend', icon(iconName ?? 'history'));
    const span = document.createElement('span');
    span.className = 'history-label';
    span.textContent = label;
    li.appendChild(span);
    if (title) li.title = title;
    li.addEventListener('click', onClick);
    if (menu) {
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        app.dialogs.popover(li, menu(), { at: { x: e.clientX, y: e.clientY } });
      });
    }
    return li;
  }

  function render() {
    pending = 0;
    const doc = app.doc;
    snapList.replaceChildren();
    states.replaceChildren();
    for (const b of el.querySelectorAll('[data-act]')) b.disabled = !doc;
    if (!doc) {
      states.innerHTML = '<li class="panel-empty">No document open</li>';
      count.textContent = '';
      return;
    }
    const h = doc.history;
    if (selectedSnap && !h.snapshots.includes(selectedSnap)) selectedSnap = null;
    for (const snap of h.snapshots) {
      snapList.appendChild(item({
        label: snap.name,
        canvas: snap.canvas,
        current: snap === selectedSnap,
        title: 'Click: restore this snapshot (undoable). Right-click for more.',
        onClick: () => {
          selectedSnap = snap;
          restoreSnapshot(doc, snap);
        },
        menu: () => [
          { label: 'Restore Snapshot', icon: 'undo', onSelect: () => restoreSnapshot(doc, snap) },
          { label: 'New Document from Snapshot', icon: 'file', onSelect: () => newDocumentFrom(snap.canvas, snap.name, doc) },
          { label: 'Rename Snapshot…', icon: 'edit', onSelect: () => renameSnapshot(doc, snap) },
          { type: 'separator' },
          { label: 'Delete Snapshot', icon: 'trash', onSelect: () => deleteSnapshot(doc, snap) },
        ],
      }));
    }
    snapList.hidden = !h.snapshots.length;
    const initial = doc.path ? 'Open' : 'New';
    states.appendChild(item({
      label: initial,
      iconName: 'file',
      current: h.index === -1,
      onClick: () => goTo(doc, -1),
      title: 'The document before the first recorded change',
    }));
    h.entries.forEach((entry, i) => {
      states.appendChild(item({
        label: entry.label || 'Change',
        iconName: stateIcon(entry.label),
        current: i === h.index,
        future: i > h.index,
        onClick: () => goTo(doc, i),
        title: entry.at ? new Date(entry.at).toLocaleTimeString() : undefined,
      }));
    });
    count.textContent = `${h.index + 1} / ${h.entries.length}`;
    btn('delete').disabled = !selectedSnap;
    // keep the current state in view
    const cur = states.querySelector('.history-item.current');
    if (cur) {
      const body = el.closest('.panel-body') ?? el;
      const r = cur.getBoundingClientRect(), b = body.getBoundingClientRect();
      if (r.bottom > b.bottom || r.top < b.top) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  function goTo(doc, index) {
    if (doc !== app.doc) return;
    app.tools?.active?.commit?.();
    doc.history.goTo(index);
    app.syncUiState();
    schedule();
  }

  function flattened(doc) {
    return flattenDocument(doc, doc.view.compositor);
  }

  async function makeSnapshot() {
    const doc = app.doc;
    if (!doc) return;
    const n = doc.history.snapshots.length + 1;
    doc.history.snapshot(`Snapshot ${n}`, flattened(doc));
    selectedSnap = doc.history.snapshots[doc.history.snapshots.length - 1];
    schedule();
  }

  async function renameSnapshot(doc, snap) {
    const name = await app.dialogs.prompt('Snapshot name', { title: 'Rename Snapshot', value: snap.name });
    if (!name || !name.trim()) return;
    snap.name = name.trim();
    schedule();
  }

  function deleteSnapshot(doc, snap) {
    const i = doc.history.snapshots.indexOf(snap);
    if (i < 0) return;
    doc.history.snapshots.splice(i, 1);
    if (selectedSnap === snap) selectedSnap = null;
    app.emit('history:changed', doc);
    schedule();
  }

  /** Replaces the layers with one layer holding the snapshot pixels, as one undoable step. */
  function restoreSnapshot(doc, snap) {
    if (doc !== app.doc) return;
    app.tools?.active?.commit?.();
    const canvas = copyCanvas(snap.canvas);
    structural(app, `Restore ${snap.name}`, () => {
      const layer = new RasterLayer({ name: snap.name, canvas, x: 0, y: 0 });
      const resized = doc.width !== canvas.width || doc.height !== canvas.height;
      doc.root.children = [layer];
      layer.parent = doc.root;
      doc.root.touch();
      if (resized) {
        doc.width = canvas.width;
        doc.height = canvas.height;
        doc.selection = null;
      }
      doc.setActive(layer);
    }, doc);
    app.setEditingMask(false);
    app.syncUiState();
  }

  function newDocumentFrom(canvas, name, src) {
    const copy = new Document({ width: canvas.width, height: canvas.height, dpi: src?.dpi ?? 72, name });
    const layer = new RasterLayer({ name: 'Background', canvas: copyCanvas(canvas) });
    layer.parent = copy.root;
    copy.root.children.push(layer);
    copy.active = layer;
    copy.selected = new Set([layer]);
    app.docs.add(copy);
    copy.history.markSaved();
    copy.history.savedIndex = -2; // never saved: closing asks
    app.syncUiState();
    return copy;
  }

  btn('snapshot').addEventListener('click', makeSnapshot);
  btn('new-doc').addEventListener('click', () => {
    const doc = app.doc;
    if (!doc) return;
    if (selectedSnap) return newDocumentFrom(selectedSnap.canvas, selectedSnap.name, doc);
    return newDocumentFrom(flattened(doc), `${doc.name.replace(/\.[^.]+$/, '')} copy`, doc);
  });
  btn('delete').addEventListener('click', () => selectedSnap && app.doc && deleteSnapshot(app.doc, selectedSnap));

  app.on('history:changed', (doc) => {
    if (doc === app.doc) schedule();
  });
  app.on('doc:activated', () => {
    selectedSnap = null;
    schedule();
  });
  app.on('doc:saved', schedule);

  app.panels.register({ id: 'history', title: 'History', icon: 'history', element: el, group: 'bottom', onShow: render });
  render();
  app.historyPanel = { snapshot: makeSnapshot, restoreSnapshot, newDocumentFrom };
  return { render };
}
