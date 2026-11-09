// STUB (0.3): Layer extras (Background from Layer, Group from Layers, Delete Hidden, per-layer export, Link, Select Linked, Rasterize All, Convert to Layers), Find/Isolate/Deselect Layers, Open as Smart Object, Close Others, Purge, File Info, Red Eye / Color Sampler / Ruler / Perspective Crop tools.
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['layer:from-background', 'layer:group-from-layers', 'layer:delete-hidden', 'layer:export-quick', 'layer:export-as', 'layer:link', 'layer:select-linked', 'layer:rasterize-all', 'layer:smart-to-layers', 'select:deselect-layers', 'select:find-layers', 'select:isolate-layers', 'file:open-smart', 'file:close-others', 'edit:purge']);
}
