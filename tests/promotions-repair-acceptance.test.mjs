import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createLegacyBinding, mapLegacyBook } from '../tools/promotions-legacy-map.mjs';

// Public synthetic source rows shared with the hosted repair acceptance check.
// Expected names, ranks, dates, and IDs below are literal independent answers.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/promotions-repair-acceptance.json', import.meta.url), 'utf8'));
const sheets = () => [{
  name: fixture.sheetName,
  rows: [structuredClone(fixture.header), ...fixture.records.map(record => structuredClone(record.sourceValues))],
}];
const mapped = () => mapLegacyBook({ sheets: sheets(), asOfDateNY: '2026-09-14' });

test('public repair fixture preserves the 13-column Black Belt source layout', () => {
  assert.equal(fixture.marker, 'SYNTHETIC REPAIR FIXTURE 20260914');
  assert.equal(fixture.sheetName, 'Black Belt');
  assert.deepEqual(fixture.header, ['Name', '', 'Date', 'Rank awarded', '4 stripes', '3 stripes', '2 stripes', '1 stripe', 'Black Belt', '4 stripes', '3 stripes', '2 stripes', '1 stripe']);
  assert.equal(fixture.records.length, 2);
  assert.ok(fixture.records.every(record => record.sourceValues.length === 13));
  assert.deepEqual(fixture.records.map(record => record.key), ['dated-split', 'unknown-split']);
  assert.deepEqual(fixture.records[0].sourceValues[4], {
    userEnteredValue: { numberValue: 44982 },
    effectiveValue: { numberValue: 44982 },
    formattedValue: '2/25/2023',
    effectiveFormat: { numberFormat: { type: 'DATE', pattern: 'm/d/yyyy' } },
  });
  assert.deepEqual(fixture.records[0].sourceValues.slice(2, 4), ['', '']);
  assert.ok(fixture.records[0].sourceValues.slice(5).every(value => value === ''));
  assert.ok(fixture.records[1].sourceValues.slice(2).every(value => value === ''));
});

test('dated split-name source recovers the full name and four Black Belt degrees', () => {
  const candidate = mapped().candidates.find(item => item.sourceRow === 2);
  assert.equal(candidate.displayName, "TEST Avery Juniper-O'Neill");
  assert.equal(candidate.sourceRef, "'Black Belt'!A2:M2");
  assert.equal(candidate.items.length, 13);
  assert.deepEqual({
    known: candidate.currentRank.known,
    belt: candidate.currentRank.belt,
    marks: candidate.currentRank.marks,
    markType: candidate.currentRank.markType,
    dateKnown: candidate.currentRank.date.known,
    date: candidate.currentRank.date.value,
  }, {
    known: true,
    belt: 'Black Belt',
    marks: 4,
    markType: 'degrees',
    dateKnown: true,
    date: '2023-02-25',
  });
  assert.equal(candidate.currentRank.evidenceRef, "'Black Belt'!E2");
  assert.equal(candidate.items[4].type, 'date_serial');
  assert.equal(candidate.items[4].value, 44982);
  assert.equal(candidate.items[4].display, '2/25/2023');
});

test('split-name source without award evidence keeps both rank and date unknown', () => {
  const candidate = mapped().candidates.find(item => item.sourceRow === 3);
  assert.equal(candidate.displayName, 'TEST Avery Fern');
  assert.equal(candidate.sourceRef, "'Black Belt'!A3:M3");
  assert.deepEqual({
    known: candidate.currentRank.known,
    belt: candidate.currentRank.belt,
    marks: candidate.currentRank.marks,
    markType: candidate.currentRank.markType,
    dateKnown: candidate.currentRank.date.known,
    date: candidate.currentRank.date.value,
    requiresAuditedResolution: candidate.currentRank.requiresAuditedResolution,
  }, {
    known: false,
    belt: '',
    marks: null,
    markType: '',
    dateKnown: false,
    date: '',
    requiresAuditedResolution: true,
  });
});

test('explicit bindings preserve distinct identities for the same first name', () => {
  const source = sheets();
  const unbound = mapLegacyBook({ sheets: source, asOfDateNY: '2026-09-14' });
  assert.ok(unbound.candidates.every(candidate => candidate.identity.studentId === null));
  assert.notEqual(unbound.candidates[0].sourceFingerprint, unbound.candidates[1].sourceFingerprint);
  const registry = unbound.candidates.map(candidate => {
    const record = fixture.records[candidate.sourceRow - 2];
    return createLegacyBinding(candidate, { studentId: record.studentId, distinguishingLabel: record.key });
  });
  const assigned = mapLegacyBook({ sheets: source, registry, asOfDateNY: '2026-09-14' });
  assert.deepEqual(assigned.candidates.map(candidate => ({
    displayName: candidate.displayName,
    studentId: candidate.identity.studentId,
    status: candidate.identity.status,
  })), [
    { displayName: "TEST Avery Juniper-O'Neill", studentId: 'fixture-repair-20260914-avery-juniper', status: 'assigned' },
    { displayName: 'TEST Avery Fern', studentId: 'fixture-repair-20260914-avery-fern', status: 'assigned' },
  ]);
  assert.equal(assigned.unmatchedBindings.length, 0);
});

test('a complete public control name in A never appends the Belt marker from B', () => {
  const source = sheets();
  source[0].rows.push(['TEST Morgan Complete', 'Belt', '', '', '', '', '', '', '', '', '', '', '']);
  const candidate = mapLegacyBook({ sheets: source, asOfDateNY: '2026-09-14' }).candidates.find(item => item.sourceRow === 4);
  assert.equal(candidate.displayName, 'TEST Morgan Complete');
  assert.equal(candidate.items[1].value, 'Belt');
  assert.equal(candidate.items.length, 13);
  assert.equal(candidate.currentRank.known, false);
  assert.equal(candidate.currentRank.date.known, false);
});
