const a = await import(process.argv[2] + '/src/shared/keymap.js');
const b = await import('/home/user/claude/pigment/src/shared/keymap.js');
for (const t of ['MENU_KEYS', 'RENDERER_KEYS', 'TYPE_KEYS']) {
  const A = a[t], B = b[t];
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) console.log(t, k, JSON.stringify(A[k]), '->', JSON.stringify(B[k]));
}
for (const k of Object.keys(a.COMMAND_LABELS)) if (a.COMMAND_LABELS[k] !== b.COMMAND_LABELS[k]) console.log('label', k, a.COMMAND_LABELS[k], b.COMMAND_LABELS[k]);
const ga = a.SHORTCUT_GROUPS.flatMap((g) => g.commands), gb = new Set(b.SHORTCUT_GROUPS.flatMap((g) => g.commands));
console.log('dropped from groups', ga.filter((c) => !gb.has(c)));
// 0.4 menu accelerators vs 0.5 per item
const ma = await import(process.argv[2] + '/src/shared/menu-template.js');
const mb = await import('/home/user/claude/pigment/src/shared/menu-template.js');
for (const platform of ['darwin', 'win32']) {
  const acc = (m) => { const out = new Map(); const walk = (l, p) => { for (const it of l) { if (Array.isArray(it.submenu)) walk(it.submenu, [...p, it.label]); else if (it.label) out.set([...p, it.label].join(' > '), it.accelerator ?? null); } }; walk(m.buildMenuTemplate({ platform, state: { hasDocument: true, hasLayer: true, layerType: 'text' }, recent: [], run: () => {}, isPackaged: false }), []); return out; };
  const A = acc(ma), B = acc(mb);
  for (const [k, v] of A) if (!B.has(k)) console.log(platform, 'item gone', k); else if (B.get(k) !== v) console.log(platform, 'accel', k, v, '->', B.get(k));
}
