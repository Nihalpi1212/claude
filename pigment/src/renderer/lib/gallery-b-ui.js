// Renderer side of gallery-b (src/shared/pixels/gallery-sketch.js): custom openers for the kinds
// whose parameters are not plain dialog fields.
// - Sketch kinds (and Stained Glass's leading) paint with the current foreground / background
//   colours: lib/filter-ui.js paramsFor() does not know about `colors`, so the opener injects
//   app.settings.foreground / background before opening the standard field dialog. The params it
//   resolves with carry the colours used, so Last Filter, actions and smart filters reproduce them.
// - Texturizer, Conté Crayon and Glass offer "Load Texture…": a .pigment / .psd / .png (any format
//   lib/io.js opens) flattened to an ImageDataLike becomes params.textureImage, which replaces the
//   procedural texture. The typed array stays in memory for the session (and for smart filters), but
//   it is dropped from JSON (settings, Last Filter, actions), where params.textureFile keeps the path
//   so the next dialog reloads it; a direct re-run without the dialog falls back to the procedural
//   texture (a loaded texture needs the file).
// Both reuse pixelEditDialog with app.filterEditor.editor(kind), so previews, the selection limit,
// history (one entry) and the actions recorder behave exactly like the other filter dialogs. The
// kinds carry `ui: 'custom'` in the registry so lib/filter-ui.js routes them here.
import { FILTERS, applyFilter } from '../../shared/pixels/filters.js';
import { COLOR_KINDS, TEXTURE_FILE_KINDS } from '../../shared/pixels/gallery-sketch.js';
import { bridge } from './bridge.js';
import { pixelEditDialog } from './adjust-ui.js';
import { flattenDocument } from './compositor.js';
import { openDocument } from './io.js';

/** An ImageDataLike for params.textureImage; JSON serialisation drops the pixels (see the header). */
function textureImageFrom(canvas, label) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const img = { width: id.width, height: id.height, data: id.data, label };
  Object.defineProperty(img, 'toJSON', { value: () => null, enumerable: false });
  return img;
}

/** Kinds whose dialog offers "Load Texture…": the Texture/Sketch/Distort ones plus the two Artistic kinds that light a texture. */
const FILE_KINDS = [...TEXTURE_FILE_KINDS, 'rough-pastels', 'underpainting'];

export function install(app) {
  if (!app.filterEditor?.register) return; // filter-ui.js installs first (app.js MODULES order)

  /** Opens an image file as a texture: { image, path } or null when the dialog was dismissed. */
  async function loadTextureFile(path = null) {
    if (!path) {
      const paths = await bridge.openFileDialog({ multiple: false, title: 'Load Texture' });
      path = Array.isArray(paths) ? paths[0] : paths;
    }
    if (!path) return null;
    const name = path.split(/[\\/]/).pop();
    const bytes = await bridge.readFile(path);
    const d = await app.busy(`Opening ${name}…`, () => openDocument(bytes, { name, path }));
    return { image: textureImageFrom(flattenDocument(d), name), path };
  }

  async function open(kind, { params, def }) {
    const doc = app.doc;
    if (!doc) return null;
    const start = { ...params };
    // Photoshop always paints with the colours current when the dialog opens
    if (COLOR_KINDS.includes(kind)) {
      if (kind === 'stained-glass') start.borderColor = app.settings.foreground;
      else start.colors = [app.settings.foreground, app.settings.background];
    }
    const withFile = FILE_KINDS.includes(kind);
    let textureImage = withFile && start.textureImage?.data ? start.textureImage : null;
    if (withFile && !textureImage && typeof start.textureFile === 'string' && start.textureFile) {
      // the previous session's texture came from a file: reload it quietly (a missing file means the procedural texture)
      try {
        textureImage = (await loadTextureFile(start.textureFile))?.image ?? null;
      } catch {
        textureImage = null;
      }
    }
    if (!withFile) {
      // nothing to do: the colours above are the only injection these kinds need
    } else if (!textureImage) {
      delete start.textureFile;
      start.textureImage = null;
      if (start.texture === 'file') start.texture = def.defaults.texture;
    } else {
      start.textureImage = textureImage;
      start.texture = 'file';
    }
    let current = start;
    const used = await pixelEditDialog(app, {
      title: def.name,
      params: current,
      margin: app.filterEditor.marginFor(kind, current),
      width: 440,
      editor: (onChange) => {
        let describe = () => {}; // set below for the texture-file kinds (refreshes the note and the select)
        const ed = app.filterEditor.editor(kind, current, (p) => {
          // the field editor hands out JSON clones, which drop the texture image: put it back unless
          // the user went back to a procedural texture
          const had = !!textureImage;
          if (withFile && p.texture !== 'file') textureImage = null;
          current = { ...p, textureImage, textureFile: textureImage ? current.textureFile : undefined };
          if (!textureImage) delete current.textureFile;
          if (had && !textureImage) describe();
          onChange(current);
        });
        if (!withFile) return ed;
        const wrap = document.createElement('div');
        wrap.appendChild(ed.element);
        const select = ed.element.querySelector('select[data-key="texture"]');
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-top: 8px';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn small';
        button.dataset.key = '__load-texture';
        button.textContent = 'Load Texture…';
        const note = document.createElement('span');
        note.className = 'muted';
        note.style.fontSize = '11px';
        note.dataset.key = '__texture-note';
        row.append(button, note);
        wrap.appendChild(row);
        const fileOption = () => {
          let o = select?.querySelector('option[value="file"]');
          if (!o && select) {
            o = document.createElement('option');
            o.value = 'file';
            select.appendChild(o);
          }
          return o;
        };
        describe = () => {
          if (textureImage) {
            const o = fileOption();
            if (o) o.textContent = `File: ${textureImage.label}`;
            if (select) select.value = 'file';
            note.textContent = `${textureImage.label} (${textureImage.width} × ${textureImage.height}, tiled)`;
          } else {
            select?.querySelector('option[value="file"]')?.remove();
            note.textContent = 'Or pick a texture above';
          }
        };
        button.addEventListener('click', async () => {
          try {
            const loaded = await loadTextureFile();
            if (!loaded) return;
            textureImage = loaded.image;
            current = { ...current, texture: 'file', textureImage, textureFile: loaded.path };
            describe();
            // a real change event moves the form's own value to 'file', so later slider edits keep the image
            if (select) select.dispatchEvent(new Event('change'));
            else onChange(current);
          } catch (err) {
            app.reportError(err, 'Could not load the texture');
          }
        });
        describe();
        return { element: wrap };
      },
      run: (img, p) => applyFilter(img, kind, p),
      // meta keeps the live texture image (lib/depth.js re-runs the filter on deep pixels from it)
      meta: (p) => ({ filter: { kind, params: p } }),
    });
    return used;
  }

  for (const kind of new Set([...COLOR_KINDS, ...FILE_KINDS])) {
    if (FILTERS[kind]?.ui === 'custom') app.filterEditor.register(kind, { open });
  }
}
