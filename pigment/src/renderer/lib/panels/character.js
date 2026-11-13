// Character panel (type-character-panel, ARCHITECTURE.md "0.4 features", package 3): every character attribute of
// the range model for the text being edited (its selection, or the caret's insertion style), else the selected text
// layers (one history entry per change whatever their number), else the defaults for new text. Mixed values show
// blank; the panel re-reads on 'type:selection' (B.7). The controls are built by lib/type/char-format.js, which the
// Properties text section shares; the sections other packages register (L.14) follow them.
import { icon } from '../icons.js';
import { onFontsChanged } from '../tools/text.js';
import { createCharacterControls, characterMenuItems, setTypeUnit } from '../type/char-format.js';
import { typeUnit } from '../type/char-values.js';

const TYPE_TOOLS = ['type-horizontal', 'type-vertical'];

export function install(app) {
  const el = document.createElement('div');
  el.className = 'char-panel';
  const head = document.createElement('div');
  head.className = 'char-head';
  const empty = document.createElement('div');
  empty.className = 'panel-empty char-empty';
  empty.textContent = 'No text layer selected. These settings apply to new text.';
  empty.hidden = true;
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'pbtn char-menu';
  menuBtn.dataset.act = 'menu';
  menuBtn.title = 'Character panel menu';
  menuBtn.setAttribute('aria-label', 'Character panel menu');
  menuBtn.innerHTML = icon('more');
  head.append(empty, menuBtn);
  el.appendChild(head);

  let controls = createCharacterControls(app, { variant: 'panel' });
  el.appendChild(controls.element);

  menuBtn.addEventListener('click', () => {
    app.dialogs.popover(menuBtn, characterMenuItems(app, (a, u) => setTypeUnit(a, u)), { align: 'right' });
  });

  let pending = 0;
  function refresh() {
    pending = 0;
    // a hidden panel catches up in onShow
    if (app.panels.panels?.has?.('character') && !app.panels.isVisible('character')) return;
    // the unit changed: the fields carry it in their labels, so they are built again
    if (controls.unit !== typeUnit(app.settings)) {
      const next = createCharacterControls(app, { variant: 'panel' });
      controls.element.replaceWith(next.element);
      controls.destroy();
      controls = next;
    }
    controls.refresh();
    empty.hidden = controls.element.dataset.target !== 'defaults';
  }
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(refresh);
  };
  app.on('doc:activated', schedule);
  app.on('doc:change', (e) => {
    if (['props', 'active', 'tree', 'history', 'canvas'].includes(e.kind)) schedule();
  });
  app.on('type:session', schedule);
  app.on('type:selection', schedule);
  app.on('type:sections-changed', ({ panel } = {}) => {
    if (panel === 'character') schedule();
  });
  app.on('tool:options', (e) => {
    if (TYPE_TOOLS.includes(e?.tool)) schedule();
  });
  app.on('color:changed', schedule);
  app.on('settings:changed', schedule);
  onFontsChanged(schedule);

  app.panels.register({ id: 'character', title: 'Character', icon: 'character', element: el, group: 'middle', onShow: refresh });
  refresh();
  return { refresh };
}
