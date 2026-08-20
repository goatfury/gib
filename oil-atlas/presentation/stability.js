(() => {
  'use strict';

  const START = Date.UTC(2025, 8, 1);
  const DAY = 86400000;
  const OIL_BASELINE = 24;
  const TRAFFIC_NORMAL = 73;
  const QA_PAUSE = new URLSearchParams(location.search).get('qaPause') === '1';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_STYLE_PROPS = [
    'fill', 'stroke', 'stroke-width', 'paint-order', 'filter',
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'letter-spacing', 'word-spacing', 'text-transform', 'text-anchor',
    'dominant-baseline', 'alignment-baseline',
  ];
  const $ = (id) => document.getElementById(id);

  const displays = new Map();
  const state = {
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

  function isSvgText(node) {
    return Boolean(node && node.namespaceURI === SVG_NS && node.tagName?.toLowerCase() === 'text');
  }

  function createSvgMirror(source, key, scope) {
    for (const prior of document.querySelectorAll(`[data-presentation-for="${key}"]`)) prior.remove();
    const computed = getComputedStyle(source);
    const mirror = source.cloneNode(true);
    mirror.removeAttribute('id');
    mirror.removeAttribute('class');
    mirror.setAttribute('class', 'presentation-value-mirror');
    mirror.setAttribute('data-presentation-for', key);
    mirror.setAttribute('aria-hidden', 'false');
    for (const property of SVG_STYLE_PROPS) {
      const value = computed.getPropertyValue(property);
      if (value) mirror.style.setProperty(property, value);
    }
    mirror.style.setProperty('display', 'inline', 'important');
    mirror.style.setProperty('visibility', 'visible', 'important');
    mirror.style.setProperty('opacity', '1', 'important');
    mirror.style.setProperty('pointer-events', 'none', 'important');
    source.style.setProperty('opacity', '0', 'important');
    source.setAttribute('aria-hidden', 'true');
    source.parentNode?.insertBefore(mirror, source.nextSibling);
    const entry = { kind: 'svg', source, mirror, key, scope, value: null };
    displays.set(key, entry);
    return entry;
  }

  function createHtmlProxy(source, key, scope) {
    const computed = getComputedStyle(source);
    source.classList.add('presentation-text-proxy');
    source.style.setProperty('--presentation-text-color', computed.color);
    const entry = { kind: 'html', source, key, scope, value: null };
    displays.set(key, entry);
    return entry;
  }

  function ensureDisplay(source, key, scope) {
    if (!source) return null;
    let entry = displays.get(key);
    if (entry && entry.source === source) {
      if (entry.kind !== 'svg' || entry.mirror?.isConnected) {
        entry.scope = scope;
        return entry;
      }
    }
    if (entry?.kind === 'svg') entry.mirror?.remove();
    displays.delete(key);
    return isSvgText(source)
      ? createSvgMirror(source, key, scope)
      : createHtmlProxy(source, key, scope);
  }

  function setVisibleText(source, value, scope = 'common', key = source?.id) {
    if (!source || !key) return;
    const entry = ensureDisplay(source, key, scope);
    if (!entry) return;
    const text = String(value);
    if (entry.value === text) return;
    entry.value = text;
    if (entry.kind === 'svg') entry.mirror.textContent = text;
    else entry.source.dataset.presentationText = text;
  }

  function setDirectText(node, value) {
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function releaseScope(scope) {
    for (const [key, entry] of [...displays]) {
      if (entry.scope !== scope) continue;
      if (entry.kind === 'svg') {
        entry.mirror?.remove();
        entry.source?.style.removeProperty('opacity');
        entry.source?.removeAttribute('aria-hidden');
      } else {
        entry.source?.classList.remove('presentation-text-proxy');
        entry.source?.removeAttribute('data-presentation-text');
        entry.source?.style.removeProperty('--presentation-text-color');
      }
      displays.delete(key);
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
    liquid.style.setProperty('display', 'inline', 'important');
    liquid.style.setProperty('visibility', 'visible', 'important');
    liquid.style.setProperty('opacity', '1', 'important');

    const clipGroup = liquid.parentElement;
    if (clipGroup) {
      for (const child of [...clipGroup.children]) {
        if (child === liquid) continue;
        child.style.setProperty('display', 'none', 'important');
        child.setAttribute('aria-hidden', 'true');
      }
    }

    for (const node of gauge.querySelectorAll('[class*="unknown"], [class*="unmeasured"], [class*="uncertain"], [class*="model-mask"], [class*="hatch"]')) {
      if (!node.closest('defs')) node.style.setProperty('display', 'none', 'important');
    }

    for (const text of gauge.querySelectorAll('text')) {
      const value = (text.textContent || '').trim();
      if (!/^(UNKNOWN|MODELED)$/i.test(value)) continue;
      if (text.hasAttribute('data-presentation-for')) continue;
      if (['flowNumber', 'barrelUnit', 'percentDisplay'].includes(text.id)) continue;
      const group = text.closest('g');
      if (group && group.id !== 'barrelCallout') group.style.setProperty('display', 'none', 'important');
      else text.style.setProperty('display', 'none', 'important');
    }
  }

  function renderCalmDate(iso) {
    const playing = isPlaying();
    setVisibleText($('dateDisplay'), playing ? formatMonth(iso) : formatExact(iso), 'date', 'dateDisplay');
    document.documentElement.dataset.presentationDateMode = playing ? 'month' : 'exact';
  }

  function captureCommonReadout(gulf) {
    if (!gulf) {
      releaseScope('common');
      return null;
    }

    const oil = Number(document.documentElement.dataset.presentationOil);
    if (Number.isFinite(oil)) {
      setVisibleText($('flowNumber'), oil.toFixed(1), 'common', 'flowNumber');
      setVisibleText($('percentDisplay'), `${Math.round(oil / OIL_BASELINE * 100)}% of 24.0m avg`, 'common', 'percentDisplay');
    }
    setVisibleText($('barrelUnit'), 'million b/d', 'common', 'barrelUnit');
    setDirectText($('benchmarkLabel'), 'Total Gulf oil exports');
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
      hormuz: $('routeBadgeHormuz')?.querySelector('.smooth-route-value:not([data-presentation-for])'),
      yanbu: $('routeBadgeYanbu')?.querySelector('.smooth-route-value:not([data-presentation-for])'),
      fujairah: $('routeBadgeFujairah')?.querySelector('.smooth-route-value:not([data-presentation-for])'),
      other: $('routeBadgeOther')?.querySelector('.smooth-route-value:not([data-presentation-for])'),
    };

    for (const [key, node] of Object.entries(nodes)) {
      const value = Number(routes[key]);
      if (node && Number.isFinite(value)) {
        setVisibleText(node, `${(value * scale).toFixed(1)}m b/d`, 'gulf', `route-${key}`);
      }
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

    const number = layer.querySelector('.traffic-number:not([data-presentation-for])');
    setVisibleText(number, String(Math.round(total)), 'gulf', 'traffic-number');

    const mode = playing ? (layer.dataset.displayMode || 'eased-live') : 'exact';
    const trafficDate = layer.dataset.trafficDate || iso;
    const pct = Math.round(total / TRAFFIC_NORMAL * 100);
    const statusNode = layer.querySelector('#trafficCounter > text.traffic-sub[y="77"]:not([data-presentation-for])');
    const breakdownNode = layer.querySelector('#trafficCounter > text.traffic-sub[y="103"]:not([data-presentation-for])');
    if (mode.endsWith('average')) {
      const days = Number.parseInt(mode, 10) || (Date.parse(`${iso}T00:00:00Z`) < Date.UTC(2026, 1, 28) ? 7 : 3);
      setVisibleText(statusNode, `${days}-day average · ${pct}% of PortWatch normal`, 'gulf', 'traffic-sub-0');
    } else if (mode === 'eased-live') {
      setVisibleText(statusNode, `smoothed traffic pace · ${pct}% of PortWatch normal`, 'gulf', 'traffic-sub-0');
    } else {
      const held = trafficDate !== iso;
      const prefix = held ? `Latest published ${formatExact(trafficDate)}` : `${formatExact(trafficDate)} · exact day`;
      setVisibleText(statusNode, `${prefix} · ${pct}% of normal`, 'gulf', 'traffic-sub-0');
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
    setVisibleText(breakdownNode, `tankers ${tanker} · cargo ${cargo}`, 'gulf', 'traffic-sub-1');

    const fill = layer.querySelector('.traffic-normal-fill');
    if (fill) {
      const width = Math.max(0, Math.min(180, 180 * total / TRAFFIC_NORMAL));
      fill.setAttribute('width', width.toFixed(1));
    }
  }

  function refreshReadouts(now, gulf, iso) {
    const layer = $('trafficLayer');
    const impact = gulf && Boolean(layer?.classList.contains('is-impact') || layer?.dataset.impact === 'true');
    const interval = impact ? 190 : 320;

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
      if (!gulf) {
        releaseScope('gulf');
        releaseScope('common');
      }
    }

    const iso = isoAtTimeline();
    renderCalmDate(iso);
    revealOil();
    refreshReadouts(now, gulf, iso);

    document.documentElement.dataset.presentationStable = 'true';
    requestAnimationFrame(frame);
  }

  function init() {
    revealOil();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

/* presentation-stability: visible oil, month-level playback date, and throttled readouts */
