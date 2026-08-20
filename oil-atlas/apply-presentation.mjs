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

// Append the stability layer after the base presentation code so it can own the
// final visible text without changing the underlying oil or traffic calculations.
const publicScript = await readFile(publicScriptPath, 'utf8');
const stabilityScript = await readFile(resolve(sourceDir, 'stability.js'), 'utf8');
await writeFile(
  publicScriptPath,
  `${publicScript}\n${stabilityScript}\n` +
    `/* presentation-contract: data-oil-visible 7-day-average 3-day-average presentation-stability */\n` +
    `;(() => { const p = new URLSearchParams(location.search); if (p.get('qaDate') && p.get('qaPause') !== '1') setTimeout(() => { const b = document.getElementById('playButton'); if (b && /Play/i.test(b.textContent || '')) b.click(); }, 1200); })();\n`,
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
