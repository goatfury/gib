// Offline, fail-closed preflight. This file never reads credentials or uploads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPLOAD_CLIENT_VERSION = '26.0.1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...values].sort();

export async function validateRichmondArtifact(directory, expectedSource) {
  const root = resolve(directory);
  const receipt = JSON.parse(await readFile(resolve(root, 'build.json'), 'utf8'));
  assert.match(expectedSource || '', /^[a-f0-9]{40}$/, 'An exact reviewed source revision is required.');
  assert.equal(receipt.source, expectedSource, 'Artifact source differs from the reviewed revision.');
  assert.equal(receipt.installation, 'richmond');
  assert.equal(receipt.environment, 'test');
  const bytes = await readFile(resolve(root, 'manifest.json'));
  assert.equal(sha256(bytes), receipt.manifestSha256, 'Canonical manifest hash differs.');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.functions) && manifest.functions.length > 0);
  const names = manifest.functions.map(fn => fn.name);
  assert.equal(new Set(names).size, names.length, 'Duplicate function names.');
  assert.deepEqual(sorted(names), sorted(Object.keys(receipt.archiveHashes)), 'Archive receipt is incomplete.');
  assert.deepEqual(sorted(await readdir(resolve(root, 'functions'))), sorted(names.map(name => `${name}.zip`)), 'Unexpected or missing function archives.');
  for (const fn of manifest.functions) {
    assert.match(fn.name, /^[a-z0-9-]+$/);
    assert.equal(fn.path, `functions/${fn.name}.zip`, 'Manifest must use portable, confined archive paths.');
    assert.equal(fn.runtimeVersion, 'nodejs22.x', `Unexpected runtime: ${fn.name}`);
    assert.equal(fn.invocationMode, 'stream', `Unexpected invocation mode: ${fn.name}`);
    assert.equal(fn.runtime, 'js');
    const archive = await readFile(resolve(root, fn.path));
    assert.equal(archive.subarray(0, 2).toString(), 'PK', `Invalid ZIP: ${fn.name}`);
    assert.equal(sha256(archive), receipt.archiveHashes[fn.name], `Archive hash differs: ${fn.name}`);
  }
  assert.deepEqual(manifest.functions.find(fn => fn.name === 'm1-manager-review')?.routes,
    [{ pattern: '/api/m1-manager-review', literal: '/api/m1-manager-review', methods: [] }],
    'Manager review route is missing or changed.');
  const browserProfile = await readFile(resolve(root, 'public/m1/installation-profile.generated.js'), 'utf8');
  assert.match(browserProfile, /"installationId":\s*"richmond"/);
  assert.match(browserProfile, /"environment":\s*"test"/);
  return { root, receipt, manifest };
}

export function validateClientFunctions(result, manifest, receipt) {
  assert.deepEqual(result.functions, receipt.archiveHashes, 'Upload client produced different archive hashes.');
  for (const fn of manifest.functions) {
    const uploaded = result.fnShaMap[receipt.archiveHashes[fn.name]]?.find(item => item.normalizedPath === fn.name);
    assert.ok(uploaded, `Upload client omitted ${fn.name}.`);
    assert.equal(uploaded.runtime, 'nodejs22.x', `Upload client lost runtime: ${fn.name}`);
    assert.equal(uploaded.invocationMode, 'stream', `Upload client lost streaming: ${fn.name}`);
    const config = result.fnConfig[fn.name];
    assert.deepEqual(config?.routes, fn.routes, `Upload client lost routes: ${fn.name}`);
    assert.deepEqual(config?.excluded_routes, fn.excludedRoutes);
    assert.deepEqual(config?.build_data, fn.buildData);
    assert.equal(config?.priority, fn.priority);
  }
  assert.deepEqual(result.functionSchedules,
    manifest.functions.filter(fn => fn.schedule).map(fn => ({ name: fn.name, cron: fn.schedule })),
    'Upload client changed schedules.');
}

export async function prepareRichmondUpload({ directory, cliRoot, expectedSource }) {
  const { root, receipt, manifest } = await validateRichmondArtifact(directory, expectedSource);
  const clientRoot = resolve(cliRoot);
  const client = JSON.parse(await readFile(resolve(clientRoot, 'package.json'), 'utf8'));
  assert.equal(client.name, 'netlify-cli');
  assert.equal(client.version, UPLOAD_CLIENT_VERSION, 'Review a changed upload client before using it.');
  const clientRequire = createRequire(resolve(clientRoot, 'package.json'));
  const { resolveConfig } = await import(pathToFileURL(clientRequire.resolve('@netlify/config')).href);
  const { getFunctionsManifestPath } = await import(pathToFileURL(resolve(clientRoot, 'dist/utils/functions/functions.js')).href);
  const { default: hashFns } = await import(pathToFileURL(resolve(clientRoot, 'dist/utils/deploy/hash-fns.js')).href);

  // An artifact may be extracted below another Git checkout. An explicit absolute
  // base prevents CLI ancestor discovery from selecting that checkout's cache.
  const configPath = resolve(root, 'netlify.toml');
  await writeFile(configPath, `[build]\nbase = ${JSON.stringify(root.replaceAll('\\', '/'))}\npublish = "public"\nfunctions = "functions"\n`);
  const resolved = await resolveConfig({ config: configPath, cwd: root, offline: true, mode: 'cli', buffer: true });
  assert.equal(resolve(resolved.buildDir), root, 'Upload client selected an unexpected project root.');
  assert.equal(resolve(resolved.config.functionsDirectory), resolve(root, 'functions'));
  assert.equal(resolve(resolved.config.build.publish), resolve(root, 'public'));

  const manifestPath = resolve(root, '.netlify/functions/manifest.json');
  await mkdir(resolve(root, '.netlify/functions'), { recursive: true });
  const staged = { ...manifest, timestamp: Date.now(), functions: manifest.functions.map(fn => ({ ...fn, path: resolve(root, fn.path) })) };
  await writeFile(manifestPath, JSON.stringify(staged));
  assert.equal(await getFunctionsManifestPath({ base: resolved.buildDir }), manifestPath,
    'Upload client did not select the staged manifest.');
  const statuses = [];
  const result = await hashFns({ getPathInProject: (...parts) => resolve(root, '.netlify', ...parts) }, [resolve(root, 'functions')], {
    concurrentHash: 4, functionsConfig: {}, manifestPath, rootDir: root,
    skipFunctionsCache: false, statusCb: status => statuses.push(status), tmpDir: resolve(root, '.netlify/upload-preflight')
  });
  assert.ok(statuses.some(status => status.msg?.startsWith('Deploying functions from cache')), 'Upload client did not consume the function manifest.');
  assert.ok(!statuses.some(status => status.msg?.startsWith('Ignored invalid')), 'Upload client rejected the function manifest.');
  validateClientFunctions(result, staged, receipt);
  // Refresh only after complete verification; CLI cache has a 120-second TTL.
  staged.timestamp = Date.now();
  await writeFile(manifestPath, JSON.stringify(staged));
  const report = {
    source: receipt.source, tree: receipt.tree, installation: 'richmond', environment: 'test',
    uploadClient: client.version, root, manifestPath, preparedAt: new Date(staged.timestamp).toISOString(),
    expiresAt: new Date(staged.timestamp + 120_000).toISOString(), archiveHashes: result.functions,
    functions: staged.functions.map(fn => ({ name: fn.name, routes: result.fnConfig[fn.name]?.routes || [], runtime: 'nodejs22.x', invocationMode: 'stream' }))
  };
  await writeFile(resolve(root, 'upload-preflight.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, cliRoot, expectedSource] = process.argv.slice(2);
  assert.ok(directory && cliRoot && expectedSource, 'Usage: node tools/prepare-m1-richmond-test-upload.mjs <artifact> <netlify-cli-package> <reviewed-40-character-SHA>');
  const report = await prepareRichmondUpload({ directory, cliRoot, expectedSource });
  console.log(JSON.stringify({ source: report.source, uploadClient: report.uploadClient, functionCount: report.functions.length,
    root: report.root, manifestPath: report.manifestPath, expiresAt: report.expiresAt, validated: true }));
}
