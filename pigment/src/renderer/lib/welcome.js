// Welcome screen shown when no document is open: new/open actions, quick canvas presets, recent
// files and a short feature tour.
import { bridge } from './bridge.js';
import { icon } from './icons.js';

const PRESETS = [
  ['Full HD', 1920, 1080, 72],
  ['Square post', 1080, 1080, 72],
  ['Story', 1080, 1920, 72],
  ['4K UHD', 3840, 2160, 72],
  ['A4 print', 2480, 3508, 300],
  ['Letter print', 2550, 3300, 300],
  ['App icon', 1024, 1024, 72],
];

const FEATURES = [
  ['Layers', 'Groups, masks, clipping masks, 27 blend modes, adjustment and fill layers, layer styles (shadows, glows, bevel, stroke, overlays).'],
  ['Paint & retouch', 'Brush, pencil, erasers, clone and pattern stamps, healing and spot healing, patch, dodge, burn, sponge, smudge.'],
  ['Select', 'Marquee, lasso, magnetic lasso, magic wand, quick selection, color range, quick mask, refine with feather, grow and more.'],
  ['Adjust & filter', 'Levels, curves, hue/saturation and 15 more adjustments; 40+ filters from Gaussian blur to oil paint, with live preview.'],
  ['Type & vectors', 'Editable text, shapes and the pen tool with paths you can fill, stroke or turn into selections.'],
  ['Files', 'Open and save PSD (layers kept) and Pigment documents; export PNG, JPEG and WebP; paste from the clipboard.'],
];

export function install(app) {
  const root = document.getElementById('welcome');
  root.innerHTML = `
    <div class="welcome-inner">
      <div class="welcome-hero">
        <img src="/build/icon.png" alt="" onerror="this.style.display='none'">
        <div><h1>Pigment</h1><p>Free, open-source image editor. Layers, masks, brushes, selections, adjustments, filters, text and vectors.</p></div>
      </div>
      <div class="welcome-actions">
        <button class="btn primary" data-command="file:new">${icon('plus')} New image…</button>
        <button class="btn" data-command="file:open">${icon('open')} Open…</button>
        <button class="btn" data-command="edit:paste">${icon('copy')} New from clipboard</button>
      </div>
      <h2>Quick start</h2>
      <div class="welcome-presets">${PRESETS.map(([name, w, h, dpi], i) => `<button class="btn" data-preset="${i}" title="${w} × ${h} px at ${dpi} ppi">${name}<span class="muted">&nbsp;${w}×${h}</span></button>`).join('')}</div>
      <div class="welcome-drop" id="welcome-drop">Drop images or PSD files anywhere in this window to open them</div>
      <h2>Recent files</h2>
      <div class="recent-list" id="recent-list"></div>
      <h2>What you can do</h2>
      <div class="welcome-features">${FEATURES.map(([t, d]) => `<div class="welcome-feature"><strong>${t}</strong>${d}</div>`).join('')}</div>
    </div>`;
  for (const btn of root.querySelectorAll('[data-command]')) {
    btn.addEventListener('click', () => app.commands.run(btn.dataset.command, undefined, 'toolbar'));
  }
  for (const btn of root.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => {
      const [name, width, height, dpi] = PRESETS[Number(btn.dataset.preset)];
      app.newDocument({ width, height, dpi, name: `Untitled ${name}`, background: 'white' });
    });
  }

  const list = root.querySelector('#recent-list');
  async function renderRecent() {
    let recent = [];
    try {
      recent = await bridge.getRecent();
    } catch {
      /* ignore */
    }
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
      item.innerHTML = `${icon('image')}<span class="recent-text"><span class="recent-name"></span><span class="recent-path"></span></span><span class="recent-remove" role="button" title="Remove from list">${icon('close')}</span>`;
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
  app.on('doc:activated', (doc) => {
    if (!doc) renderRecent();
  });
  renderRecent();
}
