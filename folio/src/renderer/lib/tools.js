// Extra tools: export text and page images, flatten, measure distances, read out loud, snapshot.
import * as engine from '../../shared/engine.js';
import { bridge, joinPath } from './bridge.js';
import { icon } from './icons.js';
import { parsePageRanges } from '../../shared/page-ranges.js';
import { AnnotationMode } from './viewer.js';

const UNITS = { mm: { perPt: 25.4 / 72, label: 'mm', digits: 1 }, cm: { perPt: 2.54 / 72, label: 'cm', digits: 2 }, in: { perPt: 1 / 72, label: 'in', digits: 2 }, pt: { perPt: 1, label: 'pt', digits: 0 } };

export function install(app) {
  const has = () => !!app.session;
  const view = () => app.view;

  // ---- export text ----------------------------------------------------------------------------------
  app.commands.register('file:export-text', {
    enabled: has,
    run: async () => {
      const session = app.session;
      const target = await bridge.saveFileDialog({ defaultPath: session.name.replace(/\.pdf$/i, '') + '.txt', filters: [{ name: 'Text', extensions: ['txt'] }], title: 'Export text' });
      if (!target) return;
      const parts = [];
      for (let i = 0; i < session.view.numPages; i++) parts.push(await session.view.getPageText(i));
      await bridge.writeFile(target, new TextEncoder().encode(parts.join('\n\n----- page break -----\n\n')));
      app.dialogs.toast('Text exported', { kind: 'success', timeout: 1500 });
    },
  });

  // ---- export page images -----------------------------------------------------------------------------
  app.commands.register('file:export-images', {
    enabled: has,
    run: async () => {
      const session = app.session;
      const v = session.view;
      const content = document.createElement('div');
      content.innerHTML = `
        <label class="field"><span>Pages (e.g. 1-3, 5; empty = all)</span><input class="input" data-pages value="${v.page}"></label>
        <div class="field-row">
          <label class="field"><span>Format</span><select class="select" data-format><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label>
          <label class="field"><span>Resolution</span><select class="select" data-dpi><option value="96">96 dpi (screen)</option><option value="150" selected>150 dpi</option><option value="300">300 dpi (print)</option></select></label>
        </div>
        <label class="checkbox"><input type="checkbox" data-annots checked> Include annotations and form fields</label>`;
      const ok = await app.dialogs.open({ title: 'Export pages as images', content, buttons: [{ label: 'Cancel', value: null }, { label: 'Export…', value: true, primary: true }] });
      if (!ok) return;
      let indices;
      try {
        indices = parsePageRanges(content.querySelector('[data-pages]').value, v.numPages);
      } catch (err) {
        app.dialogs.toast(err.message, { kind: 'error' });
        return;
      }
      const format = content.querySelector('[data-format]').value;
      const dpi = Number(content.querySelector('[data-dpi]').value) || 150;
      const annots = content.querySelector('[data-annots]').checked;
      const base = session.name.replace(/\.pdf$/i, '');
      const ext = format === 'jpeg' ? 'jpg' : 'png';
      let dir = null;
      let single = null;
      if (indices.length === 1) {
        single = await bridge.saveFileDialog({ defaultPath: `${base}-page-${indices[0] + 1}.${ext}`, filters: [{ name: format.toUpperCase(), extensions: [ext] }], title: 'Save image' });
        if (!single) return;
      } else {
        dir = await bridge.openDirectoryDialog({ title: 'Choose a folder for the images' });
      }
      const stop = app.dialogs.toast(`Exporting ${indices.length} page${indices.length === 1 ? '' : 's'}…`, { timeout: 0 });
      try {
        for (const i of indices) {
          const canvas = await v.renderPage(i, { scale: dpi / 72, annotationMode: annots ? AnnotationMode.ENABLE_FORMS : AnnotationMode.DISABLE, forPrint: true });
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.92));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const name = `${base}-page-${i + 1}.${ext}`;
          const target = single ?? (dir ? joinPath(dir, name) : await bridge.saveFileDialog({ defaultPath: name, title: `Save page ${i + 1}` }));
          if (!target) break;
          await bridge.writeFile(target, bytes);
        }
        app.dialogs.toast('Images exported', { kind: 'success', timeout: 1500 });
      } catch (err) {
        app.reportError(err, 'Export failed');
      } finally {
        stop();
      }
    },
  });

  // ---- flatten ---------------------------------------------------------------------------------------------
  app.commands.register('file:flatten', {
    enabled: has,
    run: async () => {
      const content = document.createElement('div');
      content.innerHTML = `<p>Flattening bakes content into the pages so it can no longer be edited.</p>
        <label class="checkbox"><input type="checkbox" data-forms checked> Flatten form fields (keeps the typed values as page content)</label>
        <label class="checkbox"><input type="checkbox" data-annots checked> Flatten comments and drawings (highlights, shapes, stamps, signatures)</label>
        <p class="muted">Tip: use File › Save a Copy first if you want to keep an editable version.</p>`;
      const ok = await app.dialogs.open({ title: 'Flatten document', content, buttons: [{ label: 'Cancel', value: null }, { label: 'Flatten', value: true, primary: true }] });
      if (!ok) return;
      const forms = content.querySelector('[data-forms]').checked;
      const annots = content.querySelector('[data-annots]').checked;
      if (!forms && !annots) return;
      await app.edit.apply(async (bytes) => {
        let out = bytes;
        if (forms) out = await engine.flattenForms(out);
        if (annots) out = await engine.flattenAnnotations(out);
        return out;
      }, { label: 'Flatten' });
    },
  });

  // ---- measure ------------------------------------------------------------------------------------------------
  const measure = { active: false, pageIndex: -1, start: null, overlay: null, svg: null, label: null, session: null };
  function endMeasure() {
    measure.overlay?.remove();
    measure.overlay = null;
    measure.start = null;
    measure.active = false;
    app.view?.container.classList.remove('tool-measure');
  }
  app.commands.register('tool:measure', {
    enabled: has,
    checked: () => app.tool === 'measure',
    run: () => {
      if (app.tool === 'measure') return app.commands.run('tool:none', undefined, 'api');
      app.commands.run('tool:none', undefined, 'api');
      measure.active = true;
      view().container.classList.add('tool-measure');
      app.setTool('measure');
      const bar = document.createElement('div');
      bar.className = 'tool-options';
      const hintEl = document.createElement('span');
      hintEl.className = 'tool-hint';
      hintEl.textContent = 'Click two points on a page to measure the distance between them';
      const unitSel = document.createElement('select');
      unitSel.className = 'tb-select';
      for (const u of Object.keys(UNITS)) unitSel.add(new Option(u, u, false, u === app.settings.measureUnit));
      unitSel.addEventListener('change', () => app.saveSettings({ measureUnit: unitSel.value }));
      const done = document.createElement('button');
      done.className = 'btn quiet tool-done';
      done.innerHTML = `${icon('check')} Done`;
      done.addEventListener('click', () => app.commands.run('tool:none', undefined, 'toolbar'));
      bar.append(hintEl, unitSel, done);
      app.toolbar.setSecondary(bar);
    },
  });
  app.on('tool:changed', ({ tool }) => {
    if (tool !== 'measure') endMeasure();
  });
  document.addEventListener(
    'click',
    (event) => {
      if (!measure.active || event.button !== 0) return;
      const v = view();
      const pageIndex = v?.pageIndexAt(event.clientX, event.clientY);
      if (pageIndex === undefined || pageIndex < 0) return;
      event.preventDefault();
      event.stopPropagation();
      const pt = v.clientToPdf(pageIndex, event.clientX, event.clientY);
      if (!measure.start || measure.pageIndex !== pageIndex) {
        measure.overlay?.remove();
        measure.pageIndex = pageIndex;
        measure.start = pt;
        const pageEl = v.pageElement(pageIndex);
        const overlay = document.createElement('div');
        overlay.className = 'folio-overlay';
        overlay.innerHTML = '<svg></svg><div class="folio-measure-label"></div>';
        pageEl.appendChild(overlay);
        measure.overlay = overlay;
        measure.svg = overlay.querySelector('svg');
        measure.label = overlay.querySelector('.folio-measure-label');
        drawMeasure(pt);
      } else {
        drawMeasure(pt, true);
        measure.start = null;
      }
    },
    true
  );
  document.addEventListener('mousemove', (event) => {
    if (!measure.active || !measure.start) return;
    const v = view();
    if (v?.pageIndexAt(event.clientX, event.clientY) !== measure.pageIndex) return;
    drawMeasure(v.clientToPdf(measure.pageIndex, event.clientX, event.clientY));
  });
  function drawMeasure(end, final = false) {
    const v = view();
    const pv = v.getPageView(measure.pageIndex);
    if (!pv || !measure.svg) return;
    const a = pv.viewport.convertToViewportPoint(measure.start.x, measure.start.y);
    const b = pv.viewport.convertToViewportPoint(end.x, end.y);
    const unit = UNITS[app.settings.measureUnit] ?? UNITS.mm;
    const dist = Math.hypot(end.x - measure.start.x, end.y - measure.start.y) * unit.perPt;
    measure.svg.innerHTML = `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#e53935" stroke-width="2" stroke-dasharray="${final ? '0' : '6 4'}"/><circle cx="${a[0]}" cy="${a[1]}" r="4" fill="#e53935"/><circle cx="${b[0]}" cy="${b[1]}" r="4" fill="#e53935"/>`;
    measure.label.style.left = `${(a[0] + b[0]) / 2}px`;
    measure.label.style.top = `${(a[1] + b[1]) / 2}px`;
    measure.label.textContent = `${dist.toFixed(unit.digits)} ${unit.label}`;
    if (final) app.statusbar.set('measure', `Distance: ${dist.toFixed(unit.digits)} ${unit.label}`);
  }

  // ---- read out loud (Web Speech API) --------------------------------------------------------------------------
  let speaking = false;
  let speakToken = 0;
  function stopSpeaking() {
    speakToken++;
    speaking = false;
    app.readAloud = false;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    app.statusbar.clear('speech');
    app.commands.invalidate();
  }
  async function speakFrom(session, startPage, onlyText) {
    if (!window.speechSynthesis) {
      app.dialogs.toast('Text to speech is not available on this system', { kind: 'error' });
      return;
    }
    stopSpeaking();
    const token = ++speakToken;
    speaking = true;
    app.readAloud = true;
    app.commands.invalidate();
    const say = (text) =>
      new Promise((resolve) => {
        if (!text.trim()) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        u.onend = resolve;
        u.onerror = resolve;
        window.speechSynthesis.speak(u);
      });
    if (onlyText) {
      app.statusbar.set('speech', 'Reading selection…');
      await say(onlyText);
      if (token === speakToken) stopSpeaking();
      return;
    }
    for (let i = startPage; i < session.view.numPages && token === speakToken; i++) {
      app.statusbar.set('speech', `Reading page ${i + 1}… (press Esc to stop)`);
      if (session === app.session) session.view.page = i + 1;
      const text = await session.view.getPageText(i);
      // sentence chunks keep the engine responsive and let us stop quickly
      for (const chunk of text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) ?? [text]) {
        if (token !== speakToken) return;
        await say(chunk);
      }
    }
    if (token === speakToken) stopSpeaking();
  }
  app.commands.register('view:read-aloud', {
    enabled: has,
    checked: () => speaking,
    run: (arg) => {
      if (speaking && arg !== 'selection') return stopSpeaking();
      const session = app.session;
      const selection = arg === 'selection' ? document.getSelection()?.toString() : '';
      return speakFrom(session, session.view.page - 1, selection || null);
    },
  });
  app.on('tab:activated', () => speaking && stopSpeaking());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && speaking) stopSpeaking();
  });

  // ---- snapshot -----------------------------------------------------------------------------------------------------
  const snap = { active: false };
  app.commands.register('edit:snapshot', {
    enabled: has,
    checked: () => app.tool === 'snapshot',
    run: () => {
      if (app.tool === 'snapshot') return app.commands.run('tool:none', undefined, 'api');
      app.commands.run('tool:none', undefined, 'api');
      snap.active = true;
      view().container.classList.add('tool-snapshot');
      app.setTool('snapshot');
      const bar = document.createElement('div');
      bar.className = 'tool-options';
      bar.innerHTML = `<span class="tool-hint">Drag a rectangle on the page to copy it as an image</span>`;
      const done = document.createElement('button');
      done.className = 'btn quiet tool-done';
      done.innerHTML = `${icon('check')} Done`;
      done.addEventListener('click', () => app.commands.run('tool:none', undefined, 'toolbar'));
      bar.appendChild(done);
      app.toolbar.setSecondary(bar);
    },
  });
  app.on('tool:changed', ({ tool }) => {
    if (tool !== 'snapshot') {
      snap.active = false;
      app.view?.container.classList.remove('tool-snapshot');
    }
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!snap.active || event.button !== 0) return;
      const v = view();
      const pageEl = event.target.closest?.('.page');
      if (!pageEl || !v?.container.contains(pageEl)) return;
      event.preventDefault();
      event.stopPropagation();
      const pageIndex = Number(pageEl.dataset.pageNumber) - 1;
      const rect = pageEl.getBoundingClientRect();
      const overlay = document.createElement('div');
      overlay.className = 'folio-overlay active';
      overlay.innerHTML = '<svg></svg>';
      pageEl.appendChild(overlay);
      const svg = overlay.querySelector('svg');
      const x0 = event.clientX - rect.left, y0 = event.clientY - rect.top;
      let x1 = x0, y1 = y0;
      const move = (e) => {
        x1 = e.clientX - rect.left;
        y1 = e.clientY - rect.top;
        svg.innerHTML = `<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="rgba(79,70,229,0.15)" stroke="#4f46e5" stroke-dasharray="4 3"/>`;
      };
      const up = async () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        overlay.remove();
        if (Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) return;
        try {
          const scale = 2 * v.scale;
          const canvas = await v.renderPage(pageIndex, { scale, annotationMode: AnnotationMode.ENABLE_FORMS });
          const sx = (Math.min(x0, x1) / rect.width) * canvas.width;
          const sy = (Math.min(y0, y1) / rect.height) * canvas.height;
          const sw = (Math.abs(x1 - x0) / rect.width) * canvas.width;
          const sh = (Math.abs(y1 - y0) / rect.height) * canvas.height;
          const out = document.createElement('canvas');
          out.width = Math.max(1, Math.round(sw));
          out.height = Math.max(1, Math.round(sh));
          out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
          bridge.writeClipboardImage(out.toDataURL('image/png'));
          app.dialogs.toast('Snapshot copied to the clipboard', { kind: 'success', timeout: 1800 });
        } catch (err) {
          app.reportError(err, 'Snapshot failed');
        }
        app.commands.run('tool:none', undefined, 'api');
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    },
    true
  );

  app.toolbar.addButton({ id: 'measure', group: 'tools', icon: 'measure', title: 'Measure distance', command: 'tool:measure', toggle: true });
}
