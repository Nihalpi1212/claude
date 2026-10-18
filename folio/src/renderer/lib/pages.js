// Page tools: organize pages (reorder, rotate, delete, insert, extract), split, crop, create a PDF
// from images and combine files.
import * as engine from '../../shared/engine.js';
import { bridge, joinPath } from './bridge.js';
import { icon } from './icons.js';
import { parsePageRanges, formatPageRanges } from '../../shared/page-ranges.js';

const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }];
const PDF_FILTERS = [{ name: 'PDF files', extensions: ['pdf'] }];

export function install(app) {
  const has = () => !!app.session;
  const view = () => app.view;

  app.commands.registerAll({
    'pages:organize': { enabled: has, run: () => organizeDialog(app) },
    'pages:rotate': { enabled: has, run: ({ indices, delta = 90 } = {}) => {
      const idx = indices ?? [view().page - 1];
      return app.edit.apply((bytes) => engine.rotatePages(bytes, idx, delta), { label: `Rotate page${idx.length > 1 ? 's' : ''}` });
    } },
    'pages:delete': { enabled: has, run: async ({ indices } = {}) => {
      const idx = indices ?? [view().page - 1];
      if (view().numPages - idx.length < 1) {
        app.dialogs.toast('A document needs at least one page', { kind: 'error' });
        return;
      }
      const ok = await app.dialogs.confirm(`Delete ${idx.length === 1 ? `page ${idx[0] + 1}` : `${idx.length} pages (${formatPageRanges(idx)})`}?`, { title: 'Delete pages', okLabel: 'Delete', danger: true });
      if (!ok) return;
      await app.edit.apply((bytes) => engine.deletePages(bytes, idx), { label: 'Delete pages' });
    } },
    'pages:insert': { enabled: has, run: ({ at } = {}) => insertPages(app, at) },
    'pages:extract': { enabled: has, run: ({ indices } = {}) => extractPages(app, indices) },
    'pages:split': { enabled: has, run: () => splitDialog(app) },
    'pages:crop': { enabled: has, run: () => cropDialog(app) },
    'file:new-from-images': { run: () => newFromImages(app) },
    'file:merge': { run: () => mergeDialog(app) },
  });

  app.toolbar.addButton({ id: 'organize', group: 'tools', icon: 'pages', title: 'Organize pages', command: 'pages:organize' });
}

// ---- organize dialog ----------------------------------------------------------------------------------
async function organizeDialog(app) {
  const session = app.session;
  if (!session) return;
  const v = session.view;
  const info = await engine.getPageInfo(await session.flush());
  // working model: items reference original page indices
  let items = info.pages.map((p, i) => ({ index: i, rotation: 0, selected: false, width: p.width, height: p.height }));
  const content = document.createElement('div');
  content.className = 'organize';
  content.innerHTML = `
    <div class="organize-toolbar">
      <button class="btn" data-act="rotate-ccw" title="Rotate selected counter-clockwise">${icon('rotate-ccw')}</button>
      <button class="btn" data-act="rotate-cw" title="Rotate selected clockwise">${icon('rotate-cw')}</button>
      <button class="btn" data-act="left" title="Move selected left">${icon('chevron-left')}</button>
      <button class="btn" data-act="right" title="Move selected right">${icon('chevron-right')}</button>
      <button class="btn danger" data-act="delete" title="Delete selected">${icon('trash')} Delete</button>
      <span class="organize-spacer"></span>
      <button class="btn" data-act="insert">${icon('insert')} Insert…</button>
      <button class="btn" data-act="extract">${icon('extract')} Extract…</button>
      <button class="btn quiet" data-act="all">Select all</button>
      <button class="btn quiet" data-act="none">Clear</button>
      <button class="btn quiet" data-act="reverse">Reverse order</button>
    </div>
    <div class="organize-hint muted">Click to select, Shift-click for a range, drag to reorder. Changes apply when you press Apply.</div>
    <div class="organize-grid" role="list"></div>`;
  const grid = content.querySelector('.organize-grid');
  const thumbs = new Map(); // original index -> canvas promise
  let lastClicked = -1;

  const thumb = (index) => {
    if (!thumbs.has(index)) thumbs.set(index, v.renderPage(index, { width: 120, dpr: Math.min(2, window.devicePixelRatio || 1) }).catch(() => null));
    return thumbs.get(index);
  };

  function render() {
    grid.replaceChildren();
    items.forEach((item, pos) => {
      const card = document.createElement('div');
      card.className = 'organize-card' + (item.selected ? ' selected' : '');
      card.setAttribute('role', 'listitem');
      card.draggable = true;
      card.dataset.pos = String(pos);
      card.innerHTML = `<div class="organize-frame"><div class="thumb-placeholder"></div></div><div class="organize-label">${pos + 1}<span class="muted"> (was ${item.index + 1})</span></div><div class="organize-card-actions"><button class="tb-button" data-rot="-90" title="Rotate left">${icon('rotate-ccw')}</button><button class="tb-button" data-rot="90" title="Rotate right">${icon('rotate-cw')}</button></div>`;
      const frame = card.querySelector('.organize-frame');
      thumb(item.index).then((canvas) => {
        if (!canvas) return;
        const c = canvas.cloneNode(true);
        c.getContext('2d').drawImage(canvas, 0, 0);
        c.style.width = '100%';
        c.style.height = 'auto';
        c.style.transform = `rotate(${item.rotation}deg)`;
        frame.replaceChildren(c);
      });
      card.addEventListener('click', (event) => {
        if (event.target.closest('[data-rot]')) return;
        if (event.shiftKey && lastClicked >= 0) {
          const [a, b] = [Math.min(lastClicked, pos), Math.max(lastClicked, pos)];
          for (let i = a; i <= b; i++) items[i].selected = true;
        } else if (event.ctrlKey || event.metaKey) {
          item.selected = !item.selected;
        } else {
          const only = item.selected && items.filter((x) => x.selected).length === 1;
          for (const x of items) x.selected = false;
          item.selected = !only;
        }
        lastClicked = pos;
        render();
      });
      for (const b of card.querySelectorAll('[data-rot]')) {
        b.addEventListener('click', (event) => {
          event.stopPropagation();
          item.rotation = (item.rotation + Number(b.dataset.rot) + 360) % 360;
          render();
        });
      }
      card.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', String(pos));
        event.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (event) => {
        event.preventDefault();
        card.classList.add('drop-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', (event) => {
        event.preventDefault();
        card.classList.remove('drop-target');
        const from = Number(event.dataTransfer.getData('text/plain'));
        if (!Number.isInteger(from) || from === pos) return;
        const [moved] = items.splice(from, 1);
        items.splice(pos, 0, moved);
        render();
      });
      grid.appendChild(card);
    });
  }

  const selectedPositions = () => items.map((it, i) => (it.selected ? i : -1)).filter((i) => i >= 0);
  content.querySelector('.organize-toolbar').addEventListener('click', async (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const sel = selectedPositions();
    switch (act) {
      case 'rotate-cw':
      case 'rotate-ccw':
        for (const i of sel.length ? sel : items.map((_, i) => i)) items[i].rotation = (items[i].rotation + (act === 'rotate-cw' ? 90 : 270)) % 360;
        break;
      case 'left':
        for (const i of sel) if (i > 0 && !items[i - 1].selected) [items[i - 1], items[i]] = [items[i], items[i - 1]];
        break;
      case 'right':
        for (const i of sel.slice().reverse()) if (i < items.length - 1 && !items[i + 1].selected) [items[i + 1], items[i]] = [items[i], items[i + 1]];
        break;
      case 'delete':
        if (!sel.length) return app.dialogs.toast('Select pages first', { timeout: 1200 });
        if (sel.length >= items.length) return app.dialogs.toast('Keep at least one page', { kind: 'error' });
        items = items.filter((it) => !it.selected);
        break;
      case 'all':
        for (const it of items) it.selected = true;
        break;
      case 'none':
        for (const it of items) it.selected = false;
        break;
      case 'reverse':
        items.reverse();
        break;
      case 'insert': {
        closeFn?.(null);
        await insertPages(app, sel.length ? sel[sel.length - 1] + 1 : undefined);
        return;
      }
      case 'extract': {
        closeFn?.(null);
        await extractPages(app, sel.length ? sel.map((i) => items[i].index) : undefined);
        return;
      }
    }
    render();
  });
  render();

  let closeFn = null;
  const result = await app.dialogs.open({
    title: `Organize pages — ${session.name}`,
    content,
    className: 'wide organize-dialog',
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: true, primary: true }],
    onOpen: (_d, close) => {
      closeFn = close;
    },
  });
  if (!result) return;
  const order = items.map((it) => it.index);
  const rotations = items.map((it) => it.rotation);
  const unchanged = order.length === info.count && order.every((o, i) => o === i) && rotations.every((r) => r === 0);
  if (unchanged) return;
  await app.edit.apply(
    async (bytes) => {
      let out = bytes;
      // 1. delete pages that are gone, 2. reorder the survivors, 3. rotate by new position
      const kept = new Set(order);
      const removed = info.pages.map((_, i) => i).filter((i) => !kept.has(i));
      if (removed.length) out = await engine.deletePages(out, removed);
      const survivors = info.pages.map((_, i) => i).filter((i) => kept.has(i)); // old indices in ascending order = new numbering after deletion
      const newOrder = order.map((old) => survivors.indexOf(old));
      if (newOrder.some((o, i) => o !== i)) out = await engine.reorderPages(out, newOrder);
      for (const delta of [90, 180, 270]) {
        const idx = rotations.map((r, i) => (r === delta ? i : -1)).filter((i) => i >= 0);
        if (idx.length) out = await engine.rotatePages(out, idx, delta);
      }
      return out;
    },
    { label: 'Organize pages', keepPosition: false }
  );
}

// ---- insert / extract / split / crop -------------------------------------------------------------------
async function insertPages(app, at) {
  const session = app.session;
  if (!session) return;
  const v = session.view;
  const [path] = await bridge.openFileDialog({ filters: PDF_FILTERS, title: 'Insert pages from' });
  if (!path) return;
  let other;
  try {
    other = await bridge.readFile(path);
  } catch (err) {
    app.reportError(err, 'Could not read the file');
    return;
  }
  let position = at;
  if (!Number.isInteger(position)) {
    const answer = await app.dialogs.prompt(`Insert after page (0 = at the beginning, ${v.numPages} = at the end)`, { title: 'Insert pages', type: 'number', value: String(v.page), min: 0, max: v.numPages, okLabel: 'Insert' });
    if (answer === null) return;
    position = Math.max(0, Math.min(v.numPages, Number(answer) || 0));
  }
  await app.edit.apply((bytes) => engine.insertPages(bytes, other, position), { label: 'Insert pages', keepPosition: false });
  app.dialogs.toast(`Inserted pages from ${path.split(/[\\/]/).pop()}`, { kind: 'success', timeout: 2000 });
}

async function extractPages(app, indices) {
  const session = app.session;
  if (!session) return;
  const v = session.view;
  let idx = indices;
  if (!idx) {
    const answer = await app.dialogs.prompt(`Pages to extract (e.g. 1-3, 5), out of ${v.numPages}`, { title: 'Extract pages', value: String(v.page), okLabel: 'Extract' });
    if (answer === null) return;
    try {
      idx = parsePageRanges(answer, v.numPages);
    } catch (err) {
      app.dialogs.toast(err.message, { kind: 'error' });
      return;
    }
  }
  if (!idx.length) return;
  const target = await bridge.saveFileDialog({ defaultPath: session.name.replace(/\.pdf$/i, '') + `-pages-${formatPageRanges(idx).replace(/[^0-9-]+/g, '_')}.pdf`, title: 'Save extracted pages' });
  if (!target) return;
  try {
    const bytes = await engine.extractPages(await session.flush(), idx);
    await bridge.writeFile(target, bytes);
  } catch (err) {
    app.reportError(err, 'Could not extract the pages');
    return;
  }
  app.dialogs.toast('Pages extracted', { kind: 'success', timeout: 2500, action: { label: 'Open', run: () => app.tabs.open({ path: target }) } });
}

async function splitDialog(app) {
  const session = app.session;
  if (!session) return;
  const v = session.view;
  const content = document.createElement('div');
  content.innerHTML = `
    <label class="checkbox"><input type="radio" name="split-mode" value="every" checked> Every <input class="input" type="number" min="1" value="1" style="width:70px;display:inline-block;margin:0 4px" data-every> page(s)</label>
    <label class="checkbox"><input type="radio" name="split-mode" value="ranges"> Custom ranges, one part per line (e.g. 1-3)</label>
    <textarea class="textarea" data-ranges placeholder="1-3\n4-6\n7"></textarea>
    <p class="muted">Parts are saved next to each other as <em>${session.name.replace(/\.pdf$/i, '')}-part1.pdf</em>, <em>-part2.pdf</em>, …</p>`;
  const ok = await app.dialogs.open({ title: `Split ${session.name} (${v.numPages} pages)`, content, buttons: [{ label: 'Cancel', value: null }, { label: 'Split…', value: true, primary: true }] });
  if (!ok) return;
  const mode = content.querySelector('input[name="split-mode"]:checked').value;
  let ranges = [];
  try {
    if (mode === 'every') {
      const n = Math.max(1, Number(content.querySelector('[data-every]').value) || 1);
      for (let start = 0; start < v.numPages; start += n) ranges.push(Array.from({ length: Math.min(n, v.numPages - start) }, (_, i) => start + i));
    } else {
      ranges = content.querySelector('[data-ranges]').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => parsePageRanges(l, v.numPages));
    }
  } catch (err) {
    app.dialogs.toast(err.message, { kind: 'error' });
    return;
  }
  if (!ranges.length) return;
  const dir = await bridge.openDirectoryDialog({ title: 'Choose where to save the parts' });
  const base = session.name.replace(/\.pdf$/i, '');
  let parts;
  try {
    parts = await engine.splitByRanges(await session.flush(), ranges);
  } catch (err) {
    app.reportError(err, 'Could not split the document');
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    const name = `${base}-part${i + 1}.pdf`;
    const target = dir ? joinPath(dir, name) : await bridge.saveFileDialog({ defaultPath: name, title: `Save part ${i + 1} of ${parts.length}` });
    if (!target) return;
    await bridge.writeFile(target, parts[i]);
  }
  app.dialogs.toast(`Saved ${parts.length} part${parts.length === 1 ? '' : 's'}`, { kind: 'success' });
}

async function cropDialog(app) {
  const session = app.session;
  if (!session) return;
  const v = session.view;
  const info = await engine.getPageInfo(await session.flush());
  const unit = app.settings.measureUnit ?? 'mm';
  const perPt = { mm: 25.4 / 72, cm: 2.54 / 72, in: 1 / 72, pt: 1 }[unit] ?? 1;
  const content = document.createElement('div');
  content.innerHTML = `
    <div class="field-row">
      <label class="field"><span>Top (${unit})</span><input class="input" type="number" step="any" value="0" data-m="top"></label>
      <label class="field"><span>Bottom (${unit})</span><input class="input" type="number" step="any" value="0" data-m="bottom"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Left (${unit})</span><input class="input" type="number" step="any" value="0" data-m="left"></label>
      <label class="field"><span>Right (${unit})</span><input class="input" type="number" step="any" value="0" data-m="right"></label>
    </div>
    <label class="checkbox"><input type="radio" name="crop-scope" value="current" checked> Current page only (page ${v.page})</label>
    <label class="checkbox"><input type="radio" name="crop-scope" value="all"> All pages</label>
    <p class="muted">Cropping hides the margins without removing content; enter 0 for every margin to restore the full page.</p>`;
  const ok = await app.dialogs.open({ title: 'Crop pages', content, buttons: [{ label: 'Cancel', value: null }, { label: 'Crop', value: true, primary: true }] });
  if (!ok) return;
  const m = Object.fromEntries([...content.querySelectorAll('[data-m]')].map((el) => [el.dataset.m, (Number(el.value) || 0) / perPt]));
  const scope = content.querySelector('input[name="crop-scope"]:checked').value;
  const indices = scope === 'all' ? info.pages.map((_, i) => i) : [v.page - 1];
  await app.edit.apply(async (bytes) => {
    let out = bytes;
    for (const i of indices) {
      const p = info.pages[i];
      const box = { x: m.left, y: m.bottom, width: Math.max(10, p.width - m.left - m.right), height: Math.max(10, p.height - m.top - m.bottom) };
      out = await engine.cropPages(out, [i], box);
    }
    return out;
  }, { label: 'Crop pages' });
}

// ---- create from images / combine -----------------------------------------------------------------------
async function newFromImages(app) {
  const paths = await bridge.openFileDialog({ multiple: true, filters: IMAGE_FILTERS, title: 'Choose images' });
  if (!paths.length) return;
  const images = [];
  for (const path of paths) {
    try {
      const bytes = await bridge.readFile(path);
      images.push({ bytes, type: /\.jpe?g$/i.test(path) ? 'jpeg' : 'png', name: path.split(/[\\/]/).pop() });
    } catch (err) {
      app.reportError(err, `Could not read ${path}`);
    }
  }
  if (!images.length) return;
  const content = document.createElement('div');
  content.innerHTML = `<p>${images.length} image${images.length === 1 ? '' : 's'} selected.</p>
    <label class="field"><span>Page size</span><select class="select" data-size><option value="fit">Same as each image</option><option value="A4">A4</option><option value="Letter">Letter</option><option value="Legal">Legal</option><option value="A3">A3</option></select></label>
    <label class="checkbox"><input type="checkbox" data-landscape> Landscape</label>
    <label class="field"><span>Margin (points)</span><input class="input" type="number" min="0" value="36" data-margin></label>`;
  const ok = await app.dialogs.open({ title: 'Create PDF from images', content, buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: true, primary: true }] });
  if (!ok) return;
  const pageSize = content.querySelector('[data-size]').value;
  const landscape = content.querySelector('[data-landscape]').checked;
  const margin = Math.max(0, Number(content.querySelector('[data-margin]').value) || 0);
  try {
    const bytes = await engine.imagesToPdf(images, { pageSize, margin: pageSize === 'fit' ? 0 : margin, landscape });
    const session = await app.tabs.open({ bytes, name: (images[0].name.replace(/\.[^.]+$/, '') || 'Images') + '.pdf' });
    if (session) session.opsDirty = true;
    app.emit('doc:dirty', { session, dirty: true });
  } catch (err) {
    app.reportError(err, 'Could not create the PDF');
  }
}

async function mergeDialog(app) {
  const files = [];
  if (app.session?.path) files.push({ path: app.session.path, name: app.session.name, session: app.session });
  const content = document.createElement('div');
  content.className = 'merge';
  content.innerHTML = `<div class="merge-list" role="list"></div><div class="sign-row"><button class="btn" data-add>${icon('plus')} Add files…</button><span class="muted">Files are combined in the order shown; drag to reorder.</span></div>`;
  const list = content.querySelector('.merge-list');
  function render() {
    list.replaceChildren();
    if (!files.length) list.innerHTML = '<div class="muted" style="padding:12px">No files yet.</div>';
    files.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'merge-row';
      row.draggable = true;
      row.innerHTML = `${icon('file')}<span class="merge-name"></span><button class="tb-button" data-up title="Move up">${icon('up')}</button><button class="tb-button" data-down title="Move down">${icon('down')}</button><button class="tb-button" data-remove title="Remove">${icon('close')}</button>`;
      row.querySelector('.merge-name').textContent = f.name;
      row.querySelector('[data-up]').addEventListener('click', () => {
        if (i > 0) [files[i - 1], files[i]] = [files[i], files[i - 1]];
        render();
      });
      row.querySelector('[data-down]').addEventListener('click', () => {
        if (i < files.length - 1) [files[i + 1], files[i]] = [files[i], files[i + 1]];
        render();
      });
      row.querySelector('[data-remove]').addEventListener('click', () => {
        files.splice(i, 1);
        render();
      });
      row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i)));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isInteger(from) || from === i) return;
        const [moved] = files.splice(from, 1);
        files.splice(i, 0, moved);
        render();
      });
      list.appendChild(row);
    });
  }
  content.querySelector('[data-add]').addEventListener('click', async () => {
    const paths = await bridge.openFileDialog({ multiple: true, filters: PDF_FILTERS, title: 'Add PDF files' });
    for (const path of paths) if (!files.some((f) => f.path === path)) files.push({ path, name: path.split(/[\\/]/).pop() });
    render();
  });
  render();
  const ok = await app.dialogs.open({ title: 'Combine files into one PDF', content, width: 560, buttons: [{ label: 'Cancel', value: null }, { label: 'Combine', value: true, primary: true }], validate: () => files.length > 0 || (app.dialogs.toast('Add at least one file', { timeout: 1500 }), false) });
  if (!ok) return;
  const list2 = [];
  for (const f of files) {
    try {
      list2.push(f.session ? await f.session.flush() : await bridge.readFile(f.path));
    } catch (err) {
      app.reportError(err, `Could not read ${f.name}`);
      return;
    }
  }
  try {
    const bytes = await engine.mergeDocuments(list2);
    const session = await app.tabs.open({ bytes, name: 'Combined.pdf' });
    if (session) {
      session.opsDirty = true;
      app.emit('doc:dirty', { session, dirty: true });
    }
  } catch (err) {
    app.reportError(err, 'Could not combine the files');
  }
}
