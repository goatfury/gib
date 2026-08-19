import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const patchDir = resolve(root, 'patches');
const headParts = (await readdir(patchDir))
  .filter((name) => /^gulf-audit-head-\d+\.b64$/.test(name))
  .sort();
if (!headParts.length) throw new Error('Oil Atlas audit patch head chunks are missing');

let head = '';
for (const part of headParts) head += (await readFile(resolve(patchDir, part), 'utf8')).trim();
await writeFile(resolve(patchDir, 'gulf-audit-01.b64'), `${head}\n`, 'utf8');
await import('./build.mjs');
