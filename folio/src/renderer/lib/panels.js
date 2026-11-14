// Sidebar panels: page thumbnails, bookmarks (outline), attachments and layers (optional content).
import { bridge } from './bridge.js';
import { icon } from './icons.js';

export function install(app) {
  installThumbnails(app);
  installOutline(app);
  installAttachments(app);
  installLayers(app);
}

// ---- thumbnails -------------------------------------------------------------------------------------
function installThumbnails(app) {
  const element = document.createElement('div');
  element.className = 'thumbs';
  let session = null;
  let observer = null;
  let generation = 0;

  function build(s) {
    session = s;
    generation++;
    const gen = generation;
    observer?.disconnect();
    element.replaceChildren();
    if (!s?.view.pdfDocument) {
      element.innerHTML = '<div class="sidebar-empty">Open a document to see its pages.</div>';
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = entry.target;
          observer.unobserve(item);
          renderThumb(item, Number(item.dataset.index), gen);
        }
      },
      { root: element, rootMargin: '300px' }
    );
    const n = s.view.numPages;
    for (let i = 0; i < n; i++) {
      const item = document.createElement('button');
      item.className = 'thumb';
      item.type = 'button';
      item.dataset.index = String(i);
      item.setAttribute('aria-label', `Page ${i + 1}`);
      item.innerHTML = `<div class="thumb-frame"><div class="thumb-placeholder"></div></div><div class="thumb-label">${i + 1}</div>`;
      item.addEventListener('click', () => {
        s.view.page = i + 1;
        s.view.focus();
      });
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        app.dialogs.popover(item, [
          { label: 'Rotate clockwise', icon: 'rotate-cw', onSelect: () => app.commands.run('pages:rotate', { indices: [i], delta: 90 }, 'api') },
          { label: 'Rotate counter-clockwise', icon: 'rotate-ccw', onSelect: () => app.commands.run('pages:rotate', { indices: [i], delta: -90 }, 'api') },
          { type: 'separator' },
          { label: 'Insert pages after…', icon: 'insert', onSelect: () => app.commands.run('pages:insert', { at: i + 1 }, 'api') },
          { label: 'Extract this page…', icon: 'extract', onSelect: () => app.commands.run('pages:extract', { indices: [i] }, 'api') },
          { label: 'Delete page', icon: 'trash', disabled: n < 2, onSelect: () => app.commands.run('pages:delete', { indices: [i] }, 'api') },
          { type: 'separator' },
          { label: 'Organize pages…', icon: 'pages', onSelect: () => app.commands.run('pages:organize', undefined, 'api') },
        ]);
      });
      element.appendChild(item);
      observer.observe(item);
    }
    markCurrent();
  }

  async function renderThumb(item, index, gen) {
    try {
      const canvas = await session.view.renderPage(index, { width: 150, dpr: Math.min(2, window.devicePixelRatio || 1) });
      if (gen !== generation) return;
      canvas.className = 'thumb-canvas';
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      item.querySelector('.thumb-frame').replaceChildren(canvas);
    } catch (err) {
      if (gen === generation) console.warn('thumbnail failed', err);
    }
  }

  function markCurrent() {
    if (!session?.view.pdfDocument) return;
    const current = session.view.page - 1;
    for (const item of element.children) {
      const active = Number(item.dataset.index) === current;
      item.classList.toggle('current', active);
      item.setAttribute('aria-current', active ? 'page' : 'false');
    }
    const el = element.children[current];
    if (el && el.scrollIntoView) {
      const r = el.getBoundingClientRect();
      const pr = element.getBoundingClientRect();
      if (r.top < pr.top || r.bottom > pr.bottom) el.scrollIntoView({ block: 'nearest' });
    }
  }

  app.sidebar.registerPanel({ id: 'thumbnails', title: 'Page thumbnails', icon: 'thumbnails', element, order: 0, onShow: (s) => (s !== session || !element.children.length ? build(s) : markCurrent()) });
  const rebuildIfShown = (s) => {
    if (app.sidebar.isOpen() && app.sidebar.current === 'thumbnails') build(s ?? app.session);
    else session = null;
  };
  app.on('doc:reloaded', (s) => rebuildIfShown(s));
  app.on('rotation:changed', ({ session: s }) => rebuildIfShown(s));
  app.on('tab:activated', (s) => rebuildIfShown(s));
  app.on('tab:closed', () => {
    if (!app.session) rebuildIfShown(null);
  });
  app.on('page:changed', () => {
    if (app.sidebar.isOpen() && app.sidebar.current === 'thumbnails') markCurrent();
  });
}

// ---- bookmarks (outline) ----------------------------------------------------------------------------
function installOutline(app) {
  const element = document.createElement('div');
  element.className = 'outline';
  let current = null;

  async function build(session) {
    current = session;
    element.replaceChildren();
    if (!session?.view.pdfDocument) {
      element.innerHTML = '<div class="sidebar-empty">Open a document to see its bookmarks.</div>';
      return;
    }
    let outline = null;
    try {
      outline = await session.view.getOutline();
    } catch (err) {
      console.warn('outline failed', err);
    }
    if (current !== session) return;
    if (!outline?.length) {
      element.innerHTML = '<div class="sidebar-empty">This document has no bookmarks.</div>';
      return;
    }
    const header = document.createElement('div');
    header.className = 'panel-toolbar';
    const expand = document.createElement('button');
    expand.className = 'btn quiet';
    expand.textContent = 'Expand all';
    expand.addEventListener('click', () => element.querySelectorAll('.outline-item.collapsed').forEach((el) => el.classList.remove('collapsed')));
    const collapse = document.createElement('button');
    collapse.className = 'btn quiet';
    collapse.textContent = 'Collapse all';
    collapse.addEventListener('click', () => element.querySelectorAll('.outline-item.has-children').forEach((el) => el.classList.add('collapsed')));
    header.append(expand, collapse);
    element.appendChild(header);
    element.appendChild(buildList(outline, session, 0));
  }

  function buildList(items, session, depth) {
    const ul = document.createElement('ul');
    ul.className = 'outline-list';
    ul.setAttribute('role', depth === 0 ? 'tree' : 'group');
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'outline-item' + (item.items?.length ? ' has-children' : '') + (item.items?.length && depth > 0 ? ' collapsed' : '');
      li.setAttribute('role', 'treeitem');
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const toggle = document.createElement('button');
      toggle.className = 'outline-toggle';
      toggle.type = 'button';
      toggle.innerHTML = icon('chevron-right');
      toggle.setAttribute('aria-label', 'Toggle');
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        li.classList.toggle('collapsed');
      });
      if (!item.items?.length) toggle.style.visibility = 'hidden';
      const label = document.createElement('button');
      label.className = 'outline-label';
      label.type = 'button';
      label.textContent = item.title || '(untitled)';
      if (item.bold) label.style.fontWeight = '600';
      if (item.italic) label.style.fontStyle = 'italic';
      label.addEventListener('click', async () => {
        if (item.url) {
          bridge.openExternal(item.url).catch(() => {});
          return;
        }
        if (item.dest) {
          try {
            await session.view.goToDestination(item.dest);
          } catch (err) {
            console.warn('bad destination', err);
          }
        }
        session.view.focus();
      });
      row.append(toggle, label);
      li.appendChild(row);
      if (item.items?.length) li.appendChild(buildList(item.items, session, depth + 1));
      ul.appendChild(li);
    }
    return ul;
  }

  app.sidebar.registerPanel({ id: 'outline', title: 'Bookmarks', icon: 'outline', element, order: 1, onShow: (s) => build(s) });
  app.on('doc:reloaded', (s) => {
    if (app.sidebar.isOpen() && app.sidebar.current === 'outline') build(s);
  });
}

// ---- attachments ------------------------------------------------------------------------------------
function installAttachments(app) {
  const element = document.createElement('div');
  element.className = 'attachments';
  let current = null;

  async function build(session) {
    current = session;
    element.replaceChildren();
    if (!session?.view.pdfDocument) {
      element.innerHTML = '<div class="sidebar-empty">Open a document to see its attachments.</div>';
      return;
    }
    let attachments = null;
    try {
      attachments = await session.view.getAttachments();
    } catch (err) {
      console.warn('attachments failed', err);
    }
    if (current !== session) return;
    const entries = attachments ? (attachments instanceof Map ? [...attachments.values()] : Object.values(attachments)) : [];
    if (!entries.length) {
      element.innerHTML = '<div class="sidebar-empty">This document has no attachments.</div>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'attachment-list';
    for (const att of entries) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'attachment-item';
      btn.type = 'button';
      const size = att.content?.byteLength ?? 0;
      btn.innerHTML = `${icon('attachment')}<span class="attachment-text"><span class="attachment-name"></span><span class="attachment-size muted">${size > 1024 * 1024 ? (size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB'}</span></span>${icon('download')}`;
      btn.querySelector('.attachment-name').textContent = att.filename ?? att.name ?? 'attachment';
      btn.title = att.description ? `${att.filename}\n${att.description}` : 'Save attachment';
      btn.addEventListener('click', async () => {
        const target = await bridge.saveFileDialog({ defaultPath: att.filename ?? 'attachment', filters: [{ name: 'All files', extensions: ['*'] }], title: 'Save attachment' });
        if (!target) return;
        try {
          await bridge.writeFile(target, att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content));
          app.dialogs.toast('Attachment saved', { kind: 'success', timeout: 1500 });
        } catch (err) {
          app.reportError(err, 'Could not save the attachment');
        }
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    element.appendChild(ul);
  }

  app.sidebar.registerPanel({ id: 'attachments', title: 'Attachments', icon: 'attachment', element, order: 2, onShow: (s) => build(s) });
}

// ---- layers (optional content) ---------------------------------------------------------------------
function installLayers(app) {
  const element = document.createElement('div');
  element.className = 'layers';
  let current = null;

  async function build(session) {
    current = session;
    element.replaceChildren();
    if (!session?.view.pdfDocument) {
      element.innerHTML = '<div class="sidebar-empty">Open a document to see its layers.</div>';
      return;
    }
    let config = null;
    try {
      config = await session.view.getOptionalContentConfig();
    } catch (err) {
      console.warn('layers failed', err);
    }
    if (current !== session) return;
    const order = config?.getOrder?.() ?? null;
    if (!config || !order?.length) {
      element.innerHTML = '<div class="sidebar-empty">This document has no layers.</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'layer-list';
    const addItems = (items, depth) => {
      for (const item of items) {
        if (typeof item === 'string') {
          const group = config.getGroup(item);
          if (!group) continue;
          const label = document.createElement('label');
          label.className = 'layer-item';
          label.style.paddingLeft = `${10 + depth * 14}px`;
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = group.visible !== false;
          box.addEventListener('change', async () => {
            config.setVisibility(item, box.checked);
            await session.view.setOptionalContentVisibility(config);
          });
          const span = document.createElement('span');
          span.textContent = group.name ?? item;
          label.append(box, span);
          list.appendChild(label);
        } else if (item && typeof item === 'object') {
          if (item.name) {
            const title = document.createElement('div');
            title.className = 'layer-group';
            title.style.paddingLeft = `${10 + depth * 14}px`;
            title.textContent = item.name;
            list.appendChild(title);
          }
          if (Array.isArray(item.order)) addItems(item.order, depth + 1);
        }
      }
    };
    addItems(order, 0);
    element.appendChild(list);
  }

  app.sidebar.registerPanel({ id: 'layers', title: 'Layers', icon: 'layers', element, order: 3, onShow: (s) => build(s) });
}
