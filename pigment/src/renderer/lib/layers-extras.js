// Layer, Select and File extras (see ARCHITECTURE.md "Layer, Select and File extras"):
//   Layer   Background from Layer / Layer from Background, Group from Layers, Delete Hidden Layers,
//           Quick Export as PNG / Export As for the selected layers, Link Layers / Select Linked
//           Layers, Rasterize All Layers, Smart Objects › Convert to Layers, colour labels
//   Select  Deselect Layers, Find Layers (the filter bar of the Layers panel), Isolate Layers
//   File    Open as Smart Object, Close Others
//   Edit    Purge
//   Tools   Perspective Crop (crop slot)
// The pieces live in lib/layers-extras/*.js and lib/tools/perspective-crop.js; File Info is the
// properties() dialog of lib/file-ops.js (helpers in lib/file-info.js).
//
// Hooks this module owns in files of other modules (one commented line each):
//   lib/panels/layers.js render()   app.layerFilter(layer) -> false hides a row
//   lib/panels/layers.js row()      app.decorateLayerRow(li, layer) (label tint, link badge)
//   lib/tools/move.js layersToMove  app.linkedLayers(layers) -> the layers that move together
import { installTags } from './layers-extras/tags.js';
import { installFind } from './layers-extras/find.js';
import { installExport } from './layers-extras/export.js';
import { installStructure } from './layers-extras/structure.js';
import { installFiles } from './layers-extras/files.js';
import { installPerspectiveCrop } from './tools/perspective-crop.js';
import { installFileInfo } from './file-info.js';

export function install(app) {
  // the stylesheet is loaded from here: index.html is not this module's to edit
  if (!document.querySelector('link[data-layers-extras]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../styles/layers-extras.css', import.meta.url).href;
    link.dataset.layersExtras = 'true';
    document.head.appendChild(link);
  }
  installTags(app);
  app.layersExtras = { find: installFind(app) };
  installExport(app);
  installStructure(app);
  installFiles(app);
  installPerspectiveCrop(app);
  installFileInfo(app);
}
