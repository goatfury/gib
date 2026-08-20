import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const sourceDir = resolve(root, 'presentation');
const htmlPath = resolve(publicDir, 'index.html');
const publicScriptPath = resolve(publicDir, 'presentation.js');
const publicCssPath = resolve(publicDir, 'presentation.css');

await copyFile(resolve(sourceDir, 'presentation.css'), publicCssPath);
await copyFile(resolve(sourceDir, 'presentation.js'), publicScriptPath);

const calmPhaseCss = String.raw`
/* The main Hormuz explanation is a placard, not a ticker. */
#calmPhaseCard {
  box-sizing: border-box;
  width: 100%;
  min-height: 112px;
  padding: 15px 16px 14px;
  overflow: hidden;
  border-top: 1px solid rgba(113, 155, 184, .22);
  background: rgba(5, 20, 32, .985);
  color: #eef7ff;
}
#calmPhaseCard[hidden] {
  display: none !important;
}
#calmPhaseCard .calm-phase-inner {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 480ms ease, transform 480ms ease;
  will-change: opacity, transform;
}
#calmPhaseCard .calm-phase-inner.is-changing {
  opacity: 0;
  transform: translateY(5px);
}
#calmPhaseCard .calm-phase-kicker {
  margin: 0 0 5px;
  color: #ffd166;
  font-size: .77rem;
  font-weight: 900;
  letter-spacing: .105em;
  line-height: 1.15;
  text-transform: uppercase;
}
#calmPhaseCard .calm-phase-title {
  margin: 0 0 4px;
  color: #f4f8fc;
  font-size: clamp(1.03rem, 1.55vw, 1.28rem);
  font-weight: 850;
  letter-spacing: -.02em;
  line-height: 1.08;
}
#calmPhaseCard .calm-phase-body {
  margin: 0;
  max-width: 44rem;
  color: #bfd0df;
  font-size: .84rem;
  line-height: 1.35;
}
@media (max-width: 1080px) and (min-width: 821px) {
  #calmPhaseCard {
    min-height: 98px;
    padding: 11px 13px 10px;
  }
  #calmPhaseCard .calm-phase-kicker {
    margin-bottom: 3px;
    font-size: .65rem;
  }
  #calmPhaseCard .calm-phase-title {
    margin-bottom: 3px;
    font-size: .98rem;
  }
  #calmPhaseCard .calm-phase-body {
    font-size: .73rem;
    line-height: 1.28;
  }
}
@media (prefers-reduced-motion: reduce) {
  #calmPhaseCard .calm-phase-inner {
    transition: none;
  }
}
`;
const publicCss = await readFile(publicCssPath, 'utf8');
await writeFile(publicCssPath, `${publicCss}\n${calmPhaseCss}\n`, 'utf8');

// Append the stability layer after the base presentation code so it can own the
// final visible text without changing the underlying oil or traffic calculations.
const publicScript = await readFile(publicScriptPath, 'utf8');
const stabilityScript = await readFile(resolve(sourceDir, 'stability.js'), 'utf8');

// The reconstructed atlas and the presentation layer both know how to position
// the Hormuz barrel. Allowing both to write the same SVG transforms caused the
// visible oil and callout to snap between two positions. This final layer claims
// those two transforms and becomes their only visible writer. It reads the
// already-smoothed presentation value, then eases the actual SVG position on
// every animation frame. World mode is untouched.
const singleOwnerMotionScript = String.raw`
;(() => {
  'use strict';

  const OIL_SCALE = 26;
  const root = document.documentElement;
  let liquidClaim = null;
  let calloutClaim = null;
  let visualOil = Number.NaN;
  let lastFrame = performance.now();

  function isPlaying() {
    return root.classList.contains('is-playing')
      || /Pause/i.test(document.getElementById('playButton')?.textContent || '');
  }

  function claimTransform(id) {
    const node = document.getElementById(id);
    if (!node) return null;
    if (node.dataset.presentationMotionOwned === 'true' && node.__presentationSetTransform) {
      return { node, setTransform: node.__presentationSetTransform };
    }

    const nativeSetAttribute = Element.prototype.setAttribute.bind(node);
    const nativeSetAttributeNS = Element.prototype.setAttributeNS.bind(node);
    const nativeRemoveAttribute = Element.prototype.removeAttribute.bind(node);

    Object.defineProperty(node, 'setAttribute', {
      configurable: true,
      value(name, value) {
        if (String(name).toLowerCase() === 'transform') return;
        return nativeSetAttribute(name, value);
      },
    });
    Object.defineProperty(node, 'setAttributeNS', {
      configurable: true,
      value(namespace, name, value) {
        if (String(name).toLowerCase() === 'transform') return;
        return nativeSetAttributeNS(namespace, name, value);
      },
    });
    Object.defineProperty(node, 'removeAttribute', {
      configurable: true,
      value(name) {
        if (String(name).toLowerCase() === 'transform') return;
        return nativeRemoveAttribute(name);
      },
    });

    const setTransform = (value) => nativeSetAttribute('transform', value);
    Object.defineProperty(node, '__presentationSetTransform', {
      configurable: true,
      value: setTransform,
    });
    node.dataset.presentationMotionOwned = 'true';
    return { node, setTransform };
  }

  function ensureClaims() {
    liquidClaim ||= claimTransform('barrelLiquid');
    calloutClaim ||= claimTransform('barrelCallout');
    return Boolean(liquidClaim && calloutClaim);
  }

  function frame(now) {
    const deltaSeconds = Math.min(.08, Math.max(0, now - lastFrame) / 1000);
    lastFrame = now;

    if (ensureClaims()) {
      const targetOil = Number(root.dataset.presentationOil);
      if (Number.isFinite(targetOil)) {
        if (!Number.isFinite(visualOil)) visualOil = targetOil;
        const tau = isPlaying() ? .62 : .12;
        const amount = 1 - Math.exp(-deltaSeconds / tau);
        visualOil += (targetOil - visualOil) * amount;

        const ratio = Math.max(0, Math.min(1, visualOil / OIL_SCALE));
        const surfaceY = 54 + (1 - ratio) * 320;
        liquidClaim.setTransform('translate(0 ' + (surfaceY - 54).toFixed(2) + ')');
        calloutClaim.setTransform('translate(0 ' + surfaceY.toFixed(2) + ')');
        root.dataset.presentationMotionOwner = 'single';
        root.dataset.presentationVisualOil = visualOil.toFixed(3);
      }
    }

    requestAnimationFrame(frame);
  }

  function init() {
    ensureClaims();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
`;

// The original lower-right narrative rewrote itself on nearly every timeline
// step. Hide that live ticker in Hormuz mode and replace it with a stable phase
// placard. The placard changes only at broad turning points, holds long enough to
// read, and crossfades once. World mode keeps its original card untouched.
const calmPhaseCardScript = String.raw`
;(() => {
  'use strict';

  const START = Date.UTC(2025, 8, 1);
  const DAY = 86400000;
  const HOLD_MS = 5500;
  const FADE_MS = 480;
  const root = document.documentElement;
  const phases = [
    {
      key: 'normal',
      start: '0000-01-01',
      kicker: 'Normal flow',
      title: 'Hormuz carries the system',
      body: 'Commercial traffic and regional oil exports remain near their prewar baseline.',
    },
    {
      key: 'shock',
      start: '2026-02-28',
      kicker: 'Closure shock',
      title: 'The shipping artery empties',
      body: 'Traffic collapses in days; bypass routes cannot replace the lost strait capacity.',
    },
    {
      key: 'plumbing',
      start: '2026-03-16',
      kicker: 'Emergency plumbing',
      title: 'Bypasses carry what they can',
      body: 'Yanbu, Fujairah, and other routes absorb part of the loss while Hormuz remains constrained.',
    },
    {
      key: 'rebound',
      start: '2026-06-01',
      kicker: 'Partial rebound',
      title: 'Exports recover unevenly',
      body: 'More oil gets out, but the route mix remains far from normal.',
    },
    {
      key: 'fragile',
      start: '2026-07-10',
      kicker: 'Fragile recovery',
      title: 'The system keeps adapting',
      body: 'Flows continue through a mix of Hormuz and bypass routes, still below the prewar benchmark.',
    },
  ];

  let original = null;
  let originalInlineDisplay = '';
  let card = null;
  let inner = null;
  let kicker = null;
  let title = null;
  let body = null;
  let currentKey = '';
  let queuedPhase = null;
  let lastSwapAt = 0;
  let swapTimer = 0;
  let settleTimer = 0;

  function isPlaying() {
    return root.classList.contains('is-playing')
      || /Pause/i.test(document.getElementById('playButton')?.textContent || '');
  }

  function isGulf() {
    const map = document.getElementById('gulfMap');
    return Boolean(map && !map.classList.contains('hidden'));
  }

  function isoAtTimeline() {
    const index = Math.max(0, Number(document.getElementById('timeline')?.value) || 0);
    return new Date(START + index * DAY).toISOString().slice(0, 10);
  }

  function phaseFor(iso) {
    let selected = phases[0];
    for (const phase of phases) {
      if (iso >= phase.start) selected = phase;
    }
    return selected;
  }

  function isPlausibleNarrative(node, gaugeRect, panelRect) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.id === 'calmPhaseCard' || node.contains(document.getElementById('barrelGauge'))) return false;
    if (node.matches('script, style, button, input, dialog') || node.querySelector('svg, canvas, button, input')) return false;
    const rect = node.getBoundingClientRect();
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 18 || text.length > 520) return false;
    if (rect.width < panelRect.width * .58 || rect.height < 52 || rect.height > 230) return false;
    if (rect.top < gaugeRect.bottom - 32 || rect.bottom > panelRect.bottom + 6) return false;
    return true;
  }

  function findPanel(gauge) {
    const gaugeRect = gauge.getBoundingClientRect();
    let node = gauge.parentElement;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      const containsDataButton = [...node.querySelectorAll('button')]
        .some((button) => /data/i.test((button.textContent || '').trim()));
      if (rect.width >= gaugeRect.width * .85
          && rect.width <= 620
          && rect.height >= gaugeRect.height + 80
          && containsDataButton) return node;
      node = node.parentElement;
    }
    return gauge.parentElement;
  }

  function findOriginalNarrative() {
    const gauge = document.getElementById('barrelGauge');
    if (!gauge) return null;
    const gaugeBox = gauge.closest('svg') || gauge;
    const panel = findPanel(gauge);
    if (!panel) return null;
    const gaugeRect = gaugeBox.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    const direct = [
      gaugeBox.nextElementSibling,
      gaugeBox.parentElement?.nextElementSibling,
    ].filter(Boolean);
    for (const candidate of direct) {
      if (isPlausibleNarrative(candidate, gaugeRect, panelRect)) return candidate;
    }

    const candidates = [...panel.querySelectorAll('div, section, aside, footer')]
      .filter((node) => isPlausibleNarrative(node, gaugeRect, panelRect))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        const aText = (a.textContent || '').toLowerCase();
        const bText = (b.textContent || '').toLowerCase();
        const aBoost = /shock|plumbing|flow|export|recovery|baseline|period estimate/.test(aText) ? -100000 : 0;
        const bBoost = /shock|plumbing|flow|export|recovery|baseline|period estimate/.test(bText) ? -100000 : 0;
        return (aRect.width * aRect.height + aBoost) - (bRect.width * bRect.height + bBoost);
      });
    return candidates[0] || null;
  }

  function createCard() {
    if (card?.isConnected) return true;
    original = findOriginalNarrative();
    if (!original?.parentElement) return false;

    originalInlineDisplay = original.style.display || '';
    card = document.createElement('div');
    card.id = 'calmPhaseCard';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    card.setAttribute('aria-atomic', 'true');
    card.innerHTML = '<div class="calm-phase-inner">'
      + '<div class="calm-phase-kicker"></div>'
      + '<div class="calm-phase-title"></div>'
      + '<p class="calm-phase-body"></p>'
      + '</div>';
    original.parentElement.insertBefore(card, original);
    inner = card.querySelector('.calm-phase-inner');
    kicker = card.querySelector('.calm-phase-kicker');
    title = card.querySelector('.calm-phase-title');
    body = card.querySelector('.calm-phase-body');
    root.dataset.phaseCardCalm = 'true';
    return true;
  }

  function hideOriginal(gulf) {
    if (!original) return;
    if (gulf) {
      original.style.setProperty('display', 'none', 'important');
      original.setAttribute('aria-hidden', 'true');
    } else {
      if (originalInlineDisplay) original.style.setProperty('display', originalInlineDisplay);
      else original.style.removeProperty('display');
      original.removeAttribute('aria-hidden');
    }
  }

  function writePhase(phase) {
    if (!phase || phase.key === currentKey || !inner) return;
    clearTimeout(swapTimer);
    inner.classList.add('is-changing');
    swapTimer = window.setTimeout(() => {
      kicker.textContent = phase.kicker;
      title.textContent = phase.title;
      body.textContent = phase.body;
      currentKey = phase.key;
      lastSwapAt = performance.now();
      queuedPhase = null;
      requestAnimationFrame(() => inner.classList.remove('is-changing'));
    }, currentKey ? FADE_MS : 0);
  }

  function requestPhase(phase, now, immediate = false) {
    if (!phase || phase.key === currentKey) return;
    if (!immediate && currentKey && isPlaying() && now - lastSwapAt < HOLD_MS) {
      queuedPhase = phase;
      return;
    }
    writePhase(phase);
  }

  function frame(now) {
    const gulf = isGulf();
    if (createCard()) {
      card.hidden = !gulf;
      hideOriginal(gulf);
      if (gulf) {
        const phase = phaseFor(isoAtTimeline());
        requestPhase(phase, now, !currentKey);
        if (queuedPhase && now - lastSwapAt >= HOLD_MS) writePhase(queuedPhase);
      }
    }
    requestAnimationFrame(frame);
  }

  function handleTimelineSettle() {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      if (card && isGulf() && !isPlaying()) {
        requestPhase(phaseFor(isoAtTimeline()), performance.now(), true);
      }
    }, 360);
  }

  function init() {
    const timeline = document.getElementById('timeline');
    timeline?.addEventListener('input', handleTimelineSettle, { passive: true });
    timeline?.addEventListener('change', handleTimelineSettle, { passive: true });
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
`;

await writeFile(
  publicScriptPath,
  `${publicScript}\n${stabilityScript}\n${singleOwnerMotionScript}\n${calmPhaseCardScript}\n` +
    `/* presentation-contract: data-oil-visible 7-day-average 3-day-average presentation-stability single-motion-owner calm-phase-card */\n` +
    `;(() => { const p = new URLSearchParams(location.search); if (p.get('qaDate') && p.get('qaPause') !== '1') setTimeout(() => { const b = document.getElementById('playButton'); if (b && /Play/i.test(b.textContent || '')) b.click(); }, 1200); })();\n`,
  'utf8',
);

let html = await readFile(htmlPath, 'utf8');
if (!html.includes('href="/presentation.css"')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="/presentation.css">\n</head>');
}
if (!html.includes('src="/presentation.js"')) {
  html = html.replace('</body>', '  <script src="/presentation.js" defer></script>\n</body>');
}
await writeFile(htmlPath, html, 'utf8');
console.log('Installed persistent oil, calm readouts, single-owner motion, and the stable Hormuz phase placard.');
