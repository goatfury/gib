import { chromium } from 'playwright';

const TARGET = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/';
const failures = [];
const check = (name, ok, details = null) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details ? ` ${JSON.stringify(details)}` : ''}`);
  if (!ok) failures.push({ name, details });
};

const response = await fetch(TARGET, { redirect: 'follow' });
const source = await response.text();
check('source HTTP 200', response.ok, { status: response.status });
check('2:00 quarter constant', /QUARTER_SECONDS\s*=\s*(?:120|2\s*\*\s*60)\b/.test(source));
check('old 5:00 constant absent', !/QUARTER_SECONDS\s*=\s*5\s*\*\s*60\b/.test(source));
check('ball-camera telemetry present', /cameraSubject/.test(source) && /footballScreenX/.test(source) && /activeCarrierVisible/.test(source));
check('offscreen Bo telemetry present', /boOffscreenDirection/.test(source) && /boOffscreenDistance/.test(source));
check('clean-start telemetry present', /freshGameSceneClean/.test(source) && /giantSkeletonCorpseCount/.test(source));
check('Q2 story is explicit in source', /ALIENS INVADE EARTH/i.test(source) && /DESTROY THE MOTHERSHIP/i.test(source));
check('Q3 story is explicit in source', /OLYMPUS TAKES THE FIELD/i.test(source) && /DEFEAT THE GODS/i.test(source));
check('Q4 story is explicit in source', /ONLY BO SURVIVES/i.test(source) && /BEAT THE MACHINES/i.test(source));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
const pageErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));
const navigation = await page.goto(`${TARGET}?qa`, { waitUntil: 'networkidle', timeout: 120000 });
check('browser navigation HTTP 200', navigation?.status() === 200, { status: navigation?.status() ?? null });
await page.waitForFunction(() => typeof window.__tecmoBoSnapshot === 'function', null, { timeout: 30000 });
let snapshot = await page.evaluate(() => window.__tecmoBoSnapshot());
const quarterTime = Number(snapshot.quarterTimeRemaining ?? snapshot.timeLeft);
check('initial clock is 2:00', Number.isFinite(quarterTime) && Math.abs(quarterTime - 120) < 0.1, { quarterTime });

await page.locator('#startButton').click();
await page.waitForTimeout(100);
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Space');
await page.waitForTimeout(220);
snapshot = await page.evaluate(() => window.__tecmoBoSnapshot());
check('fresh Q1 scene reports clean', snapshot.freshGameSceneClean === true, { freshGameSceneClean: snapshot.freshGameSceneClean });
for (const field of ['skeletonCorpseCount','giantSkeletonCorpseCount','humanSkeletonCount','humanCorpseCount','bloodStainCount','reanimatedSkeletonCount','looseBoneCount','boneWallCount']) {
  if (Object.prototype.hasOwnProperty.call(snapshot, field)) check(`fresh Q1 ${field}=0`, Number(snapshot[field]) === 0, { value: snapshot[field] });
}
if (Object.prototype.hasOwnProperty.call(snapshot, 'firstHumanDeathOccurred')) check('no human death before first play collision', snapshot.firstHumanDeathOccurred === false, { value: snapshot.firstHumanDeathOccurred });
check('no console errors', consoleErrors.length === 0, consoleErrors);
check('no page errors', pageErrors.length === 0, pageErrors);
await page.screenshot({ path: 'qa-public/clean-q1-gate.png', fullPage: true });
await browser.close();
if (failures.length) {
  console.error(JSON.stringify({ failures }, null, 2));
  process.exitCode = 1;
}
