// Printing: renders the chosen pages (with annotations and form values) into the hidden
// #print-container and hands the page to the system print dialog.
import { bridge } from './bridge.js';
import { parsePageRanges } from '../../shared/page-ranges.js';
import { AnnotationMode } from './viewer.js';

export function install(app) {
  const container = document.getElementById('print-container');

  app.commands.register('file:print', {
    enabled: () => !!app.session,
    run: async () => {
      const session = app.session;
      const v = session.view;
      const content = document.createElement('div');
      content.innerHTML = `
        <label class="checkbox"><input type="radio" name="print-range" value="all" checked> All pages (${v.numPages})</label>
        <label class="checkbox"><input type="radio" name="print-range" value="current"> Current page (${v.page})</label>
        <label class="checkbox"><input type="radio" name="print-range" value="custom"> Pages: <input class="input" data-pages placeholder="e.g. 1-3, 5" style="width:160px;display:inline-block;margin-left:6px"></label>
        <div class="field-row" style="margin-top:10px">
          <label class="field"><span>Quality</span><select class="select" data-dpi><option value="110">Draft (110 dpi)</option><option value="150" selected>Normal (150 dpi)</option><option value="300">High (300 dpi)</option></select></label>
          <label class="field"><span>Content</span><select class="select" data-annots><option value="1" selected>Document, comments and form fields</option><option value="0">Document only</option></select></label>
        </div>
        <label class="checkbox"><input type="checkbox" data-fit checked> Fit each page to the paper</label>
        <p class="muted">The system print dialog opens next, where you choose the printer, paper and copies.</p>`;
      content.querySelector('[data-pages]').addEventListener('focus', () => (content.querySelector('input[value="custom"]').checked = true));
      const ok = await app.dialogs.open({ title: 'Print', content, buttons: [{ label: 'Cancel', value: null }, { label: 'Print…', value: true, primary: true }] });
      if (!ok) return;
      const mode = content.querySelector('input[name="print-range"]:checked').value;
      let indices;
      try {
        indices = mode === 'all' ? parsePageRanges('', v.numPages) : mode === 'current' ? [v.page - 1] : parsePageRanges(content.querySelector('[data-pages]').value, v.numPages);
      } catch (err) {
        app.dialogs.toast(err.message, { kind: 'error' });
        return;
      }
      if (!indices.length) return;
      const dpi = Number(content.querySelector('[data-dpi]').value) || 150;
      const withAnnots = content.querySelector('[data-annots]').value === '1';
      const fit = content.querySelector('[data-fit]').checked;
      const stop = app.dialogs.toast(`Preparing ${indices.length} page${indices.length === 1 ? '' : 's'} for printing…`, { timeout: 0 });
      container.replaceChildren();
      container.classList.toggle('fit', fit);
      try {
        for (const i of indices) {
          const canvas = await v.renderPage(i, { scale: dpi / 72, annotationMode: withAnnots ? AnnotationMode.ENABLE_FORMS : AnnotationMode.DISABLE, forPrint: true });
          const pageDiv = document.createElement('div');
          pageDiv.className = 'print-page';
          const img = document.createElement('img');
          img.src = canvas.toDataURL('image/jpeg', 0.95);
          img.alt = `Page ${i + 1}`;
          const page = await v.pdfDocument.getPage(i + 1);
          const vp = page.getViewport({ scale: 1, rotation: (page.rotate + v.rotation) % 360 });
          pageDiv.style.setProperty('--page-w', `${(vp.width / 72) * 25.4}mm`);
          pageDiv.style.setProperty('--page-h', `${(vp.height / 72) * 25.4}mm`);
          pageDiv.classList.toggle('landscape', vp.width > vp.height);
          pageDiv.appendChild(img);
          container.appendChild(pageDiv);
        }
        await Promise.all([...container.querySelectorAll('img')].map((img) => (img.complete ? Promise.resolve() : new Promise((r) => (img.onload = img.onerror = r)))));
        stop();
        document.body.classList.add('printing');
        const result = await bridge.print({ printBackground: true });
        if (result && result.ok === false && result.reason && !/cancel/i.test(result.reason)) app.dialogs.toast(`Printing failed: ${result.reason}`, { kind: 'error' });
      } catch (err) {
        stop();
        app.reportError(err, 'Could not print');
      } finally {
        document.body.classList.remove('printing');
        // keep the rendered pages a moment: the native dialog may still be reading them
        setTimeout(() => container.replaceChildren(), 60_000);
      }
    },
  });
}
