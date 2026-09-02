(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DAY = 86400000;
  const start = Date.parse('2025-09-01T00:00:00Z');
  const countryNames = { SA: 'Saudi Arabia', KW: 'Kuwait', BH: 'Bahrain' };
  const regionNames = {
    opec: 'OPEC reporters', us: 'U.S.', canada: 'Canada', eurocasp: 'Europe and Caspian',
    meaf: 'Middle East and Africa', asia: 'Asia-Pacific'
  };
  let data = null;
  let scheduled = false;

  function refinedActive() {
    return $('refinedStream')?.getAttribute('aria-pressed') === 'true';
  }

  function activeMode() {
    return $('worldMode')?.getAttribute('aria-pressed') === 'true' ? 'world' : 'gulf';
  }

  function timelineDate() {
    const value = Number($('timeline')?.value || 0);
    return new Date(start + value * DAY);
  }

  function readingAt(view, date) {
    const rows = data?.[view]?.months || [];
    if (!rows.length) return null;
    const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    let row = rows[0];
    for (const candidate of rows) {
      if (Date.parse(candidate.month + 'T00:00:00Z') <= month.getTime()) row = candidate;
      else break;
    }
    const latest = rows.at(-1);
    return {
      ...row,
      held: month.getTime() > Date.parse(latest.month + 'T00:00:00Z'),
      latestMonth: latest.month,
    };
  }

  function relativePhrase(value, baseline, noun) {
    const change = ((value / baseline) - 1) * 100;
    const rounded = Math.round(Math.abs(change));
    if (Math.abs(change) < 0.5) return `${noun} match the September 2025 baseline`;
    return `${noun} are ${rounded}% ${change < 0 ? 'below' : 'above'} September 2025`;
  }

  function gulfTakeaway(reading) {
    const baseline = data.gulf.months[0];
    const latestPrefix = reading.held ? 'Latest reported exports' : 'Reported exports';
    const title = relativePhrase(reading.value, baseline.value, latestPrefix);
    if (reading.month === baseline.month) {
      return {
        title: 'September sets the three-country baseline',
        text: 'Saudi Arabia, Kuwait and Bahrain are the entire reported cohort; five Gulf states remain unreported.',
      };
    }

    const april = data.gulf.months.find((row) => row.month === '2026-04-01');
    const allBelow = Object.keys(countryNames).every((code) => reading.countries[code] < baseline.countries[code]);
    if (april && reading.month >= '2026-05-01' && reading.countries.KW > april.countries.KW * 1.5 && allBelow) {
      return {
        title,
        text: 'Kuwait has rebounded from April, but all three reporters remain below their September levels.',
      };
    }

    const changes = Object.keys(countryNames).map((code) => ({
      code,
      change: ((reading.countries[code] / baseline.countries[code]) - 1) * 100,
    })).sort((a, b) => a.change - b.change);
    const weakest = changes[0];
    const strongest = changes.at(-1);
    return {
      title,
      text: `${countryNames[weakest.code]} is furthest below its September level; ${countryNames[strongest.code]} is closest to the baseline.`,
    };
  }

  function worldTakeaway(reading) {
    const baseline = data.world.months[0];
    if (reading.month === baseline.month) {
      return {
        title: 'September sets the 47-country baseline',
        text: 'The same 47 countries remain in every month; Russia and Latin America are outside this strict cohort.',
      };
    }
    const title = relativePhrase(reading.value, baseline.value, reading.held ? 'Latest reported refinery output' : 'Reported refinery output');
    const changes = Object.keys(reading.regions)
      .filter((id) => baseline.regions[id] > 0)
      .map((id) => ({ id, delta: reading.regions[id] - baseline.regions[id] }));
    const gain = [...changes].sort((a, b) => b.delta - a.delta)[0];
    const loss = [...changes].sort((a, b) => a.delta - b.delta)[0];
    return {
      title,
      text: `${regionNames[gain.id] || gain.id} is the largest increase; ${regionNames[loss.id] || loss.id} is the largest decline in the fixed cohort.`,
    };
  }

  function installHatch() {
    const svg = $('gulfMap');
    const defs = svg?.querySelector('defs');
    if (!defs || $('refinedMissingLandHatch')) return;
    const ns = 'http://www.w3.org/2000/svg';
    const pattern = document.createElementNS(ns, 'pattern');
    pattern.id = 'refinedMissingLandHatch';
    pattern.setAttribute('width', '7');
    pattern.setAttribute('height', '7');
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('patternTransform', 'rotate(35)');
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('width', '7');
    rect.setAttribute('height', '7');
    rect.setAttribute('fill', '#172835');
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', '0');
    line.setAttribute('y2', '7');
    line.setAttribute('stroke', '#788b98');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-opacity', '.66');
    pattern.append(rect, line);
    defs.append(pattern);
  }

  function updateGeography(active) {
    installHatch();
    const reported = new Set(['SAU', 'KWT']);
    const missing = new Set(['ARE', 'IRN', 'IRQ', 'OMN', 'QAT']);
    document.querySelectorAll('#gulfMap .regional-country').forEach((node) => {
      const iso = node.dataset.iso || '';
      const isBahrain = node.getAttribute('aria-label') === 'Bahrain';
      node.classList.toggle('refined-reported-land', active && (reported.has(iso) || isBahrain));
      node.classList.toggle('refined-unreported-land', active && missing.has(iso));
    });
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function sync() {
    scheduled = false;
    const active = refinedActive();
    const mode = activeMode();

    setText($('gulfMode'), active ? 'Gulf reported exports' : 'Gulf routes');
    setText($('worldMode'), active ? 'Global refinery output' : 'Whole world');
    document.querySelector('.mode-switch')?.setAttribute(
      'aria-label',
      active ? 'Refined-product measurement' : 'Data view',
    );

    const caveat = $('refinedHeadlineCaveat');
    caveat?.classList.toggle('hidden', !active);
    if (active) {
      setText(
        caveat,
        mode === 'gulf'
          ? 'Saudi Arabia, Kuwait and Bahrain only — not a Gulf total.'
          : 'Fixed 47-country reporting cohort — not a world total.',
      );
    }

    updateGeography(active);
    if (!active || !data) return;

    const coverage = $('refinedCoverage');
    if (coverage) {
      coverage.innerHTML = mode === 'gulf'
        ? '<strong>Map key:</strong> highlighted = reported; hatched = unreported. Routes are illustrative.'
        : '<strong>Map key:</strong> brighter countries report in every month; dim countries are outside the fixed cohort.';
    }

    const reading = readingAt(mode, timelineDate());
    if (!reading) return;
    const takeaway = mode === 'gulf' ? gulfTakeaway(reading) : worldTakeaway(reading);
    setText($('phaseKicker'), reading.held ? 'Latest reported month' : mode === 'gulf' ? 'Three-country cohort' : 'Forty-seven-country cohort');
    setText($('phaseTitle'), takeaway.title);
    setText($('phaseText'), takeaway.text);

    const value = Number(reading.value).toFixed(2);
    $('barrelGauge')?.setAttribute(
      'aria-label',
      mode === 'gulf'
        ? `${value} million barrels per day; Saudi Arabia, Kuwait and Bahrain only; not a Gulf total.`
        : `${value} million barrels per day; fixed 47-country reporting cohort; not a world total.`,
    );
  }

  function requestSync() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(sync);
  }

  async function startClarity() {
    try {
      const response = await fetch('/data/refined-products.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Refined data request failed: ${response.status}`);
      data = await response.json();
    } catch (error) {
      console.error(error);
    }

    ['refinedStream', 'liquidsStream', 'gulfMode', 'worldMode'].forEach((id) => {
      $(id)?.addEventListener('click', requestSync);
    });
    $('timeline')?.addEventListener('input', requestSync);

    const observer = new MutationObserver(requestSync);
    ['refinedStream', 'gulfMode', 'worldMode', 'flowNumber', 'dateDisplay'].forEach((id) => {
      const node = $(id);
      if (node) observer.observe(node, { attributes: true, childList: true, subtree: true });
    });
    requestSync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startClarity, { once: true });
  else startClarity();
})();
