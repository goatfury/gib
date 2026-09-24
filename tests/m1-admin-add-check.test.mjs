import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { handleAdminAddCheck, config } from '../netlify/functions/m1-admin-add-check.mjs';
import { additionReceiptFromDailyReview } from '../netlify/functions/_lib/m1-admin-add-check.mjs';
import { sanitizeAdminAdditionPayload } from '../netlify/functions/_lib/m1-admin-contracts.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { REMOVAL_VERSION } from '../netlify/functions/_lib/m1-revolution-removal.mjs';

const origin = 'https://deploy-preview-89--gib-live.netlify.app';
const productionOrigin = 'https://gib-live.netlify.app';
const now = Date.parse('2026-09-24T19:00:00Z');
const env = { GIB_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_TEST_RECEIVER/exec',
  GIB_TEST_WEBHOOK_TOKEN: 'synthetic-test-transport-1234567890', GIB_TEST_ADMIN_ACTION_TOKEN: 'synthetic-test-admin-1234567890abcdef' };
const dependencies = { enabled: true, target: 'test', env, now, dateNow: new Date(now),
  context: { site: { id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff', name: 'gib-live' }, deploy: { context: 'deploy-preview', published: false } } };
const productionEnv = { GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_PRODUCTION_CONTRACT_RECEIVER/exec',
  GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'synthetic-production-transport-1234567890', GIB_M1_ADMIN_ACTION_TOKEN: 'synthetic-production-admin-1234567890abcdef',
  GIB_M1_ADMIN_PASSPHRASE: 'isolated fictional local contract words' };
const productionDependencies = { ...dependencies, target: 'production', env: productionEnv,
  context: { ...dependencies.context, deploy: { context: 'production', published: true } } };
const adminName = 'Stuart Turner';
const original = { requestId: 'm1-2026-09-23-111111112222222233333333', date: '2026-09-23',
  classLabel: '6:00 PM TEST class', duration: 1, instructor: 'TEST retained instructor', site: 'Rev',
  notes: 'DO NOT PAY', reason: 'TEST preserved addition' };
const notes = body => `Admin-added | Admin: ${adminName} | Reason: ${body.reason}${body.notes ? ` | Notes: ${body.notes}` : ''}`;
function googleReview(body = original, target = 'test') {
  return { ok: true, date: body.date, records: [{ displayId: 'sheet-row-20', recordId: `gib-admin-${body.requestId}`,
    timestamp: '2026-09-24 14:00:00', date: body.date, classLabel: body.classLabel, duration: body.duration,
    instructor: body.instructor, site: body.site, notes: notes(body), source: 'Admin-added', reviewRequired: false, reviewMessage: '',
    ...(target === 'production' ? { removal: { eligible: true, fingerprint: 'a'.repeat(64), explanation: '', pending: null } } : {}) }],
  warnings: [], auditHistory: [{ auditId: 'audit-row-12', actionNumber: 11, adminName,
    actionTime: '2026-09-24 14:00:01', instructor: body.instructor, classDate: body.date, classLabel: body.classLabel,
    site: body.site, duration: body.duration, reason: body.reason, result: 'added', linkedRecordId: `gib-admin-${body.requestId}` }] };
}
function request(body = original, options = {}) {
  const selectedOrigin = options.production ? productionOrigin : origin;
  const authenticationProduction = options.authenticationProduction ?? options.production;
  const runtime = runtimeConfig(authenticationProduction ? productionEnv : env, { admin: true, requestUrl: authenticationProduction ? productionOrigin : origin });
  const requestToken = 'r'.repeat(43);
  const cookie = createAdminSession(options.adminName || adminName, runtime.sessionSecret, now, requestToken);
  return new Request(options.url || selectedOrigin + config.path, { method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json', Origin: selectedOrigin, Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`,
      [ADMIN_REQUEST_HEADER]: requestToken, ...options.headers },
    ...((options.method || 'POST') === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
async function run(body = original, review = googleReview(body), overrides = {}, options = {}) {
  const calls = [];
  const response = await handleAdminAddCheck(request(body, options), { ...(options.production ? productionDependencies : dependencies), fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(review), { status: 200 });
  }, ...overrides });
  return { response, value: await response.json(), calls };
}

test('fresh exact original row and audit produce a full ordinary addition receipt through reads only', async () => {
  for (const body of [original, { ...original, requestId: 'manager-add-11111111-2222-4333-8444-555555555555', notes: '' }]) {
    const { response, value, calls } = await run(body);
    assert.equal(response.status, 200, JSON.stringify(value));
    assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
    assert.equal(value.test, true);
    const { test: _test, message: _message, ...receipt } = value;
    assert.ok(sanitizeAdminAdditionPayload(receipt, { ...body, adminName }));
    assert.equal(value.requestId, body.requestId);
    assert.equal(value.linkedRecordId, `gib-admin-${body.requestId}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'dailyReview');
    assert.equal(calls[0].date, body.date);
    assert.equal(calls[0].target, 'test');
    assert.equal('removalVersion' in calls[0], false);
    assert.equal('requestId' in calls[0], false);
  }
});

test('read-only receipt passes the unchanged real browser addition validator, including its exact message contract', async () => {
  const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
  const helpers = html.slice(html.indexOf('function exactObjectKeys('), html.indexOf('function validReviewDate('));
  const validator = html.slice(html.indexOf('function validAdminAdditionResponse('), html.indexOf('function signinVoidRequestId('));
  const context = vm.createContext({ testMode: true });
  vm.runInContext(`${helpers}\n${validator}`, context);
  for (const body of [original, { ...original, requestId: 'manager-add-11111111-2222-4333-8444-555555555555', notes: '' }]) {
    const { response, value } = await run(body);
    assert.equal(response.status, 200);
    const expected = { ...body, adminName };
    assert.equal(context.validAdminAdditionResponse(value, expected), true);
    assert.equal(context.validAdminAdditionResponse({ ...value, message: 'The original addition and its audit are confirmed.' }, expected), false);
    assert.equal(context.validAdminAdditionResponse({ ...value, auditActionNumber: 0 }, expected), false);
    assert.equal(context.validAdminAdditionResponse({ ...value, test: false }, expected), false);
    assert.equal(context.validAdminAdditionResponse({ ...value, requestId: body.requestId + '-different' }, expected), false);
    assert.equal(context.validAdminAdditionResponse({ ...value, confirmation: { ...value.confirmation, instructor: 'TEST another instructor' } }, expected), false);
  }
});

test('a legitimate second instructor and separate audit do not prevent confirmation or change either record', async () => {
  const review = googleReview();
  const second = googleReview({ ...original, requestId: 'm1-2026-09-23-aaaaaaaaaaaaaaaabbbbbbbb', instructor: 'TEST legitimate second instructor' });
  review.records.push({ ...second.records[0], displayId: 'sheet-row-21' });
  review.auditHistory.push({ ...second.auditHistory[0], auditId: 'audit-row-13', actionNumber: 12 });
  const before = structuredClone(review);
  const { response, value, calls } = await run(original, review);
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(value.linkedRecordId, `gib-admin-${original.requestId}`);
  assert.equal(value.auditActionNumber, 11);
  assert.deepEqual(review, before);
  assert.deepEqual(calls.map(call => call.action), ['dailyReview']);
});

function receiverHarness(target = 'test') {
  const sheets = new Map();
  const receiverEnv = target === 'test' ? env : productionEnv;
  const transportToken = target === 'test' ? receiverEnv.GIB_TEST_WEBHOOK_TOKEN : receiverEnv.GIB_M1_PRODUCTION_WEBHOOK_TOKEN;
  const actionToken = target === 'test' ? receiverEnv.GIB_TEST_ADMIN_ACTION_TOKEN : receiverEnv.GIB_M1_ADMIN_ACTION_TOKEN;
  // Names are receiver contract fixtures; every sheet below exists only in memory.
  const spreadsheetName = target === 'test' ? 'TEST ONLY synthetic integration' : 'RBJJ M1 — PRODUCTION';
  const sheet = initial => {
    const rows = structuredClone(initial);
    return { rows, notes: new Map(), appendRow: row => rows.push([...row]), getDataRange: () => ({ getValues: () => structuredClone(rows) }), getLastRow: () => rows.length,
      getLastColumn: () => rows[0]?.length || 0,
      getMaxRows: () => 1000, setFrozenRows() {},
      getRange(startRow, startColumn, rowCount, columnCount) {
        return { getValues: () => Array.from({ length: rowCount }, (_, offset) => (rows[startRow - 1 + offset] || []).slice(startColumn - 1, startColumn - 1 + columnCount)),
          getNotes: () => Array.from({ length: rowCount }, (_, offset) => [this.notes.get(startRow + offset) || '']),
          setValues(values) { values.forEach((row, offset) => { const target = rows[startRow - 1 + offset] ||= []; row.forEach((value, column) => { target[startColumn - 1 + column] = value; }); }); return this; },
          setNumberFormat() { return this; } };
      } };
  };
  sheets.set('Signins', sheet([['RowID', 'Timestamp', 'Date', 'Class Label', 'Duration (hr)', 'Instructor', 'Site', 'Device', 'Build', 'Notes', 'Status']]));
  const spreadsheet = { getName: () => spreadsheetName, getSheetByName: name => sheets.get(name),
    insertSheet(name) { const value = sheet([]); sheets.set(name, value); return value; } };
  const formatDate = (date, timeZone, pattern) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}:${parts.second}`;
    if (pattern === 'yyyy-MM-dd') return day;
    if (pattern === 'yyyy-MM-dd HH:mm:ss') return `${day} ${time}`;
    if (pattern === "yyyy-MM-dd'T'HH:mm:ss") return `${day}T${time}`;
    if (pattern === 'Z') {
      const offset = Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60000);
      return `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    }
    throw new Error('Unexpected test date format');
  };
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    EXPECTED_SPREADSHEET_NAME: spreadsheetName, ...(target === 'test' ? { TEST_SPREADSHEET_ID: 'synthetic-test-sheet' } : { SPREADSHEET_ID: 'synthetic-production-contract-sheet' }), GIB_M1_ALLOWED_TARGET: target,
    GIB_M1_REVOLUTION_REMOVAL_ENABLED: true,
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => ({ GIB_M1_RECEIVER_TRANSPORT_TOKEN: transportToken, GIB_M1_ADMIN_ACTION_TOKEN: actionToken })[name] || '' }) },
    SpreadsheetApp: { openById: () => spreadsheet, flush() {} }, Utilities: { formatDate, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(value).digest()] }
  });
  vm.runInContext(readFileSync(new URL('../integrations/google-apps-script/GibM1Receiver.gs', import.meta.url), 'utf8'), context);
  const post = body => JSON.parse(context.adReceiverV2_({ postData: { contents: JSON.stringify(body) } }).text);
  const envelope = { token: transportToken, adminActionToken: actionToken, target, adminName };
  return { post, envelope, sheets };
}

test('the actual receiver addition and Daily Review contract confirm read-only with two legitimate instructors', async () => {
  const { post, envelope, sheets } = receiverHarness();
  const actualSaved = post({ ...envelope, action: 'addMissedInstructor', ...original });
  assert.equal(actualSaved.ok, true, JSON.stringify(actualSaved));
  const second = { ...original, requestId: 'm1-2026-09-23-aaaaaaaaaaaaaaaabbbbbbbb', instructor: 'TEST actual second instructor' };
  assert.equal(post({ ...envelope, action: 'addMissedInstructor', ...second }).ok, true);
  assert.equal(sheets.get('Signins').rows.length, 3);
  assert.equal(sheets.get('Admin Audit').rows.length, 3);
  const before = JSON.stringify([...sheets].map(([name, value]) => [name, value.rows]));
  const actions = [];
  const { response, value } = await run(original, null, { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); actions.push(body.action);
    assert.equal(body.action, 'dailyReview');
    return new Response(JSON.stringify(post(body)));
  } });
  assert.equal(response.status, 200, JSON.stringify(value));
  const { test: _test, message: _message, ...receipt } = value;
  assert.deepEqual(receipt, actualSaved);
  assert.deepEqual(actions, ['dailyReview']);
  assert.equal(JSON.stringify([...sheets].map(([name, item]) => [name, item.rows])), before);
});

const mutations = [
  ['missing / VOID row', value => { value.records = []; }],
  ['duplicate permanent row ID', value => { value.records.push({ ...value.records[0], displayId: 'sheet-row-21' }); }],
  ['duplicate display ID', value => { value.records.push({ ...value.records[0] }); }],
  ['wrong permanent ID', value => { value.records[0].recordId += '-changed'; }],
  ['wrong instructor', value => { value.records[0].instructor = 'TEST other person'; }],
  ['wrong class', value => { value.records[0].classLabel = '7 PM TEST'; }],
  ['wrong date', value => { value.records[0].date = '2026-09-22'; }],
  ['wrong duration', value => { value.records[0].duration = 0.5; }],
  ['wrong site', value => { value.records[0].site = 'Richmond'; }],
  ['manual row', value => { value.records[0].source = 'Manual'; }],
  ['blank timestamp', value => { value.records[0].timestamp = ''; }],
  ['invalid timestamp', value => { value.records[0].timestamp = '2026-02-31 14:00:00'; }],
  ['incorrect note attribution', value => { value.records[0].notes = 'Admin-added | Admin: Andrew Smith | Reason: TEST preserved addition | Notes: DO NOT PAY'; }],
  ['changed notes', value => { value.records[0].notes += ' altered'; }],
  ['collision review', value => { Object.assign(value.records[0], { source: 'Collision review', reviewRequired: true, reviewMessage: 'Needs review' }); }],
  ['missing audit', value => { value.auditHistory = []; }],
  ['duplicate linked audit', value => { value.auditHistory.push({ ...value.auditHistory[0], auditId: 'audit-row-13', actionNumber: 12 }); }],
  ['additional conflicting linked audit', value => { value.auditHistory.push({ ...value.auditHistory[0], auditId: 'audit-row-13', actionNumber: 12, result: 'already exists' }); }],
  ['wrong audit reviewer', value => { value.auditHistory[0].adminName = 'Andrew Smith'; }],
  ['wrong audit reason', value => { value.auditHistory[0].reason = 'Other reason'; }],
  ['wrong audit instructor', value => { value.auditHistory[0].instructor = 'TEST another instructor'; }],
  ['wrong audit date', value => { value.auditHistory[0].classDate = '2026-09-22'; }],
  ['wrong audit class', value => { value.auditHistory[0].classLabel = '7 PM TEST'; }],
  ['wrong audit site', value => { value.auditHistory[0].site = 'Richmond'; }],
  ['wrong audit duration', value => { value.auditHistory[0].duration = 0.5; }],
  ['non-addition audit', value => { value.auditHistory[0].result = 'already exists'; }],
  ['VOID audit', value => { value.auditHistory[0].result = 'voided'; }],
  ['invalid audit number', value => { value.auditHistory[0].actionNumber = 0; }],
  ['invalid audit timestamp', value => { value.auditHistory[0].actionTime = ''; }],
  ['incomplete read warning', value => { value.warnings.push({ displayId: 'audit-history', code: 'AUDIT_UNAVAILABLE', message: 'Daily Review audit history could not be read.' }); }],
  ['partial response', value => { delete value.auditHistory; }]
];
for (const [name, mutate] of mutations) {
  test(`${name} remains unconfirmed and cannot dispatch a write`, async () => {
    const review = googleReview(); mutate(review);
    const { response, value, calls } = await run(original, review);
    assert.ok([409, 503].includes(response.status), JSON.stringify(value));
    assert.equal(value.ok, false); assert.equal(value.result, 'unconfirmed');
    assert.equal(value.code, 'ADMIN_ADD_CHECK_UNCONFIRMED');
    assert.match(value.message, /do not submit another addition/);
    assert.ok(calls.length > 0 && calls.every(call => call.action === 'dailyReview'));
  });
}

test('transport failures and unreadable responses stay unconfirmed', async () => {
  for (const fetch of [async () => { throw new Error('No connection'); }, async () => new Response('unavailable', { status: 503 }), async () => new Response('{partial')]) {
    const { response, value } = await run(original, null, { fetch });
    assert.equal(response.status, 503); assert.equal(value.result, 'unconfirmed');
  }
});

test('authenticated reviewer is bound to the original row and audit', async () => {
  const { response, value } = await run(original, googleReview(), {}, { adminName: 'Andrew Smith' });
  assert.equal(response.status, 409); assert.equal(value.result, 'unconfirmed');
});

test('only exact bounded original TEST requests are accepted before any read', async () => {
  for (const patch of [{ requestId: 'arbitrary-id' }, { requestId: 'm1-2026-09-22-111111112222222233333333' },
    { requestId: original.requestId + '\n' }, { site: 'Richmond' }, { instructor: 'Real instructor' },
    { date: '2026-09-25' }, { reason: ' TEST padded reason ' }, { notes: 'DO  NOT PAY' }, { adminName: 'Andrew Smith' },
    { rowId: `gib-admin-${original.requestId}` }]) {
    const { response, calls } = await run({ ...original, ...patch });
    assert.equal(response.status, 400); assert.equal(calls.length, 0);
  }
});

test('canonical preview, trusted scope and existing Admin authentication are required', async () => {
  const cases = [
    [{}, { method: 'GET' }, 405], [{}, { headers: { Cookie: '' } }, 401],
    [{}, { headers: { [ADMIN_REQUEST_HEADER]: 'wrong' } }, 403],
    [{}, { headers: { Origin: 'https://other.example' } }, 403],
    [{}, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
    [{}, { url: 'https://gib-live.netlify.app' + config.path }, 403],
    [{}, { url: 'https://gib-richmond-test.netlify.app' + config.path }, 403],
    [{}, { url: 'https://deploy-preview-90--gib-live.netlify.app' + config.path }, 403],
    [{}, { url: origin + '/.netlify/functions/m1-admin-add-check' }, 403],
    [{}, { url: origin + config.path + '?target=production' }, 403],
    [{ target: 'production' }, {}, 403], [{ enabled: false }, {}, 403],
    [{ installationId: 'richmond', environment: 'test' }, {}, 403],
    [{ context: { ...dependencies.context, deploy: { context: 'production', published: true } } }, {}, 403],
    [{ context: { ...dependencies.context, site: { name: 'gib-live', id: 'wrong-site-id' } } }, {}, 403]
  ];
  for (const [overrides, options, status] of cases) {
    const { response, calls } = await run(original, googleReview(), overrides, options);
    assert.equal(response.status, status, JSON.stringify({ overrides, options }));
    assert.equal(calls.length, 0);
  }
});

test('complete Daily Review envelope validation is required and the new endpoint contains no write action', () => {
  const daily = { ...googleReview(), test: true, adminName };
  assert.ok(additionReceiptFromDailyReview(daily, original, adminName, 'test'));
  for (const patch of [{ test: false }, { adminName: 'Andrew Smith' }, { extra: true }, { ok: false }]) {
    assert.equal(additionReceiptFromDailyReview({ ...daily, ...patch }, original, adminName, 'test'), null);
  }
  const source = readFileSync(new URL('../netlify/functions/m1-admin-add-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /addMissedInstructor|handleAdminAdd\(|postGoogle\(|managerReviewSave|managerReviewVoid|loadCallbackLedger/);
  assert.match(source, /handleAdminReview\(dailyRequest/);
  assert.equal(config.path, '/api/m1-admin-add-check');
});

test('enabled published Revolution production uses existing full history read and the ordinary live receipt contract', async () => {
  const { response, value, calls } = await run(original, googleReview(original, 'production'), {}, { production: true });
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(value.test, false);
  assert.equal(value.linkedRecordId, `gib-admin-${original.requestId}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'dailyReview');
  assert.equal(calls[0].target, 'production');
  assert.equal(calls[0].environment, 'production');
  assert.equal(calls[0].installation, 'rev');
  assert.equal(calls[0].removalVersion, REMOVAL_VERSION);
  const html = readFileSync(new URL('../m1/admin/index.html', import.meta.url), 'utf8');
  const context = vm.createContext({ testMode: false });
  vm.runInContext(html.slice(html.indexOf('function exactObjectKeys('), html.indexOf('function validReviewDate('))
    + html.slice(html.indexOf('function validAdminAdditionResponse('), html.indexOf('function signinVoidRequestId(')), context);
  assert.equal(context.validAdminAdditionResponse(value, { ...original, adminName }), true);
  assert.equal(context.validAdminAdditionResponse({ ...value, test: true }, { ...original, adminName }), false);
});

test('production remains unavailable without its existing live switch, canonical published site and matching authentication scope', async () => {
  const cases = [
    [{ enabled: false }, {}, 403], [{ target: 'disabled' }, {}, 403], [{ target: 'test' }, {}, 403],
    [{}, { url: origin + config.path }, 403],
    [{}, { url: 'https://1234567890abcdef12345678--gib-live.netlify.app' + config.path }, 403],
    [{}, { url: 'https://gib-richmond-live.netlify.app' + config.path }, 403],
    [{}, { url: productionOrigin + config.path + '?test=true' }, 403],
    [{}, { headers: { Cookie: '' } }, 401], [{}, { authenticationProduction: false }, 401],
    [{}, { headers: { [ADMIN_REQUEST_HEADER]: 'wrong' } }, 403],
    [{}, { headers: { Origin: origin } }, 403],
    [{}, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
    [{ env }, {}, 503],
    [{ env: { ...productionEnv, GIB_TEST_WEBHOOK_URL: productionEnv.GIB_M1_PRODUCTION_WEBHOOK_URL } }, {}, 503],
    [{ installationId: 'richmond', environment: 'production', activation: 'active' }, {}, 403],
    [{ context: { ...productionDependencies.context, deploy: { context: 'production', published: false } } }, {}, 403],
    [{ context: { ...productionDependencies.context, deploy: { context: 'deploy-preview', published: false } } }, {}, 403],
    [{ context: { ...productionDependencies.context, site: { name: 'gib-live', id: 'wrong-site-id' } } }, {}, 403]
  ];
  for (const [overrides, options, status] of cases) {
    const { response, calls } = await run(original, googleReview(original, 'production'), overrides, { production: true, ...options });
    assert.equal(response.status, status, JSON.stringify({ overrides: Object.keys(overrides), options }));
    assert.equal(calls.length, 0);
  }
  // No client body field can select the environment or admit TEST-generated IDs.
  for (const patch of [{ test: true }, { target: 'test' }, { environment: 'production' },
    { requestId: 'manager-add-11111111-2222-4333-8444-555555555555' }, { requestId: 'm1-2026-09-22-111111112222222233333333' }]) {
    const { response, calls } = await run({ ...original, ...patch }, googleReview(original, 'production'), {}, { production: true });
    assert.equal(response.status, 400); assert.equal(calls.length, 0);
  }
  const noBuildSwitch = { ...productionDependencies }; delete noBuildSwitch.enabled; delete noBuildSwitch.target;
  let calls = 0;
  const unavailable = await handleAdminAddCheck(request(original, { production: true }), { ...noBuildSwitch, fetch: async () => { calls++; throw new Error('Disabled source must not call Google'); } });
  assert.equal(unavailable.status, 403); assert.equal(calls, 0);
});

test('trusted TEST/live receipt targets cannot cross even when all attendance fields match', () => {
  for (const target of ['test', 'production']) {
    const value = { ...googleReview(original, target), test: target === 'test', adminName };
    assert.ok(additionReceiptFromDailyReview(value, original, adminName, target));
    assert.equal(additionReceiptFromDailyReview({ ...value, test: !value.test }, original, adminName, target), null);
    assert.equal(additionReceiptFromDailyReview(value, original, adminName), null);
    assert.equal(additionReceiptFromDailyReview(value, original, adminName, 'disabled'), null);
  }
});

test('production rejects the same incomplete/conflicting evidence and incomplete protected history', async () => {
  const changes = [...mutations,
    ['missing protected-history fields', value => { delete value.records[0].removal; }],
    ['protected history unavailable', value => { value.records[0].removal = { eligible: false, fingerprint: '', explanation: 'History needs review.', pending: null }; }],
    ['removal pending', value => { value.records[0].removal = { eligible: false, fingerprint: 'a'.repeat(64), explanation: 'A saved removal needs confirmation.',
      pending: { requestId: 'gib-m1-admin-void-' + value.records[0].recordId, adminName, reason: 'Original removal request' } }; }]
  ];
  for (const [name, mutate] of changes) {
    const review = googleReview(original, 'production'); mutate(review);
    const { response, value, calls } = await run(original, review, {}, { production: true });
    assert.ok([409, 503].includes(response.status), name + JSON.stringify(value));
    assert.equal(value.result, 'unconfirmed', name);
    assert.ok(calls.length && calls.every(call => call.action === 'dailyReview' && call.removalVersion === REMOVAL_VERSION));
  }
});

test('actual production receiver lost-receipt replay preserves one permanent row/audit and read-only confirmation matches', async () => {
  const { post, envelope, sheets } = receiverHarness('production');
  const first = post({ ...envelope, action: 'addMissedInstructor', ...original });
  assert.equal(first.ok, true, JSON.stringify(first));
  // Simulate a lost response followed by the same existing permanent request.
  const replay = post({ ...envelope, action: 'addMissedInstructor', ...original });
  assert.deepEqual(replay, first);
  assert.equal(sheets.get('Signins').rows.length, 2);
  assert.equal(sheets.get('Admin Audit').rows.length, 2);
  const before = JSON.stringify([...sheets].map(([name, value]) => [name, value.rows]));
  const actions = [];
  const { response, value } = await run(original, null, { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); actions.push(body.action);
    assert.equal(body.action, 'dailyReview'); assert.equal(body.removalVersion, REMOVAL_VERSION);
    return new Response(JSON.stringify(post(body)));
  } }, { production: true });
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(value.test, false);
  const { test: _test, message: _message, ...receipt } = value;
  assert.deepEqual(receipt, first);
  assert.deepEqual(actions, ['dailyReview']);
  assert.equal(JSON.stringify([...sheets].map(([name, item]) => [name, item.rows])), before);
});

test('actual production receiver exposes hidden linked VOID conflicts, off-date duplicate IDs and pending removal without changing history', async () => {
  for (const type of ['linked-void-audit', 'other-date-duplicate', 'void-duplicate', 'pending-removal']) {
    const { post, envelope, sheets } = receiverHarness('production');
    assert.equal(post({ ...envelope, action: 'addMissedInstructor', ...original }).ok, true);
    const row = sheets.get('Signins').rows[1], audits = sheets.get('Admin Audit').rows;
    if (type === 'linked-void-audit') audits.push([2, adminName, '2026-09-24T19:00:00.000Z', original.instructor, original.date, original.classLabel, original.site, original.duration, 'Conflicting removal', 'voided', row[0]]);
    if (type.includes('duplicate')) { const duplicate = [...row]; duplicate[2] = '2026-09-22'; if (type === 'void-duplicate') duplicate[10] = 'VOID'; sheets.get('Signins').rows.push(duplicate); }
    if (type === 'pending-removal') {
      const daily = post({ ...envelope, action: 'dailyReview', date: original.date, installation: 'rev', environment: 'production', removalVersion: REMOVAL_VERSION });
      const fingerprint = daily.records[0].removal.fingerprint;
      assert.match(fingerprint, /^[a-f0-9]{64}$/);
      sheets.get('Signins').notes.set(2, JSON.stringify({ adminName, fingerprint, reason: 'Original pending removal', removalVersion: REMOVAL_VERSION,
        requestId: 'gib-m1-admin-void-' + row[0], rowId: row[0] }));
    }
    if (type === 'linked-void-audit') {
      const legacy = post({ ...envelope, action: 'dailyReview', date: original.date });
      assert.equal(legacy.auditHistory.length, 1, 'unversioned Daily Review really hides the conflicting VOID audit');
    }
    const before = JSON.stringify([...sheets].map(([name, value]) => [name, value.rows, [...value.notes]]));
    const { response, value } = await run(original, null, { fetch: async (_url, init) => {
      const body = JSON.parse(init.body); assert.equal(body.action, 'dailyReview');
      return new Response(JSON.stringify(post(body)));
    } }, { production: true });
    assert.ok([409, 503].includes(response.status), type + JSON.stringify(value));
    assert.equal(value.result, 'unconfirmed', type);
    assert.equal(JSON.stringify([...sheets].map(([name, item]) => [name, item.rows, [...item.notes]])), before, type);
  }
});
