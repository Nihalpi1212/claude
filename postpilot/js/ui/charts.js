// Charts: inline SVG, sized to the real container width (ResizeObserver) so text
// stays crisp and label thinning is computed against actual pixels. All colors come
// from CSS tokens (--series-1..6, --series-muted, --ink-*, --line*), so charts follow
// the light/dark theme automatically.
//
// Mark specs (see css/app.css "Charts"): 2px lines, >=8px end dots with a 2px surface
// ring, area wash at 10% opacity, bars <= 24px thick with a 4px rounded data end and a
// square baseline, hairline solid gridlines. Every chart has a hover/focus tooltip
// (arrow keys move it when the chart is focused), an aria-label summary, and a
// visually hidden data table for screen readers.

import { html, useState, useRef, useLayoutEffect } from '../../vendor/preact.js';
import { Icon } from './icons.js';

// ---------------------------------------------------------------------------
// Formatting helpers (shared with kit.js)
// ---------------------------------------------------------------------------

const nfCache = new Map();
function nf(opts) {
  const k = JSON.stringify(opts);
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat(undefined, opts));
  return nfCache.get(k);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Format a number for display.
 * kind: 'number' (1,234.5) | 'compact' (12.3K) | 'percent' (fraction 0.123 -> 12.3%)
 *     | 'duration' (seconds -> 1m 05s) | function(n) => string.
 * null/undefined/NaN -> an em dash.
 */
export function formatValue(n, kind = 'number') {
  if (typeof kind === 'function') return n == null ? '—' : kind(n);
  if (n == null || (typeof n === 'number' && Number.isNaN(n))) return '—';
  if (typeof n !== 'number') return String(n);
  const abs = Math.abs(n);
  switch (kind) {
    case 'percent':
      return nf({ style: 'percent', maximumFractionDigits: 1 }).format(n);
    case 'compact':
      if (abs >= 1000) return nf({ notation: 'compact', maximumFractionDigits: 1 }).format(n);
      return nf({ maximumFractionDigits: Number.isInteger(n) ? 0 : 1 }).format(n);
    case 'duration': {
      const s = Math.round(n);
      if (abs < 60) return `${nf({ maximumFractionDigits: abs < 10 ? 1 : 0 }).format(n)}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
      return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    }
    default:
      return nf({ maximumFractionDigits: Number.isInteger(n) ? 0 : abs < 100 ? 2 : 1 }).format(n);
  }
}

/** Signed percent change from a fraction: 0.12 -> "+12%", -0.034 -> "−3.4%". */
export function formatDelta(d) {
  if (!isNum(d)) return '—';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return sign + nf({ style: 'percent', maximumFractionDigits: Math.abs(d) < 0.1 ? 1 : 0 }).format(Math.abs(d));
}

/** Categorical series color by slot (0-based). Past slot 6 everything folds to the muted "other" tone. */
export function seriesColor(i) {
  return i >= 0 && i < 6 ? `var(--series-${i + 1})` : 'var(--series-muted)';
}

/** Round axis bounds and evenly spaced "nice" ticks (1/2/2.5/5 x 10^n). */
export function niceScale(min, max, count = 5, { fixMin = false, fixMax = false } = {}) {
  if (!isNum(min) || !isNum(max)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    if (!fixMin) min -= min === 0 ? 0 : pad;
    max += pad;
  }
  const span = max - min;
  const rough = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = fixMin ? min : Math.floor(min / step + 1e-9) * step;
  const hi = fixMax ? max : Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  const first = Math.ceil(lo / step - 1e-9) * step;
  for (let t = first; t <= hi + step * 1e-6; t += step) ticks.push(Number(t.toPrecision(12)));
  if (fixMin && ticks[0] !== lo) ticks.unshift(lo);
  return { min: lo, max: hi === lo ? lo + step : hi, step, ticks };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MONO_CH = 6.6; // IBM Plex Mono advance at 11px (0.6em)
const SANS_CH = 6.3; // average IBM Plex Sans advance at 11.5px
const monoW = (s) => String(s).length * MONO_CH;
const sansW = (s) => String(s).length * SANS_CH;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const f1 = (n) => Math.round(n * 10) / 10;

function truncate(s, maxPx, chPx = SANS_CH) {
  const str = String(s);
  const max = Math.max(2, Math.floor(maxPx / chPx));
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** Track an element's content width. Returns [ref, width]. */
function useWidth(initial = 640) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const cw = Math.floor(el.clientWidth);
      if (cw > 0) setW(cw);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Choose which x labels to show so they never collide; always keeps the last one. */
function visibleXIndices(n, labels, plotW) {
  if (!n) return [];
  const longest = Math.max(1, ...labels.map((l) => String(l ?? '').length));
  const slot = longest * MONO_CH + 14;
  const fit = Math.max(1, Math.floor(plotW / slot));
  const step = Math.max(1, Math.ceil(n / fit));
  const out = [];
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

function ChartEmpty({ height, text }) {
  return html`<div class="chart-empty" style=${{ minHeight: `${height}px` }}>
    <${Icon} name="chart" size=${20} />
    <span>${text || 'No data yet'}</span>
  </div>`;
}

function SrTable({ caption, head, rows }) {
  return html`<table class="sr-only">
    <caption>${caption}</caption>
    <thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i === 0 ? html`<th scope="row">${c}</th>` : html`<td>${c}</td>`))}</tr>`)}</tbody>
  </table>`;
}

function Tip({ x, y, width, children, align = 'top' }) {
  const side = x > width * 0.58 ? 'left' : 'right';
  return html`<div class="chart-tip" data-side=${side} data-align=${align} style=${{ left: `${x}px`, top: `${y}px` }} aria-hidden="true">${children}</div>`;
}

function TipRow({ color, value, name, shape = 'line' }) {
  return html`<div class="chart-tip-row">
    ${color ? html`<span class=${`legend-key is-${shape}`} style=${{ '--key': color }}></span>` : null}
    <strong class="num">${value}</strong>
    ${name != null && name !== '' ? html`<span class="chart-tip-name">${name}</span>` : null}
  </div>`;
}

/** Keyboard navigation for a 1-D index (arrow keys, Home/End, Escape). */
function keyNav(n, hover, setHover) {
  return (e) => {
    const cur = hover == null ? n - 1 : hover;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(n - 1, cur + (hover == null ? 0 : 1));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, cur - (hover == null ? 0 : 1));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setHover(null);
      return;
    } else return;
    e.preventDefault();
    setHover(next);
  };
}

function vBarPath(xc, y0, y1, w, r = 4) {
  const x0 = f1(xc - w / 2);
  const x1 = f1(xc + w / 2);
  const hgt = Math.abs(y0 - y1);
  if (hgt < 0.5) return '';
  const rr = Math.min(r, w / 2, hgt);
  if (y1 < y0) return `M${x0} ${f1(y0)}V${f1(y1 + rr)}A${rr} ${rr} 0 0 1 ${f1(x0 + rr)} ${f1(y1)}H${f1(x1 - rr)}A${rr} ${rr} 0 0 1 ${x1} ${f1(y1 + rr)}V${f1(y0)}Z`;
  return `M${x0} ${f1(y0)}V${f1(y1 - rr)}A${rr} ${rr} 0 0 0 ${f1(x0 + rr)} ${f1(y1)}H${f1(x1 - rr)}A${rr} ${rr} 0 0 0 ${x1} ${f1(y1 - rr)}V${f1(y0)}Z`;
}

function hBarPath(x0, x1, yc, hgt, r = 4) {
  const w = x1 - x0;
  if (w < 0.5) return '';
  const y0 = f1(yc - hgt / 2);
  const y1 = f1(yc + hgt / 2);
  const rr = Math.min(r, hgt / 2, w);
  return `M${f1(x0)} ${y0}H${f1(x1 - rr)}A${rr} ${rr} 0 0 1 ${f1(x1)} ${f1(y0 + rr)}V${f1(y1 - rr)}A${rr} ${rr} 0 0 1 ${f1(x1 - rr)} ${y1}H${f1(x0)}Z`;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

/**
 * Legend {items: [{label, color?, value?, shape?: 'line'|'rect'|'dot'}], shape?}
 * Keys mirror the mark (line for line charts, rect for bars/areas). Text stays in ink tokens.
 */
export function Legend({ items = [], shape = 'rect', class: cls }) {
  if (!items.length) return null;
  return html`<ul class=${['legend', cls].filter(Boolean).join(' ')}>
    ${items.map(
      (it, i) => html`<li key=${it.label ?? i}>
        <span class=${`legend-key is-${it.shape || shape}`} style=${{ '--key': it.color || seriesColor(i) }}></span>
        <span class="legend-label">${it.label}</span>
        ${it.value != null && it.value !== '' ? html`<span class="legend-value num">${it.value}</span>` : null}
      </li>`,
    )}
  </ul>`;
}

// ---------------------------------------------------------------------------
// LineChart
// ---------------------------------------------------------------------------

/**
 * LineChart {series: [{name, values: (number|null)[], color?}], xLabels: string[], height=220,
 *            format?: kind|fn, area=true, yMin?, yMax?, label?, emptyText?}
 * - y axis starts at 0 when `area` is on and the data is non-negative (areas must sit on a
 *   zero baseline); with area={false} the axis hugs the data. Pass yMin to force a floor.
 * - >= 2 series: legend above; 2-4 series also get direct end labels when they don't collide.
 * - null values leave a gap in the line.
 */
export function LineChart({ series = [], xLabels = [], height = 220, format, area = true, yMin, yMax, label, emptyText, class: cls }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const list = (series || []).filter((s) => s && Array.isArray(s.values));
  const n = Math.max(xLabels.length, 0, ...list.map((s) => s.values.length));
  const finite = list.flatMap((s) => s.values.filter(isNum));
  const wrapCls = ['chart', 'chart-line', cls].filter(Boolean).join(' ');

  if (!list.length || !finite.length) {
    return html`<div class=${wrapCls} ref=${ref}><${ChartEmpty} height=${height} text=${emptyText} /></div>`;
  }

  const axisFmt = (v) => formatValue(v, format || 'compact');
  const tipFmt = (v) => formatValue(v, format || 'number');
  const dMin = Math.min(...finite);
  const dMax = Math.max(...finite);
  const lo = yMin ?? (area && dMin >= 0 ? 0 : dMin);
  const hi = yMax ?? Math.max(dMax, lo);
  const sc = niceScale(lo, hi, height < 170 ? 3 : 5, { fixMin: yMin != null, fixMax: yMax != null });
  const tickLabels = sc.ticks.map(axisFmt);
  const left = Math.max(24, Math.max(...tickLabels.map(monoW)) + 10);
  const top = 12;
  const bottom = 26;
  const plotH = Math.max(40, height - top - bottom);
  const yOf = (v) => top + plotH - ((clamp(v, sc.min, sc.max) - sc.min) / (sc.max - sc.min || 1)) * plotH;
  const colors = list.map((s, i) => s.color || seriesColor(i));
  const lastIdx = list.map((s) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (isNum(s.values[i])) return i;
    return -1;
  });

  // Direct end labels for 2-4 series when there is room and they don't collide.
  let right = 14;
  let endLabels = false;
  if (list.length >= 2 && list.length <= 4 && width >= 480) {
    const ys = list.map((s, i) => (lastIdx[i] >= 0 ? yOf(s.values[lastIdx[i]]) : null)).filter((y) => y != null).sort((a, b) => a - b);
    const collide = ys.some((y, i) => i > 0 && y - ys[i - 1] < 14);
    if (!collide) {
      right = Math.min(width * 0.22, Math.max(...list.map((s) => sansW(s.name))) + 14);
      endLabels = true;
    }
  }
  const plotW = Math.max(40, width - left - right);
  const xOf = (i) => left + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const baseY = yOf(clamp(0, sc.min, sc.max));

  const linePath = (vals) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (!isNum(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${f1(xOf(i))} ${f1(yOf(v))}`;
      pen = true;
    });
    return d;
  };
  const areaPath = (vals) => {
    let d = '';
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        d += `M${f1(xOf(run[0]))} ${f1(baseY)}` + run.map((i) => `L${f1(xOf(i))} ${f1(yOf(vals[i]))}`).join('') + `L${f1(xOf(run[run.length - 1]))} ${f1(baseY)}Z`;
      }
      run = [];
    };
    vals.forEach((v, i) => (isNum(v) ? run.push(i) : flush()));
    flush();
    return d;
  };

  const xs = visibleXIndices(n, xLabels, plotW);
  const onMove = (e) => {
    const svg = e.currentTarget.ownerSVGElement || e.currentTarget;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) * width) / (r.width || width);
    setHover(n <= 1 ? 0 : clamp(Math.round(((px - left) / plotW) * (n - 1)), 0, n - 1));
  };

  const single = list.length === 1;
  const s0 = list[0];
  const summary =
    (label ? `${label}. ` : '') +
    list
      .map((s, i) => {
        const v = s.values.filter(isNum);
        return `${s.name || 'Series'}: latest ${tipFmt(s.values[lastIdx[i]])}, low ${tipFmt(Math.min(...v))}, high ${tipFmt(Math.max(...v))}`;
      })
      .join('; ') +
    (n > 1 && xLabels.length ? ` (${xLabels[0]} to ${xLabels[n - 1]})` : '');

  return html`<div class=${wrapCls} ref=${ref} tabindex="0" aria-label=${summary}
      onKeyDown=${keyNav(n, hover, setHover)} onFocus=${() => hover == null && setHover(n - 1)} onBlur=${() => setHover(null)}>
    ${list.length >= 2 ? html`<${Legend} shape="line" items=${list.map((s, i) => ({ label: s.name, color: colors[i] }))} />` : null}
    <div class="chart-plot">
      <svg width="100%" height=${height} viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${summary}>
        <g class="chart-grid">
          ${sc.ticks.map((t, i) => html`<line key=${'g' + i} x1=${left} x2=${width - right} y1=${f1(yOf(t)) + 0.5} y2=${f1(yOf(t)) + 0.5} class=${t === sc.min ? 'is-base' : ''} />`)}
        </g>
        <g class="chart-axis">
          ${sc.ticks.map((t, i) => html`<text key=${'t' + i} x=${left - 8} y=${yOf(t)} text-anchor="end" dominant-baseline="middle">${tickLabels[i]}</text>`)}
          ${xs.map((i) => {
            const text = String(xLabels[i] ?? '');
            const half = monoW(text) / 2;
            return html`<text key=${'x' + i} x=${clamp(xOf(i), half, width - half)} y=${height - 8} text-anchor="middle">${text}</text>`;
          })}
        </g>
        ${area ? list.map((s, i) => html`<path key=${'a' + i} d=${areaPath(s.values)} class="chart-area" style=${{ fill: colors[i] }} />`) : null}
        ${list.map((s, i) => html`<path key=${'l' + i} d=${linePath(s.values)} class="chart-line-path" style=${{ stroke: colors[i] }} />`)}
        ${hover != null ? html`<line class="chart-crosshair" x1=${f1(xOf(hover)) + 0.5} x2=${f1(xOf(hover)) + 0.5} y1=${top} y2=${top + plotH} />` : null}
        ${list.map((s, i) => {
          const at = hover != null ? (isNum(s.values[hover]) ? hover : -1) : lastIdx[i];
          return at >= 0 ? html`<circle key=${'d' + i} class="chart-dot" cx=${xOf(at)} cy=${yOf(s.values[at])} r="4" style=${{ fill: colors[i] }} />` : null;
        })}
        ${single && hover == null && lastIdx[0] >= 0
          ? html`<text class="chart-value" x=${xOf(lastIdx[0]) - (lastIdx[0] === n - 1 ? 0 : -8)} y=${Math.max(10, yOf(s0.values[lastIdx[0]]) - 11)} text-anchor=${lastIdx[0] === n - 1 ? 'end' : 'start'}>${tipFmt(s0.values[lastIdx[0]])}</text>`
          : null}
        ${endLabels
          ? list.map((s, i) => (lastIdx[i] >= 0 ? html`<text key=${'e' + i} class="chart-end-label" x=${xOf(lastIdx[i]) + 9} y=${yOf(s.values[lastIdx[i]])} dominant-baseline="middle">${truncate(s.name, right - 12)}</text>` : null))
          : null}
        <rect class="chart-hit" x=${left} y=${top} width=${plotW} height=${plotH} onPointerMove=${onMove} onPointerDown=${onMove} onPointerLeave=${() => setHover(null)} />
      </svg>
      ${hover != null
        ? html`<${Tip} x=${xOf(hover)} y=${top} width=${width}>
            <div class="chart-tip-title">${xLabels[hover] ?? ''}</div>
            ${list.map((s, i) => html`<${TipRow} color=${colors[i]} value=${tipFmt(s.values[hover])} name=${single ? '' : s.name} />`)}
          </${Tip}>`
        : null}
    </div>
    <${SrTable} caption=${label || 'Chart data'} head=${['', ...list.map((s) => s.name || 'Value')]}
      rows=${Array.from({ length: n }, (_, i) => [xLabels[i] ?? String(i + 1), ...list.map((s) => tipFmt(s.values[i]))])} />
  </div>`;
}

// ---------------------------------------------------------------------------
// BarChart
// ---------------------------------------------------------------------------

/**
 * BarChart {data: [{label, value, color?}], horizontal=false, height?, format?, highlightMax=false,
 *           color?, label?, emptyText?}
 * One series: every bar wears --series-1 (or `color`). highlightMax paints the max bar in the
 * accent and the rest muted (emphasis). Horizontal bars carry their values at the tips; height
 * grows with the row count unless given.
 */
export function BarChart({ data = [], horizontal = false, height, format, highlightMax = false, color, label, emptyText, class: cls }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const rows = (data || []).filter((d) => d && isNum(d.value));
  const n = rows.length;
  const wrapCls = ['chart', horizontal ? 'chart-hbar' : 'chart-bar', cls].filter(Boolean).join(' ');
  if (!n) return html`<div class=${wrapCls} ref=${ref}><${ChartEmpty} height=${height || 180} text=${emptyText} /></div>`;

  const axisFmt = (v) => formatValue(v, format || 'compact');
  const tipFmt = (v) => formatValue(v, format || 'number');
  let maxI = 0;
  rows.forEach((d, i) => d.value > rows[maxI].value && (maxI = i));
  const base = color || 'var(--series-1)';
  const fillOf = (d, i) => (highlightMax ? (i === maxI ? d.color || base : 'var(--series-muted)') : d.color || base);
  const summary = (label ? `${label}. ` : '') + `${n} bars; highest ${rows[maxI].label} at ${tipFmt(rows[maxI].value)}.`;
  const dimmed = (i) => hover != null && hover !== i;
  const table = html`<${SrTable} caption=${label || 'Chart data'} head=${['', 'Value']} rows=${rows.map((d) => [String(d.label), tipFmt(d.value)])} />`;

  if (horizontal) {
    const rowH = height ? Math.max(20, (height - 8) / n) : 30;
    const barH = Math.min(16, rowH - 8);
    const H = height || Math.round(n * rowH + 8);
    const valueTexts = rows.map((d) => tipFmt(d.value));
    const labelCol = Math.min(width * 0.38, Math.max(...rows.map((d) => sansW(d.label))) + 12);
    const valW = Math.max(...valueTexts.map(monoW)) + 10;
    const x0 = labelCol;
    const plotW = Math.max(20, width - x0 - valW);
    const vmax = Math.max(0, ...rows.map((d) => d.value)) || 1;
    const yc = (i) => 4 + rowH * (i + 0.5);
    const xEnd = (v) => x0 + (Math.max(0, v) / vmax) * plotW;
    return html`<div class=${wrapCls} ref=${ref} tabindex="0" aria-label=${summary}
        onKeyDown=${keyNav(n, hover, setHover)} onFocus=${() => hover == null && setHover(0)} onBlur=${() => setHover(null)}>
      <div class="chart-plot">
        <svg width="100%" height=${H} viewBox=${`0 0 ${width} ${H}`} role="img" aria-label=${summary}>
          ${rows.map(
            (d, i) => html`<g key=${i} class=${dimmed(i) ? 'is-dim' : ''}>
              <text class="chart-cat" x="0" y=${yc(i)} dominant-baseline="middle">${truncate(d.label, labelCol - 12)}</text>
              <path class="chart-barmark" d=${hBarPath(x0, xEnd(d.value), yc(i), barH)} style=${{ fill: fillOf(d, i) }} />
              <text class="chart-value" x=${xEnd(d.value) + 6} y=${yc(i)} dominant-baseline="middle">${valueTexts[i]}</text>
              <rect class="chart-hit" x="0" y=${yc(i) - rowH / 2} width=${width} height=${rowH}
                onPointerEnter=${() => setHover(i)} onPointerDown=${() => setHover(i)} onPointerLeave=${() => setHover(null)} />
            </g>`,
          )}
          <line class="chart-baseline" x1=${f1(x0) + 0.5} x2=${f1(x0) + 0.5} y1="2" y2=${H - 2} />
        </svg>
        ${hover != null
          ? html`<${Tip} x=${Math.min(xEnd(rows[hover].value), width - 40)} y=${yc(hover)} width=${width} align="middle">
              <div class="chart-tip-title">${rows[hover].label}</div>
              <${TipRow} color=${fillOf(rows[hover], hover)} shape="rect" value=${tipFmt(rows[hover].value)} />
            </${Tip}>`
          : null}
      </div>
      ${table}
    </div>`;
  }

  const H = height || 220;
  const vals = rows.map((d) => d.value);
  const sc = niceScale(Math.min(0, ...vals), Math.max(0, ...vals), H < 170 ? 3 : 5);
  const tickLabels = sc.ticks.map(axisFmt);
  const left = Math.max(24, Math.max(...tickLabels.map(monoW)) + 10);
  const top = 18;
  const bottom = 26;
  const plotH = Math.max(40, H - top - bottom);
  const plotW = Math.max(40, width - left - 8);
  const band = plotW / n;
  const barW = Math.max(2, Math.min(24, band * 0.62, band - 2));
  const cxOf = (i) => left + band * (i + 0.5);
  const yOf = (v) => top + plotH - ((v - sc.min) / (sc.max - sc.min || 1)) * plotH;
  const y0 = yOf(0);
  const labels = rows.map((d) => d.label);
  const xs = visibleXIndices(n, labels, plotW);
  const showValue = (i) => {
    const text = tipFmt(rows[i].value);
    if (monoW(text) > band - 2) return false;
    return highlightMax ? i === maxI : n <= 7;
  };
  return html`<div class=${wrapCls} ref=${ref} tabindex="0" aria-label=${summary}
      onKeyDown=${keyNav(n, hover, setHover)} onFocus=${() => hover == null && setHover(maxI)} onBlur=${() => setHover(null)}>
    <div class="chart-plot">
      <svg width="100%" height=${H} viewBox=${`0 0 ${width} ${H}`} role="img" aria-label=${summary}>
        <g class="chart-grid">
          ${sc.ticks.map((t, i) => html`<line key=${'g' + i} x1=${left} x2=${width - 8} y1=${f1(yOf(t)) + 0.5} y2=${f1(yOf(t)) + 0.5} class=${t === 0 ? 'is-base' : ''} />`)}
        </g>
        <g class="chart-axis">
          ${sc.ticks.map((t, i) => html`<text key=${'t' + i} x=${left - 8} y=${yOf(t)} text-anchor="end" dominant-baseline="middle">${tickLabels[i]}</text>`)}
          ${xs.map((i) => {
            const text = String(labels[i] ?? '');
            const half = monoW(text) / 2;
            return html`<text key=${'x' + i} x=${clamp(cxOf(i), half, width - half)} y=${H - 8} text-anchor="middle">${text}</text>`;
          })}
        </g>
        ${rows.map(
          (d, i) => html`<g key=${i} class=${dimmed(i) ? 'is-dim' : ''}>
            <path class="chart-barmark" d=${vBarPath(cxOf(i), y0, yOf(d.value), barW)} style=${{ fill: fillOf(d, i) }} />
            ${showValue(i) ? html`<text class="chart-value" x=${cxOf(i)} y=${d.value >= 0 ? yOf(d.value) - 6 : yOf(d.value) + 13} text-anchor="middle">${tipFmt(d.value)}</text>` : null}
            <rect class="chart-hit" x=${left + band * i} y=${top} width=${band} height=${plotH}
              onPointerEnter=${() => setHover(i)} onPointerDown=${() => setHover(i)} onPointerLeave=${() => setHover(null)} />
          </g>`,
        )}
      </svg>
      ${hover != null
        ? html`<${Tip} x=${cxOf(hover)} y=${Math.max(top, Math.min(yOf(rows[hover].value), y0) - 4)} width=${width} align="bottom">
            <div class="chart-tip-title">${rows[hover].label}</div>
            <${TipRow} color=${fillOf(rows[hover], hover)} shape="rect" value=${tipFmt(rows[hover].value)} />
          </${Tip}>`
        : null}
    </div>
    ${table}
  </div>`;
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

const DEFAULT_ROWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_COLS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

/** Sequential fill for t in [0,1] on the accent hue; 0/empty sits on --surface-2. */
export function heatColor(t) {
  if (!isNum(t) || t <= 0) return 'var(--surface-2)';
  return `color-mix(in srgb, var(--accent) ${Math.round(14 + clamp(t, 0, 1) * 86)}%, var(--surface))`;
}

/**
 * Heatmap {matrix: number[rows][cols] (7x24 for weekday x hour; raw values or 0..1),
 *          rowLabels = Sun..Sat, colLabels = 00..23, format?, height?, highlightMax=true, label?}
 * Single-hue sequential scale on --accent. The highest cell gets an ink ring.
 */
export function Heatmap({ matrix = [], rowLabels = DEFAULT_ROWS, colLabels = DEFAULT_COLS, format, height, highlightMax = true, label, emptyText, class: cls }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null); // [r, c]
  const rows = (matrix || []).filter(Array.isArray);
  const R = rows.length;
  const C = Math.max(0, ...rows.map((r) => r.length));
  const finite = rows.flat().filter(isNum);
  const wrapCls = ['chart', 'chart-heatmap', cls].filter(Boolean).join(' ');
  if (!R || !C || !finite.length || finite.every((v) => v === 0)) {
    return html`<div class=${wrapCls} ref=${ref}><${ChartEmpty} height=${height || 200} text=${emptyText} /></div>`;
  }
  const fmt = (v) => formatValue(v, format || 'number');
  const vmin = Math.min(0, ...finite);
  const vmax = Math.max(...finite);
  const tOf = (v) => (isNum(v) && vmax > vmin ? (v - vmin) / (vmax - vmin) : 0);
  let best = [0, 0];
  rows.forEach((r, ri) => r.forEach((v, ci) => isNum(v) && v > rows[best[0]][best[1]] && (best = [ri, ci])));

  const left = Math.max(...rowLabels.slice(0, R).map((l) => sansW(l))) + 10;
  const bottom = 20;
  const gap = 2;
  const plotW = Math.max(60, width - left);
  const cellW = (plotW - gap * (C - 1)) / C;
  const cellH = height ? Math.max(8, (height - bottom - gap * (R - 1)) / R) : clamp(cellW * 0.95, 14, 30);
  const H = height || Math.round(R * cellH + gap * (R - 1) + bottom);
  const xOf = (c) => left + c * (cellW + gap);
  const yOf = (r) => r * (cellH + gap);
  const longest = Math.max(...colLabels.map((l) => String(l).length));
  const every = [1, 2, 3, 4, 6, 12, 24].find((k) => (monoW('0'.repeat(longest)) + 8) * (C / k) <= plotW) || 24;

  const move = (dr, dc) => {
    const [r, c] = hover || best;
    setHover([clamp(r + dr, 0, R - 1), clamp(c + dc, 0, C - 1)]);
  };
  const onKey = (e) => {
    const map = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (map[e.key]) {
      e.preventDefault();
      move(...map[e.key]);
    } else if (e.key === 'Escape') setHover(null);
  };
  const summary = (label ? `${label}. ` : '') + `Highest: ${rowLabels[best[0]] ?? ''} ${colLabels[best[1]] ?? ''} at ${fmt(rows[best[0]][best[1]])}.`;

  return html`<div class=${wrapCls} ref=${ref} tabindex="0" aria-label=${summary} onKeyDown=${onKey}
      onFocus=${() => hover == null && setHover(best)} onBlur=${() => setHover(null)}>
    <div class="chart-plot">
      <svg width="100%" height=${H} viewBox=${`0 0 ${width} ${H}`} role="img" aria-label=${summary}>
        <g class="chart-axis">
          ${rows.map((_, r) => html`<text key=${'r' + r} class="chart-cat" x="0" y=${yOf(r) + cellH / 2} dominant-baseline="middle">${rowLabels[r] ?? ''}</text>`)}
          ${Array.from({ length: C }, (_, c) => (c % every === 0 ? html`<text key=${'c' + c} x=${xOf(c) + cellW / 2} y=${H - 5} text-anchor="middle">${colLabels[c] ?? ''}</text>` : null))}
        </g>
        ${rows.map((row, r) =>
          row.map(
            (v, c) => html`<rect key=${r + '-' + c} class=${'chart-cell' + (hover && hover[0] === r && hover[1] === c ? ' is-hover' : '')}
              x=${f1(xOf(c))} y=${f1(yOf(r))} width=${f1(cellW)} height=${f1(cellH)} rx="2"
              style=${{ fill: heatColor(tOf(v)) }}
              onPointerEnter=${() => setHover([r, c])} onPointerDown=${() => setHover([r, c])} onPointerLeave=${() => setHover(null)} />`,
          ),
        )}
        ${highlightMax ? html`<rect class="chart-cell-best" x=${f1(xOf(best[1])) - 1} y=${f1(yOf(best[0])) - 1} width=${f1(cellW) + 2} height=${f1(cellH) + 2} rx="3" />` : null}
      </svg>
      ${hover
        ? html`<${Tip} x=${xOf(hover[1]) + cellW / 2} y=${yOf(hover[0])} width=${width} align="bottom">
            <div class="chart-tip-title">${rowLabels[hover[0]] ?? ''} ${colLabels[hover[1]] ?? ''}</div>
            <${TipRow} color=${heatColor(tOf(rows[hover[0]][hover[1]]))} shape="rect" value=${fmt(rows[hover[0]][hover[1]])} />
          </${Tip}>`
        : null}
    </div>
    <div class="heat-scale" aria-hidden="true">
      <span>Less</span>
      ${[0.08, 0.3, 0.55, 0.78, 1].map((t) => html`<i style=${{ background: heatColor(t) }}></i>`)}
      <span>More</span>
    </div>
    <${SrTable} caption=${label || 'Heatmap data'} head=${['', ...colLabels.slice(0, C)]} rows=${rows.map((row, r) => [rowLabels[r] ?? '', ...row.map(fmt)])} />
  </div>`;
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

/**
 * Sparkline {values, width=96, height=28, color?, label?}
 * De-emphasis line (--ink-3) with the current (last) point in the accent. Fixed size.
 */
export function Sparkline({ values = [], width = 96, height = 28, color, label, class: cls }) {
  const pts = (values || []).map((v, i) => [i, v]).filter(([, v]) => isNum(v));
  const cls2 = ['sparkline', cls].filter(Boolean).join(' ');
  if (pts.length < 2) {
    return html`<svg class=${cls2} width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} aria-hidden="true">
      <line x1="2" x2=${width - 2} y1=${height / 2} y2=${height / 2} class="sparkline-empty" />
    </svg>`;
  }
  const n = values.length;
  const vs = pts.map(([, v]) => v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = 4;
  const x = (i) => pad + ((width - pad * 2) * i) / Math.max(1, n - 1);
  const y = (v) => (hi === lo ? height / 2 : pad + (height - pad * 2) * (1 - (v - lo) / (hi - lo)));
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${f1(x(i))} ${f1(y(v))}`).join('');
  const [li, lv] = pts[pts.length - 1];
  const a11y = label ? { role: 'img', 'aria-label': `${label}: from ${formatValue(vs[0])} to ${formatValue(lv)}` } : { 'aria-hidden': 'true' };
  return html`<svg class=${cls2} width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} ...${a11y}>
    <path d=${d} class="sparkline-path" style=${color ? { stroke: color } : null} />
    <circle cx=${x(li)} cy=${y(lv)} r="2.75" class="sparkline-dot" style=${color ? { fill: color } : null} />
  </svg>`;
}

// ---------------------------------------------------------------------------
// StackedBar (100% part-to-whole)
// ---------------------------------------------------------------------------

/**
 * StackedBar {segments: [{label, value, color?}], format?, height=14, legend=true, label?}
 * Horizontal 100% bar, 2px surface gaps between segments, legend with value and share.
 */
export function StackedBar({ segments = [], format, height = 14, legend = true, label, emptyText, class: cls }) {
  const [hover, setHover] = useState(null);
  const segs = (segments || []).filter((s) => s && isNum(s.value) && s.value > 0);
  const total = segs.reduce((a, s) => a + s.value, 0);
  const wrapCls = ['chart', 'chart-stack', cls].filter(Boolean).join(' ');
  if (!segs.length || !total) return html`<div class=${wrapCls}><${ChartEmpty} height=${Math.max(64, height + 40)} text=${emptyText} /></div>`;
  const fmt = (v) => formatValue(v, format || 'number');
  const pct = (v) => formatValue(v / total, 'percent');
  const colorOf = (s, i) => s.color || seriesColor(i);
  const summary = (label ? `${label}. ` : '') + segs.map((s) => `${s.label} ${pct(s.value)}`).join(', ');
  return html`<div class=${wrapCls} role="group" aria-label=${summary}>
    <div class="chart-plot">
      <div class="stackbar" style=${{ height: `${height}px` }} role="img" aria-label=${summary}>
        ${segs.map(
          (s, i) => html`<span key=${s.label ?? i} class=${'stackbar-seg' + (hover != null && hover !== i ? ' is-dim' : '')}
            style=${{ flexGrow: s.value, background: colorOf(s, i) }}
            onPointerEnter=${() => setHover(i)} onPointerLeave=${() => setHover(null)} onPointerDown=${() => setHover(i)}></span>`,
        )}
      </div>
      ${hover != null
        ? html`<div class="chart-tip" data-side="center" style=${{ left: `${(segs.slice(0, hover).reduce((a, s) => a + s.value, 0) + segs[hover].value / 2) / total * 100}%`, top: '0px' }} aria-hidden="true">
            <div class="chart-tip-title">${segs[hover].label}</div>
            <${TipRow} color=${colorOf(segs[hover], hover)} shape="rect" value=${fmt(segs[hover].value)} name=${pct(segs[hover].value)} />
          </div>`
        : null}
    </div>
    ${legend ? html`<${Legend} items=${segs.map((s, i) => ({ label: s.label, color: colorOf(s, i), value: `${fmt(s.value)} · ${pct(s.value)}` }))} />` : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------

/**
 * Donut {segments: [{label, value, color?}], size=140, label?, format?, legend=true}
 * At most 6 segments: the tail folds into "Other". The center reads the total, or the
 * hovered segment's value and share.
 */
export function Donut({ segments = [], size = 140, label, format, legend = true, emptyText, class: cls }) {
  const [hover, setHover] = useState(null);
  let segs = (segments || []).filter((s) => s && isNum(s.value) && s.value > 0);
  if (segs.length > 6) {
    const head = segs.slice(0, 5);
    const rest = segs.slice(5).reduce((a, s) => a + s.value, 0);
    segs = [...head, { label: 'Other', value: rest, color: 'var(--series-muted)' }];
  }
  const total = segs.reduce((a, s) => a + s.value, 0);
  const wrapCls = ['chart', 'chart-donut', cls].filter(Boolean).join(' ');
  if (!segs.length || !total) return html`<div class=${wrapCls}><${ChartEmpty} height=${size} text=${emptyText} /></div>`;
  const fmt = (v) => formatValue(v, format || 'compact');
  const pct = (v) => formatValue(v / total, 'percent');
  const colorOf = (s, i) => s.color || seriesColor(i);
  const stroke = Math.max(10, Math.round(size * 0.13));
  const r = (size - stroke) / 2 - 1;
  const C = 2 * Math.PI * r;
  const gap = segs.length > 1 ? 2 : 0;
  let acc = 0;
  const arcs = segs.map((s, i) => {
    const len = (s.value / total) * C;
    const arc = { i, len: Math.max(0.5, len - gap), offset: -acc };
    acc += len;
    return arc;
  });
  const h = hover != null ? segs[hover] : null;
  const summary = (label ? `${label}. ` : '') + segs.map((s) => `${s.label} ${pct(s.value)}`).join(', ');
  return html`<div class=${wrapCls} role="group" aria-label=${summary}>
    <div class="donut-figure" style=${{ width: `${size}px`, height: `${size}px` }}>
      <svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`} role="img" aria-label=${summary}>
        <g transform=${`rotate(-90 ${size / 2} ${size / 2})`}>
          ${arcs.map(
            (a) => html`<circle key=${a.i} class=${'donut-arc' + (hover != null && hover !== a.i ? ' is-dim' : '')}
              cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${stroke}
              stroke-dasharray=${`${f1(a.len)} ${f1(C - a.len)}`} stroke-dashoffset=${f1(a.offset)}
              style=${{ stroke: colorOf(segs[a.i], a.i) }}
              onPointerEnter=${() => setHover(a.i)} onPointerLeave=${() => setHover(null)} onPointerDown=${() => setHover(a.i)} />`,
          )}
        </g>
      </svg>
      <div class="donut-center" aria-hidden="true">
        <strong>${h ? pct(h.value) : fmt(total)}</strong>
        <span>${h ? h.label : label || 'Total'}</span>
      </div>
    </div>
    ${legend ? html`<${Legend} class="legend-stacked" items=${segs.map((s, i) => ({ label: s.label, color: colorOf(s, i), value: pct(s.value) }))} />` : null}
  </div>`;
}
