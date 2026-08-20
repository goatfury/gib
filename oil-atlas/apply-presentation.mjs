import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const sourceDir = resolve(root, 'presentation');
const htmlPath = resolve(publicDir, 'index.html');
const publicScriptPath = resolve(publicDir, 'presentation.js');

await copyFile(resolve(sourceDir, 'presentation.css'), resolve(publicDir, 'presentation.css'));
await copyFile(resolve(sourceDir, 'presentation.js'), publicScriptPath);

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

// The small prose panel below the Hormuz barrel changed every few timeline days,
// which made the entire lower-right card flash even after the barrel itself was
// smoothed. It duplicated the map story and sometimes described an old blank-
// barrel state. Hide that panel in Gulf mode, while leaving the world view alone.
const quietNarrativeScript = String.raw`
;(() => {
  'use strict';

  const root = document.documentElement;
  let strip = null;
  let originalStyle = null;
  let modeObserver = null;

  function isGulf() {
    const map = document.getElementById('gulfMap');
    return Boolean(map && !map.classList.contains('hidden'));
  }

  function directChildContaining(parent, node) {
    if (!parent || !node) return null;
    let current = node;
    while (current?.parentElement && current.parentElement !== parent) {
      current = current.parentElement;
    }
    return current?.parentElement === parent ? current : null;
  }

  function locateStrip() {
    const gauge = document.getElementById('barrelGauge');
    const date = document.getElementById('dateDisplay');
    if (!gauge) return null;

    // The nearest ancestor shared by the gauge and its date header is the
    // complete right-hand barrel card, rather than the whole page layout.
    let card = gauge.parentElement;
    while (card && card !== document.body && date && !card.contains(date)) {
      card = card.parentElement;
    }
    if (!card || card === document.body) return null;

    const gaugeBranch = directChildContaining(card, gauge);
    const dateBranch = directChildContaining(card, date);
    const children = [...card.children];
    const gaugeIndex = children.indexOf(gaugeBranch);

    // Prefer the first substantial, non-control sibling after the gauge. This
    // is the bordered prose strip visible at the bottom of the screenshot.
    if (gaugeIndex >= 0) {
      for (const child of children.slice(gaugeIndex + 1)) {
        if (child === dateBranch || child.contains(gauge)) continue;
        if (child.querySelector('svg, input, select')) continue;
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 20 && text.length <= 1200) return child;
      }
    }

    // Fallback for a nested card layout: score readable blocks that follow the
    // SVG and contain ordinary prose, then expand to their outer section.
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of card.querySelectorAll('section, article, div')) {
      if (candidate.contains(gauge) || candidate.contains(date)) continue;
      if (!(gauge.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 20 || text.length > 1200) continue;
      let score = 0;
      if (candidate.querySelector('h1, h2, h3, h4')) score += 30;
      if (candidate.querySelector('p')) score += 25;
      if (/closure shock|emergency plumbing|barrel stays blank|no comparable period/i.test(text)) score += 80;
      const computed = getComputedStyle(candidate);
      if (parseFloat(computed.borderTopWidth) > 0) score += 35;
      if (candidate.parentElement === card) score += 25;
      if (candidate.querySelector('button, input, select')) score -= 40;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (!best || bestScore < 20) return null;
    while (
      best.parentElement
      && best.parentElement !== card
      && !best.parentElement.contains(gauge)
      && !best.parentElement.contains(date)
    ) {
      best = best.parentElement;
    }
    return best;
  }

  function applyMode() {
    if (!strip?.isConnected) return false;
    const gulf = isGulf();
    const hidden = strip.dataset.presentationNarrativeHidden === 'true';

    if (gulf && !hidden) {
      if (originalStyle === null) originalStyle = strip.getAttribute('style');
      strip.dataset.presentationNarrativeHidden = 'true';
      strip.setAttribute('aria-hidden', 'true');
      strip.style.setProperty('display', 'none', 'important');
      strip.style.setProperty('height', '0', 'important');
      strip.style.setProperty('min-height', '0', 'important');
      strip.style.setProperty('margin', '0', 'important');
      strip.style.setProperty('padding', '0', 'important');
      strip.style.setProperty('border', '0', 'important');
      strip.style.setProperty('overflow', 'hidden', 'important');
      root.dataset.presentationNarrative = 'removed';
    } else if (!gulf && hidden) {
      if (originalStyle === null) strip.removeAttribute('style');
      else strip.setAttribute('style', originalStyle);
      strip.removeAttribute('data-presentation-narrative-hidden');
      strip.removeAttribute('aria-hidden');
      root.dataset.presentationNarrative = 'available';
    } else {
      root.dataset.presentationNarrative = gulf ? 'removed' : 'available';
    }
    return true;
  }

  function install() {
    if (!strip?.isConnected) {
      strip = locateStrip();
      originalStyle = null;
    }
    if (!strip) return false;
    strip.dataset.presentationNarrativeStrip = 'true';
    applyMode();

    if (!modeObserver) {
      const map = document.getElementById('gulfMap');
      if (map) {
        modeObserver = new MutationObserver(() => requestAnimationFrame(applyMode));
        modeObserver.observe(map, { attributes: true, attributeFilter: ['class'] });
      }
    }
    return true;
  }

  function init() {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (install() || attempts >= 80) clearInterval(timer);
    }, 50);
    install();
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
  `${publicScript}\n${stabilityScript}\n${singleOwnerMotionScript}\n${quietNarrativeScript}\n` +
    `/* presentation-contract: data-oil-visible 7-day-average 3-day-average presentation-stability single-motion-owner quiet-gulf-narrative */\n` +
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
console.log('Installed the persistent-oil, calm-readout, single-owner motion, and quiet Hormuz narrative layers.');
