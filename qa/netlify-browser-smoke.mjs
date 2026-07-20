import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('qa-public');
await mkdir(OUT, { recursive: true });
const report = { launched: false, navigated: false, status: null, title: null, canvas: false, error: null };
try {
  const browser = await chromium.launch({ headless: true });
  report.launched = true;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const response = await page.goto('https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/?qa', { waitUntil: 'networkidle', timeout: 120000 });
  report.navigated = true;
  report.status = response?.status() ?? null;
  report.title = await page.title();
  report.canvas = await page.locator('#game').isVisible().catch(() => false);
  await page.screenshot({ path: path.join(OUT, 'browser-smoke.png'), fullPage: true });
  await browser.close();
} catch (error) {
  report.error = String(error?.stack || error);
}
await writeFile(path.join(OUT, 'browser-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!(report.launched && report.navigated && report.status === 200 && report.canvas)) process.exitCode = 1;
