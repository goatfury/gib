// Build artifact only. This tool has no deployment credentials or publishing step.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { zipFunctions } from '../.m1-test-packager/node_modules/@netlify/zip-it-and-ship-it/dist/main.js';

const root = resolve('.m1-richmond-test-package');
const profile = await readFile('netlify/functions/_lib/m1-installation.generated.mjs', 'utf8');
if (!profile.includes('= "richmond"') || !profile.includes('= "test"')) throw new Error('Richmond TEST profile required.');
await mkdir(root, { recursive: true });
await cp('public', resolve(root, 'public'), { recursive: true });
const functions = await zipFunctions('netlify/functions', resolve(root, 'functions'), {
  basePath: process.cwd(),
  config: {
    '*': { nodeBundler: 'esbuild', nodeVersion: '22.x' },
    'm1-schedule': { includedFiles: ['m1/shared-schedule.json', 'm1/richmond-schedule.json'] },
    'm1-manager-review': { includedFiles: ['m1/shared-schedule.json', 'm1/richmond-schedule.json'] }
  },
  manifest: resolve(root, 'manifest.json')
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveHashes = {};
for (const fn of functions) archiveHashes[fn.name] = sha256(await readFile(fn.path));
await writeFile(resolve(root, 'build.json'), JSON.stringify({
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  installation: 'richmond', environment: 'test', packager: '14.5.4', archiveHashes
}, null, 2));
await writeFile(resolve(root, 'netlify.toml'), '[build]\npublish = "public"\nfunctions = "functions"\n');
console.log(`Packaged ${functions.length} Richmond TEST functions; nothing deployed.`);
