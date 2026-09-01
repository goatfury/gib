import { gunzipSync } from 'node:zlib';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const payloadDir = resolve(root, 'feature-payload');
const parts = (await readdir(payloadDir)).filter((name) => /^refined-map-part-\d+$/.test(name)).sort();
if (!parts.length) throw new Error('Refined-map feature payload is missing');
let encoded = '';
for (const part of parts) encoded += (await readFile(resolve(payloadDir, part), 'utf8')).trim();
const generated = resolve(root, '.generated-apply-refined-map.mjs');
await writeFile(generated, gunzipSync(Buffer.from(encoded, 'base64')));
await import(`${pathToFileURL(generated).href}?v=${Date.now()}`);
