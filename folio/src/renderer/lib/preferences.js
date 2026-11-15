// Preferences dialog.
import { ScrollMode, SpreadMode } from './viewer.js';
import { DEFAULT_SETTINGS } from '../../shared/defaults.js';

export function install(app) {
  app.commands.register('edit:preferences', { run: () => preferencesDialog(app) });
}

async function preferencesDialog(app) {
  const s = app.settings;
  const content = document.createElement('div');
  content.innerHTML = `
    <div class="dialog-tabs" role="tablist">
      <button class="dialog-tab" data-tab="general" aria-selected="true">General</button>
      <button class="dialog-tab" data-tab="view" aria-selected="false">View</button>
      <button class="dialog-tab" data-tab="comments" aria-selected="false">Comments</button>
    </div>
    <div data-pane="general">
      <label class="field"><span>Your name (used as the author of comments and signatures)</span><input class="input" data-k="authorName"></label>
      <label class="field"><span>Appearance</span><select class="select" data-k="theme"><option value="system">Follow the system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label class="checkbox"><input type="checkbox" data-k="restoreSession"> Reopen the documents from the last session on start</label>
      <label class="checkbox"><input type="checkbox" data-k="rememberLastPage"> Reopen documents at the page you left</label>
      <label class="field"><span>Recent files to remember</span><input class="input" type="number" min="0" max="100" data-k="recentLimit"></label>
    </div>
    <div data-pane="view" hidden>
      <label class="field"><span>Default zoom</span><select class="select" data-k="defaultZoom"><option value="auto">Automatic</option><option value="page-fit">Fit page</option><option value="page-width">Fit width</option><option value="page-actual">Actual size</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label>
      <label class="field"><span>Default page layout</span><select class="select" data-k="scrollMode"><option value="0">Continuous</option><option value="3">Single page</option><option value="1">Horizontal</option><option value="2">Wrapped</option></select></label>
      <label class="field"><span>Default spreads</span><select class="select" data-k="spreadMode"><option value="0">None</option><option value="1">Two pages, odd on the left</option><option value="2">Two pages, even on the left</option></select></label>
      <label class="checkbox"><input type="checkbox" data-k="highlightFormFields"> Highlight form fields</label>
      <label class="field"><span>Measurement unit</span><select class="select" data-k="measureUnit"><option value="mm">Millimetres</option><option value="cm">Centimetres</option><option value="in">Inches</option><option value="pt">Points</option></select></label>
    </div>
    <div data-pane="comments" hidden>
      <div class="field-row">
        <label class="field"><span>Drawing thickness</span><input class="input" type="number" min="1" max="20" data-k="inkThickness"></label>
        <label class="field"><span>Shape line width</span><input class="input" type="number" min="1" max="12" data-k="shapeWidth"></label>
        <label class="field"><span>Text box size</span><input class="input" type="number" min="6" max="48" data-k="freeTextSize"></label>
      </div>
      <label class="field"><span>Stamp presets (one per line)</span><textarea class="textarea" data-k="stampPresets"></textarea></label>
      <button class="btn quiet" type="button" data-reset>Restore defaults</button>
    </div>`;
  const fields = [...content.querySelectorAll('[data-k]')];
  const load = (values) => {
    for (const el of fields) {
      const k = el.dataset.k;
      const value = values[k];
      if (el.type === 'checkbox') el.checked = !!value;
      else if (k === 'stampPresets') el.value = (value ?? []).join('\n');
      else el.value = String(value ?? '');
    }
  };
  load(s);
  content.querySelector('[data-reset]').addEventListener('click', () => load({ ...DEFAULT_SETTINGS, authorName: s.authorName }));
  for (const tab of content.querySelectorAll('.dialog-tab')) {
    tab.addEventListener('click', () => {
      for (const t of content.querySelectorAll('.dialog-tab')) t.setAttribute('aria-selected', String(t === tab));
      for (const pane of content.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    });
  }
  const ok = await app.dialogs.open({ title: 'Preferences', content, width: 560, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: true, primary: true }] });
  if (!ok) return;
  const patch = {};
  for (const el of fields) {
    const k = el.dataset.k;
    if (el.type === 'checkbox') patch[k] = el.checked;
    else if (k === 'stampPresets') patch[k] = el.value.split('\n').map((l) => l.trim()).filter(Boolean);
    else if (['recentLimit', 'inkThickness', 'shapeWidth', 'freeTextSize', 'scrollMode', 'spreadMode'].includes(k)) patch[k] = Number(el.value) || DEFAULT_SETTINGS[k];
    else if (k === 'defaultZoom') patch[k] = /^[\d.]+$/.test(el.value) ? Number(el.value) : el.value;
    else patch[k] = el.value;
  }
  await app.saveSettings(patch);
  await app.applyTheme();
  for (const session of app.tabs.list()) {
    session.view.setHighlightFields(patch.highlightFormFields);
    if (session.view.scrollMode !== patch.scrollMode) session.view.scrollMode = patch.scrollMode;
    if (session.view.spreadMode !== patch.spreadMode) session.view.spreadMode = patch.spreadMode;
  }
  app.syncUiState();
  app.dialogs.toast('Preferences saved', { kind: 'success', timeout: 1500 });
}

export { ScrollMode, SpreadMode };
