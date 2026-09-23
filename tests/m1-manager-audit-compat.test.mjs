import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { sanitizeDailyReviewPayload } from '../netlify/functions/_lib/m1-admin-contracts.mjs';

// The hosted pilot's retained VOID audit exposed this integration regression:
// the receiver returns the audit, but the older server and UI rejected its ID.
const audit = {
  auditId: 'audit-row-25', actionNumber: 24, adminName: 'Andrew Smith',
  actionTime: '2026-09-22 18:30:00', instructor: 'QA TEST Pilot Late Wrong 0922',
  classDate: '2026-09-21', classLabel: '9:00 AM QA TEST Manager Pilot 0922',
  site: 'Rev', duration: 0.75, reason: 'TEST fixture correction; preserve this record and audit',
  result: 'voided', linkedRecordId: 'gib-admin-manager-add-42d359a7-550f-46e8-b4d1-5f925e60ff38'
};
const payload = item => ({ ok: true, date: item.classDate, records: [], warnings: [], auditHistory: [item] });
const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function validAuditRecord('), html.indexOf('function validDailyReviewResponse('));
function client(item, { enabled = true, testMode = true, richmond = false } = {}) {
  const context = vm.createContext({
    testMode, IS_RICHMOND: richmond, M1_MANAGER_REVIEW_CONFIG: { enabled },
    REV_REMOVAL_ENABLED: false, IS_RICHMOND_PRODUCTION: false,
    RICHMOND_PRODUCTION_ROW_ID_PATTERN: /^gib-m1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    exactObjectKeys: (v, keys) => v && Object.keys(v).sort().join('|') === [...keys].sort().join('|'),
    validReviewTimestamp: v => /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v)
  });
  vm.runInContext(source, context);
  return context.validAuditRecord(item, item.classDate);
}

test('retained manager VOID audit is readable in both TEST gyms without relaxing other audit fields', () => {
  for (const site of ['Rev', 'Richmond']) {
    const item = { ...audit, site };
    assert.ok(sanitizeDailyReviewPayload(payload(item), item.classDate, { managerReviewTestSite: site }));
    assert.equal(client(item, { richmond: site === 'Richmond' }), true);
    for (const change of [
      { linkedRecordId: 'unrecognized-id' }, { instructor: 'Real Instructor' },
      { actionNumber: 1.5 }, { actionTime: 'not-a-time' }, { duration: 0 },
      { adminName: 'Unauthorized Reviewer' }, { extra: true }
    ]) {
      const bad = { ...item, ...change };
      assert.equal(sanitizeDailyReviewPayload(payload(bad), item.classDate, { managerReviewTestSite: site }), null);
      assert.equal(client(bad, { richmond: site === 'Richmond' }), false);
    }
  }
});

test('pilot audit compatibility stays disabled outside its TEST gym and feature gate', () => {
  for (const options of [{}, { allowRevolutionRemoval: true }, { allowInstructorSigninVoid: true }, { managerReviewTestSite: 'Richmond' }]) {
    assert.equal(sanitizeDailyReviewPayload(payload(audit), audit.classDate, options), null);
  }
  for (const options of [{ enabled: false }, { testMode: false }, { richmond: true }]) {
    assert.equal(client(audit, options), false);
  }
  const server = readFileSync(new URL('../netlify/functions/m1-admin-review.mjs', import.meta.url), 'utf8');
  assert.match(server, /managerReviewTestSite: MANAGER_REVIEW_ENABLED && config.target === 'test'/);
});
