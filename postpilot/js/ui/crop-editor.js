// CropEditor: choose the shape of a photo before it is uploaded (or re-cropped).
//
//   <CropEditor open source=${file} aspects=${['portrait', 'square', 'landscape']} onApply=${(r) => ...} onClose=${...} />
//
// Props: {open, source: File|Blob, name?, aspects?: (keyof media.ASPECTS)[], lockAspect?: number (fixed ratio,
//         e.g. a carousel's first photo), value?: {aspectKey, focus, zoom}, remaining?: number (more photos
//         waiting; shows "Use for all"), onApply(result, {all}), onClose, title?, applyLabel?}
// result: {aspect: number|null, aspectKey, ratio (output width / height), focus: {x, y}, zoom} - pass to
// media.prepareFile(file, result).
// Drag the photo (or use the arrow keys) to move the focus point; zoom with the slider, +/- keys,
// the mouse wheel or a pinch.

import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact.js';
import { LIMITS } from '../../core/model.js';
import { loadViewCss } from '../css.js';
import { ASPECTS, cropRect, loadBitmap } from '../media.js';
import { Button, Callout, Modal, Segmented, Spinner, cx } from './kit.js';

loadViewCss('composer');

const SHORT = { original: 'Original', square: '1:1', portrait: '4:5', landscape: '1.91:1', story: '9:16' };
const LONG = { original: 'Original shape', square: 'Square', portrait: 'Portrait', landscape: 'Landscape', story: 'Full screen' };
const MAX_SIDE = 1440;
const MAX_ZOOM = 4;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Preset key for a ratio, or null when it matches none. */
export function aspectKeyFor(ratio) {
  if (!ratio) return 'original';
  for (const [k, v] of Object.entries(ASPECTS)) if (v && Math.abs(v - ratio) < 0.012) return k;
  return null;
}

/** "4:5", "1:1"... for a ratio. */
export function ratioLabel(ratio) {
  const k = aspectKeyFor(ratio);
  if (k && k !== 'original') return SHORT[k];
  return ratio ? `${(Math.round(ratio * 100) / 100).toString()}:1` : 'Original';
}

function clampFocus(focus, w, h, aspect, zoom) {
  const r = cropRect(w, h, aspect, { x: 0.5, y: 0.5 }, zoom);
  const hx = r.w / 2 / w;
  const hy = r.h / 2 / h;
  return { x: clamp(focus.x, hx, 1 - hx), y: clamp(focus.y, hy, 1 - hy) };
}

function EditorBody({ source, name, aspects = ['portrait', 'square', 'landscape'], lockAspect, value, remaining = 0, onApply, onClose, title, applyLabel }) {
  const [bmp, setBmp] = useState(null);
  const [error, setError] = useState('');
  const locked = lockAspect ? (aspectKeyFor(lockAspect) || 'custom') : null;
  const [aspectKey, setAspectKey] = useState(() => locked || (value && value.aspectKey) || aspects[0] || 'original');
  const [focus, setFocus] = useState(() => (value && value.focus) || { x: 0.5, y: 0.5 });
  const [zoom, setZoom] = useState(() => (value && value.zoom) || 1);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const w = bmp ? bmp.width || bmp.naturalWidth : 0;
  const h = bmp ? bmp.height || bmp.naturalHeight : 0;
  const aspect = locked ? lockAspect : aspectKey === 'original' ? null : ASPECTS[aspectKey];
  const ratio = aspect || (w && h ? w / h : 1);

  useEffect(() => {
    let alive = true;
    let opened = null;
    loadBitmap(source)
      .then((b) => {
        opened = b;
        if (alive) setBmp(b);
        else if (b.close) b.close();
      })
      .catch((err) => alive && setError(err.message || 'This photo could not be opened.'));
    return () => {
      alive = false;
      if (opened && opened.close) opened.close();
    };
  }, [source]);

  // Fit the stage to the available space at the chosen ratio.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const fit = () => {
      const availW = el.clientWidth;
      const availH = Math.max(220, Math.min(window.innerHeight * 0.56, 560));
      let cw = availW;
      let ch = cw / ratio;
      if (ch > availH) {
        ch = availH;
        cw = ch * ratio;
      }
      setBox({ w: Math.round(cw), h: Math.round(ch) });
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [ratio, bmp]);

  // Focus the photo once it is open: arrow keys move it, +/- zoom, Enter applies.
  useEffect(() => {
    if (bmp) requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }));
  }, [bmp]);

  // Keep the focus inside the image when the shape or zoom changes.
  useEffect(() => {
    if (!w) return;
    setFocus((f) => clampFocus(f, w, h, aspect, zoom));
  }, [w, h, aspect, zoom]);

  // Draw.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !bmp || !box.w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(box.w * dpr);
    c.height = Math.round(box.h * dpr);
    const g = c.getContext('2d');
    const r = cropRect(w, h, aspect, focus, zoom);
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  }, [bmp, box.w, box.h, focus, zoom, aspect]);

  const r = w ? cropRect(w, h, aspect, focus, zoom) : null;
  const scale = r ? Math.min(1, MAX_SIDE / Math.max(r.w, r.h)) : 1;
  const outW = r ? Math.round(r.w * scale) : 0;
  const outH = r ? Math.round(r.h * scale) : 0;

  const pan = (dxCss, dyCss) => {
    if (!r || !box.w) return;
    const k = r.w / box.w; // source px per css px
    setFocus((f) => clampFocus({ x: f.x - (dxCss * k) / w, y: f.y - (dyCss * k) / h }, w, h, aspect, zoom));
  };

  const onPointerDown = (e) => {
    if (!bmp) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = null;
    setDragging(true);
  };
  const onPointerMove = (e) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    if (pointers.current.size >= 2) {
      pointers.current.set(e.pointerId, next);
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current) setZoom((z) => clamp((z * dist) / gesture.current, 1, MAX_ZOOM));
      gesture.current = dist;
      return;
    }
    pointers.current.set(e.pointerId, next);
    pan(next.x - prev.x, next.y - prev.y);
  };
  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
    if (!pointers.current.size) setDragging(false);
  };
  const onWheel = (e) => {
    if (!bmp) return;
    e.preventDefault();
    setZoom((z) => clamp(z * Math.exp(-e.deltaY * 0.0015), 1, MAX_ZOOM));
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 40 : 8;
    const map = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (map[e.key]) {
      e.preventDefault();
      pan(...map[e.key]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onApply?.(result(), { all: false });
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom((z) => clamp(z + 0.1, 1, MAX_ZOOM));
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setZoom((z) => clamp(z - 0.1, 1, MAX_ZOOM));
    }
  };

  const result = () => ({
    aspect: aspect || null,
    aspectKey: locked ? aspectKeyFor(lockAspect) || 'custom' : aspectKey,
    ratio: r ? r.w / r.h : ratio,
    focus: { ...focus },
    zoom,
  });
  const reset = () => {
    setZoom(1);
    setFocus({ x: 0.5, y: 0.5 });
  };

  const naturalRatio = w && h ? w / h : null;
  const originalOutOfFeed = aspects.includes('original') && naturalRatio && (naturalRatio < LIMITS.feedAspectMin - 0.01 || naturalRatio > LIMITS.feedAspectMax + 0.01);
  const options = aspects.map((k) => ({ value: k, label: SHORT[k] || k, title: LONG[k] }));

  const footer = html`<div class="crop-foot">
    <${Button} variant="ghost" onClick=${reset} disabled=${!bmp}>Reset<//>
    <span class="spacer"></span>
    <${Button} variant="ghost" onClick=${onClose}>Cancel<//>
    ${remaining > 0 ? html`<${Button} onClick=${() => onApply?.(result(), { all: true })} disabled=${!bmp}>Use for all ${remaining + 1}<//>` : null}
    <${Button} variant="primary" icon="check" onClick=${() => onApply?.(result(), { all: false })} disabled=${!bmp}>${applyLabel || 'Use photo'}<//>
  </div>`;

  return html`<${Modal} open=${true} title=${title || 'Crop photo'} onClose=${onClose} footer=${footer} class="crop-modal">
    <div class="crop">
      ${name ? html`<p class="crop-name muted text-sm truncate" title=${name}>${name}${remaining > 0 ? html` <span class="faint">· ${remaining} more after this</span>` : null}</p>` : null}
      <div class="crop-shapes">
        ${locked
          ? html`<p class="text-sm muted crop-locked">Shape <strong class="mono">${ratioLabel(lockAspect)}</strong>${locked === 'story' ? ': stories are full screen.' : ': every photo in a carousel uses the shape of the first one.'}</p>`
          : html`<${Segmented} label="Shape" options=${options} value=${aspectKey} onChange=${setAspectKey} />`}
      </div>
      <div class="crop-stage" ref=${stageRef}>
        ${error
          ? html`<${Callout} tone="danger" title="Could not open this photo">${error}<//>`
          : !bmp
            ? html`<div class="crop-loading"><${Spinner} label="Opening photo" /></div>`
            : html`<div class=${cx('crop-canvas-wrap', dragging && 'is-dragging')} style=${{ width: `${box.w}px`, height: `${box.h}px` }}>
                <canvas ref=${canvasRef} class="crop-canvas" tabindex="0" role="img"
                  aria-label=${`Crop preview, ${ratioLabel(ratio)}. Drag or use the arrow keys to move the photo, plus and minus to zoom, Enter to use it.`}
                  style=${{ width: `${box.w}px`, height: `${box.h}px` }}
                  onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}
                  onWheel=${onWheel} onKeyDown=${onKeyDown}></canvas>
                <span class="crop-grid" aria-hidden="true"></span>
              </div>`}
      </div>
      <div class="crop-controls">
        <label class="crop-zoom">
          <span class="label-caps">Zoom</span>
          <input type="range" min="1" max=${MAX_ZOOM} step="0.01" value=${zoom} disabled=${!bmp}
            onInput=${(e) => setZoom(Number(e.currentTarget.value))} aria-valuetext=${`${zoom.toFixed(1)}x`} />
          <span class="mono num crop-zoom-val">${zoom.toFixed(1)}×</span>
        </label>
        ${r ? html`<span class="mono num text-sm muted crop-size" title="Size that will be uploaded">${outW} × ${outH}</span>` : null}
      </div>
      ${bmp && outW < 1080 && (aspect || 1) <= 1.2
        ? html`<p class="text-sm text-warn crop-hint">This crop is ${outW} px wide. Instagram shows photos at 1080 px, so it may look soft. ${zoom > 1.01
            ? 'Zoom out if you can.'
            : !locked && aspect && aspect < 1 && aspects.includes('square') && Math.min(w, h) >= 1080
              ? 'Square keeps the full width.'
              : 'A larger original would look sharper.'}</p>`
        : null}
      ${aspectKey === 'original' && !locked && originalOutOfFeed
        ? html`<p class="text-sm text-warn crop-hint">The original shape is outside 4:5 to 1.91:1, so Instagram will not accept it in the feed. It still works for stories.</p>`
        : null}
    </div>
  <//>`;
}

/** CropEditor (see the header comment). Renders nothing while closed. */
export function CropEditor(props) {
  if (!props.open || !props.source) return null;
  return html`<${EditorBody} ...${props} />`;
}

export default CropEditor;
