#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_CLASP_VERSION = '3.3.0';
export const PRODUCTION_SCRIPT_TITLE = 'RBJJ M1 Receiver — PRODUCTION';
export const PRODUCTION_SHEET_TITLE = 'RBJJ M1 — PRODUCTION';
export const PRODUCTION_ORIGIN = 'https://gib-live.netlify.app';
export const PROVISION_FUNCTION = 'provisionGibM1ProductionReceiver';
export const PRIVATE_STATE_SCHEMA = 'gib-m1-production-private-state/v1';
export const PRIVATE_CONFIG_SCHEMA = 'gib-m1-production-private-config/v1';
export const INSTALL_LINK_PATH = '/m1/tablet-install.html';
export const INSTALL_CAPABILITY_SECONDS = 60;
export const PROVISIONING_SEQUENCE = Object.freeze([
  'prepare',
  'create',
  'push',
  'version',
  'deploy',
  'provision',
]);
export const STAGED_SOURCE_FILES = Object.freeze([
  'Code.gs',
  'GibM1Receiver.gs',
  'appsscript.json',
]);
export const MUTATING_ACTIONS = Object.freeze(new Set([
  'create',
  'push',
  'provision',
  'version',
  'deploy',
  'update',
  'rollback',
  'restore',
  'install-link',
]));

const SOURCE_FILES = Object.freeze([
  ['wrapper', 'Code.gs'],
  ['receiver', 'GibM1Receiver.gs'],
  ['manifest', 'appsscript.json'],
]);
const CLASP_IGNORE = '**/*\n!Code.gs\n!GibM1Receiver.gs\n!appsscript.json\n';
const ID_PATTERN = /^[A-Za-z0-9_-]{8,512}$/u;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,62}$/u;
const INSTALL_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;

export class ProductionProvisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionProvisionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionProvisionError(code, message);
}

export function confirmationForAction(action) {
  const normalized = String(action || '').toLowerCase();
  if (!MUTATING_ACTIONS.has(normalized)) {
    fail('INVALID_MUTATION_ACTION', 'The requested production mutation is not supported.');
  }
  return `M1-PRODUCTION-${normalized.toUpperCase()}`;
}

export function authorizeMutation({ action, execute, confirm, confirmation }) {
  const normalized = String(action || '').toLowerCase();
  let expected;
  try { expected = confirmationForAction(normalized); }
  catch { return false; }
  return execute === true && (confirmation ?? confirm) === expected;
}

function requireAuthorization(authorization) {
  if (authorization !== true) {
    fail('MUTATION_GATE_CLOSED', 'The production mutation gate is closed.');
  }
}

export function buildProductionStage(sources = {}) {
  const wrapper = sources.wrapperSource ?? sources.productionWrapper;
  const receiver = sources.receiverSource ?? sources.sharedReceiver;
  const manifest = sources.manifestSource ?? sources.productionManifest;
  if (![wrapper, receiver, manifest].every(value => typeof value === 'string')) {
    fail('PRODUCTION_SOURCE_MISSING', 'The reviewed production stage source is incomplete.');
  }
  return new Map([
    ['Code.gs', wrapper],
    ['GibM1Receiver.gs', receiver],
    ['appsscript.json', manifest],
  ]);
}

const nodeFs = Object.freeze({
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
});

function cleanEnvironment(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key]) => {
    return !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|WEBHOOK|SHEET_ID|SCRIPT_ID|DEPLOYMENT_ID)/iu.test(key);
  }));
}

export function createCommandRunner({ timeoutMs = 60_000 } = {}) {
  return ({ executable, args, cwd, env = process.env }) => new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      env: cleanEnvironment(env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (!settled) child.kill();
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: '' });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: Number.isInteger(code) ? code : 1, stdout, stderr });
    });
  });
}

function resolvePaths(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const privateDir = path.resolve(options.privateDir || path.join(repoRoot, 'private', 'm1-production'));
  const projectDir = path.resolve(options.projectDir || path.join(privateDir, 'clasp-project'));
  const resolved = {
    repoRoot,
    privateDir,
    projectDir,
    bootstrapDir: path.resolve(options.bootstrapDir || path.join(privateDir, 'clasp-bootstrap')),
    statePath: path.resolve(options.statePath || path.join(privateDir, 'state.json')),
    configPath: path.resolve(options.configPath || path.join(privateDir, 'config.json')),
    installerLinkPath: path.resolve(options.installerLinkPath || path.join(privateDir, 'installer-link.txt')),
    wrapperPath: path.resolve(options.wrapperPath || path.join(repoRoot, 'integrations', 'google-apps-script', 'production', 'Code.gs')),
    receiverPath: path.resolve(options.receiverPath || path.join(repoRoot, 'integrations', 'google-apps-script', 'GibM1Receiver.gs')),
    manifestPath: path.resolve(options.manifestPath || path.join(repoRoot, 'integrations', 'google-apps-script', 'production', 'appsscript.json')),
    claspPath: path.resolve(options.claspPath || path.join(
      repoRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'clasp.cmd' : 'clasp',
    )),
  };
  for (const privatePath of [
    resolved.projectDir,
    resolved.bootstrapDir,
    resolved.statePath,
    resolved.configPath,
    resolved.installerLinkPath,
  ]) {
    if (!isInside(privateDir, privatePath)) {
      fail('PRIVATE_PATH_OUTSIDE_PRIVATE_DIR', 'Production-private paths must stay inside the ignored private directory.');
    }
  }
  return Object.freeze(resolved);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function privatePathIgnored({ repoRoot, privateDir, fs = nodeFs }) {
  const privateRoot = path.join(path.resolve(repoRoot), 'private');
  if (!isInside(privateRoot, path.resolve(privateDir))) return false;
  try {
    const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    return ignore.split(/\r?\n/u).map(line => line.trim()).includes('/private/');
  } catch {
    return false;
  }
}

function parseJson(text, code = 'INVALID_PRIVATE_JSON') {
  try { return JSON.parse(String(text)); }
  catch { fail(code, 'A required private JSON file is not valid.'); }
}

function readOptionalJson(filePath, fs) {
  if (!fs.existsSync(filePath)) return null;
  return parseJson(fs.readFileSync(filePath, 'utf8'));
}

function writePrivateText(filePath, value, fs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function writePrivateJson(filePath, value, fs) {
  writePrivateText(filePath, `${JSON.stringify(value, null, 2)}\n`, fs);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function derivedProductionReceiverToken(scriptId) {
  return createHash('sha256')
    .update(`gib-m1-production:${scriptId}`, 'utf8')
    .digest('base64url');
}

function validateSource(paths, fs) {
  const missing = [paths.wrapperPath, paths.receiverPath, paths.manifestPath]
    .filter(filePath => !fs.existsSync(filePath));
  if (missing.length) fail('PRODUCTION_SOURCE_MISSING', 'The reviewed production Apps Script source is incomplete.');
  const wrapper = fs.readFileSync(paths.wrapperPath, 'utf8');
  const receiver = fs.readFileSync(paths.receiverPath, 'utf8');
  const manifestText = fs.readFileSync(paths.manifestPath, 'utf8');
  const manifest = parseJson(manifestText, 'PRODUCTION_MANIFEST_INVALID');
  if (
    !/GIB_M1_ALLOWED_TARGET\s*=\s*['"]production['"]/u.test(wrapper)
    || !new RegExp(`function\\s+${PROVISION_FUNCTION}\\s*\\(`, 'u').test(wrapper)
    || /RBJJ M1\s+—\s+TEST|GIB_M1_ALLOWED_TARGET\s*=\s*['"]test['"]/u.test(wrapper)
    || receiver.length < 1_000
    || manifest?.executionApi?.access !== 'MYSELF'
    || manifest?.webapp?.access !== 'ANYONE_ANONYMOUS'
    || manifest?.webapp?.executeAs !== 'USER_DEPLOYING'
  ) {
    fail('PRODUCTION_SOURCE_UNSAFE', 'The reviewed production Apps Script package failed its target-lock checks.');
  }
  return Object.freeze({
    wrapper,
    receiver,
    manifestText,
    hashes: Object.freeze({
      wrapper: sha256Hex(wrapper),
      receiver: sha256Hex(receiver),
      manifest: sha256Hex(manifestText),
    }),
  });
}

function readPrivateConfig(paths, fs) {
  const config = readOptionalJson(paths.configPath, fs);
  if (!config) return null;
  if (
    config.schema !== PRIVATE_CONFIG_SCHEMA
    || !PROJECT_ID_PATTERN.test(String(config.projectId || ''))
  ) fail('PRIVATE_CONFIG_INVALID', 'The ignored production configuration is invalid.');
  return config;
}

function resolvePrivateAuthPath(config, paths, fs) {
  if (!config?.authPath) return null;
  const authPath = path.resolve(paths.privateDir, String(config.authPath));
  if (!isInside(paths.privateDir, authPath) || !fs.existsSync(authPath)) {
    fail('CLASP_AUTH_PATH_INVALID', 'The optional clasp auth file must exist inside the ignored private directory.');
  }
  return authPath;
}

function readPrivateState(paths, fs) {
  const state = readOptionalJson(paths.statePath, fs);
  if (!state) return null;
  if (state.schema !== PRIVATE_STATE_SCHEMA) {
    fail('PRIVATE_STATE_INVALID', 'The ignored production state has the wrong schema.');
  }
  return state;
}

function projectFilePath(paths) {
  return path.join(paths.projectDir, '.clasp.json');
}

function readProjectFile(paths, fs) {
  const filePath = projectFilePath(paths);
  if (!fs.existsSync(filePath)) return null;
  const project = parseJson(fs.readFileSync(filePath, 'utf8'), 'CLASP_PROJECT_STATE_INVALID');
  if (
    !ID_PATTERN.test(String(project.scriptId || ''))
    || !PROJECT_ID_PATTERN.test(String(project.projectId || ''))
  ) fail('CLASP_PROJECT_STATE_INVALID', 'The ignored clasp project state is unusable.');
  return project;
}

function writeProjectFile(paths, project, fs) {
  if (
    !ID_PATTERN.test(String(project.scriptId || ''))
    || !PROJECT_ID_PATTERN.test(String(project.projectId || ''))
  ) fail('CLASP_PROJECT_STATE_INVALID', 'The clasp project identity is unusable.');
  writePrivateJson(projectFilePath(paths), {
    scriptId: project.scriptId,
    projectId: project.projectId,
    rootDir: '.',
    filePushOrder: ['Code.gs', 'GibM1Receiver.gs'],
  }, fs);
}

function ensureNoUnexpectedStageFiles(paths, fs) {
  if (typeof fs.readdirSync !== 'function' || !fs.existsSync(paths.projectDir)) return;
  const allowed = new Set([
    '.clasp.json',
    '.claspignore',
    'Code.gs',
    'GibM1Receiver.gs',
    'appsscript.json',
  ]);
  const unexpected = fs.readdirSync(paths.projectDir).filter(name => !allowed.has(name));
  if (unexpected.length) fail('UNEXPECTED_STAGING_FILE', 'The ignored clasp stage contains an unexpected file.');
}

function stageReviewedSource(paths, source, fs, authorization) {
  requireAuthorization(authorization, 'push');
  fs.mkdirSync(paths.projectDir, { recursive: true });
  ensureNoUnexpectedStageFiles(paths, fs);
  writePrivateText(path.join(paths.projectDir, 'Code.gs'), source.wrapper, fs);
  writePrivateText(path.join(paths.projectDir, 'GibM1Receiver.gs'), source.receiver, fs);
  writePrivateText(path.join(paths.projectDir, 'appsscript.json'), source.manifestText, fs);
  writePrivateText(path.join(paths.projectDir, '.claspignore'), CLASP_IGNORE, fs);
  ensureNoUnexpectedStageFiles(paths, fs);
}

function command(action, args, cwd, paths, authPath = null) {
  const finalArgs = authPath ? ['-A', authPath, ...args] : args;
  return Object.freeze({ action, executable: paths.claspPath, args: Object.freeze(finalArgs), cwd });
}

async function runCaptured(runner, spec, errorCode) {
  let result;
  try { result = await runner(spec); }
  catch { fail(errorCode, 'A captured clasp command failed safely.'); }
  if (!result || result.code !== 0) fail(errorCode, 'A captured clasp command failed safely.');
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function findJsonValue(output) {
  const text = String(output || '').trim();
  const candidates = [text, ...text.split(/\r?\n/u).reverse()];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/^Result:\s*/iu, '').trim();
    try { return JSON.parse(cleaned); } catch {}
  }
  return null;
}

async function claspPreflight({ paths, runner, env, authPath = null }) {
  const version = await runCaptured(
    runner,
    command('status', ['--version'], paths.repoRoot, paths, authPath),
    'CLASP_UNAVAILABLE',
  );
  if (version.stdout.trim().replace(/^v/u, '') !== REQUIRED_CLASP_VERSION) {
    fail('CLASP_VERSION_MISMATCH', 'The pinned clasp version is unavailable.');
  }
  const auth = await runCaptured(
    runner,
    { ...command('status', ['show-authorized-user', '--json'], paths.repoRoot, paths, authPath), env },
    'CLASP_AUTH_UNUSABLE',
  );
  const value = findJsonValue(auth.stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CLASP_AUTH_UNUSABLE', 'Existing clasp authorization could not be verified.');
  }
  if (value.loggedIn !== true) {
    fail('CLASP_AUTH_UNUSABLE', 'Existing clasp authorization could not be verified.');
  }
  return true;
}

function strictProvisionResult(output) {
  const envelope = findJsonValue(output);
  if (
    !envelope
    || typeof envelope !== 'object'
    || Array.isArray(envelope)
    || JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(['response'])
  ) fail('PROVISION_RESPONSE_INVALID', 'The production provision response was not complete and sanitized.');
  const value = typeof envelope.response === 'string'
    ? findJsonValue(envelope.response)
    : envelope.response;
  const expectedKeys = [
    'created',
    'dataRowCount',
    'headerCount',
    'ok',
    'signinsSheet',
    'spreadsheetMatches',
    'spreadsheetTitle',
    'target',
  ];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.ok !== true
    || value.target !== 'production'
    || value.spreadsheetTitle !== PRODUCTION_SHEET_TITLE
    || value.spreadsheetMatches !== 1
    || typeof value.created !== 'boolean'
    || value.signinsSheet !== 'Signins'
    || value.headerCount !== 11
    || !Number.isInteger(value.dataRowCount)
    || value.dataRowCount < 0
  ) fail('PROVISION_RESPONSE_INVALID', 'The production provision response was not complete and sanitized.');
  return value;
}

function parseVersionNumber(output) {
  const value = findJsonValue(output);
  const candidates = [
    value?.versionNumber,
    value?.version,
    ...[...String(output).matchAll(/\bversion(?:\s+number)?\D{0,12}(\d+)\b/giu)].map(match => Number(match[1])),
  ].filter(item => Number.isInteger(Number(item)) && Number(item) > 0).map(Number);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) fail('CLASP_VERSION_OUTPUT_INVALID', 'The immutable version response was unreadable.');
  return unique[0];
}

function parseDeploymentId(output) {
  const value = findJsonValue(output);
  const candidates = [value?.deploymentId, value?.id].filter(item => ID_PATTERN.test(String(item || '')));
  for (const match of String(output).matchAll(/(?:deployment(?:\s+id)?\s*[:=-]?|^-\s*)([A-Za-z0-9_-]{20,512})/gimu)) {
    if (ID_PATTERN.test(match[1])) candidates.push(match[1]);
  }
  const unique = [...new Set(candidates.map(String))];
  if (unique.length !== 1) fail('CLASP_DEPLOYMENT_OUTPUT_INVALID', 'The deployment response was unreadable.');
  return unique[0];
}

function deploymentVersionFromList(output, deploymentId) {
  const value = findJsonValue(output);
  const items = Array.isArray(value) ? value : (value?.deployments || value?.items);
  if (!Array.isArray(items)) {
    fail('CLASP_DEPLOYMENT_LIST_INVALID', 'The deployment inventory was unreadable.');
  }
  const matches = items.filter(item => String(item?.deploymentId || item?.id || '') === deploymentId);
  const version = Number(matches[0]?.versionNumber ?? matches[0]?.version);
  if (matches.length !== 1 || !Number.isInteger(version) || version < 1) {
    fail('CLASP_DEPLOYMENT_STATE_AMBIGUOUS', 'The deployment inventory did not match private state.');
  }
  return version;
}

async function verifiedDeploymentMove({
  action,
  state,
  fromVersion,
  toVersion,
  description,
  paths,
  authPath,
  fs,
  runner,
  env,
}) {
  const deploymentId = state?.deployment?.deploymentId;
  if (
    !ID_PATTERN.test(String(deploymentId || ''))
    || !Number.isInteger(fromVersion)
    || !Number.isInteger(toVersion)
  ) fail('DEPLOYMENT_MOVE_STATE_INVALID', 'A deployment move requires exact private versions.');
  const listSpec = command('status', ['list-deployments', '--json'], paths.projectDir, paths, authPath);
  const before = await runCaptured(runner, { ...listSpec, env }, 'CLASP_DEPLOYMENT_LIST_FAILED');
  if (deploymentVersionFromList(before.stdout, deploymentId) !== fromVersion) {
    fail('CLASP_DEPLOYMENT_STATE_DRIFT', 'Remote deployment state changed outside the private lifecycle.');
  }
  state.pendingOperation = {
    action,
    deploymentId,
    fromVersion,
    toVersion,
  };
  writePrivateJson(paths.statePath, state, fs);
  const updateSpec = command(action, [
    'update-deployment',
    deploymentId,
    '--versionNumber',
    String(toVersion),
    '--description',
    description,
    '--json',
  ], paths.projectDir, paths, authPath);
  await runCaptured(runner, { ...updateSpec, env }, `CLASP_${action.toUpperCase().replace('-', '_')}_FAILED`);
  const after = await runCaptured(runner, { ...listSpec, env }, 'CLASP_DEPLOYMENT_LIST_FAILED');
  if (deploymentVersionFromList(after.stdout, deploymentId) !== toVersion) {
    fail('CLASP_DEPLOYMENT_STATE_AMBIGUOUS', 'Deployment mutation could not be verified; private journal was preserved.');
  }
  state.pendingOperation = null;
  return { listSpec, updateSpec };
}

function validateFileStatus(output) {
  const value = findJsonValue(output);
  const items = Array.isArray(value)
    ? value
    : (value?.filesToPush || value?.files || value?.items);
  if (!Array.isArray(items)) fail('CLASP_FILE_STATUS_INVALID', 'Clasp file status was unreadable.');
  const names = items.map(item => path.basename(typeof item === 'string' ? item : String(item?.name || item?.path || '')));
  const expected = ['Code.gs', 'GibM1Receiver.gs', 'appsscript.json'];
  if (JSON.stringify([...new Set(names)].sort()) !== JSON.stringify(expected.sort())) {
    fail('CLASP_FILE_STATUS_INVALID', 'Clasp would push files outside the exact production package.');
  }
}

function initialState(project, source) {
  return {
    schema: PRIVATE_STATE_SCHEMA,
    lifecycle: 'script-created',
    project: {
      scriptId: project.scriptId,
      projectId: project.projectId,
      title: PRODUCTION_SCRIPT_TITLE,
    },
    deployment: {
      deploymentId: null,
      webhookUrl: null,
      currentVersion: null,
      approvedVersion: null,
      previousVersion: null,
      rolledBackFromVersion: null,
    },
    sheet: {
      title: PRODUCTION_SHEET_TITLE,
      resolved: false,
      created: false,
      matchCount: 0,
      headerCount: 0,
      dataRowCount: 0,
    },
    netlify: {
      origin: PRODUCTION_ORIGIN,
      webhookUrl: null,
      receiverToken: derivedProductionReceiverToken(project.scriptId),
      syncEnabled: false,
    },
    source: source.hashes,
    installer: { generated: false, expiresInSeconds: 0 },
  };
}

function projectFromState(state) {
  const scriptId = state?.project?.scriptId;
  const projectId = state?.project?.projectId;
  if (!ID_PATTERN.test(String(scriptId || '')) || !PROJECT_ID_PATTERN.test(String(projectId || ''))) {
    fail('PRIVATE_PROJECT_STATE_MISSING', 'The ignored production project identity is incomplete.');
  }
  return { scriptId, projectId };
}

function safeSummary(overrides = {}) {
  return Object.freeze({
    ok: overrides.ok === true,
    dryRun: overrides.dryRun === true,
    sourceReady: overrides.sourceReady === true,
    privatePathIgnored: overrides.privatePathIgnored === true,
    authUsable: overrides.authUsable === true,
    projectStateUsable: overrides.projectStateUsable === true,
    stagedFileCount: Number(overrides.stagedFileCount || 0),
    commandCount: Number(overrides.commandCount || 0),
    sheetResolved: overrides.sheetResolved === true,
    sheetCreated: overrides.sheetCreated === true,
    sheetMatchCount: Number(overrides.sheetMatchCount || 0),
    headerCount: Number(overrides.headerCount || 0),
    dataRowCount: Number(overrides.dataRowCount || 0),
    rollbackPrepared: overrides.rollbackPrepared === true,
    restorePrepared: overrides.restorePrepared === true,
    installerLinkSaved: overrides.installerLinkSaved === true,
    expiresInSeconds: Number(overrides.expiresInSeconds || 0),
    lifecycle: String(overrides.lifecycle || 'unknown'),
  });
}

export async function statusProductionProvisioning(options = {}, dependencies = {}) {
  const fs = dependencies.fs || nodeFs;
  const runner = dependencies.runner || createCommandRunner();
  const paths = resolvePaths(options);
  const ignored = privatePathIgnored({ ...paths, fs });
  if (!ignored) {
    return safeSummary({ ok: true, dryRun: true, lifecycle: 'absent' });
  }
  let sourceReady = false;
  let authUsable = false;
  try { validateSource(paths, fs); sourceReady = true; } catch {}
  let authPath = null;
  let authConfigUsable = true;
  try {
    const config = readPrivateConfig(paths, fs);
    authPath = resolvePrivateAuthPath(config, paths, fs);
  } catch {
    authConfigUsable = false;
  }
  if (authConfigUsable) {
    try {
      await claspPreflight({ paths, runner, env: options.env || process.env, authPath });
      authUsable = true;
    } catch {}
  }
  let state = null;
  let project = null;
  try { state = readPrivateState(paths, fs); } catch {}
  try { project = readProjectFile(paths, fs); } catch {}
  const projectStateUsable = Boolean(
    state
    && project
    && state.project?.scriptId === project.scriptId
    && state.project?.projectId === project.projectId
  );
  return safeSummary({
    ok: true,
    dryRun: true,
    sourceReady,
    privatePathIgnored: ignored,
    authUsable,
    projectStateUsable,
    sheetResolved: state?.sheet?.resolved === true,
    sheetCreated: state?.sheet?.created === true,
    sheetMatchCount: state?.sheet?.matchCount,
    headerCount: state?.sheet?.headerCount,
    dataRowCount: state?.sheet?.dataRowCount,
    currentVersion: state?.deployment?.currentVersion,
    approvedVersion: state?.deployment?.approvedVersion,
    previousVersion: state?.deployment?.previousVersion,
    rollbackPrepared: Number.isInteger(state?.deployment?.previousVersion),
    restorePrepared: state?.deployment?.rolledBackFromVersion === state?.deployment?.approvedVersion,
    installerLinkSaved: state?.installer?.generated === true,
    expiresInSeconds: state?.installer?.expiresInSeconds,
    lifecycle: state?.lifecycle || 'absent',
  });
}

export async function prepareProductionProvisioning(options = {}, dependencies = {}) {
  const fs = dependencies.fs || nodeFs;
  const runner = dependencies.runner || createCommandRunner();
  const paths = resolvePaths(options);
  if (!privatePathIgnored({ ...paths, fs })) {
    fail('PRIVATE_PATH_NOT_IGNORED', 'Production state and staging must stay under an ignored private path.');
  }
  const source = validateSource(paths, fs);
  const stage = buildProductionStage({
    wrapperSource: source.wrapper,
    receiverSource: source.receiver,
    manifestSource: source.manifestText,
  });
  if (
    stage.size !== STAGED_SOURCE_FILES.length
    || STAGED_SOURCE_FILES.some(name => !stage.has(name))
  ) fail('PRODUCTION_SOURCE_UNSAFE', 'The reviewed production stage is incomplete.');
  const config = readPrivateConfig(paths, fs);
  if (!config) fail('PRIVATE_CONFIG_MISSING', 'An ignored production config with the standard project ID is required.');
  const authPath = resolvePrivateAuthPath(config, paths, fs);
  await claspPreflight({ paths, runner, env: options.env || process.env, authPath });
  const state = readPrivateState(paths, fs);
  const project = readProjectFile(paths, fs);
  return safeSummary({
    ok: true,
    dryRun: true,
    sourceReady: true,
    privatePathIgnored: true,
    authUsable: true,
    projectStateUsable: Boolean(
      state
      && project
      && state.project?.scriptId === project.scriptId
      && state.project?.projectId === project.projectId
    ),
    stagedFileCount: stage.size,
    lifecycle: state?.lifecycle || 'absent',
  });
}

function summaryFromState(state, overrides = {}) {
  return safeSummary({
    ok: true,
    sourceReady: true,
    privatePathIgnored: true,
    authUsable: true,
    projectStateUsable: Boolean(state?.project?.scriptId),
    stagedFileCount: overrides.stagedFileCount,
    commandCount: overrides.commandCount,
    sheetResolved: state?.sheet?.resolved === true,
    sheetCreated: state?.sheet?.created === true,
    sheetMatchCount: state?.sheet?.matchCount,
    headerCount: state?.sheet?.headerCount,
    dataRowCount: state?.sheet?.dataRowCount,
    rollbackPrepared: Number.isInteger(state?.deployment?.previousVersion),
    restorePrepared: state?.deployment?.rolledBackFromVersion === state?.deployment?.approvedVersion,
    installerLinkSaved: state?.installer?.generated === true,
    expiresInSeconds: state?.installer?.expiresInSeconds,
    lifecycle: state?.lifecycle,
  });
}

function checkedProjectState(paths, fs, missingCode = 'PRIVATE_PROJECT_STATE_MISSING') {
  const state = readPrivateState(paths, fs);
  const project = readProjectFile(paths, fs);
  if (!state || !project) fail(missingCode, 'The ignored production project state is missing.');
  const expected = projectFromState(state);
  if (expected.scriptId !== project.scriptId || expected.projectId !== project.projectId) {
    fail('PRIVATE_PROJECT_STATE_MISMATCH', 'Private project identifiers do not match.');
  }
  if (state.pendingOperation) {
    fail('PENDING_OPERATION_REQUIRES_RECONCILIATION', 'A prior remote mutation needs exact read-only reconciliation.');
  }
  return { state, project };
}

export async function executeProductionAction(action, options = {}, dependencies = {}) {
  const normalized = String(action || '').toLowerCase();
  if (!MUTATING_ACTIONS.has(normalized)) {
    fail('INVALID_ACTION', 'The production mutation action is unsupported.');
  }
  requireAuthorization(authorizeMutation({
    action: normalized,
    execute: options.execute,
    confirmation: options.confirmation ?? options.confirm,
  }));
  const fs = dependencies.fs || nodeFs;
  const runner = dependencies.runner || createCommandRunner();
  const paths = resolvePaths(options);
  const env = options.env || process.env;
  if (!privatePathIgnored({ ...paths, fs })) {
    fail('PRIVATE_PATH_NOT_IGNORED', 'Production state and staging must stay under an ignored private path.');
  }
  const source = validateSource(paths, fs);
  const config = readPrivateConfig(paths, fs);
  if (!config) fail('PRIVATE_CONFIG_MISSING', 'An ignored production config with the standard project ID is required.');
  const authPath = resolvePrivateAuthPath(config, paths, fs);
  await claspPreflight({ paths, runner, env, authPath });

  if (normalized === 'create') {
    if (readPrivateState(paths, fs) || readProjectFile(paths, fs)) {
      fail('PROJECT_ALREADY_CREATED', 'The private production project already exists.');
    }
    fs.mkdirSync(paths.bootstrapDir, { recursive: true });
    const existingBootstrap = fs.readdirSync(paths.bootstrapDir);
    let created = readOptionalJson(path.join(paths.bootstrapDir, '.clasp.json'), fs);
    if (!created) {
      if (existingBootstrap.length) fail('BOOTSTRAP_NOT_EMPTY', 'The ignored clasp bootstrap directory must be empty.');
      const spec = command('create', [
        'create-script',
        '--type',
        'standalone',
        '--title',
        PRODUCTION_SCRIPT_TITLE,
        '--rootDir',
        '.',
        '--json',
      ], paths.bootstrapDir, paths, authPath);
      await runCaptured(runner, { ...spec, env }, 'CLASP_CREATE_FAILED');
      created = readOptionalJson(path.join(paths.bootstrapDir, '.clasp.json'), fs);
    }
    if (!created || !ID_PATTERN.test(String(created.scriptId || ''))) {
      fail('CLASP_CREATE_STATE_MISSING', 'Clasp did not create a usable private project file.');
    }
    const project = { scriptId: created.scriptId, projectId: config.projectId };
    writeProjectFile(paths, project, fs);
    const state = initialState(project, source);
    writePrivateJson(paths.statePath, state, fs);
    return summaryFromState(state, { commandCount: 1 });
  }

  const { state } = checkedProjectState(paths, fs);
  if (normalized === 'push') {
    if (!['script-created', 'provisioned'].includes(state.lifecycle)) {
      fail('LIFECYCLE_ORDER_INVALID', 'Source push requires a created or approved production project.');
    }
    stageReviewedSource(paths, source, fs, true);
    const fileStatus = command('status', ['show-file-status', '--json'], paths.projectDir, paths, authPath);
    const statusOutput = await runCaptured(runner, { ...fileStatus, env }, 'CLASP_FILE_STATUS_FAILED');
    validateFileStatus(statusOutput.stdout);
    const pushSpec = command('push', ['push', '--force'], paths.projectDir, paths, authPath);
    await runCaptured(runner, { ...pushSpec, env }, 'CLASP_PUSH_FAILED');
    state.source = source.hashes;
    state.lifecycle = 'source-pushed';
    writePrivateJson(paths.statePath, state, fs);
    return summaryFromState(state, { commandCount: 2, stagedFileCount: 3 });
  }

  if (normalized === 'version') {
    if (state.lifecycle !== 'source-pushed') fail('LIFECYCLE_ORDER_INVALID', 'Versioning requires pushed source.');
    const spec = command('version', [
      'create-version',
      'GIB M1 production candidate',
      '--json',
    ], paths.projectDir, paths, authPath);
    const output = await runCaptured(runner, { ...spec, env }, 'CLASP_VERSION_FAILED');
    state.deployment.candidateVersion = parseVersionNumber(output.stdout);
    state.lifecycle = 'versioned';
    writePrivateJson(paths.statePath, state, fs);
    return summaryFromState(state, { commandCount: 1 });
  }

  if (normalized === 'deploy') {
    if (state.lifecycle !== 'versioned' || state.deployment.deploymentId) {
      fail('LIFECYCLE_ORDER_INVALID', 'Initial deploy requires an undeployed immutable version.');
    }
    const version = state.deployment.candidateVersion;
    if (!Number.isInteger(version)) fail('CANDIDATE_VERSION_MISSING', 'The immutable candidate version is missing.');
    state.pendingOperation = { action: 'deploy', deploymentId: null, fromVersion: null, toVersion: version };
    writePrivateJson(paths.statePath, state, fs);
    const spec = command('deploy', [
      'create-deployment',
      '--versionNumber',
      String(version),
      '--description',
      'GIB M1 production candidate',
      '--json',
    ], paths.projectDir, paths, authPath);
    const output = await runCaptured(runner, { ...spec, env }, 'CLASP_DEPLOY_FAILED');
    const deploymentId = parseDeploymentId(output.stdout);
    state.pendingOperation.deploymentId = deploymentId;
    writePrivateJson(paths.statePath, state, fs);
    const listSpec = command('status', ['list-deployments', '--json'], paths.projectDir, paths, authPath);
    const listed = await runCaptured(runner, { ...listSpec, env }, 'CLASP_DEPLOYMENT_LIST_FAILED');
    if (deploymentVersionFromList(listed.stdout, deploymentId) !== version) {
      fail('CLASP_DEPLOYMENT_STATE_AMBIGUOUS', 'Initial deployment could not be verified; private journal was preserved.');
    }
    state.pendingOperation = null;
    state.deployment.deploymentId = deploymentId;
    state.deployment.currentVersion = version;
    state.deployment.previousVersion = null;
    state.deployment.webhookUrl = `https://script.google.com/macros/s/${deploymentId}/exec`;
    state.netlify.webhookUrl = state.deployment.webhookUrl;
    state.lifecycle = 'deployed-unprovisioned';
    writePrivateJson(paths.statePath, state, fs);
    return summaryFromState(state, { commandCount: 2 });
  }

  if (normalized === 'update') {
    if (state.lifecycle !== 'versioned' || !state.deployment.deploymentId) {
      fail('LIFECYCLE_ORDER_INVALID', 'Update requires an existing deployment and immutable candidate.');
    }
    const fromVersion = state.deployment.currentVersion;
    const toVersion = state.deployment.candidateVersion;
    await verifiedDeploymentMove({
      action: 'update', state, fromVersion, toVersion,
      description: 'GIB M1 production candidate', paths, authPath, fs, runner, env,
    });
    state.deployment.previousVersion = fromVersion;
    state.deployment.currentVersion = toVersion;
    state.lifecycle = 'deployed-unprovisioned';
    writePrivateJson(paths.statePath, state, fs);
    return summaryFromState(state, { commandCount: 3 });
  }

  if (normalized === 'provision') {
    if (state.lifecycle !== 'deployed-unprovisioned') {
      fail('LIFECYCLE_ORDER_INVALID', 'Provision requires the immutable fail-closed deployment.');
    }
    const deploymentId = state.deployment.deploymentId;
    const version = state.deployment.currentVersion;
    if (!ID_PATTERN.test(String(deploymentId || '')) || !Number.isInteger(version)) {
      fail('CLASP_DEPLOYMENT_STATE_AMBIGUOUS', 'The deployment state required for provisioning is incomplete.');
    }
    const listSpec = command('status', ['list-deployments', '--json'], paths.projectDir, paths, authPath);
    const listed = await runCaptured(runner, { ...listSpec, env }, 'CLASP_DEPLOYMENT_LIST_FAILED');
    if (deploymentVersionFromList(listed.stdout, deploymentId) !== version) {
      fail('CLASP_DEPLOYMENT_STATE_DRIFT', 'Remote deployment state changed before provisioning.');
    }
    const spec = command('provision', [
      'run-function',
      PROVISION_FUNCTION,
      '--nondev',
      '--json',
    ], paths.projectDir, paths, authPath);
    const output = await runCaptured(runner, { ...spec, env }, 'CLASP_PROVISION_FAILED');
    const result = strictProvisionResult(output.stdout);
    state.sheet = {
      title: PRODUCTION_SHEET_TITLE,
      resolved: true,
      created: result.created,
      matchCount: result.spreadsheetMatches,
      headerCount: result.headerCount,
      dataRowCount: result.dataRowCount,
    };
    state.deployment.approvedVersion = state.deployment.currentVersion;
    state.deployment.candidateVersion = null;
    state.deployment.rolledBackFromVersion = null;
    state.lifecycle = 'provisioned';
    writePrivateJson(paths.statePath, state, fs);
    return summaryFromState(state, { commandCount: 2 });
  }

  fail('USE_DEPLOYMENT_MOVE_ACTION', 'Rollback, restore, and install-link use their dedicated safe operations.');
}

async function moveDeployment(action, options, dependencies) {
  const authorization = authorizeMutation({
    action,
    execute: options.execute,
    confirmation: options.confirmation ?? options.confirm,
  });
  requireAuthorization(authorization);
  const fs = dependencies.fs || nodeFs;
  const runner = dependencies.runner || createCommandRunner();
  const paths = resolvePaths(options);
  const env = options.env || process.env;
  if (!privatePathIgnored({ ...paths, fs })) fail('PRIVATE_PATH_NOT_IGNORED', 'Private state is not ignored.');
  const config = readPrivateConfig(paths, fs);
  if (!config) fail('PRIVATE_CONFIG_MISSING', 'The ignored production config is missing.');
  const authPath = resolvePrivateAuthPath(config, paths, fs);
  await claspPreflight({ paths, runner, env, authPath });
  const { state } = checkedProjectState(paths, fs);
  let fromVersion;
  let toVersion;
  if (action === 'rollback') {
    if (state.lifecycle !== 'provisioned') fail('ROLLBACK_NOT_PREPARED', 'Rollback requires the approved lifecycle.');
    fromVersion = state.deployment.currentVersion;
    toVersion = state.deployment.previousVersion;
    if (!Number.isInteger(toVersion)) fail('ROLLBACK_NOT_PREPARED', 'A recorded prior version is required.');
  } else {
    if (
      state.lifecycle !== 'rolled-back'
      || state.deployment.rolledBackFromVersion !== state.deployment.approvedVersion
    ) fail('RESTORE_NOT_PREPARED', 'Restore requires the exact matching recorded rollback.');
    fromVersion = state.deployment.currentVersion;
    toVersion = state.deployment.approvedVersion;
  }
  await verifiedDeploymentMove({
    action,
    state,
    fromVersion,
    toVersion,
    description: action === 'rollback'
      ? 'GIB M1 production rollback'
      : 'GIB M1 production restore approved version',
    paths,
    authPath,
    fs,
    runner,
    env,
  });
  if (action === 'rollback') {
    state.deployment.rolledBackFromVersion = state.deployment.approvedVersion;
    state.deployment.currentVersion = toVersion;
    state.lifecycle = 'rolled-back';
  } else {
    state.deployment.currentVersion = toVersion;
    state.deployment.rolledBackFromVersion = null;
    state.lifecycle = 'provisioned';
  }
  writePrivateJson(paths.statePath, state, fs);
  return Object.freeze({
    summary: summaryFromState(state, { commandCount: 3 }),
  });
}

export function rollbackProductionDeployment(options = {}, dependencies = {}) {
  return moveDeployment('rollback', options, dependencies);
}

export function restoreProductionDeployment(options = {}, dependencies = {}) {
  return moveDeployment('restore', options, dependencies);
}

function readInstallerSecret(options, paths, fs, env) {
  const fromEnv = env.GIB_M1_PRODUCTION_INSTALL_CAPABILITY_SECRET;
  const secretFile = options.installerSecretFile
    ? path.resolve(options.installerSecretFile)
    : null;
  if (fromEnv && secretFile) fail('INSTALL_SECRET_AMBIGUOUS', 'Use either the private secret environment value or file.');
  let secret = fromEnv;
  if (secretFile) {
    if (!isInside(paths.privateDir, secretFile) || !fs.existsSync(secretFile)) {
      fail('INSTALL_SECRET_FILE_INVALID', 'The installer secret file must be inside the ignored private directory.');
    }
    secret = String(fs.readFileSync(secretFile, 'utf8')).replace(/\r?\n$/u, '');
  }
  if (typeof secret !== 'string' || secret.length < 32 || /[\u0000-\u001f\u007f]/u.test(secret)) {
    fail('INSTALL_SECRET_MISSING', 'A valid private installer capability secret is required.');
  }
  return secret;
}

function validateInstallToken(token, runId, issuedAt, expiresAt) {
  if (typeof token !== 'string' || token.length > 2_048 || !INSTALL_TOKEN_PATTERN.test(token)) {
    fail('INSTALL_CAPABILITY_INVALID', 'The installer capability helper returned an invalid token.');
  }
  const [encodedPayload] = token.split('.');
  let payload;
  try { payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')); }
  catch { fail('INSTALL_CAPABILITY_INVALID', 'The installer capability payload was unreadable.'); }
  const exact = {
    v: 1,
    purpose: 'production-tablet-install',
    origin: PRODUCTION_ORIGIN,
    runId,
    issuedAt,
    expiresAt,
    nonce: payload?.nonce,
  };
  if (
    JSON.stringify(payload) !== JSON.stringify(exact)
    || !/^[A-Za-z0-9_-]{43}$/u.test(String(payload?.nonce || ''))
    || expiresAt - issuedAt !== INSTALL_CAPABILITY_SECONDS
  ) fail('INSTALL_CAPABILITY_INVALID', 'The installer capability payload did not match the production contract.');
}

async function defaultCapabilityFactory({ paths, secret, runId, issuedAt, expiresAt, nonce }) {
  const modulePath = path.join(paths.repoRoot, 'netlify', 'functions', '_lib', 'm1-production-runtime.mjs');
  const runtime = await import(pathToFileURL(modulePath).href);
  if (typeof runtime.createProductionInstallCapability !== 'function') {
    fail('INSTALL_HELPER_MISSING', 'The production installer capability helper is unavailable.');
  }
  return runtime.createProductionInstallCapability({ secret, runId, issuedAt, expiresAt, nonce });
}

export async function generateProductionInstallerLink(options = {}, dependencies = {}) {
  const authorization = authorizeMutation({
    action: 'install-link',
    execute: options.execute,
    confirmation: options.confirmation ?? options.confirm,
  });
  requireAuthorization(authorization);
  const fs = dependencies.fs || nodeFs;
  const paths = resolvePaths(options);
  const env = options.env || process.env;
  if (!privatePathIgnored({ ...paths, fs })) fail('PRIVATE_PATH_NOT_IGNORED', 'The installer link must stay private.');
  const { state } = checkedProjectState(paths, fs, 'INSTALL_LIFECYCLE_INVALID');
  if (state.lifecycle !== 'provisioned') {
    fail('INSTALL_LIFECYCLE_INVALID', 'The production receiver must be provisioned before issuing an installer link.');
  }
  const runId = String(env.GIB_M1_PRODUCTION_INSTALL_RUN_ID || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(runId)) {
    fail('INSTALL_RUN_ID_INVALID', 'The private production installer run ID is invalid.');
  }
  const secret = readInstallerSecret(options, paths, fs, env);
  const now = dependencies.now == null ? Date.now() : Number(dependencies.now);
  const issuedAt = Math.floor(now / 1_000);
  const expiresAt = issuedAt + INSTALL_CAPABILITY_SECONDS;
  const nonce = (dependencies.randomBytes || randomBytes)(32).toString('base64url');
  const capabilityFactory = dependencies.capabilityFactory || (args => defaultCapabilityFactory(args));
  const token = await capabilityFactory({ paths, secret, runId, issuedAt, expiresAt, nonce });
  validateInstallToken(token, runId, issuedAt, expiresAt);
  const link = `${PRODUCTION_ORIGIN}${INSTALL_LINK_PATH}#${token}`;
  writePrivateText(paths.installerLinkPath, `${link}\n`, fs);
  state.installer = { generated: true, expiresInSeconds: INSTALL_CAPABILITY_SECONDS };
  writePrivateJson(paths.statePath, state, fs);
  return Object.freeze({
    summary: safeSummary({
      ok: true,
      privatePathIgnored: true,
      projectStateUsable: true,
      installerLinkSaved: true,
      expiresInSeconds: INSTALL_CAPABILITY_SECONDS,
      lifecycle: state.lifecycle,
    }),
  });
}

function parseArguments(argv) {
  const args = {};
  const positionals = [];
  const booleanFlags = new Set(['execute']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    if (booleanFlags.has(key)) args[key] = true;
    else args[key] = argv[++index];
  }
  return { ...args, positionals };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const action = String(args.positionals[0] || args.action || 'status').toLowerCase();
  const options = {
    execute: args.execute === true,
    confirm: args.confirm,
    confirmation: args.confirm,
    privateDir: args['private-dir'],
    configPath: args.config,
    statePath: args.state,
    installerLinkPath: args['installer-link-path'],
    installerSecretFile: args['installer-secret-file'],
    claspPath: args['clasp-bin'],
  };
  let result;
  if (action === 'status') {
    result = { summary: await statusProductionProvisioning(options) };
  } else if (action === 'prepare') {
    result = { summary: await prepareProductionProvisioning(options) };
  } else if (MUTATING_ACTIONS.has(action) && options.execute !== true) {
    result = { summary: safeSummary({ ok: true, dryRun: true, lifecycle: 'unchanged' }) };
  } else if (['create', 'push', 'version', 'deploy', 'update', 'provision'].includes(action)) {
    result = { summary: await executeProductionAction(action, options) };
  }
  else if (action === 'rollback') result = await rollbackProductionDeployment(options);
  else if (action === 'restore') result = await restoreProductionDeployment(options);
  else if (action === 'install-link') result = await generateProductionInstallerLink(options);
  else fail('INVALID_ACTION', 'Use a documented production provisioning action.');
  console.log(JSON.stringify(result.summary));
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    const safe = error instanceof ProductionProvisionError
      ? { ok: false, code: error.code }
      : { ok: false, code: 'PRODUCTION_PROVISION_FAILED_SAFELY' };
    console.error(JSON.stringify(safe));
    process.exitCode = 1;
  });
}
