// Preset files on disk for the main process (ARCHITECTURE.md "0.4 features", C): the five methods behind
// pigment.presets.* (ipc.js channels pigment:presetsRead / Write / ReadBlob / WriteBlob / RemoveBlob). Pure Node (no
// Electron) so it is unit-tested; every argument is validated because the renderer is untrusted.
//
//   <dir>/<kind>.json          the kind's file (':' in a kind becomes '__'), written atomically
//   <dir>/<kind>/<name>        binary side files (pattern pixels)
// A file that does not parse is renamed <file>.corrupt-<time> and read as null (the built-ins only). write(kind, null)
// deletes the kind's file (PresetStore.reset).
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const PRESET_KIND_RE = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/;
export const BLOB_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_FILE = 64 * 1024 * 1024; // a presets file is JSON with small items; blobs carry the pixels
const MAX_BLOB = 256 * 1024 * 1024;

function checkKind(kind) {
  if (typeof kind !== 'string' || !PRESET_KIND_RE.test(kind)) throw new Error(`Invalid preset kind: ${String(kind).slice(0, 64)}`);
  return kind.replace(':', '__');
}

function checkName(name) {
  // '.' and '..' match the pattern but are not file names
  if (typeof name !== 'string' || !BLOB_NAME_RE.test(name) || name === '.' || name === '..') throw new Error(`Invalid preset blob name: ${String(name).slice(0, 64)}`);
  return name;
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('Expected binary data');
}

async function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The preset file methods over a directory (main.js passes <userData>/presets). */
export function presetFiles(dir) {
  // writes of one kind run in order, so a slow write never lands after a later one
  const chains = new Map();
  const serial = (key, fn) => {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    chains.set(key, next);
    return next;
  };
  const fileOf = (kind) => join(dir, `${checkKind(kind)}.json`);
  const blobOf = (kind, name) => join(dir, checkKind(kind), checkName(name));

  return {
    async read(kind) {
      const path = fileOf(kind);
      let text;
      try {
        text = await fs.readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      try {
        const json = JSON.parse(text);
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
        return json;
      } catch {
        // keep the user's file for inspection and start from the built-ins
        await fs.rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
        return null;
      }
    },
    write(kind, json) {
      const path = fileOf(kind);
      if (json === null) return serial(path, () => fs.rm(path, { force: true }));
      if (!json || typeof json !== 'object' || Array.isArray(json)) return Promise.reject(new Error('A presets file must be an object'));
      const text = JSON.stringify(json);
      if (text.length > MAX_FILE) return Promise.reject(new Error('The presets file is too large'));
      return serial(path, async () => {
        await fs.mkdir(dir, { recursive: true });
        await atomicWrite(path, text);
      });
    },
    async readBlob(kind, name) {
      try {
        return new Uint8Array(await fs.readFile(blobOf(kind, name)));
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    },
    writeBlob(kind, name, bytes) {
      const path = blobOf(kind, name);
      const data = toUint8(bytes);
      if (data.byteLength > MAX_BLOB) return Promise.reject(new Error('The preset data is too large'));
      return serial(path, async () => {
        await fs.mkdir(join(dir, checkKind(kind)), { recursive: true });
        await atomicWrite(path, data);
      });
    },
    removeBlob(kind, name) {
      const path = blobOf(kind, name);
      return serial(path, () => fs.rm(path, { force: true }));
    },
  };
}
