// Welcome screen shown when no document is open: actions, drop zone, recent files, feature tour.
import { bridge } from './bridge.js';
import { icon } from './icons.js';

const FEATURES = [
  ['View', 'Continuous, single-page and two-page layouts, zoom to fit, rotate, night mode, presentation mode.'],
  ['Search', 'Find text with match case and whole word options and jump between results.'],
  ['Comment', 'Highlight, underline, strike through, sticky notes, text boxes, freehand drawing, shapes and stamps.'],
  ['Fill & Sign', 'Fill in forms, then draw, type or upload your signature and place it anywhere.'],
  ['Organize', 'Rotate, reorder, delete, insert and extract pages; combine files; split documents.'],
  ['Export', 'Save text, page images or form data; flatten annotations; print.'],
];

export function install(app) {
  const root = document.getElementById('welcome');
  root.innerHTML = `
    <div class="welcome-inner">
      <div class="welcome-hero">
        <img src="/build/icon.png" alt="" onerror="this.style.display='none'">
        <div><h1>Pigment</h1><p>Free, open-source PDF reader for Windows and macOS. View, comment, fill and sign, organize pages.</p></div>
      </div>
      <div class="welcome-actions">
        <button class="btn primary" data-command="file:open">${icon('open')} Open PDF…</button>
        <button class="btn" data-command="file:new-from-images">${icon('image')} Create PDF from images…</button>
        <button class="btn" data-command="file:merge">${icon('merge')} Combine files…</button>
      </div>
      <div class="welcome-drop" id="welcome-drop">Drag and drop PDF files anywhere in this window to open them</div>
      <h2>Recent files</h2>
      <div class="recent-list" id="recent-list"></div>
      <h2>What you can do</h2>
      <div class="welcome-features">${FEATURES.map(([t, d]) => `<div class="welcome-feature"><strong>${t}</strong>${d}</div>`).join('')}</div>
    </div>`;
  for (const btn of root.querySelectorAll('[data-command]')) {
    btn.addEventListener('click', () => app.commands.run(btn.dataset.command, undefined, 'toolbar'));
  }

  const list = root.querySelector('#recent-list');
  async function renderRecent() {
    const recent = await bridge.getRecent();
    list.replaceChildren();
    if (!recent.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Files you open will show up here.';
      list.appendChild(empty);
      return;
    }
    for (const entry of recent) {
      const item = document.createElement('button');
      item.className = 'recent-item';
      item.type = 'button';
      item.title = entry.path;
      item.innerHTML = `${icon('file')}<span class="recent-text"><span class="recent-name"></span><span class="recent-path"></span></span><span class="recent-remove" role="button" title="Remove from list">${icon('close')}</span>`;
      item.querySelector('.recent-name').textContent = entry.name;
      item.querySelector('.recent-path').textContent = entry.path;
      item.addEventListener('click', (event) => {
        if (event.target.closest('.recent-remove')) {
          event.stopPropagation();
          bridge.removeRecent(entry.path).then(() => app.emit('recent:changed'));
          return;
        }
        app.commands.run('file:open-recent', entry.path, 'toolbar');
      });
      list.appendChild(item);
    }
  }
  app.on('recent:changed', renderRecent);
  app.on('tab:activated', (session) => {
    if (!session) renderRecent();
  });
  renderRecent();
}
