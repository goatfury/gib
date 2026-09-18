import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildReader, READER_FUNCTIONS } from '../promotions/api-readonly/build.mjs';

const shared = readFileSync(new URL('../promotions/Code.gs', import.meta.url), 'utf8');
const reader = readFileSync(new URL('../promotions/api-readonly/Reader.gs', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../promotions/api-readonly/Adapter.gs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../promotions/api-readonly/appsscript.json', import.meta.url)));
const OWNER = 'synthetic-ops@example.invalid', BOOK = 'synthetic-api-proof-book', SECRET = 'synthetic-bridge-secret-0000000000000000';
const MODE = 'm1-authorized-tablet-test-v1', ORIGIN = 'https://deploy-preview-86--gib-live.netlify.app';
const CONFIG = { TEST_OWNER_EMAIL: OWNER, TEST_WORKBOOK_ID: BOOK, TEST_BRIDGE_ORIGIN: ORIGIN, TEST_BRIDGE_SECRET: SECRET, TEST_BRIDGE_MODE: MODE, TEST_BRIDGE_INSTALLATION: 'rev' };
const plain = value => JSON.parse(JSON.stringify(value));
const digest = text => createHash('sha256').update(text).digest('hex');
const signedBytes = value => [...value].map(byte => byte > 127 ? byte - 256 : byte);

function harness({ original = false, active = OWNER, effective = OWNER, configured = true, properties: changes = {}, bookTitle = 'GYM IN A BOX Promotions — PRIVATE SYNTHETIC TEST', timezone = 'America/New_York', lockAvailable = true } = {}) {
  const properties = new Map(Object.entries({ ...CONFIG, ...(!configured ? { TEST_BRIDGE_SECRET: '', TEST_BRIDGE_MODE: '', TEST_BRIDGE_INSTALLATION: '' } : {}), ...changes }));
  const cache = new Map(), cacheWrites = [], propertyReads = [], propertyWrites = [], opened = [], data = new Map(); let held = false;
  const context = vm.createContext({ Date, console: { info() {} },
    Session: { getActiveUser: () => ({ getEmail: () => active }), getEffectiveUser: () => ({ getEmail: () => effective }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty(name) { propertyReads.push(name); return properties.get(name) || ''; },
      setProperties(values) { assert.equal(held, true); assert.deepEqual(Object.keys(values).sort(), ['TEST_BRIDGE_INSTALLATION', 'TEST_BRIDGE_MODE', 'TEST_BRIDGE_SECRET']); propertyWrites.push(plain(values)); for (const [k,v] of Object.entries(values)) properties.set(k,v); } }) },
    LockService: { getScriptLock: () => ({ tryLock() { assert.equal(held, false); held = lockAvailable; return held; }, releaseLock() { assert.equal(held, true); held = false; } }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key) || null, put(key, value, ttl) { if (!original || key.startsWith('promotions-bridge:')) assert.equal(held, true); cacheWrites.push({ key, value, ttl }); cache.set(key,value); } }) },
    SpreadsheetApp: { openById(id) { assert.equal(held, true); opened.push(id); assert.equal(id, BOOK); return book; } },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, text) => signedBytes(createHash('sha256').update(text).digest()),
      computeHmacSha256Signature: (text, key) => signedBytes(createHmac('sha256', key).update(text).digest()),
      formatDate: value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value),
      newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: () => ({ text, getContent: () => text }) }) }
  });
  vm.runInContext(original ? shared : reader + '\n' + adapter, context);
  const headers = name => plain(vm.runInContext(name, context));
  const historyHeaders = headers('PROMOTION_HISTORY_HEADERS_');
  function row(values) { return historyHeaders.map(name => values[name] ?? ''); }
  const refs = JSON.stringify([{ range: "'Black Belt'!A2:B2", fingerprint: 'a'.repeat(64) }]);
  const first = { event_id: 'seed-event-001', request_id: 'seed-request-001', student_id: 'seed-student-001', revision: 1, event_kind: 'REGISTER',
    recorded_at_utc: '2026-09-01T12:00:00.000Z', display_name: 'TEST Avery', distinguishing_label: 'Legacy Black Belt row 2', after_status: 'active', after_rank_known: false,
    recorder_identity: 'LEGACY BASELINE IMPORT', reason: 'Legacy baseline import; manifest=promotions-live-baseline-v1; promotion date unknown.', legacy_refs: refs, history_note: 'Synthetic proof' };
  const second = { event_id: 'seed-event-002', request_id: 'seed-request-002', student_id: 'seed-student-002', revision: 1, event_kind: 'REGISTER',
    recorded_at_utc: '2026-09-01T12:00:00.000Z', display_name: 'TEST Rowan', distinguishing_label: 'Synthetic identity', after_status: 'active',
    after_rank_known: true, after_belt: 'White Belt', after_marks: 0, after_mark_type: 'stripes', recorder_identity: 'SYNTHETIC FIXTURE' };
  const stripe = { ...second, event_id: 'award-event-002', request_id: 'award-request-002', revision: 2, event_kind: 'STRIPE', event_date_ny: '2026-09-02',
    before_status: 'active', before_rank_known: true, before_belt: 'White Belt', before_marks: 0, before_mark_type: 'stripes', after_marks: 1,
    recorder_identity: 'm1-test-device-' + 'a'.repeat(24), approver_label: 'Synthetic Coach', payload_fingerprint: 'b'.repeat(64) };
  data.set('Promotion History', [historyHeaders, row(first), row(second), row(stripe)]);
  data.set('Students', [headers('STUDENT_HEADERS_')]);
  for (const name of ['Black Belt', 'Brown Belt', 'Purple Belt', 'Blue Belt', 'White Belt', 'Former student']) data.set(name, [['Name']]);
  const book = { getId: () => BOOK, getName: () => bookTitle, getSpreadsheetTimeZone: () => timezone,
    getSheetByName(name) { if (!data.has(name)) return null; const values = data.get(name); return {
      getLastColumn: () => values[0].length, getLastRow: () => values.length,
      getRange(r,c,height=1,width=1) { return { getValues() { assert.equal(held,true); return Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>values[r+y-1]?.[c+x-1] ?? '')); } }; }
    }; } };
  let sequence = 0;
  function envelope(request, changes = {}) {
    const payload = { version: 1, mode: MODE, target: 'test', installation: 'rev', origin: ORIGIN, issuedAt: Math.floor(Date.now()/1000),
      nonce: (++sequence).toString(16).padStart(32,'0'), deviceIdentity: 'm1-test-device-' + 'a'.repeat(24), request, ...changes };
    return { payload, signature: createHmac('sha256', SECRET).update('gib-promotions-test-bridge:v1\n' + context.canonicalPromotionJson_(payload)).digest('hex') };
  }
  return { context, data, row, properties, propertyReads, propertyWrites, opened, cacheWrites, envelope, first,
    call(value) { return plain(original ? JSON.parse(context.doPost({postData:{contents:JSON.stringify(value)}}).text) : context.readPromotions(plain(value))); },
    configure(config = CONFIG) { return plain(context.configureTestReader(plain(config))); },
    appendIdentityRepair() {
      const before = { displayName: first.display_name, distinguishingLabel: first.distinguishing_label };
      const after = { ...before, displayName: 'TEST Avery Finch' };
      const cells = [['A1','Name'],['B1',''],['A2','TEST Avery'],['B2','Finch']].map(([cell,value])=>({sheet:'Black Belt',cell,value:{type:value?'string':'blank',value},display:value,numberFormat:null}));
      const identity = { schema:'promotions-data-repair-v1',manifestId:'synthetic-api-manifest',target:'test',workbookId:BOOK,studentId:first.student_id,
        expectedRevision:1,expectedLastEventId:first.event_id,expectedSourceFingerprint:digest(refs),field:'identity',before,after,
        evidence:{interpretation:'Established source split name in A and B.',headerRefs:["'Black Belt'!A1:B1"],cells} };
      const repair = { ...identity,repairId:'repair-'+context.promotionRepairFingerprint_(identity) };
      context.validatePromotionRepair_(plain(repair));
      data.get('Promotion History').push(row({...first,event_id:'evt-'+repair.repairId,request_id:'req-'+repair.repairId,revision:2,event_kind:'REPAIR',event_date_ny:'2026-09-03',
        display_name:after.displayName,before_status:'active',before_rank_known:false,recorder_identity:'OWNER DATA REPAIR: '+OWNER,
        reason:context.canonicalPromotionRepairJson_(repair),payload_fingerprint:context.promotionRepairFingerprint_({operation:'applyRepair',repair})}));
    }
  };
}

test('generated artifact is the exact allowlisted strict-reader closure with only two public functions and no business writer', () => {
  assert.equal(reader.replace(/\r\n/g,'\n'),buildReader(shared));
  const functions=[...(reader+'\n'+adapter).matchAll(/^function (\w+)\(/gm)].map(m=>m[1]);
  assert.deepEqual(functions.filter(name=>!name.endsWith('_')).sort(),['configureTestReader','readPromotions']);
  for(const name of ['doGet','doPost','promotionRepair','promotionRequest','promotionRequestWithRecorder_','validatePromotionRequest_','verifyPromotionRepairSource_','buildPromotionEvent_','promotionEventRow_','rebuildPromotionStudents_','confirmedPromotionResult_']) assert.equal(functions.includes(name),false,name);
  assert.equal(/\b(?:appendRow|setValues|setValue|clearContent|flush|insertSheet)\s*\(/.test(reader+adapter),false);
  assert.equal(/['"]LIVE_[A-Z_]+['"]/.test(reader+adapter),false);
  assert.ok(READER_FUNCTIONS.includes('validatePromotionRepair_'));
  assert.deepEqual(manifest.oauthScopes,['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/userinfo.email']);
  assert.deepEqual(manifest.executionApi,{access:'MYSELF'}); assert.equal(manifest.webapp,undefined);
});

test('API reads equal the existing five-field web-app responses for current, unknown and repaired history', () => {
  const api=harness(),reference=harness({original:true});api.appendIdentityRepair();reference.appendIdentityRepair();
  const before=structuredClone(api.data);
  for(const request of [{operation:'bootstrap'},{operation:'readStudent',studentId:'seed-student-001'},{operation:'readStudent',studentId:'seed-student-002'},{operation:'readStudent',studentId:'missing-student-003'}]) {
    const env=api.envelope(request);const actual=api.call(env);assert.deepEqual(actual,reference.call(env));assert.equal(Object.keys(actual).length,5);
  }
  assert.deepEqual(api.data,before);assert.ok(api.propertyReads.every(name=>name.startsWith('TEST_')));assert.deepEqual(api.propertyWrites,[]);
  const repaired=api.call(api.envelope({operation:'readStudent',studentId:'seed-student-001'})).result.data;
  assert.equal(repaired.student.displayName,'TEST Avery Finch');assert.equal(repaired.history[0].after.displayName,'TEST Avery');assert.equal(repaired.student.rankKnown,false);
});

test('writes, repair and checkSave reject before workbook/cache access despite a valid signed envelope', () => {
  const h=harness();for(const operation of ['checkSave','recordPromotion','confirmRank','registerStudent','correctLatest','applyRepair','repair','unknown']) {
    const result=h.call(h.envelope({operation,requestId:'synthetic-request-0001'}));assert.equal(result.result.error.code,'VALIDATION');
  }
  assert.deepEqual(h.opened,[]);assert.deepEqual(h.cacheWrites,[]);assert.deepEqual(h.propertyWrites,[]);
  const bad=h.call(h.envelope({operation:'bootstrap',workbookId:'other-book'}));assert.equal(bad.result.error.code,'VALIDATION');assert.deepEqual(h.opened,[]);
});

test('only the configured TEST identity/origin/signature and fresh nonce can reach the workbook', () => {
  for(const mutation of [{target:'live'},{mode:'m1-authorized-tablet-live-v1'},{origin:'https://gib-live.netlify.app'},{origin:'https://deploy-preview-99--gib-live.netlify.app'},
    {installation:'richmond'},{issuedAt:Math.floor(Date.now()/1000)-121},{issuedAt:Math.floor(Date.now()/1000)+31},{nonce:'bad'},{deviceIdentity:'m1-live-device-'+'a'.repeat(24)}]) {
    const h=harness();assert.equal(h.call(h.envelope({operation:'bootstrap'},mutation)).error.code,'UNAUTHORIZED');assert.deepEqual(h.opened,[]);
  }
  for(const options of [{active:'other@example.invalid'},{effective:'other@example.invalid'},{configured:false}]) {
    const h=harness(options);assert.equal(h.call(h.envelope({operation:'bootstrap'})).error.code,'UNAUTHORIZED');assert.deepEqual(h.opened,[]);
  }
  const h=harness();const invalid=h.envelope({operation:'bootstrap'});invalid.signature='0'.repeat(64);assert.equal(h.call(invalid).error.code,'UNAUTHORIZED');
  const env=h.envelope({operation:'bootstrap'});assert.equal(h.call(env).result.ok,true);const count=h.opened.length;
  assert.equal(h.call(env).result.error.code,'UNAUTHORIZED');assert.equal(h.opened.length,count);assert.equal(h.cacheWrites.length,1);assert.equal(h.cacheWrites[0].ttl,180);
});

test('unprepared/wrong TEST destination and unknown or inconsistent history fail closed without mutation', () => {
  for(const options of [{bookTitle:'Some other workbook'},{timezone:'UTC'},{lockAvailable:false}]) {
    const h=harness(options);const result=h.call(h.envelope({operation:'bootstrap'}));assert.equal(result.result.ok,false);assert.deepEqual(h.propertyWrites,[]);
  }
  for(const corrupt of [h=>h.data.delete('Former student'),h=>h.data.get('Students')[0].pop(),h=>h.data.get('Promotion History')[1][4]='UNKNOWN',h=>h.data.get('Promotion History')[3][3]=5,h=>h.data.get('Promotion History')[1][15]=true]) {
    const api=harness(),reference=harness({original:true});corrupt(api);corrupt(reference);const snapshot=structuredClone(api.data);const env=api.envelope({operation:'bootstrap'});
    assert.equal(api.call(env).result.ok,false);assert.deepEqual(api.data,snapshot);
    if(api.data.get('Students')?.[0].length===12)assert.equal(reference.call(env).result.ok,false);
  }
});

test('owner initializer uses existing pins and atomically configures only missing bridge properties, with exact-repeat idempotency', () => {
  const h=harness({configured:false});assert.deepEqual(h.configure(),{ok:true,status:'configured'});assert.equal(h.propertyWrites.length,1);
  assert.deepEqual(h.propertyWrites[0],{TEST_BRIDGE_SECRET:SECRET,TEST_BRIDGE_MODE:MODE,TEST_BRIDGE_INSTALLATION:'rev'});
  assert.deepEqual(h.configure(),{ok:true,status:'already_configured'});assert.equal(h.propertyWrites.length,1);
  assert.equal(h.call(h.envelope({operation:'bootstrap'})).result.ok,true);
  const partial=harness({configured:false,properties:{TEST_BRIDGE_MODE:MODE}});assert.equal(partial.configure().status,'configured');assert.equal(partial.propertyWrites.length,1);
});

test('initializer refuses absent/mismatched pins, nonowner, malformed secret and any conflicting existing configuration', () => {
  for(const options of [{configured:false,properties:{TEST_OWNER_EMAIL:''}},{configured:false,properties:{TEST_WORKBOOK_ID:''}},
    {configured:false,properties:{TEST_BRIDGE_ORIGIN:''}},{configured:false,active:'other@example.invalid'},
    {properties:{TEST_BRIDGE_SECRET:'a-different-existing-secret-00000000'}},{configured:false,properties:{TEST_BRIDGE_MODE:'different-mode'}},{configured:false,bookTitle:'Other'}]) {
    const h=harness(options);assert.throws(()=>h.configure());assert.deepEqual(h.propertyWrites,[]);
  }
  for(const changes of [{TEST_OWNER_EMAIL:'other@example.invalid'},{TEST_WORKBOOK_ID:'other-book'},{TEST_BRIDGE_ORIGIN:'https://deploy-preview-99--gib-live.netlify.app'},
    {TEST_BRIDGE_SECRET:'short'},{TEST_BRIDGE_SECRET:' '+SECRET},{TEST_BRIDGE_MODE:'live'},{TEST_BRIDGE_INSTALLATION:'richmond'},{extra:'private'}]) {
    const h=harness({configured:false});assert.throws(()=>h.configure({...CONFIG,...changes}),error=>!error.message.includes(SECRET));assert.deepEqual(h.propertyWrites,[]);
  }
});
