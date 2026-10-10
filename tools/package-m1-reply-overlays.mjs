// Exact per-gym live-source overlays. Offline build only; never uploads source,
// creates credentials, changes Google manifests, sends mail or starts timers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packageDisabledRelease } from './package-m1-disabled-release.mjs';
const mainBase = '2cd775876af71f8b8ead0fed6eaa527e617e5d60';
const bases = { rev: '682e9eb6aab5db00d8933a1925a51783b362f904', richmond: '5984438610d474f3c286752e42ebd78c9e6f241e' };
const adapted = ['integrations/google-apps-script/GibM1AttendanceEmailFirst.gs', 'netlify/functions/_lib/m1-attendance-digest-outbox.mjs', 'netlify/functions/m1-attendance-digest-job.mjs'];
const root = process.cwd(), [destination, client] = process.argv.slice(2);
assert.ok(destination && client, 'New output directory and existing pinned Netlify CLI required.');
const output = resolve(destination), cliRoot = resolve(client);
const applyEnvironment = { ...process.env, GIT_CEILING_DIRECTORIES: output };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
const source = git('rev-parse', 'HEAD').trim();
const changed = git('diff', '--name-only', mainBase, source).trim().split('\n');
const paths = changed.filter(path => /^(integrations\/|netlify\/functions\/|tests\/|tools\/)/.test(path)
  && !['tools/package-m1-reply-overlays.mjs', 'tools/m1-reply-richmond-adaptation.patch'].includes(path));
const hashes = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output); const receipts = [];
for (const gym of ['rev', 'richmond']) {
  const stage = resolve(output, gym + '-source'); await mkdir(stage);
  const archive = resolve(output, gym + '-base.tar'); git('archive', '--format=tar', '--output=' + archive, bases[gym]);
  execFileSync('tar', ['-xf', archive, '-C', stage]);
  const patch = git('diff', '--binary', mainBase, source, '--', ...paths.filter(path => gym !== 'richmond' || !adapted.includes(path)));
  execFileSync('git', ['apply', '--check', '-'], { cwd: stage, env: applyEnvironment, input: patch });
  execFileSync('git', ['apply', '-'], { cwd: stage, env: applyEnvironment, input: patch });
  if (gym === 'richmond') {
    const adaptation = await readFile(resolve(root, 'tools/m1-reply-richmond-adaptation.patch'));
    execFileSync('git', ['apply', '--check', '-'], { cwd: stage, env: applyEnvironment, input: adaptation });
    execFileSync('git', ['apply', '-'], { cwd: stage, env: applyEnvironment, input: adaptation });
  }
  const verifiedFiles = {};
  for (const path of paths) verifiedFiles[path] = hashes(await readFile(resolve(stage, path)));
  const regression = execFileSync(process.execPath, ['--test', 'tests/m1-reply-intake.test.mjs', 'tests/m1-reply-projection.test.mjs'], { cwd: stage, encoding: 'utf8' });
  await writeFile(resolve(output, gym + '-regressions.txt'), regression);
  // The packager makes isolated lockfile stages and runs all archives under
  // production Node22 with network/credentials excluded from the probes.
  const [build] = await packageDisabledRelease({ source, root: stage, output: resolve(output, gym + '-artifacts'), cliRoot,
    preserveRevolutionPromotions: true, emailFirst: true, gyms: [gym] });
  assert.equal(build.installation, gym); assert.equal(build.runtimeVerification.archiveCount, 36);
  const receipt = { gym, source, liveBase: bases[gym], verifiedFiles, build: gym + '-artifacts/' + gym + '/build.json',
    node: process.version, functions: 36, deployed: false, consentGranted: false, routingEnabled: false,
    adaptation: gym === 'richmond' ? hashes(await readFile(resolve(root, 'tools/m1-reply-richmond-adaptation.patch'))) : null };
  await writeFile(resolve(output, gym + '-overlay.json'), JSON.stringify(receipt, null, 2) + '\n'); receipts.push(receipt);
}
await writeFile(resolve(output, 'overlays.json'), JSON.stringify({ source, receipts }, null, 2) + '\n');
console.log(JSON.stringify(receipts.map(({ gym, source, liveBase, functions, node, deployed }) => ({ gym, source, liveBase, functions, node, deployed }))));
