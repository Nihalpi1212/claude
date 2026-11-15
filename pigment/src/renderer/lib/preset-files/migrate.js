// Migrate Presets from an older Pigment's presets folder (preset-files-manager). The preset store keeps each kind as
// <folder>/<kind>.json (':' in a kind written '__') and its side files in <folder>/<kind>/ (src/main/preset-files.js,
// the IndexedDB store of the browser build mirrors it); this reads such a folder (or a settings folder holding one
// named `presets`) into a .pigment-bundle, which the bundle format then imports like any other: the user's presets and
// the built-ins they changed, never one the library already holds. Node-safe: the file access is the bridge passed in.
import { writeBundle } from './bundle.js';
import { FILE_FORMAT, BLOB_NAME_RE } from '../presets.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const join = (dir, name) => `${String(dir).replace(/[\\/]+$/, '')}/${name}`;
const fileKind = (kind) => kind.replace(':', '__');

/**
 * The bundle of a presets folder: { bytes, report, found } (found: how many kinds had a file). `bridge` gives readFile
 * and listDir; `kinds` are the kinds to look for.
 */
export async function folderBundle(bridge, dir, kinds) {
  const report = [];
  let root = dir;
  let listed = null; // the names in the folder, when it can be listed (only those kind files are read)
  try {
    const entries = await bridge.listDir(dir);
    const kindFiles = new Set(kinds.map((k) => `${fileKind(k)}.json`));
    // a settings folder: its `presets` folder
    if (!entries.some((e) => kindFiles.has(e.name)) && entries.some((e) => e.isDir && e.name === 'presets')) {
      root = join(dir, 'presets');
      listed = new Set((await bridge.listDir(root)).map((e) => e.name));
    } else listed = new Set(entries.map((e) => e.name));
  } catch {
    listed = null; // listing is a convenience: without it the files are read by name
  }
  const files = new Map();
  for (const kind of kinds) {
    let json = null;
    if (listed && !listed.has(`${fileKind(kind)}.json`)) continue;
    try {
      const bytes = await bridge.readFile(join(root, `${fileKind(kind)}.json`));
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    if (!isObject(json) || json.format !== FILE_FORMAT || !Array.isArray(json.items)) {
      report.push(`${fileKind(kind)}.json is not a Pigment presets file and was skipped`);
      continue;
    }
    files.set(kind, json);
  }
  const source = {
    list: (kind) => (files.get(kind)?.items ?? []).filter((it) => isObject(it) && typeof it.id === 'string' && it.data !== undefined).map((it) => ({ ...it, modified: !!it.builtin })),
    groups: (kind) => (files.get(kind)?.groups ?? []).filter((g) => isObject(g) && typeof g.id === 'string' && !g.hidden).map((g) => ({ id: g.id, name: String(g.name ?? 'Group'), parent: g.parent ?? null, builtin: !!g.builtin })),
    readBlob: async (kind, name) => {
      if (!BLOB_NAME_RE.test(name)) return null;
      try {
        return await bridge.readFile(join(join(root, fileKind(kind)), name));
      } catch {
        report.push(`the side file ${fileKind(kind)}/${name} is missing`);
        return null;
      }
    },
  };
  const bytes = await writeBundle(source, { kinds: [...files.keys()] });
  return { bytes, report, found: files.size };
}
