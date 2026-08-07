import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOOL_PATH = path.join(ROOT, 'tools', 'm1-production-provision.mjs');
const TOOL_URL = pathToFileURL(TOOL_PATH).href;
const REAL_WRAPPER = path.join(ROOT, 'integrations', 'google-apps-script', 'production', 'Code.gs');
const REAL_RECEIVER = path.join(ROOT, 'integrations', 'google-apps-script', 'GibM1Receiver.gs');
const REAL_MANIFEST = path.join(ROOT, 'integrations', 'google-apps-script', 'production', 'appsscript.json');

const BASE_FS = Object.freeze({
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
});

async function loadTool() {
  assert.equal(existsSync(TOOL_PATH), true, 'The repository-driven production provisioning tool is required.');
  return import(`${TOOL_URL}?phased-provisioning-contract=${Date.now()}`);
}

function makeFixture(t, provision) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'gib-m1-provisioning-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const privateDir = path.join(repoRoot, 'private', 'm1-production');
  const productionSource = path.join(repoRoot, 'integrations', 'google-apps-script', 'production');
  const sharedSource = path.dirname(productionSource);
  const statePath = path.join(privateDir, 'state.json');
  const events = [];
  mkdirSync(productionSource, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(path.join(repoRoot, '.gitignore'), '/private/\n', 'utf8');
  writeFileSync(path.join(productionSource, 'Code.gs'), readFileSync(REAL_WRAPPER, 'utf8'), 'utf8');
  writeFileSync(path.join(sharedSource, 'GibM1Receiver.gs'), readFileSync(REAL_RECEIVER, 'utf8'), 'utf8');
  writeFileSync(path.join(productionSource, 'appsscript.json'), readFileSync(REAL_MANIFEST, 'utf8'), 'utf8');
  writeFileSync(path.join(privateDir, 'config.json'), `${JSON.stringify({
    schema: provision.PRIVATE_CONFIG_SCHEMA,
    projectId: 'gib-m1-production-project'
  })}\n`, 'utf8');

  const fs = Object.freeze({
    ...BASE_FS,
    writeFileSync(filePath, value, options) {
      if (path.resolve(filePath) === path.resolve(`${statePath}.tmp`)) {
        try {
          events.push({ type: 'state-write', state: JSON.parse(String(value)) });
        } catch {}
      }
      return writeFileSync(filePath, value, options);
    }
  });
  return {
    repoRoot,
    privateDir,
    bootstrapDir: path.join(privateDir, 'clasp-bootstrap'),
    projectDir: path.join(privateDir, 'clasp-project'),
    statePath,
    installerLinkPath: path.join(privateDir, 'installer-link.txt'),
    events,
    fs,
    options: {
      repoRoot,
      privateDir,
      claspPath: path.join(repoRoot, 'private', 'fake-clasp')
    }
  };
}

function commandName(spec) {
  const known = [
    '--version',
    'show-authorized-user',
    'create-script',
    'show-file-status',
    'push',
    'create-version',
    'create-deployment',
    'update-deployment',
    'list-deployments',
    'run-function'
  ];
  return known.find(name => spec.args.includes(name));
}

function makeRemoteRunner(fixture, provision) {
  const remote = {
    nextVersion: 12,
    deploymentId: 'privateProductionDeploymentIdentifier123456789',
    activeVersion: null,
    reportPreviousAfterMove: false,
    beforeMoveVersion: null
  };
  const scriptId = 'privateProductionScriptIdentifier123456789';
  const runner = async spec => {
    const name = commandName(spec);
    fixture.events.push({ type: 'runner', name, spec });
    if (name === '--version') return { code: 0, stdout: `${provision.REQUIRED_CLASP_VERSION}\n`, stderr: '' };
    if (name === 'show-authorized-user') {
      return { code: 0, stdout: '{"loggedIn":true,"clientId":"synthetic-oauth-client"}', stderr: '' };
    }
    if (name === 'create-script') {
      mkdirSync(spec.cwd, { recursive: true });
      writeFileSync(path.join(spec.cwd, '.clasp.json'), `${JSON.stringify({ scriptId })}\n`, 'utf8');
      // clasp v3 pulls starter files. They must remain isolated from the reviewed push stage.
      writeFileSync(path.join(spec.cwd, 'Code.js'), 'function myFunction() {}\n', 'utf8');
      writeFileSync(path.join(spec.cwd, 'appsscript.json'), '{"timeZone":"Etc/GMT"}\n', 'utf8');
      return { code: 0, stdout: JSON.stringify({ scriptId }), stderr: '' };
    }
    if (name === 'show-file-status') {
      return {
        code: 0,
        stdout: JSON.stringify({ filesToPush: ['Code.gs', 'GibM1Receiver.gs', 'appsscript.json'] }),
        stderr: ''
      };
    }
    if (name === 'push') return { code: 0, stdout: 'pushed', stderr: '' };
    if (name === 'create-version') {
      const versionNumber = remote.nextVersion++;
      return { code: 0, stdout: JSON.stringify({ versionNumber }), stderr: '' };
    }
    if (name === 'create-deployment') {
      const index = spec.args.indexOf('--versionNumber');
      remote.activeVersion = Number(spec.args[index + 1]);
      return {
        code: 0,
        stdout: JSON.stringify({ deploymentId: remote.deploymentId, versionNumber: remote.activeVersion }),
        stderr: ''
      };
    }
    if (name === 'update-deployment') {
      const index = spec.args.indexOf('--versionNumber');
      remote.beforeMoveVersion = remote.activeVersion;
      remote.activeVersion = Number(spec.args[index + 1]);
      return { code: 0, stdout: JSON.stringify({ deploymentId: remote.deploymentId }), stderr: '' };
    }
    if (name === 'list-deployments') {
      const versionNumber = remote.reportPreviousAfterMove && remote.beforeMoveVersion != null
        ? remote.beforeMoveVersion
        : remote.activeVersion;
      return {
        code: 0,
        stdout: JSON.stringify([{ deploymentId: remote.deploymentId, versionNumber }]),
        stderr: ''
      };
    }
    if (name === 'run-function') {
      return {
        code: 0,
        stdout: JSON.stringify({
          response: {
            ok: true,
            target: 'production',
            spreadsheetTitle: provision.PRODUCTION_SHEET_TITLE,
            spreadsheetMatches: 1,
            created: true,
            signinsSheet: 'Signins',
            headerCount: 11,
            dataRowCount: 0
          }
        }),
        stderr: ''
      };
    }
    throw new Error(`Unexpected mocked clasp action: ${name || spec.args.join(' ')}`);
  };
  return { remote, runner, scriptId };
}

function readState(fixture) {
  return JSON.parse(readFileSync(fixture.statePath, 'utf8'));
}

function actionOptions(fixture, provision, action) {
  return {
    ...fixture.options,
    execute: true,
    confirmation: provision.confirmationForAction(action)
  };
}

function assertSanitized(value, privateValues) {
  const serialized = JSON.stringify(value);
  for (const privateValue of privateValues) {
    assert.doesNotMatch(serialized, new RegExp(privateValue, 'u'));
  }
  assert.doesNotMatch(serialized, /script\.google\.com|\/macros\/s\/|receiver-token/iu);
}

function mutationEvents(events) {
  return events.filter(event => event.type === 'runner' && [
    'create-script',
    'push',
    'create-version',
    'create-deployment',
    'update-deployment',
    'run-function'
  ].includes(event.name));
}

function assertJournaledMove(events, action, mutationName) {
  const pendingIndex = events.findIndex(event => (
    event.type === 'state-write'
    && event.state?.pendingOperation?.action === action
  ));
  const mutationIndex = events.findIndex(event => event.type === 'runner' && event.name === mutationName);
  const verifiedIndex = events.findIndex((event, index) => (
    index > mutationIndex && event.type === 'runner' && event.name === 'list-deployments'
  ));
  assert.ok(pendingIndex >= 0, `${action} must journal its exact move before mutation.`);
  assert.ok(pendingIndex < mutationIndex, `${action} journal must precede the remote mutation.`);
  assert.ok(mutationIndex < verifiedIndex, `${action} must verify the remote deployment after mutation.`);
}

test('the provisioning module is import-safe and exposes phased/injected safety seams', () => {
  const probe = [
    `const moduleUrl = ${JSON.stringify(TOOL_URL)};`,
    'const loaded = await import(moduleUrl);',
    "process.stdout.write(Object.keys(loaded).sort().join(',') + '\\n');"
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exported = stdout.trim().split(',');
  for (const name of [
    'MUTATING_ACTIONS',
    'authorizeMutation',
    'confirmationForAction',
    'executeProductionAction',
    'generateProductionInstallerLink',
    'restoreProductionDeployment',
    'rollbackProductionDeployment',
    'statusProductionProvisioning'
  ]) {
    assert.ok(exported.includes(name), `Expected import-safe export ${name}.`);
  }
  for (const obsolete of [
    'executeProductionProvisioning',
    'persistInstallArtifact',
    'planDeploymentMove',
    'runProvisioningCli'
  ]) {
    assert.equal(exported.includes(obsolete), false, `Obsolete composite/compat export ${obsolete} must stay removed.`);
  }
});

test('every mutation requires its own execute flag and action-bound confirmation', async () => {
  const provision = await loadTool();
  const actions = [...provision.MUTATING_ACTIONS].sort();
  assert.deepEqual(actions, [
    'create', 'deploy', 'install-link', 'provision', 'push', 'restore', 'rollback', 'update', 'version'
  ]);
  const authorized = input => {
    try { return provision.authorizeMutation(input) === true; }
    catch { return false; }
  };
  for (const action of actions) {
    const confirmation = `M1-PRODUCTION-${action.toUpperCase()}`;
    assert.equal(provision.confirmationForAction(action), confirmation);
    assert.equal(authorized({ action, execute: false, confirmation }), false);
    assert.equal(authorized({ action, execute: true, confirmation: '' }), false);
    assert.equal(authorized({ action, execute: true, confirmation: `${confirmation}-WRONG` }), false);
    assert.equal(authorized({ action, execute: true, confirmation }), true);
  }
});

test('closed or cross-scoped phased gates perform no runner or filesystem write', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const effects = [];
  const fs = new Proxy(fixture.fs, {
    get(target, property) {
      if (['chmodSync', 'mkdirSync', 'renameSync', 'writeFileSync'].includes(property)) {
        return (...args) => effects.push({ type: 'write', property, args });
      }
      return target[property];
    }
  });
  const runner = async spec => {
    effects.push({ type: 'runner', spec });
    return { code: 0, stdout: '', stderr: '' };
  };
  for (const action of ['create', 'push', 'version', 'deploy', 'update', 'provision']) {
    await assert.rejects(
      () => provision.executeProductionAction(action, fixture.options, { fs, runner }),
      error => error?.code === 'MUTATION_GATE_CLOSED'
    );
    assert.deepEqual(effects, []);
    const wrongAction = action === 'provision' ? 'create' : 'provision';
    await assert.rejects(
      () => provision.executeProductionAction(action, {
        ...fixture.options,
        execute: true,
        confirmation: provision.confirmationForAction(wrongAction)
      }, { fs, runner }),
      error => error?.code === 'MUTATION_GATE_CLOSED'
    );
    assert.deepEqual(effects, []);
  }
});

test('private artifact overrides outside privateDir fail before any filesystem or runner call', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const effects = [];
  const fs = new Proxy(fixture.fs, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        effects.push({ type: 'fs', property, args });
        return value(...args);
      };
    }
  });
  const runner = async spec => {
    effects.push({ type: 'runner', spec });
    return { code: 0, stdout: '', stderr: '' };
  };
  const overrides = [
    ['statePath', path.join(fixture.repoRoot, 'outside-private', 'state.json')],
    ['configPath', path.join(fixture.repoRoot, 'outside-private', 'config.json')],
    ['installerLinkPath', path.join(fixture.repoRoot, 'outside-private', 'installer-link.txt')]
  ];

  for (const [option, outsidePath] of overrides) {
    effects.length = 0;
    await assert.rejects(
      () => provision.statusProductionProvisioning({
        ...fixture.options,
        [option]: outsidePath
      }, { fs, runner }),
      error => error?.code === 'PRIVATE_PATH_OUTSIDE_PRIVATE_DIR'
    );
    assert.deepEqual(effects, [], `${option} status rejection must precede all injected I/O.`);

    effects.length = 0;
    await assert.rejects(
      () => provision.executeProductionAction('create', {
        ...actionOptions(fixture, provision, 'create'),
        [option]: outsidePath
      }, { fs, runner }),
      error => error?.code === 'PRIVATE_PATH_OUTSIDE_PRIVATE_DIR'
    );
    assert.deepEqual(effects, [], `${option} execute rejection must precede all injected I/O.`);
  }
});

test('the real main rejects outside-private artifact flags without exposing their paths', async t => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'gib-m1-main-containment-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const privateDir = path.join(repoRoot, 'private', 'm1-production');
  const outsidePath = path.join(repoRoot, 'outside-private', 'sensitive-private-artifact.json');
  for (const flag of ['--state', '--config', '--installer-link-path']) {
    const child = spawnSync(process.execPath, [
      TOOL_PATH,
      'status',
      '--private-dir',
      privateDir,
      flag,
      outsidePath
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true
    });
    assert.equal(child.status, 1, `${flag} must fail closed in the real CLI main.`);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), {
      ok: false,
      code: 'PRIVATE_PATH_OUTSIDE_PRIVATE_DIR'
    });
    assert.doesNotMatch(child.stderr, /sensitive-private-artifact|outside-private/iu);
  }
});

test('status applies a private config authPath to every clasp preflight without leaking it', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const relativeAuthPath = path.join('auth', 'clasp-auth.json');
  const resolvedAuthPath = path.join(fixture.privateDir, relativeAuthPath);
  const privateAuthMarker = 'synthetic-private-auth-material-that-must-not-leak';
  mkdirSync(path.dirname(resolvedAuthPath), { recursive: true });
  writeFileSync(resolvedAuthPath, `${JSON.stringify({ marker: privateAuthMarker })}\n`, 'utf8');
  writeFileSync(path.join(fixture.privateDir, 'config.json'), `${JSON.stringify({
    schema: provision.PRIVATE_CONFIG_SCHEMA,
    projectId: 'gib-m1-production-project',
    authPath: relativeAuthPath
  })}\n`, 'utf8');
  const specs = [];
  const runner = async spec => {
    specs.push(spec);
    if (commandName(spec) === '--version') {
      return { code: 0, stdout: `${provision.REQUIRED_CLASP_VERSION}\n`, stderr: privateAuthMarker };
    }
    if (commandName(spec) === 'show-authorized-user') {
      return {
        code: 0,
        stdout: '{"loggedIn":true,"clientId":"synthetic-oauth-client"}',
        stderr: privateAuthMarker
      };
    }
    throw new Error('Status must run only the two clasp preflight commands.');
  };

  const summary = await provision.statusProductionProvisioning(
    fixture.options,
    { fs: fixture.fs, runner }
  );

  assert.equal(summary.authUsable, true);
  assert.deepEqual(specs.map(commandName), ['--version', 'show-authorized-user']);
  for (const spec of specs) {
    assert.deepEqual(spec.args.slice(0, 2), ['-A', resolvedAuthPath]);
  }
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(resolvedAuthPath), false);
  assert.equal(serialized.includes(relativeAuthPath), false);
  assertSanitized(summary, [privateAuthMarker]);
});

test('real phased actions isolate clasp bootstrap, stage exactly three files, and deploy before provision', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  const privateValues = [remote.scriptId, remote.remote.deploymentId];
  const results = [];

  for (const action of ['create', 'push', 'version']) {
    fixture.events.length = 0;
    results.push(await provision.executeProductionAction(
      action,
      actionOptions(fixture, provision, action),
      { fs: fixture.fs, runner: remote.runner }
    ));
    assert.equal(mutationEvents(fixture.events).at(-1)?.name, {
      create: 'create-script', push: 'push', version: 'create-version'
    }[action]);
  }

  const createCall = remote.runner && readdirSync(fixture.bootstrapDir);
  assert.ok(createCall.includes('Code.js'), 'clasp starter source must stay in the isolated bootstrap directory.');
  assert.equal(readFileSync(path.join(fixture.bootstrapDir, 'Code.js'), 'utf8').includes('myFunction'), true);
  const staged = readdirSync(fixture.projectDir).filter(name => !name.startsWith('.')).sort();
  assert.deepEqual(staged, ['Code.gs', 'GibM1Receiver.gs', 'appsscript.json']);
  assert.equal(existsSync(path.join(fixture.projectDir, 'Code.js')), false);
  assert.equal(readFileSync(path.join(fixture.projectDir, 'Code.gs'), 'utf8'), readFileSync(REAL_WRAPPER, 'utf8'));
  assert.equal(readFileSync(path.join(fixture.projectDir, 'GibM1Receiver.gs'), 'utf8'), readFileSync(REAL_RECEIVER, 'utf8'));
  assert.equal(readState(fixture).lifecycle, 'versioned');
  assert.equal(readState(fixture).deployment.candidateVersion, 12);

  fixture.events.length = 0;
  const deployed = await provision.executeProductionAction(
    'deploy',
    actionOptions(fixture, provision, 'deploy'),
    { fs: fixture.fs, runner: remote.runner }
  );
  assertJournaledMove(fixture.events, 'deploy', 'create-deployment');
  assert.equal(readState(fixture).pendingOperation, null);
  assert.equal(readState(fixture).lifecycle, 'deployed-unprovisioned');
  assert.equal(readState(fixture).deployment.currentVersion, 12);

  fixture.events.length = 0;
  const provisioned = await provision.executeProductionAction(
    'provision',
    actionOptions(fixture, provision, 'provision'),
    { fs: fixture.fs, runner: remote.runner }
  );
  assert.deepEqual(mutationEvents(fixture.events).map(event => event.name), ['run-function']);
  assert.equal(readState(fixture).lifecycle, 'provisioned');
  assert.equal(readState(fixture).deployment.approvedVersion, 12);
  assert.equal(readState(fixture).sheet.resolved, true);

  for (const result of [...results, deployed, provisioned]) assertSanitized(result, privateValues);
});

test('the real CLI recognizes positional mutation actions and defaults each to a sanitized dry run', async () => {
  for (const action of ['create', 'push', 'version', 'deploy', 'update', 'provision', 'rollback', 'restore', 'install-link']) {
    const child = spawnSync(process.execPath, [TOOL_PATH, action], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true
    });
    assert.equal(child.status, 0, `${action} dry run must not need clasp or Google authorization.`);
    assert.equal(child.stderr, '');
    const output = JSON.parse(child.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.dryRun, true);
    assert.equal(output.lifecycle, 'unchanged');
    assertSanitized(output, ['AKfy', 'private-production']);
  }
});

test('update, rollback, and restore are journaled and verified against exact remote versions', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  for (const action of ['create', 'push', 'version', 'deploy', 'provision']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner
    });
  }
  for (const action of ['push', 'version']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner
    });
  }
  assert.equal(readState(fixture).deployment.candidateVersion, 13);

  fixture.events.length = 0;
  const updated = await provision.executeProductionAction(
    'update',
    actionOptions(fixture, provision, 'update'),
    { fs: fixture.fs, runner: remote.runner }
  );
  assertJournaledMove(fixture.events, 'update', 'update-deployment');
  assert.equal(readState(fixture).pendingOperation, null);
  assert.equal(readState(fixture).deployment.currentVersion, 13);
  assert.equal(readState(fixture).deployment.previousVersion, 12);
  assert.equal(readState(fixture).lifecycle, 'deployed-unprovisioned');
  await provision.executeProductionAction(
    'provision',
    actionOptions(fixture, provision, 'provision'),
    { fs: fixture.fs, runner: remote.runner }
  );

  fixture.events.length = 0;
  const rolledBack = await provision.rollbackProductionDeployment(
    actionOptions(fixture, provision, 'rollback'),
    { fs: fixture.fs, runner: remote.runner }
  );
  assertJournaledMove(fixture.events, 'rollback', 'update-deployment');
  assert.equal(readState(fixture).pendingOperation, null);
  assert.equal(readState(fixture).deployment.currentVersion, 12);
  assert.equal(readState(fixture).deployment.rolledBackFromVersion, 13);
  assert.equal(readState(fixture).lifecycle, 'rolled-back');

  fixture.events.length = 0;
  const restored = await provision.restoreProductionDeployment(
    actionOptions(fixture, provision, 'restore'),
    { fs: fixture.fs, runner: remote.runner }
  );
  assertJournaledMove(fixture.events, 'restore', 'update-deployment');
  assert.equal(readState(fixture).pendingOperation, null);
  assert.equal(readState(fixture).deployment.currentVersion, 13);
  assert.equal(readState(fixture).deployment.rolledBackFromVersion, null);
  assert.equal(readState(fixture).lifecycle, 'provisioned');
  for (const result of [updated, rolledBack, restored]) {
    assertSanitized(result, [remote.remote.deploymentId, remote.scriptId]);
  }
});

test('a post-move verification mismatch preserves the private journal and exposes no raw response', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  for (const action of ['create', 'push', 'version', 'deploy', 'provision', 'push', 'version']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner
    });
  }
  remote.remote.reportPreviousAfterMove = true;
  let failure;
  try {
    await provision.executeProductionAction('update', actionOptions(fixture, provision, 'update'), {
      fs: fixture.fs,
      runner: remote.runner
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'CLASP_DEPLOYMENT_STATE_AMBIGUOUS');
  const state = readState(fixture);
  assert.deepEqual(state.pendingOperation, {
    action: 'update',
    deploymentId: remote.remote.deploymentId,
    fromVersion: 12,
    toVersion: 13
  });
  assertSanitized(
    { name: failure.name, code: failure.code, message: failure.message },
    [remote.remote.deploymentId, remote.scriptId]
  );
});

test('captured clasp failures never expose raw IDs, URLs, tokens, or stderr', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  await provision.executeProductionAction('create', actionOptions(fixture, provision, 'create'), {
    fs: fixture.fs,
    runner: remote.runner
  });
  const privateUrl = `https://script.google.com/macros/s/${remote.remote.deploymentId}/exec`;
  const privateToken = 'private-production-receiver-token-0123456789';
  const failingRunner = async spec => {
    if (commandName(spec) === 'push') {
      return { code: 1, stdout: privateUrl, stderr: `Google rejected ${privateToken}` };
    }
    return remote.runner(spec);
  };
  let failure;
  try {
    await provision.executeProductionAction('push', actionOptions(fixture, provision, 'push'), {
      fs: fixture.fs,
      runner: failingRunner
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'CLASP_PUSH_FAILED');
  assertSanitized(
    { name: failure.name, code: failure.code, message: failure.message },
    [remote.remote.deploymentId, privateToken]
  );
});

test('provision accepts only the exact clasp response envelope and rejects any error envelope', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  for (const action of ['create', 'push', 'version', 'deploy']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner
    });
  }
  const validProvisionResult = {
    ok: true,
    target: 'production',
    spreadsheetTitle: provision.PRODUCTION_SHEET_TITLE,
    spreadsheetMatches: 1,
    created: true,
    signinsSheet: 'Signins',
    headerCount: 11,
    dataRowCount: 0
  };
  const privateErrorMarker = 'private-clasp-envelope-error-that-must-not-leak';
  remote.remote.activeVersion = 99;
  let driftedRunCalls = 0;
  await assert.rejects(
    () => provision.executeProductionAction(
      'provision',
      actionOptions(fixture, provision, 'provision'),
      {
        fs: fixture.fs,
        runner: async spec => {
          if (commandName(spec) === 'run-function') driftedRunCalls += 1;
          return remote.runner(spec);
        }
      }
    ),
    error => error?.code === 'CLASP_DEPLOYMENT_STATE_DRIFT'
  );
  assert.equal(driftedRunCalls, 0, 'Remote drift must fail before the provisioning function runs.');
  assert.equal(readState(fixture).lifecycle, 'deployed-unprovisioned');
  remote.remote.activeVersion = 12;
  const invalidOutputs = [
    validProvisionResult,
    { response: validProvisionResult, error: null },
    { response: validProvisionResult, error: { message: privateErrorMarker } }
  ];

  for (const invalidOutput of invalidOutputs) {
    const runner = async spec => {
      if (commandName(spec) === 'run-function') {
        return { code: 0, stdout: JSON.stringify(invalidOutput), stderr: privateErrorMarker };
      }
      return remote.runner(spec);
    };
    let failure;
    try {
      await provision.executeProductionAction(
        'provision',
        actionOptions(fixture, provision, 'provision'),
        { fs: fixture.fs, runner }
      );
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, 'PROVISION_RESPONSE_INVALID');
    assertSanitized(
      { name: failure?.name, code: failure?.code, message: failure?.message },
      [privateErrorMarker]
    );
    assert.equal(readState(fixture).lifecycle, 'deployed-unprovisioned');
  }
});

test('install-link saves capability material only in the ignored private artifact', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  const runId = 'production-install-run-0001';
  const nonce = Buffer.alloc(32, 7).toString('base64url');
  let rawToken = '';
  let capabilityCalls = 0;
  const capabilityFactory = async ({ issuedAt, expiresAt }) => {
    capabilityCalls += 1;
    const payload = {
      v: 1,
      purpose: 'production-tablet-install',
      origin: provision.PRODUCTION_ORIGIN,
      runId,
      issuedAt,
      expiresAt,
      nonce
    };
    rawToken = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${'s'.repeat(43)}`;
    return rawToken;
  };
  const installOptions = {
    ...actionOptions(fixture, provision, 'install-link'),
    env: {
      GIB_M1_PRODUCTION_INSTALL_RUN_ID: runId,
      GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET: 'synthetic-private-installer-secret-value'
    }
  };
  await assert.rejects(
    () => provision.generateProductionInstallerLink(installOptions, {
      fs: fixture.fs,
      capabilityFactory,
      now: Date.UTC(2026, 7, 7, 12, 0, 0),
      randomBytes: () => Buffer.alloc(32, 7)
    }),
    error => error?.code === 'INSTALL_LIFECYCLE_INVALID'
  );
  assert.equal(capabilityCalls, 0, 'An unprovisioned lifecycle must fail before capability generation.');
  assert.equal(existsSync(fixture.installerLinkPath), false);

  for (const action of ['create', 'push', 'version', 'deploy', 'provision']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner
    });
  }
  const result = await provision.generateProductionInstallerLink({
    ...installOptions
  }, {
    fs: fixture.fs,
    capabilityFactory,
    now: Date.UTC(2026, 7, 7, 12, 0, 0),
    randomBytes: () => Buffer.alloc(32, 7)
  });
  assert.equal(existsSync(fixture.installerLinkPath), true);
  const privateArtifact = readFileSync(fixture.installerLinkPath, 'utf8');
  assert.ok(privateArtifact.includes(rawToken));
  assert.match(privateArtifact, /^https:\/\/gib-live\.netlify\.app\/m1\/tablet-install\.html#/u);
  assertSanitized(result, [rawToken, remote.scriptId, remote.remote.deploymentId]);
  assert.equal(capabilityCalls, 1);
  assert.equal(result.summary.installerLinkSaved, true);
  assert.equal(result.summary.expiresInSeconds, 60);
  assert.equal(result.summary.lifecycle, 'provisioned');
});

test('the tool contains no destructive, OAuth-bootstrap, or Netlify production command', () => {
  const source = readFileSync(TOOL_PATH, 'utf8');
  assert.doesNotMatch(
    source,
    /['"`](?:delete-script|delete-deployment|undeploy|login|logout|open-credentials-setup|enable-api|disable-api)['"`]/iu
  );
  assert.doesNotMatch(source, /netlify\s+(?:deploy\s+--prod|env:(?:set|import|unset))/iu);
  assert.doesNotMatch(source, /(?:setEnvVarValue|deleteEnvVar|production_deploy)/u);
});
