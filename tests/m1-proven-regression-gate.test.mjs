import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EXPECTED_COUNTS,
  PROVEN_TEST_COMMIT,
  SUPERSEDED_TEST_FILES,
  SUPERSEDED_TEST_NAMES,
  exactPattern,
  tapSummary
} from '../tools/m1-proven-regression-gate.mjs';

const ROOT = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, ROOT), 'utf8');

const EXACT_SUPERSEDED_NAMES = [
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
];

test('immutable regression gate pins the suite and exact superseded expectations', () => {
  const workflow = read('.github/workflows/m1-admin-only-required.yml');
  const runner = read('tools/m1-proven-regression-gate.mjs');

  assert.equal(PROVEN_TEST_COMMIT, 'a0273e4d154cc0289a0a3e10169135fca53b1b23');
  assert.deepEqual(SUPERSEDED_TEST_NAMES, EXACT_SUPERSEDED_NAMES);
  assert.deepEqual(EXPECTED_COUNTS, {
    tests: 101,
    currentPasses: 86,
    supersededFailures: 15
  });
  assert.equal(new Set(SUPERSEDED_TEST_NAMES).size, SUPERSEDED_TEST_NAMES.length);
  assert.deepEqual(
    new Set(Object.values(SUPERSEDED_TEST_FILES)),
    new Set(['m1-admin-only.test.mjs', 'm1-tablet-diagnostic-secret-safe.test.mjs'])
  );

  assert.match(workflow, /PROVEN_TEST_COMMIT: a0273e4d154cc0289a0a3e10169135fca53b1b23/u);
  assert.match(workflow, /git archive "\$PROVEN_TEST_COMMIT" tests/u);
  assert.match(workflow, /node tools\/m1-proven-regression-gate\.mjs "\$baseline_suite"/u);
  assert.match(runner, /--test-skip-pattern/u);
  assert.match(runner, /--test-name-pattern/u);
});

test('immutable regression patterns are exact and TAP totals are read fail-closed', () => {
  const pattern = new RegExp(exactPattern(SUPERSEDED_TEST_NAMES), 'u');
  for (const name of SUPERSEDED_TEST_NAMES) assert.match(name, pattern);
  assert.doesNotMatch(`prefix ${SUPERSEDED_TEST_NAMES[0]}`, pattern);
  assert.doesNotMatch(`${SUPERSEDED_TEST_NAMES[0]} suffix`, pattern);

  assert.deepEqual(
    tapSummary('# tests 86\n# pass 86\n# fail 0\n# skipped 0\n'),
    { tests: 86, pass: 86, fail: 0, skipped: 0 }
  );
  assert.deepEqual(tapSummary('not TAP output'), {});
});
