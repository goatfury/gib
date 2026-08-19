import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const payloadDir = resolve(root, 'payload');
const outputPath = resolve(root, 'index.html');
const expectedHtmlSha256 = '60d73fb928dbc388183c35089cf11ff209136019d37abf9ab631fe87cda50cf5';

const parts = (await readdir(payloadDir))
  .filter((name) => /^part-\d+\.txt$/.test(name))
  .sort();
if (!parts.length) throw new Error('Atlantic Atlas payload chunks are missing');

let encoded = '';
for (const part of parts) encoded += (await readFile(resolve(payloadDir, part), 'utf8')).trim();

const html = gunzipSync(Buffer.from(encoded, 'base64'));
const actualHash = createHash('sha256').update(html).digest('hex');
if (actualHash !== expectedHtmlSha256) {
  throw new Error(`Atlantic Atlas checksum mismatch: ${actualHash}`);
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html);
console.log(`Reconstructed Atlantic Crossing Atlas (${html.length.toLocaleString()} bytes).`);
