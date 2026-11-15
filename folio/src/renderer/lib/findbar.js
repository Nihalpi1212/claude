// Find bar: text search through pdf.js' find controller, with options and a results list.
import { icon } from './icons.js';
import { FindState } from 'pdfjs-dist/web/pdf_viewer.mjs';

export function install(app) {
  const bar = document.getElementById('findbar');
  bar.innerHTML = `
    <input type="text" class="tb-input" id="find-input" placeholder="Find in document" aria-label="Find in document" autocomplete="off" spellcheck="false">
    <button class="tb-button" id="find-prev" title="Previous match (Shift+Enter)">${icon('up')}</button>
    <button class="tb-button" id="find-next" title="Next match (Enter)">${icon('down')}</button>
    <span class="find-status" id="find-status" aria-live="polite"></span>
    <label><input type="checkbox" id="find-case"> Match case</label>
    <label><input type="checkbox" id="find-word"> Whole words</label>
    <label><input type="checkbox" id="find-all" checked> Highlight all</label>
    <button class="tb-button" id="find-list" title="List all matches" aria-pressed="false">${icon('menu')}</button>
    <span class="toolbar-spacer" style="flex:1"></span>
    <button class="tb-button" id="find-close" title="Close (Esc)">${icon('close')}</button>
    <div class="find-results" id="find-results"></div>`;
  const input = bar.querySelector('#find-input');
  const status = bar.querySelector('#find-status');
  const caseBox = bar.querySelector('#find-case');
  const wordBox = bar.querySelector('#find-word');
  const allBox = bar.querySelector('#find-all');
  const results = bar.querySelector('#find-results');
  const listBtn = bar.querySelector('#find-list');
  let listOpen = false;
  let lastQuery = '';

  function opts() {
    return { query: input.value, caseSensitive: caseBox.checked, entireWord: wordBox.checked, highlightAll: allBox.checked };
  }
  function search(type = '', findPrevious = false) {
    const v = app.view;
    if (!v) return;
    if (!input.value) {
      v.clearFind();
      status.textContent = '';
      status.classList.remove('notfound');
      results.replaceChildren();
      return;
    }
    v.find({ ...opts(), type, findPrevious });
    lastQuery = input.value;
    if (listOpen) buildList();
  }
  const isOpen = () => !bar.hidden;
  function open() {
    bar.hidden = false;
    const sel = document.getSelection()?.toString().trim();
    if (sel && sel.length < 80 && !sel.includes('\n')) input.value = sel;
    input.focus();
    input.select();
    if (input.value) search('');
    app.emit('layout:changed');
  }
  function close() {
    bar.hidden = true;
    app.view?.clearFind();
    app.view?.focus();
    app.emit('layout:changed');
  }

  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => search(''), 120);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      search('again', event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  bar.querySelector('#find-next').addEventListener('click', () => search('again', false));
  bar.querySelector('#find-prev').addEventListener('click', () => search('again', true));
  bar.querySelector('#find-close').addEventListener('click', close);
  caseBox.addEventListener('change', () => search('casesensitivitychange'));
  wordBox.addEventListener('change', () => search('entirewordchange'));
  allBox.addEventListener('change', () => search('highlightallchange'));
  listBtn.addEventListener('click', () => {
    listOpen = !listOpen;
    listBtn.setAttribute('aria-pressed', String(listOpen));
    bar.classList.toggle('show-results', listOpen);
    if (listOpen) buildList();
    app.emit('layout:changed');
  });

  async function buildList() {
    const v = app.view;
    results.replaceChildren();
    const query = input.value.trim();
    if (!v || !query) return;
    const flags = caseBox.checked ? 'g' : 'gi';
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(wordBox.checked ? `\\b${escaped}\\b` : escaped, flags);
    const token = (buildList.token = Symbol('list'));
    let count = 0;
    for (let i = 0; i < v.numPages && count < 500; i++) {
      let text;
      try {
        text = await v.getPageText(i);
      } catch {
        continue;
      }
      if (buildList.token !== token) return;
      for (const m of text.matchAll(re)) {
        count++;
        const start = Math.max(0, m.index - 40);
        const end = Math.min(text.length, m.index + m[0].length + 40);
        const row = document.createElement('button');
        row.className = 'find-result';
        row.type = 'button';
        const page = document.createElement('span');
        page.className = 'find-result-page';
        page.textContent = `Page ${i + 1}`;
        const snippet = document.createElement('span');
        snippet.append(document.createTextNode((start > 0 ? '…' : '') + text.slice(start, m.index).replace(/\s+/g, ' ')));
        const mark = document.createElement('mark');
        mark.textContent = m[0];
        snippet.appendChild(mark);
        snippet.append(document.createTextNode(text.slice(m.index + m[0].length, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '')));
        row.append(page, snippet);
        row.addEventListener('click', () => {
          v.page = i + 1;
          search('');
        });
        results.appendChild(row);
        if (count >= 500) break;
      }
    }
    if (!count) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.style.padding = '4px 6px';
      none.textContent = 'No matches';
      results.appendChild(none);
    }
  }

  function onState({ state, matchesCount }) {
    const { current = 0, total = 0 } = matchesCount ?? {};
    status.classList.toggle('notfound', state === FindState.NOT_FOUND);
    if (state === FindState.NOT_FOUND) status.textContent = 'No matches';
    else if (state === FindState.PENDING) status.textContent = 'Searching…';
    else if (total > 0) status.textContent = `${current} of ${total} match${total === 1 ? '' : 'es'}`;
    else status.textContent = '';
    app.emit('find:results', { current, total, state });
  }
  function onCount({ matchesCount }) {
    const { current = 0, total = 0 } = matchesCount ?? {};
    if (total > 0) status.textContent = `${current} of ${total} match${total === 1 ? '' : 'es'}`;
  }

  const bound = new WeakSet();
  function bind(session) {
    if (!session || bound.has(session)) return;
    bound.add(session);
    session.view.on('updatefindcontrolstate', onState);
    session.view.on('updatefindmatchescount', onCount);
  }
  app.on('tab:opened', bind);
  app.on('tab:activated', (session) => {
    bind(session);
    if (isOpen() && session && input.value) search('');
  });

  app.commands.registerAll({
    'edit:find': { enabled: () => !!app.session, run: open },
    'edit:find-next': { enabled: () => !!app.session, run: () => (isOpen() && input.value ? search('again', false) : open()) },
    'edit:find-prev': { enabled: () => !!app.session, run: () => (isOpen() && input.value ? search('again', true) : open()) },
    'edit:find-close': { run: close },
  });
}
