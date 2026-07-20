import { chromium } from 'playwright';

const target = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/?qa';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', message => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
page.on('pageerror', error => errors.push(`page:${String(error?.stack || error)}`));
let passed = false;
let result = {};
try {
  const response = await page.goto(target, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => typeof window.__tecmoBoSnapshot === 'function', null, { timeout: 30000 });
  await page.locator('#startButton').click();
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.waitForTimeout(160);
  const snap = await page.evaluate(() => window.__tecmoBoSnapshot());
  const fields = ['giantSkeletonCorpseCount','skeletonCorpseCount','humanSkeletonCount','humanCorpseCount','bloodStainCount','reanimatedSkeletonCount','looseBoneCount','boneWallCount','goreChunkCount'];
  const counts = Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(snap, field)).map(field => [field, Number(snap[field])]));
  const required = ['giantSkeletonCorpseCount','skeletonCorpseCount'];
  const requiredPresent = required.every(field => Object.prototype.hasOwnProperty.call(counts, field));
  const allZero = Object.values(counts).every(value => Number.isFinite(value) && value === 0);
  const noDeath = snap.firstHumanDeathOccurred === false || snap.firstHumanDeathOccurred == null;
  const livingHumans = Number(snap.livingHumanCount);
  const humansOkay = !Number.isFinite(livingHumans) || livingHumans > 0;
  result = { status: response?.status() ?? null, mode: snap.mode, quarter: snap.quarter, counts, firstHumanDeathOccurred: snap.firstHumanDeathOccurred, livingHumanCount: snap.livingHumanCount, errors };
  passed = response?.status() === 200 && requiredPresent && allZero && noDeath && humansOkay && errors.length === 0;
  await page.screenshot({ path: 'qa-public/clean-kickoff.png', fullPage: true });
} catch (error) {
  result.error = String(error?.stack || error);
}
await browser.close();
console.log(JSON.stringify({ passed, result }, null, 2));
if (!passed) process.exitCode = 1;
