const D = await import('/home/user/claude/pigment/src/shared/pixels/develop.js');
const OLD = await import(new URL('./v04/pigment/src/shared/pixels/develop.js', import.meta.url).href);
let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const ranges = { temperature: [-100, 100], tint: [-100, 100], exposure: [-5, 5], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], whites: [-100, 100], blacks: [-100, 100], texture: [-100, 100], clarity: [-100, 100], dehaze: [-100, 100], vibrance: [-100, 100], saturation: [-100, 100], vignette: [-100, 100], grain: [0, 100] };
const RANGES = ['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'];
let fails = 0, runs = 0;
for (let k = 0; k < 120; k++) {
  const p = {};
  for (const [key, [lo, hi]] of Object.entries(ranges)) if (rnd() < 0.35) p[key] = Math.round(lo + rnd() * (hi - lo));
  if (rnd() < 0.3) { p.hsl = {}; for (const r of RANGES) if (rnd() < 0.3) p.hsl[r] = { hue: Math.round(rnd() * 200 - 100), saturation: Math.round(rnd() * 200 - 100), luminance: Math.round(rnd() * 200 - 100) }; }
  if (rnd() < 0.25) p.sharpen = { amount: Math.round(rnd() * 150), radius: 0.5 + rnd() * 2.5, detail: Math.round(rnd() * 100) };
  if (rnd() < 0.25) p.noise = { luminance: Math.round(rnd() * 100), color: Math.round(rnd() * 100) };
  if (rnd() < 0.3) p.seed = Math.floor(rnd() * 100);
  const w = 8 + Math.floor(rnd() * 40), h = 8 + Math.floor(rnd() * 30);
  const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < data.length; i++) data[i] = (i % 4 === 3) ? (rnd() < 0.1 ? 0 : rnd() < 0.3 ? rnd() * 255 : 255) : rnd() * 256;
  const rect = rnd() < 0.5 ? { x: Math.floor(rnd() * 4), y: Math.floor(rnd() * 4), width: w - 5, height: h - 5 } : null;
  const a = { width: w, height: h, data: new Uint8ClampedArray(data) }, b = { width: w, height: h, data: new Uint8ClampedArray(data) };
  D.develop(a, p, rect); OLD.develop(b, p, rect); runs++;
  let diff = 0; for (let i = 0; i < data.length; i++) if (a.data[i] !== b.data[i]) diff++;
  if (diff) { fails++; if (fails < 4) console.log('DIFF', diff, JSON.stringify(p), rect); }
}
console.log('random combos', runs, 'fails', fails);
for (const name of Object.keys(OLD)) if (!(name in D)) console.log('0.4 export missing in 0.5 develop.js:', name);
console.log('defaults equal (minus treatment):', JSON.stringify(OLD.DEVELOP_DEFAULTS) === JSON.stringify(D.DEVELOP_DEFAULTS), JSON.stringify(Object.keys(D.developDefaults())));
const np = D.normalizeParams({ exposure: 1 }); const op = OLD.normalizeParams({ exposure: 1 });
console.log('normalizeParams same?', JSON.stringify(np) === JSON.stringify(op), Object.keys(np).filter(k => !(k in op)));
console.log('isNeutral same for defaults / small', D.isNeutral(OLD.DEVELOP_DEFAULTS) === OLD.isNeutral(OLD.DEVELOP_DEFAULTS), D.isNeutral({ grain: -5 }), OLD.isNeutral({ grain: -5 }));
console.log('stages', (await import('/home/user/claude/pigment/src/shared/pixels/develop-stages.js')).developStages().map(s => `${s.id}:${s.space}:${s.order}:${(s.params?.keys ?? []).join('|')}`).join('\n'));
