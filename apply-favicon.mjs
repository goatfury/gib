import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(root, 'public/index.html');
let html = await readFile(htmlPath, 'utf8');
if (!html.includes('/favicon.svg')) {
  html = html.replace(/<\/head>/i, '  <link rel="icon" href="/favicon.svg" type="image/svg+xml">\n</head>');
  await writeFile(htmlPath, html, 'utf8');
}
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#071725"/><path d="M16 42c7-3 9-13 16-18 6-5 11-4 16-2-4 3-8 5-11 9 5-1 9 1 12 5-8-2-13 0-18 6-5 6-10 7-15 0Z" fill="#65d6cf"/><circle cx="43" cy="19" r="4" fill="#ffc857"/></svg>`;
await writeFile(resolve(root, 'public/favicon.svg'), favicon, 'utf8');
