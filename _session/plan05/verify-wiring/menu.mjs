import { buildMenuTemplate, menuItemCommands } from '/home/user/claude/pigment/src/shared/menu-template.js';
const pr = (list, ind='') => { for (const it of list) { if (it.type==='separator') { console.log(ind+'---'); continue; } console.log(ind + (it.label??it.role) + (it.accelerator? '  ['+it.accelerator+']':'') + (it.enabled===false?' (off)':'') + (it.pigmentColor? ' {'+it.pigmentColor+'}':'')); if (Array.isArray(it.submenu) && process.argv[3]!=='flat') pr(it.submenu, ind+'  '); } };
const platform = process.argv[2] || 'linux';
const t = buildMenuTemplate({ platform, state: { hasDocument: true, hasLayer: true, layerType: 'text', stubs: 'edit:menus,type:warp-text' , menus: JSON.stringify({hidden:['type:add-fonts','menu:Edit>Purge'], colors:{'type:warp-text':'red','menu:Type>Anti-Alias':'blue'}, showAll:false}) }, recent: [], run: ()=>{}, isPackaged: false });
const pick = process.argv[4] ? process.argv[4].split(',') : null;
pr(t.filter(m => !pick || pick.some(p => (m.label||'').replace('&','').startsWith(p))));
