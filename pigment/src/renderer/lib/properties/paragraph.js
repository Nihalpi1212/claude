// Properties section 'paragraph' of a type layer (type-paragraph-panel, ARCHITECTURE.md "0.4 features", L.1, package
// 4): the Paragraph panel's controls (lib/panels/paragraph.js: alignment, indents, spacing, Hyphenate, lists, and the
// type sections registered for 'paragraph') and a button to the panel. It acts on what the Paragraph panel acts on
// (B.7): the paragraphs of the text being edited, else the selected text layers.
import { createParagraphControls } from '../panels/paragraph.js';
import { typeUnit } from '../type/char-values.js';
import { section } from './ui.js';

// the mounted section (the Properties panel is the only host) and its controls
let last = null;

function render(layer, doc, { app, keep }) {
  const unit = typeUnit(app.settings);
  // the same element while the layer and the unit stay: a field being typed in survives the re-render a change causes
  if (keep(`${layer.id}:${unit}`) && last?.element.isConnected) {
    last.controls.refresh();
    return last.element;
  }
  const element = section('Paragraph');
  element.classList.add('props-paragraph');
  const controls = createParagraphControls(app, { variant: 'properties' });
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

export const paragraphSection = { id: 'paragraph', order: 40, region: 'main', test: (layer) => layer?.type === 'text', render, dispose };
