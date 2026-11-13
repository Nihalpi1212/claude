// Properties section 'text' of a type layer: a summary and the Edit Text / Character buttons (ARCHITECTURE.md
// "0.4 features", L.1). Moved out of panels/properties.js by the 0.4 skeleton, unchanged in output; owned by
// type-character-panel afterwards (the editable text section, with the type sections of lib/type/sections.js).
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { h, button, section, row, cssPaint } from './ui.js';

function render(layer, doc, { app }) {
  const s = section('Text');
  const f = layer.font ?? {};
  const preview = h('div', 'props-text-preview', (layer.text ?? '').slice(0, 200) || '(empty)');
  s.appendChild(preview);
  s.appendChild(row('Font', h('span', 'props-value', `${f.family ?? ''} ${f.weight && f.weight !== 400 ? f.weight : ''}${f.italic ? ' italic' : ''}`.trim())));
  s.appendChild(row('Size', h('span', 'props-value', `${Math.round((f.size ?? 0) * 10) / 10} px`)));
  const sw = h('span', 'props-chip static');
  sw.style.background = cssPaint(f.color ?? '#000');
  s.appendChild(row('Color', [sw, h('span', 'props-value mono', rgbaToHex(parseColor(f.color ?? '#000')))]));
  const acts = h('div', 'props-actions');
  if (app.commands.has('layer:edit-text')) acts.appendChild(button('Edit Text', 'text', 'Edit the text on the canvas', () => app.commands.run('layer:edit-text', layer.id, 'panel')));
  if (app.panels.panels?.has?.('character')) acts.appendChild(button('Character…', 'character', 'Show the Character panel', () => app.panels.show('character', { reveal: true })));
  if (acts.childNodes.length) s.appendChild(acts);
  return s;
}

export const textSection = { id: 'text', order: 30, region: 'main', test: (layer) => layer?.type === 'text', render };
