import { chromium } from '/home/user/claude/pigment/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
const port = Number(process.env.PORT || 8791);
const srv = spawn('node', ['/home/user/claude/pigment/tests/e2e/server.mjs', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' in {} ? undefined : undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForSelector('body[data-ready]', { timeout: 15000 }).catch(() => logs.push('NOT READY'));
const script = process.argv[2];
if (script) {
  const fn = (await import(script)).default;
  await fn(page, logs);
}
await page.screenshot({ path: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-brush-engine-core/smoke.png' });
console.log(logs.join('\n') || 'no errors');
await browser.close();
srv.kill();
