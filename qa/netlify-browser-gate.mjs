import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGET = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/';
const OUT = path.resolve('qa-public');
await mkdir(OUT, { recursive: true });

const report = {
  target: TARGET,
  ranAt: new Date().toISOString(),
  assertions: [],
  qaKeys: [],
  snapshots: {},
  screenshots: {},
  consoleErrors: [],
  pageErrors: [],
};

function assert(name, condition, details = null) {
  const passed = Boolean(condition);
  report.assertions.push({ name, passed, details });
  if (!passed) throw new Error(`ASSERTION FAILED: ${name}${details ? ` :: ${JSON.stringify(details)}` : ''}`);
}

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedWords(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const browser = await chromium.launch({ headless: true });

async function makePage(viewport = { width: 1440, height: 900 }, mobile = false) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  page.on('pageerror', error => report.pageErrors.push(String(error?.stack || error)));
  const response = await page.goto(`${TARGET}?qa`, { waitUntil: 'networkidle', timeout: 120_000 });
  assert('target returns HTTP 200', response?.status() === 200, { status: response?.status() ?? null });
  await page.waitForFunction(() => typeof window.__tecmoBoSnapshot === 'function', null, { timeout: 30_000 });
  return { context, page };
}

async function snapshot(page) {
  return page.evaluate(() => window.__tecmoBoSnapshot());
}

async function startGame(page) {
  await page.locator('#startButton').click();
  await page.waitForTimeout(120);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.waitForTimeout(240);
}

async function qaKeys(page) {
  return page.evaluate(() => Object.keys(window.__tecmoBoQA || {}).sort());
}

async function callBest(page, { label, required = [], any = [], preferred = [], args = [] }) {
  return page.evaluate(({ label, required, any, preferred, args }) => {
    const qa = window.__tecmoBoQA || {};
    const keys = Object.keys(qa).filter(key => typeof qa[key] === 'function');
    const words = value => String(value)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const score = key => {
      const keyWords = words(key);
      if (required.some(token => !keyWords.includes(token))) return -1;
      if (any.length && !any.some(token => keyWords.includes(token))) return -1;
      return required.length * 20 + any.filter(token => keyWords.includes(token)).length * 8 + preferred.filter(token => keyWords.includes(token)).length * 3;
    };
    const ranked = keys.map(key => ({ key, score: score(key) })).filter(item => item.score >= 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    if (!ranked.length) return { called: false, label, available: keys };
    const key = ranked[0].key;
    try {
      return { called: true, label, key, value: qa[key](...args), ranked: ranked.slice(0, 5) };
    } catch (error) {
      return { called: true, label, key, error: String(error?.stack || error), ranked: ranked.slice(0, 5) };
    }
  }, { label, required, any, preferred, args });
}

async function screenshot(page, name) {
  const buffer = await page.locator('#game').screenshot({ path: path.join(OUT, `${name}.png`) });
  const digest = createHash('sha256').update(buffer).digest('hex');
  report.screenshots[name] = { sha256: digest, bytes: buffer.length };
  return digest;
}

try {
  const sourceResponse = await fetch(TARGET, { redirect: 'follow' });
  const source = await sourceResponse.text();
  assert('source fetch succeeds', sourceResponse.ok, { status: sourceResponse.status });
  assert('quarter constant is two minutes', /QUARTER_SECONDS\s*=\s*(?:120|2\s*\*\s*60)\b/.test(source));
  assert('old five-minute quarter constant is absent', !/QUARTER_SECONDS\s*=\s*5\s*\*\s*60\b/.test(source));
  assert('ball-camera telemetry is implemented', /cameraSubject/.test(source) && /footballScreenX/.test(source) && /activeCarrierVisible/.test(source));
  assert('offscreen Bo guidance telemetry is implemented', /boOffscreenDirection/.test(source) && /boOffscreenDistance/.test(source));
  assert('clean-start telemetry is implemented', /freshGameSceneClean/.test(source) && /giantSkeletonCorpseCount/.test(source));
  assert('Q2 story language is explicit', /ALIENS INVADE EARTH/i.test(source) && /DESTROY THE MOTHERSHIP/i.test(source));
  assert('Q3 story language is explicit', /OLYMPUS TAKES THE FIELD/i.test(source) && /DEFEAT THE GODS/i.test(source));
  assert('Q4 story language is explicit', /ONLY BO SURVIVES/i.test(source) && /BEAT THE MACHINES/i.test(source));

  const main = await makePage();
  report.qaKeys = await qaKeys(main.page);
  assert('QA API is exposed', report.qaKeys.length >= 10, { count: report.qaKeys.length });
  const initial = await snapshot(main.page);
  report.snapshots.initial = initial;
  assert('new game is configured for 2:00', Math.abs((number(initial.quarterTimeRemaining) ?? number(initial.timeLeft) ?? -1) - 120) < 0.1, { quarterTimeRemaining: initial.quarterTimeRemaining, timeLeft: initial.timeLeft });

  await startGame(main.page);
  const clean = await snapshot(main.page);
  report.snapshots.cleanQ1 = clean;
  await screenshot(main.page, 'clean-q1');
  assert('fresh Q1 scene reports clean', clean.freshGameSceneClean === true, { freshGameSceneClean: clean.freshGameSceneClean });
  const cleanCounts = [
    'skeletonCorpseCount', 'giantSkeletonCorpseCount', 'humanSkeletonCount', 'humanCorpseCount',
    'bloodStainCount', 'reanimatedSkeletonCount', 'looseBoneCount', 'boneWallCount'
  ];
  for (const field of cleanCounts) {
    if (field in clean) assert(`fresh Q1 ${field} is zero`, number(clean[field]) === 0, { field, value: clean[field] });
  }
  assert('fresh Q1 begins before any human death', clean.firstHumanDeathOccurred === false || clean.firstHumanDeathOccurred == null, { firstHumanDeathOccurred: clean.firstHumanDeathOccurred });
  await main.context.close();

  const camera = await makePage();
  await startGame(camera.page);
  const forceOpponent = await callBest(camera.page, { label: 'force opponent possession', required: ['opponent', 'possession'], any: ['force', 'begin', 'start'], preferred: ['qa'], args: [true] });
  assert('opponent-possession QA helper is callable', forceOpponent.called && !forceOpponent.error, forceOpponent);
  await camera.page.waitForTimeout(200);
  const forceAhead = await callBest(camera.page, { label: 'put carrier ahead', required: ['carrier'], any: ['ahead', 'offscreen', 'field'], preferred: ['opponent', 'force', 'far'] });
  assert('carrier-ahead QA helper is callable', forceAhead.called && !forceAhead.error, forceAhead);
  await camera.page.waitForTimeout(450);
  const cameraSnap = await snapshot(camera.page);
  report.snapshots.opponentCamera = cameraSnap;
  await screenshot(camera.page, 'opponent-ball-camera');
  assert('opponent possesses the football in camera test', String(cameraSnap.possessionTeam).toLowerCase().includes('opponent'), { possessionTeam: cameraSnap.possessionTeam });
  assert('active opponent carrier remains visible', cameraSnap.activeCarrierVisible === true, { activeCarrierVisible: cameraSnap.activeCarrierVisible, activeCarrier: cameraSnap.activeCarrier });
  const footballX = number(cameraSnap.footballScreenX);
  assert('football remains on screen', footballX != null && footballX >= 0 && footballX <= 960, { footballScreenX: cameraSnap.footballScreenX });
  const subject = text(cameraSnap.cameraSubject).toLowerCase();
  const carrierText = text(cameraSnap.activeCarrier).toLowerCase();
  assert('camera subject is the football or active carrier', subject.includes('football') || subject.includes('ball') || (carrierText && subject.includes(carrierText.replace(/[^a-z0-9]/g, ''))), { cameraSubject: cameraSnap.cameraSubject, activeCarrier: cameraSnap.activeCarrier });
  if (cameraSnap.boVisible === false) {
    assert('offscreen Bo indicator supplies direction', Boolean(cameraSnap.boOffscreenDirection), { boOffscreenDirection: cameraSnap.boOffscreenDirection });
    assert('offscreen Bo indicator supplies distance', number(cameraSnap.boOffscreenDistance) != null && number(cameraSnap.boOffscreenDistance) >= 0, { boOffscreenDistance: cameraSnap.boOffscreenDistance });
  }
  await camera.context.close();

  const acts = [
    { id: 'q2', number: 2, words: ['alien'], helperRequired: ['q2'], helperAny: ['intro', 'alien', 'invasion', 'force', 'begin'] },
    { id: 'q3', number: 3, words: ['olympus', 'god', 'zeus'], helperRequired: ['q3'], helperAny: ['intro', 'olympus', 'force', 'begin'] },
    { id: 'q4', number: 4, words: ['nuclear', 'survives', 'machine'], helperRequired: ['q4'], helperAny: ['intro', 'nuclear', 'force', 'begin'] },
  ];

  for (const act of acts) {
    const scene = await makePage();
    await startGame(scene.page);
    let invoked = await callBest(scene.page, { label: `${act.id} introduction`, required: act.helperRequired, any: act.helperAny, preferred: ['play', 'story'] });
    if (!invoked.called) {
      invoked = await callBest(scene.page, { label: `${act.id} introduction fallback`, required: [], any: act.helperAny, preferred: act.helperRequired.concat(['intro', 'story']) });
    }
    assert(`${act.id} introduction QA helper is callable`, invoked.called && !invoked.error, invoked);
    await scene.page.waitForTimeout(180);
    const intro = await snapshot(scene.page);
    report.snapshots[`${act.id}Intro`] = intro;
    await screenshot(scene.page, `${act.id}-intro`);
    await scene.page.waitForTimeout(1500);
    const active = await snapshot(scene.page);
    report.snapshots[`${act.id}Active`] = active;
    await screenshot(scene.page, `${act.id}-active`);

    const joined = [
      intro.storyAct, intro.storyEvent, intro.storyPhase, intro.storyIntroBeat, intro.persistentActHud,
      active.storyAct, active.storyEvent, active.storyPhase, active.persistentActHud,
      intro.worldEvent, active.worldEvent, intro.banner, active.banner
    ].map(text).join(' ').toLowerCase();
    assert(`${act.id} identifies its act in telemetry`, act.words.some(word => joined.includes(word)), { joined: joined.slice(0, 1200) });
    assert(`${act.id} has an active or recently active story introduction`, intro.storyIntroActive === true || active.storyIntroActive === true || Boolean(intro.storyIntroBeat) || Boolean(active.persistentActHud), { introActive: intro.storyIntroActive, introBeat: intro.storyIntroBeat, persistentActHud: active.persistentActHud });
    assert(`${act.id} keeps the football carrier visible`, intro.activeCarrierVisible !== false && active.activeCarrierVisible !== false, { intro: intro.activeCarrierVisible, active: active.activeCarrierVisible });
    const timeScale = number(intro.storyTimeScale);
    if (timeScale != null) assert(`${act.id} introduction uses nonzero playable time scale`, timeScale > 0 && timeScale <= 1, { storyTimeScale: intro.storyTimeScale });
    await scene.context.close();
  }

  const uniqueSceneHashes = new Set(Object.entries(report.screenshots).filter(([name]) => /q[234]-active/.test(name)).map(([, value]) => value.sha256));
  assert('Q2, Q3, and Q4 render as visually distinct acts', uniqueSceneHashes.size === 3, { hashes: [...uniqueSceneHashes] });

  const mobile = await makePage({ width: 390, height: 844 }, true);
  await startGame(mobile.page);
  let mobileQ2 = await callBest(mobile.page, { label: 'mobile Q2 introduction', required: ['q2'], any: ['intro', 'alien', 'invasion', 'force', 'begin'], preferred: ['play', 'story'] });
  if (!mobileQ2.called) mobileQ2 = await callBest(mobile.page, { label: 'mobile Q2 fallback', required: [], any: ['alien', 'invasion'], preferred: ['q2', 'intro'] });
  assert('mobile Q2 introduction is callable', mobileQ2.called && !mobileQ2.error, mobileQ2);
  await mobile.page.waitForTimeout(900);
  const mobileSnap = await snapshot(mobile.page);
  report.snapshots.mobileQ2 = mobileSnap;
  await mobile.page.screenshot({ path: path.join(OUT, 'mobile-q2-full.png'), fullPage: true });
  assert('touch controls remain visible on mobile', await mobile.page.locator('.touch-controls').isVisible());
  assert('mobile carrier remains visible during Q2 story', mobileSnap.activeCarrierVisible !== false, { activeCarrierVisible: mobileSnap.activeCarrierVisible });
  await mobile.context.close();

  assert('no browser console errors', report.consoleErrors.length === 0, report.consoleErrors);
  assert('no browser page errors', report.pageErrors.length === 0, report.pageErrors);
} catch (error) {
  report.failure = String(error?.stack || error);
} finally {
  await browser.close();
  await writeFile(path.join(OUT, 'browser-gate.json'), `${JSON.stringify(report, null, 2)}\n`);
  const passed = !report.failure && report.assertions.every(item => item.passed);
  console.log(JSON.stringify({ passed, assertions: report.assertions.length, failure: report.failure || null }));
  if (!passed) process.exitCode = 1;
}
