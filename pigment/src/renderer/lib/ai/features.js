// AI features (see ARCHITECTURE.md "0.2 features: AI — Features"): the AI menu commands built on
// app.ai (lib/ai/accounts.js) and the provider request builders (lib/ai/providers.js). Every command
// checks the connection first (the accounts dialog opens when nothing fits), asks for its options in a
// form dialog whose provider/model choice is remembered in settings.ai, runs the request under app.busy
// with a Cancel button, and lands the result as a new layer above the active one through structural()
// so it is one undoable step. Pixel maths that the providers module does not already offer (white
// keying, sky detection, alpha -> mask) lives here as small pure helpers, exported for the assistant.
import { RasterLayer, createCanvas, copyCanvas, createDocument } from '../document.js';
import { structural, setLayerProps, nextLayerName, cloneLayer, rasterizeLayer } from '../layer-ops.js';
import { flattenDocument } from '../compositor.js';
import { formDialog } from '../form.js';
import { bridge } from '../bridge.js';
import { PROVIDERS, makeCanvas, cropCanvas, resampleTo, imageDataOf, canvasFromImageData, isOpaque, keyWhiteBorder } from './providers.js';
import * as selOps from '../../../shared/pixels/selection-ops.js';

export { isOpaque, keyWhiteBorder };

const ANCHORS = [['nw', 'Top left'], ['n', 'Top'], ['ne', 'Top right'], ['w', 'Left'], ['c', 'Centre'], ['e', 'Right'], ['sw', 'Bottom left'], ['s', 'Bottom'], ['se', 'Bottom right']];

/** Largest region sent for a generative fill (the providers downscale further when their own limit is lower). */
const MAX_REGION = 1536;
const PROMPT_LIMIT = 4000;

const providerOptions = (status, kind) => Object.keys(PROVIDERS).filter((p) => (kind === 'image' ? status?.[p]?.method === 'api_key' : !!status?.[p]?.method)).map((p) => [p, PROVIDERS[p].label]);

// ---- cancellable busy runs -----------------------------------------------------------------------------------------

/**
 * Runs fn under app.busy with a persistent "Cancel" toast. The bridge has no way to abort a request in
 * flight, so cancelling discards the answer when it arrives (fn gets { cancelled } to stop early between
 * steps). Rejects with { code: 'cancelled' } when the user cancels.
 */
export function aiTask(app, label, fn) {
  let cancelled = false;
  let reject;
  const cancel = new Promise((_, rej) => {
    reject = rej;
  });
  const remove = app.dialogs.toast(label, { kind: 'info', timeout: 0, action: { label: 'Cancel', run: () => {
    cancelled = true;
    reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
  } } });
  const state = {
    get cancelled() {
      return cancelled;
    },
  };
  // the real work keeps running after a cancel (nothing can abort the bridge call); its late result is dropped
  const work = Promise.resolve().then(() => fn(state));
  work.catch(() => {});
  return app
    .busy(label, () => Promise.race([work, cancel]))
    .finally(() => remove());
}

/** Error toast with the right follow-up: a connection problem opens the accounts dialog, a cancel says nothing. */
export function reportAiError(app, err, context) {
  if (!err || err.code === 'cancelled') return;
  const message = err?.message ?? String(err);
  if (err.code === 'not_connected' || /not connected|sign in|api key/i.test(message)) {
    app.dialogs.toast(`${context}: ${message}`, { kind: 'error', timeout: 8000, action: { label: 'AI Accounts…', run: () => app.ai?.openAccounts() } });
    return;
  }
  console.error(context, err);
  app.dialogs.toast(`${context}: ${message}`, { kind: 'error', timeout: 8000 });
}

// ---- pixel helpers ---------------------------------------------------------------------------------------------------

/**
 * Feathers a coverage mask as if the canvas continued beyond its border (edges replicated), so a
 * selection touching the border keeps full coverage there: the border is not a selection edge.
 */
export function featherKeepingBorder(mask, width, height, radius) {
  const f = Math.ceil(radius) * 3 + 2; // wider than the blur kernel, so nothing outside the padding is ever read
  const W = width + 2 * f, H = height + 2 * f;
  const big = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(height - 1, Math.max(0, y - f));
    for (let x = 0; x < W; x++) big[y * W + x] = mask[sy * width + Math.min(width - 1, Math.max(0, x - f))];
  }
  selOps.feather(big, W, H, radius);
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) out.set(big.subarray((y + f) * W + f, (y + f) * W + f + width), y * width);
  return out;
}

/** An alpha-only canvas (white, alpha = source alpha) of `size`, with the source placed at (x, y). */
export function alphaToMaskCanvas(src, size, x = 0, y = 0) {
  const out = createCanvas(size.width, size.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(src, x, y);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  return out;
}

/** Inverts the alpha of a mask canvas (white where the input was transparent). */
export function invertMaskCanvas(mask) {
  const img = imageDataOf(mask);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = 255 - d[i + 3];
  }
  return canvasFromImageData(img);
}

/** Mask of the transparent area of a composite (alpha 255 where the image is transparent); null when fully opaque. */
export function transparentAreaMask(composite) {
  const img = imageDataOf(composite);
  const d = img.data;
  let any = false;
  for (let i = 0; i < d.length; i += 4) {
    const a = 255 - d[i + 3];
    if (a) any = true;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = a;
  }
  return any ? canvasFromImageData(img) : null;
}

/**
 * A rough sky mask: bright, blue-leaning or near-white pixels connected to the top edge, dilated by a
 * few pixels and feathered. Returns null when nothing qualifies (the caller then asks for a selection).
 */
export function skyMask(composite, { minPixels = 0.01 } = {}) {
  const img = imageDataOf(composite);
  const { width: w, height: h, data: d } = img;
  const sky = new Uint8Array(w * h);
  const isSky = (i) => {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    if (d[i * 4 + 3] < 8) return false;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const blueish = b >= r && b >= g * 0.92 && lum > 90;
    const bright = lum > 190 && Math.max(r, g, b) - Math.min(r, g, b) < 60;
    return blueish || bright;
  };
  const stack = [];
  const push = (i) => {
    if (!sky[i] && isSky(i)) {
      sky[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) push(x);
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  let count = 0;
  for (let i = 0; i < sky.length; i++) count += sky[i];
  if (count < w * h * minPixels) return null;
  const out = new ImageData(w, h);
  const o = out.data;
  for (let i = 0; i < sky.length; i++) {
    o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = 255;
    o[i * 4 + 3] = sky[i] ? 255 : 0;
  }
  // blur the edge a little so the horizon blends; the canvas border is not an edge, so the mask is padded
  // with its own border pixels before blurring (otherwise the sky would fade out along the top and sides)
  const PAD = 4;
  const c = canvasFromImageData(out);
  const padded = createCanvas(w + 2 * PAD, h + 2 * PAD);
  const pc = padded.getContext('2d');
  pc.drawImage(c, PAD, PAD);
  pc.drawImage(c, 0, 0, w, 1, PAD, 0, w, PAD); // top strip
  pc.drawImage(c, 0, h - 1, w, 1, PAD, h + PAD, w, PAD); // bottom strip
  pc.drawImage(c, 0, 0, 1, h, 0, PAD, PAD, h); // left strip
  pc.drawImage(c, w - 1, 0, 1, h, w + PAD, PAD, PAD, h); // right strip
  pc.drawImage(c, 0, 0, 1, 1, 0, 0, PAD, PAD);
  pc.drawImage(c, w - 1, 0, 1, 1, w + PAD, 0, PAD, PAD);
  pc.drawImage(c, 0, h - 1, 1, 1, 0, h + PAD, PAD, PAD);
  pc.drawImage(c, w - 1, h - 1, 1, 1, w + PAD, h + PAD, PAD, PAD);
  const blurred = createCanvas(w + 2 * PAD, h + 2 * PAD);
  const bc = blurred.getContext('2d');
  bc.filter = 'blur(2px)';
  bc.drawImage(padded, 0, 0);
  bc.filter = 'none';
  return cropCanvas(blurred, PAD, PAD, w, h);
}

/** The selection as a feathered (1 px) alpha canvas cropped to `region`; full coverage is kept along the canvas border. */
function selectionMaskCanvas(doc, region, feather = 1) {
  let sel = doc.selection;
  if (feather > 0) {
    sel = doc.selection.clone();
    sel.mask = featherKeepingBorder(doc.selection.mask, sel.width, sel.height, feather);
    sel.invalidate();
  }
  return cropCanvas(sel.toCanvas(), region.x, region.y, region.width, region.height);
}

/**
 * The region sent for a generative fill: the selection bounds padded by 25 % on each side, made
 * square-ish, clamped to the canvas and limited to MAX_REGION (the padding shrinks first).
 */
export function fillRegion(bounds, docWidth, docHeight, maxSize = MAX_REGION) {
  const side = Math.max(bounds.width, bounds.height);
  let size = Math.ceil(side * 1.5); // 25 % padding on each side
  if (size > maxSize) size = Math.max(side, maxSize);
  let w = Math.max(bounds.width, Math.min(size, docWidth));
  let h = Math.max(bounds.height, Math.min(size, docHeight));
  // square-ish: grow the smaller side up to the larger within the canvas
  w = Math.min(docWidth, Math.max(w, Math.min(h, docWidth)));
  h = Math.min(docHeight, Math.max(h, Math.min(w, docHeight)));
  let x = Math.round(bounds.x + bounds.width / 2 - w / 2);
  let y = Math.round(bounds.y + bounds.height / 2 - h / 2);
  x = Math.max(0, Math.min(docWidth - w, x));
  y = Math.max(0, Math.min(docHeight - h, y));
  return { x, y, width: Math.round(w), height: Math.round(h) };
}

/** Applies an alpha mask to a canvas copy (destination-in). */
function throughMask(canvas, mask) {
  const out = copyCanvas(canvas);
  const ctx = out.getContext('2d');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  return out;
}

// ---- install ---------------------------------------------------------------------------------------------------------

export function install(app) {
  const doc = () => app.doc;
  const has = () => !!app.doc;
  const hasLayer = () => !!app.doc?.active && !app.doc.active.isGroup;
  const hasSel = () => !!app.doc?.selection && !app.doc.selection.isEmpty;
  const ai = () => app.ai;

  /** Checks the connection and returns { provider, status } or null (the accounts dialog was shown). */
  async function connected(kind) {
    if (!ai()) {
      app.dialogs.toast('AI is not available in this build', { kind: 'error' });
      return null;
    }
    const provider = await ai().ensureConnected(kind);
    if (!provider) return null;
    const status = ai().current;
    // the Preferred provider (AI Accounts) decides when it serves this kind; otherwise the last dialog's choice
    const prefs = ai().prefs();
    const def = prefs.defaultProvider;
    const saved = prefs[kind === 'image' ? 'imageProvider' : 'chatProvider'];
    const pick = def && ai().fits(def, kind) ? def : saved && ai().fits(saved, kind) ? saved : provider;
    return { provider: pick, status };
  }

  /**
   * Provider + model fields for formDialog. The model select is a custom field refilled whenever the
   * provider changes; `kind` picks chat or image models. Returns { fields, onChange, remember(values) }.
   */
  function providerFields(kind, start, status) {
    const prefKey = (p) => `${p}${kind === 'image' ? 'Image' : 'Chat'}`;
    const select = document.createElement('select');
    select.className = 'select';
    select.dataset.key = 'model';
    select.setAttribute('aria-label', 'Model');
    let formRef = null;
    let token = 0;
    const fill = async (provider) => {
      const my = ++token;
      select.disabled = true;
      select.replaceChildren(new Option('Loading…', ''));
      try {
        const list = await ai().models(provider);
        if (my !== token) return;
        const ids = kind === 'image' ? list.image : list.chat;
        const saved = ai().prefs()[prefKey(provider)];
        const chosen = saved && ids.includes(saved) ? saved : list.default[kind];
        select.replaceChildren();
        if (!ids.length) {
          select.append(new Option(`No ${kind} models for ${PROVIDERS[provider].label}`, ''));
          formRef?.set('model', '', { silent: true });
          return;
        }
        for (const id of ids) select.append(new Option(id, id, false, id === chosen));
        select.disabled = false;
        formRef?.set('model', chosen ?? ids[0], { silent: true });
      } catch (err) {
        if (my !== token) return;
        select.replaceChildren(new Option(`Could not list models: ${err?.message ?? err}`, ''));
        formRef?.set('model', '', { silent: true });
      }
    };
    select.addEventListener('change', () => formRef?.set('model', select.value, { silent: true }));
    const fields = [
      { key: 'provider', label: 'Provider', type: 'select', value: start, options: providerOptions(status, kind) },
      {
        key: 'model',
        label: 'Model',
        type: 'custom',
        value: '',
        render: (values, set, form) => {
          formRef = form;
          fill(values.provider);
          return select;
        },
        sync: (values) => {
          if (values.model && select.value !== values.model && [...select.options].some((o) => o.value === values.model)) select.value = values.model;
        },
      },
    ];
    return {
      fields,
      onChange: (values, key) => {
        if (key === 'provider') fill(values.provider);
      },
      validate: (values) => {
        if (!values.model) {
          app.dialogs.toast('Choose a model (connect a provider with image models in AI Accounts)', { kind: 'error' });
          return false;
        }
        return true;
      },
      remember: (values) => ai().setPrefs({ [kind === 'image' ? 'imageProvider' : 'chatProvider']: values.provider, [prefKey(values.provider)]: values.model }),
    };
  }

  /** Shows a dialog with a prompt, the provider/model fields and extra fields; resolves with the values or null. */
  async function optionsDialog({ title, kind = 'image', intro, promptLabel = 'Prompt', promptDefault = '', extra = [], okLabel = 'Generate', noPrompt = false }) {
    const c = await connected(kind);
    if (!c) return null;
    const pf = providerFields(kind, c.provider, c.status);
    const fields = [
      ...(noPrompt ? [] : [{ key: 'prompt', label: promptLabel, type: 'textarea', value: promptDefault, rows: 3 }]),
      ...pf.fields,
      ...extra,
    ];
    const values = await formDialog(app, {
      title,
      intro,
      fields,
      okLabel,
      width: 480,
      className: 'ai-dialog',
      onChange: pf.onChange,
      validate: (v) => {
        if (!noPrompt && !String(v.prompt ?? '').trim()) {
          app.dialogs.toast('Enter a prompt', { kind: 'error' });
          return false;
        }
        return pf.validate(v);
      },
    });
    if (!values) return null;
    pf.remember(values);
    if (!noPrompt) values.prompt = String(values.prompt).trim().slice(0, PROMPT_LIMIT);
    return values;
  }

  /** Composite of the document (what the providers see). */
  const composite = (d) => flattenDocument(d, d.view?.compositor);

  /** Adds raster layers above the active layer as one undoable entry and activates the last one. */
  function addLayers(d, layers, label) {
    const anchor = d.active && d.active !== d.root ? d.active : null;
    structural(app, label, () => {
      let parent = anchor?.isGroup ? anchor : anchor?.parent ?? d.root;
      let index = anchor?.isGroup ? anchor.children.length : anchor ? parent.children.indexOf(anchor) + 1 : parent.children.length;
      for (const l of layers) d.add(l, parent, index++);
      d.setActive(layers[layers.length - 1]);
    }, d, { bytes: layers.reduce((n, l) => n + l.canvas.width * l.canvas.height * 4, 0) });
    app.setEditingMask(false);
  }

  /** The active layer's pixels in document space as { canvas, x, y } (text/shape/smart layers rendered; an enabled layer mask applied). */
  function activePixels(d) {
    const layer = d.active;
    if (!layer || layer.isGroup) return null;
    if (layer.type === 'raster') {
      let canvas = layer.canvas;
      if (layer.mask?.canvas && layer.mask.enabled !== false) canvas = throughMask(layer.canvas, cropCanvas(layer.mask.canvas, layer.x, layer.y, layer.canvas.width, layer.canvas.height));
      return { layer, canvas, x: layer.x, y: layer.y };
    }
    const r = rasterizeLayer(layer, d);
    return r ? { layer, canvas: r.canvas, x: r.x, y: r.y } : null;
  }

  // ---- generative fill / expand --------------------------------------------------------------------------------------

  /**
   * Generative fill through a mask (an alpha canvas in document space, 255 = change): edits the composite
   * region and returns the new layers (one per variation) holding only the masked pixels.
   */
  async function fillThroughMask(d, mask, region, { provider, model, prompt, variations = 1, name }, state) {
    const src = cropCanvas(composite(d), region.x, region.y, region.width, region.height);
    const regionMask = cropCanvas(mask, region.x, region.y, region.width, region.height);
    const layers = [];
    for (let i = 0; i < variations; i++) {
      if (state?.cancelled) break;
      const answer = await ai().providers.editImage({ provider, model, image: src, mask: regionMask, prompt });
      const pixels = throughMask(answer, regionMask);
      layers.push(new RasterLayer({ name: variations > 1 ? `${name} ${i + 1}` : name, canvas: pixels, x: region.x, y: region.y }));
    }
    return layers;
  }

  async function generativeFill(opts = null) {
    const d = doc();
    if (!d || !hasSel()) return app.dialogs.toast('Make a selection first', { kind: 'error' });
    let values = opts;
    if (!values) {
      values = await optionsDialog({
        title: 'Generative Fill',
        intro: 'Fills the selection with what you describe, taking the surrounding image into account.',
        promptLabel: 'Describe what to generate',
        promptDefault: ai().prefs().lastFillPrompt ?? '',
        extra: [{ key: 'variations', label: 'Variations', type: 'slider', value: 1, min: 1, max: 3 }],
      });
      if (!values) return;
      ai().setPrefs({ lastFillPrompt: values.prompt });
    } else {
      const c = await connected('image');
      if (!c) return;
      values = { provider: c.provider, model: await ai().model(c.provider, 'image'), variations: 1, ...opts };
      if (!values.model) throw new Error(`No ${PROVIDERS[values.provider].label} image model is available`);
    }
    const b = d.selection.bounds;
    const region = fillRegion(b, d.width, d.height);
    const mask = selectionMaskCanvas(d, { x: 0, y: 0, width: d.width, height: d.height }, 1);
    const n = Math.max(1, Math.min(3, Math.round(values.variations ?? 1)));
    try {
      const layers = await aiTask(app, n > 1 ? `Generating ${n} fills…` : 'Generative Fill…', (state) => fillThroughMask(d, mask, region, { ...values, variations: n, name: 'Generative Fill' }, state));
      if (!layers.length) return;
      addLayers(d, layers, 'Generative Fill');
      return layers.map((l) => l.id);
    } catch (err) {
      reportAiError(app, err, 'Generative Fill failed');
    }
  }

  async function generativeExpand() {
    const d = doc();
    if (!d) return;
    const already = !!transparentAreaMask(composite(d));
    const values = await optionsDialog({
      title: 'Generative Expand',
      intro: already
        ? 'Fills the transparent area around the image (enlarge the canvas further here if you like). Describe what should appear there, or leave a short hint such as "continue the scene".'
        : 'Enlarges the canvas and fills the new area so the picture continues. Describe what should appear there, or leave a short hint such as "continue the scene".',
      promptLabel: 'Describe the expansion',
      promptDefault: ai().prefs().lastExpandPrompt ?? 'Continue the image naturally into the empty area, matching its style, lighting and perspective.',
      extra: [
        { key: 'width', label: 'New width', type: 'number', value: d.width, min: d.width, max: 30000, unit: 'px' },
        { key: 'height', label: 'New height', type: 'number', value: d.height, min: d.height, max: 30000, unit: 'px' },
        { key: 'anchor', label: 'Keep the image', type: 'select', value: 'c', options: ANCHORS },
      ],
    });
    if (!values) return;
    ai().setPrefs({ lastExpandPrompt: values.prompt });
    const W = Math.max(d.width, Math.round(values.width) || d.width), H = Math.max(d.height, Math.round(values.height) || d.height);
    // the canvas grows here with a transparent extension (Canvas Size fills an opaque Background by default)
    if (W > d.width || H > d.height) await app.commands.run('image:canvas-size', { width: W, height: H, anchor: values.anchor, color: null }, 'api');
    const mask = transparentAreaMask(composite(d));
    if (!mask) return app.dialogs.toast('Nothing to expand: enter a larger size, or enlarge the canvas with a transparent extension (Image › Canvas Size)', { kind: 'error', timeout: 6000 });
    const region = { x: 0, y: 0, width: d.width, height: d.height };
    try {
      const layers = await aiTask(app, 'Generative Expand…', (state) => fillThroughMask(d, mask, region, { ...values, variations: 1, name: 'Generative Expand' }, state));
      if (!layers.length) return;
      addLayers(d, layers, 'Generative Expand');
    } catch (err) {
      reportAiError(app, err, 'Generative Expand failed');
    }
  }

  // ---- generate image ---------------------------------------------------------------------------------------------------

  async function generateImage() {
    const d = doc();
    const preset = app.settings.newDocPreset ?? {};
    const values = await optionsDialog({
      title: 'Generate Image',
      promptLabel: 'Describe the image',
      promptDefault: ai().prefs().lastGeneratePrompt ?? '',
      extra: [
        { key: 'target', label: 'Place in', type: 'select', value: d ? 'layer' : 'document', options: [...(d ? [['layer', 'New layer (document size)']] : []), ['document', 'New document']] },
        { key: 'width', label: 'Width', type: 'number', value: d?.width ?? preset.width ?? 1024, min: 16, max: 8192, unit: 'px', when: (v) => v.target === 'document' },
        { key: 'height', label: 'Height', type: 'number', value: d?.height ?? preset.height ?? 1024, min: 16, max: 8192, unit: 'px', when: (v) => v.target === 'document' },
        { key: 'transparent', label: 'Transparent background', type: 'checkbox', value: false, when: (v) => !/^dall-e/.test(String(v.model ?? '')), help: 'gpt-image models return real transparency; Gemini models are asked for a plain white background, which is keyed out afterwards.' },
      ],
    });
    if (!values) return;
    ai().setPrefs({ lastGeneratePrompt: values.prompt });
    const toDoc = values.target === 'document' || !d;
    const width = toDoc ? Math.round(values.width) : d.width;
    const height = toDoc ? Math.round(values.height) : d.height;
    try {
      const image = await aiTask(app, 'Generating image…', () => ai().providers.generateImage({ provider: values.provider, model: values.model, prompt: values.prompt, width, height, transparent: !!values.transparent }));
      if (toDoc) {
        const fresh = createDocument({ width, height, dpi: d?.dpi ?? 72, name: values.prompt.slice(0, 40) || 'Generated image', background: 'transparent' });
        const first = fresh.root.children[0];
        first.name = 'Generated';
        fresh.meta.description = values.prompt;
        app.docs.add(fresh);
        // a history entry, so the new document counts as unsaved (closing asks) and the generation can be undone
        fresh.history.pixels('Generate Image', first.canvas, { x: 0, y: 0, width, height }, (ctx) => ctx.drawImage(image, 0, 0), { layer: first });
        return fresh.id;
      }
      const layer = new RasterLayer({ name: nextLayerName(d, 'Generated'), canvas: image, x: 0, y: 0 });
      addLayers(d, [layer], 'Generate Image');
      return layer.id;
    } catch (err) {
      reportAiError(app, err, 'Generate Image failed');
    }
  }

  // ---- remove / replace background, replace sky --------------------------------------------------------------------------

  /**
   * Asks the model for the subject of the active layer with a transparent background and returns the
   * subject's alpha as a document-sized mask canvas (plus the layer pixels used). Opaque answers (Gemini)
   * are keyed on their near-white border.
   */
  async function subjectMask(d, { provider, model }, state) {
    const px = activePixels(d);
    if (!px) throw new Error('Select a layer with pixels');
    const answer = await ai().providers.editImage({ provider, model, image: px.canvas, prompt: 'Remove the background. Keep the subject exactly as it is, with its edges intact, on a fully transparent background.', transparent: true });
    if (state?.cancelled) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    const img = imageDataOf(answer);
    if (isOpaque(img)) keyWhiteBorder(img);
    const alpha = canvasFromImageData(img);
    return { layer: px.layer, x: px.x, y: px.y, mask: alphaToMaskCanvas(alpha, d, px.x, px.y) };
  }

  async function removeBackground() {
    const d = doc();
    if (!d || !hasLayer()) return;
    const c = await connected('image');
    if (!c) return;
    const model = await ai().model(c.provider, 'image');
    if (!model) return reportAiError(app, Object.assign(new Error(`No ${PROVIDERS[c.provider].label} image model is available`), { code: 'not_connected' }), 'Remove Background failed');
    try {
      const r = await aiTask(app, 'Removing background…', (state) => subjectMask(d, { provider: c.provider, model }, state));
      // what the user had already masked away stays hidden: intersect with the existing (enabled) mask
      if (r.layer.mask?.canvas && r.layer.mask.enabled !== false) {
        const mctx = r.mask.getContext('2d');
        mctx.globalCompositeOperation = 'destination-in';
        mctx.drawImage(r.layer.mask.canvas, 0, 0);
        mctx.globalCompositeOperation = 'source-over';
      }
      const copy = cloneLayer(r.layer, { name: `${r.layer.name} (no background)` });
      copy.mask = { canvas: r.mask, enabled: true, linked: true };
      // the copy carries the mask so the original stays editable; it is hidden, not removed. Visibility is not
      // part of a structural snapshot, so the two changes are grouped into one history entry.
      const original = r.layer;
      d.history.group('Remove Background', () => {
        structural(app, 'Remove Background', () => {
          d.add(copy, original.parent, original.parent.children.indexOf(original) + 1);
          d.setActive(copy);
        }, d, { bytes: r.mask.width * r.mask.height * 4 });
        setLayerProps(app, original, { visible: false }, 'Hide layer');
      });
      app.setEditingMask(false);
      return copy.id;
    } catch (err) {
      reportAiError(app, err, 'Remove Background failed');
    }
  }

  async function replaceBackground() {
    const d = doc();
    if (!d || !hasLayer()) return;
    const values = await optionsDialog({
      title: 'Replace Background',
      intro: 'The subject of the active layer is kept; everything around it is regenerated from your description.',
      promptLabel: 'Describe the new background',
      promptDefault: ai().prefs().lastBackgroundPrompt ?? '',
    });
    if (!values) return;
    ai().setPrefs({ lastBackgroundPrompt: values.prompt });
    try {
      const layers = await aiTask(app, 'Replacing background…', async (state) => {
        const subject = await subjectMask(d, values, state);
        const mask = invertMaskCanvas(subject.mask);
        const region = { x: 0, y: 0, width: d.width, height: d.height };
        return fillThroughMask(d, mask, region, { ...values, variations: 1, name: 'Replace Background' }, state);
      });
      if (!layers.length) return;
      addLayers(d, layers, 'Replace Background');
    } catch (err) {
      reportAiError(app, err, 'Replace Background failed');
    }
  }

  async function replaceSky() {
    const d = doc();
    if (!d || !hasLayer()) return;
    const values = await optionsDialog({
      title: 'Replace Sky',
      intro: hasSel() ? 'The selection marks the sky.' : 'The bright area at the top of the image is treated as the sky (make a selection to mark it yourself).',
      promptLabel: 'Describe the new sky',
      promptDefault: ai().prefs().lastSkyPrompt ?? 'A dramatic sunset sky with warm clouds',
    });
    if (!values) return;
    ai().setPrefs({ lastSkyPrompt: values.prompt });
    const mask = hasSel() ? selectionMaskCanvas(d, { x: 0, y: 0, width: d.width, height: d.height }, 1) : skyMask(composite(d));
    if (!mask) return app.dialogs.toast('No sky was found at the top of the image; select the sky area and try again', { kind: 'error', timeout: 6000 });
    const region = { x: 0, y: 0, width: d.width, height: d.height };
    try {
      const layers = await aiTask(app, 'Replacing sky…', (state) => fillThroughMask(d, mask, region, { ...values, variations: 1, name: 'Replace Sky' }, state));
      if (!layers.length) return;
      addLayers(d, layers, 'Replace Sky');
    } catch (err) {
      reportAiError(app, err, 'Replace Sky failed');
    }
  }

  // ---- describe --------------------------------------------------------------------------------------------------------------

  async function describe() {
    const d = doc();
    if (!d) return;
    const c = await connected('chat');
    if (!c) return;
    const model = await ai().model(c.provider, 'chat');
    if (!model) return reportAiError(app, Object.assign(new Error(`No ${PROVIDERS[c.provider].label} chat model is available`), { code: 'not_connected' }), 'Describe Image failed');
    let text;
    try {
      text = await aiTask(app, 'Describing image…', () => ai().providers.describeImage({ provider: c.provider, model, image: composite(d) }));
    } catch (err) {
      return reportAiError(app, err, 'Describe Image failed');
    }
    if (!text) return app.dialogs.toast('The model returned no description', { kind: 'error' });
    const content = document.createElement('div');
    content.className = 'ai-describe';
    const ta = document.createElement('textarea');
    ta.className = 'textarea ai-describe-text';
    ta.readOnly = true;
    ta.rows = 10;
    ta.value = text;
    ta.setAttribute('aria-label', 'Description');
    content.append(ta);
    const choice = await app.dialogs.open({
      title: 'Describe Image',
      content,
      width: 560,
      className: 'ai-describe-dialog',
      buttons: [
        { label: 'Copy', value: 'copy' },
        { label: 'Use as document description', value: 'use' },
        { label: 'Close', value: true, primary: true },
      ],
    });
    if (choice === 'copy') {
      bridge.writeClipboardText(text);
      app.dialogs.toast('Description copied', { kind: 'success', timeout: 1500 });
    } else if (choice === 'use') {
      const before = d.meta.description ?? '';
      const set = (v) => {
        d.meta.description = v;
        d.changed('props');
      };
      set(text);
      d.history.push({ label: 'Document description', undo: () => set(before), redo: () => set(text), bytes: 0, at: Date.now() });
      d.changed('history');
      app.dialogs.toast('Saved as the document description (File › Document Properties)', { kind: 'success', timeout: 2500 });
    }
    return text;
  }

  // programmatic entry points (the assistant's generative_fill tool, tests)
  app.aiFeatures = { generativeFill, generativeExpand, generateImage, removeBackground, replaceBackground, replaceSky, describe, task: (label, fn) => aiTask(app, label, fn) };

  app.commands.registerAll({
    'ai:generative-fill': { enabled: () => hasLayer() && hasSel(), run: () => generativeFill(), label: 'Generative Fill…' },
    'ai:generative-expand': { enabled: hasLayer, run: generativeExpand, label: 'Generative Expand…' },
    'ai:generate-image': { run: generateImage, label: 'Generate Image…' },
    'ai:remove-background': { enabled: hasLayer, run: removeBackground, label: 'Remove Background' },
    'ai:replace-background': { enabled: hasLayer, run: replaceBackground, label: 'Replace Background…' },
    'ai:replace-sky': { enabled: hasLayer, run: replaceSky, label: 'Replace Sky…' },
    'ai:describe': { enabled: has, run: describe, label: 'Describe Image' },
  });
  void makeCanvas;
  void resampleTo;
}
