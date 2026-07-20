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

  const setup = await page.evaluate(() => {
    const qa = window.__tecmoBoQA || {};
    const keys = Object.keys(qa).filter(key => typeof qa[key] === 'function');
    const words = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const invoke = (key, args = []) => {
      try { return { key, value: qa[key](...args) }; }
      catch (error) { return { key, error: String(error?.stack || error) }; }
    };
    const opponent = keys
      .map(key => ({ key, words: words(key) }))
      .filter(item => item.words.includes('opponent') && item.words.includes('possession'))
      .sort((a, b) => Number(b.words.includes('force')) - Number(a.words.includes('force')))[0];
    const opponentResult = opponent ? invoke(opponent.key, [true]) : null;
    const stressCandidates = keys
      .map(key => ({ key, words: words(key) }))
      .filter(item =>
        (item.words.includes('carrier') && (item.words.includes('ahead') || item.words.includes('far'))) ||
        (item.words.includes('opponent') && item.words.includes('field') && item.words.includes('run')) ||
        (item.words.includes('bo') && item.words.includes('offscreen'))
      )
      .sort((a, b) => {
        const score = item => Number(item.words.includes('carrier')) * 8 + Number(item.words.includes('ahead')) * 8 + Number(item.words.includes('far')) * 6 + Number(item.words.includes('full')) * 5 + Number(item.words.includes('force')) * 3;
        return score(b) - score(a);
      });
    const stressResults = stressCandidates.map(item => invoke(item.key));
    return { keys, opponentResult, stressCandidates, stressResults };
  });

  await page.waitForTimeout(700);
  let snap = await page.evaluate(() => window.__tecmoBoSnapshot());
  if (snap.boVisible !== false && typeof snap.boWorldX === 'number' && typeof snap.footballWorldX === 'number') {
    await page.waitForTimeout(900);
    snap = await page.evaluate(() => window.__tecmoBoSnapshot());
  }
  await page.screenshot({ path: 'qa-public/camera-stress.png', fullPage: true });

  const subject = String(snap.cameraSubject ?? '').toLowerCase();
  const subjectId = String(snap.cameraSubjectId ?? '').toLowerCase();
  const carrier = typeof snap.activeCarrier === 'string' ? snap.activeCarrier.toLowerCase() : JSON.stringify(snap.activeCarrier ?? '').toLowerCase();
  const footballX = Number(snap.footballScreenX);
  const carrierX = Number(snap.activeCarrierScreenX);
  const subjectOkay = subject.includes('ball') || subject.includes('football') || subject.includes('carrier') || (carrier && (subject.includes(carrier) || subjectId.includes(carrier)));
  const carrierVisible = snap.activeCarrierVisible === true;
  const footballVisible = Number.isFinite(footballX) && footballX >= 0 && footballX <= 960;
  const carrierScreenOkay = !Number.isFinite(carrierX) || (carrierX >= 0 && carrierX <= 960);
  const boGuidanceOkay = snap.boVisible !== false || (Boolean(snap.boOffscreenDirection) && Number.isFinite(Number(snap.boOffscreenDistance)) && Number(snap.boOffscreenDistance) >= 0);
  const stressHelperCalled = setup.stressResults.some(item => item && !item.error);
  result = {
    status: response?.status() ?? null,
    setup,
    possessionTeam: snap.possessionTeam,
    activeCarrier: snap.activeCarrier,
    cameraSubject: snap.cameraSubject,
    cameraSubjectId: snap.cameraSubjectId,
    activeCarrierVisible: snap.activeCarrierVisible,
    activeCarrierScreenX: snap.activeCarrierScreenX,
    footballScreenX: snap.footballScreenX,
    boVisible: snap.boVisible,
    boOffscreenDirection: snap.boOffscreenDirection,
    boOffscreenDistance: snap.boOffscreenDistance,
    boWorldX: snap.boWorldX,
    footballWorldX: snap.footballWorldX,
    subjectOkay,
    carrierVisible,
    footballVisible,
    carrierScreenOkay,
    boGuidanceOkay,
    stressHelperCalled,
    errors,
  };
  passed = response?.status() === 200 && setup.opponentResult && !setup.opponentResult.error && stressHelperCalled && String(snap.possessionTeam).toLowerCase().includes('opponent') && subjectOkay && carrierVisible && footballVisible && carrierScreenOkay && boGuidanceOkay && errors.length === 0;
} catch (error) {
  result.error = String(error?.stack || error);
}
await browser.close();
console.log(JSON.stringify({ passed, result }, null, 2));
if (!passed) process.exitCode = 1;
