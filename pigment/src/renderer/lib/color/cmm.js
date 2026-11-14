// icc-engine's MODULES entry (ARCHITECTURE.md "0.5 features", package 4). Until the package lands this is the
// skeleton's stub (S15): Edit > Assign Profile… is a disabled stub and the colour pipeline (lib/color/pipeline.js)
// keeps its sRGB engine, so colorEngine().available is false. The package replaces this file at the same path and
// registers the LittleCMS engine with setColorEngine from install() (S6.1).
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, ['edit:assign-profile']);
}
