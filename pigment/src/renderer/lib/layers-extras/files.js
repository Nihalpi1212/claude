// File › Open as Smart Object, File › Close Others and Edit › Purge.
import { bridge } from '../bridge.js';
import { Document } from '../document.js';
import { flattenDocument } from '../compositor.js';
import { openDocument, decodeImageFile, baseName, extOf, OPEN_FILTERS } from '../io.js';
import { SmartLayer, makeSource, attachHost } from '../smart-object.js';

const PURGE_TARGETS = { undo: 'the undo history of this document', clipboard: 'the clipboard', histories: 'the undo histories of all open documents', all: 'the clipboard and the undo histories of all open documents' };

export function installFiles(app) {
  /** A smart-object source from a file: layered documents stay documents, images stay images. */
  async function sourceFromFile(path) {
    if (window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
    const bytes = await bridge.readFile(path);
    const name = path.split(/[\\/]/).pop();
    if (['pigment', 'psd', 'psb'].includes(extOf(path))) {
      const d = await openDocument(bytes, { name, path: null });
      return { source: makeSource({ kind: 'document', doc: d, name: baseName(path) }), width: d.width, height: d.height, dpi: d.dpi };
    }
    const canvas = await decodeImageFile(bytes, path);
    return { source: makeSource({ kind: 'image', canvas, name: baseName(path) }), width: canvas.width, height: canvas.height, dpi: 72 };
  }

  /**
   * arg: nothing (file dialog), a path, paths, or { paths, into: 'new' | 'active' }. Like Photoshop each file opens
   * as its own document holding one smart object; `into: 'active'` places the files into the active document.
   */
  async function openSmart(arg, ctx = null) {
    let paths = typeof arg === 'string' ? [arg] : Array.isArray(arg) ? arg : Array.isArray(arg?.paths) ? arg.paths : null;
    const into = arg?.into === 'active' && app.doc ? 'active' : 'new';
    if (!paths?.length) {
      paths = await bridge.openFileDialog({ multiple: true, filters: OPEN_FILTERS, title: 'Open as Smart Object' });
      if (!paths?.length) return ctx?.cancel();
    }
    ctx?.setReplayArg({ paths: paths.slice(), into }); // actions (lib/actions.js): the chosen files replay the command
    let last = null;
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop();
      try {
        if (into === 'active') {
          await app.commands.run('file:place', path, 'api'); // lib/smart-object.js places files as smart objects
          last = app.doc;
          continue;
        }
        const { source, width, height, dpi } = await app.busy(`Opening ${name}…`, () => sourceFromFile(path));
        const d = new Document({ width, height, dpi, name: baseName(path) });
        const layer = new SmartLayer({ name: baseName(path), source });
        d.root.children.push(layer);
        layer.parent = d.root;
        d.active = layer;
        d.selected.add(layer);
        attachHost(layer, d);
        app.docs.add(d);
        // a new, unsaved document: nothing to lose yet, so closing it right away asks nothing
        d.history.markSaved(flattenDocument(d, d.view.compositor));
        last = d;
      } catch (err) {
        app.reportError(err, `Could not open "${name}" as a smart object`);
      }
    }
    return last;
  }

  async function closeOthers() {
    const keep = app.doc;
    if (!keep) return false;
    for (const d of app.docs.docs.slice()) {
      if (d === keep) continue;
      // unsaved documents ask, one after the other; Cancel stops the whole command
      if (!(await app.docs.close(d))) {
        app.docs.activate(keep);
        return false;
      }
    }
    if (app.docs.docs.includes(keep)) app.docs.activate(keep);
    return true;
  }

  /** Drops every undo/redo step of a document and keeps its current state (and whether it has unsaved changes). */
  function purgeHistory(d) {
    const h = d?.history;
    if (!h || (!h.entries.length && !h.stroke)) return 0;
    const dirty = h.dirty;
    const n = h.entries.length;
    h.stroke = null;
    h.clear();
    if (dirty) h.savedIndex = -2; // the saved state is not reachable any more: the document stays "edited"
    h.onChange();
    d.changed('history');
    return n;
  }

  /** arg: 'undo' | 'clipboard' | 'histories' | 'all', or { what, confirm: false } to skip the question. */
  async function purge(arg, ctx = null) {
    const what = typeof arg === 'string' ? arg : arg?.what;
    if (!PURGE_TARGETS[what]) return ctx?.cancel();
    if ((what === 'undo' || what === 'histories') && !app.doc) return ctx?.cancel();
    app.tools?.active?.commit?.();
    // also when an action runs it: Purge is never recorded (actions/model.js), so no action has a say in this
    if (arg?.confirm !== false) {
      const ok = await app.dialogs.confirm(`Purge ${PURGE_TARGETS[what]}?`, { title: 'Purge', detail: 'This frees memory and cannot be undone.', okLabel: 'Purge', danger: true });
      if (!ok) return ctx?.cancel();
    }
    ctx?.setReplayArg({ what, confirm: false });
    let steps = 0;
    if (what === 'undo') steps = purgeHistory(app.doc);
    if (what === 'histories' || what === 'all') for (const d of app.docs.docs) steps += purgeHistory(d);
    const hadClipboard = !!app.clipboard;
    if (what === 'clipboard' || what === 'all') app.clipboard = null;
    app.commands.invalidate();
    app.syncUiState();
    const parts = [];
    if (what !== 'clipboard') parts.push(`${steps} history step${steps === 1 ? '' : 's'}`);
    if (what === 'clipboard' || what === 'all') parts.push(hadClipboard ? 'the clipboard' : 'an empty clipboard');
    app.dialogs.toast(`Purged ${parts.join(' and ')}`, { timeout: 1800 });
    return { steps, clipboard: (what === 'clipboard' || what === 'all') && hadClipboard };
  }

  app.commands.registerAll({
    'file:open-smart': { run: openSmart, label: 'Open as Smart Object…', dialog: true },
    'file:close-others': { enabled: () => (app.docs?.docs.length ?? 0) > 1, run: closeOthers, label: 'Close Others' },
    'edit:purge': { run: purge, label: 'Purge', dialog: true },
  });
}
