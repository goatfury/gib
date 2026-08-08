import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
});

async function loadTool() {
  assert.equal(existsSync(TOOL_PATH), true, 'The repository-driven production provisioning tool is required.');
  return import(`${TOOL_URL}?phased-provisioning-contract=${Date.now()}`);
}

function installFixtureClaspPackage(repoRoot, {
  version = '3.3.0',
  bin = { clasp: 'build/src/index.js' },
  createEntrypoint = true,
  entrypointSource = 'process.stdout.write("fixture clasp must not run directly\\n");\n'
} = {}) {
  const packageDir = path.join(repoRoot, 'node_modules', '@google', 'clasp');
  const packageJsonPath = path.join(packageDir, 'package.json');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(packageJsonPath, `${JSON.stringify({
    name: '@google/clasp',
    version,
    bin
  })}\n`, 'utf8');
  if (createEntrypoint && bin && typeof bin === 'object' && typeof bin.clasp === 'string') {
    const entrypointPath = path.resolve(packageDir, bin.clasp);
    mkdirSync(path.dirname(entrypointPath), { recursive: true });
    writeFileSync(entrypointPath, entrypointSource, 'utf8');
  }
  return { packageDir, packageJsonPath };
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
  installFixtureClaspPackage(repoRoot, { version: provision.REQUIRED_CLASP_VERSION });
  writeFileSync(path.join(privateDir, 'config.json'), `${JSON.stringify({
    schema: provision.PRIVATE_CONFIG_SCHEMA
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
      privateDir
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
    'list-deployments'
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
    throw new Error(`Unexpected mocked clasp action: ${name || spec.args.join(' ')}`);
  };
  return { remote, runner, scriptId };
}

function validProvisionResult(overrides = {}) {
  return {
    created: true,
    dataRowCount: 0,
    headerCount: 11,
    ok: true,
    provisioningClosed: true,
    sheetStored: true,
    spreadsheetMatches: 1,
    targetLocked: true,
    ...overrides
  };
}

function makeProvisionRequester(fixture, result = validProvisionResult()) {
  const calls = [];
  const requester = async (request, dependencies) => {
    calls.push({ request, dependencies });
    fixture.events.push({ type: 'provision-request', request });
    return result;
  };
  return { calls, requester };
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
    'update-deployment'
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
    'prepareProductionProvisioning',
    'resolveClaspLaunch',
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

test('every platform launches the installed clasp JavaScript entrypoint through process.execPath', async t => {
  const provision = await loadTool();
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const toolSource = readFileSync(TOOL_PATH, 'utf8');
  try {
    for (const platform of ['win32', 'linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
      const fixture = makeFixture(t, provision);
      const specs = [];
      const runner = async spec => {
        specs.push(spec);
        if (commandName(spec) === '--version') {
          return { code: 0, stdout: `${provision.REQUIRED_CLASP_VERSION}\n`, stderr: '' };
        }
        if (commandName(spec) === 'show-authorized-user') {
          return { code: 0, stdout: '{"loggedIn":true}', stderr: '' };
        }
        throw new Error('Only read-only clasp preflight commands are allowed in launcher tests.');
      };
      const prepared = await provision.prepareProductionProvisioning(
        fixture.options,
        { fs: fixture.fs, runner }
      );
      const launch = provision.resolveClaspLaunch({ repoRoot: fixture.repoRoot, fs: fixture.fs });
      assert.equal(prepared.authUsable, true);
      assert.equal(specs.length, 2);
      assert.deepEqual(specs.map(commandName), ['--version', 'show-authorized-user']);
      assert.deepEqual(specs[0].args, [launch.entrypoint, '--version']);
      assert.deepEqual(specs[1].args, [launch.entrypoint, 'show-authorized-user', '--json']);
      for (const spec of specs) {
        assert.equal(spec.executable, process.execPath, `${platform} must launch clasp through Node.`);
        assert.equal(spec.args[0], launch.entrypoint);
        assert.doesNotMatch(spec.executable, /clasp(?:\.cmd)?$/iu);
        assert.doesNotMatch(spec.args[0], /[\\/]\.bin[\\/]|clasp\.cmd$/iu);
      }
      assert.deepEqual(mutationEvents(fixture.events), []);
    }
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }

  assert.doesNotMatch(toolSource, /clasp\.cmd|['"]clasp-bin['"]|node_modules[^\n]*[\\/]\.bin/iu);
  assert.doesNotMatch(toolSource, /shell\s*:\s*true|\bexec\s*\(|cmd\.exe|powershell|\bnpx\b/iu);
  assert.match(toolSource, /shell\s*:\s*false/u);
});

test('clasp package metadata and entrypoint validation fail closed before any command runs', async t => {
  const provision = await loadTool();
  const privateMarker = 'private-clasp-package-marker-that-must-not-leak';

  async function expectPrepareFailure(fixture, code) {
    const calls = [];
    let failure;
    try {
      await provision.prepareProductionProvisioning(fixture.options, {
        fs: fixture.fs,
        runner: async spec => {
          calls.push(spec);
          return { code: 0, stdout: '', stderr: '' };
        }
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, code);
    assert.deepEqual(calls, []);
    assert.doesNotMatch(
      JSON.stringify({ name: failure?.name, code: failure?.code, message: failure?.message }),
      new RegExp(privateMarker, 'iu')
    );
  }

  {
    const fixture = makeFixture(t, provision);
    rmSync(path.join(fixture.repoRoot, 'node_modules', '@google', 'clasp'), { recursive: true, force: true });
    await expectPrepareFailure(fixture, 'CLASP_PACKAGE_UNAVAILABLE');
  }

  {
    const fixture = makeFixture(t, provision);
    installFixtureClaspPackage(fixture.repoRoot, {
      version: `3.3.1-${privateMarker}`,
      createEntrypoint: false
    });
    await expectPrepareFailure(fixture, 'CLASP_VERSION_MISMATCH');
  }

  const invalidCases = [
    { name: 'missing bin', bin: null, createEntrypoint: false },
    { name: 'string bin', bin: `build/${privateMarker}.js`, createEntrypoint: false },
    { name: 'missing clasp member', bin: { other: `build/${privateMarker}.js` }, createEntrypoint: false },
    { name: 'empty clasp member', bin: { clasp: '' }, createEntrypoint: false },
    { name: 'parent escape', bin: { clasp: `../../${privateMarker}.js` }, createEntrypoint: true },
    { name: 'POSIX absolute path', bin: { clasp: `/tmp/${privateMarker}.js` }, createEntrypoint: false },
    { name: 'Windows absolute path', bin: { clasp: `C:\\${privateMarker}.js` }, createEntrypoint: false },
    { name: 'command shim', bin: { clasp: `build/${privateMarker}.cmd` }, createEntrypoint: true },
    { name: 'missing JavaScript file', bin: { clasp: `build/${privateMarker}.js` }, createEntrypoint: false }
  ];
  for (const invalidCase of invalidCases) {
    const fixture = makeFixture(t, provision);
    installFixtureClaspPackage(fixture.repoRoot, {
      version: provision.REQUIRED_CLASP_VERSION,
      bin: invalidCase.bin,
      createEntrypoint: invalidCase.createEntrypoint
    });
    await expectPrepareFailure(fixture, 'CLASP_ENTRYPOINT_INVALID');
  }

  {
    const fixture = makeFixture(t, provision);
    const bin = { clasp: `build/${privateMarker}.js` };
    installFixtureClaspPackage(fixture.repoRoot, {
      version: provision.REQUIRED_CLASP_VERSION,
      bin,
      createEntrypoint: false
    });
    mkdirSync(path.resolve(
      fixture.repoRoot,
      'node_modules',
      '@google',
      'clasp',
      bin.clasp
    ), { recursive: true });
    await expectPrepareFailure(fixture, 'CLASP_ENTRYPOINT_INVALID');
  }
});

test('runtime clasp version validation remains exact after package validation', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const calls = [];
  await assert.rejects(
    () => provision.prepareProductionProvisioning(fixture.options, {
      fs: fixture.fs,
      runner: async spec => {
        calls.push(spec);
        return { code: 0, stdout: '3.3.1\n', stderr: 'private stderr must remain captured' };
      }
    }),
    error => error?.code === 'CLASP_VERSION_MISMATCH'
  );
  assert.deepEqual(calls.map(commandName), ['--version']);
});

test('command runner preserves spaced and shell-like arguments, output, and exit codes with shell disabled', async t => {
  const provision = await loadTool();
  const runnerRoot = mkdtempSync(path.join(os.tmpdir(), 'gib clasp runner with spaces-'));
  t.after(() => rmSync(runnerRoot, { recursive: true, force: true }));
  const helperPath = path.join(runnerRoot, 'inert argv helper.js');
  writeFileSync(helperPath, [
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    "process.stderr.write('captured stderr');",
    'process.exitCode = 23;'
  ].join('\n'), 'utf8');
  const inertArguments = [
    'path containing spaces',
    '-A',
    path.join(runnerRoot, 'private auth path with spaces.json'),
    ';',
    '&',
    '|',
    '>',
    '$(not-a-command)',
    '"quoted value"'
  ];
  let invocation;
  const runner = provision.createCommandRunner({
    spawnImpl(executable, args, options) {
      invocation = { executable, args: [...args], options: { ...options } };
      return spawn(executable, args, options);
    }
  });
  const result = await runner({
    executable: process.execPath,
    args: [helperPath, ...inertArguments],
    cwd: runnerRoot,
    env: process.env
  });
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [helperPath, ...inertArguments]);
  assert.equal(invocation.options.shell, false);
  assert.equal(result.code, 23);
  assert.deepEqual(JSON.parse(result.stdout), inertArguments);
  assert.equal(result.stderr, 'captured stderr');
});

test('command runner timeout still captures partial stdout and stderr', async t => {
  const provision = await loadTool();
  const runnerRoot = mkdtempSync(path.join(os.tmpdir(), 'gib clasp timeout with spaces-'));
  t.after(() => rmSync(runnerRoot, { recursive: true, force: true }));
  const helperPath = path.join(runnerRoot, 'timeout helper.js');
  writeFileSync(helperPath, [
    "process.stdout.write('stdout before timeout');",
    "process.stderr.write('stderr before timeout');",
    'setInterval(() => {}, 1_000);'
  ].join('\n'), 'utf8');
  const startedAt = Date.now();
  const result = await provision.createCommandRunner({ timeoutMs: 500 })({
    executable: process.execPath,
    args: [helperPath],
    cwd: runnerRoot,
    env: process.env
  });
  assert.ok(Date.now() - startedAt < 5_000, 'Timed out clasp processes must be terminated promptly.');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'stdout before timeout');
  assert.equal(result.stderr, 'stderr before timeout');
});

test('the production lifecycle uses the default Apps Script Cloud project and ends with status', async () => {
  const provision = await loadTool();
  assert.deepEqual([...provision.PROVISIONING_SEQUENCE], [
    'prepare',
    'create',
    'push',
    'version',
    'deploy',
    'provision',
    'status'
  ]);
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
  const provisionRequester = async request => {
    effects.push({ type: 'provision-request', request });
    return validProvisionResult();
  };
  for (const action of ['create', 'push', 'version', 'deploy', 'update', 'provision']) {
    await assert.rejects(
      () => provision.executeProductionAction(action, fixture.options, { fs, runner, provisionRequester }),
      error => error?.code === 'MUTATION_GATE_CLOSED'
    );
    assert.deepEqual(effects, []);
    const wrongAction = action === 'provision' ? 'create' : 'provision';
    await assert.rejects(
      () => provision.executeProductionAction(action, {
        ...fixture.options,
        execute: true,
        confirmation: provision.confirmationForAction(wrongAction)
      }, { fs, runner, provisionRequester }),
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
  const relativeAuthPath = path.join('auth folder with spaces & inert', 'clasp auth.json');
  const resolvedAuthPath = path.join(fixture.privateDir, relativeAuthPath);
  const privateAuthMarker = 'synthetic-private-auth-material-that-must-not-leak';
  mkdirSync(path.dirname(resolvedAuthPath), { recursive: true });
  writeFileSync(resolvedAuthPath, `${JSON.stringify({ marker: privateAuthMarker })}\n`, 'utf8');
  writeFileSync(path.join(fixture.privateDir, 'config.json'), `${JSON.stringify({
    schema: provision.PRIVATE_CONFIG_SCHEMA,
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
    assert.equal(spec.executable, process.execPath);
    assert.deepEqual(spec.args.slice(1, 3), ['-A', resolvedAuthPath]);
  }
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(resolvedAuthPath), false);
  assert.equal(serialized.includes(relativeAuthPath), false);
  assertSanitized(summary, [privateAuthMarker]);
});

test('status, prepare, and create require no standard Cloud project or private config file', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  rmSync(path.join(fixture.privateDir, 'config.json'));
  const remote = makeRemoteRunner(fixture, provision);

  const status = await provision.statusProductionProvisioning(
    fixture.options,
    { fs: fixture.fs, runner: remote.runner }
  );
  assert.equal(status.authUsable, true);
  assert.equal(status.defaultCloudProjectIntentional, true);
  assert.equal(status.lifecycle, 'absent');
  assert.equal(status.rollbackPrepared, false);
  assert.equal(status.restorePrepared, false);

  const prepared = await provision.prepareProductionProvisioning(
    fixture.options,
    { fs: fixture.fs, runner: remote.runner }
  );
  assert.equal(prepared.defaultCloudProjectIntentional, true);
  assert.equal(prepared.stagedFileCount, 3);
  assert.equal(prepared.lifecycle, 'absent');

  await provision.executeProductionAction(
    'create',
    actionOptions(fixture, provision, 'create'),
    { fs: fixture.fs, runner: remote.runner }
  );
  const createEvent = fixture.events.find(event => event.type === 'runner' && event.name === 'create-script');
  assert.ok(createEvent);
  assert.equal(createEvent.spec.args.includes('--parentId'), false);
  assert.equal(createEvent.spec.args.some(value => /projectId|cloudProject/iu.test(String(value))), false);
  const projectFile = JSON.parse(readFileSync(path.join(fixture.projectDir, '.clasp.json'), 'utf8'));
  assert.equal(projectFile.scriptId, remote.scriptId);
  assert.equal(projectFile.projectId, undefined);
  assert.equal(readState(fixture).project.cloudProjectMode, 'apps-script-default');
  assert.equal(readState(fixture).project.projectId, undefined);

  writeFileSync(path.join(fixture.projectDir, '.clasp.json'), `${JSON.stringify({
    ...projectFile,
    projectId: 'misleading-local-value-is-not-remote-association-proof'
  })}\n`, 'utf8');
  const statusWithMisleadingLocalProjectId = await provision.statusProductionProvisioning(
    fixture.options,
    { fs: fixture.fs, runner: remote.runner }
  );
  assert.equal(statusWithMisleadingLocalProjectId.projectStateUsable, true);
  assert.equal(statusWithMisleadingLocalProjectId.defaultCloudProjectIntentional, true);
  assert.equal(readState(fixture).project.projectId, undefined);
});

test('real phased actions isolate clasp bootstrap, stage exactly three files, and deploy before provision', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  const provisionRequest = makeProvisionRequester(fixture);
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
  const projectFile = JSON.parse(readFileSync(path.join(fixture.projectDir, '.clasp.json'), 'utf8'));
  assert.equal(projectFile.scriptId, remote.scriptId);
  assert.equal(Object.hasOwn(projectFile, 'projectId'), false);
  assert.equal(readState(fixture).project.scriptId, remote.scriptId);
  assert.equal(readState(fixture).project.projectId, undefined);
  assert.equal(readState(fixture).project.cloudProjectMode, 'apps-script-default');
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
    { fs: fixture.fs, runner: remote.runner, provisionRequester: provisionRequest.requester }
  );
  assert.deepEqual(mutationEvents(fixture.events), []);
  assert.equal(provisionRequest.calls.length, 1);
  assert.deepEqual(provisionRequest.calls[0].request, {
    webhookUrl: `https://script.google.com/macros/s/${remote.remote.deploymentId}/exec`,
    scriptId: remote.scriptId,
    timeoutMs: provision.PROVISION_TIMEOUT_MS
  });
  assert.equal(readState(fixture).lifecycle, 'provisioned');
  assert.equal(readState(fixture).pendingOperation, null);
  assert.equal(readState(fixture).deployment.approvedVersion, 12);
  assert.equal(readState(fixture).sheet.resolved, true);
  assert.equal(readState(fixture).netlify.syncEnabled, false);

  const status = await provision.statusProductionProvisioning(
    fixture.options,
    { fs: fixture.fs, runner: remote.runner }
  );
  assert.equal(status.lifecycle, 'provisioned');
  assert.equal(status.sheetResolved, true);
  assert.equal(status.rollbackPrepared, false);
  assert.equal(status.restorePrepared, false);

  for (const result of [...results, deployed, provisioned, status]) assertSanitized(result, privateValues);
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
  const provisionRequest = makeProvisionRequester(fixture);
  for (const action of ['create', 'push', 'version', 'deploy', 'provision']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner,
      provisionRequester: provisionRequest.requester
    });
  }
  assert.equal(provisionRequest.calls.length, 1);
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
  assert.equal(readState(fixture).deployment.approvedVersion, 13);
  assert.equal(readState(fixture).lifecycle, 'provisioned');
  assert.equal(readState(fixture).netlify.syncEnabled, false);
  assert.equal(provisionRequest.calls.length, 1, 'A later update must not reopen one-time provisioning.');
  assert.equal(updated.rollbackPrepared, true);
  assert.equal(updated.restorePrepared, false);

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
  assert.equal(rolledBack.summary.rollbackPrepared, false);
  assert.equal(rolledBack.summary.restorePrepared, true);

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
  assert.equal(readState(fixture).netlify.syncEnabled, false);
  assert.equal(provisionRequest.calls.length, 1);
  assert.equal(restored.summary.rollbackPrepared, true);
  assert.equal(restored.summary.restorePrepared, false);
  for (const result of [updated, rolledBack, restored]) {
    assertSanitized(result, [remote.remote.deploymentId, remote.scriptId]);
  }
});

test('a post-move verification mismatch preserves the private journal and exposes no raw response', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  const provisionRequest = makeProvisionRequester(fixture);
  for (const action of ['create', 'push', 'version', 'deploy', 'provision', 'push', 'version']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner,
      provisionRequester: provisionRequest.requester
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

test('the private provisioning request is one bounded POST and keeps its credential only in the body', async () => {
  const provision = await loadTool();
  const scriptId = 'privateProductionScriptIdentifier123456789';
  const webhookUrl = 'https://script.google.com/macros/s/privateProductionDeploymentIdentifier123456789/exec';
  const signal = Object.freeze({ synthetic: 'timeout-signal' });
  const calls = [];
  const result = await provision.requestProductionProvisioning(
    { webhookUrl, scriptId, timeoutMs: provision.PROVISION_TIMEOUT_MS },
    {
      timeoutSignalFactory(timeoutMs) {
        assert.equal(timeoutMs, 25_000);
        return signal;
      },
      async fetchImpl(url, init) {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(validProvisionResult())
        };
      }
    }
  );

  assert.deepEqual(result, validProvisionResult());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, webhookUrl);
  assert.equal(calls[0].url.includes('?'), false);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'follow');
  assert.equal(calls[0].init.signal, signal);
  assert.deepEqual(calls[0].init.headers, {
    Accept: 'application/json',
    'Content-Type': 'text/plain;charset=utf-8'
  });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'provisioningSecret', 'target']);
  assert.equal(body.action, provision.PROVISION_ACTION);
  assert.equal(body.target, 'production');
  assert.equal(typeof body.provisioningSecret, 'string');
  assert.ok(body.provisioningSecret.length >= 32);
  assert.notEqual(body.provisioningSecret, scriptId);
  assert.equal(JSON.stringify({ url: calls[0].url, headers: calls[0].init.headers }).includes(body.provisioningSecret), false);
});

test('status allowlists lifecycle text and never claims rollback or restore from corrupt state', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  await provision.executeProductionAction(
    'create',
    actionOptions(fixture, provision, 'create'),
    { fs: fixture.fs, runner: remote.runner }
  );
  const lifecycleCanary = 'private-lifecycle-canary-that-must-not-leak';
  const state = readState(fixture);
  state.lifecycle = lifecycleCanary;
  state.deployment.currentVersion = 12;
  state.deployment.approvedVersion = 12;
  state.deployment.previousVersion = 11;
  state.deployment.rolledBackFromVersion = 12;
  writeFileSync(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const status = await provision.statusProductionProvisioning(
    fixture.options,
    { fs: fixture.fs, runner: remote.runner }
  );
  assert.equal(status.lifecycle, 'unknown');
  assert.equal(status.rollbackPrepared, false);
  assert.equal(status.restorePrepared, false);
  assert.equal(JSON.stringify(status).includes(lifecycleCanary), false);
});

test('timeout, HTTP failure, unreadable JSON, and response drift stop after one sanitized request', async t => {
  const provision = await loadTool();
  const privateMarker = 'private-provision-response-marker-that-must-not-leak';
  const cases = [
    {
      name: 'timeout',
      fetchImpl: async () => {
        const error = new Error(privateMarker);
        error.name = 'AbortError';
        throw error;
      }
    },
    {
      name: 'HTTP error',
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => privateMarker
      })
    },
    {
      name: 'unreadable JSON',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => `<html>${privateMarker}</html>`
      })
    },
    {
      name: 'response drift',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ...validProvisionResult(), extra: privateMarker })
      })
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let calls = 0;
      let failure;
      try {
        await provision.requestProductionProvisioning(
          {
            webhookUrl: 'https://script.google.com/macros/s/privateProductionDeploymentIdentifier123456789/exec',
            scriptId: 'privateProductionScriptIdentifier123456789',
            timeoutMs: provision.PROVISION_TIMEOUT_MS
          },
          {
            timeoutSignalFactory: () => Object.freeze({ synthetic: true }),
            fetchImpl: async (...args) => {
              calls += 1;
              return item.fetchImpl(...args);
            }
          }
        );
      } catch (error) {
        failure = error;
      }
      assert.equal(calls, 1);
      assert.equal(failure?.code, 'PROVISION_RESPONSE_AMBIGUOUS');
      assertSanitized(
        { name: failure?.name, code: failure?.code, message: failure?.message },
        [privateMarker, 'privateProductionDeploymentIdentifier123456789', 'privateProductionScriptIdentifier123456789']
      );
    });
  }
});

test('deployment drift fails before the one-shot provisioning requester', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  for (const action of ['create', 'push', 'version', 'deploy']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner
    });
  }
  remote.remote.activeVersion = 99;
  let requestCalls = 0;
  await assert.rejects(
    () => provision.executeProductionAction(
      'provision',
      actionOptions(fixture, provision, 'provision'),
      {
        fs: fixture.fs,
        runner: remote.runner,
        provisionRequester: async () => {
          requestCalls += 1;
          return validProvisionResult();
        }
      }
    ),
    error => error?.code === 'CLASP_DEPLOYMENT_STATE_DRIFT'
  );
  assert.equal(requestCalls, 0);
  assert.equal(readState(fixture).lifecycle, 'deployed-unprovisioned');
  assert.equal(readState(fixture).pendingOperation, null);
});

test('an unreadable or failed provisioning result is ambiguous, journaled, sanitized, and never retried', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  for (const action of ['create', 'push', 'version', 'deploy']) {
    await provision.executeProductionAction(action, actionOptions(fixture, provision, action), {
      fs: fixture.fs,
      runner: remote.runner
    });
  }
  const privateErrorMarker = 'private-web-response-body-that-must-not-leak';
  let requestCalls = 0;
  let failure;
  try {
    await provision.executeProductionAction(
      'provision',
      actionOptions(fixture, provision, 'provision'),
      {
        fs: fixture.fs,
        runner: remote.runner,
        provisionRequester: async () => {
          requestCalls += 1;
          throw new Error(privateErrorMarker);
        }
      }
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'PROVISION_RESPONSE_AMBIGUOUS');
  assertSanitized(
    { name: failure?.name, code: failure?.code, message: failure?.message },
    [privateErrorMarker, remote.remote.deploymentId, remote.scriptId]
  );
  assert.equal(requestCalls, 1);
  assert.equal(readState(fixture).lifecycle, 'provisioning-ambiguous');
  assert.deepEqual(readState(fixture).pendingOperation, {
    action: 'provision',
    deploymentId: remote.remote.deploymentId,
    fromVersion: 12,
    toVersion: 12
  });

  await assert.rejects(
    () => provision.executeProductionAction(
      'provision',
      actionOptions(fixture, provision, 'provision'),
      {
        fs: fixture.fs,
        runner: remote.runner,
        provisionRequester: async () => {
          requestCalls += 1;
          return validProvisionResult();
        }
      }
    )
  );
  assert.equal(requestCalls, 1, 'An ambiguous provisioning request must never be retried blindly.');
});

test('install-link saves capability material only in the ignored private artifact', async t => {
  const provision = await loadTool();
  const fixture = makeFixture(t, provision);
  const remote = makeRemoteRunner(fixture, provision);
  const provisionRequest = makeProvisionRequester(fixture);
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
      runner: remote.runner,
      provisionRequester: provisionRequest.requester
    });
  }
  assert.equal(provisionRequest.calls.length, 1);
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
  const manifestSource = readFileSync(REAL_MANIFEST, 'utf8');
  assert.doesNotMatch(
    source,
    /['"`](?:delete-script|delete-deployment|undeploy|login|logout|open-credentials-setup|enable-api|disable-api)['"`]/iu
  );
  assert.doesNotMatch(source, /netlify\s+(?:deploy\s+--prod|env:(?:set|import|unset))/iu);
  assert.doesNotMatch(source, /(?:setEnvVarValue|deleteEnvVar|production_deploy)/u);
  assert.doesNotMatch(source, /\brun-function\b|\bscripts\.run\b|\bapiExecutable\b/iu);
  assert.doesNotMatch(manifestSource, /"executionApi"|"apiExecutable"/u);
});
