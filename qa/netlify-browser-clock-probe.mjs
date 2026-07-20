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
  await page.waitForTimeout(120);
  const kicker = await page.locator('#playCallKicker').textContent();
  const snap = await page.evaluate(() => window.__tecmoBoSnapshot());
  const rawValues = [snap.quarterTimeRemaining, snap.timeLeft, snap.rawQuarterTimeRemaining]
    .map(value => Number(value))
    .filter(Number.isFinite);
  const formattedValues = [snap.formattedQuarterClock, snap.quarterClock, snap.clockDisplay]
    .filter(value => value != null)
    .map(String);
  const rawOkay = rawValues.some(value => value >= 118 && value <= 120.1);
  const formattedOkay = formattedValues.some(value => /^(?:2:00|1:59)$/.test(value.trim())) || /(?:2:00|1:59)/.test(String(kicker));
  result = { status: response?.status() ?? null, kicker, rawValues, formattedValues, quarter: snap.quarter, mode: snap.mode, errors };
  passed = response?.status() === 200 && Number(snap.quarter) === 1 && (rawOkay || formattedOkay) && errors.length === 0;
  await page.screenshot({ path: 'qa-public/two-minute-playcall.png', fullPage: true });
} catch (error) {
  result.error = String(error?.stack || error);
}
await browser.close();
console.log(JSON.stringify({ passed, result }, null, 2));
if (!passed) process.exitCode = 1;
