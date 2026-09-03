(() => {
  'use strict';

  const START = Date.UTC(2025, 8, 1);
  const DAY = 86400000;
  const BASELINE = 24;
  const MAX_SCALE = 26;
  const NS = 'http://www.w3.org/2000/svg';
  const MODEL = [
    ['2025-09-01',24.1,20.9,1.3,1.2,.7],['2025-09-15',23.8,20.5,1.4,1.2,.7],
    ['2025-10-01',24.3,21.0,1.4,1.2,.7],['2025-10-15',24.0,20.7,1.4,1.2,.7],
    ['2025-11-01',23.9,20.6,1.4,1.2,.7],['2025-11-15',24.2,20.9,1.4,1.2,.7],
    ['2025-12-01',24.4,21.1,1.4,1.2,.7],['2025-12-15',24.0,20.7,1.4,1.2,.7],
    ['2026-01-01',23.8,20.5,1.4,1.2,.7],['2026-01-15',24.5,21.2,1.4,1.2,.7],
    ['2026-02-01',25.1,21.8,1.4,1.2,.7],['2026-02-15',25.6,22.3,1.4,1.2,.7],
    ['2026-02-27',25.1,21.8,1.4,1.2,.7],['2026-02-28',24.8,21.5,1.4,1.2,.7],
    ['2026-03-01',21.0,16.5,2.2,1.4,.9],['2026-03-02',17.0,10.6,3.5,1.5,1.4],
    ['2026-03-04',12.5,5.1,4.4,1.7,1.3],['2026-03-07',9.8,1.9,4.6,1.8,1.5],
    ['2026-03-15',8.6,.7,4.5,1.8,1.6],['2026-04-01',11.0,3.8,4.1,1.7,1.4],
    ['2026-04-15',10.4,3.1,4.2,1.7,1.4],['2026-05-01',10.0,2.7,4.2,1.7,1.4],
    ['2026-05-20',9.6,2.4,4.2,1.7,1.3],['2026-06-01',12.0,4.3,4.4,1.7,1.6],
    ['2026-06-17',15.5,8.0,4.4,1.7,1.4],['2026-06-30',16.1,8.8,4.3,1.7,1.3],
    ['2026-07-03',20.0,12.4,4.5,1.8,1.3],['2026-07-10',16.0,8.5,4.4,1.8,1.3],
    ['2026-07-20',13.2,5.8,4.3,1.8,1.3],['2026-07-31',12.0,4.8,4.2,1.7,1.3],
    ['2026-08-16',12.0,4.5,4.4,1.8,1.3],['2026-08-20',12.0,4.5,4.4,1.8,1.3],
  ].map(([date,value,hormuz,yanbu,fujairah,other]) => ({
    date, t: Date.parse(`${date}T00:00:00Z`), value,
    routes: { hormuz, yanbu, fujairah, other },
  }));

  const $ = (id) => document.getElementById(id);
  const state = { lastKey: '', labels: {}, ready: false };

  function svg(name, attrs = {}, parent) {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent?.appendChild(node);
    return node;
  }

  function mix(a, b, p) { return a + (b - a) * p; }
  function currentModel(date) {
    const t = date.getTime();
    if (t <= MODEL[0].t) return MODEL[0];
    if (t >= MODEL.at(-1).t) return MODEL.at(-1);
    let right = 1;
    while (right < MODEL.length && MODEL[right].t < t) right += 1;
    const a = MODEL[right - 1];
    const b = MODEL[right];
    const p = (t - a.t) / (b.t - a.t);
    return {
      date: new Date(t).toISOString().slice(0, 10),
      value: mix(a.value, b.value, p),
      routes: {
        hormuz: mix(a.routes.hormuz, b.routes.hormuz, p),
        yanbu: mix(a.routes.yanbu, b.routes.yanbu, p),
        fujairah: mix(a.routes.fujairah, b.routes.fujairah, p),
        other: mix(a.routes.other, b.routes.other, p),
      },
    };
  }

  function makeBadge(parent, id, x, y, width, title, capacity) {
    const group = svg('g', { id, class: 'smooth-route-badge', transform: `translate(${x} ${y})` }, parent);
    svg('rect', { x: 0, y: 0, width, height: 42, rx: 8 }, group);
    const t = svg('text', { class: 'smooth-route-title', x: 8, y: 14 }, group);
    t.textContent = title;
    const v = svg('text', { class: 'smooth-route-value', x: 8, y: 31 }, group);
    v.textContent = '—';
    const c = svg('text', { class: 'smooth-route-capacity', x: width - 7, y: 31, 'text-anchor': 'end' }, group);
    c.textContent = capacity;
    return { group, value: v };
  }

  function installLabels() {
    const map = $('gulfMap');
    if (!map || $('smoothOilLabels')) return;
    const layer = svg('g', { id: 'smoothOilLabels', 'aria-label': 'Modeled oil volume by export route' }, map);
    state.labels.hormuz = makeBadge(layer, 'routeBadgeHormuz', 620, 160, 151, 'STRAIT OF HORMUZ', 'modeled');
    state.labels.yanbu = makeBadge(layer, 'routeBadgeYanbu', 77, 175, 157, 'EAST–WEST → YANBU', '5.0 capacity');
    state.labels.fujairah = makeBadge(layer, 'routeBadgeFujairah', 617, 287, 165, 'HABSHAN–FUJAIRAH', '1.8 capacity');
    state.labels.other = makeBadge(layer, 'routeBadgeOther', 610, 362, 164, 'OTHER / STORAGE', 'modeled');
  }

  function route(id, value, max, minWidth, maxWidth) {
    const node = $(id);
    if (!node) return;
    const ratio = Math.max(0, Math.min(1, value / max));
    node.style.strokeWidth = `${mix(minWidth, maxWidth, ratio).toFixed(2)}px`;
    node.style.opacity = String(.16 + ratio * .84);
  }

  function updateRoutes(model) {
    const r = model.routes;
    route('hormuzRoute', r.hormuz, 22.5, 1.2, 14);
    route('eastWestRoute', r.yanbu, 5, 1.2, 10);
    route('redNorthRoute', r.yanbu * .7, 3.5, 1, 8);
    route('redSouthRoute', r.yanbu * .3, 1.5, 1, 6.5);
    route('uaeRoute', r.fujairah, 1.8, 1.2, 9);
    route('omanRoute', r.other, 1.8, 1, 6);

    if (state.labels.hormuz) state.labels.hormuz.value.textContent = `${r.hormuz.toFixed(1)}m b/d`;
    if (state.labels.yanbu) state.labels.yanbu.value.textContent = `${r.yanbu.toFixed(1)}m b/d`;
    if (state.labels.fujairah) state.labels.fujairah.value.textContent = `${r.fujairah.toFixed(1)}m b/d`;
    if (state.labels.other) state.labels.other.value.textContent = `${r.other.toFixed(1)}m b/d`;
  }

  function phaseFor(date, value) {
    const t = date.getTime();
    if (t < Date.UTC(2026,1,28)) return ['PREWAR VARIATION', 'A busy, high-volume system', `Modeled total moves around the 24.0m b/d reference average rather than sitting on one fake daily constant.`];
    if (t < Date.UTC(2026,2,8)) return ['SHOCK', 'The artery closes', `Ship traffic collapses first; modeled oil volume follows as bypass pipelines ramp hard.`];
    if (t < Date.UTC(2026,5,17)) return ['EMERGENCY PLUMBING', 'Bypasses carry the system', `Hormuz is only a fraction of normal while Yanbu and Fujairah operate near modeled capacity.`];
    if (t < Date.UTC(2026,6,8)) return ['FRAGILE REBOUND', 'Hormuz partially returns', `A reopening lifts modeled Gulf exports, but the recovery remains vulnerable.`];
    return ['UNSETTLED SYSTEM', 'A smaller, rerouted flow', `${value.toFixed(1)}m b/d modeled across Hormuz, Yanbu, Fujairah and other outlets.`];
  }

  function updateBarrel(model, date) {
    const ratio = Math.max(0, Math.min(1, model.value / MAX_SCALE));
    const surfaceY = 54 + (1 - ratio) * 320;
    $('barrelLiquid')?.setAttribute('transform', `translate(0 ${(surfaceY - 54).toFixed(2)})`);
    $('barrelCallout')?.setAttribute('transform', `translate(0 ${surfaceY.toFixed(2)})`);
    if ($('flowNumber')) $('flowNumber').textContent = model.value.toFixed(1);
    if ($('percentDisplay')) $('percentDisplay').textContent = `${Math.round(model.value / BASELINE * 100)}% of 24.0m avg`;
    if ($('benchmarkLabel')) $('benchmarkLabel').textContent = 'Modeled total Gulf oil exports';
    if ($('barrelFullValue')) $('barrelFullValue').textContent = MAX_SCALE.toFixed(1);
    if ($('barrelHalfValue')) $('barrelHalfValue').textContent = (MAX_SCALE / 2).toFixed(1);
    const gauge = $('barrelGauge');
    if (gauge) {
      const accent = ratio < .5 ? '#ff6b6b' : ratio < .75 ? '#ffd166' : '#54d2d2';
      gauge.style.setProperty('--gauge-accent', accent);
      gauge.setAttribute('aria-label', `${model.value.toFixed(1)} million barrels per day, modeled Gulf exports`);
    }
    const [kicker, title, text] = phaseFor(date, model.value);
    if ($('phaseKicker')) $('phaseKicker').textContent = kicker;
    if ($('phaseTitle')) $('phaseTitle').textContent = title;
    if ($('phaseText')) $('phaseText').textContent = text;
    if ($('phaseLongText')) $('phaseLongText').textContent = `${text} Route values are a constrained visual model, not pipeline meter readings.`;
    if ($('numberType')) $('numberType').textContent = 'Modeled daily path between published period observations';
    if ($('coreSource')) $('coreSource').textContent = 'IEA, EIA, Kpler and Vortexa anchors; EIA route capacities';
    if ($('confidence')) $('confidence').textContent = 'Highest at published windows; lower between them';
  }

  function removeUnknownLabels() {
    if (document.documentElement.classList.contains('refined-products')) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (/\bUNKNOWN\b/i.test(node.nodeValue || '')) node.nodeValue = node.nodeValue.replace(/\bUNKNOWN\b/gi, 'MODELED');
    }
  }

  function update() {
    const map = $('gulfMap');
    const timeline = $('timeline');
    if (document.documentElement.classList.contains('refined-products')) {
      state.lastKey = '';
      return;
    }
    if (!map || !timeline || map.classList.contains('hidden')) return;
    const index = Math.max(0, Number(timeline.value) || 0);
    const date = new Date(START + index * DAY);
    const key = date.toISOString().slice(0,10);
    if (key === state.lastKey) return;
    state.lastKey = key;
    const model = currentModel(date);
    updateBarrel(model, date);
    updateRoutes(model);
    document.documentElement.dataset.smoothOilDate = key;
    document.documentElement.dataset.smoothOilValue = model.value.toFixed(2);
    document.documentElement.dataset.smoothOilHormuz = model.routes.hormuz.toFixed(2);
    document.documentElement.dataset.smoothOilYanbu = model.routes.yanbu.toFixed(2);
    document.documentElement.dataset.smoothOilFujairah = model.routes.fujairah.toFixed(2);
  }

  function loop() {
    update();
    requestAnimationFrame(loop);
  }

  function init() {
    installLabels();
    removeUnknownLabels();
    const observer = new MutationObserver(removeUnknownLabels);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    requestAnimationFrame(loop);
    window.__oilAtlasSmoothOil = { modelAt: (iso) => currentModel(new Date(`${iso}T00:00:00Z`)), anchors: MODEL };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
