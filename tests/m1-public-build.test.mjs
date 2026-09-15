import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildPublic, PUBLIC_FILES } from '../tools/build-public.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEMP_PREFIX = 'gib-public-build-test-';

async function put(root, file, contents) {
  const destination = path.join(root, ...file.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX));
    await rm(resolved, { recursive: true, force: true });
  });
  const sources = [...PUBLIC_FILES, 'package.json', 'tools/build-public.mjs', 'tools/build-m1-installation-profile.mjs'];
  for (const file of sources) {
    const destination = path.join(root, ...file.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, ...file.split('/')), destination);
  }
  await mkdir(path.join(root, 'netlify', 'functions', '_lib'), { recursive: true });
  return root;
}

async function inventory(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventory(root, file));
    else files.push(file);
  }
  return files.sort();
}

function buildEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:GIB_PROMOTIONS_|GIB_M1_INSTALLATION$|GIB_M1_ENVIRONMENT$|GIB_RICHMOND_PRODUCTION_|CONTEXT$)/u.test(key)) delete env[key];
  }
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  return { ...env, ...overrides };
}

async function runFixtureBuild(root, env) {
  const options = { cwd: root, env: buildEnvironment(env), stdio: 'pipe', timeout: 20000, windowsHide: true };
  if (process.platform !== 'win32') {
    execFileSync(process.execPath, ['--run', 'build'], options);
    return;
  }
  // The Windows sandbox's shell launch can fail before `node --run` starts the
  // build. Execute the same checked package command as sequential Node steps.
  const steps = ['tools/build-m1-installation-profile.mjs', 'tools/build-public.mjs'];
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.build, steps.map(file => `node ${file}`).join(' && '));
  for (const file of steps) execFileSync(process.execPath, [file], options);
}

async function assertGeneratedCopies(root) {
  for (const file of ['m1/installation-profile.generated.js', 'm1/promotions-config.generated.js']) {
    assert.deepEqual(await readFile(path.join(root, 'public', file)), await readFile(path.join(root, file)));
  }
  const context = { document: { documentElement: { dataset: {} } } };
  vm.createContext(context);
  for (const file of ['m1/installation-profile.generated.js', 'm1/promotions-config.generated.js']) {
    vm.runInContext(await readFile(path.join(root, 'public', file), 'utf8'), context, { timeout: 1000 });
  }
  return context;
}

for (const scenario of [
  { name: 'default Revolution', env: {}, installation: 'rev', staffClock: true, target: 'rev', promotions: false },
  { name: 'Revolution TEST', env: { GIB_M1_INSTALLATION: 'rev', CONTEXT: 'deploy-preview', GIB_PROMOTIONS_TEST_ENABLED: 'true' }, installation: 'rev', staffClock: true, target: 'rev', promotions: true },
  { name: 'Richmond TEST', env: { GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'test', CONTEXT: 'deploy-preview' }, installation: 'richmond', staffClock: false, target: 'richmond-test', promotions: false },
  { name: 'Richmond production', env: { GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'production', CONTEXT: 'production', GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true' }, installation: 'richmond', staffClock: false, target: 'richmond-production', promotions: false }
]) {
  test(`normal build publishes the freshly generated ${scenario.name} profile and config`, async t => {
    const root = await fixture(t);
    await put(root, 'm1/installation-profile.generated.js', 'stale profile');
    await put(root, 'm1/promotions-config.generated.js', 'stale config');
    await runFixtureBuild(root, scenario.env);
    const context = await assertGeneratedCopies(root);
    assert.equal(context.M1_INSTALLATION_PROFILE.installationId, scenario.installation);
    assert.equal(context.M1_INSTALLATION_PROFILE.backend.transportTarget, scenario.target);
    assert.equal(context.M1_INSTALLATION_PROFILE.featureFlags.staffClock, scenario.staffClock);
    assert.equal(context.M1_PROMOTIONS_TEST_CONFIG.enabled, scenario.promotions);
    assert.deepEqual(await inventory(path.join(root, 'public')), [...PUBLIC_FILES].sort());
    for (const file of ['_headers', '_redirects', 'index.html', 'guests/index.html', 'redneck-racing/style.css', 'm1/index.html', 'm1/connection.html', 'm1/connection-check.mjs', 'm1/shared-schedule.json', 'm1/richmond-schedule.json', 'm1/assets/revolution-bjj-logo.webp', 'm1/assets/richmond-bjj-logo.webp']) {
      assert.deepEqual(await readFile(path.join(root, 'public', file)), await readFile(path.join(ROOT, file)), file);
    }
    const server = await readFile(path.join(root, 'netlify/functions/_lib/m1-installation.generated.mjs'), 'utf8');
    assert.ok(server.includes(`DEPLOYMENT_INSTALLATION_ID = "${scenario.installation}"`));
    assert.equal(await lstat(path.join(root, 'public/netlify')).catch(() => null), null);
  });
}

test('public packaging excludes private/source/data files and removes stale output deterministically', async t => {
  const root = await fixture(t);
  const excluded = [
    'docs/release.md', 'tests/example.test.mjs', 'integrations/google-apps-script/Code.gs',
    'promotions/Code.gs', 'promotions/appsscript.json', 'private/settings.json', 'data/students.json',
    '.env', '.netlify/state.json', 'node_modules/example/index.js',
    'm1/private/settings.json', 'm1/data/students.json', 'm1/docs/help.html', 'm1/tests/example.js',
    'm1/Code.gs', 'm1/export.csv', 'm1/unapproved-script.js', 'guests/data/records.json',
    'redneck-racing/private/settings.json'
  ];
  for (const file of excluded) await put(root, file, 'synthetic private fixture');
  await put(root, 'public/stale.html', 'stale output');
  await put(root, 'public/private/leak.json', 'stale synthetic fixture');
  await buildPublic({ root });
  assert.deepEqual(await inventory(path.join(root, 'public')), [...PUBLIC_FILES].sort());
  for (const file of excluded) assert.equal(await lstat(path.join(root, 'public', file)).catch(() => null), null, file);
  const first = await Promise.all(PUBLIC_FILES.map(file => readFile(path.join(root, 'public', file))));
  await buildPublic({ root });
  assert.deepEqual(await Promise.all(PUBLIC_FILES.map(file => readFile(path.join(root, 'public', file)))), first);
});

test('packaging validates complete sources before clearing an existing output', async t => {
  const root = await fixture(t);
  await put(root, 'public/previous.html', 'previous output');
  await rm(path.join(root, 'm1/promotions-config.generated.js'));
  await assert.rejects(buildPublic({ root }), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'public/previous.html'), 'utf8'), 'previous output');
});

test('packaging refuses a linked public destination without deleting its target', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'protected-fixture');
  await mkdir(target);
  await put(root, 'protected-fixture/keep.txt', 'keep');
  await symlink(target, path.join(root, 'public'), 'junction');
  await assert.rejects(buildPublic({ root }), /linked or non-directory/u);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'keep');
});

test('Netlify publishes only public output while retaining function and route configuration', async () => {
  const config = await readFile(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(config, /publish\s*=\s*"public"/u);
  assert.match(config, /command\s*=\s*"npm run build"/u);
  assert.match(config, /functions\s*=\s*"netlify\/functions"/u);
  assert.match(config, /node_bundler\s*=\s*"esbuild"/u);
  assert.match(config, /included_files\s*=\s*\["m1\/shared-schedule\.json", "m1\/richmond-schedule\.json"\]/u);
  assert.match(await readFile(path.join(ROOT, '.gitignore'), 'utf8'), /^\/public\/$/mu);
});
