// Info panel (bottom group): colour under the pointer (sampled from the composite, all layers),
// pointer position, document size, selection size, active layer bounds and the colour sampler
// points placed with the Color Sampler tool (doc.samplers).
import { layerContentBounds } from './properties.js';
import { rgbaToHex, rgbToCmyk, rgbToLab, rgbToHsv } from '../../../shared/pixels/color.js';

// the secondary readout (settings.infoSecondary): label -> rows of [key, text]
const SECONDARY = {
  cmyk: { label: 'CMYK', rows: ([r, g, b]) => rgbToCmyk(r, g, b).map((v, i) => ['CMYK'[i], `${Math.round(v)}%`]) },
  lab: { label: 'Lab', rows: ([r, g, b]) => rgbToLab(r, g, b).map((v, i) => ['Lab'[i], String(Math.round(v))]) },
  hsb: { label: 'HSB', rows: ([r, g, b]) => rgbToHsv(r, g, b).map((v, i) => (i ? [i === 1 ? 'S' : 'B', `${Math.round(v * 100)}%`] : ['H', `${Math.round(v)}°`])) },
};

const UNIT_LABEL = { px: 'px', in: 'in', cm: 'cm', mm: 'mm', pt: 'pt', percent: '%' };

export function install(app) {
  const el = document.createElement('div');
  el.className = 'info-panel';
  el.innerHTML = `
    <div class="info-block info-pointer">
      <div class="info-col">
        <div class="info-swatch-row"><span class="info-swatch" data-k="swatch"></span><span class="mono" data-k="hex">—</span></div>
        <div class="info-grid info-rgb">
          <span class="k">R</span><span data-k="r">—</span>
          <span class="k">G</span><span data-k="g">—</span>
          <span class="k">B</span><span data-k="b">—</span>
          <span class="k">A</span><span data-k="a">—</span>
        </div>
        <div class="info-secondary">
          <select class="select info-mode" data-k="mode" aria-label="Secondary colour readout" title="Second readout: CMYK, Lab or HSB">
            <option value="cmyk">CMYK</option><option value="lab">Lab</option><option value="hsb">HSB</option>
          </select>
          <div class="info-grid info-alt" data-k="alt"></div>
        </div>
      </div>
      <div class="info-col">
        <div class="info-grid">
          <span class="k">X</span><span data-k="x">—</span>
          <span class="k">Y</span><span data-k="y">—</span>
        </div>
        <div class="info-grid info-units muted" data-k="units"></div>
      </div>
    </div>
    <div class="info-block">
      <div class="info-grid info-wide">
        <span class="k">Document</span><span data-k="doc">—</span>
        <span class="k">Selection</span><span data-k="sel">—</span>
        <span class="k">Layer</span><span data-k="layer">—</span>
        <span class="k">Bounds</span><span data-k="bounds">—</span>
      </div>
    </div>
    <div class="info-block info-samplers" hidden>
      <div class="info-title muted">Color samplers</div>
      <div class="info-sampler-list"></div>
    </div>`;
  const $ = (k) => el.querySelector(`[data-k="${k}"]`);
  const mode = $('mode');
  const secondary = () => (SECONDARY[app.settings.infoSecondary] ? app.settings.infoSecondary : 'cmyk');
  mode.value = secondary();
  mode.addEventListener('change', () => {
    app.saveSettingsSoon({ infoSecondary: mode.value });
    renderPointer();
  });
  if (!document.getElementById('info-secondary-style')) {
    const style = document.createElement('style');
    style.id = 'info-secondary-style';
    style.textContent = '.info-secondary { margin-top: 6px; } .info-panel .info-mode { height: 20px; font-size: 10px; padding: 0 4px; margin-bottom: 4px; } .info-panel .info-alt { font-family: var(--mono); }';
    document.head.appendChild(style);
  }
  const samplersBox = el.querySelector('.info-samplers');
  const samplerList = el.querySelector('.info-sampler-list');
  let pointer = null; // { doc, x, y }
  let raf = 0;
  let docTimer = 0;
  let last = { key: '', rgba: null };

  const visible = () => app.panels.isVisible('info');

  function fmtUnit(px, axis, doc) {
    const unit = app.settings.rulerUnit ?? 'px';
    if (unit === 'px' || !doc) return null;
    const dpi = doc.dpi || 72;
    let v;
    if (unit === 'in') v = px / dpi;
    else if (unit === 'cm') v = (px / dpi) * 2.54;
    else if (unit === 'mm') v = (px / dpi) * 25.4;
    else if (unit === 'pt') v = (px / dpi) * 72;
    else if (unit === 'percent') v = (px / (axis === 'x' ? doc.width : doc.height)) * 100;
    else return null;
    return `${Math.round(v * 100) / 100} ${UNIT_LABEL[unit] ?? unit}`;
  }

  /** RGBA of the composite at a document pixel (cached per document version and position). */
  function sampleAt(doc, x, y) {
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
    const key = `${doc.id}:${doc.version}:${doc.root?.version}:${x}:${y}`;
    if (last.key === key) return last.rgba;
    let rgba = null;
    try {
      const comp = doc.view.compositor.composite(doc);
      const d = comp.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
      rgba = [d[0], d[1], d[2], d[3]];
    } catch (err) {
      console.warn('info sample', err);
    }
    last = { key, rgba };
    return rgba;
  }

  function renderPointer() {
    raf = 0;
    const doc = app.doc;
    const p = pointer && pointer.doc === doc ? pointer : null;
    const inside = !!(doc && p && p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height);
    const x = p ? Math.floor(p.x) : 0, y = p ? Math.floor(p.y) : 0;
    $('x').textContent = p ? `${x} px` : '—';
    $('y').textContent = p ? `${y} px` : '—';
    const ux = p ? fmtUnit(x, 'x', doc) : null, uy = p ? fmtUnit(y, 'y', doc) : null;
    $('units').textContent = ux ? `${ux} · ${uy}` : '';
    const rgba = inside ? sampleAt(doc, x, y) : null;
    const sw = $('swatch');
    const sec = SECONDARY[secondary()];
    if (mode.value !== secondary()) mode.value = secondary();
    $('alt').replaceChildren(...sec.rows(rgba ?? [0, 0, 0]).flatMap(([k, v]) => {
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = k;
      const val = document.createElement('span');
      val.textContent = rgba ? v : '—';
      return [key, val];
    }));
    if (rgba) {
      $('r').textContent = String(rgba[0]);
      $('g').textContent = String(rgba[1]);
      $('b').textContent = String(rgba[2]);
      $('a').textContent = `${Math.round((rgba[3] / 255) * 100)}%`;
      const hex = rgbaToHex([rgba[0], rgba[1], rgba[2]]);
      $('hex').textContent = hex;
      sw.style.setProperty('--c', `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`);
      sw.classList.remove('none');
    } else {
      for (const k of ['r', 'g', 'b', 'a', 'hex']) $(k).textContent = '—';
      sw.style.removeProperty('--c');
      sw.classList.add('none');
    }
  }

  function rectText(r) {
    return `${Math.round(r.width)} × ${Math.round(r.height)} at ${Math.round(r.x)}, ${Math.round(r.y)}`;
  }

  function renderDoc() {
    docTimer = 0;
    const doc = app.doc;
    if (!doc) {
      for (const k of ['doc', 'sel', 'layer', 'bounds']) $(k).textContent = '—';
      samplersBox.hidden = true;
      renderPointer();
      return;
    }
    $('doc').textContent = `${doc.width} × ${doc.height} px · ${doc.dpi} ppi`;
    const sb = doc.selection && !doc.selection.isEmpty ? doc.selection.bounds : null;
    $('sel').textContent = sb ? rectText(sb) : 'None';
    const layer = doc.active;
    $('layer').textContent = layer ? layer.name : 'None';
    let b = null;
    try {
      b = layer ? layerContentBounds(layer) : null;
    } catch {
      b = layer?.bounds?.() ?? null;
    }
    $('bounds').textContent = layer ? (b ? rectText(b) : layer.type === 'adjustment' ? 'Whole image' : 'Empty') : '—';
    renderSamplers(doc);
    renderPointer();
  }

  function renderSamplers(doc) {
    const list = doc?.samplers ?? [];
    samplersBox.hidden = !list.length;
    samplerList.replaceChildren();
    list.forEach((s, i) => {
      const rgba = sampleAt(doc, Math.floor(s.x), Math.floor(s.y));
      const rowEl = document.createElement('div');
      rowEl.className = 'info-sampler';
      const sw = document.createElement('span');
      sw.className = 'info-swatch small' + (rgba ? '' : ' none');
      if (rgba) sw.style.setProperty('--c', `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`);
      const t = document.createElement('span');
      t.className = 'mono';
      t.textContent = rgba ? `#${i + 1}  R ${rgba[0]}  G ${rgba[1]}  B ${rgba[2]}  ${rgbaToHex([rgba[0], rgba[1], rgba[2]])}` : `#${i + 1}  outside the image`;
      const pos = document.createElement('span');
      pos.className = 'muted';
      pos.textContent = `${Math.floor(s.x)}, ${Math.floor(s.y)}`;
      rowEl.append(sw, t, pos);
      samplerList.appendChild(rowEl);
    });
  }

  const scheduleDoc = (delay = 80) => {
    if (!visible()) return;
    clearTimeout(docTimer);
    docTimer = setTimeout(renderDoc, delay);
  };

  app.on('pointer:moved', ({ view, x, y }) => {
    pointer = { doc: view?.doc ?? app.doc, x, y };
    if (!visible() || raf) return;
    raf = requestAnimationFrame(renderPointer);
  });
  app.on('doc:activated', () => {
    pointer = null;
    scheduleDoc(0);
  });
  app.on('layer:activated', () => scheduleDoc());
  app.on('selection:changed', () => scheduleDoc());
  app.on('samplers:changed', () => scheduleDoc(0));
  app.on('settings:changed', (patch) => {
    if (patch && ('rulerUnit' in patch || 'infoSecondary' in patch)) scheduleDoc(0);
  });
  app.on('doc:change', (e) => {
    if (e.doc !== app.doc) return;
    scheduleDoc(e.kind === 'pixels' || e.kind === 'mask' ? 300 : 120);
  });

  app.panels.register({ id: 'info', title: 'Info', icon: 'info', element: el, group: 'bottom', onShow: () => renderDoc() });
  renderDoc();
}
