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
  await page.waitForTimeout(180);
  const helper = await page.evaluate(() => {
    const qa = window.__tecmoBoQA || {};
    const keys = Object.keys(qa).filter(key => typeof qa[key] === 'function');
    const words = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const candidates = keys.map(key => ({ key, words: words(key) }))
      .filter(item => item.words.includes('opponent') && item.words.includes('possession'))
      .sort((a, b) => (b.words.includes('force') ? 1 : 0) - (a.words.includes('force') ? 1 : 0));
    if (!candidates.length) return { called: false, keys };
    const key = candidates[0].key;
    try { return { called: true, key, value: qa[key](true), keys }; }
    catch (error) { return { called: true, key, error: String(error?.stack || error), keys }; }
  });
  await page.waitForTimeout(350);
  const snap = await page.evaluate(() => window.__tecmoBoSnapshot());
  await page.screenshot({ path: 'qa-public/camera-basic.png', fullPage: true });
  const subject = String(snap.cameraSubject ?? '').toLowerCase();
  const subjectId = String(snap.cameraSubjectId ?? '').toLowerCase();
  const activeCarrierText = typeof snap.activeCarrier === 'string' ? snap.activeCarrier.toLowerCase() : JSON.stringify(snap.activeCarrier ?? '').toLowerCase();
  const footballX = Number(snap.footballScreenX);
  const subjectOkay = subject.includes('ball') || subject.includes('football') || subject.includes('carrier') || (activeCarrierText && (subject.includes(activeCarrierText) || subjectId.includes(activeCarrierText)));
  const visibleOkay = snap.activeCarrierVisible === true;
  const footballOkay = Number.isFinite(footballX) && footballX >= 0 && footballX <= 960;
  result = {
    status: response?.status() ?? null,
    helper,
    possessionTeam: snap.possessionTeam,
    activeCarrier: snap.activeCarrier,
    cameraSubject: snap.cameraSubject,
    cameraSubjectId: snap.cameraSubjectId,
    activeCarrierVisible: snap.activeCarrierVisible,
    footballScreenX: snap.footballScreenX,
    boVisible: snap.boVisible,
    errors,
    subjectOkay,
    visibleOkay,
    footballOkay,
  };
  passed = response?.status() === 200 && helper.called && !helper.error && String(snap.possessionTeam).toLowerCase().includes('opponent') && subjectOkay && visibleOkay && footballOkay && errors.length === 0;
} catch (error) {
  result.error = String(error?.stack || error);
}
await browser.close();
console.log(JSON.stringify({ passed, result }, null, 2));
if (!passed) process.exitCode = 1;
