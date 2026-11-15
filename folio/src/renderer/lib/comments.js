// Comments panel: every markup annotation in the document, threaded by replies, with reply,
// edit, delete and navigate actions (through the engine).
import * as engine from '../../shared/engine.js';
import { icon } from './icons.js';
import { fromPdfDate } from '../../shared/pdf-date.js';

const SKIP = new Set(['Widget', 'Link', 'Popup']);
const ICONS = { Text: 'note', FreeText: 'text', Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly', Square: 'rect', Circle: 'ellipse', Line: 'line', Ink: 'pen', Stamp: 'stamp', FileAttachment: 'attachment', Polygon: 'shapes', PolyLine: 'shapes', Caret: 'edit' };
const LABELS = { Text: 'Sticky note', FreeText: 'Text box', Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough', Squiggly: 'Squiggly', Square: 'Rectangle', Circle: 'Ellipse', Line: 'Line', Ink: 'Drawing', Stamp: 'Stamp' };

export function install(app) {
  const element = document.createElement('div');
  element.className = 'comments';
  let current = null;
  let filter = '';
  let sort = 'page';
  const author = () => app.settings.authorName || 'Folio user';

  const toolbar = document.createElement('div');
  toolbar.className = 'panel-toolbar comments-toolbar';
  toolbar.innerHTML = `<input class="input" type="search" placeholder="Filter comments" aria-label="Filter comments"><select class="select" aria-label="Sort"><option value="page">By page</option><option value="date">Newest first</option><option value="author">By author</option></select>`;
  const filterInput = toolbar.querySelector('input');
  const sortSelect = toolbar.querySelector('select');
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    render();
  });
  sortSelect.addEventListener('change', () => {
    sort = sortSelect.value;
    render();
  });
  const list = document.createElement('div');
  list.className = 'comment-list';
  const summary = document.createElement('div');
  summary.className = 'comments-summary muted';
  element.append(toolbar, summary, list);

  let items = [];

  async function collect(session) {
    const out = [];
    const doc = session.view.pdfDocument;
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const annots = await page.getAnnotations();
      for (const a of annots) {
        if (SKIP.has(a.subtype) || a.hidden) continue;
        out.push({
          id: a.id,
          page: i,
          subtype: a.subtype,
          rect: a.rect,
          contents: a.contentsObj?.str ?? '',
          author: a.titleObj?.str ?? '',
          modified: parseDate(a.modificationDate),
          created: parseDate(a.creationDate),
          color: a.color ? `rgb(${a.color[0]}, ${a.color[1]}, ${a.color[2]})` : null,
          inReplyTo: a.inReplyTo ?? null,
          hasAppearance: a.hasAppearance,
        });
      }
    }
    return out;
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    return fromPdfDate(String(value));
  }

  async function build(session) {
    current = session;
    if (!session?.view.pdfDocument) {
      items = [];
      summary.textContent = '';
      list.innerHTML = '<div class="sidebar-empty">Open a document to see its comments.</div>';
      return;
    }
    list.innerHTML = '<div class="sidebar-empty">Loading…</div>';
    try {
      const collected = await collect(session);
      if (current !== session) return;
      items = collected;
    } catch (err) {
      console.warn('comments failed', err);
      items = [];
    }
    render();
  }

  function render() {
    list.replaceChildren();
    if (!current?.view.pdfDocument) return;
    const byId = new Map(items.map((a) => [a.id, a]));
    const roots = items.filter((a) => !a.inReplyTo || !byId.has(a.inReplyTo));
    const replies = new Map();
    for (const a of items) {
      if (a.inReplyTo && byId.has(a.inReplyTo)) {
        if (!replies.has(a.inReplyTo)) replies.set(a.inReplyTo, []);
        replies.get(a.inReplyTo).push(a);
      }
    }
    const matches = (a) => !filter || a.contents.toLowerCase().includes(filter) || a.author.toLowerCase().includes(filter) || (LABELS[a.subtype] ?? a.subtype).toLowerCase().includes(filter) || (replies.get(a.id) ?? []).some(matches);
    let visible = roots.filter(matches);
    if (sort === 'date') visible.sort((a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0));
    else if (sort === 'author') visible.sort((a, b) => a.author.localeCompare(b.author) || a.page - b.page);
    else visible.sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3]);
    summary.textContent = items.length ? `${roots.length} comment${roots.length === 1 ? '' : 's'}${filter ? ` · ${visible.length} shown` : ''}` : '';
    if (!visible.length) {
      list.innerHTML = `<div class="sidebar-empty">${items.length ? 'No comments match the filter.' : 'No comments yet. Use the Highlight, Note or Draw tools to add some.'}</div>`;
      if (current.view.hasUnsavedEdits()) list.innerHTML += '<div class="sidebar-empty muted">Unsaved drawings and text boxes appear here after you save.</div>';
      return;
    }
    let lastPage = -1;
    for (const a of visible) {
      if (sort === 'page' && a.page !== lastPage) {
        lastPage = a.page;
        const h = document.createElement('div');
        h.className = 'comment-page';
        h.textContent = `Page ${a.page + 1}`;
        list.appendChild(h);
      }
      list.appendChild(renderItem(a, replies, 0));
    }
  }

  function renderItem(a, replies, depth) {
    const item = document.createElement('div');
    item.className = 'comment';
    item.style.marginLeft = `${depth * 16}px`;
    item.dataset.id = a.id;
    const head = document.createElement('div');
    head.className = 'comment-head';
    head.innerHTML = `<span class="comment-icon">${icon(ICONS[a.subtype] ?? 'note')}</span><span class="comment-author"></span><span class="comment-type muted"></span><span class="comment-date muted"></span>`;
    head.querySelector('.comment-author').textContent = a.author || 'Unknown';
    head.querySelector('.comment-type').textContent = LABELS[a.subtype] ?? a.subtype;
    head.querySelector('.comment-date').textContent = a.modified ? formatDate(a.modified) : '';
    if (a.color) head.querySelector('.comment-icon').style.color = a.color;
    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = a.contents || (depth === 0 ? '(no text)' : '');
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    const btn = (name, title, fn) => {
      const b = document.createElement('button');
      b.className = 'tb-button';
      b.title = title;
      b.innerHTML = icon(name);
      b.addEventListener('click', (event) => {
        event.stopPropagation();
        fn();
      });
      actions.appendChild(b);
      return b;
    };
    btn('reply', 'Reply', () => reply(a));
    btn('edit', 'Edit text', () => editText(a));
    btn('trash', 'Delete', () => remove(a));
    item.append(head, body, actions);
    item.addEventListener('click', () => goTo(a));
    const kids = replies.get(a.id) ?? [];
    if (kids.length) {
      const wrap = document.createElement('div');
      wrap.className = 'comment-replies';
      for (const k of kids.sort((x, y) => (x.modified?.getTime() ?? 0) - (y.modified?.getTime() ?? 0))) wrap.appendChild(renderItem(k, replies, depth + 1));
      item.appendChild(wrap);
    }
    return item;
  }

  function formatDate(d) {
    try {
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return d.toISOString();
    }
  }

  function goTo(a) {
    const v = current?.view;
    if (!v) return;
    for (const el of list.querySelectorAll('.comment.selected')) el.classList.remove('selected');
    list.querySelector(`.comment[data-id="${CSS.escape(a.id)}"]`)?.classList.add('selected');
    try {
      v.pdfViewer.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: 'XYZ' }, Math.max(0, a.rect[0] - 40), a.rect[3] + 40, null], ignoreDestinationZoom: true });
    } catch {
      v.page = a.page + 1;
    }
  }

  async function reply(a) {
    const text = await app.dialogs.prompt(`Reply to ${a.author || 'comment'}`, { title: 'Reply', multiline: true, okLabel: 'Reply' });
    if (!text) return;
    await app.edit.apply((bytes) => engine.addReply(bytes, a.id, { contents: text, author: author() }), { label: 'Reply' });
  }

  async function editText(a) {
    const text = await app.dialogs.prompt('Comment text', { title: 'Edit comment', value: a.contents, multiline: true, okLabel: 'Save' });
    if (text === null) return;
    await app.edit.apply((bytes) => engine.updateAnnotation(bytes, a.id, { contents: text }), { label: 'Edit comment' });
  }

  async function remove(a) {
    const ok = await app.dialogs.confirm(`Delete this ${(LABELS[a.subtype] ?? a.subtype).toLowerCase()}?`, { title: 'Delete comment', okLabel: 'Delete', danger: true, detail: 'Replies to it are deleted as well.' });
    if (!ok) return;
    await app.edit.apply((bytes) => engine.deleteAnnotation(bytes, a.id), { label: 'Delete comment' });
  }

  app.sidebar.registerPanel({ id: 'comments', title: 'Comments', icon: 'comments', element, order: 4, onShow: (s) => build(s) });
  const refresh = (s) => {
    if (app.sidebar.isOpen() && app.sidebar.current === 'comments') build(s ?? app.session);
  };
  app.on('doc:reloaded', refresh);
  app.on('doc:saved', refresh);
  app.on('tab:activated', refresh);
  app.on('tab:closed', () => {
    if (!app.session) refresh(null);
  });
}
