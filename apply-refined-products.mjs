import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

async function walk(directory) {
  const output = [];
  for (const name of await readdir(directory)) {
    if (name === '.git' || name === 'node_modules' || name === 'refined-products') continue;
    const path = join(directory, name);
    const information = await stat(path);
    if (information.isDirectory()) output.push(...await walk(path));
    else if (name === 'index.html') output.push(path);
  }
  return output;
}

const candidates = await walk(root);
let target = null;
let bestScore = -1;
for (const path of candidates) {
  const html = await readFile(path, 'utf8').catch(() => null);
  if (!html || !/<html/i.test(html)) continue;
  const score = html.length + (path.includes('dist') || path.includes('public') ? 10_000_000 : 0);
  if (score > bestScore) {
    bestScore = score;
    target = path;
  }
}
if (!target) throw new Error('Oil Atlas index.html was not found after the audited build');

let html = await readFile(target, 'utf8');
if (!html.includes('refined-products.css')) {
  html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="/refined-products.css">\n</head>');
}
if (!html.includes('refined-products.js')) {
  html = html.replace(/<\/body>/i, '  <script type="module" src="/refined-products.js"></script>\n</body>');
}
await writeFile(target, html, 'utf8');

const destination = dirname(target);
const source = resolve(root, 'refined-products');
for (const name of ['refined-products.css', 'refined-products.js', 'refined-products-data.json']) {
  await copyFile(resolve(source, name), resolve(destination, name));
}
console.log(`Installed the crude/refined-products stream switch in ${target}`);
