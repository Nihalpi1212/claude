// Paths panel: the Work Path, saved paths (doc.paths) and the active shape layer's path, each with a
// thumbnail. Click selects (app.ui.activePath, drawn by the vector tools), double-click renames a
// saved path or saves the work path, Ctrl/Cmd-click loads a path as a selection; footer buttons fill,
// stroke, load as selection, make a work path from the selection, save, create and delete paths.
import { icon } from '../icons.js';
import { pathToPath2D } from '../document.js';
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
    ctx.fill(pathToPath2D(path), 'nonzero');
    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = '#2b2b33';
    ctx.stroke(pathToPath2D(path));
    thumbs.set(path, { key, canvas: c });
    return c;
  }

  function render() {
    pending = 0;
    if (renaming) return;
    const doc = app.doc;
    list.replaceChildren();
    if (!doc) {
      list.innerHTML = '<li class="panel-empty">No document open</li>';
      updateButtons();
      return;
    }
    const all = rows();
    if (!all.length) {
      const li = document.createElement('li');
      li.className = 'panel-empty';
      li.textContent = 'No paths. Draw with the Pen or a Shape tool in Path mode, or make a work path from a selection.';
      list.appendChild(li);
    }
    const current = activePathTarget(app)?.key ?? null;
    for (const r of all) list.appendChild(row(r, r.key === current));
    updateButtons();
  }

  function row(r, selected) {
    const li = document.createElement('li');
    li.className = 'path-row' + (selected ? ' selected' : '');
    li.dataset.key = r.key;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(selected));
    const t = document.createElement('span');
    t.className = 'path-thumb';
    t.appendChild(thumb(r.path));
    const name = document.createElement('span');
    name.className = 'path-name' + (r.italic ? ' italic' : '');
    name.textContent = r.name;
    li.append(t, name);
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      setActivePath(app, r.ap);
      render();
      if (e.ctrlKey || e.metaKey) {
        const op = e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
        app.commands.run('path:make-selection', { op }, 'panel');
      }
    });
    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (r.ap.kind === 'saved') startRename(r, name);
      else if (r.ap.kind === 'work') app.commands.run('path:save', undefined, 'panel');
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setActivePath(app, r.ap);
      render();
      const run = (cmd, arg) => () => app.commands.run(cmd, arg, 'panel');
      app.dialogs.popover(li, [
        ...(r.ap.kind === 'work' ? [{ label: 'Save Path…', onSelect: run('path:save') }] : []),
        ...(r.ap.kind === 'saved' ? [{ label: 'Rename Path…', onSelect: () => startRename(r, name) }] : []),
        ...(r.ap.kind !== 'shape' ? [{ label: 'Delete Path', onSelect: run('path:delete') }, { type: 'separator' }] : []),
        { label: 'Make Selection…', onSelect: run('path:make-selection') },
        { label: 'Fill Path…', onSelect: run('path:fill') },
        { label: 'Stroke Path…', onSelect: run('path:stroke') },
      ], { at: { x: e.clientX, y: e.clientY } });
    });
    return li;
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
    if (e.target === list && app.ui.activePath) {
      setActivePath(app, null);
      render();
    }
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
