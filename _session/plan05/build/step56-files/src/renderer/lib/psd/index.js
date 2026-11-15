// The PSD mapper modules (ARCHITECTURE.md "0.5 features", S4.1), skeleton file; a MODULES entry in app.js. Importing
// it loads the registry, the built-ins and every mapper file, so each registers what it maps (lib/io.js imports it too,
// so Node tests that import io.js get every mapper). Later skeletons add one import line per new mapper file
// (reserved: resources.js, channels.js, deep.js, modes.js and smart-filters.js 0.6, smart-objects.js 0.7, comps.js
// 0.8, artboards.js and annotations.js 0.9, slices.js 0.10).
//
// install(app) runs each mapper file's optional `install(app)` (psd-layers' save option and Preferences section, for
// example), in this order.
import './registry.js';
import './builtin.js';
import * as adjustments from './adjustments.js';
import * as effects from './effects.js';
import * as vector from './vector.js';
import * as tags from './tags.js';
import * as text from './text.js';

const MAPPERS = [adjustments, effects, vector, tags, text];

export function install(app) {
  for (const m of MAPPERS) {
    if (typeof m.install !== 'function') continue;
    try {
      m.install(app);
    } catch (err) {
      console.error('PSD mapper install failed', err);
    }
  }
}
