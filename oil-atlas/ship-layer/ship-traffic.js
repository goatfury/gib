(() => {
  'use strict';

  const START = Date.UTC(2025, 8, 1);
  const WAR = Date.UTC(2026, 1, 28);
  const DAY = 86400000;
  const PORTWATCH_BASELINE = 73;
  const BROADER_INDUSTRY_NORMAL = '≈130–138/day';
  const MAX_ICONS = 30;
  const NS = 'http://www.w3.org/2000/svg';
  const IMPACT_SEQUENCE = [
    { after: 0, date: '2026-02-28' },
    { after: 320, date: '2026-03-01' },
    { after: 690, date: '2026-03-02' },
    { after: 1080, date: '2026-03-04' },
  ];
  const IMPACT_DURATION = 1650;

  // Dated fallback points keep the visual honest if the daily endpoint is temporarily unavailable.
  const FALLBACK = [
    ['2025-09-01',93,57,36],['2025-09-05',120,75,45],['2025-09-14',41,24,17],
    ['2025-09-17',105,55,50],['2025-09-30',99,56,43],['2025-10-05',119,72,47],
    ['2025-10-07',25,11,14],['2025-10-14',117,63,54],['2025-10-31',78,42,36],
    ['2025-11-08',106,62,44],['2025-11-18',43,28,15],['2025-11-30',53,32,21],
    ['2025-12-09',82,46,36],['2025-12-23',22,9,13],['2025-12-31',67,44,23],
    ['2026-01-09',73,40,33],['2026-01-17',38,23,15],['2026-01-31',70,40,30],
    ['2026-02-13',97,51,46],['2026-02-22',125,68,57],['2026-02-27',53,30,23],
    ['2026-02-28',51,33,18],['2026-03-01',18,5,13],['2026-03-02',4,1,3],
    ['2026-03-03',4,1,3],['2026-03-04',0,0,0],['2026-03-05',3,1,2],
    ['2026-03-08',1,0,1],['2026-03-15',7,2,5],['2026-04-01',6,1,5],
    ['2026-04-18',20,12,8],['2026-05-05',0,0,0],['2026-05-20',7,3,4],
    ['2026-06-01',2,1,1],['2026-06-18',19,10,9],['2026-06-24',44,18,26],
    ['2026-07-01',27,17,10],['2026-07-10',4,3,1],['2026-07-23',0,0,0],
    ['2026-08-01',3,2,1],['2026-08-09',1,0,1],['2026-08-16',1,1,0],
  ].map(([date,total,tanker,cargo]) => ({ date, total, tanker, cargo }));

  const state = {
    records: [],
    byDate: new Map(),
    indexByDate: new Map(),
    latestDate: FALLBACK.at(-1).date,
    source: 'embedded dated fallback',
    currentKey: '',
    currentTotal: 0,
    currentTanker: 0,
    currentCargo: 0,
    currentPace: 0,
    visualIcons: 0,
    targetIcons: 0,
    lastFrame: performance.now(),
    impactTimer: 0,
    impactReplayStart: 0,
    lastTimelineIndex: 0,
    lastMode: 'gulf',
    qaMode: false,
    suppressImpact: false,
  };

  const el = {};
  const ships = [];
  let outPath;
  let inPath;
  let outLength = 1;
  let inLength = 1;

  function svg(name, attrs = {}, parent) {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent?.appendChild(node);
    return node;
  }

  function isoFromIndex(index) {
    return new Date(START + index * DAY).toISOString().slice(0, 10);
  }

  function indexFromIso(iso) {
    return Math.max(0, Math.round((Date.parse(`${iso}T00:00:00Z`) - START) / DAY));
  }

  function dayNumber(iso) {
    return Date.parse(`${iso}T00:00:00Z`);
  }

  function prettyDate(iso) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(`${iso}T00:00:00Z`));
  }

  function normalizeRecords(records) {
    const clean = records
      .map((r) => ({
        date: String(r.date || '').slice(0, 10),
        total: Math.max(0, Number(r.total ?? r.n_total)),
        tanker: Math.max(0, Number(r.tanker ?? r.n_tanker)),
        cargo: Math.max(0, Number(r.cargo ?? r.n_cargo)),
      }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.total))
      .sort((a, b) => a.date.localeCompare(b.date));

    const seen = new Map();
    for (const row of clean) seen.set(row.date, row);
    state.records = [...seen.values()];
    state.byDate = new Map(state.records.map((r) => [r.date, r]));
    state.indexByDate = new Map(state.records.map((r, index) => [r.date, index]));
    state.latestDate = state.records.at(-1)?.date || FALLBACK.at(-1).date;
  }

  function nearestPublishedRow(iso) {
    const exact = state.byDate.get(iso);
    if (exact) return { ...exact, held: false };

    const target = dayNumber(iso);
    let prior = null;
    for (let i = state.records.length - 1; i >= 0; i -= 1) {
      const candidate = state.records[i];
      if (dayNumber(candidate.date) <= target) {
        prior = candidate;
        break;
      }
    }
    if (!prior) prior = state.records[0] || FALLBACK[0];
    return { ...prior, held: true };
  }

  function iconCount(total) {
    if (total <= 0) return 0;
    return Math.max(1, Math.min(MAX_ICONS, Math.round(MAX_ICONS * total / PORTWATCH_BASELINE)));
  }

  function buildShip(parent, index) {
    const group = svg('g', {
      class: `traffic-ship ${index % 5 < 3 ? 'tanker' : 'cargo'}`,
      'aria-hidden': 'true',
    }, parent);
    svg('line', { class: 'traffic-wake', x1: -13, y1: 0, x2: -5.5, y2: 0 }, group);
    svg('path', { class: 'ship-hull', d: 'M-5.5 -2.45 H4.5 L7.3 0 4.5 2.45 H-5.4 L-7.4 0 Z' }, group);
    svg('rect', { class: 'ship-detail', x: -3.1, y: -1.2, width: 2.8, height: 2.4, rx: .35 }, group);
    if (index % 5 < 3) {
      svg('circle', { class: 'ship-detail', cx: 1.15, cy: 0, r: .82 }, group);
      svg('circle', { class: 'ship-detail', cx: 3.15, cy: 0, r: .82 }, group);
    } else {
      svg('rect', { class: 'ship-detail', x: .5, y: -1, width: 1.55, height: 2, rx: .15 }, group);
      svg('rect', { class: 'ship-detail', x: 2.35, y: -1, width: 1.55, height: 2, rx: .15 }, group);
    }
    return {
      group,
      direction: index % 2 === 0 ? 1 : -1,
      phase: (index / MAX_ICONS + (index % 4) * .041) % 1,
      speed: .085 + (index % 5) * .009,
    };
  }

  function buildLayer() {
    el.map = document.getElementById('gulfMap');
    el.timeline = document.getElementById('timeline');
    el.gulfMode = document.getElementById('gulfMode');
    el.worldMode = document.getElementById('worldMode');
    if (!el.map || !el.timeline) return false;

    el.layer = svg('g', {
      id: 'trafficLayer',
      'aria-label': 'Animated daily commercial ship traffic through the Strait of Hormuz',
      'data-traffic-total': '0',
      'data-visible-ships': '0',
    }, el.map);

    const corridor = svg('g', { id: 'trafficCorridor' }, el.layer);
    outPath = svg('path', {
      id: 'trafficLaneOut', class: 'traffic-lane hot',
      d: 'M492 177 C540 183 582 196 620 214 C671 238 725 254 793 267',
    }, corridor);
    inPath = svg('path', {
      id: 'trafficLaneIn', class: 'traffic-lane',
      d: 'M793 279 C726 270 671 251 620 227 C580 208 540 196 492 190',
    }, corridor);
    outLength = outPath.getTotalLength();
    inLength = inPath.getTotalLength();

    const shipGroup = svg('g', { id: 'trafficShips' }, el.layer);
    for (let i = 0; i < MAX_ICONS; i += 1) ships.push(buildShip(shipGroup, i));

    const counter = svg('g', { id: 'trafficCounter', transform: 'translate(578 54)' }, el.layer);
    svg('rect', { class: 'traffic-counter-bg', x: 0, y: 0, width: 207, height: 116, rx: 12 }, counter);
    el.kicker = svg('text', { class: 'traffic-kicker', x: 13, y: 19 }, counter);
    el.kicker.textContent = 'TRACKED COMMERCIAL TRANSITS';
    el.number = svg('text', { class: 'traffic-number', x: 13, y: 58 }, counter);
    el.number.textContent = '93';
    const unit = svg('text', { class: 'traffic-unit', x: 75, y: 55 }, counter);
    unit.textContent = 'SHIPS / DAY';
    el.sub = svg('text', { class: 'traffic-sub', x: 13, y: 77 }, counter);
    el.sub.textContent = 'Exact PortWatch day · normal median 73';
    svg('rect', { class: 'traffic-normal-track', x: 13, y: 86, width: 180, height: 6, rx: 3 }, counter);
    el.fill = svg('rect', { class: 'traffic-normal-fill', x: 13, y: 86, width: 180, height: 6, rx: 3 }, counter);
    el.breakdown = svg('text', { class: 'traffic-sub', x: 13, y: 103 }, counter);
    el.breakdown.textContent = 'tankers 57 · cargo 36';
    el.scope = svg('text', { class: 'traffic-scope', x: 13, y: 114 }, counter);
    el.scope.textContent = `Wider industry normal ${BROADER_INDUSTRY_NORMAL}`;

    const impact = svg('g', { id: 'trafficImpact', transform: 'translate(470 292)' }, el.layer);
    svg('rect', { class: 'traffic-impact-bg', x: 0, y: 0, width: 327, height: 48, rx: 12 }, impact);
    el.impactTitle = svg('text', { class: 'traffic-impact-title', x: 163.5, y: 20, 'text-anchor': 'middle' }, impact);
    el.impactTitle.textContent = 'TRAFFIC COLLAPSE';
    el.impactSequence = svg('text', { class: 'traffic-impact-sequence', x: 163.5, y: 37, 'text-anchor': 'middle' }, impact);
    el.impactSequence.textContent = '51 → 18 → 4 → 0 tracked ships/day';

    const mapCard = el.map.closest('.map-card');
    if (mapCard && !mapCard.querySelector('.hormuz-traffic-source')) {
      el.sourceNote = document.createElement('div');
      el.sourceNote.className = 'hormuz-traffic-source';
      el.sourceNote.innerHTML = `<span class="traffic-live-dot"></span><strong>Ship density:</strong> IMF PortWatch daily tanker + cargo transits. Icons encode traffic intensity, not one vessel each. PortWatch normal median: ${PORTWATCH_BASELINE}/day; wider industry definitions: ${BROADER_INDUSTRY_NORMAL}.`;
      mapCard.appendChild(el.sourceNote);
    }

    normalizeRecords(FALLBACK);
    return true;
  }

  async function loadData() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch('/api/hormuz_traffic', { cache: 'no-store', signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.records) || data.records.length < 120) throw new Error('short series');
      normalizeRecords(data.records);
      state.source = data.source || 'IMF PortWatch live series';
      if (el.sourceNote) {
        el.sourceNote.innerHTML = `<span class="traffic-live-dot"></span><strong>Ship density:</strong> IMF PortWatch daily tanker + cargo transits through ${prettyDate(state.latestDate)}. Icons encode traffic intensity, not one vessel each. PortWatch normal median: ${PORTWATCH_BASELINE}/day; wider industry definitions: ${BROADER_INDUSTRY_NORMAL}.`;
      }
      el.layer.dataset.source = 'live';
    } catch (_) {
      el.layer.dataset.source = 'fallback';
    }
  }

  function setModeCopy(isGulf) {
    if (!isGulf) return;
    const deck = document.getElementById('pageDeck');
    const mapTitle = document.getElementById('mapTitle');
    const mapPill = document.getElementById('mapPill');
    if (deck) deck.innerHTML = 'Watch the <strong>shipping artery empty almost overnight</strong>, while oil reroutes through the region’s emergency plumbing.';
    if (mapTitle) mapTitle.textContent = 'Hormuz ship traffic and oil routes';
    if (mapPill) mapPill.textContent = 'Daily tracked ships';
  }

  function triggerImpact(now = performance.now()) {
    if (state.suppressImpact) return;
    clearTimeout(state.impactTimer);
    state.impactReplayStart = now;
    el.layer.classList.remove('is-impact');
    void el.layer.getBBox();
    el.layer.classList.add('is-impact');
    el.layer.dataset.impact = 'true';
    state.impactTimer = setTimeout(() => {
      el.layer?.classList.remove('is-impact');
      if (el.layer) el.layer.dataset.impact = 'false';
    }, IMPACT_DURATION);
  }

  function replayRow(now) {
    if (!state.impactReplayStart) return null;
    const elapsed = now - state.impactReplayStart;
    if (elapsed >= IMPACT_DURATION) {
      state.impactReplayStart = 0;
      return null;
    }
    let step = IMPACT_SEQUENCE[0];
    for (const candidate of IMPACT_SEQUENCE) {
      if (elapsed >= candidate.after) step = candidate;
    }
    const row = state.byDate.get(step.date) || FALLBACK.find((item) => item.date === step.date);
    return row ? { ...row, held: false, impact: true } : null;
  }

  function renderTraffic(row, renderKey) {
    if (renderKey === state.currentKey) return;
    state.currentKey = renderKey;
    state.currentTotal = row.total;
    state.currentTanker = row.tanker;
    state.currentCargo = row.cargo;
    state.currentPace = row.total;
    state.targetIcons = iconCount(row.total);

    const isHeld = Boolean(row.held);
    el.number.textContent = String(Math.round(row.total));
    const pct = Math.round(row.total / PORTWATCH_BASELINE * 100);
    el.sub.textContent = isHeld
      ? `Latest published ${prettyDate(row.date)} · ${pct}% of normal`
      : `${prettyDate(row.date)} · ${pct}% of PortWatch normal`;
    el.breakdown.textContent = `tankers ${Math.round(row.tanker)} · cargo ${Math.round(row.cargo)}`;
    const width = Math.max(0, Math.min(180, 180 * row.total / PORTWATCH_BASELINE));
    el.fill.setAttribute('width', width.toFixed(1));
    el.fill.style.fill = pct < 15 ? '#ff6b6b' : pct < 45 ? '#ffd166' : '#54d2d2';

    const ratio = Math.max(0, Math.min(1, row.total / PORTWATCH_BASELINE));
    outPath.style.opacity = String(.08 + ratio * .7);
    inPath.style.opacity = String(.07 + ratio * .55);
    outPath.style.strokeWidth = String(1 + ratio * 2.7);
    inPath.style.strokeWidth = String(1 + ratio * 2.2);

    el.layer.dataset.trafficDate = row.date;
    el.layer.dataset.trafficTotal = String(Math.round(row.total));
    el.layer.dataset.trafficTanker = String(Math.round(row.tanker));
    el.layer.dataset.trafficCargo = String(Math.round(row.cargo));
    el.layer.dataset.targetShips = String(state.targetIcons);
  }

  function updateDate(now) {
    const index = Math.max(0, Number(el.timeline.value) || 0);
    const iso = isoFromIndex(index);
    const previousDate = START + state.lastTimelineIndex * DAY;
    const currentDate = START + index * DAY;
    if (previousDate < WAR && currentDate >= WAR) triggerImpact(now);
    state.lastTimelineIndex = index;

    const impactRow = replayRow(now);
    if (impactRow) {
      renderTraffic(impactRow, `impact:${impactRow.date}`);
      return;
    }
    const row = nearestPublishedRow(iso);
    renderTraffic(row, `${iso}:${row.date}:${row.held ? 'held' : 'exact'}`);
  }

  function updateShips(now) {
    const delta = Math.min(80, now - state.lastFrame) / 1000;
    state.lastFrame = now;
    const easing = 1 - Math.pow(.001, delta / .28);
    state.visualIcons += (state.targetIcons - state.visualIcons) * easing;
    const visibleCount = Math.max(0, Math.round(state.visualIcons));
    const tankerRatio = state.currentTotal > 0 ? state.currentTanker / state.currentTotal : .55;
    const visibleTankers = Math.round(visibleCount * tankerRatio);

    ships.forEach((ship, index) => {
      ship.phase = (ship.phase + delta * ship.speed) % 1;
      const visible = index < visibleCount;
      ship.group.classList.toggle('is-visible', visible);
      ship.group.classList.toggle('tanker', index < visibleTankers);
      ship.group.classList.toggle('cargo', index >= visibleTankers);
      if (!visible) return;
      const path = ship.direction > 0 ? outPath : inPath;
      const length = ship.direction > 0 ? outLength : inLength;
      const position = ship.phase * length;
      const point = path.getPointAtLength(position);
      const next = path.getPointAtLength(Math.min(length, position + 1.5));
      const angle = Math.atan2(next.y - point.y, next.x - point.x) * 180 / Math.PI;
      ship.group.setAttribute('transform', `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) rotate(${angle.toFixed(2)}) scale(.82)`);
    });

    el.layer.dataset.visibleShips = String(visibleCount);
  }

  function loop(now) {
    const isGulf = !el.map.classList.contains('hidden');
    el.layer.style.display = isGulf ? '' : 'none';
    if (el.sourceNote) el.sourceNote.style.display = isGulf ? '' : 'none';
    if (isGulf) {
      updateDate(now);
      updateShips(now);
      if (state.lastMode !== 'gulf') setTimeout(() => setModeCopy(true), 0);
      state.lastMode = 'gulf';
    } else {
      state.lastMode = 'world';
      state.lastFrame = now;
    }
    requestAnimationFrame(loop);
  }

  function pausePlayback() {
    const button = document.getElementById('playButton');
    if (button && /Pause/i.test(button.textContent || '')) button.click();
  }

  function applyQaMode() {
    const params = new URLSearchParams(location.search);
    const qaDate = params.get('qaDate');
    if (!qaDate || !/^\d{4}-\d{2}-\d{2}$/.test(qaDate)) return;
    state.qaMode = true;
    state.suppressImpact = true;
    document.documentElement.dataset.trafficQa = 'true';

    const apply = () => {
      el.timeline.value = String(indexFromIso(qaDate));
      el.timeline.dispatchEvent(new Event('input', { bubbles: true }));
      if (params.get('qaPause') === '1') pausePlayback();
      if (params.get('qaImpact') === '1') {
        state.suppressImpact = false;
        triggerImpact(performance.now());
      }
    };
    setTimeout(apply, 150);
    setTimeout(apply, 1050);
  }

  function init() {
    if (!buildLayer()) return;
    setModeCopy(true);
    loadData();
    applyQaMode();
    el.gulfMode?.addEventListener('click', () => setTimeout(() => setModeCopy(true), 0));
    requestAnimationFrame(loop);
    window.__oilAtlasTraffic = {
      getState: () => ({
        date: el.layer?.dataset.trafficDate,
        total: Number(el.layer?.dataset.trafficTotal || 0),
        visibleShips: Number(el.layer?.dataset.visibleShips || 0),
        latestDate: state.latestDate,
        source: state.source,
      }),
      triggerImpact: () => triggerImpact(performance.now()),
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
