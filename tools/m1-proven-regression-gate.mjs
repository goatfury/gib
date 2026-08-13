#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVEN_TEST_COMMIT = 'a0273e4d154cc0289a0a3e10169135fca53b1b23';

// These pinned tests assert contracts that the August rollout intentionally
// supersedes. Keep the names exact: a rename, disappearance, or unexpected pass
// must fail this gate and receive an explicit review.
export const SUPERSEDED_TEST_NAMES = Object.freeze([
  'production Admin configuration fails closed without every private value',
  'production preserves a short non-empty legacy webhook credential',
  'Admin passphrase policy and production login are enforced',
  'TEST login shortcut is limited to the exact Deploy Preview host pattern',
  'valid session can review, search, add, and logout with no-store responses',
  'rapid Admin retry creates one payroll event and readable results',
  'rapid double-click reaches one added result and one duplicate-safe result',
  'Daily Review workflow is yesterday-first, date-selectable, complete, and explicit about limits',
  'Admin addition UX has fixed fields, reason, confirmation, refresh, and Admin label',
  'server rejects the removed install action without creating a capability',
  'issue requires same-origin Admin authentication and returns only a short capability grant',
  'valid diagnostic proofs confirm fixed nonsecret same-origin invariants',
  'verification is run-bound, session-bound, expiring, and rejects the general Admin header',
  'invalid host, origin, path, and extra issue fields fail closed',
  'production and Deploy Preview diagnostics never return server transport values'
]);

export const SUPERSEDED_TEST_FILES = Object.freeze(Object.fromEntries(
  SUPERSEDED_TEST_NAMES.map((name, index) => [
    name,
    index < 9
      ? 'm1-admin-only.test.mjs'
      : 'm1-tablet-diagnostic-secret-safe.test.mjs'
  ])
));

export const EXPECTED_COUNTS = Object.freeze({
  tests: 101,
  currentPasses: 86,
  supersededFailures: SUPERSEDED_TEST_NAMES.length
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function exactPattern(names) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new TypeError('At least one test name is required.');
  }
  return `^(?:${names.map(escapeRegExp).join('|')})$`;
}

export function tapSummary(output) {
  const summary = {};
  for (const match of output.matchAll(/^# (tests|pass|fail|skipped)\s+(\d+)\s*$/gmu)) {
    summary[match[1]] = Number(match[2]);
  }
  return summary;
}

function runTests(files, option, pattern) {
  const args = ['--test', '--test-reporter=tap', `${option}=${pattern}`, ...files];
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
}

function renderFailure(message, result) {
  process.stderr.write(`\nIMMUTABLE REGRESSION GATE FAILED: ${message}\n`);
  if (result?.error) process.stderr.write(`${result.error.stack || result.error}\n`);
  if (result?.stdout) process.stderr.write(`\n--- child stdout ---\n${result.stdout}`);
  if (result?.stderr) process.stderr.write(`\n--- child stderr ---\n${result.stderr}`);
  process.exitCode = 1;
}

function hasExactTapFailure(output, name) {
  const pattern = new RegExp(`^not ok \\d+ - ${escapeRegExp(name)}\\s*$`, 'mu');
  return pattern.test(output);
}

export function main(argv = process.argv.slice(2)) {
  const suiteDirectory = argv[0] ? path.resolve(argv[0]) : '';
  if (!suiteDirectory || !statSafe(suiteDirectory)?.isDirectory()) {
    renderFailure('Pass the extracted immutable tests directory as the only argument.');
    return;
  }

  const files = readdirSync(suiteDirectory)
    .filter(name => /^m1-.*\.test\.mjs$/u.test(name))
    .sort()
    .map(name => path.join(suiteDirectory, name));
  if (files.length === 0) {
    renderFailure(`No immutable m1-*.test.mjs files found in ${suiteDirectory}.`);
    return;
  }

  const current = runTests(
    files,
    '--test-skip-pattern',
    exactPattern(SUPERSEDED_TEST_NAMES)
  );
  const currentOutput = `${current.stdout || ''}${current.stderr || ''}`;
  const currentSummary = tapSummary(currentOutput);
  const currentIsExact = current.status === 0
    && currentSummary.tests === EXPECTED_COUNTS.currentPasses
    && currentSummary.pass === EXPECTED_COUNTS.currentPasses
    && currentSummary.fail === 0
    && currentSummary.skipped === 0;
  if (!currentIsExact) {
    renderFailure(
      `Non-superseded baseline changed; expected exactly ${EXPECTED_COUNTS.currentPasses} pass and 0 fail.`,
      current
    );
    return;
  }
  process.stdout.write(
    `Immutable non-superseded tests: ${currentSummary.pass} passed; ${EXPECTED_COUNTS.supersededFailures} exact superseded names deferred for inverted checks.\n`
  );

  for (const name of SUPERSEDED_TEST_NAMES) {
    const expectedFile = path.join(suiteDirectory, SUPERSEDED_TEST_FILES[name]);
    if (!files.includes(expectedFile)) {
      renderFailure(`Pinned test file is missing for superseded test: ${SUPERSEDED_TEST_FILES[name]}`);
      return;
    }
    const result = runTests([expectedFile], '--test-name-pattern', exactPattern([name]));
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const summary = tapSummary(output);
    const remainsExactFailure = result.status === 1
      && summary.tests === 1
      && summary.pass === 0
      && summary.fail === 1
      && summary.skipped === 0
      && hasExactTapFailure(output, name);
    if (!remainsExactFailure) {
      renderFailure(
        `Superseded test is missing, unexpectedly passed, or no longer the sole failure: ${name}`,
        result
      );
      return;
    }
    process.stdout.write(`Confirmed exact superseded failure: ${name}\n`);
  }

  process.stdout.write(
    `Immutable suite accounted for: ${EXPECTED_COUNTS.currentPasses} current passes + ${EXPECTED_COUNTS.supersededFailures} exact expected failures = ${EXPECTED_COUNTS.tests} tests.\n`
  );
}

function statSafe(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
