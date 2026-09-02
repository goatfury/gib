import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(root, 'public/index.html');
let html = await readFile(htmlPath, 'utf8');

if (!html.includes('oil-atlas-clarity-2026-09-02')) {
  const measure = '<div class="barrel-measure" id="benchmarkLabel">Broad Gulf export evidence</div>';
  if (!html.includes(measure)) throw new Error('Barrel benchmark marker not found');
  html = html.replace(
    measure,
    `${measure}\n          <div class="refined-headline-caveat hidden" id="refinedHeadlineCaveat"></div>`,
  );
  html = html.replace(
    '</head>',
    '  <link rel="stylesheet" href="/clarity.css">\n  <meta name="oil-atlas-clarity" content="oil-atlas-clarity-2026-09-02">\n</head>',
  );
  html = html.replace(
    '  <script src="/presentation.js" defer></script>\n</body>',
    '  <script src="/presentation.js" defer></script>\n  <script src="/clarity.js" defer></script>\n</body>',
  );
  await writeFile(htmlPath, html, 'utf8');
}

await copyFile(resolve(root, 'clarity/clarity.css'), resolve(root, 'public/clarity.css'));
await copyFile(resolve(root, 'clarity/clarity.js'), resolve(root, 'public/clarity.js'));
console.log('Installed clearer refined-view labels, coverage, geography, and takeaways.');
