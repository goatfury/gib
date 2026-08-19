import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const payloadDir = resolve(root, 'payload');
const expectedBrotliSha256 = '339d45936486417cef79a079e5e7d08bad6f20b5c9ed976faffa7ae5eeb9fb4a';

const parts = (await readdir(payloadDir))
  .filter((name) => /^payload-\d+\.b64$/.test(name))
  .sort();
if (!parts.length) throw new Error('Oil Atlas payload chunks are missing');

let encoded = '';
for (const part of parts) encoded += (await readFile(resolve(payloadDir, part), 'utf8')).trim();
const compressed = Buffer.from(encoded, 'base64');
const actualHash = createHash('sha256').update(compressed).digest('hex');
if (actualHash !== expectedBrotliSha256) {
  throw new Error(`Oil Atlas payload checksum mismatch: ${actualHash}`);
}

const archive = JSON.parse(brotliDecompressSync(compressed).toString('utf8'));
if (archive.version !== 1 || !archive.files || typeof archive.files !== 'object') {
  throw new Error('Oil Atlas payload has an unsupported format');
}

for (const [relativePath, content] of Object.entries(archive.files)) {
  const outputPath = resolve(root, relativePath);
  if (!outputPath.startsWith(`${root}${sep}`)) throw new Error(`Unsafe output path: ${relativePath}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
}

console.log(`Reconstructed ${Object.keys(archive.files).length} Oil Flow Atlas files.`);
