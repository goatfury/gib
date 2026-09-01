(() => {
  'use strict';

  const START = Date.UTC(2025, 8, 1);
  const WAR = Date.UTC(2026, 1, 28);
  const DAY = 86400000;
  const OIL_BASELINE = 24;
  const OIL_SCALE = 26;
  const TRAFFIC_NORMAL = 73;
  const $ = (id) => document.getElementById(id);

  const state = {
    lastFrame: performance.now(),
    oil: null,
    routes: null,
    traffic: null,
    trafficRows: [],
    trafficByDate: new Map(),
  };

  function isPlaying() {
    return document.documentElement.classList.contains('is-playing');
  }

  function isGulf() {
    if (document.documentElement.classList.contains('refined-products')) return false;
    const map = $('gulfMap');
    return Boolean(map && !map.classList.contains('hidden'));
  }

  function isoAtTimeline() {
    const index = Math.max(0, Number($('timeline')?.value) || 0);
    return new Date(START + index * DAY).toISOString().slice(0, 10);
  }

  function dateFromIso(iso) {
    return new Date(`${iso}T00:00:00Z`);
  }

  function formatExact(iso) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }).format(dateFromIso(iso));
  }

  function formatMonth(iso) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(dateFromIso(iso));
  }

  function approach(current, target, deltaSeconds, tauSeconds) {
    if (!Number.isFinite(current)) return target;
    const amount = 1 - Math.exp(-deltaSeconds / Math.max(.001, tauSeconds));
    return current + (target - current) * amount;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function concealBarrelMask() {
    const gauge = $('barrelGauge');
    const liquid = $('barrelLiquid');
    if (!gauge || !liquid) return;

    if (gauge.dataset.oilVisible !== 'true') gauge.dataset.oilVisible = 'true';
    if (liquid.style.display !== 'inline') liquid.style.display = 'inline';
    if (liquid.style.visibility !== 'visible') liquid.style.visibility = 'visible';
    if (liquid.style.opacity !== '1') liquid.style.opacity = '1';

    // Keep the evidence in Data, but never cover the barrel itself. Inside this
    // clip, the only presentation layer retained is the actual oil group.
    const clipGroup = liquid.parentElement;
    if (clipGroup) {
      for (const child of [...clipGroup.children]) {
        if (child !== liquid && child.style.display !== 'none') {
          child.style.display = 'none';
          child.setAttribute('aria-hidden', 'true');
        }
      }
    }

    for (const node of gauge.querySelectorAll('[class*="unknown"], [class*="unmeasured"], [class*="uncertain"], [class*="model-mask"], [class*="hatch"]')) {
      if (!node.closest('defs') && node.style.display !== 'none') node.style.display = 'none';
    }

    for (const text of gauge.querySelectorAll('text')) {
      const value = (text.textContent || '').trim();
      if (/^(UNKNOWN|MODELED)$/i.test(value) && !['flowNumber', 'barrelUnit', 'percentDisplay'].includes(text.id)) {
        const group = text.closest('g');
        if (group && group.id !== 'barrelCallout') group.style.display = 'none';
        else text.style.display = 'none';
      }
    }
  }

  function oilTarget(iso) {
    const model = window.__oilAtlasSmoothOil?.modelAt?.(iso);
    if (!model || !Number.isFinite(model.value)) return null;
    return model;
  }

  function renderOil(target, iso, deltaSeconds) {
    if (!target || !isGulf()) return;

    if (!Number.isFinite(state.oil)) {
      state.oil = target.value;
      state.routes = { ...target.routes };
    }

    const tau = isPlaying() ? .34 : .13;
    state.oil = approach(state.oil, target.value, deltaSeconds, tau);
    for (const key of ['hormuz', 'yanbu', 'fujairah', 'other']) {
      state.routes[key] = approach(state.routes[key], target.routes[key], deltaSeconds, tau);
    }

    const ratio = Math.max(0, Math.min(1, state.oil / OIL_SCALE));
    const surfaceY = 54 + (1 - ratio) * 320;
    const liquid = $('barrelLiquid');
    const callout = $('barrelCallout');
    if (liquid) liquid.setAttribute('transform', `translate(0 ${(surfaceY - 54).toFixed(2)})`);
    if (callout) callout.setAttribute('transform', `translate(0 ${surfaceY.toFixed(2)})`);

    setText($('flowNumber'), state.oil.toFixed(1));
    setText($('barrelUnit'), 'million b/d');
    setText($('percentDisplay'), `${Math.round(state.oil / OIL_BASELINE * 100)}% of 24.0m avg`);
    setText($('benchmarkLabel'), 'Total Gulf oil exports');

    const gauge = $('barrelGauge');
    if (gauge) {
      const accent = ratio < .5 ? '#ff6b6b' : ratio < .75 ? '#ffd166' : '#54d2d2';
      gauge.style.setProperty('--gauge-accent', accent);
      gauge.setAttribute('aria-label', `${state.oil.toFixed(1)} million barrels per day, modeled Gulf exports`);
    }

    const labels = {
      hormuz: $('routeBadgeHormuz')?.querySelector('.smooth-route-value'),
      yanbu: $('routeBadgeYanbu')?.querySelector('.smooth-route-value'),
      fujairah: $('routeBadgeFujairah')?.querySelector('.smooth-route-value'),
      other: $('routeBadgeOther')?.querySelector('.smooth-route-value'),
    };
    for (const key of Object.keys(labels)) setText(labels[key], `${state.routes[key].toFixed(1)}m b/d`);

    document.documentElement.dataset.presentationOil = state.oil.toFixed(2);
    document.documentElement.dataset.presentationIso = iso;
  }

  async function loadTrafficRows() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5500);
      const response = await fetch('/api/hormuz_traffic', { cache: 'no-store', signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.records)) return;
      state.trafficRows = data.records
        .map((row) => ({
          date: String(row.date || '').slice(0, 10),
          total: Number(row.total ?? row.n_total),
          tanker: Number(row.tanker ?? row.n_tanker),
          cargo: Number(row.cargo ?? row.n_cargo),
        }))
        .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.total))
        .sort((a, b) => a.date.localeCompare(b.date));
      state.trafficByDate = new Map(state.trafficRows.map((row) => [row.date, row]));
    } catch (_) {
      // The ship layer retains its own dated fallback. Presentation smoothing
      // falls back to the values already rendered there.
    }
  }

  function nearestTrafficRow(iso) {
    const exact = state.trafficByDate.get(iso);
    if (exact) return { ...exact, held: false };
    for (let i = state.trafficRows.length - 1; i >= 0; i -= 1) {
      if (state.trafficRows[i].date <= iso) return { ...state.trafficRows[i], held: true };
    }
    return null;
  }

  function averagedTraffic(iso, days) {
    if (!state.trafficRows.length) return null;
    const end = Date.parse(`${iso}T00:00:00Z`);
    const start = end - (days - 1) * DAY;
    const rows = state.trafficRows.filter((row) => {
      const time = Date.parse(`${row.date}T00:00:00Z`);
      return time >= start && time <= end;
    });
    if (!rows.length) return nearestTrafficRow(iso);
    const sum = rows.reduce((acc, row) => ({
      total: acc.total + row.total,
      tanker: acc.tanker + row.tanker,
      cargo: acc.cargo + row.cargo,
    }), { total: 0, tanker: 0, cargo: 0 });
    return {
      date: iso,
      total: sum.total / rows.length,
      tanker: sum.tanker / rows.length,
      cargo: sum.cargo / rows.length,
      count: rows.length,
      held: false,
    };
  }

  function trafficTarget(iso) {
    const layer = $('trafficLayer');
    if (!layer) return null;
    const impact = layer.classList.contains('is-impact') || layer.dataset.impact === 'true';

    if (impact) {
      return {
        date: iso,
        total: Number(layer.dataset.trafficTotal || 0),
        tanker: Number(layer.dataset.trafficTanker || 0),
        cargo: Number(layer.dataset.trafficCargo || 0),
        mode: 'impact-exact',
        days: 1,
        held: false,
      };
    }

    if (!isPlaying()) {
      const exact = nearestTrafficRow(iso);
      if (exact) return { ...exact, mode: 'exact', days: 1 };
      return {
        date: iso,
        total: Number(layer.dataset.trafficTotal || 0),
        tanker: Number(layer.dataset.trafficTanker || 0),
        cargo: Number(layer.dataset.trafficCargo || 0),
        mode: 'exact',
        days: 1,
        held: false,
      };
    }

    const days = Date.parse(`${iso}T00:00:00Z`) < WAR ? 7 : 3;
    const average = averagedTraffic(iso, days);
    if (average) return { ...average, mode: `${days}-day-average`, days };
    return {
      date: iso,
      total: Number(layer.dataset.trafficTotal || 0),
      tanker: Number(layer.dataset.trafficTanker || 0),
      cargo: Number(layer.dataset.trafficCargo || 0),
      mode: 'eased-live',
      days,
      held: false,
    };
  }

  function renderTraffic(target, iso, deltaSeconds) {
    const layer = $('trafficLayer');
    if (!target || !layer || !isGulf()) return;

    if (!state.traffic) state.traffic = { total: target.total, tanker: target.tanker, cargo: target.cargo };
    const fastImpact = target.mode === 'impact-exact';
    const tau = fastImpact ? .075 : isPlaying() ? .3 : .11;
    for (const key of ['total', 'tanker', 'cargo']) {
      state.traffic[key] = approach(state.traffic[key], target[key], deltaSeconds, tau);
    }

    const number = layer.querySelector('.traffic-number');
    const sub = layer.querySelectorAll('.traffic-sub')[0];
    const breakdown = layer.querySelectorAll('.traffic-sub')[1];
    const fill = layer.querySelector('.traffic-normal-fill');
    const shown = Math.max(0, Math.round(state.traffic.total));
    setText(number, String(shown));

    const pct = Math.round(state.traffic.total / TRAFFIC_NORMAL * 100);
    if (target.mode === 'exact' || target.mode === 'impact-exact') {
      const dateLabel = target.held ? `Latest published ${formatExact(target.date)}` : `${formatExact(target.date)} · exact day`;
      setText(sub, `${dateLabel} · ${pct}% of normal`);
    } else if (target.mode.endsWith('average')) {
      setText(sub, `${target.days}-day average · ${pct}% of PortWatch normal`);
    } else {
      setText(sub, `smoothed traffic pace · ${pct}% of PortWatch normal`);
    }
    setText(breakdown, `tankers ${Math.max(0, Math.round(state.traffic.tanker))} · cargo ${Math.max(0, Math.round(state.traffic.cargo))}`);

    if (fill) {
      const width = Math.max(0, Math.min(180, 180 * state.traffic.total / TRAFFIC_NORMAL));
      fill.setAttribute('width', width.toFixed(1));
      fill.style.fill = pct < 15 ? '#ff6b6b' : pct < 45 ? '#ffd166' : '#54d2d2';
    }

    layer.dataset.displayMode = target.mode;
    layer.dataset.displayTraffic = state.traffic.total.toFixed(2);
  }

  function renderCalmDate(iso) {
    setText($('dateDisplay'), isPlaying() ? formatMonth(iso) : formatExact(iso));
    document.documentElement.dataset.presentationDateMode = isPlaying() ? 'month' : 'exact';
  }

  function frame(now) {
    const deltaSeconds = Math.min(.1, Math.max(0, now - state.lastFrame) / 1000);
    state.lastFrame = now;
    const iso = isoAtTimeline();
    const gulf = isGulf();

    concealBarrelMask();
    renderCalmDate(iso);

    if (gulf) {
      renderOil(oilTarget(iso), iso, deltaSeconds);
      renderTraffic(trafficTarget(iso), iso, deltaSeconds);
      document.documentElement.dataset.presentationMode = 'gulf';
    } else {
      document.documentElement.dataset.presentationMode = 'world';
    }

    document.documentElement.dataset.presentationReady = 'true';
    requestAnimationFrame(frame);
  }

  function init() {
    concealBarrelMask();
    loadTrafficRows();
    requestAnimationFrame(frame);
    window.__oilAtlasPresentation = {
      getState: () => ({
        iso: isoAtTimeline(),
        oil: state.oil,
        traffic: state.traffic?.total,
        trafficMode: $('trafficLayer')?.dataset.displayMode,
        oilVisible: $('barrelGauge')?.dataset.oilVisible === 'true',
      }),
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
