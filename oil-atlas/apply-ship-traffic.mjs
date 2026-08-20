import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const htmlPath = resolve(publicDir, 'index.html');
const sourceDir = resolve(root, 'ship-layer');

await copyFile(resolve(sourceDir, 'ship-traffic.css'), resolve(publicDir, 'ship-traffic.css'));
await copyFile(resolve(sourceDir, 'ship-traffic.js'), resolve(publicDir, 'ship-traffic.js'));

let html = await readFile(htmlPath, 'utf8');
if (!html.includes('href="/ship-traffic.css"')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="/ship-traffic.css">\n</head>');
}
if (!html.includes('src="/ship-traffic.js"')) {
  html = html.replace('</body>', '  <script src="/ship-traffic.js" defer></script>\n</body>');
}
await writeFile(htmlPath, html, 'utf8');
console.log('Installed the daily Hormuz ship-traffic layer.');
