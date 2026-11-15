import fs from 'node:fs';
export default async function (page, logs) {
  const r = JSON.parse(fs.readFileSync(new URL('./rewrites.json', import.meta.url)));
  const res = await page.evaluate(async (orig) => {
    const app = window.pigmentApp;
    const { readPigment } = await import('/lib/io.js');
    const { flattenDocument } = await import('/lib/compositor.js');
    const out = {};
    for (const [k, bytes] of Object.entries(orig)) {
      const path = `mem:/${k}.pigment`;
      window.__pigmentTest.files[path] = new Uint8Array(bytes);
      const before = app.docs.list?.().length ?? app.docs.docs?.length;
      await app.commands.run('file:open-paths', [path], 'menu');
      await new Promise((res) => setTimeout(res, 500));
      const d = app.doc;
      const ref = await readPigment(new Uint8Array(bytes));
      const a = flattenDocument(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
      const b = flattenDocument(ref).getContext('2d').getImageData(0, 0, ref.width, ref.height).data;
      let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      out[k] = { name: d.name, path: d.path, nDiff: n, notices: d.openNotices ?? null, profile: d.profile, dirty: d.dirty ?? d.isDirty?.() };
    }
    return out;
  }, r.orig);
  console.log(JSON.stringify(res));
}
