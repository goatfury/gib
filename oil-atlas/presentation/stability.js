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
    const flow = $('flowNumber');
    const unit = $('barrelUnit');
    const percent = $('percentDisplay');
    const label = $('benchmarkLabel');

    if (gulf) {
      const oil = Number(document.documentElement.dataset.presentationOil);
      if (Number.isFinite(oil)) {
        ownText(flow, oil.toFixed(1), 'common');
        ownText(percent, `${Math.round(oil / OIL_BASELINE * 100)}% of 24.0m avg`, 'common');
      } else if (flow) {
        ownText(flow, flow.textContent || '', 'common');
        if (percent) ownText(percent, percent.textContent || '', 'common');
      }
      ownText(unit, 'million b/d', 'common');
      ownText(label, 'Total Gulf oil exports', 'common');
      return;
    }

    for (const node of [flow, unit, percent, label]) {
      if (node) ownText(node, node.textContent || '', 'common');
    }
  }

  function captureGulfReadout() {
    const layer = $('trafficLayer');
    if (!layer) return;

    const traffic = Number(layer.dataset.displayTraffic);
    const number = layer.querySelector('.traffic-number');
    if (Number.isFinite(traffic)) ownText(number, String(Math.max(0, Math.round(traffic))), 'gulf');
    else if (number) ownText(number, number.textContent || '', 'gulf');

    for (const node of layer.querySelectorAll('.traffic-sub')) {
      ownText(node, node.textContent || '', 'gulf');
    }

    for (const node of document.querySelectorAll('.smooth-route-value')) {
      ownText(node, node.textContent || '', 'gulf');
    }

    const fill = layer.querySelector('.traffic-normal-fill');
    if (fill && Number.isFinite(traffic)) {
      const width = Math.max(0, Math.min(180, 180 * traffic / TRAFFIC_NORMAL));
      fill.setAttribute('width', width.toFixed(1));
    }
  }

  function refreshReadouts(now, gulf) {
    const layer = $('trafficLayer');
    const impact = gulf && Boolean(layer?.classList.contains('is-impact') || layer?.dataset.impact === 'true');
    const interval = impact ? 140 : 260;

    if (isPlaying() && now < state.nextReadoutAt) return;
    state.nextReadoutAt = now + interval;

    captureCommonReadout(gulf);
    if (gulf) captureGulfReadout();
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

    renderCalmDate(isoAtTimeline());
    revealOil();
    refreshReadouts(now, gulf);

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
