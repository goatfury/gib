(() => {
  'use strict';

  const START = Date.UTC(2025, 8, 1);
  const DAY = 86400000;
  const OIL_BASELINE = 24;
  const TRAFFIC_NORMAL = 73;
  const QA_PAUSE = new URLSearchParams(location.search).get('qaPause') === '1';
  const $ = (id) => document.getElementById(id);

  const owned = new Map();
  const state = {
    enforcing: false,
    nextReadoutAt: 0,
    lastMode: '',
  };

  function isPlaying() {
    return document.documentElement.classList.contains('is-playing');
  }

  function isGulf() {
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

  function ownText(node, text, scope = 'common') {
    if (!node) return;
    const value = String(text);
    owned.set(node, { value, scope });
    if (node.textContent !== value) node.textContent = value;
  }

  function releaseScope(scope) {
    for (const [node, entry] of [...owned]) {
      if (entry.scope === scope) owned.delete(node);
    }
  }

  function enforceQaPause() {
    if (!QA_PAUSE) return;
    const button = $('playButton');
    if (button && /Pause/i.test(button.textContent || '')) button.click();
  }

  function revealOil() {
    if (!isGulf()) return;
    const gauge = $('barrelGauge');
    const liquid = $('barrelLiquid');
    if (!gauge || !liquid) return;

    gauge.dataset.oilVisible = 'true';
    liquid.style.display = 'inline';
    liquid.style.visibility = 'visible';
    liquid.style.opacity = '1';

    const clipGroup = liquid.parentElement;
    if (clipGroup) {
      for (const child of [...clipGroup.children]) {
        if (child === liquid) continue;
        child.style.display = 'none';
        child.setAttribute('aria-hidden', 'true');
      }
    }

    for (const node of gauge.querySelectorAll('[class*="unknown"], [class*="unmeasured"], [class*="uncertain"], [class*="model-mask"], [class*="hatch"]')) {
      if (!node.closest('defs')) node.style.display = 'none';
    }

    for (const text of gauge.querySelectorAll('text')) {
      const value = (text.textContent || '').trim();
      if (!/^(UNKNOWN|MODELED)$/i.test(value)) continue;
      if (['flowNumber', 'barrelUnit', 'percentDisplay'].includes(text.id)) continue;
      const group = text.closest('g');
      if (group && group.id !== 'barrelCallout') group.style.display = 'none';
      else text.style.display = 'none';
    }
  }

  function enforceOwnedText() {
    if (state.enforcing) return;
    state.enforcing = true;
    try {
      for (const [node, entry] of [...owned]) {
        if (!node.isConnected) {
          owned.delete(node);
          continue;
        }
        if (node.textContent !== entry.value) node.textContent = entry.value;
      }
      revealOil();
    } finally {
      state.enforcing = false;
    }
  }

  function renderCalmDate(iso) {
    const playing = isPlaying();
    ownText($('dateDisplay'), playing ? formatMonth(iso) : formatExact(iso), 'date');
    document.documentElement.dataset.presentationDateMode = playing ? 'month' : 'exact';
  }

  function captureCommonReadout(gulf) {
    if (!gulf) {
      releaseScope('common');
      return null;
    }

    const flow = $('flowNumber');
    const unit = $('barrelUnit');
    const percent = $('percentDisplay');
    const label = $('benchmarkLabel');
    const oil = Number(document.documentElement.dataset.presentationOil);

    if (Number.isFinite(oil)) {
      ownText(flow, oil.toFixed(1), 'common');
      ownText(percent, `${Math.round(oil / OIL_BASELINE * 100)}% of 24.0m avg`, 'common');
    }
    ownText(unit, 'million b/d', 'common');
    ownText(label, 'Total Gulf oil exports', 'common');
    return Number.isFinite(oil) ? oil : null;
  }

  function captureRouteReadouts(iso, displayedOil) {
    const model = window.__oilAtlasSmoothOil?.modelAt?.(iso);
    if (!model?.routes) return;

    const routes = model.routes;
    const rawTotal = ['hormuz', 'yanbu', 'fujairah', 'other']
      .reduce((sum, key) => sum + (Number(routes[key]) || 0), 0);
    const scale = Number.isFinite(displayedOil) && rawTotal > 0 ? displayedOil / rawTotal : 1;
    const nodes = {
      hormuz: $('routeBadgeHormuz')?.querySelector('.smooth-route-value'),
      yanbu: $('routeBadgeYanbu')?.querySelector('.smooth-route-value'),
      fujairah: $('routeBadgeFujairah')?.querySelector('.smooth-route-value'),
      other: $('routeBadgeOther')?.querySelector('.smooth-route-value'),
    };

    for (const [key, node] of Object.entries(nodes)) {
      const value = Number(routes[key]);
      if (node && Number.isFinite(value)) ownText(node, `${(value * scale).toFixed(1)}m b/d`, 'gulf');
    }
  }

  function captureTrafficReadout(iso) {
    const layer = $('trafficLayer');
    if (!layer) return;

    const playing = isPlaying();
    const exactTanker = Math.max(0, Number(layer.dataset.trafficTanker) || 0);
    const exactCargo = Math.max(0, Number(layer.dataset.trafficCargo) || 0);
    const exactTotal = exactTanker + exactCargo;
    const easedTraffic = Number(layer.dataset.displayTraffic);
    const total = playing && Number.isFinite(easedTraffic)
      ? Math.max(0, easedTraffic)
      : exactTotal;
    const number = layer.querySelector('.traffic-number');
    ownText(number, String(Math.round(total)), 'gulf');

    const mode = playing
      ? (layer.dataset.displayMode || 'eased-live')
      : 'exact';
    const trafficDate = layer.dataset.trafficDate || iso;
    const pct = Math.round(total / TRAFFIC_NORMAL * 100);
    const sub = layer.querySelectorAll('.traffic-sub')[0];
    if (mode.endsWith('average')) {
      const days = Number.parseInt(mode, 10) || (Date.parse(`${iso}T00:00:00Z`) < Date.UTC(2026, 1, 28) ? 7 : 3);
      ownText(sub, `${days}-day average · ${pct}% of PortWatch normal`, 'gulf');
    } else if (mode === 'eased-live') {
      ownText(sub, `smoothed traffic pace · ${pct}% of PortWatch normal`, 'gulf');
    } else {
      const held = trafficDate !== iso;
      const prefix = held ? `Latest published ${formatExact(trafficDate)}` : `${formatExact(trafficDate)} · exact day`;
      ownText(sub, `${prefix} · ${pct}% of normal`, 'gulf');
    }

    let tanker;
    let cargo;
    if (!playing) {
      tanker = Math.round(exactTanker);
      cargo = Math.round(exactCargo);
    } else {
      const ratio = exactTotal > 0 ? exactTanker / exactTotal : .5;
      tanker = Math.round(total * ratio);
      cargo = Math.max(0, Math.round(total) - tanker);
    }
    const breakdown = layer.querySelectorAll('.traffic-sub')[1];
    ownText(breakdown, `tankers ${tanker} · cargo ${cargo}`, 'gulf');

    const fill = layer.querySelector('.traffic-normal-fill');
    if (fill) {
      const width = Math.max(0, Math.min(180, 180 * total / TRAFFIC_NORMAL));
      fill.setAttribute('width', width.toFixed(1));
    }
  }

  function refreshReadouts(now, gulf, iso) {
    const layer = $('trafficLayer');
    const impact = gulf && Boolean(layer?.classList.contains('is-impact') || layer?.dataset.impact === 'true');
    const interval = impact ? 140 : 260;

    if (isPlaying() && now < state.nextReadoutAt) return;
    state.nextReadoutAt = now + interval;

    const displayedOil = captureCommonReadout(gulf);
    if (!gulf) return;
    captureTrafficReadout(iso);
    captureRouteReadouts(iso, displayedOil);
  }

  function frame(now) {
    enforceQaPause();

    const gulf = isGulf();
    const mode = gulf ? 'gulf' : 'world';
    if (mode !== state.lastMode) {
      state.lastMode = mode;
      state.nextReadoutAt = 0;
      if (!gulf) releaseScope('gulf');
    }

    const iso = isoAtTimeline();
    renderCalmDate(iso);
    revealOil();
    refreshReadouts(now, gulf, iso);

    document.documentElement.dataset.presentationStable = 'true';
    requestAnimationFrame(frame);
  }

  function init() {
    const root = document.body || document.documentElement;
    if (!root) return;

    const observer = new MutationObserver(enforceOwnedText);
    observer.observe(root, { subtree: true, childList: true, characterData: true });

    revealOil();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

/* presentation-stability: visible oil, month-level playback date, and throttled readouts */
