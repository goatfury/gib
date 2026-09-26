import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

// Execute the real generator in an isolated directory; never change the checkout's
// generated defaults while testing a production build configuration.
async function build(environment) {
  const base = tmpdir(), root = await mkdtemp(join(base, 'gib-manager-release-'));
  try {
    await mkdir(join(root, 'tools'));
    await mkdir(join(root, 'm1'));
    await mkdir(join(root, 'netlify/functions/_lib'), { recursive: true });
    for (const file of ['tools/build-m1-installation-profile.mjs', 'm1/installation-profile-core.mjs']) {
      await writeFile(join(root, file), await readFile(new URL('../' + file, import.meta.url)));
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIB_') || key === 'CONTEXT') delete env[key];
    const result = spawnSync(process.execPath, [join(root, 'tools/build-m1-installation-profile.mjs')], { env: { ...env, ...environment }, encoding: 'utf8' });
    if (result.status !== 0) {
      assert.equal(await stat(join(root, 'm1/manager-review-config.generated.js')).then(() => true, () => false), false);
      return { error: result.stderr };
    }
    const context = vm.createContext({});
    vm.runInContext(await readFile(join(root, 'm1/manager-review-config.generated.js'), 'utf8'), context);
    const server = await readFile(join(root, 'netlify/functions/_lib/m1-manager-review.generated.mjs'), 'utf8');
    return { config: JSON.parse(JSON.stringify(context.M1_MANAGER_REVIEW_CONFIG)), frozen: Object.isFrozen(context.M1_MANAGER_REVIEW_CONFIG), server };
  } finally {
    assert.equal(dirname(root), base);
    await rm(root, { recursive: true, force: true });
  }
}

test('real build requires a separate explicit production flag and keeps generated targets aligned', async () => {
  for (const [env, expected] of [
    [{}, { enabled: false, target: 'disabled' }],
    [{ CONTEXT: 'production' }, { enabled: false, target: 'disabled' }],
    [{ CONTEXT: 'production', GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'TRUE' }, { enabled: false, target: 'disabled' }],
    [{ CONTEXT: 'deploy-preview', GIB_M1_MANAGER_REVIEW_PILOT: 'true' }, { enabled: true, target: 'test' }],
    [{ CONTEXT: 'deploy-preview', GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'test', GIB_M1_MANAGER_REVIEW_PILOT: 'true' }, { enabled: true, target: 'test' }],
    [{ CONTEXT: 'production', GIB_M1_INSTALLATION: 'rev', GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'true' }, { enabled: true, target: 'production' }]
  ]) {
    const result = await build(env);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.config, expected);
    assert.equal(result.frozen, true);
    assert.equal(result.server, `export const MANAGER_REVIEW_ENABLED = ${expected.enabled};\nexport const MANAGER_REVIEW_TARGET = ${JSON.stringify(expected.target)};\n`);
  }
});

test('real build rejects mixed flags, preview live activation and either Richmond live environment', async () => {
  for (const env of [
    { CONTEXT: 'production', GIB_M1_MANAGER_REVIEW_PILOT: 'true' },
    { CONTEXT: 'production', GIB_M1_MANAGER_REVIEW_PILOT: 'true', GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'true' },
    { CONTEXT: 'deploy-preview', GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'true' },
    { CONTEXT: 'production', GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'test', GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'true' },
    { CONTEXT: 'production', GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'production', GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'true' },
    { CONTEXT: 'branch-deploy', GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'production', GIB_M1_MANAGER_REVIEW_PILOT: 'true' }
  ]) assert.match((await build(env)).error, /requires? an explicit|cannot enable/);
});

test('approved production wrapper remains dormant without its exact separate activation property', async () => {
  const source = await readFile(new URL('../integrations/google-apps-script/production/Code.gs', import.meta.url), 'utf8');
  for (const value of [null, '', 'true', 'ACTIVE', 'active']) {
    const context = vm.createContext({ PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'GIB_M1_MANAGER_REVIEW_LIVE_PILOT' ? value : null }) } });
    vm.runInContext(source, context);
    assert.equal(context.GIB_M1_MANAGER_REVIEW_LIVE_ENABLED, value === 'active');
    assert.equal(context.GIB_M1_ALLOWED_TARGET, 'production');
    assert.equal(context.GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK, true);
  }
});
