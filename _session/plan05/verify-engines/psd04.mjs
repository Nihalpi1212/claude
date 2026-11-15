import { chromium } from '/home/user/claude/pigment/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PSD_GOLDEN_DOCS, pagePsdGolden } from '/home/user/claude/pigment/tests/e2e/goldens.mjs';
const root = process.argv[2];
const port = Number(process.argv[3]);
const srv = spawn('node', [`${root}/tests/e2e/server.mjs`, String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const logs = [];
page.on('pageerror', (e) => logs.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForSelector('body[data-ready]', { timeout: 15000 });
for (const id of PSD_GOLDEN_DOCS) {
  const json = await page.evaluate(pagePsdGolden, id);
  const g = readFileSync(`/home/user/claude/pigment/tests/fixtures/psd-golden/${id}.json`, 'utf8').trim();
  console.log(id, json === g ? 'EQUAL' : `DIFF (${json.length} vs ${g.length})`);
}
console.log(logs.join('\n') || 'no page errors');
await browser.close(); srv.kill();
