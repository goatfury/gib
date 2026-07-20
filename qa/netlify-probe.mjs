import { chromium } from 'playwright';

const TARGET = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/';
const probe = process.env.PROBE || 'source_2min';
const fail = (message, details = null) => {
  console.error(JSON.stringify({ probe, passed: false, message, details }, null, 2));
  process.exitCode = 1;
};
const pass = (details = null) => console.log(JSON.stringify({ probe, passed: true, details }, null, 2));

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchSource() {
  const response = await fetch(TARGET, { redirect: 'follow' });
  const source = await response.text();
  if (!response.ok) throw new Error(`source HTTP ${response.status}`);
  return source;
}

async function browserPage() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('pageerror', error => errors.push(`page:${String(error?.stack || error)}`));
  const response = await page.goto(`${TARGET}?qa`, { waitUntil: 'networkidle', timeout: 120000 });
  if (response?.status() !== 200) throw new Error(`browser HTTP ${response?.status()}`);
  await page.waitForFunction(() => typeof window.__tecmoBoSnapshot === 'function', null, { timeout: 30000 });
  return { browser, page, errors };
}

async function startGame(page) {
  await page.locator('#startButton').click();
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.waitForTimeout(180);
}

async function snapshot(page) {
  return page.evaluate(() => window.__tecmoBoSnapshot());
}

async function callBest(page, required, any, preferred = [], args = []) {
  return page.evaluate(({ required, any, preferred, args }) => {
    const qa = window.__tecmoBoQA || {};
    const keys = Object.keys(qa).filter(key => typeof qa[key] === 'function');
    const words = value => String(value)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const ranked = keys.map(key => {
      const w = words(key);
      if (required.some(token => !w.includes(token))) return { key, score: -1 };
      if (any.length && !any.some(token => w.includes(token))) return { key, score: -1 };
      return { key, score: required.length * 20 + any.filter(token => w.includes(token)).length * 7 + preferred.filter(token => w.includes(token)).length * 3 };
    }).filter(x => x.score >= 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    if (!ranked.length) return { called: false, available: keys };
    const key = ranked[0].key;
    try { return { called: true, key, value: qa[key](...args), ranked: ranked.slice(0, 5) }; }
    catch (error) { return { called: true, key, error: String(error?.stack || error), ranked: ranked.slice(0, 5) }; }
  }, { required, any, preferred, args });
}

try {
  if (probe.startsWith('source_')) {
    const source = await fetchSource();
    if (probe === 'source_2min') {
      const result = {
        twoMinute: /QUARTER_SECONDS\s*=\s*(?:120|2\s*\*\s*60)\b/.test(source),
        fiveMinute: /QUARTER_SECONDS\s*=\s*5\s*\*\s*60\b/.test(source),
        literalFive: /5:00/.test(source),
      };
      if (!result.twoMinute || result.fiveMinute) fail('quarter-duration source check failed', result); else pass(result);
    } else if (probe === 'source_camera') {
      const result = Object.fromEntries(['cameraSubject','footballScreenX','activeCarrierVisible','boOffscreenDirection','boOffscreenDistance'].map(key => [key, source.includes(key)]));
      if (Object.values(result).every(Boolean)) pass(result); else fail('camera telemetry missing', result);
    } else if (probe === 'source_clean') {
      const result = Object.fromEntries(['freshGameSceneClean','giantSkeletonCorpseCount','skeletonCorpseCount'].map(key => [key, source.includes(key)]));
      if (Object.values(result).every(Boolean)) pass(result); else fail('clean-start telemetry missing', result);
    } else if (probe === 'source_story') {
      const lower = source.toLowerCase();
      const result = {
        q2: lower.includes('alien') && lower.includes('mothership') && (lower.includes('invade') || lower.includes('invasion')),
        q3: lower.includes('olympus') && lower.includes('zeus') && lower.includes('god'),
        q4: lower.includes('nuclear') && lower.includes('surviv') && lower.includes('machine'),
        storyIntro: lower.includes('storyintroactive') && lower.includes('persistentacthud'),
      };
      if (Object.values(result).every(Boolean)) pass(result); else fail('story source markers missing', result);
    }
  } else if (probe === 'browser_initial') {
    const { browser, page, errors } = await browserPage();
    const snap = await snapshot(page);
    await browser.close();
    const rawCandidates = [snap.quarterTimeRemaining, snap.timeLeft, snap.rawQuarterTimeRemaining].map(num).filter(value => value != null);
    const formattedCandidates = [snap.formattedQuarterClock, snap.quarterClock, snap.clockDisplay].filter(value => value != null).map(String);
    const rawOkay = rawCandidates.some(value => Math.abs(value - 120) < 0.1);
    const formattedOkay = formattedCandidates.some(value => value.trim() === '2:00' || value.includes('2:00'));
    if ((rawOkay || formattedOkay) && errors.length === 0) pass({ rawCandidates, formattedCandidates, mode: snap.mode });
    else fail('initial browser state failed', { rawCandidates, formattedCandidates, mode: snap.mode, keys: Object.keys(snap), errors });
  } else if (probe === 'browser_clean') {
    const { browser, page, errors } = await browserPage();
    await startGame(page);
    const snap = await snapshot(page);
    await browser.close();
    const fields = ['skeletonCorpseCount','giantSkeletonCorpseCount','humanSkeletonCount','humanCorpseCount','bloodStainCount','reanimatedSkeletonCount','looseBoneCount','boneWallCount'];
    const counts = Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(snap, field)).map(field => [field, snap[field]]));
    const allZero = Object.values(counts).every(value => Number(value) === 0);
    const noDeath = snap.firstHumanDeathOccurred === false || snap.firstHumanDeathOccurred == null;
    if (snap.freshGameSceneClean === true && allZero && noDeath && errors.length === 0) pass({ freshGameSceneClean: snap.freshGameSceneClean, counts, firstHumanDeathOccurred: snap.firstHumanDeathOccurred });
    else fail('clean browser state failed', { freshGameSceneClean: snap.freshGameSceneClean, counts, firstHumanDeathOccurred: snap.firstHumanDeathOccurred, errors });
  } else if (probe === 'browser_camera') {
    const { browser, page, errors } = await browserPage();
    await startGame(page);
    const forceOpponent = await callBest(page, ['opponent','possession'], ['force','begin','start'], ['qa'], [true]);
    await page.waitForTimeout(180);
    let forceAhead = await callBest(page, ['carrier'], ['ahead','offscreen'], ['opponent','force','far']);
    if (!forceAhead.called) forceAhead = await callBest(page, ['opponent'], ['field','run'], ['carrier','full','force']);
    await page.waitForTimeout(450);
    const snap = await snapshot(page);
    await browser.close();
    const subject = String(snap.cameraSubject ?? '').toLowerCase();
    const footballX = num(snap.footballScreenX);
    const result = {
      forceOpponent,
      forceAhead,
      possessionTeam: snap.possessionTeam,
      cameraSubject: snap.cameraSubject,
      activeCarrier: snap.activeCarrier,
      activeCarrierVisible: snap.activeCarrierVisible,
      footballScreenX: snap.footballScreenX,
      boVisible: snap.boVisible,
      boOffscreenDirection: snap.boOffscreenDirection,
      boOffscreenDistance: snap.boOffscreenDistance,
      errors,
    };
    const subjectGood = subject.includes('ball') || subject.includes('football') || subject.includes('carrier') || subject.includes(String(snap.activeCarrier ?? '').toLowerCase());
    const visible = snap.activeCarrierVisible === true;
    const ballOnScreen = footballX != null && footballX >= 0 && footballX <= 960;
    const helperGood = forceOpponent.called && !forceOpponent.error && forceAhead.called && !forceAhead.error;
    if (helperGood && String(snap.possessionTeam).toLowerCase().includes('opponent') && subjectGood && visible && ballOnScreen && errors.length === 0) pass(result); else fail('camera browser state failed', result);
  } else if (probe === 'browser_story') {
    const acts = [
      { id: 'q2', required: ['q2'], any: ['intro','alien','invasion','force','begin'], words: ['alien','mothership'] },
      { id: 'q3', required: ['q3'], any: ['intro','olympus','force','begin'], words: ['olympus','zeus','god'] },
      { id: 'q4', required: ['q4'], any: ['intro','nuclear','force','begin'], words: ['nuclear','surviv','machine'] },
    ];
    const results = [];
    let okay = true;
    for (const act of acts) {
      const { browser, page, errors } = await browserPage();
      await startGame(page);
      let invoked = await callBest(page, act.required, act.any, ['story','play']);
      if (!invoked.called) invoked = await callBest(page, [], act.any, act.required.concat(['story','intro']));
      await page.waitForTimeout(180);
      const intro = await snapshot(page);
      await page.waitForTimeout(1000);
      const active = await snapshot(page);
      await browser.close();
      const joined = [intro.storyAct,intro.storyEvent,intro.storyPhase,intro.storyIntroBeat,intro.persistentActHud,intro.worldEvent,intro.banner,active.storyAct,active.storyEvent,active.storyPhase,active.persistentActHud,active.worldEvent,active.banner].map(value => typeof value === 'string' ? value : JSON.stringify(value ?? '')).join(' ').toLowerCase();
      const identifies = act.words.some(word => joined.includes(word));
      const introVisible = intro.storyIntroActive === true || Boolean(intro.storyIntroBeat) || Boolean(intro.persistentActHud) || Boolean(active.persistentActHud);
      const carrierOkay = intro.activeCarrierVisible !== false && active.activeCarrierVisible !== false;
      const one = { id: act.id, invoked, identifies, introVisible, carrierOkay, joined: joined.slice(0, 900), errors };
      results.push(one);
      if (!(invoked.called && !invoked.error && identifies && introVisible && carrierOkay && errors.length === 0)) okay = false;
    }
    if (okay) pass(results); else fail('story browser state failed', results);
  } else {
    fail('unknown probe', { probe });
  }
} catch (error) {
  fail('probe threw', String(error?.stack || error));
}
