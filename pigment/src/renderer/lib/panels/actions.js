// Actions panel (bottom group): the tree of sets › actions › steps of app.actions (lib/actions.js).
//
// List mode: every row has an include checkbox (a step that is off is skipped on playback; on a set
// or action it switches all of its steps) and a dialog toggle (the step shows its dialog on playback
// instead of using the recorded settings). Click selects, double-click renames a set, opens Action
// Options for an action or edits a step (its argument as JSON, the message of a Stop, the test of a
// conditional). Steps and actions reorder by dragging. The footer holds Stop / Record / Play / New Set /
// New Action / Delete; the panel menu (also the context menu) has the rest.
// Button mode: one coloured button per action; a click plays it.
import { icon } from '../icons.js';
import { isMac } from '../bridge.js';
import { colorOf, describeArg, functionKeyLabel, findAction, findStep, stepKind, conditionLabel } from '../actions/model.js';

const DIALOG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16M8 13h8M8 16h5"/></svg>';

export function install(app) {
  const engine = app.actions;
  const el = document.createElement('div');
  el.className = 'actions-panel';
  if (!engine) {
    // lib/actions.js failed to load: say so instead of showing an empty panel
    el.innerHTML = '<div class="panel-empty">Actions are not available.</div>';
    app.panels.register({ id: 'actions', title: 'Actions', icon: 'play', element: el, group: 'bottom' });
    return;
  }
  el.innerHTML = `
    <div class="actions-tree" role="tree" aria-label="Actions" tabindex="0"></div>
    <div class="actions-buttons" role="list" aria-label="Actions" hidden></div>
    <div class="panel-footer actions-footer">
      <button class="pbtn" data-cmd="actions:stop" title="Stop playing / recording">${icon('stop')}</button>
      <button class="pbtn act-record" data-cmd="actions:record" title="Begin recording">${icon('record')}</button>
      <button class="pbtn" data-cmd="actions:play" title="Play selection">${icon('play')}</button>
      <span style="flex:1"></span>
      <button class="pbtn" data-cmd="actions:new-set" title="Create new set">${icon('folder')}</button>
      <button class="pbtn" data-cmd="actions:new-action" title="Create new action">${icon('plus')}</button>
      <button class="pbtn" data-cmd="actions:delete" title="Delete">${icon('trash')}</button>
      <button class="pbtn" data-act="menu" title="Actions panel menu" aria-haspopup="menu">${icon('more')}</button>
    </div>`;
  const tree = el.querySelector('.actions-tree');
  const buttons = el.querySelector('.actions-buttons');
  const footer = el.querySelector('.actions-footer');
  /** steps whose settings are unfolded (panel state only) */
  const expanded = new Set();
  let pending = 0;
  let drag = null;

  const run = (cmd, arg) => app.commands.run(cmd, arg, 'panel');
  const visible = () => app.panels.isVisible('actions');
  const schedule = () => {
    if (pending || !visible()) return;
    pending = requestAnimationFrame(render);
  };

  for (const b of footer.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => run(b.dataset.cmd));
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => app.dialogs.popover(e.currentTarget, menu(), { align: 'right' }));

  function menu() {
    const cmd = (label, id, extra = {}) => ({ label, disabled: !app.commands.isEnabled(id), onSelect: () => run(id), ...extra });
    const list = [{ label: 'Button Mode', checked: engine.buttonMode, onSelect: () => run('actions:button-mode') }, { type: 'separator' }];
    if (!engine.buttonMode) {
      list.push(
        cmd('New Action…', 'actions:new-action'),
        cmd('New Set…', 'actions:new-set'),
        cmd('Duplicate', 'actions:duplicate'),
        cmd('Delete', 'actions:delete'),
        cmd('Play', 'actions:play'),
        { type: 'separator' },
        cmd('Start Recording', 'actions:record'),
        cmd('Insert Menu Item…', 'actions:insert-menu-item'),
        cmd('Insert Stop…', 'actions:insert-stop'),
        cmd('Insert Conditional…', 'actions:insert-conditional'),
        { type: 'separator' },
        cmd('Action Options…', 'actions:action-options'),
      );
    }
    list.push(
      cmd('Playback Options…', 'actions:playback-options'),
      { type: 'separator' },
      cmd('Clear All Actions', 'actions:clear'),
      cmd('Reset Actions', 'actions:reset'),
      cmd('Load Actions…', 'actions:load'),
      cmd('Save Actions…', 'actions:save'),
    );
    return list;
  }

  // ---- rows ---------------------------------------------------------------------------------------------------
  function checkbox(state, title, onChange) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'act-check';
    cb.checked = state !== false;
    cb.indeterminate = state === null;
    cb.title = title;
    cb.setAttribute('aria-label', title);
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => onChange(cb.checked));
    return cb;
  }

  /** state: true | false | null (mixed) | undefined (no dialog to show: an empty slot keeps the columns aligned) */
  function dialogToggle(state, title, onToggle) {
    const b = document.createElement(state === undefined ? 'span' : 'button');
    b.className = 'act-dialog';
    if (state === undefined) return b;
    b.type = 'button';
    b.innerHTML = DIALOG_ICON;
    b.setAttribute('aria-pressed', state === null ? 'mixed' : String(state));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle(!(state === true));
    });
    return b;
  }

  function twisty(open, onToggle) {
    const b = document.createElement(open === undefined ? 'span' : 'button');
    b.className = 'act-twisty';
    if (open === undefined) return b;
    b.type = 'button';
    b.innerHTML = icon(open ? 'chevron-down' : 'chevron-right');
    b.title = open ? 'Collapse' : 'Expand';
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle();
    });
    return b;
  }

  /** Whether a step's command can ask again on playback (it was registered as a dialog command). */
  const canDialog = (step) => !!step.command && !step.menuItem && (!!app.commands.commands.get(step.command)?.dialog || step.dialog);
  const dialogState = (steps) => {
    const able = steps.filter(canDialog);
    if (!able.length) return undefined;
    const on = able.filter((s) => s.dialog).length;
    return on === 0 ? false : on === able.length ? true : null;
  };
  const checkState = (steps) => {
    if (!steps.length) return true;
    const on = steps.filter((s) => s.enabled).length;
    return on === 0 ? false : on === steps.length ? true : null;
  };
  const setAll = (steps, patch) => {
    for (const s of steps) {
      if ('enabled' in patch) s.enabled = patch.enabled;
      if ('dialog' in patch && canDialog(s)) s.dialog = patch.dialog;
    }
    engine.changed('toggle');
  };

  function row(kind, id, level, selected) {
    const r = document.createElement('div');
    r.className = `act-row act-${kind}${selected ? ' selected' : ''}`;
    r.dataset.id = id;
    r.dataset.kind = kind;
    r.setAttribute('role', 'treeitem');
    r.setAttribute('aria-level', String(level));
    r.setAttribute('aria-selected', String(!!selected));
    r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selected) engine.select({ [kind]: id });
      app.dialogs.popover(r, menu(), { at: { x: e.clientX, y: e.clientY } });
    });
    return r;
  }

  function name(text, extraClass = '') {
    const s = document.createElement('span');
    s.className = `act-name ${extraClass}`.trim();
    s.textContent = text;
    return s;
  }

  function makeDraggable(r, kind, id) {
    r.draggable = true;
    r.addEventListener('dragstart', (e) => {
      drag = { kind, id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      r.classList.add('dragging');
    });
    r.addEventListener('dragend', () => {
      drag = null;
      for (const x of tree.querySelectorAll('.dragging, .drop-above, .drop-below')) x.classList.remove('dragging', 'drop-above', 'drop-below');
    });
  }

  /** Where a dragged step or action would land on this row: { parent id, index } or null. */
  function dropTarget(r, e) {
    if (!drag) return null;
    const kind = r.dataset.kind, id = r.dataset.id;
    const below = e.clientY > r.getBoundingClientRect().top + r.offsetHeight / 2;
    if (drag.kind === 'step') {
      if (kind === 'step') {
        const f = findStep(engine.sets, id);
        return f ? { parent: f.action.id, index: f.index + (below ? 1 : 0), below } : null;
      }
      if (kind === 'action') return { parent: id, index: below ? 0 : findAction(engine.sets, id)?.action.steps.length ?? 0, below: true };
      return null;
    }
    if (drag.kind === 'action') {
      if (kind === 'action') {
        const f = findAction(engine.sets, id);
        return f ? { parent: f.set.id, index: f.set.actions.indexOf(f.action) + (below ? 1 : 0), below } : null;
      }
      if (kind === 'set') return { parent: id, index: engine.sets.find((s) => s.id === id)?.actions.length ?? 0, below: true };
    }
    return null;
  }

  function acceptDrops(r) {
    r.addEventListener('dragover', (e) => {
      const t = dropTarget(r, e);
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      r.classList.toggle('drop-above', !t.below);
      r.classList.toggle('drop-below', !!t.below);
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop-above', 'drop-below'));
    r.addEventListener('drop', (e) => {
      const t = dropTarget(r, e);
      r.classList.remove('drop-above', 'drop-below');
      if (!t || !drag) return;
      e.preventDefault();
      if (drag.kind === 'step') engine.moveStep(drag.id, t.parent, t.index);
      else engine.moveAction(drag.id, t.parent, t.index);
    });
  }

  function stepDetails(step) {
    const box = document.createElement('div');
    box.className = 'act-details';
    const lines = [];
    if (step.stop) lines.push(['Message', step.stop.message || '(none)'], ['Continue', step.stop.allowContinue ? 'allowed' : 'not allowed']);
    else if (step.conditional) lines.push(['If', conditionLabel(step.conditional.test)], ['Then play', step.conditional.thenAction ?? 'None'], ['Else play', step.conditional.elseAction ?? 'None']);
    else if (step.menuItem) lines.push(['Menu item', 'asks for its settings on playback']);
    else if (step.arg !== null && typeof step.arg === 'object' && !Array.isArray(step.arg)) {
      for (const [k, v] of Object.entries(step.arg).slice(0, 14)) lines.push([k, describeArg(v, 48) || (v === null ? 'none' : '…')]);
      if (Object.keys(step.arg).length > 14) lines.push(['…', `${Object.keys(step.arg).length - 14} more`]);
    } else if (step.arg !== undefined) lines.push(['Value', describeArg(step.arg, 64)]);
    else lines.push(['Settings', 'none']);
    for (const [k, v] of lines) {
      const line = document.createElement('div');
      const key = document.createElement('span');
      key.className = 'act-key';
      key.textContent = `${k}: `;
      line.append(key, document.createTextNode(String(v)));
      box.appendChild(line);
    }
    return box;
  }

  function render() {
    pending = 0;
    const list = !engine.buttonMode;
    tree.hidden = !list;
    buttons.hidden = list;
    for (const b of footer.querySelectorAll('[data-cmd]')) {
      b.hidden = !list;
      b.disabled = !app.commands.isEnabled(b.dataset.cmd);
    }
    footer.querySelector('.act-record').classList.toggle('recording', !!engine.recording);
    el.classList.toggle('is-recording', !!engine.recording);
    el.classList.toggle('is-playing', !!engine.playing);
    if (list) renderTree();
    else renderButtons();
  }

  function renderTree() {
    const sel = engine.selection;
    const frag = document.createDocumentFragment();
    if (!engine.sets.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'No actions. Create a set and an action, then press Record, or choose Reset Actions from the panel menu.';
      frag.appendChild(empty);
    }
    for (const set of engine.sets) {
      const all = set.actions.flatMap((a) => a.steps);
      const sr = row('set', set.id, 1, sel.set === set.id && !sel.action && !sel.step);
      sr.setAttribute('aria-expanded', String(!set.collapsed));
      sr.append(
        checkbox(checkState(all), 'Include all steps of this set', (on) => setAll(all, { enabled: on })),
        dialogToggle(dialogState(all), 'Show the dialogs of this set on playback', (on) => setAll(all, { dialog: on })),
        twisty(!set.collapsed, () => {
          set.collapsed = !set.collapsed;
          engine.changed('fold');
        }),
      );
      sr.insertAdjacentHTML('beforeend', icon('folder'));
      sr.appendChild(name(set.name));
      sr.addEventListener('click', () => engine.select({ set: set.id }));
      sr.addEventListener('dblclick', (e) => {
        if (e.target.closest('input, button')) return;
        run('actions:rename');
      });
      acceptDrops(sr);
      frag.appendChild(sr);
      if (set.collapsed) continue;
      for (const action of set.actions) {
        const ar = row('action', action.id, 2, sel.action === action.id && !sel.step);
        ar.setAttribute('aria-expanded', String(!action.collapsed));
        if (engine.recording?.action === action) ar.classList.add('recording');
        if (engine.playing?.action === action) ar.classList.add('playing');
        ar.append(
          checkbox(checkState(action.steps), 'Include all steps of this action', (on) => setAll(action.steps, { enabled: on })),
          dialogToggle(dialogState(action.steps), 'Show the dialogs of this action on playback', (on) => setAll(action.steps, { dialog: on })),
          twisty(!action.collapsed, () => {
            action.collapsed = !action.collapsed;
            engine.changed('fold');
          }),
          name(action.name),
        );
        if (action.color) {
          ar.style.setProperty('--act-color', colorOf(action.color));
          ar.classList.add('has-color');
        }
        if (action.functionKey) {
          const key = document.createElement('span');
          key.className = 'act-fkey';
          key.textContent = functionKeyLabel(action.functionKey, isMac);
          ar.appendChild(key);
        }
        ar.addEventListener('click', () => engine.select({ action: action.id }));
        ar.addEventListener('dblclick', (e) => {
          if (e.target.closest('input, button')) return;
          run('actions:action-options');
        });
        makeDraggable(ar, 'action', action.id);
        acceptDrops(ar);
        frag.appendChild(ar);
        if (action.collapsed) continue;
        for (const step of action.steps) {
          const open = expanded.has(step.id);
          const st = row('step', step.id, 3, sel.step === step.id);
          st.classList.toggle('off', !step.enabled);
          if (engine.playing?.step === step) st.classList.add('playing');
          const kind = stepKind(step);
          st.append(
            checkbox(step.enabled, 'Include this step', () => run('actions:toggle-step', step.id)),
            dialogToggle(canDialog(step) ? !!step.dialog : undefined, step.dialog ? 'Shows its dialog on playback (click to use the recorded settings)' : 'Uses the recorded settings (click to show the dialog on playback)', () => run('actions:toggle-dialog', step.id)),
            twisty(open, () => {
              if (open) expanded.delete(step.id);
              else expanded.add(step.id);
              schedule();
            }),
            name(step.label, kind === 'stop' ? 'act-stop' : kind === 'conditional' ? 'act-cond' : step.menuItem ? 'act-menu' : ''),
          );
          const summary = step.stop ? step.stop.message : step.menuItem ? 'menu item' : describeArg(step.arg, 40);
          if (summary && !open) {
            const s = document.createElement('span');
            s.className = 'act-summary muted';
            s.textContent = summary;
            st.appendChild(s);
          }
          st.title = step.command ? `${step.label} (${step.command})` : step.label;
          st.addEventListener('click', () => engine.select({ step: step.id }));
          st.addEventListener('dblclick', (e) => {
            if (e.target.closest('input, button')) return;
            engine.select({ step: step.id });
            run('actions:edit-step', step.id);
          });
          makeDraggable(st, 'step', step.id);
          acceptDrops(st);
          frag.appendChild(st);
          if (open) frag.appendChild(stepDetails(step));
        }
      }
    }
    tree.replaceChildren(frag);
    // keep the step being recorded or played in view
    const follow = engine.playing?.step?.id ?? (engine.recording ? sel.step : null);
    if (follow) tree.querySelector(`.act-step[data-id="${follow}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function renderButtons() {
    const frag = document.createDocumentFragment();
    for (const set of engine.sets) {
      for (const action of set.actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'act-button';
        b.dataset.id = action.id;
        b.setAttribute('role', 'listitem');
        const color = colorOf(action.color);
        if (color) {
          b.style.setProperty('--act-color', color);
          b.classList.add('has-color');
        }
        b.appendChild(name(action.name));
        if (action.functionKey) {
          const key = document.createElement('span');
          key.className = 'act-fkey';
          key.textContent = functionKeyLabel(action.functionKey, isMac);
          b.appendChild(key);
        }
        b.title = `Play “${action.name}” (${set.name})`;
        b.disabled = !!engine.playing;
        if (engine.playing?.action === action) b.classList.add('playing');
        b.addEventListener('click', () => run('actions:play', { id: action.id }));
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          app.dialogs.popover(b, menu(), { at: { x: e.clientX, y: e.clientY } });
        });
        frag.appendChild(b);
      }
    }
    if (!frag.childNodes.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'No actions. Turn Button Mode off in the panel menu to record one.';
      frag.appendChild(empty);
    }
    buttons.replaceChildren(frag);
  }

  // keyboard: arrows walk the visible rows, Delete removes, Enter edits, Space plays
  tree.addEventListener('keydown', (e) => {
    if (e.target !== tree) return;
    const rows = [...tree.querySelectorAll('.act-row')];
    const at = rows.findIndex((r) => r.classList.contains('selected'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) engine.select({ [next.dataset.kind]: next.dataset.id });
    } else if (e.key === 'Delete' || e.key === 'Backspace') run('actions:delete');
    else if (e.key === 'Enter') {
      const kind = rows[at]?.dataset.kind;
      if (kind === 'step') run('actions:edit-step');
      else if (kind === 'action') run('actions:action-options');
      else if (kind === 'set') run('actions:rename');
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  tree.addEventListener('mousedown', (e) => {
    if (!e.target.closest('input, button')) tree.focus({ preventScroll: true });
  });

  app.on('actions:changed', schedule);
  app.on('commands:changed', () => {
    // enabled states of the footer follow the document (Play needs nothing, Record needs no playback…)
    if (!visible() || pending) return;
    for (const b of footer.querySelectorAll('[data-cmd]')) b.disabled = !app.commands.isEnabled(b.dataset.cmd);
  });
  app.panels.register({ id: 'actions', title: 'Actions', icon: 'play', element: el, group: 'bottom', onShow: schedule });
}
