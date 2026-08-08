import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROVISION_TOOL = path.join(ROOT, 'tools', 'm1-production-provision.mjs');
const PRODUCTION_MANIFEST = path.join(
  ROOT,
  'integrations',
  'google-apps-script',
  'production',
  'appsscript.json'
);
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'm1-admin-only-required.yml');

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}

function slash(value) {
  return value.replaceAll('\\', '/');
}

function candidateFiles() {
  const tracked = git(['ls-files', '--cached', '-z'])
    .split('\0')
    .filter(Boolean)
    .map(slash);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .map(slash)
    .filter(relativePath => !/^\.m1-(?:baseline|proven-tests)(?:[-./]|$)/u.test(relativePath));
  return [...new Set([...tracked, ...untracked])].sort();
}

function textEntries() {
  const entries = [];
  for (const relativePath of candidateFiles()) {
    const absolutePath = path.join(ROOT, ...relativePath.split('/'));
    if (!existsSync(absolutePath)) continue;
    const value = readFileSync(absolutePath);
    if (value.includes(0)) continue;
    entries.push({ path: relativePath, text: value.toString('utf8') });
  }
  return entries;
}

function placeholder(value, relativePath = '') {
  if (/^\s*\$\{[A-Z0-9_]+\}\s*$/u.test(value)) return true;
  if (/(?:synthetic|placeholder|example|fake|canary|redacted|not-a-real|replace-me)/iu.test(value)) {
    return true;
  }
  return relativePath.startsWith('tests/')
    && (
      /(?:test|unit|private.*production|production.*private)/iu.test(value)
      || /^[a-z][a-z0-9]*(?:[ -][a-z0-9]+){2,}$/u.test(value)
    );
}

function patternViolations(entries, patterns) {
  const violations = [];
  for (const entry of entries) {
    for (const { label, pattern } of patterns) {
      if (pattern.test(entry.text)) violations.push(`${entry.path}: ${label}`);
    }
  }
  return violations;
}

test('candidate text contains no private Google identifier, endpoint, or literal production secret', () => {
  const entries = textEntries();
  assert.ok(entries.length > 20, 'Expected to scan the complete repository candidate.');

  const identifierViolations = [];

  const deploymentIdentifier = /\b(AKfy[A-Za-z0-9_-]{16,})\b/gu;
  for (const entry of entries) {
    for (const match of entry.text.matchAll(deploymentIdentifier)) {
      if (!placeholder(match[1], entry.path)) {
        identifierViolations.push(`${entry.path}: Apps Script deployment identifier`);
      }
    }
  }

  const resourceUrls = [
    {
      label: 'Apps Script web-app URL',
      pattern: /https:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]{20,})\/(?:exec|dev)\b/gu
    },
    {
      label: 'Google Sheet URL',
      pattern: /https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})\b/gu
    },
    {
      label: 'Apps Script project URL',
      pattern: /https:\/\/script\.google\.com\/(?:d|home\/projects)\/([A-Za-z0-9_-]{20,})\b/gu
    }
  ];
  for (const entry of entries) {
    for (const resource of resourceUrls) {
      for (const match of entry.text.matchAll(resource.pattern)) {
        if (!placeholder(match[1], entry.path)) {
          identifierViolations.push(`${entry.path}: ${resource.label}`);
        }
      }
    }
  }

  const assignedIdentifier = /\b(?:sheet|spreadsheet|script|deployment)[_-]?(?:id|identifier)\b\s*[:=]\s*['"`]([A-Za-z0-9_-]{25,})['"`]/giu;
  for (const entry of entries) {
    for (const match of entry.text.matchAll(assignedIdentifier)) {
      if (!placeholder(match[1], entry.path)) {
        identifierViolations.push(`${entry.path}: assigned Google resource identifier`);
      }
    }
  }

  const opaqueLiteral = /['"`]([A-Za-z0-9_-]{36,80})['"`]/gu;
  for (const entry of entries) {
    for (const match of entry.text.matchAll(opaqueLiteral)) {
      const value = match[1];
      const knownHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
      const looksOpaque = /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /\d/u.test(value);
      if (looksOpaque && !knownHash && !uuid && !placeholder(value, entry.path)) {
        identifierViolations.push(`${entry.path}: unexplained opaque identifier`);
      }
    }
  }

  const literalSecret = /\b(?:GIB_[A-Z0-9_]*(?:TOKEN|SECRET|PASSPHRASE|PASSWORD|CREDENTIAL)|(?:PRODUCTION|PROD)_[A-Z0-9_]*(?:TOKEN|SECRET|PASSPHRASE|PASSWORD|CREDENTIAL))\b\s*[:=]\s*['"`]([^'"`\r\n]{12,})['"`]/giu;
  const secretViolations = [];
  for (const entry of entries) {
    for (const match of entry.text.matchAll(literalSecret)) {
      if (!placeholder(match[1], entry.path)) {
        secretViolations.push(`${entry.path}: literal production secret`);
      }
    }
  }

  assert.deepEqual([...identifierViolations, ...secretViolations], []);
});

test('browser-facing sources contain no server transport name or permanent credential material', () => {
  const browserEntries = textEntries().filter(entry => {
    return /^(?:index\.html|guests\/|m1\/)/u.test(entry.path)
      && /\.(?:css|html|js|json|mjs)$/u.test(entry.path);
  });
  assert.ok(browserEntries.length >= 5, 'Expected kiosk, installer, diagnostic, and Admin browser sources.');

  const violations = patternViolations(browserEntries, [
    {
      label: 'server environment name',
      pattern: /\bGIB_(?:M1|TEST|PRODUCTION)_[A-Z0-9_]+\b/u
    },
    {
      label: 'Google receiver URL or identifier',
      pattern: /(?:script\.google\.com\/macros|\bAKfy[A-Za-z0-9_-]{16,}\b)/u
    },
    {
      label: 'permanent server credential field',
      pattern: /\b(?:webhookUrl|webhookToken|receiverToken|receiverCredential|deviceCredential|deviceAuthSecret|spreadsheetId|sheetId|scriptId|deploymentId|netlifySecret)\b\s*[:=]/iu
    },
    {
      label: 'literal bearer credential',
      pattern: /\bAuthorization\b\s*[:=]\s*['"`]Bearer\s+[A-Za-z0-9_-]{12,}/iu
    }
  ]);
  assert.deepEqual(violations, []);
});

test('all exact private production material paths are ignored and untracked', () => {
  const privatePaths = [
    '.clasp.json',
    '.clasprc.json',
    '.env',
    '.env.production',
    'client_secret-production.json',
    'credentials.json',
    'private/m1-production.json',
    'private/oauth-material.json',
    'private/google-sheet-id.txt',
    'private/google-script-id.txt',
    'private/google-deployment-id.txt',
    'private/google-webhook-url.txt',
    'private/device-credentials.json',
    'integrations/google-apps-script/.clasp.json',
    'integrations/google-apps-script/.clasprc.json',
    'integrations/google-apps-script/.env.production',
    'integrations/google-apps-script/client_secret-production.json',
    'integrations/google-apps-script/credentials.json',
    'integrations/google-apps-script/production/.clasp.json',
    'integrations/google-apps-script/production/.clasprc.json'
  ];
  const tracked = new Set(
    git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean).map(slash)
  );
  const ignored = new Set(
    git(['check-ignore', '--no-index', '--stdin', '-z'], {
      input: `${privatePaths.join('\0')}\0`
    }).split('\0').filter(Boolean).map(slash)
  );

  for (const privatePath of privatePaths) {
    assert.equal(tracked.has(privatePath), false, `${privatePath} must not be tracked.`);
    assert.equal(ignored.has(privatePath), true, `${privatePath} must be covered by an ignore rule.`);
  }
});

test('production provisioning uses the default Apps Script Cloud project and no execution API path', () => {
  const provisionSource = readFileSync(PROVISION_TOOL, 'utf8');
  const manifestSource = readFileSync(PRODUCTION_MANIFEST, 'utf8');
  const manifest = JSON.parse(manifestSource);
  assert.deepEqual(manifest.webapp, {
    access: 'ANYONE_ANONYMOUS',
    executeAs: 'USER_DEPLOYING'
  });
  assert.equal(manifest.executionApi, undefined);
  assert.doesNotMatch(provisionSource, /\brun-function\b|\bscripts\.run\b|\bapiExecutable\b/iu);
  assert.doesNotMatch(manifestSource, /"executionApi"|"apiExecutable"/u);
  assert.doesNotMatch(provisionSource, /\bprojectId\b|standard Cloud project/iu);
});

test('every production mutation action is protected by execute and exact confirmation gates', async () => {
  assert.equal(existsSync(PROVISION_TOOL), true, 'The repository-driven production provisioning tool is required.');
  const provision = await import(`${pathToFileURL(PROVISION_TOOL).href}?security-test=${Date.now()}`);
  const expectedActions = [
    'create',
    'deploy',
    'install-link',
    'provision',
    'push',
    'restore',
    'rollback',
    'update',
    'version'
  ];
  const actualActions = [...(provision.MUTATING_ACTIONS || [])].sort();
  assert.deepEqual(actualActions, expectedActions);
  assert.equal(typeof provision.confirmationForAction, 'function');
  assert.equal(typeof provision.authorizeMutation, 'function');

  function authorized(input) {
    try {
      const value = provision.authorizeMutation(input);
      return value === true || (
        value?.authorized === true
        && value.action === input.action
      );
    } catch {
      return false;
    }
  }

  for (const action of expectedActions) {
    const confirmation = `M1-PRODUCTION-${action.toUpperCase()}`;
    assert.equal(provision.confirmationForAction(action), confirmation);
    assert.equal(authorized({
      action,
      execute: false,
      confirm: confirmation,
      confirmation
    }), false);
    assert.equal(authorized({ action, execute: true, confirm: '', confirmation: '' }), false);
    assert.equal(authorized({
      action,
      execute: true,
      confirm: `${confirmation}-WRONG`,
      confirmation: `${confirmation}-WRONG`
    }), false);
    assert.equal(authorized({
      action,
      execute: true,
      confirm: confirmation,
      confirmation
    }), true);
  }
  assert.equal(authorized({
    action: 'unknown',
    execute: true,
    confirm: 'M1-PRODUCTION-UNKNOWN',
    confirmation: 'M1-PRODUCTION-UNKNOWN'
  }), false);

  const source = readFileSync(PROVISION_TOOL, 'utf8');
  assert.match(source, /item\.startsWith\(['"]--['"]\)/u);
  assert.match(source, /booleanFlags\s*=\s*new Set\(\[['"]execute['"]/u);
  assert.match(source, /(?:confirm|confirmation):\s*args\.confirm/u);
  assert.ok(
    (source.match(/authorizeMutation\s*\(/gu) || []).length >= 2,
    'The CLI dispatcher must invoke the centralized mutation gate.'
  );
});

test('obsolete review artifacts are absent from every repository text file', () => {
  const obsoleteNumber = [4, 4].join('');
  const obsoletePr = new RegExp(`(?:\\bPR\\s*#?|#)${obsoleteNumber}\\b`, 'iu');
  const obsoletePull = new RegExp(`(?:pull|pulls)/${obsoleteNumber}\\b`, 'iu');
  const obsoletePreview = new RegExp(
    `${['deploy', 'preview', obsoleteNumber].join('-')}--`,
    'iu'
  );
  const violations = patternViolations(textEntries(), [
    { label: 'obsolete pull request', pattern: obsoletePr },
    { label: 'obsolete pull URL', pattern: obsoletePull },
    { label: 'obsolete Deploy Preview', pattern: obsoletePreview }
  ]);
  assert.deepEqual(violations, []);
});

test('required CI checks the immutable TEST source and both regression suites', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.dependencies?.['@netlify/blobs'], '10.7.12');
  assert.equal(packageLock.packages?.['']?.dependencies?.['@netlify/blobs'], '10.7.12');
  assert.match(workflow, /- agent\/m1-revbjjops-test-path/u);
  assert.match(workflow, /a0273e4d154cc0289a0a3e10169135fca53b1b23/u);
  assert.match(workflow, /git archive "\$PROVEN_TEST_COMMIT" tests/u);
  assert.match(workflow, /npm ci[\s\S]*node --test "\$baseline_suite"\/m1-\*\.test\.mjs[\s\S]*node --test tests\/m1-\*\.test\.mjs/u);
  assert.doesNotMatch(workflow, /git merge-base --is-ancestor "\$proven_test_commit" HEAD/u);
  assert.doesNotMatch(workflow, /unexpected non-Admin files changed/iu);
  assert.doesNotMatch(workflow, /git rev-parse "HEAD:m1\//u);
});
