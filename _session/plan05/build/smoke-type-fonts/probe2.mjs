import { readFileSync } from 'node:fs';
import { fontInfo } from '/home/user/claude/pigment/src/renderer/lib/type/font-tables.js';
for (const f of process.argv.slice(2)) { const i = fontInfo(new Uint8Array(readFileSync(f))); console.log(f.split('/').pop(), JSON.stringify({ ...i, instances: i.instances.map(x=>[x.name,x.postScriptName,x.weight,x.italic].join(':')) })); }
