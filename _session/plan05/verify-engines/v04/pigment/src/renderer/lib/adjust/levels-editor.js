// The Levels editor (adjust-tonal; registered with app.adjustEditors by lib/adjust/tonal.js, I.2): Photoshop's
// dialog body. The channel menu follows the document mode (J.9 `space`), a histogram, the input slider with black,
// grey and white triangles and the output slider (Alt-drag of the black or white input triangle shows the clipping
// display), the five numeric fields (data-key inBlack, gamma, inWhite, outBlack, outWhite: 0.3's keys), and as
// capabilities the black / grey / white eyedroppers, Auto with its options and setParams for presets and Reset.
import { DEFAULT_LEVELS, TONAL_SPACES, tonalSpace, remapTonalSpace, autoTonalParams } from '../../../shared/pixels/adjust-tonal.js';
import { sourceHistogram, drawHistogram, histKey, editorSpace, channelOptions, sliderTrack, selectRow } from './tonal-ui.js';
import { tonalEyedroppers } from './eyedroppers.js';
import { openAutoOptions, savedAutoOptions } from './auto-options.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const round2 = (v) => Math.round(v * 100) / 100;

/** The grey triangle's position for a gamma (the input that maps to mid output), and back. */
export const grayPos = (l) => l.inBlack + (l.inWhite - l.inBlack) * Math.pow(0.5, l.gamma);
export const gammaAt = (l, pos) => {
  const t = (pos - l.inBlack) / Math.max(1, l.inWhite - l.inBlack);
  return Math.max(0.1, Math.min(9.99, round2(Math.log(Math.max(0.001, Math.min(0.999, t))) / Math.log(0.5))));
};

/**
 * levelsEditor(kind, params, onChange, { source, app, clip }) -> editor (I.2). `clip(which | null)` (optional, the
 * dialog's) shows the clipping display while an input triangle is Alt-dragged.
 */
export function levelsEditor(kind, params, onChange, { source = null, app = null, clip = null } = {}) {
  let space = editorSpace('levels', params, app);
  let p = tonalSpace(params) === space ? clone(params) : remapTonalSpace('levels', params ?? {}, space);
  p.space = space;
  const s = TONAL_SPACES[space];
  let channel = s.composite ?? s.channels[0];
  const hist = sourceHistogram(source);

  const el = document.createElement('div');
  el.className = 'levels-editor tonal-editor';
  el.dataset.space = space;
  const chanRow = selectRow('Channel', channelOptions(space), channel, (v) => {
    channel = v;
    sync();
  }, { dataKey: '__channel' });
  el.appendChild(chanRow.element);

  const canvas = document.createElement('canvas');
  canvas.className = 'histogram';
  canvas.width = 256;
  canvas.height = 96;
  el.appendChild(canvas);

  const lv = () => ({ ...DEFAULT_LEVELS, ...(p[channel] ?? {}) });
  const emit = () => onChange(clone(p));
  const write = (patch) => {
    const next = { ...lv(), ...patch };
    if (next.inWhite <= next.inBlack + 1) {
      if ('inBlack' in patch) next.inWhite = Math.min(255, next.inBlack + 2);
      else next.inBlack = Math.max(0, next.inWhite - 2);
    }
    p[channel] = next;
    if (space === 'rgb' && channel !== 'rgb') p.perChannel = true;
  };

  // ---- input slider and fields
  let clipping = null;
  const setClip = (which) => {
    if (clipping === which) return;
    clipping = which;
    clip?.(which);
  };
  const input = sliderTrack(
    [{ key: 'inBlack', value: 0, color: 'black' }, { key: 'gray', value: 128, color: 'gray' }, { key: 'inWhite', value: 255, color: 'white' }],
    (key, value, { altKey, phase }) => {
      const cur = lv();
      if (key === 'gray') write({ gamma: gammaAt(cur, Math.max(cur.inBlack + 1, Math.min(cur.inWhite - 1, value))) });
      else if (key === 'inBlack') write({ inBlack: Math.round(Math.max(0, Math.min(253, Math.min(value, cur.inWhite - 2)))) });
      else write({ inWhite: Math.round(Math.max(2, Math.min(255, Math.max(value, cur.inBlack + 2)))) });
      // Alt while dragging the black or white input triangle: the clipping display (Photoshop's)
      setClip(phase !== 'end' && altKey && key !== 'gray' ? (key === 'inBlack' ? 'shadows' : 'highlights') : null);
      sync({ keepInputs: false });
      emit();
    },
    { className: 'tonal-track-input' },
  );
  el.appendChild(input.element);
  const num = (key, label, { min, max, step = 1 }) => {
    const i = document.createElement('input');
    i.type = 'number';
    i.className = 'input num';
    i.dataset.key = key;
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.title = label;
    i.setAttribute('aria-label', label);
    const commit = () => {
      const v = Number(i.value);
      if (!Number.isFinite(v)) return;
      const c = Math.max(min, Math.min(max, v));
      write({ [key]: key === 'gamma' ? round2(c) : Math.round(c) });
      sync({ except: i });
      emit();
    };
    i.addEventListener('change', commit);
    i.addEventListener('input', () => {
      if (i.value !== '' && Number.isFinite(Number(i.value))) commit();
    });
    return i;
  };
  const inRow = document.createElement('div');
  inRow.className = 'tonal-fields';
  const fInBlack = num('inBlack', 'Input shadows', { min: 0, max: 253 });
  const fGamma = num('gamma', 'Input midtones (gamma)', { min: 0.1, max: 9.99, step: 0.01 });
  const fInWhite = num('inWhite', 'Input highlights', { min: 2, max: 255 });
  inRow.append(label('Input Levels'), fInBlack, fGamma, fInWhite);
  el.appendChild(inRow);

  // ---- output slider and fields
  const output = sliderTrack(
    [{ key: 'outBlack', value: 0, color: 'black' }, { key: 'outWhite', value: 255, color: 'white' }],
    (key, value) => {
      write({ [key]: Math.round(value) });
      sync();
      emit();
    },
    { className: 'tonal-track-output' },
  );
  el.appendChild(output.element);
  const outRow = document.createElement('div');
  outRow.className = 'tonal-fields';
  const fOutBlack = num('outBlack', 'Output shadows', { min: 0, max: 255 });
  const fOutWhite = num('outWhite', 'Output highlights', { min: 0, max: 255 });
  outRow.append(label('Output Levels'), fOutBlack, fOutWhite);
  el.appendChild(outRow);

  function sync({ except = null } = {}) {
    const l = lv();
    drawHistogram(canvas, hist, histKey(space, channel));
    input.set({ inBlack: l.inBlack, inWhite: l.inWhite, gray: grayPos(l) });
    output.set({ outBlack: l.outBlack, outWhite: l.outWhite });
    for (const [f, v] of [[fInBlack, l.inBlack], [fGamma, l.gamma], [fInWhite, l.inWhite], [fOutBlack, l.outBlack], [fOutWhite, l.outWhite]]) {
      if (f !== except) f.value = String(f === fGamma ? round2(v) : Math.round(v));
    }
    chanRow.select.value = channel;
  }
  // ends a clipping display when the Alt key or the pointer is released elsewhere
  const onUp = () => setClip(null);
  window.addEventListener('pointerup', onUp);
  sync();

  const setParams = (next) => {
    const n = next ?? {};
    p = tonalSpace(n) === space ? clone(n) : remapTonalSpace('levels', n, space);
    p.space = space;
    sync();
  };
  const autoSource = () => source;
  return {
    element: el,
    setParams,
    eyedroppers: tonalEyedroppers(app, 'levels', {
      getParams: () => clone(p),
      setParams: (next) => {
        setParams(next);
        emit();
      },
      gray: space !== 'gray',
    }),
    auto: {
      run: (src) => autoTonalParams('levels', src, savedAutoOptions(app), space),
      options: async () => {
        const before = clone(p);
        const src = autoSource();
        const opts = await openAutoOptions(app, {
          preview: src ? (o) => {
            setParams(autoTonalParams('levels', src, o, space));
            emit();
          } : null,
          revert: () => {
            setParams(before);
            emit();
          },
        });
        if (opts && src) {
          setParams(autoTonalParams('levels', src, opts, space));
          emit();
        }
        return !!opts;
      },
    },
    dispose() {
      window.removeEventListener('pointerup', onUp);
      setClip(null);
    },
  };
}

function label(text) {
  const s = document.createElement('span');
  s.className = 'tonal-fields-label';
  s.textContent = text;
  return s;
}
