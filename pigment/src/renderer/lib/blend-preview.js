// layers-panel-depth (package 14): the Layers panel's blend-mode menu with Photoshop's live preview.
//
//   previewBlend(app, layers, mode)   shows `mode` on the layers without touching history (mode null: their own)
//   endBlendPreview(app)              puts every previewed layer back; true when a preview was running
//   blendControl(app, { targets, commit, steps })
//       -> { element, update({ mode, isGroup, disabled, mixed }), open(), close() }
//
// The menu is a button that opens a list of the modes. Hovering a mode (or moving through the list with the arrow
// keys) shows it on the canvas at once; leaving the list shows the layers' own modes again; a click or Enter commits
// it through the `commit` callback (the panel runs layer:blend with the ids). With the list closed and the button
// focused, ArrowUp / ArrowDown step to the previous or next mode and commit it, as a focused list box does.
//
// A preview changes `layer.blend` and bumps the layer's version so the compositor redraws, but never calls
// doc.changed: nothing is recorded and the document is not marked as modified. It ends (the layers get their own
// modes back) before any command runs (a command observer, E4), when another document becomes active, and when the
// list closes; a command or a save can never see a previewed mode.
import { BLEND_MODES, BLEND_LABELS } from './document.js';
import { blendSteps, stepMode } from './panels/layers-model.js';

let active = null; // { app, doc, saved: Map<layer, blend>, off }

/** Shows `mode` on `layers` (each keeps a mode it cannot take: Pass Through is for groups only). */
export function previewBlend(app, layers, mode) {
  const doc = app.doc;
  if (!doc) return;
  if (active && active.doc !== doc) endBlendPreview(app);
  if (!active) {
    const list = (layers ?? []).filter(Boolean);
    if (!list.length) return;
    active = { app, doc, saved: new Map(list.map((l) => [l, l.blend])), off: null };
    // E4: the preview must be gone before any command runs (Save, Undo, the commit itself)
    active.off = app.commands.observe({ before: () => endBlendPreview(app) });
  }
  let changed = false;
  for (const [layer, own] of active.saved) {
    const want = mode ?? own;
    const next = want === 'pass-through' && !layer.isGroup ? own : want;
    if (layer.blend !== next) {
      layer.blend = next;
      layer.touch();
      changed = true;
    }
  }
  if (changed) doc.view?.invalidate();
}

/** Ends a running preview: every previewed layer gets its own mode back. */
export function endBlendPreview(app) {
  const p = active;
  if (!p || (app && p.app !== app)) return false;
  active = null;
  p.off?.();
  let changed = false;
  for (const [layer, own] of p.saved) {
    if (layer.blend !== own) {
      layer.blend = own;
      layer.touch();
      changed = true;
    }
  }
  if (changed) p.doc.view?.invalidate();
  return true;
}

/** True while a preview is shown (tests, the panel). */
export function blendPreviewActive() {
  return !!active;
}

const label = (mode) => BLEND_LABELS[mode] ?? mode;

/**
 * The blend-mode button and its list. `targets()` gives the layers a choice applies to (the panel's selected
 * layers); `commit(mode)` applies it for real. `steps(isGroup)` defaults to blendSteps over BLEND_MODES.
 */
export function blendControl(app, { targets, commit, steps = (isGroup) => blendSteps(BLEND_MODES, isGroup) } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'select blend-mode-button';
  button.dataset.blend = '';
  button.title = 'Blend mode (hover a mode to preview it; arrow keys step through them)';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.className = 'blend-mode-label';
  button.appendChild(text);
  let state = { mode: 'normal', isGroup: false, disabled: true, mixed: false };
  let list = null; // the open list element
  let highlighted = null;
  let cleanup = null;

  function update(next) {
    state = { ...state, ...next };
    button.disabled = !!state.disabled;
    button.dataset.value = state.mode ?? '';
    text.textContent = state.mixed ? '—' : label(state.mode);
    button.setAttribute('aria-label', `Blend mode: ${state.mixed ? 'mixed' : label(state.mode)}`);
    if (list && state.disabled) close();
  }

  function modesNow() {
    return steps(state.isGroup);
  }

  function open() {
    if (list || button.disabled) return;
    app.dialogs?.closePopover?.();
    list = document.createElement('div');
    list.className = 'popover blend-mode-list';
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    const modes = modesNow();
    // the separators of BLEND_MODES group the list as Photoshop does
    let prevGroup = null;
    const groupOf = new Map();
    let g = 0;
    for (const m of BLEND_MODES) {
      if (!m) g++;
      else groupOf.set(m[0], g);
    }
    groupOf.set('pass-through', -1);
    for (const m of modes) {
      const grp = groupOf.get(m) ?? 99;
      if (prevGroup !== null && grp !== prevGroup) {
        const sep = document.createElement('div');
        sep.className = 'popover-separator';
        list.appendChild(sep);
      }
      prevGroup = grp;
      const item = document.createElement('div');
      item.className = 'popover-item blend-mode-item';
      item.setAttribute('role', 'option');
      item.dataset.mode = m;
      item.textContent = label(m);
      if (m === state.mode && !state.mixed) item.setAttribute('aria-selected', 'true');
      item.addEventListener('mouseenter', () => highlight(m, { scroll: false }));
      item.addEventListener('mousedown', (e) => e.preventDefault()); // keeps the focus on the button
      item.addEventListener('click', () => choose(m));
      list.appendChild(item);
    }
    list.addEventListener('mouseleave', () => {
      // off the list: the layers' own modes again (the highlight stays for the keyboard)
      previewBlend(app, targets(), null);
    });
    document.body.appendChild(list);
    const r = button.getBoundingClientRect();
    list.style.minWidth = `${Math.max(140, r.width)}px`;
    const ph = list.offsetHeight;
    const below = window.innerHeight - r.bottom - 8;
    let top = r.bottom + 2;
    if (ph > below && r.top > below) top = Math.max(8, r.top - ph - 2);
    list.style.maxHeight = `${Math.max(120, top > r.top ? below : r.top - 10)}px`;
    list.style.left = `${Math.min(r.left, window.innerWidth - list.offsetWidth - 8)}px`;
    list.style.top = `${top}px`;
    button.setAttribute('aria-expanded', 'true');
    highlighted = state.mixed ? null : state.mode;
    list.querySelector(`[data-mode="${CSS.escape(highlighted ?? '')}"]`)?.scrollIntoView?.({ block: 'nearest' });
    paintHighlight();
    const onDown = (e) => {
      if (!list?.contains(e.target) && !button.contains(e.target)) close();
    };
    const onChange = () => close();
    setTimeout(() => document.addEventListener('mousedown', onDown, true));
    const offDoc = app.on?.('doc:activated', onChange);
    cleanup = () => {
      document.removeEventListener('mousedown', onDown, true);
      offDoc?.();
    };
  }

  function paintHighlight() {
    if (!list) return;
    for (const el of list.querySelectorAll('.blend-mode-item')) el.classList.toggle('highlighted', el.dataset.mode === highlighted);
  }

  function highlight(mode, { scroll = true } = {}) {
    highlighted = mode;
    paintHighlight();
    if (scroll) list?.querySelector(`[data-mode="${CSS.escape(mode)}"]`)?.scrollIntoView?.({ block: 'nearest' });
    previewBlend(app, targets(), mode);
  }

  function close() {
    if (!list) return;
    cleanup?.();
    cleanup = null;
    list.remove();
    list = null;
    highlighted = null;
    button.setAttribute('aria-expanded', 'false');
    endBlendPreview(app);
  }

  function choose(mode) {
    close();
    if (mode && (state.mixed || mode !== state.mode)) commit(mode);
  }

  button.addEventListener('click', () => (list ? close() : open()));
  button.addEventListener('blur', () => {
    // a click on an item keeps the focus (mousedown is prevented), so a blur means the user went elsewhere
    setTimeout(() => {
      if (list && document.activeElement !== button) close();
    }, 0);
  });
  button.addEventListener('keydown', (e) => {
    // the tool shortcuts and the arrow-key nudge of the Move tool must not see these keys
    const k = e.key;
    if (!['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape', 'Home', 'End', 'Tab'].includes(k)) return;
    if (k === 'Tab') {
      if (list) close();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const modes = modesNow();
    if (!list) {
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        if (e.altKey) return open();
        // with several layers in different modes the step starts from the active layer's mode
        const next = stepMode(modes, state.mode, k === 'ArrowUp' ? -1 : 1);
        if (next && (state.mixed || next !== state.mode)) commit(next);
      } else if (k === 'Enter' || k === ' ') open();
      return;
    }
    if (k === 'Escape') return close();
    if (k === 'Enter' || k === ' ') return choose(highlighted);
    if (k === 'Home') return highlight(modes[0]);
    if (k === 'End') return highlight(modes[modes.length - 1]);
    highlight(stepMode(modes, highlighted ?? state.mode, k === 'ArrowUp' ? -1 : 1));
  });

  update(state);
  return { element: button, update, open, close, get isOpen() { return !!list; } };
}
