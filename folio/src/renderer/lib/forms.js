// Form helpers: field highlighting, tabbing between fields, reset and data export.
import * as engine from '../../shared/engine.js';
import { bridge } from './bridge.js';

export function install(app) {
  const fieldInputs = () => {
    const v = app.view;
    if (!v) return [];
    return [...v.container.querySelectorAll('.annotationLayer input:not([type="hidden"]), .annotationLayer textarea, .annotationLayer select, .annotationLayer button')].filter((el) => !el.disabled && el.offsetParent !== null);
  };

  app.commands.registerAll({
    'form:toggle-highlight': {
      enabled: () => !!app.session,
      checked: () => app.settings.highlightFormFields !== false,
      run: async () => {
        const next = !(app.settings.highlightFormFields !== false);
        await app.saveSettings({ highlightFormFields: next });
        for (const s of app.tabs.list()) s.view.setHighlightFields(next);
      },
    },
    'form:next-field': {
      enabled: () => !!app.session,
      run: () => {
        const inputs = fieldInputs();
        if (!inputs.length) {
          app.dialogs.toast('No form fields on the visible pages', { timeout: 1500 });
          return;
        }
        const index = inputs.indexOf(document.activeElement);
        const next = inputs[(index + 1) % inputs.length];
        next.focus();
        next.scrollIntoView?.({ block: 'center' });
      },
    },
    'form:reset': {
      enabled: () => !!app.session,
      run: async () => {
        const ok = await app.dialogs.confirm('Clear every form field in this document?', { title: 'Reset form', okLabel: 'Reset', danger: true });
        if (!ok) return;
        await app.edit.apply((bytes) => engine.resetForm(bytes), { label: 'Reset form' });
      },
    },
    'form:export': { enabled: () => !!app.session, run: () => exportFormData() },
    'file:export-form-data': { enabled: () => !!app.session, run: () => exportFormData() },
  });

  async function exportFormData() {
    const session = app.session;
    if (!session) return;
    const bytes = await session.flush();
    let fields;
    try {
      fields = await engine.getFormData(bytes);
    } catch (err) {
      app.reportError(err, 'Could not read the form');
      return;
    }
    if (!fields.length) {
      app.dialogs.toast('This document has no form fields', { timeout: 1800 });
      return;
    }
    const target = await bridge.saveFileDialog({ defaultPath: session.name.replace(/\.pdf$/i, '') + '-form-data.json', filters: [{ name: 'JSON', extensions: ['json'] }], title: 'Export form data' });
    if (!target) return;
    const data = { document: session.name, exportedAt: new Date().toISOString(), fields: Object.fromEntries(fields.map((f) => [f.name, f.value])) };
    await bridge.writeFile(target, new TextEncoder().encode(JSON.stringify(data, null, 2)));
    app.dialogs.toast('Form data exported', { kind: 'success', timeout: 1500 });
  }

  // Status bar hint when the document has fields.
  async function updateStatus(session) {
    if (!session?.view.pdfDocument) {
      app.statusbar.clear('form');
      return;
    }
    try {
      const fields = await session.view.getFieldObjects();
      const count = fields ? (fields instanceof Map ? fields.size : Object.keys(fields).length) : 0;
      if (session !== app.session) return;
      app.statusbar.set('form', count ? `Form: ${count} field${count === 1 ? '' : 's'}` : null);
    } catch {
      app.statusbar.clear('form');
    }
  }
  app.on('doc:loaded', updateStatus);
  app.on('doc:reloaded', updateStatus);
  app.on('tab:activated', updateStatus);
}
