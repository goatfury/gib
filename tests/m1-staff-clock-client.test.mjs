import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const kioskHtml = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../m1/staff-clock-client.mjs', import.meta.url), 'utf8');
const serviceWorkerSource = readFileSync(new URL('../m1/service-worker.js', import.meta.url), 'utf8');

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

const fullRecord = Object.freeze({
  punchId: 'gib-m1-staff-123e4567-e89b-42d3-a456-426614174000',
  timestamp: '2026-08-18T09:30:00-04:00',
  date: '2026-08-18',
  staffId: 'front-desk-test-two',
  staffName: 'Front Desk Test Two',
  punchAction: 'clockIn',
  site: 'Rev TEST',
  device: 'Staff Clock tablet',
  build: '2026-08-18 M1B TEST staff-clock-operational-candidate',
  note: '',
  status: 'ACTIVE',
  source: 'Tablet',
  adminName: '',
  linkedPunchId: ''
});

test('Staff Clock is isolated from the inherited inline kiosk client', () => {
  const inlineModule = kioskHtml.match(/<script type="module">([\s\S]*?)<\/script>/u)?.[1] || '';
  assert.match(
    kioskHtml,
    /<script type="module" src="\.\/staff-clock-client\.mjs\?v=2026-08-18-m1b-staff-clock-operational-r4"><\/script>/u
  );
  assert.doesNotMatch(inlineModule, /staff-clock-core|staffClockSyncPunch|syncStaffClockQueue|renderStaffTimeAdmin/u);
});

test('Staff Clock sync projects durable records to the exact ten-key wire shape', () => {
  const project = Function(`return (${namedFunctionSource(clientSource, 'staffClockSyncPunch')});`)();
  const wirePunch = project(fullRecord);
  assert.deepEqual(Object.keys(wirePunch), [
    'punchId',
    'timestamp',
    'date',
    'staffId',
    'staffName',
    'punchAction',
    'site',
    'device',
    'build',
    'note'
  ]);
  assert.deepEqual(wirePunch, {
    punchId: fullRecord.punchId,
    timestamp: fullRecord.timestamp,
    date: fullRecord.date,
    staffId: fullRecord.staffId,
    staffName: fullRecord.staffName,
    punchAction: fullRecord.punchAction,
    site: fullRecord.site,
    device: fullRecord.device,
    build: fullRecord.build,
    note: fullRecord.note
  });
  assert.match(clientSource, /punches: batch\.map\(staffClockSyncPunch\)/u);
});

test('needs attention is a valid non-acceptance and leaves the punch queued', () => {
  const evaluate = Function(`
    const IS_PRODUCTION_ORIGIN = false;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'acceptedStaffClockSyncIds')});
  `)();
  const accepted = evaluate({
    ok: true,
    target: 'test',
    results: [{
      punchId: fullRecord.punchId,
      result: 'needs attention',
      linkedPunchId: ''
    }]
  }, [fullRecord]);
  assert.equal(accepted.size, 0);

  for (const ambiguousResult of [
    {
      punchId: fullRecord.punchId,
      result: 'needs attention',
      linkedPunchId: fullRecord.punchId
    },
    {
      punchId: fullRecord.punchId,
      result: 'needs attention',
      linkedPunchId: '',
      extra: true
    }
  ]) {
    assert.throws(() => evaluate({
      ok: true,
      target: 'test',
      results: [ambiguousResult]
    }, [fullRecord]));
  }
});

test('snapshot and sync confirmations reject added envelope fields', () => {
  const validateSnapshot = Function(`
    const IS_PRODUCTION_ORIGIN = false;
    const normalizeStaffClockPerson = value => value;
    const normalizeStaffClockRecord = value => value;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'validatedStaffClockSnapshot')});
  `)();
  const snapshot = {
    ok: true,
    target: 'test',
    staff: [{ staffId: fullRecord.staffId, staffName: fullRecord.staffName }],
    records: [fullRecord]
  };
  assert.deepEqual(validateSnapshot(snapshot), {
    staff: snapshot.staff,
    records: snapshot.records
  });
  assert.equal(validateSnapshot({ ...snapshot, extra: true }), null);

  const evaluate = Function(`
    const IS_PRODUCTION_ORIGIN = false;
    ${namedFunctionSource(clientSource, 'exactStaffClockKeys')}
    return (${namedFunctionSource(clientSource, 'acceptedStaffClockSyncIds')});
  `)();
  assert.throws(() => evaluate({
    ok: true,
    target: 'test',
    results: [{
      punchId: fullRecord.punchId,
      result: 'added',
      linkedPunchId: fullRecord.punchId
    }],
    extra: true
  }, [fullRecord]));
});

test('the offline shell precaches and serves both Staff Clock modules', () => {
  assert.match(serviceWorkerSource, /staff-clock-core\.mjs\?v=/u);
  assert.match(serviceWorkerSource, /staff-clock-client\.mjs\?v=/u);
  assert.match(serviceWorkerSource, /STAFF_CLOCK_CLIENT_URL/u);
});

test('a punch queued during startup sync triggers an immediate coalesced second pass', () => {
  const syncSource = namedFunctionSource(clientSource, 'syncStaffClockQueue');
  assert.match(clientSource, /let staffClockSyncRequested = false;/u);
  assert.match(syncSource, /if \(staffClockSyncPromise\) \{\s*staffClockSyncRequested = true;\s*return staffClockSyncPromise;/u);
  assert.match(syncSource, /staffClockSyncPromise = \(async \(\) => \{\s*\/\/[^\n]+\n\s*\/\/[^\n]+\n\s*await Promise\.resolve\(\);/u);
  assert.match(syncSource, /staffClockSyncPromise = null;\s*if \(staffClockSyncRequested\) \{\s*staffClockSyncRequested = false;\s*void syncStaffClockQueue\(\);/u);
});
