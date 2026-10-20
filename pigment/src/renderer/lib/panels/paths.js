// Paths panel: the Work Path, saved paths (doc.paths) and the active shape layer's path, each with a
// thumbnail. Click selects (app.ui.activePath, drawn by the vector tools), double-click renames a
// saved path or saves the work path, Ctrl/Cmd-click loads a path as a selection; footer buttons fill,
// stroke, load as selection, make a work path from the selection, save, create and delete paths.
import { icon } from '../icons.js';
import { pathToPath2D, createCanvas } from '../document.js';
import { pathAreaCanvas, hasPathOps } from '../path-ops.js';
import { activePathTarget, setActivePath, isEmptyPath } from '../tools/vector.js';

const TW = 40, TH = 30;

export function install(app) {
  const el = document.createElement('div');
  el.className = 'paths-panel';
  el.innerHTML = `
    <ul class="path-list" role="listbox" aria-label="Paths"></ul>
    <div class="panel-footer">
      <button class="pbtn" data-cmd="path:fill" title="Fill path with foreground colour (Alt-click for options)">${icon('fill')}</button>
      <button class="pbtn" data-cmd="path:stroke" title="Stroke path with brush (Alt-click for options)">${icon('brush')}</button>
      <button class="pbtn" data-cmd="path:make-selection" title="Load path as a selection (Alt-click for options)">${icon('marquee-rect')}</button>
      <button class="pbtn" data-cmd="path:from-selection" title="Make work path from selection (Alt-click for options)">${icon('pen')}</button>
      <span style="flex:1"></span>
      <button class="pbtn" data-cmd="path:save" title="Save the work path">${icon('save')}</button>
      <button class="pbtn" data-cmd="path:new" title="Create new path">${icon('plus')}</button>
      <button class="pbtn" data-cmd="path:delete" title="Delete path">${icon('trash')}</button>
    </div>`;
  const list = el.querySelector('.path-list');
  const thumbs = new WeakMap(); // path object -> { key, canvas }
  let renaming = null;
  let pending = 0;

  for (const b of el.querySelectorAll('[data-cmd]')) {
    b.addEventListener('click', (e) => {
      const cmd = b.dataset.cmd;
      const direct = ['path:fill', 'path:stroke', 'path:make-selection', 'path:from-selection'].includes(cmd);
      app.commands.run(cmd, direct && !e.altKey ? {} : undefined, 'panel');
    });
  }

  function rows() {
    const doc = app.doc;
    if (!doc) return [];
    const out = [];
    if (doc.workPath && !isEmptyPath(doc.workPath)) out.push({ key: 'work', ap: { kind: 'work' }, name: 'Work Path', path: doc.workPath, italic: true });
    for (const p of doc.paths) out.push({ key: `saved:${p.id}`, ap: { kind: 'saved', id: p.id }, name: p.name, path: p.path, id: p.id });
    if (doc.active?.type === 'shape') out.push({ key: `shape:${doc.active.id}`, ap: { kind: 'shape', layerId: doc.active.id }, name: `${doc.active.name} Shape Path`, path: doc.active.path, italic: true });
    return out;
  }

  function thumb(path) {
    const doc = app.doc;
    const key = `${doc.width}x${doc.height}`;
    const cached = thumbs.get(path);
    if (cached?.key === key) return cached.canvas;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const c = document.createElement('canvas');
    c.width = TW * dpr;
    c.height = TH * dpr;
    const ctx = c.getContext('2d');
    const s = Math.min(TW / doc.width, TH / doc.height);
    const ox = (TW - doc.width * s) / 2, oy = (TH - doc.height * s) / 2;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox, oy, doc.width * s, doc.height * s);
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    ctx.fillStyle = '#5a5a66';
    if (hasPathOps(path)) {
      // subtract / intersect / exclude components: tint the combined area instead of a plain non-zero fill
      const area = pathAreaCanvas(path, doc.width, doc.height);
      const tinted = createCanvas(doc.width, doc.height);
      const tctx = tinted.getContext('2d');
      tctx.fillStyle = '#5a5a66';
      tctx.fillRect(0, 0, doc.width, doc.height);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(area, 0, 0);
      ctx.drawImage(tinted, 0, 0);
    } else ctx.fill(pathToPath2D(path), 'nonzero');
    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = '#2b2b33';
    ctx.stroke(pathToPath2D(path));
    thumbs.set(path, { key, canvas: c });
    return c;
  }

  const rowEls = new Map(); // key -> { li, nameEl, thumbEl, path, name, r }
  let emptyEl = null;

  /** Updates the list in place (rows keep their nodes, so double-clicks and renames survive refreshes). */
  function render() {
    pending = 0;
    if (renaming) return;
    const doc = app.doc;
    const all = doc ? rows() : [];
    const current = activePathTarget(app)?.key ?? null;
    const order = [];
    for (const r of all) {
      let e = rowEls.get(r.key);
      if (!e) {
        e = buildRow(r);
        rowEls.set(r.key, e);
      }
      e.r = r;
      if (e.path !== r.path || e.docSize !== `${doc.width}x${doc.height}`) {
        e.thumbEl.replaceChildren(thumb(r.path));
        e.path = r.path;
        e.docSize = `${doc.width}x${doc.height}`;
      }
      if (e.name !== r.name) {
        e.nameEl.textContent = r.name;
        e.name = r.name;
      }
      e.li.classList.toggle('selected', r.key === current);
      e.li.setAttribute('aria-selected', String(r.key === current));
      order.push(e.li);
    }
    const keys = new Set(all.map((r) => r.key));
    for (const [k, e] of rowEls) if (!keys.has(k)) {
      e.li.remove();
      rowEls.delete(k);
    }
    if (!all.length) {
      emptyEl ??= document.createElement('li');
      emptyEl.className = 'panel-empty';
      emptyEl.textContent = doc ? 'No paths. Draw with the Pen or a Shape tool in Path mode, or make a work path from a selection.' : 'No document open';
      order.push(emptyEl);
    }
    const same = order.length === list.children.length && order.every((n, i) => list.children[i] === n);
    if (!same) list.replaceChildren(...order);
    updateButtons();
  }

  function buildRow(r0) {
    const e = { r: r0 };
    const li = document.createElement('li');
    li.className = 'path-row';
    li.dataset.key = r0.key;
    li.setAttribute('role', 'option');
    const t = document.createElement('span');
    t.className = 'path-thumb';
    const name = document.createElement('span');
    name.className = 'path-name' + (r0.italic ? ' italic' : '');
    li.append(t, name);
    Object.assign(e, { li, thumbEl: t, nameEl: name });
    li.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (renaming) return;
      setActivePath(app, e.r.ap);
      if (ev.ctrlKey || ev.metaKey) {
        const op = ev.shiftKey && ev.altKey ? 'intersect' : ev.shiftKey ? 'add' : ev.altKey ? 'subtract' : 'replace';
        app.commands.run('path:make-selection', { op }, 'panel');
      }
    });
    li.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      if (e.r.ap.kind === 'saved') startRename(e.r, name);
      else if (e.r.ap.kind === 'work') app.commands.run('path:save', undefined, 'panel');
    });
    li.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const r = e.r;
      setActivePath(app, r.ap);
      const run = (cmd, arg) => () => app.commands.run(cmd, arg, 'panel');
      app.dialogs.popover(li, [
        ...(r.ap.kind === 'work' ? [{ label: 'Save Path…', onSelect: run('path:save') }] : []),
        ...(r.ap.kind === 'saved' ? [{ label: 'Rename Path…', onSelect: () => startRename(r, name) }] : []),
        ...(r.ap.kind !== 'shape' ? [{ label: 'Delete Path', onSelect: run('path:delete') }, { type: 'separator' }] : []),
        { label: 'Make Selection…', onSelect: run('path:make-selection') },
        { label: 'Fill Path…', onSelect: run('path:fill') },
        { label: 'Stroke Path…', onSelect: run('path:stroke') },
      ], { at: { x: ev.clientX, y: ev.clientY } });
    });
    return e;
  }

  function startRename(r, nameEl) {
    renaming = r.id;
    const input = document.createElement('input');
    input.className = 'input';
    input.value = r.name;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    const done = (commit) => {
      if (renaming !== r.id) return;
      renaming = null;
      nameEl.textContent = r.name;
      if (commit && input.value.trim() && input.value.trim() !== r.name) app.commands.run('path:rename', { id: r.id, name: input.value.trim() }, 'panel');
      render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  function updateButtons() {
    for (const b of el.querySelectorAll('[data-cmd]')) b.disabled = !app.commands.isEnabled(b.dataset.cmd);
  }

  // clicking the empty part of the list deselects (hides the path outline)
  list.addEventListener('click', (e) => {
    if ((e.target === list || e.target === emptyEl) && app.ui.activePath) setActivePath(app, null);
  });

  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(render);
  };
  app.on('doc:activated', schedule);
  app.on('doc:change', (e) => {
    if (['paths', 'history', 'tree', 'active', 'props', 'canvas', 'selection'].includes(e.kind)) schedule();
  });
  app.on('path:selected', schedule);
  app.on('selection:changed', schedule);

  app.panels.register({ id: 'paths', title: 'Paths', icon: 'paths', element: el, group: 'middle', onShow: render });
  render();
  return { render };
}
