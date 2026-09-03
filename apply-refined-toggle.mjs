import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const partsDir = resolve(root, 'refined/apply-toggle-parts');
const parts = (await readdir(partsDir)).filter((name) => /^part-\d+\.txt$/.test(name)).sort();
if (!parts.length) throw new Error('Refined-toggle source parts are missing');
let source = '';
for (const part of parts) source += await readFile(resolve(partsDir, part), 'utf8');
const temporary = resolve(root, '.apply-refined-toggle.generated.mjs');
await writeFile(temporary, source, 'utf8');
try {
  await import(`${pathToFileURL(temporary).href}?build=${Date.now()}`);
} finally {
  await unlink(temporary).catch(() => {});
}
