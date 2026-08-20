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

await writeFile(
  publicScriptPath,
  `${publicScript}\n${stabilityScript}\n${singleOwnerMotionScript}\n` +
    `/* presentation-contract: data-oil-visible 7-day-average 3-day-average presentation-stability single-motion-owner */\n` +
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
console.log('Installed the persistent-oil, calm-readout, and single-owner motion layers.');
