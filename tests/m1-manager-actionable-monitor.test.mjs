import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAttendanceDigestJob } from '../netlify/functions/m1-attendance-digest-job.mjs';
import { makeDigestBinding, digestSignature } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { recordUploadEvidence } from '../netlify/functions/_lib/m1-upload-evidence.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';

// Actual handlers, entirely fake runtime/session, in-memory stores; no network.
export const DATE = '2026-10-03', NOW = Date.parse('2026-10-04T00:05:31Z');
export const ID = '00000000-0000-4000-8000-000000000004';
export function memoryStore() {
  const entries = new Map(); let serial = 0;
  return { entries, async list({prefix}) { return {blobs:[...entries].filter(([k])=>k.startsWith(prefix)).map(([key])=>({key}))}; },
    async getWithMetadata(key) { return structuredClone(entries.get(key) || null); },
    async set(key, raw, c={}) { const old=entries.get(key); if(c.onlyIfNew&&old || c.onlyIfMatch&&old?.etag!==c.onlyIfMatch)return {modified:false};
      entries.set(key,{data:JSON.parse(raw),etag:String(++serial)}); return {modified:true}; } };
}
export function input(gym='rev', date=DATE, now=NOW) {
  const ledger={ok:true,schema:'m1-manager-review/v1',target:'production',complete:true,gym,from:'2026-09-07',to:date,
    days:datesThrough(date).map(date=>({date,attendanceHash:'a'.repeat(64),records:[],warnings:[],review:null}))};
  const schedules={gym,timezone:'America/New_York',days:datesThrough(date).map(date=>({date,status:'complete',observedAt:date+'T12:00:00.000Z',sourceVersion:'fake-local-'+date,occurrences:[]}))};
  return {date,now,ledger,schedules,digestStore:memoryStore(),uploadStore:memoryStore()};
}
export function manifest(date=DATE, patch={}) { return {schema:'m1-upload-evidence/v1',deviceId:ID,sequence:1,date,
  coverageFrom:new Date(Date.parse(date+'T12:00Z')-86400000).toISOString().slice(0,10),manifestComplete:true,rowIds:[],savedCount:0,pendingCount:0,unconfirmedCount:0,...patch}; }
export async function runJob(f) {
  const env={GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true',GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED:'true',
    GIB_M1_PRODUCTION_WEBHOOK_URL:'https://script.google.com/macros/s/TEST_RECEIVER_PLACEHOLDER/exec',
    GIB_M1_PRODUCTION_WEBHOOK_TOKEN:'fake-local-receiver-token-0123456789',GIB_M1_ADMIN_ACTION_TOKEN:'fake-local-admin-token-0123456789',
    GIB_M1_ADMIN_PASSPHRASE:'fake local amber meadow',GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED:'true',GIB_M1_MAILAPP_LIVE_SEND_ENABLED:'true'};
  const body=JSON.stringify({...makeDigestBinding(ID,'scheduled',f.now,'production'),gyms:[{gym:'rev',attendance:{ok:true,ledger:f.ledger},staff:{ok:true,complete:true,items:[],notApplicable:true}}]});
  const req=new Request('https://gib-live.netlify.app/api/m1-attendance-digest-job',{method:'POST',headers:{'Content-Type':'application/json','X-GIB-M1-Digest-Signature':digestSignature(body,env.GIB_M1_ADMIN_ACTION_TOKEN)},body});
  const response=await handleAttendanceDigestJob(req,{env,installationId:'rev',clock:()=>f.now,
    context:{site:{name:'gib-live',id:'f748e737-11e3-4fab-8e8c-bf185eab29ff'},deploy:{context:'production',published:true}},
    digestStore:f.digestStore,uploadStore:f.uploadStore,loadSchedules:async()=>f.schedules,traceLog(){},fetch:async()=>{throw Error('External network forbidden in local fixture');}});
  assert.equal(response.status,200); return response.json();
}

test('owner October3 zero-correction/no-reporter/history regression: operator faults do not generate manager email',async()=>{
  const f=input(); f.schedules.days=f.schedules.days.map(day=>day.date<'2026-10-01'?{date:day.date,status:'unavailable',code:'MISSING_DATED_SCHEDULE'}:day);
  const r=await runJob(f);
  assert.equal(r.dailyEmail.shouldSend,false,'zero manager-actionable findings must not send internal setup faults');
  assert.equal(r.dailyEmail.coverageConfirmed,false,'no manager email is not a clean upload check');
  const record=f.digestStore.entries.get('outbox/m1-production-daily-'+DATE).data;
  assert.equal(record.readFailures.find(x=>x.code==='HISTORICAL_SCHEDULE_UNAVAILABLE').dates.length,24);
  assert.equal(record.readFailures.find(x=>x.component==='uploads').code,'UPLOAD_COMPLETENESS_UNCONFIRMED');
});

test('historical setup alone remains raw evidence without a manager send or false clean claim',async()=>{
  const f=input(); await recordUploadEvidence(f.uploadStore,manifest(),NOW);
  f.schedules.days=f.schedules.days.map(day=>day.date<'2026-10-01'?{date:day.date,status:'unavailable',code:'MISSING_DATED_SCHEDULE'}:day);
  const r=await runJob(f);
  assert.equal(r.dailyEmail.shouldSend,false); assert.equal(r.dailyEmail.coverageConfirmed,false);
});
