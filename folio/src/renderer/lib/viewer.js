// DocumentView: the pdf.js wrapper for one open document (see ARCHITECTURE.md).
import * as pdfjsLib from 'pdfjs-dist';
import { EventBus, PDFViewer, PDFLinkService, PDFFindController, PDFHistory, PDFScriptingManager, LinkTarget, ScrollMode, SpreadMode } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { icon } from './icons.js';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url);
// The worker goes through lib/pdf-worker.js so the polyfills load before pdf.js' worker code.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf-worker.js', import.meta.url).href;

export const { AnnotationEditorType, AnnotationEditorParamsType, AnnotationMode } = pdfjsLib;
export { ScrollMode, SpreadMode };

export const HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F';
export const ZOOM_PRESETS = ['auto', 'page-fit', 'page-width', 'page-actual'];

export class PasswordError extends Error {
  constructor(wrong) {
    super(wrong ? 'The password is incorrect' : 'This document is password protected');
    this.name = 'PasswordError';
    this.needsPassword = true;
    this.wrong = !!wrong;
  }
}

export class InvalidPdfError extends Error {
  constructor(message) {
    super(message || 'The file is not a valid PDF document');
    this.name = 'InvalidPdfError';
  }
}

/** Groups DOMRects that sit on one line into fewer, wider rects (text layers produce one rect per span). */
function mergeLineRects(rects) {
  const sorted = rects
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const h = Math.min(last.bottom - last.top, r.bottom - r.top);
      const sameLine = Math.abs(last.top - r.top) < h * 0.5 && Math.abs(last.bottom - r.bottom) < h * 0.5;
      const touching = r.left <= last.right + h * 0.6;
      if (sameLine && touching) {
        last.right = Math.max(last.right, r.right);
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

export class DocumentView {
  #modified = false;
  #editsListeners = new Set();
  #loadingTask = null;
  #resizeObserver = null;
  #grab = null;
  #overlay = null;
  #unsubscribe = [];

  constructor({ host, app, session }) {
    this.app = app;
    this.session = session;
    this.host = host;
    this.bytes = null;
    this.pdfDocument = null;
    this.nightMode = false;
    this.handTool = false;
    this.presentation = false;

    this.container = document.createElement('div');
    this.container.className = 'viewerContainer';
    this.container.tabIndex = -1;
    const viewer = document.createElement('div');
    viewer.className = 'pdfViewer';
    this.container.appendChild(viewer);
    host.appendChild(this.container);
    this.viewerAlert = document.createElement('div');
    this.viewerAlert.className = 'sr-only';
    this.viewerAlert.setAttribute('role', 'alert');
    host.appendChild(this.viewerAlert);

    const eventBus = (this.eventBus = new EventBus());
    this.linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow' });
    this.findController = new PDFFindController({ eventBus, linkService: this.linkService, updateMatchesCountOnProgress: true });
    try {
      this.scriptingManager = new PDFScriptingManager({
        eventBus,
        sandboxBundleSrc: new URL('pdf.sandbox.mjs', VENDOR).href,
        docProperties: (pdfDocument) => this.#docProperties(pdfDocument),
      });
    } catch (err) {
      console.warn('Form scripting unavailable', err);
      this.scriptingManager = null;
    }
    this.pdfViewer = new PDFViewer({
      container: this.container,
      viewer,
      eventBus,
      linkService: this.linkService,
      findController: this.findController,
      scriptingManager: this.scriptingManager ?? undefined,
      viewerAlert: this.viewerAlert,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS,
      enableHighlightFloatingButton: true,
      enableUpdatedAddImage: false,
      imageResourcesPath: new URL('images/', VENDOR).href,
      removePageBorders: true,
      supportsPinchToZoom: true,
      enablePermissions: false,
      enableAutoLinking: true,
    });
    this.linkService.setViewer(this.pdfViewer);
    this.history = new PDFHistory({ linkService: this.linkService, eventBus });
    this.linkService.setHistory(this.history);

    this.#wireEvents();
    this.#setupWheelZoom();
    this.#setupGrabToPan();
    this.#resizeObserver = new ResizeObserver(() => this.#onResize());
    this.#resizeObserver.observe(host);
    this.applySettings(app.settings);
  }

  // ---- loading -----------------------------------------------------------------------------------

  async load(bytes, { password, name } = {}) {
    this.name = name ?? this.name ?? 'document.pdf';
    this.#showLoading();
    await this.#closeDocument();
    this.bytes = bytes;
    const data = bytes.slice();
    const task = pdfjsLib.getDocument({
      data,
      password: password || undefined,
      cMapUrl: new URL('cmaps/', VENDOR).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
      wasmUrl: new URL('wasm/', VENDOR).href,
      iccUrl: new URL('iccs/', VENDOR).href,
      enableXfa: true,
    });
    this.#loadingTask = task;
    let pdfDocument;
    try {
      pdfDocument = await task.promise;
    } catch (err) {
      this.#hideOverlay();
      if (this.#loadingTask === task) this.#loadingTask = null;
      task.destroy().catch(() => {});
      if (err?.name === 'PasswordException') throw new PasswordError(err.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
      throw new InvalidPdfError(err?.message);
    }
    if (this.#loadingTask !== task) {
      // superseded by another load
      pdfDocument.loadingTask.destroy().catch(() => {});
      throw new Error('Load cancelled');
    }
    this.pdfDocument = pdfDocument;
    this.#modified = false;
    pdfDocument.annotationStorage.onSetModified = () => this.#setModified(true);
    pdfDocument.annotationStorage.onResetModified = () => this.#setModified(false);

    const firstPage = new Promise((resolve) => this.eventBus.on('pagesinit', resolve, { once: true }));
    this.pdfViewer.setDocument(pdfDocument);
    this.linkService.setDocument(pdfDocument, null);
    this.history.initialize({ fingerprint: pdfDocument.fingerprints[0] ?? 'folio', resetHistory: true, updateUrl: false });
    await firstPage;
    this.pdfViewer.currentScaleValue = this.#initialZoom();
    this.#hideOverlay();
    return { numPages: pdfDocument.numPages };
  }

  /** Reloads new bytes for the same document (after a pdf-lib operation). */
  async reload(bytes, { keepPosition = true, password } = {}) {
    const state = keepPosition ? this.#captureState() : null;
    try {
      await this.load(bytes, { password, name: this.name });
    } catch (err) {
      this.#showError(err);
      throw err;
    }
    if (state) await this.#restoreState(state);
  }

  async #closeDocument() {
    const task = this.#loadingTask;
    this.#loadingTask = null;
    if (this.pdfDocument) {
      this.pdfViewer.setDocument(null);
      this.linkService.setDocument(null, null);
      const doc = this.pdfDocument;
      this.pdfDocument = null;
      await doc.loadingTask.destroy().catch(() => {});
    } else if (task) {
      await task.destroy().catch(() => {});
    }
  }

  destroy() {
    this.#resizeObserver?.disconnect();
    for (const off of this.#unsubscribe) off();
    this.#closeDocument().catch(() => {});
    this.pdfViewer.cleanup?.();
  }

  onActivate() {
    // The host was display:none; sizes are only valid now.
    requestAnimationFrame(() => {
      if (!this.pdfDocument) return;
      this.#reapplyPresetScale();
      this.pdfViewer.update();
      this.container.focus({ preventScroll: true });
    });
  }

  onDeactivate() {}

  #captureState() {
    const { pdfViewer, container } = this;
    return {
      page: pdfViewer.currentPageNumber,
      scaleValue: pdfViewer.currentScaleValue,
      scale: pdfViewer.currentScale,
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      rotation: pdfViewer.pagesRotation,
      scrollMode: pdfViewer.scrollMode,
      spreadMode: pdfViewer.spreadMode,
    };
  }

  async #restoreState(state) {
    const { pdfViewer, container } = this;
    pdfViewer.pagesRotation = state.rotation;
    pdfViewer.scrollMode = state.scrollMode;
    pdfViewer.spreadMode = state.spreadMode;
    pdfViewer.currentScaleValue = ZOOM_PRESETS.includes(state.scaleValue) ? state.scaleValue : String(state.scale);
    await pdfViewer.pagesPromise;
    pdfViewer.currentPageNumber = Math.min(state.page, pdfViewer.pagesCount);
    container.scrollTop = state.scrollTop;
    container.scrollLeft = state.scrollLeft;
  }

  #initialZoom() {
    const z = this.app.settings.defaultZoom;
    if (typeof z === 'number' && z > 0) return String(z);
    return ZOOM_PRESETS.includes(z) ? z : 'auto';
  }

  async #docProperties(pdfDocument) {
    const { info, metadata } = await pdfDocument.getMetadata();
    return {
      ...info,
      baseURL: '',
      filesize: this.bytes?.byteLength ?? 0,
      filename: this.name,
      metadata: metadata?.getRaw?.(),
      authors: metadata?.get?.('dc:creator'),
      numPages: pdfDocument.numPages,
      URL: '',
    };
  }

  applySettings(settings) {
    this.pdfViewer.scrollMode = settings.scrollMode ?? ScrollMode.VERTICAL;
    this.pdfViewer.spreadMode = settings.spreadMode ?? SpreadMode.NONE;
    this.container.classList.toggle('highlight-fields', settings.highlightFormFields !== false);
    this.nightMode = !!settings.nightMode;
    this.container.classList.toggle('night', this.nightMode);
  }

  // ---- overlays ------------------------------------------------------------------------------------

  #showLoading() {
    this.#hideOverlay();
    const el = document.createElement('div');
    el.className = 'doc-overlay';
    el.innerHTML = '<div class="doc-loading"><div class="spinner"></div><div>Opening…</div></div>';
    this.host.appendChild(el);
    this.#overlay = el;
  }

  #showError(err) {
    this.#hideOverlay();
    const el = document.createElement('div');
    el.className = 'doc-overlay';
    el.innerHTML = `<div class="doc-error">${icon('warning')}<h3>Could not open this document</h3><p class="muted"></p></div>`;
    el.querySelector('p').textContent = err?.message ?? String(err);
    this.host.appendChild(el);
    this.#overlay = el;
  }

  #hideOverlay() {
    this.#overlay?.remove();
    this.#overlay = null;
  }

  // ---- events ---------------------------------------------------------------------------------------

  #wireEvents() {
    const { eventBus, app } = this;
    const on = (name, handler) => {
      eventBus.on(name, handler);
      this.#unsubscribe.push(() => eventBus.off(name, handler));
    };
    on('pagechanging', ({ pageNumber }) => {
      app.emit('page:changed', { session: this.session, page: pageNumber });
      app.commands.invalidate();
    });
    on('scalechanging', ({ scale, presetValue }) => app.emit('zoom:changed', { session: this.session, scale, value: presetValue ?? scale }));
    on('rotationchanging', ({ pagesRotation }) => app.emit('rotation:changed', { session: this.session, rotation: pagesRotation }));
    on('editingstateschanged', ({ details }) => {
      app.emit('editor:states', { session: this.session, ...details });
      app.commands.invalidate();
    });
    on('annotationeditormodechanged', ({ mode }) => app.emit('editor:mode', { session: this.session, mode }));
    on('scrollmodechanged', ({ mode }) => app.emit('layout:mode', { session: this.session, scrollMode: mode }));
    on('spreadmodechanged', ({ mode }) => app.emit('layout:mode', { session: this.session, spreadMode: mode }));
    on('pagesloaded', () => app.emit('doc:pages', this.session));
    on('namedaction', ({ action }) => {
      const map = { GoBack: 'view:back', GoForward: 'view:forward', NextPage: 'view:next-page', PrevPage: 'view:prev-page', FirstPage: 'view:first-page', LastPage: 'view:last-page', Find: 'edit:find', Print: 'file:print', SaveAs: 'file:save-as' };
      if (map[action]) app.commands.run(map[action], undefined, 'api');
    });
    const onSelection = () => {
      const sel = document.getSelection();
      const hasText = !!sel && !sel.isCollapsed && this.container.contains(sel.anchorNode);
      if (hasText !== this.hasTextSelection) {
        this.hasTextSelection = hasText;
        app.emit('selection:changed', { session: this.session, hasText });
        app.commands.invalidate();
      }
    };
    document.addEventListener('selectionchange', onSelection);
    this.#unsubscribe.push(() => document.removeEventListener('selectionchange', onSelection));
  }

  on(event, handler) {
    this.eventBus.on(event, handler);
    return () => this.eventBus.off(event, handler);
  }

  #onResize() {
    if (!this.pdfDocument || this.host.hidden) return;
    this.#reapplyPresetScale();
    this.pdfViewer.update();
  }

  #reapplyPresetScale() {
    const value = this.pdfViewer.currentScaleValue;
    if (ZOOM_PRESETS.includes(value)) this.pdfViewer.currentScaleValue = value;
  }

  // ---- navigation / layout ----------------------------------------------------------------------------

  get numPages() {
    return this.pdfDocument?.numPages ?? 0;
  }
  get page() {
    return this.pdfViewer.currentPageNumber;
  }
  set page(n) {
    if (!this.pdfDocument) return;
    const page = Math.max(1, Math.min(this.numPages, Math.floor(Number(n) || 1)));
    this.pdfViewer.currentPageNumber = page;
  }
  get pageLabel() {
    return this.pdfViewer.currentPageLabel;
  }
  goToPageLabel(label) {
    this.linkService.goToPage(label);
  }
  get zoom() {
    const v = this.pdfViewer.currentScaleValue;
    return ZOOM_PRESETS.includes(v) ? v : this.pdfViewer.currentScale;
  }
  set zoom(value) {
    if (!this.pdfDocument) return;
    if (typeof value === 'number') this.pdfViewer.currentScaleValue = String(Math.max(0.1, Math.min(10, value)));
    else if (ZOOM_PRESETS.includes(value)) this.pdfViewer.currentScaleValue = value;
  }
  get scale() {
    return this.pdfViewer.currentScale;
  }
  zoomIn(steps = 1) {
    this.pdfViewer.increaseScale({ steps });
  }
  zoomOut(steps = 1) {
    this.pdfViewer.decreaseScale({ steps });
  }
  zoomAt(delta, clientX, clientY) {
    this.pdfViewer.updateScale({ steps: delta, origin: [clientX, clientY] });
  }
  get rotation() {
    return this.pdfViewer.pagesRotation;
  }
  rotate(delta) {
    if (!this.pdfDocument) return;
    this.pdfViewer.pagesRotation = (this.pdfViewer.pagesRotation + delta + 360) % 360;
  }
  get scrollMode() {
    return this.pdfViewer.scrollMode;
  }
  set scrollMode(mode) {
    this.pdfViewer.scrollMode = mode;
  }
  get spreadMode() {
    return this.pdfViewer.spreadMode;
  }
  set spreadMode(mode) {
    this.pdfViewer.spreadMode = mode;
  }
  nextPage() {
    this.pdfViewer.nextPage();
  }
  previousPage() {
    this.pdfViewer.previousPage();
  }
  goToDestination(dest) {
    return this.linkService.goToDestination(dest);
  }
  back() {
    this.history.back();
  }
  forward() {
    this.history.forward();
  }
  focus() {
    this.container.focus({ preventScroll: true });
  }

  setNightMode(flag) {
    this.nightMode = !!flag;
    this.container.classList.toggle('night', this.nightMode);
  }

  setHandTool(flag) {
    this.handTool = !!flag;
    this.container.classList.toggle('hand-tool', this.handTool);
  }

  setHighlightFields(flag) {
    this.container.classList.toggle('highlight-fields', !!flag);
  }

  // ---- editing (pdf.js annotation editors) ---------------------------------------------------------

  get uiManager() {
    return this.pdfViewer._layerProperties?.annotationEditorUIManager ?? null;
  }
  get editorMode() {
    return this.pdfViewer.annotationEditorMode;
  }
  set editorMode(mode) {
    if (!this.pdfDocument) return;
    try {
      this.pdfViewer.annotationEditorMode = { mode };
    } catch (err) {
      console.warn('Cannot switch editor mode', err);
    }
  }
  setEditorParam(type, value) {
    this.eventBus.dispatch('switchannotationeditorparams', { source: this, type, value });
  }
  editorAction(name) {
    this.eventBus.dispatch('editingaction', { source: this, name });
  }
  get editorStates() {
    const m = this.uiManager;
    return m ? { hasSelectedEditor: m.hasSelection, hasSomethingToUndo: m.hasSomethingToUndo?.(), hasSomethingToRedo: m.hasSomethingToRedo?.() } : {};
  }

  /** Adds an image (PNG blob) as a stamp editor, centred in the view or at page coordinates (CSS px inside the page). */
  async addImageStamp(blob, { pageIndex = this.page - 1, x, y } = {}) {
    if (!this.pdfDocument) return false;
    this.editorMode = AnnotationEditorType.STAMP;
    const pageView = this.pdfViewer.getPageView(pageIndex);
    if (!pageView) return false;
    if (pageView.renderingState < 3 /* FINISHED */ || !pageView.annotationEditorLayer?.annotationEditorLayer) {
      this.pdfViewer.currentPageNumber = pageIndex + 1;
    }
    let layer = null;
    for (let i = 0; i < 60 && !layer; i++) {
      layer = pageView.annotationEditorLayer?.annotationEditorLayer ?? null;
      if (!layer) await new Promise((r) => setTimeout(r, 50));
    }
    if (!layer) return false;
    const file = new File([blob], 'image.png', { type: blob.type || 'image/png' });
    if (Number.isFinite(x) && Number.isFinite(y)) {
      layer.createAndAddNewEditor({ offsetX: x, offsetY: y }, true, { bitmapFile: file });
    } else {
      await layer.pasteEditor({ mode: AnnotationEditorType.STAMP }, { bitmapFile: file });
    }
    return true;
  }

  hasUnsavedEdits() {
    return this.#modified;
  }

  onEditsChanged(handler) {
    this.#editsListeners.add(handler);
    return () => this.#editsListeners.delete(handler);
  }

  #setModified(flag) {
    if (this.#modified === flag) return;
    this.#modified = flag;
    for (const fn of this.#editsListeners) fn(flag);
    this.app.emit('doc:dirty', { session: this.session, dirty: this.session?.dirty ?? flag });
    this.app.commands.invalidate();
  }

  /** Returns the current bytes, saving pdf.js edits (forms + editors) into them first when needed. */
  async flush() {
    if (!this.pdfDocument) return this.bytes;
    if (this.#modified) {
      const data = await this.pdfDocument.saveDocument();
      this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    }
    return this.bytes;
  }

  markSaved() {
    if (this.pdfDocument) this.pdfDocument.annotationStorage.resetModified();
    this.#setModified(false);
  }

  // ---- geometry ---------------------------------------------------------------------------------------

  getPageView(index) {
    return this.pdfViewer.getPageView(index) ?? null;
  }

  pageElement(index) {
    return this.getPageView(index)?.div ?? null;
  }

  pageIndexAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const page = el?.closest?.('.page');
    if (!page || !this.container.contains(page)) return -1;
    return Number(page.dataset.pageNumber) - 1;
  }

  clientToPdf(pageIndex, clientX, clientY) {
    const pv = this.getPageView(pageIndex);
    if (!pv) return null;
    const rect = pv.div.getBoundingClientRect();
    const [x, y] = pv.viewport.convertToPdfPoint(clientX - rect.left, clientY - rect.top);
    return { x, y };
  }

  pdfToClient(pageIndex, x, y) {
    const pv = this.getPageView(pageIndex);
    if (!pv) return null;
    const rect = pv.div.getBoundingClientRect();
    const [vx, vy] = pv.viewport.convertToViewportPoint(x, y);
    return { x: rect.left + vx, y: rect.top + vy };
  }

  /** Current text selection as PDF-space quads grouped by page, or null. */
  getSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !this.container.contains(sel.anchorNode)) return null;
    const text = sel.toString();
    const byPage = new Map();
    for (let r = 0; r < sel.rangeCount; r++) {
      const range = sel.getRangeAt(r);
      const rects = [...range.getClientRects()];
      // map rects to pages by hit testing their centre against page divs
      const pages = [...this.container.querySelectorAll('.page')];
      for (const rect of mergeLineRects(rects)) {
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        const pageEl = pages.find((p) => {
          const b = p.getBoundingClientRect();
          return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
        });
        if (!pageEl) continue;
        const pageIndex = Number(pageEl.dataset.pageNumber) - 1;
        const pv = this.getPageView(pageIndex);
        if (!pv) continue;
        const b = pageEl.getBoundingClientRect();
        const corners = [
          [rect.left, rect.top],
          [rect.right, rect.top],
          [rect.left, rect.bottom],
          [rect.right, rect.bottom],
        ].map(([x, y]) => pv.viewport.convertToPdfPoint(x - b.left, y - b.top));
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const x1 = Math.min(...xs);
        const x2 = Math.max(...xs);
        const y1 = Math.min(...ys);
        const y2 = Math.max(...ys);
        if (!byPage.has(pageIndex)) byPage.set(pageIndex, { pageIndex, text, quads: [], rects: [] });
        const entry = byPage.get(pageIndex);
        entry.quads.push([x1, y2, x2, y2, x1, y1, x2, y1]);
        entry.rects.push([x1, y1, x2, y2]);
      }
    }
    if (!byPage.size) return null;
    return [...byPage.values()].sort((a, b) => a.pageIndex - b.pageIndex);
  }

  clearSelection() {
    document.getSelection()?.removeAllRanges();
  }

  // ---- document info --------------------------------------------------------------------------------

  getOutline() {
    return this.pdfDocument?.getOutline() ?? Promise.resolve(null);
  }
  getAttachments() {
    return this.pdfDocument?.getAttachments() ?? Promise.resolve(null);
  }
  getMetadata() {
    return this.pdfDocument?.getMetadata() ?? Promise.resolve({ info: {}, metadata: null });
  }
  getPermissions() {
    return this.pdfDocument?.getPermissions() ?? Promise.resolve(null);
  }
  getOptionalContentConfig() {
    return this.pdfDocument?.getOptionalContentConfig() ?? Promise.resolve(null);
  }
  getPageLabels() {
    return this.pdfDocument?.getPageLabels() ?? Promise.resolve(null);
  }
  getFieldObjects() {
    return this.pdfDocument?.getFieldObjects() ?? Promise.resolve(null);
  }
  getPageIndex(ref) {
    return this.pdfDocument.getPageIndex(ref);
  }
  async setOptionalContentVisibility(config) {
    this.pdfViewer.optionalContentConfigPromise = Promise.resolve(config);
  }

  async getPageText(index) {
    const page = await this.pdfDocument.getPage(index + 1);
    const content = await page.getTextContent();
    let out = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      out += item.str;
      if (item.hasEOL) out += '\n';
    }
    return out;
  }

  /**
   * Renders a page to a new canvas.
   * @param {number} index 0-based
   * @param {{ scale?: number, width?: number, annotationMode?: number, forPrint?: boolean, rotation?: number, dpr?: number }} opts
   */
  async renderPage(index, { scale, width, annotationMode = AnnotationMode.ENABLE_FORMS, forPrint = false, rotation, dpr = 1 } = {}) {
    const page = await this.pdfDocument.getPage(index + 1);
    const rot = rotation ?? (page.rotate + this.rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation: rot });
    const s = scale ?? (width ? width / base.width : 1);
    const viewport = page.getViewport({ scale: s, rotation: rot });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width * dpr));
    canvas.height = Math.max(1, Math.ceil(viewport.height * dpr));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const renderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      annotationMode,
      intent: forPrint ? 'print' : 'display',
      printAnnotationStorage: forPrint ? this.pdfDocument.annotationStorage.print : undefined,
      optionalContentConfigPromise: this.pdfViewer.optionalContentConfigPromise ?? undefined,
    });
    await renderTask.promise;
    return canvas;
  }

  // ---- search -------------------------------------------------------------------------------------------

  find({ query, type = '', caseSensitive = false, entireWord = false, highlightAll = true, findPrevious = false, matchDiacritics = false }) {
    this.eventBus.dispatch('find', { source: this, type, query, caseSensitive, entireWord, highlightAll, findPrevious, matchDiacritics });
  }

  clearFind() {
    this.eventBus.dispatch('findbarclose', { source: this });
  }

  // ---- interaction helpers ------------------------------------------------------------------------------

  #setupWheelZoom() {
    this.container.addEventListener(
      'wheel',
      (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        if (!this.pdfDocument) return;
        const delta = event.deltaMode === 1 ? event.deltaY * 20 : event.deltaY;
        this.#wheelAccum = (this.#wheelAccum ?? 0) + delta;
        const steps = Math.trunc(this.#wheelAccum / 40);
        if (steps !== 0) {
          this.#wheelAccum -= steps * 40;
          this.pdfViewer.updateScale({ steps: -steps, origin: [event.clientX, event.clientY], drawingDelay: 60 });
        }
      },
      { passive: false }
    );
  }
  #wheelAccum = 0;

  #setupGrabToPan() {
    const c = this.container;
    let start = null;
    c.addEventListener('pointerdown', (event) => {
      if (!this.handTool || event.button !== 0) return;
      if (event.target.closest('a, input, textarea, select, button, .annotationEditorLayer, [contenteditable="true"]')) return;
      start = { x: event.clientX, y: event.clientY, left: c.scrollLeft, top: c.scrollTop };
      c.classList.add('grabbing');
      c.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    c.addEventListener('pointermove', (event) => {
      if (!start) return;
      c.scrollLeft = start.left - (event.clientX - start.x);
      c.scrollTop = start.top - (event.clientY - start.y);
    });
    const end = () => {
      start = null;
      c.classList.remove('grabbing');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
}
