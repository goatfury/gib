import { gunzipSync } from 'node:zlib';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const payloadDir = resolve(root, 'payload');
const outputPath = resolve(root, 'index.html');

const parts = (await readdir(payloadDir))
  .filter((name) => /^part-\d+\.txt$/.test(name))
  .sort();
if (!parts.length) throw new Error('Atlantic Atlas payload chunks are missing');

let encoded = '';
for (const part of parts) encoded += (await readFile(resolve(payloadDir, part), 'utf8')).trim();

const html = gunzipSync(Buffer.from(encoded, 'base64'));
await writeFile(outputPath, html);
console.log(`Reconstructed Atlantic Crossing Atlas (${html.length.toLocaleString()} bytes).`);
