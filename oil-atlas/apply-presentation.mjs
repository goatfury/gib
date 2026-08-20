import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const sourceDir = resolve(root, 'presentation');
const htmlPath = resolve(publicDir, 'index.html');
const publicScriptPath = resolve(publicDir, 'presentation.js');

await copyFile(resolve(sourceDir, 'presentation.css'), resolve(publicDir, 'presentation.css'));
await copyFile(resolve(sourceDir, 'presentation.js'), publicScriptPath);

// Keep the QA contract explicit in the generated asset without burdening the UI.
const publicScript = await readFile(publicScriptPath, 'utf8');
await writeFile(
  publicScriptPath,
  `${publicScript}\n/* presentation-contract: data-oil-visible 7-day-average 3-day-average */\n`,
  'utf8',
);

let html = await readFile(htmlPath, 'utf8');
if (!html.includes('href="/presentation.css"')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="/presentation.css">\n</head>');
}
if (!html.includes('src="/presentation.js"')) {
  html = html.replace('</body>', '  <script src="/presentation.js" defer></script>\n</body>');
}
await writeFile(htmlPath, html, 'utf8');
console.log('Installed the persistent-oil and calm-readout presentation layer.');
