export default async function (page, logs) {
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async () => {
    const { fontCatalog } = await import('/lib/type/api.js');
    const fonts = await import('/lib/type/fonts.js');
    const c = fontCatalog();
    await c.ready();
    const fams = c.families();
    const ss = c.family('SourceSans3VF');
    return { real: c.real, n: fams.length, first: fams.slice(0, 5).map((f) => f.name), ss: ss && { styles: ss.styles.map((s) => s.postScriptName), src: ss.source, cls: ss.classification }, loaded: fonts.loadedFaces().map((f) => f.postScriptName), arialKey: c.styleKey({ fontFamily: 'Arial', fontWeight: 700 }), ssKey: c.styleKey({ fontFamily: 'SourceSans3VF', fontWeight: 700 }), ssKey2: c.styleKey({ fontFamily: 'SourceSans3VF', fontWeight: 650 }), patch: c.stylePatch('SourceSans3VF', 'SourceSans3VF-Semibold|wght=650'), stubbed: window.pigmentApp.stubbed.filter((s) => s.startsWith('type:')) };
  });
  console.log(JSON.stringify(r, null, 1));
}
