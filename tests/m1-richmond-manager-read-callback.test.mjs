import assert from 'node:assert/strict';
import test from 'node:test';
import { handleManagerReview } from '../netlify/functions/m1-manager-review.mjs';
import { handleReadResult } from '../netlify/functions/m1-test-read-result.mjs';
import { handleReadProof } from '../netlify/functions/m1-test-read-proof.mjs';
import { ADMIN_COOKIE, ADMIN_REQUEST_HEADER, createAdminSession, runtimeConfig } from '../netlify/functions/_lib/m1-common.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { RICHMOND_TEST_ORIGIN as ORIGIN, CALLBACK_PATH, PROOF_PATH, STAFF_READ_PATH, SIGNATURE_HEADER, READ_ID_HEADER, READ_OPERATION_HEADER,
  callbackRuntime, cleanupExpiredReads, key, makeBinding, signature, validateBinding } from '../netlify/functions/_lib/m1-test-read-callback.mjs';
const NOW = Date.parse('2026-09-29T18:00:00Z'), ID = '00000000-0000-4000-8000-000000000001', BADGE = '00000000-0000-4000-8000-000000000002';
const ENV = { GIB_M1_INSTALLATION: 'richmond', GIB_M1_ENVIRONMENT: 'test',
  GIB_RICHMOND_TEST_WEBHOOK_URL: 'https://script.google.com/macros/s/SYNTHETIC_RICHMOND_CALLBACK/exec',
  GIB_RICHMOND_TEST_WEBHOOK_TOKEN: 'richmond-test-receiver-1234567890abcdef', GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN: 'richmond-test-admin-1234567890abcdef' };
const SCOPE = { installationId: 'richmond', environment: 'test' };
const RUNTIME = runtimeConfig(ENV, { ...SCOPE, admin: true, requestUrl: ORIGIN });
const ledger = () => ({ ok: true, target: 'test', schema: 'm1-manager-review/v1', complete: true, gym: 'richmond', from: '2026-09-07', to: '2026-09-29',
  days: datesThrough('2026-09-29').map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) });
const scopedKey = (id, part) => key(id, part, 'test', 'richmond');
function harness() {
  let stamp = NOW; const entries = new Map(), tasks = [], calls = [];
  const store = { async getWithMetadata(k) { return entries.has(k) ? { etag: 'confirmed', data: structuredClone(entries.get(k)) } : null; },
    async set(k, raw, options) { assert.equal(options.onlyIfNew, true); if (entries.has(k)) return { modified: false }; entries.set(k, JSON.parse(raw)); return { modified: true }; },
    async *list({prefix}) { yield { blobs: [...entries.keys()].filter(k => k.startsWith(prefix)).map(key => ({key})) }; }, async delete(k) { entries.delete(k); } };
  const deps = { ...SCOPE, env: ENV, enabled: true, store, clock: () => stamp,
    context: { site: { id: '42736c77-e3c8-40aa-ba97-4f935d0999ad', name: 'gib-richmond-test' }, deploy: { context: 'production', published: true }, waitUntil: p => tasks.push(p) },
    traceLog() {}, schedule: { current: true, timezone: 'America/New_York', days: {} }, addedStore: { getWithMetadata: async () => null },
    fetch: async (_, options) => { const body = JSON.parse(options.body); assert.ok(entries.has(scopedKey(body.binding.requestId, 'pending'))); assert.equal(options.redirect, 'manual'); calls.push(body); return new Response(null, {status:404}); } };
  // Nested handlers spread the injected dependencies. Keep the synthetic clock
  // enumerable so those handlers never mix this fixture date with today's date.
  Object.defineProperty(deps,'now',{enumerable:true,get:()=>stamp});
  return { entries, tasks, calls, deps, advance: ms => { stamp = NOW + ms; } };
}
function request(operation='start', id=ID, name='Trey Martin', body) {
  const token='x'.repeat(43), cookie=createAdminSession(name,RUNTIME.sessionSecret,NOW,token,RUNTIME);
  return new Request(ORIGIN+'/api/m1-manager-review',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',Cookie:`${ADMIN_COOKIE}=${encodeURIComponent(cookie)}`,[ADMIN_REQUEST_HEADER]:token},body:JSON.stringify(body||{action:'read',readRequest:{operation,requestId:id}})});
}
const badge=(operation='start',id=BADGE)=>new Request(ORIGIN+'/api/m1-manager-review',{headers:{[READ_ID_HEADER]:id,[READ_OPERATION_HEADER]:operation}});
async function deliver(h,id=ID,change=()=>{}) {
  const payload={binding:structuredClone(h.entries.get(scopedKey(id,'pending')).binding),readAt:h.deps.clock(),result:ledger()};change(payload);
  const raw=JSON.stringify(payload);return handleReadResult(new Request(ORIGIN+CALLBACK_PATH,{method:'POST',headers:{'Content-Type':'application/json',[SIGNATURE_HEADER]:signature(raw,RUNTIME.adminActionToken)},body:raw}),h.deps);
}
test('Richmond canonical TEST read uses its own durable ticket, auth, fixed receiver envelope and single dispatch despite lost ordinary reply',async()=>{
  const h=harness(); const starts=await Promise.all([handleManagerReview(request(),h.deps),handleManagerReview(request(),h.deps)]);
  assert.deepEqual(starts.map(r=>r.status),[202,202]); await Promise.all(h.tasks);
  assert.equal(h.calls.length,1); assert.equal(h.calls[0].action,'managerReviewReadCallback');
  assert.equal(h.calls[0].installation,'richmond');assert.equal(h.calls[0].environment,'test');assert.equal(h.calls[0].gym,'richmond');assert.equal(h.calls[0].adminName,'Trey Martin');
  assert.equal(h.entries.has(key(ID,'pending')),false); h.advance(35000);
  assert.equal((await deliver(h)).status,200);assert.equal((await deliver(h)).status,200);
  const result=await handleManagerReview(request('status'),h.deps);assert.equal(result.status,200);
  const value=await result.json();assert.equal(value.gym,'richmond');assert.equal(value.days.length,23);assert.equal(h.calls.length,1);
});
test('Richmond badge has no invented reviewer and exposes only aggregate count; Admin data stays authenticated and owner-bound',async()=>{
  const h=harness();await Promise.all([handleManagerReview(request(),h.deps),handleManagerReview(badge(),h.deps)]);await Promise.all(h.tasks);
  assert.equal(Object.hasOwn(h.calls.find(c=>c.binding.action==='managerReviewBadgeRead'),'adminName'),false);
  assert.equal((await handleManagerReview(badge('status',ID),h.deps)).status,409);
  assert.equal((await handleManagerReview(request('status',ID,'Andrew Smith'),h.deps)).status,409);
  assert.equal((await handleManagerReview(new Request(ORIGIN+'/api/m1-manager-review',{method:'POST',body:JSON.stringify({action:'read'})}),h.deps)).status,401);
  await deliver(h,BADGE);const value=await(await handleManagerReview(badge('status'),h.deps)).json();assert.deepEqual(Object.keys(value).sort(),['asOf','ok','pendingDays']);
});
test('Richmond rejects crossed gym, incomplete, conflicting and late callbacks; missing results never become all-clear',async()=>{
  const h=harness();await handleManagerReview(request(),h.deps);await Promise.all(h.tasks);
  assert.equal((await deliver(h,ID,p=>p.binding.gym='rev')).status,409);
  assert.equal((await deliver(h,ID,p=>p.result.gym='rev')).status,422);
  assert.equal((await deliver(h,ID,p=>p.result.complete=false)).status,422);
  assert.equal((await deliver(h)).status,200);
  assert.equal((await deliver(h,ID,p=>p.result.days[0].attendanceHash='b'.repeat(64))).status,409);
  h.advance(50000);const expired=await handleManagerReview(request('status'),h.deps);assert.equal(expired.status,410);assert.equal((await expired.json()).pendingDays,undefined);
  h.advance(60000);assert.equal((await deliver(h)).status,410);
});
test('Richmond proof, Staff, addition proof, foreign origins/sites and production cannot enter the callback route',async()=>{
  const h=harness();
  for(const path of [PROOF_PATH,STAFF_READ_PATH,'/api/m1-admin-add-check']) assert.equal(callbackRuntime(new Request(ORIGIN+path),path,h.deps),null);
  assert.equal((await handleReadProof(new Request(ORIGIN+PROOF_PATH),h.deps)).status,403);
  assert.equal(callbackRuntime(new Request('https://gib-richmond-live.netlify.app/api/m1-manager-review'),'/api/m1-manager-review',h.deps),null);
  assert.equal(callbackRuntime(new Request(ORIGIN+'/api/m1-manager-review'),'/api/m1-manager-review',{...h.deps,context:{...h.deps.context,site:{name:'gib-live',id:'f748e737-11e3-4fab-8e8c-bf185eab29ff'}}}),null);
  for(const action of ['adminAdditionCheckRead','staffClockRead','managerReviewSave']) assert.throws(()=>validateBinding(makeBinding(ID,NOW,action,'test','richmond'),NOW,'test','richmond'));
  assert.throws(()=>validateBinding(makeBinding(ID,NOW,'managerReviewRead','production','richmond'),NOW,'production','richmond'));
  assert.equal(h.calls.length,0);
});
test('Richmond cleanup preserves every unexpired read and Revolution namespace',async()=>{
  const h=harness(); h.entries.set(scopedKey(ID,'pending'),{binding:makeBinding(ID,NOW-70000,'managerReviewRead','test','richmond')});
  h.entries.set(scopedKey(ID,'result'),{old:true});h.entries.set(key(ID,'pending'),{binding:makeBinding(ID,NOW-70000)});
  h.entries.set(scopedKey(BADGE,'pending'),{binding:makeBinding(BADGE,NOW,'managerReviewBadgeRead','test','richmond')});
  await cleanupExpiredReads(h.deps.store,NOW,{gym:'richmond'});
  assert.equal(h.entries.has(scopedKey(ID,'pending')),false);assert.equal(h.entries.has(scopedKey(ID,'result')),false);
  assert.equal(h.entries.has(key(ID,'pending')),true);assert.equal(h.entries.has(scopedKey(BADGE,'pending')),true);
});
test('Richmond same-request save recovery keeps the exact original ordinary pre-save read',async()=>{
  const h=harness(),original={action:'partial',requestId:'manager-original-123456789',date:'2026-09-28',revision:0,attendanceHash:'a'.repeat(64),scheduleHash:'b'.repeat(64),decisions:[]};
  h.deps.fetch=async(_,options)=>{const body=JSON.parse(options.body);h.calls.push(body);assert.equal(body.action,'managerReviewRead');assert.deepEqual(body.check,original);return new Response(JSON.stringify({...ledger(),receipt:{saved:true,requestId:original.requestId,revision:1}}));};
  const response=await handleManagerReview(request('start',ID,'Trey Martin',original),h.deps);assert.equal(response.status,200,await response.clone().text());assert.equal(h.calls.length,1);assert.equal(h.tasks.length,0);assert.equal(h.entries.size,0);
});
