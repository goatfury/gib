// Offline preparation only: no credentials, remote calls, uploads or activation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { verifyReleaseRuntime } from './verify-m1-release-runtime.mjs';
import { PUBLIC_FILES, buildPublic } from './build-public.mjs';
import { validateClientFunctions, UPLOAD_CLIENT_VERSION } from './prepare-m1-richmond-test-upload.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const DISABLED_SETTINGS = Object.freeze({
  GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED: 'false',
  GIB_M1_MANAGER_REVIEW_PILOT: 'false', GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'false',
  GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'false', GIB_M1_STAFF_RECOVERY_LIVE_ENABLED: 'false',
  GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED: 'false', GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'false',
  GIB_M1_MAILAPP_LIVE_SEND_ENABLED: 'false', GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED: 'false'
});
export function emailFirstSettings(gym) {
  assert.ok(['rev', 'richmond'].includes(gym));
  return { ...DISABLED_SETTINGS, GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED: 'true', GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'true' };
}
export function activationSettings(gym) {
  assert.ok(['rev', 'richmond'].includes(gym));
  return { ...DISABLED_SETTINGS, GIB_M1_MANAGER_REVIEW_LIVE_PILOT: 'true', GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'true',
    GIB_M1_STAFF_RECOVERY_LIVE_ENABLED: gym === 'rev' ? 'true' : 'false',
    GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED: gym === 'richmond' ? 'true' : 'false' };
}
export const GOOGLE_FILES = Object.freeze({
  rev: ['Code.gs', 'GibM1Receiver.gs', 'GibM1ManagerReview.gs', 'GibM1StaffRecovery.gs', 'GibM1AttendanceDigest.gs', 'GibM1MailApp.gs', 'GibM1ReplyIntake.gs', 'GibM1LiveFeatures.gs', 'GibM1AttendanceEmailFirst.gs', 'appsscript.json', '.claspignore'],
  richmond: ['Code.gs', 'GibM1Receiver.gs', 'GibM1ManagerReview.gs', 'GibM1AttendanceDigest.gs', 'GibM1MailApp.gs', 'GibM1ReplyIntake.gs', 'GibM1LiveFeatures.gs', 'GibM1AttendanceEmailFirst.gs', 'appsscript.json', '.claspignore']
});
async function filesAt(root, prefix) {
  const files = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix + '/' + entry.name;
    if (entry.isDirectory()) files.push(...await filesAt(root, path));
    else if (entry.isFile() && /\.m(?:j|t)s$/.test(entry.name)) files.push(path);
    else throw new Error('Unexpected function source; explicit review required: ' + path);
  }
  return files.sort();
}
export async function packageDisabledRelease({ source, output, cliRoot, root = ROOT, preserveRevolutionPromotions = false, activation = false, emailFirst = false, runtime = process.execPath }) {
  assert.match(source || '', /^[a-f0-9]{40}$/, 'Exact reviewed GitHub source required; local HEAD is not assumed.');
  assert.equal(typeof preserveRevolutionPromotions, 'boolean', 'Explicit promotion preservation must be a boolean.');
  assert.equal(typeof activation, 'boolean');
  assert.equal(typeof emailFirst, 'boolean'); assert.ok(!(activation && emailFirst));
  assert.match(execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(), /^v22\./, 'Archive verification requires production Node22.');
  const destination = resolve(output), clientRoot = resolve(cliRoot);
  await mkdir(destination, { recursive: true });
  assert.equal((await readdir(destination)).length, 0, 'Never overwrite a retained release artifact.');
  const client = JSON.parse(await readFile(resolve(clientRoot, 'package.json'), 'utf8'));
  assert.equal(client.name, 'netlify-cli'); assert.equal(client.version, UPLOAD_CLIENT_VERSION);
  const clientRequire = createRequire(resolve(clientRoot, 'package.json'));
  const zipPackage = clientRequire.resolve('@netlify/zip-it-and-ship-it/package.json');
  assert.equal(JSON.parse(await readFile(zipPackage, 'utf8')).version, '14.5.4');
  const { zipFunctions } = await import(pathToFileURL(clientRequire.resolve('@netlify/zip-it-and-ship-it')).href);
  const { default: hashFns } = await import(pathToFileURL(resolve(clientRoot, 'dist/utils/deploy/hash-fns.js')).href);
  const { getFunctionsManifestPath } = await import(pathToFileURL(resolve(clientRoot, 'dist/utils/functions/functions.js')).href);
  const inputs = [...new Set([...PUBLIC_FILES, 'tools/m1-release-controls.mjs', 'tools/verify-m1-release-runtime.mjs', 'tools/m1-release-runtime-probe.mjs', 'package.json', 'package-lock.json', 'tools/build-m1-installation-profile.mjs',
    ...await filesAt(root, 'netlify/functions')])].sort();
  const sourceHashes = {};
  for (const path of inputs) sourceHashes[path] = sha256(await readFile(resolve(root, path)));
  const receipts = [];
  for (const gym of ['rev', 'richmond']) {
    // A separate lockfile install is essential: the packager must resolve from
    // this stage, rather than a checkout junction or an unrelated parent install.
    const stage = resolve(root, emailFirst ? '.m1-email-first-release-stage' : activation ? '.m1-activation-release-stage' : '.m1-disabled-release-stage', source, gym);
    await mkdir(stage, { recursive: true }); assert.equal((await readdir(stage)).length, 0, 'Retained stage exists.');
    for (const path of inputs) { await mkdir(dirname(resolve(stage, path)), { recursive: true }); await copyFile(resolve(root, path), resolve(stage, path)); }
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(GIB_|CONTEXT$|DEPLOY_PRIME_URL$|URL$|NODE_PATH$)/.test(name)) delete env[name];
    const settings = emailFirst ? emailFirstSettings(gym) : activation ? activationSettings(gym) : DISABLED_SETTINGS;
    Object.assign(env, settings, { CONTEXT: 'production', GIB_M1_INSTALLATION: gym, GIB_M1_ENVIRONMENT: 'production',
      GIB_RICHMOND_PRODUCTION_ACTIVATION: 'active', GIB_RICHMOND_PRODUCTION_WRITE_ENABLED: 'true',
      GIB_PROMOTIONS_TEST_ENABLED: 'false', GIB_PROMOTIONS_LIVE_ENABLED: gym === 'rev' && preserveRevolutionPromotions ? 'true' : 'false' });
    const npmCli = resolve(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
    execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, env, stdio: 'pipe', timeout: 180000 });
    assert.equal(sha256(await readFile(resolve(stage, 'package-lock.json'))), sourceHashes['package-lock.json'], 'Install must not change the reviewed lockfile.');
    execFileSync(process.execPath, ['tools/build-m1-installation-profile.mjs'], { cwd: stage, env, stdio: 'pipe', timeout: 20000 });
    await buildPublic({ root: stage });
    const globals = { document: { documentElement: { dataset: {} } } }; vm.createContext(globals);
    vm.runInContext(await readFile(resolve(stage, 'public/m1/installation-profile.generated.js'), 'utf8'), globals);
    vm.runInContext(await readFile(resolve(stage, 'public/m1/manager-review-config.generated.js'), 'utf8'), globals);
    vm.runInContext(await readFile(resolve(stage, 'public/m1/promotions-config.generated.js'), 'utf8'), globals);
    assert.equal(globals.M1_INSTALLATION_PROFILE.installationId, gym);
    assert.equal(globals.M1_INSTALLATION_PROFILE.featureFlags.staffClock, gym === 'rev');
    assert.equal(JSON.stringify(globals.M1_MANAGER_REVIEW_CONFIG), JSON.stringify({ enabled: activation, target: activation ? 'production' : 'disabled', staffRecovery: activation && gym === 'rev', richmondReviewer: activation && gym === 'richmond', reminders: activation || emailFirst }));
    assert.equal(globals.M1_PROMOTIONS_TEST_CONFIG.enabled, gym === 'rev' && preserveRevolutionPromotions);
    if (gym === 'rev' && preserveRevolutionPromotions) assert.equal(globals.M1_PROMOTIONS_TEST_CONFIG.target, 'live');
    const artifact = resolve(destination, gym); await mkdir(artifact); await mkdir(resolve(artifact, 'public'));
    for (const path of PUBLIC_FILES) { await mkdir(dirname(resolve(artifact, 'public', path)), { recursive: true }); await copyFile(resolve(stage, 'public', path), resolve(artifact, 'public', path)); }
    await zipFunctions(resolve(stage, 'netlify/functions'), resolve(artifact, 'functions'), {
      basePath: stage, config: { '*': { nodeBundler: 'esbuild', nodeVersion: '22.x', externalNodeModules: ['@netlify/blobs'] },
        'm1-schedule': { includedFiles: ['m1/shared-schedule.json', 'm1/richmond-schedule.json'] },
        'm1-manager-review': { includedFiles: ['m1/shared-schedule.json', 'm1/richmond-schedule.json'] } }, manifest: resolve(artifact, 'manifest.json')
    });
    const manifest = JSON.parse(await readFile(resolve(artifact, 'manifest.json'), 'utf8')), archiveHashes = {};
    for (const fn of manifest.functions) { archiveHashes[fn.name] = sha256(await readFile(fn.path)); fn.path = 'functions/' + fn.name + '.zip'; }
    assert.equal(manifest.functions.filter(fn => fn.schedule).length, 1, 'Only the pre-existing tablet-pairing cleanup schedule is permitted.');
    assert.equal(manifest.functions.find(fn => fn.schedule)?.name, 'm1-tablet-pairing-cleanup');
    await writeFile(resolve(artifact, 'manifest.json'), JSON.stringify(manifest));
    const receipt = { source, installation: gym, environment: 'production', newFeaturesDisabled: !activation && !emailFirst, emailFirst, realSendingDisabled: true, packager: '14.5.4',
      archiveHashes, manifestSha256: sha256(JSON.stringify(manifest)), sourceHashes, googleHashes: {}, publicHashes: {},
      ...(emailFirst ? { emailFirstSettings: settings } : activation ? { activationSettings: settings } : { offSettings: settings }),
      preservedFeatures: { promotionsLive: gym === 'rev' && preserveRevolutionPromotions } };
    for (const path of PUBLIC_FILES) receipt.publicHashes[path] = sha256(await readFile(resolve(artifact, 'public', path)));
    const google = resolve(artifact, 'google'); await mkdir(google);
    const wrapper = 'integrations/google-apps-script/' + (gym === 'rev' ? 'production' : 'richmond-production');
    for (const path of GOOGLE_FILES[gym]) {
      const input = ['Code.gs', 'appsscript.json', '.claspignore'].includes(path) ? wrapper + '/' + path : 'integrations/google-apps-script/' + path;
      const bytes = await readFile(resolve(root, input)); await writeFile(resolve(google, path), bytes); receipt.googleHashes[path] = sha256(bytes); receipt.sourceHashes[input] = sha256(bytes);
    }
    const scopedManifest = { ...manifest, timestamp: Date.now(), functions: manifest.functions.map(fn => ({ ...fn, path: resolve(artifact, fn.path) })) };
    const manifestPath = resolve(artifact, '.netlify/functions/manifest.json'); await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(scopedManifest));
    assert.equal(await getFunctionsManifestPath({ base: artifact }), manifestPath);
    const statuses = [], result = await hashFns({ getPathInProject: (...parts) => resolve(artifact, '.netlify', ...parts) }, [resolve(artifact, 'functions')], {
      concurrentHash: 4, functionsConfig: {}, manifestPath, rootDir: artifact, skipFunctionsCache: false,
      statusCb: status => statuses.push(status), tmpDir: resolve(artifact, '.netlify/upload-preflight')
    });
    assert.ok(statuses.some(status => status.msg?.startsWith('Deploying functions from cache')));
    assert.ok(!statuses.some(status => status.msg?.startsWith('Ignored invalid')));
    validateClientFunctions(result, scopedManifest, receipt);
    receipt.runtimeVerification = await verifyReleaseRuntime({ artifact, cliRoot: clientRoot, runtime, installation: gym, archiveHashes });
    receipt.uploadClient = client.version; receipt.functions = manifest.functions.map(fn => ({ name: fn.name, routes: fn.routes, runtime: fn.runtimeVersion, invocationMode: fn.invocationMode }));
    receipt.warning = 'Not deployed. Refresh the 120-second relocated client manifest at approved cutover; confirm live promotion flags still match preservedFeatures.';
    await writeFile(resolve(artifact, 'build.json'), JSON.stringify(receipt, null, 2));
    await writeFile(resolve(artifact, 'netlify.toml'), '[build]\npublish = "public"\nfunctions = "functions"\n');
    receipts.push(receipt);
  }
  await writeFile(resolve(destination, 'release.json'), JSON.stringify({ source, preparedAt: new Date().toISOString(), deployed: false,
    consentGranted: false, realEmailSent: false, timersInstalled: false, gyms: receipts }, null, 2));
  return receipts;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, output, cliRoot, ...flags] = process.argv.slice(2); assert.ok(source && output && cliRoot, 'Exact source, empty output and existing client required.');
  assert.ok(flags.every(flag => ['--preserve-revolution-promotions', '--activation', '--email-first'].includes(flag)), 'Unknown setting.');
  const result = await packageDisabledRelease({ source, output, cliRoot, preserveRevolutionPromotions: flags.includes('--preserve-revolution-promotions'), activation: flags.includes('--activation'), emailFirst: flags.includes('--email-first'), runtime: process.env.M1_ARCHIVE_NODE || process.execPath });
  console.log(JSON.stringify({ source, gyms: result.map(receipt => ({ installation: receipt.installation, functions: receipt.functions.length, disabled: receipt.newFeaturesDisabled, runtimeVerified: true })), deployed: false }));
}
