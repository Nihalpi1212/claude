// The profiles Pigment knows beyond its built-ins (icc-engine, ARCHITECTURE.md "0.5 features", package 4; S6.1,
// S6.6, S10.5): the user's own ICC files, kept in the `color-profiles` preset kind (a record { name, colorSpace,
// blob: 'icc-<sha1>.icc' } and the bytes as its blob, so the browser build has them too and the Preset Manager can
// export them), the operating system's profile folders (bridge.listColorProfiles, Electron), and every profile a
// document brought with it, so a recorded Assign Profile and profileById find it again.
import { profileRecord } from './profiles.js';
import { forgetTransforms } from './transforms.js';
import { forgetProfile } from './lcms.js';

const KIND = 'color-profiles';
const MAX_SYSTEM = 300; // a folder of hundreds of printer profiles is not read whole on start-up
const MAX_BYTES = 8 << 20;

export class ProfileLibrary {
  constructor(app, builtins = []) {
    this.app = app;
    // the list engine.profiles() resolves to (the built-ins, then the user's and the system's profiles); it stays the
    // same array, so the pipeline's cached profilesList() sees profiles added later (S6.5: "OS profiles cached after
    // the first profiles()")
    this.list = [...builtins];
    this.byId = new Map(builtins.map((p) => [p.id, p])); // every profile seen: built-in, user, system, embedded
    this.loading = null;
  }

  /** Records a profile (an embedded one a document adopted) so profileById finds it. */
  remember(p) {
    if (p?.id && !this.byId.has(p.id)) this.byId.set(p.id, p);
    return this.byId.get(p?.id) ?? p;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  #push(p) {
    if (!p || this.list.some((q) => q.id === p.id)) return;
    this.list.push(p);
    this.byId.set(p.id, p);
  }

  /** Loads the user and system profiles once; resolves to the live list. */
  load() {
    if (!this.loading) {
      this.loading = (async () => {
        await this.loadUser();
        await this.loadSystem();
        return this.list;
      })().catch(() => this.list);
    }
    return this.loading;
  }

  async loadUser() {
    const presets = this.app?.presets;
    if (!presets) return;
    try {
      await presets.ready(KIND);
    } catch {
      return;
    }
    for (const p of presets.list(KIND)) {
      try {
        const bytes = await presets.readBlob(KIND, p.data.blob);
        const rec = bytes ? profileRecord(bytes, 'user', { name: p.name }) : null;
        if (rec) this.#push({ ...rec, name: p.name || rec.name, presetId: p.id });
      } catch {}
    }
  }

  async loadSystem() {
    let entries = [];
    let bridge = null;
    try {
      ({ bridge } = await import('../bridge.js')); // imported here: the rest of this file runs in Node tests
      entries = (await bridge.listColorProfiles?.()) ?? [];
    } catch {
      return;
    }
    for (const e of entries.slice(0, MAX_SYSTEM)) {
      try {
        const bytes = e.bytes ?? (await bridge.readFile(e.path));
        if (!bytes || bytes.length > MAX_BYTES) continue;
        const rec = profileRecord(bytes, 'system', { name: e.name });
        if (rec) this.#push({ ...rec, path: e.path });
      } catch {}
    }
  }

  /** The user's profiles (the `color-profiles` kind), in the library's order. */
  userProfiles() {
    return this.list.filter((p) => p.source === 'user');
  }

  /**
   * Adds an ICC file to the user's profiles. Resolves to the profile, or throws with a sentence for the user (not a
   * profile, a space Pigment cannot use, already there).
   */
  async addUserProfile(bytes, fileName = '') {
    const rec = profileRecord(bytes, 'user', { name: fileName.replace(/\.(icc|icm)$/i, '') });
    if (!rec) throw new Error(`${fileName || 'The file'} is not an ICC colour profile.`);
    if (!['rgb', 'gray', 'cmyk', 'lab'].includes(rec.colorSpace)) throw new Error(`“${rec.name}” is a profile of a colour space Pigment does not use.`);
    const existing = this.list.find((p) => p.id === rec.id && p.source === 'user');
    if (existing) return existing;
    const presets = this.app.presets;
    await presets.ready(KIND);
    const blob = `icc-${rec.id}.icc`;
    await presets.writeBlob(KIND, blob, rec.bytes);
    const preset = presets.add(KIND, { name: rec.name, data: { name: rec.name, colorSpace: rec.colorSpace, blob } });
    const p = { ...rec, presetId: preset.id };
    // a system profile with the same bytes gives way to the user's own copy
    const at = this.list.findIndex((q) => q.id === rec.id);
    if (at >= 0) this.list.splice(at, 1);
    this.list.push(p);
    this.byId.set(p.id, p);
    this.app.emit?.('color:profiles-changed');
    return p;
  }

  /** Removes one of the user's profiles (documents tagged with it keep it: their bytes are their own). */
  removeUserProfile(id) {
    const p = this.list.find((q) => q.id === id && q.source === 'user');
    if (!p) return false;
    try {
      if (p.presetId) this.app.presets.remove(KIND, [p.presetId]);
    } catch {}
    this.list.splice(this.list.indexOf(p), 1);
    forgetTransforms(id);
    forgetProfile(id);
    this.app.emit?.('color:profiles-changed');
    return true;
  }
}
