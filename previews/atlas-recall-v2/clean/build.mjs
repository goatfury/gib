import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// No runtime wrappers, remote dependencies or compressed payloads.
const here = path.dirname(fileURLToPath(import.meta.url));
const countries = JSON.parse(fs.readFileSync(path.join(here, 'countries.json'), 'utf8'));
const map = fs.readFileSync(path.join(here, 'world-map.svg'), 'utf8');
if (countries.length !== 197 || new Set(countries.map(c => c.id)).size !== 197) throw Error('Expected 197 unique countries');
if (new Set([...map.matchAll(/data-id="([^"]+)"/g)].map(m => m[1])).size !== 197) throw Error('Map must cover all 197 countries');
const out = path.join(here, 'dist');
fs.mkdirSync(out, { recursive: true });
for (const file of fs.readdirSync(out)) fs.rmSync(path.join(out, file), { recursive: true, force: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
const data = 'window.ATLAS_COUNTRIES = ' + JSON.stringify(countries) + ';\n';
const css = fs.readFileSync(path.join(here, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(here, 'game.js'), 'utf8');
const buildId = 'atlas-clean-' + hash(data + css + js);
const assets = { DATA: 'countries.' + hash(data) + '.js', STYLE: 'styles.' + hash(css) + '.css', GAME: 'game.' + hash(js) + '.js' };
for (const [key, content] of [['DATA', data], ['STYLE', css], ['GAME', js]]) fs.writeFileSync(path.join(out, assets[key]), content);
let html = fs.readFileSync(path.join(here, 'index.html'), 'utf8').replace('<!-- WORLD_MAP -->', map).replaceAll('__BUILD__', buildId);
for (const [key, value] of Object.entries(assets)) html = html.replaceAll('__' + key + '__', value);
if (/<iframe|DecompressionStream|part-\d|omitted for brevity|__STYLE__/.test(html)) throw Error('Invalid published HTML');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ buildId, countryCount: countries.length, createdAt: new Date().toISOString() }, null, 2));
fs.writeFileSync(path.join(out, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\'\n/\n  Cache-Control: no-store\n/index.html\n  Cache-Control: no-store\n/build.json\n  Cache-Control: no-store\n/*.js\n  Cache-Control: public, max-age=31536000, immutable\n/*.css\n  Cache-Control: public, max-age=31536000, immutable\n');
fs.writeFileSync(path.join(out, 'netlify.toml'), '[build]\n  publish = "."\n');
console.log(JSON.stringify({ buildId, out, countries: countries.length, files: fs.readdirSync(out) }));
