import { readFileSync } from 'node:fs';
import { pagePsdGolden, PSD_GOLDEN_DOCS } from '/home/user/claude/pigment/tests/e2e/goldens.mjs';
export default async function (page) {
  for (const id of PSD_GOLDEN_DOCS) {
    const json = await page.evaluate(pagePsdGolden, id);
    const want = readFileSync(`/home/user/claude/pigment/tests/fixtures/psd-golden/${id}.json`, 'utf8').trimEnd();
    if (json === want) { console.log(id, 'SAME'); continue; }
    // first difference
    let i = 0; while (i < json.length && json[i] === want[i]) i++;
    console.log(id, 'DIFF at', i, '\n got:', json.slice(Math.max(0, i - 150), i + 250), '\n want:', want.slice(Math.max(0, i - 150), i + 250));
  }
}
