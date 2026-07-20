import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TARGET = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/';
const BRANCH = 'review/tecmo-ball-camera-20260720';
const OUT_DIR = path.resolve('qa/netlify-ball-camera-source');
const HTML_PATH = path.join(OUT_DIR, 'ball-camera-live.html');
const META_PATH = path.join(OUT_DIR, 'metadata.json');

await mkdir(OUT_DIR, { recursive: true });
const response = await fetch(TARGET, { redirect: 'follow' });
if (!response.ok) throw new Error(`Target fetch failed: ${response.status} ${response.statusText}`);
const html = await response.text();
const sha256 = createHash('sha256').update(html).digest('hex');
const metadata = {
  target: TARGET,
  status: response.status,
  finalUrl: response.url,
  contentType: response.headers.get('content-type'),
  bytes: Buffer.byteLength(html),
  sha256,
  fetchedAt: new Date().toISOString(),
};

let previousSha = null;
try {
  previousSha = JSON.parse(await readFile(META_PATH, 'utf8')).sha256 || null;
} catch (_) {}

await writeFile(HTML_PATH, html);
await writeFile(META_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata));

if (previousSha === sha256) {
  console.log('Source unchanged; no repository update needed.');
  process.exit(0);
}

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
};

run('git', ['config', 'user.name', 'netlify-build[bot]']);
run('git', ['config', 'user.email', 'netlify-build[bot]@users.noreply.github.com']);
run('git', ['add', '-f', 'qa/netlify-ball-camera-source/ball-camera-live.html', 'qa/netlify-ball-camera-source/metadata.json']);
const commit = run('git', ['commit', '-m', 'Capture exact Ball Camera Cut preview source']);
if (commit.status !== 0) {
  console.log('No source commit created.');
  process.exit(0);
}

let push = run('git', ['push', 'origin', `HEAD:${BRANCH}`]);
if (push.status !== 0) {
  console.log('Standard push failed; trying repository URL credentials and current HEAD.');
  push = run('git', ['push', '--force-with-lease', 'origin', `HEAD:${BRANCH}`]);
}
if (push.status !== 0) throw new Error('Unable to push recovered source to review branch');
