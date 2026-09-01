import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(root, 'public/index.html');
const smoothPath = resolve(root, 'public/smooth-oil.js');
const trafficPath = resolve(root, 'public/ship-traffic.js');
let html = await readFile(htmlPath, 'utf8');

const isoList = ['EGY','ISR','JOR','SYR','IRQ','IRN','KWT','SAU','YEM','OMN','ARE','QAT'];
const escapeHtml = (value) => String(value).replace(/[&<>\"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[char]));
const countryPaths = isoList.map((iso) => {
  const pattern = new RegExp(`<path class="world-country" data-iso="${iso}" aria-label="([^"]+)" d="([^"]+)"\\s*/>`);
  const match = html.match(pattern);
  if (!match) throw new Error(`Natural Earth path missing for ${iso}`);
  return `<path class="regional-country" data-iso="${iso}" aria-label="${escapeHtml(match[1])}" d="${match[2]}"/>`;
}).join('\n          ');

const gulfSvg = `      <svg id="gulfMap" class="map-svg realistic-gulf-map" viewBox="0 0 800 440" role="img" aria-label="Geographic map of Gulf oil routes using Natural Earth country boundaries">
        <defs>
          <filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <linearGradient id="gulfSea" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#061725"/><stop offset=".48" stop-color="#0a263c"/><stop offset="1" stop-color="#071a2b"/></linearGradient>
          <linearGradient id="gulfLand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#31495d"/><stop offset="1" stop-color="#1a2d3e"/></linearGradient>
          <radialGradient id="gulfShelf" cx="69%" cy="53%" r="42%"><stop offset="0" stop-color="#174361" stop-opacity=".62"/><stop offset=".58" stop-color="#0f3048" stop-opacity=".28"/><stop offset="1" stop-color="#081d31" stop-opacity="0"/></radialGradient>
          <pattern id="gulfGrain" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M0 8H28M0 20H28" stroke="#9bc1d9" stroke-opacity=".025" stroke-width=".7"/><path d="M8 0V28M20 0V28" stroke="#9bc1d9" stroke-opacity=".018" stroke-width=".7"/></pattern>
          <clipPath id="gulfClip"><rect width="800" height="440"/></clipPath>
        </defs>
        <rect width="800" height="440" fill="url(#gulfSea)"/><rect width="800" height="440" fill="url(#gulfShelf)"/><rect width="800" height="440" fill="url(#gulfGrain)"/>
        <g class="gulf-depth-contours" aria-hidden="true"><path d="M476 213C558 170 681 177 800 229"/><path d="M458 237C566 201 690 211 800 263"/><path d="M520 302C616 271 713 274 800 304"/><path d="M270 151C250 232 279 337 383 431"/></g>
        <g id="regionalCountries" clip-path="url(#gulfClip)" transform="translate(35 -10) scale(6.8 5.4) translate(-500 -140)" fill-rule="evenodd">${countryPaths}</g>
        <circle class="regional-country regional-island" cx="548" cy="185" r="4.2" aria-label="Bahrain"/>
        <g class="geo-labels" aria-hidden="true">
          <text class="country-label" x="132" y="170">EGYPT</text><text class="country-label" x="355" y="254">SAUDI ARABIA</text><text class="country-label" x="390" y="382">YEMEN</text><text class="country-label" x="635" y="346">OMAN</text><text class="country-label" x="592" y="252">UAE</text><text class="country-label" x="546" y="197">QATAR</text><text class="country-label" x="508" y="140">KUWAIT</text><text class="country-label" x="475" y="90">IRAQ</text><text class="country-label" x="650" y="100">IRAN</text>
          <text class="water-label" x="534" y="193" transform="rotate(13 534 193)">Persian Gulf</text><text class="water-label" x="290" y="299" transform="rotate(-69 290 299)">Red Sea</text><text class="water-label" x="677" y="287">Gulf of Oman</text><text class="water-label" x="678" y="397">Arabian Sea</text>
        </g>
        <path class="route-base" d="M500 194 C552 187 595 198 625 217 C676 244 728 258 800 272" stroke-width="18"/><path id="hormuzRoute" class="route-live route-hormuz" d="M500 194 C552 187 595 198 625 217 C676 244 728 258 800 272" stroke-width="13" filter="url(#glow)"/>
        <path class="route-base" d="M500 194 C443 197 380 215 322 246" stroke-width="16"/><path id="eastWestRoute" class="route-live route-pipeline" d="M500 194 C443 197 380 215 322 246" stroke-width="8" filter="url(#glow)"/>
        <path class="route-base" d="M322 246 C286 211 245 169 211 122" stroke-width="14"/><path id="redNorthRoute" class="route-live route-pipeline" d="M322 246 C286 211 245 169 211 122" stroke-width="7" filter="url(#glow)"/>
        <path class="route-base" d="M322 246 C331 305 354 359 392 414" stroke-width="14"/><path id="redSouthRoute" class="route-live route-pipeline" d="M322 246 C331 305 354 359 392 414" stroke-width="5" filter="url(#glow)"/>
        <path class="route-base" d="M571 238 C596 238 614 246 636 258 C685 267 738 273 800 282" stroke-width="14"/><path id="uaeRoute" class="route-live route-uae" d="M571 238 C596 238 614 246 636 258 C685 267 738 273 800 282" stroke-width="8" filter="url(#glow)"/>
        <path class="route-base" d="M610 340 C666 319 725 301 800 290" stroke-width="12"/><path id="omanRoute" class="route-live route-oman" d="M610 340 C666 319 725 301 800 290" stroke-width="5" filter="url(#glow)"/>
        <circle class="port" cx="500" cy="194" r="6"/><text class="port-label" x="457" y="183">Ras Tanura</text><circle class="port" cx="322" cy="246" r="6"/><text class="port-label" x="282" y="234">Yanbu</text><circle class="port" cx="636" cy="258" r="6"/><text class="port-label" x="627" y="244">Fujairah</text><circle class="port" cx="610" cy="340" r="6"/><text class="port-label" x="568" y="328">Oman ports</text>
        <text class="choke-label" x="610" y="205">HORMUZ</text><text class="choke-label" x="348" y="427">BAB EL-MANDEB</text><text class="choke-label" x="171" y="112">SUEZ / SUMED</text>
        <circle id="hormuzDanger" class="danger-ring" cx="625" cy="217" r="17"/><circle id="mandebDanger" class="danger-ring" cx="392" cy="414" r="17"/><circle id="yanbuDanger" class="danger-ring" cx="322" cy="246" r="17"/>
      </svg>`;

const mapPattern = /      <svg id="gulfMap"[\s\S]*?      <\/svg>\n\n      <svg id="worldMap"/;
if (!mapPattern.test(html)) throw new Error('Existing Gulf map block not found');
html = html.replace(mapPattern, `${gulfSvg}\n\n      <svg id="worldMap"`);
if (!html.includes('/realistic-gulf-map.css')) html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="/realistic-gulf-map.css">\n</head>');
await writeFile(htmlPath, html, 'utf8');

const css = `.realistic-gulf-map .regional-country{fill:url(#gulfLand);stroke:rgba(154,187,211,.72);stroke-width:.7;vector-effect:non-scaling-stroke}.realistic-gulf-map .regional-country[data-iso="IRN"]{fill:#2b4356}.realistic-gulf-map .regional-country[data-iso="SAU"]{fill:#263e51}.realistic-gulf-map .regional-island{fill:#2d465a;stroke-width:1}.gulf-depth-contours path{fill:none;stroke:rgba(96,176,214,.12);stroke-width:1.1;stroke-dasharray:2 7}.realistic-gulf-map .country-label{font-size:10.5px;letter-spacing:.08em;fill:rgba(227,238,247,.78);stroke-width:3.5px}.realistic-gulf-map .water-label{fill:rgba(113,171,205,.64);font-size:11px}@media(max-width:820px){.realistic-gulf-map .country-label{font-size:9.6px}}\n`;
await writeFile(resolve(root, 'public/realistic-gulf-map.css'), css, 'utf8');

let smooth = await readFile(smoothPath, 'utf8');
smooth = smooth.replace("state.labels.hormuz = makeBadge(layer, 'routeBadgeHormuz', 620, 160", "state.labels.hormuz = makeBadge(layer, 'routeBadgeHormuz', 620, 150").replace("state.labels.yanbu = makeBadge(layer, 'routeBadgeYanbu', 77, 175", "state.labels.yanbu = makeBadge(layer, 'routeBadgeYanbu', 40, 228").replace("state.labels.fujairah = makeBadge(layer, 'routeBadgeFujairah', 617, 287", "state.labels.fujairah = makeBadge(layer, 'routeBadgeFujairah', 617, 286").replace("state.labels.other = makeBadge(layer, 'routeBadgeOther', 610, 362", "state.labels.other = makeBadge(layer, 'routeBadgeOther', 610, 358");
await writeFile(smoothPath, smooth, 'utf8');
let traffic = await readFile(trafficPath, 'utf8');
traffic = traffic.replace("d: 'M492 177 C540 183 582 196 620 214 C671 238 725 254 793 267',", "d: 'M500 194 C552 187 595 198 625 217 C676 244 728 258 793 272',").replace("d: 'M793 279 C726 270 671 251 620 227 C580 208 540 196 492 190',", "d: 'M793 286 C728 277 676 259 625 232 C594 214 552 204 500 208',");
await writeFile(trafficPath, traffic, 'utf8');
console.log('Installed realistic Natural Earth Gulf geography.');
