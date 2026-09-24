import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareRichmondUpload, validateClientFunctions, validateRichmondArtifact } from '../tools/prepare-m1-richmond-test-upload.mjs';

const source = 'a'.repeat(40);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gib-richmond-upload-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '/') || resolve(root).startsWith(resolve(tmpdir()) + '\\'));
    await rm(root, { recursive: true });
  });
  await mkdir(join(root, 'functions'));
  await mkdir(join(root, 'public/m1'), { recursive: true });
  await writeFile(join(root, 'public/m1/installation-profile.generated.js'), '{"installationId":"richmond","environment":"test"}');
  const name = 'm1-manager-review';
  const archive = Buffer.from('PKfixture: content is only hashed by upload client');
  await writeFile(join(root, `functions/${name}.zip`), archive);
  const manifest = { version: 1, timestamp: 1, functions: [{ name, path: `functions/${name}.zip`, runtime: 'js', runtimeVersion: 'nodejs22.x', invocationMode: 'stream',
    buildData: { runtimeAPIVersion: 2 }, priority: 10, routes: [{ pattern: '/api/m1-manager-review', literal: '/api/m1-manager-review', methods: [] }] }] };
  const receipt = { source, tree: 'b'.repeat(40), installation: 'richmond', environment: 'test', archiveHashes: { [name]: sha256(archive) } };
  async function persist() {
    const bytes = JSON.stringify(manifest);
    receipt.manifestSha256 = sha256(bytes);
    await writeFile(join(root, 'manifest.json'), bytes);
    await writeFile(join(root, 'build.json'), JSON.stringify(receipt));
  }
  await persist();
  return { root, manifest, receipt, persist };
}

test('Richmond artifact accepts relocated package but rejects altered ZIPs and wrong source', async t => {
  const f = await fixture(t);
  assert.equal((await validateRichmondArtifact(f.root, source)).receipt.source, source);
  await assert.rejects(validateRichmondArtifact(f.root, 'c'.repeat(40)), /source differs/);
  await writeFile(join(f.root, 'functions/m1-manager-review.zip'), 'PKaltered');
  await assert.rejects(validateRichmondArtifact(f.root, source), /Archive hash differs/);
});

test('canonical metadata, path confinement, runtime, streaming and route are required before staging', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'manifest.json'), JSON.stringify({ ...f.manifest, timestamp: 9 }));
  await assert.rejects(validateRichmondArtifact(f.root, source), /manifest hash differs/);
  await f.persist();
  const fn = f.manifest.functions[0];
  for (const [field, value, error] of [
    ['path', '/home/runner/functions/m1-manager-review.zip', /portable, confined/],
    ['path', '../m1-manager-review.zip', /portable, confined/],
    ['runtimeVersion', 'js', /Unexpected runtime/],
    ['invocationMode', undefined, /Unexpected invocation/],
    ['routes', undefined, /route is missing/]
  ]) {
    const before = fn[field]; fn[field] = value; await f.persist();
    await assert.rejects(validateRichmondArtifact(f.root, source), error);
    fn[field] = before;
  }
});

test('unexpected extra archive and non-TEST profile fail closed', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'functions/stale.zip'), 'PKstale');
  await assert.rejects(validateRichmondArtifact(f.root, source), /Unexpected or missing/);
  await rm(join(f.root, 'functions/stale.zip'));
  await writeFile(join(f.root, 'public/m1/installation-profile.generated.js'), '{"installationId":"richmond","environment":"production"}');
  await assert.rejects(validateRichmondArtifact(f.root, source));
});

test('client-produced metadata cannot silently lose routes, runtime, streaming or bytes', async t => {
  const f = await fixture(t), fn = f.manifest.functions[0], digest = f.receipt.archiveHashes[fn.name];
  const result = { functions: { ...f.receipt.archiveHashes }, fnShaMap: { [digest]: [{ normalizedPath: fn.name, runtime: 'nodejs22.x', invocationMode: 'stream' }] },
    fnConfig: { [fn.name]: { routes: fn.routes, build_data: fn.buildData, priority: fn.priority } }, functionSchedules: [] };
  validateClientFunctions(result, f.manifest, f.receipt);
  for (const mutate of [
    r => { r.fnConfig[fn.name].routes = undefined; },
    r => { r.fnShaMap[digest][0].runtime = 'js'; },
    r => { r.fnShaMap[digest][0].invocationMode = undefined; },
    r => { r.functions[fn.name] = 'c'.repeat(64); }
  ]) { const changed = structuredClone(result); mutate(changed); assert.throws(() => validateClientFunctions(changed, f.manifest, f.receipt)); }
});

test('actual installed upload client consumes the fresh staged manifest and produces exact metadata', { skip: !process.env.M1_TEST_UPLOAD_CLIENT_ROOT }, async t => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, 'manifest.json'), 'utf8');
  const report = await prepareRichmondUpload({ directory: f.root, cliRoot: process.env.M1_TEST_UPLOAD_CLIENT_ROOT, expectedSource: source });
  assert.equal(report.functions.length, 1);
  assert.equal(report.root, f.root);
  assert.equal(report.manifestPath, join(f.root, '.netlify/functions/manifest.json'));
  assert.deepEqual(report.archiveHashes, f.receipt.archiveHashes);
  assert.equal(await readFile(join(f.root, 'manifest.json'), 'utf8'), original, 'Relocation never mutates the canonical manifest.');
  const staged = JSON.parse(await readFile(report.manifestPath, 'utf8'));
  assert.ok(Date.now() - staged.timestamp < 120_000);
  assert.equal(staged.functions[0].path, join(f.root, 'functions/m1-manager-review.zip'));
});
