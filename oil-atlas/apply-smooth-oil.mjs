import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const sourceDir = resolve(root, 'smooth-oil');
const htmlPath = resolve(publicDir, 'index.html');

await copyFile(resolve(sourceDir, 'smooth-oil.css'), resolve(publicDir, 'smooth-oil.css'));
await copyFile(resolve(sourceDir, 'smooth-oil.js'), resolve(publicDir, 'smooth-oil.js'));

let html = await readFile(htmlPath, 'utf8');
if (!html.includes('href="/smooth-oil.css"')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="/smooth-oil.css">\n</head>');
}
if (!html.includes('src="/smooth-oil.js"')) {
  html = html.replace('</body>', '  <script src="/smooth-oil.js" defer></script>\n</body>');
}
await writeFile(htmlPath, html, 'utf8');
console.log('Installed the smooth modeled Gulf oil and route layer.');
