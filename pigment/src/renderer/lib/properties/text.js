// Properties section 'text' of a type layer (type-character-panel, ARCHITECTURE.md "0.4 features", L.1, package 3):
// the editable character controls of the Character panel (lib/type/char-format.js) with the type options
// (orientation, anti-aliasing, the text box), Edit Text and a button to the Character panel. Transform stays the
// skeleton's section; the paragraph controls are type-paragraph-panel's 'paragraph' section. It acts on what the
// Character panel acts on (B.7): the text being edited, else the selected text layers.
import { createCharacterControls } from '../type/char-format.js';
import { typeUnit } from '../type/char-values.js';
import { section } from './ui.js';

// the mounted section (the Properties panel is the only host) and its controls
let last = null;

function render(layer, doc, { app, keep }) {
  const unit = typeUnit(app.settings);
  // the same element while the layer and the unit stay: an open select, or a drag on a scrubby label, survives the
  // re-render that every change causes
  if (keep(`${layer.id}:${unit}`) && last?.element.isConnected) {
    last.controls.refresh();
    return last.element;
  }
  const element = section('Character');
  element.classList.add('props-text');
  const controls = createCharacterControls(app, { variant: 'properties' });
  element.appendChild(controls.element);
  controls.refresh();
  last = { element, controls };
  return element;
}

function dispose(element) {
  if (last?.element !== element) return;
  last.controls.destroy();
  last = null;
}

export const textSection = { id: 'text', order: 30, region: 'main', test: (layer) => layer?.type === 'text', render, dispose };
