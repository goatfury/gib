import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGET = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/';
const OUT = path.resolve('qa/tecmo-ball-camera-review-output');
await mkdir(OUT, { recursive: true });
const result = { target: TARGET, http: {}, markers: {}, qa: {}, clean: {}, camera: {}, scenes: {}, mobile: {}, errors: [] };

const fetched = await fetch(TARGET, { redirect: 'follow' });
const source = await fetched.text();
result.http = { status: fetched.status, ok: fetched.ok, finalUrl: fetched.url, bytes: Buffer.byteLength(source) };
await writeFile(path.join(OUT, 'live-source.html'), source);
for (const [name, re] of Object.entries({
  twoMinute: /QUARTER_SECONDS\s*=\s*(?:120|2\s*\*\s*60)\b/,
  fiveMinute: /QUARTER_SECONDS\s*=\s*5\s*\*\s*60\b/,
  camera: /cameraSubject|footballScreenX|activeCarrierVisible|boOffscreen/gi,
  clean: /freshGameSceneClean|giantSkeletonCorpseCount|skeletonCorpseCount/gi,
  q2: /ALIENS INVADE EARTH|DESTROY THE MOTHERSHIP|ALIEN INVASION/gi,
  q3: /OLYMPUS TAKES THE FIELD|DEFEAT THE GODS|ZEUS WAITS/gi,
  q4: /ONLY BO SURVIVES|LAST GAME ON EARTH|BEAT THE MACHINES/gi,
})) {
  const matches = source.match(re) || [];
  result.markers[name] = { present: matches.length > 0, count: matches.length };
}

const browser = await chromium.launch({ headless: true });
const diagnostics = (page, bucket) => {
  page.on('console', m => { if (m.type() === 'error') bucket.push('console: ' + m.text()); });
  page.on('pageerror', e => bucket.push('pageerror: ' + String(e?.stack || e)));
};
const snap = page => page.evaluate(() => typeof window.__tecmoBoSnapshot === 'function' ? window.__tecmoBoSnapshot() : null);
const api = page => page.evaluate(() => {
  const qa = window.__tecmoBoQA || {};
  return Object.fromEntries(Object.keys(qa).sort().map(k => [k, { arity: typeof qa[k] === 'function' ? qa[k].length : null, source: typeof qa[k] === 'function' ? String(qa[k]).slice(0, 500) : '' }]));
});
async function call(page, candidates, args = []) {
  return page.evaluate(({ candidates, args }) => {
    const qa = window.__tecmoBoQA || {};
    const keys = Object.keys(qa);
    const norm = v => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wants = candidates.map(norm);
    let key = keys.find(k => wants.includes(norm(k)) && typeof qa[k] === 'function');
    if (!key) key = keys.find(k => wants.some(w => norm(k).includes(w) || w.includes(norm(k))) && typeof qa[k] === 'function');
    if (!key) return { called: false, candidates, available: keys };
    try { return { called: true, key, value: qa[key](...args) }; }
    catch (error) { return { called: true, key, error: String(error?.stack || error) }; }
  }, { candidates, args });
}
async function start(page) {
  await page.locator('#startButton').click().catch(() => {});
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowUp').catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
  await page.waitForTimeout(260);
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
diagnostics(page, result.errors);
const nav = await page.goto(TARGET + '?qa', { waitUntil: 'networkidle', timeout: 120000 });
result.qa.navigation = nav?.status() ?? null;
result.qa.title = await page.title();
result.qa.api = await api(page);
await writeFile(path.join(OUT, 'qa-api.json'), JSON.stringify(result.qa.api, null, 2));
await page.screenshot({ path: path.join(OUT, '00-title.png'), fullPage: true });
await start(page);
result.clean.early = await snap(page);
await page.locator('#game').screenshot({ path: path.join(OUT, '01-clean-q1.png') });
await page.waitForTimeout(900);
result.clean.later = await snap(page);

const cam = await context.newPage();
const camErrors = [];
diagnostics(cam, camErrors);
await cam.goto(TARGET + '?qa', { waitUntil: 'networkidle', timeout: 120000 });
await start(cam);
result.camera.opponent = await call(cam, ['forceOpponentPossession', 'forceOpponentBall', 'beginOpponentPossessionForQA'], [true]);
await cam.waitForTimeout(200);
result.camera.ahead = await call(cam, ['forceOpponentCarrierFarAhead', 'placeOpponentCarrierFarAhead', 'forceCarrierAhead', 'forceBoOffscreen']);
result.camera.fullRun = await call(cam, ['makeOpponentRunFullField', 'runOpponentFullField', 'forceOpponentFullFieldRun']);
await cam.waitForTimeout(1500);
result.camera.snapshot = await snap(cam);
result.camera.errors = camErrors;
await cam.locator('#game').screenshot({ path: path.join(OUT, '02-ball-camera.png') });
await cam.close();

for (const spec of [
  ['q2', ['playQ2Introduction', 'forceQ2Introduction', 'forceAlienIntroduction', 'beginAlienInvasion', 'forceAlienInvasion']],
  ['q3', ['playQ3Introduction', 'forceQ3Introduction', 'forceOlympusIntroduction', 'beginOlympus', 'forceOlympus']],
  ['q4', ['playQ4Introduction', 'forceQ4Introduction', 'forceNuclearIntroduction', 'beginNuclearWar', 'forceNuclearWar', 'beginQ4']],
]) {
  const [name, candidates] = spec;
  const p = await context.newPage();
  const errs = [];
  diagnostics(p, errs);
  await p.goto(TARGET + '?qa', { waitUntil: 'networkidle', timeout: 120000 });
  await start(p);
  const invoked = await call(p, candidates);
  const immediate = await snap(p);
  await p.waitForTimeout(900);
  await p.locator('#game').screenshot({ path: path.join(OUT, `${name}-intro.png`) });
  const mid = await snap(p);
  await p.waitForTimeout(1900);
  await p.locator('#game').screenshot({ path: path.join(OUT, `${name}-active.png`) });
  result.scenes[name] = { invoked, immediate, mid, active: await snap(p), errors: errs };
  await p.close();
}

const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mobile = await mobileContext.newPage();
const mobileErrors = [];
diagnostics(mobile, mobileErrors);
await mobile.goto(TARGET + '?qa', { waitUntil: 'networkidle', timeout: 120000 });
await start(mobile);
result.mobile.invoked = await call(mobile, ['playQ2Introduction', 'forceQ2Introduction', 'forceAlienIntroduction', 'beginAlienInvasion', 'forceAlienInvasion']);
await mobile.waitForTimeout(900);
result.mobile.snapshot = await snap(mobile);
result.mobile.touchControlsVisible = await mobile.locator('.touch-controls').isVisible().catch(() => false);
result.mobile.errors = mobileErrors;
await mobile.screenshot({ path: path.join(OUT, 'mobile-q2.png'), fullPage: true });
await mobileContext.close();

await browser.close();
await writeFile(path.join(OUT, 'review-result.json'), JSON.stringify(result, null, 2));
if (!result.http.ok || result.qa.navigation !== 200 || result.errors.length) process.exitCode = 1;

// synchronize trigger
