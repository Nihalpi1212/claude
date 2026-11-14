// Edit > Search… (Ctrl+F; conventions-shortcuts-fields, ARCHITECTURE.md "0.4 features", package 16): a palette over
// the menu commands (with their menu paths, read from src/shared/menu-template.js with the current app.uiState), the
// tools (their tool:* commands) and the panels (window:panel-*). Photoshop's Stock and Learn results are not offered.
//
// openSearch(app) shows the palette and returns at once. On a choice the palette closes first, then the command is
// checked (registered, enabled, not a stub) and run with source 'menu' and the menu item's argument, so the actions
// recorder records that command (edit:search itself is `record: false`).
//
// The matching (menuEntries, scoreEntry, searchEntries) is pure, so node's tests import it.
import { buildMenuTemplate, PANELS } from '../../shared/menu-template.js';
import { MENU_KEYS, RENDERER_KEYS, describeAccelerator } from '../../shared/keymap.js';

/** A menu label without its mnemonic markers ('&File' -> 'File', '&&' -> '&'). */
export function plainLabel(label) {
  return String(label ?? '').replace(/&&/g, '\u0000').replace(/&/g, '').replace(/\u0000/g, '&');
}

/** Ids the palette never lists: itself, and the recent-file list's own commands. */
const SKIP = new Set(['edit:search', 'file:clear-recent']);

/**
 * Every menu item that runs a command, as { id, arg, label, path: string[], kind: 'menu' }, in menu order, each
 * (id, arg) once. Built from buildMenuTemplate with a recording `run`, so the arguments are exactly the menu's.
 */
export function menuEntries({ platform = 'linux', state = {}, recent = [], isPackaged = true } = {}) {
  let captured = null;
  const template = buildMenuTemplate({ platform, state, recent, isPackaged, run: (cmd, arg) => (captured = { cmd, arg }) });
  const out = [];
  const seen = new Set();
  const walk = (items, path) => {
    for (const item of items ?? []) {
      if (!item || item.type === 'separator') continue;
      const label = plainLabel(item.label);
      if (Array.isArray(item.submenu)) {
        walk(item.submenu, label ? [...path, label] : path);
        continue;
      }
      if (typeof item.click !== 'function' || !label) continue;
      captured = null;
      try {
        item.click(null, null, {});
      } catch {
        captured = null;
      }
      if (!captured || typeof captured.cmd !== 'string' || SKIP.has(captured.cmd)) continue;
      const key = `${captured.cmd}\u0001${captured.arg === undefined ? '' : JSON.stringify(captured.arg)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: captured.cmd, arg: captured.arg, label, path, kind: 'menu' });
    }
  };
  walk(template, []);
  return out;
}

const words = (s) => String(s).toLowerCase().split(/[^a-z0-9%]+/i).filter(Boolean);

/**
 * How well an entry matches the query words (0: not at all). Every word must match: the start of a word of the
 * label scores 3 (4 at the label's start), anywhere in the label 2, in the menu path or the command id 1.
 */
export function scoreEntry(entry, queryWords) {
  if (!queryWords.length) return 0;
  const label = String(entry.label).toLowerCase();
  const labelWords = words(entry.label);
  const path = (entry.path ?? []).join(' ').toLowerCase();
  const extra = String(entry.keywords ?? '').toLowerCase();
  let score = 0;
  for (const w of queryWords) {
    let s = 0;
    if (labelWords[0]?.startsWith(w)) s = 4;
    else if (labelWords.some((lw) => lw.startsWith(w))) s = 3;
    else if (label.includes(w)) s = 2;
    else if (path.includes(w) || extra.includes(w) || String(entry.id).toLowerCase().includes(w)) s = 1;
    if (!s) return 0;
    score += s;
  }
  return score;
}

/** Entries matching `query`, best first (ties: shorter label, then the original order). Empty query: none. */
export function searchEntries(entries, query, limit = 60) {
  const q = words(query);
  if (!q.length) return [];
  const scored = [];
  entries.forEach((e, i) => {
    const s = scoreEntry(e, q);
    if (s > 0) scored.push({ e, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.e.label.length - b.e.label.length || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.e);
}

// ---- the palette (DOM) ---------------------------------------------------------------------------------------

/** Everything the palette offers right now: menu items, tools, panels. */
export function collectEntries(app, { platform = 'linux' } = {}) {
  const out = menuEntries({ platform, state: app.uiState ?? {}, recent: [], isPackaged: true });
  const have = new Set(out.map((e) => `${e.id}\u0001${e.arg ?? ''}`));
  for (const tool of app.tools?.tools?.values?.() ?? []) {
    const id = `tool:${tool.id}`;
    if (have.has(`${id}\u0001`)) continue;
    const slot = app.tools.slots.find((s) => s.tools.includes(tool.id));
    const key = RENDERER_KEYS[`tool:${slot?.id}`]?.[0] ?? RENDERER_KEYS[id]?.[0] ?? null;
    out.push({ id, arg: undefined, label: tool.name, path: ['Tools'], kind: 'tool', icon: tool.icon, key });
  }
  for (const p of PANELS) {
    if (!p) continue;
    const id = `window:panel-${p[0]}`;
    const found = out.find((e) => e.id === id);
    if (found) {
      found.kind = 'panel';
      found.keywords = 'panel';
    } else out.push({ id, arg: undefined, label: p[1], path: ['Window'], kind: 'panel', keywords: 'panel' });
  }
  return out;
}

const KIND_LABEL = { menu: 'Menu', tool: 'Tool', panel: 'Panel' };

function shortcutOf(entry, isMac) {
  const accel = entry.key ?? (entry.arg === undefined ? MENU_KEYS[entry.id] ?? RENDERER_KEYS[entry.id]?.[0] : null);
  return accel ? describeAccelerator(accel, isMac) : '';
}

/** Is the entry's command one that runs now? */
function runnable(app, entry) {
  return app.commands.has(entry.id) && !(app.stubbed ?? []).includes(entry.id) && app.commands.isEnabled(entry.id);
}

/** Opens the Search palette (returns at once; the chosen command runs after the palette has closed). */
export function openSearch(app, { isMac = false, platform = isMac ? 'darwin' : 'linux' } = {}) {
  if (app.dialogs.stack?.some((e) => e.opts?.className?.includes?.('command-search'))) return;
  const entries = collectEntries(app, { platform });
  const recentIds = Array.isArray(app.settings?.conventions?.recentSearches) ? app.settings.conventions.recentSearches : [];
  const content = document.createElement('div');
  content.className = 'command-search-body';
  const input = document.createElement('input');
  input.className = 'input command-search-input';
  input.type = 'search';
  input.placeholder = 'Search menus, tools and panels';
  input.setAttribute('aria-label', 'Search');
  input.autofocus = true;
  input.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'command-search-list';
  list.setAttribute('role', 'listbox');
  const empty = document.createElement('p');
  empty.className = 'muted command-search-empty';
  content.append(input, list, empty);

  let shown = [];
  let current = 0;
  let closeDialog = null;

  const select = (i) => {
    current = Math.max(0, Math.min(shown.length - 1, i));
    list.querySelectorAll('.command-search-row').forEach((row, j) => {
      const on = j === current;
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', String(on));
      if (on) row.scrollIntoView({ block: 'nearest' });
    });
  };
  const render = () => {
    const q = input.value;
    if (q.trim()) shown = searchEntries(entries, q);
    else shown = recentIds.map((k) => entries.find((e) => recentKey(e) === k)).filter(Boolean);
    list.replaceChildren();
    for (const [i, e] of shown.entries()) {
      const row = document.createElement('div');
      row.className = 'command-search-row';
      row.setAttribute('role', 'option');
      row.dataset.command = e.id;
      if (e.arg !== undefined) row.dataset.arg = typeof e.arg === 'string' ? e.arg : JSON.stringify(e.arg);
      if (!runnable(app, e)) row.classList.add('disabled');
      const kind = document.createElement('span');
      kind.className = 'command-search-kind';
      kind.textContent = KIND_LABEL[e.kind] ?? '';
      const text = document.createElement('span');
      text.className = 'command-search-text';
      const label = document.createElement('span');
      label.className = 'command-search-label';
      label.textContent = e.label;
      const path = document.createElement('span');
      path.className = 'command-search-path';
      path.textContent = e.path.join(' › ');
      text.append(label, path);
      const sc = document.createElement('span');
      sc.className = 'command-search-shortcut';
      sc.textContent = shortcutOf(e, isMac);
      row.append(kind, text, sc);
      row.addEventListener('mousemove', () => current !== i && select(i));
      row.addEventListener('click', () => choose(i));
      list.appendChild(row);
    }
    empty.textContent = q.trim() && !shown.length ? 'Nothing matches.' : !q.trim() && !shown.length ? 'Type to search the menus, tools and panels.' : '';
    empty.hidden = !empty.textContent;
    select(0);
  };
  const choose = (i) => {
    const e = shown[i];
    if (!e || !closeDialog) return;
    closeDialog(e);
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      select(current + (ev.key === 'ArrowDown' ? 1 : -1));
    } else if (ev.key === 'PageDown' || ev.key === 'PageUp') {
      ev.preventDefault();
      select(current + (ev.key === 'PageDown' ? 8 : -8));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      choose(current);
    }
  });

  app.dialogs
    .open({
      title: 'Search',
      content,
      buttons: [],
      width: 560,
      className: 'command-search',
      positionKey: 'search',
      onOpen: (_dialog, close) => {
        closeDialog = close;
        render();
      },
    })
    .then((entry) => {
      if (!entry || typeof entry !== 'object') return;
      remember(app, entry);
      if (!runnable(app, entry)) {
        app.dialogs.toast(`${entry.label.replace(/…$/, '')} is not available now`, { kind: 'error', timeout: 2200 });
        return;
      }
      app.commands.run(entry.id, entry.arg, 'menu');
    });
}

function recentKey(e) {
  return `${e.id}${e.arg === undefined ? '' : `|${typeof e.arg === 'string' ? e.arg : JSON.stringify(e.arg)}`}`;
}

/** The last ten choices are offered before anything is typed (settings.conventions.recentSearches). */
function remember(app, entry) {
  const conv = app.settings?.conventions ?? {};
  const prev = Array.isArray(conv.recentSearches) ? conv.recentSearches : [];
  const k = recentKey(entry);
  const next = [k, ...prev.filter((x) => x !== k)].slice(0, 10);
  app.saveSettingsSoon?.({ conventions: { ...conv, recentSearches: next } });
}
