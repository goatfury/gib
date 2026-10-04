import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAttendanceDigestJob } from '../netlify/functions/m1-attendance-digest-job.mjs';
import { makeDigestBinding, digestSignature } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { recordUploadEvidence } from '../netlify/functions/_lib/m1-upload-evidence.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { CASES, runCase, worker } from './fixtures/m1-manager-actionable-cases.mjs';
import { managerAttendanceEmail } from '../netlify/functions/_lib/m1-manager-attendance-email.mjs';
import { buildAttendanceDigest, defaultDigestConfiguration } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { scope } from './fixtures/m1-manager-actionable-cases.mjs';

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

for (const gym of ['rev','richmond']) for (const kind of CASES) test(gym+' real local check/render/worker: '+kind,async()=>{
  const {report,capture}=await runCase(kind,gym),h=worker(gym);h.report(report);
  const sends=['known-pending','known-stale','known-read-failed','missing-plus-internal','incorrect-plus-internal'].includes(kind);
  assert.equal(report.shouldSend,sends);assert.equal(report.schema,'m1-daily-email-check/v2');
  assert.equal(report.unconfirmedChecks,report.managerWarningCount+report.operatorFaultCount);
  const result=h.tick();h.tick();assert.equal(h.checks.length,1);assert.equal(h.sends.length,sends?1:0);
  assert.equal(h.claim().coverageConfirmed,report.coverageConfirmed);
  if(!sends){assert.equal(report.rendered,null);assert.equal(result.state,report.coverageConfirmed?'suppressed':'no-manager-action');}
  else {
    const sent=h.sends[0];assert.equal(sent.subject,report.rendered.subject);assert.equal(sent.body,report.rendered.text);assert.equal(sent.htmlBody,report.rendered.html);
    assert.equal(sent.to,gym==='rev'?'info@revolutionbjj.com':'info@richmondbjj.com');assert.equal(sent.bcc,'andrew@revolutionbjj.com');assert.equal(sent.replyTo,'andrew@revolutionbjj.com');assert.equal(sent.cc,undefined);
    assert.doesNotMatch(sent.body+sent.htmlBody,/2026-09-07|2026-09-30|Historical schedule|MISSING_DATED_SCHEDULE|No tablet upload report has been received/);
    assert.equal(/Please reply[^\n<]*correction/i.test(sent.body+sent.htmlBody),['missing-plus-internal','incorrect-plus-internal'].includes(kind));
    if(kind.startsWith('known-')){assert.match(sent.body,/Check the tablet's saved-upload warnings/);assert.doesNotMatch(sent.body,/no valid instructor sign-in recorded/);}
    if(kind==='missing-plus-internal')assert.match(sent.body,/2026-10-03.*6:00 PM Local QA class.*instructor: not identified.*no valid instructor sign-in recorded/);
    if(kind==='incorrect-plus-internal')assert.match(sent.body,/Local QA Instructor.*saved sign-in is flagged for review/);
  }
  if(['history-only','missing-plus-internal','incorrect-plus-internal'].includes(kind)){
    assert.equal(capture.readFailures.find(f=>f.code==='HISTORICAL_SCHEDULE_UNAVAILABLE').dates.length,24);
    assert.match(capture.text,/Historical schedule coverage remains unconfirmed for 24 dates/);
    assert.equal(report.coverageConfirmed,false);
  }
  if(kind==='no-reporter'){assert.equal(capture.reportingEvidence.state,'none-observed');assert.equal(report.coverageConfirmed,false);assert.equal(h.claim().state,'no-manager-action');}
  if(kind==='integration-failed')assert.equal(capture.reportingEvidence.state,'unknown');
  if(kind==='later-class')assert.equal(report.issueCount,0);
});

for(const gym of ['rev','richmond'])test(gym+' unavailable monitor holds internal fault; prior known reporter still warns, never repeats, and next day proceeds',async()=>{
  const unknown=worker(gym);assert.equal(unknown.tick().state,'no-manager-action');unknown.tick();
  assert.equal(unknown.sends.length,0);assert.equal(unknown.claim().checkConfirmed,false);assert.equal(unknown.claim().dailyCoverageConfirmed,false);
  const h=worker(gym);h.values.set('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE','2026-10-02');
  h.values.set('M1_ATTENDANCE_EMAIL_FIRST_DAY_2026-10-02',JSON.stringify({date:'2026-10-02',startedAt:NOW-86400000,state:'suppressed',checkConfirmed:true,
    reportingEvidence:{schema:'m1-reporting-evidence/v1',gym,target:'production',state:'observed',deviceCount:1}}));
  h.failSend();assert.equal(h.tick().state,'uncertain');h.tick();h.tick();assert.equal(h.sends.length,1);assert.equal(h.checks.length,1);
  assert.match(h.sends[0].body,/could not confirm uploads/);assert.doesNotMatch(h.sends[0].body,/Please reply.*correction/i);
  h.at(NOW+86400000);assert.equal(h.tick().state,'uncertain');assert.equal(h.sends.length,2);assert.equal(h.checks.length,2);assert.equal(h.claim().missedChecks[0],DATE);
  assert.doesNotMatch(h.sends[1].body,/Earlier daily checks could not be confirmed for/);
});

for(const gym of ['rev','richmond'])test(gym+' prior observed reporter cannot disappear into a later empty store or leak across gyms',async()=>{
  const h=worker(gym);h.values.set('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE','2026-10-02');
  const prior={date:'2026-10-02',startedAt:NOW-86400000,state:'suppressed',checkConfirmed:true,reportingEvidence:{schema:'m1-reporting-evidence/v1',gym,target:'production',state:'observed',deviceCount:1}};
  h.values.set('M1_ATTENDANCE_EMAIL_FIRST_DAY_2026-10-02',JSON.stringify(prior));h.report((await runCase('no-reporter',gym)).report);
  assert.equal(h.tick().state,'submitted');assert.equal(h.sends.length,1);assert.match(h.sends[0].body,/previously reporting tablet/);
  assert.equal(h.claim().currentReportingEvidence.state,'none-observed');assert.equal(h.claim().reportingEvidence.state,'observed');assert.equal(h.claim().coverageConfirmed,false);
  const foreign=worker(gym);foreign.values.set('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE','2026-10-02');
  foreign.values.set('M1_ATTENDANCE_EMAIL_FIRST_DAY_2026-10-02',JSON.stringify({...prior,reportingEvidence:{...prior.reportingEvidence,gym:gym==='rev'?'richmond':'rev'}}));
  assert.equal(foreign.tick().state,'no-manager-action');assert.equal(foreign.sends.length,0);
});

test('report evidence and v2 envelope are bound to own gym/production and count/coverage semantics',async()=>{
  const r=(await runCase('complete-clean')).report,h=worker();
  assert.equal(h.context.gibM1EmailFirstReportValid_(r,{gym:'rev'},DATE),true);
  for(const patch of [{gym:'richmond'},{date:'2026-10-02'},{policy:'unreviewed'},{coverageConfirmed:false},{managerWarningCount:1},{reportingEvidence:{...r.reportingEvidence,gym:'richmond'}},{reportingEvidence:{...r.reportingEvidence,target:'test'}},{reportingEvidence:{...r.reportingEvidence,state:'none-observed',deviceCount:0}}])
    assert.equal(h.context.gibM1EmailFirstReportValid_({...r,...patch},{gym:'rev'},DATE),false);
  const f=input(),config=defaultDigestConfiguration(scope('rev'),{GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true'});
  const d=buildAttendanceDigest({jobDate:DATE,now:NOW,configuration:config,snapshots:[{gym:'rev',attendance:{ok:true,ledger:f.ledger},uploads:{ok:false}}],schedules:[f.schedules]});
  assert.throws(()=>managerAttendanceEmail(d,config,{monitoring:{...r.reportingEvidence,gym:'richmond'}}),/binding/);
});

test('missed checks stay operator evidence, failed claim cannot send, and lost scheduled send is never replayed',async()=>{
  const h=worker();h.values.set('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE','2026-10-02');h.report((await runCase('complete-clean')).report);
  assert.equal(h.tick().state,'no-manager-action');assert.equal(h.sends.length,0);assert.equal(h.claim().coverageConfirmed,true);assert.equal(h.claim().dailyCoverageConfirmed,false);
  assert.deepEqual(Array.from(h.claim().missedChecks),['2026-10-02']);h.tick();assert.equal(h.checks.length,1);
  const failed=worker();failed.report((await runCase('known-pending')).report);failed.failClaim();assert.throws(()=>failed.tick(),/persistence/);assert.equal(failed.sends.length,0);assert.equal(failed.checks.length,0);
});

test('later class absent sign-in is assessed at following ordinary date, with no replay of prior day',async()=>{
  const prior=input();prior.schedules.days.at(-1).occurrences.push({label:'8:00 PM Local QA late class',startAt:'2026-10-04T00:00:00.000Z',endAt:'2026-10-04T01:00:00.000Z',cancelled:false});
  await recordUploadEvidence(prior.uploadStore,manifest(),NOW);assert.equal((await runJob(prior)).dailyEmail.issueCount,0);
  const next=input('rev','2026-10-04',NOW+86400000);next.schedules.days[next.schedules.days.length-2]=prior.schedules.days.at(-1);
  await recordUploadEvidence(next.uploadStore,manifest('2026-10-04'),NOW+86400000);const report=(await runJob(next)).dailyEmail;
  assert.equal(report.issueCount,1);assert.match(report.rendered.text,/2026-10-03.*8:00 PM Local QA late class/);
  const h=worker();h.report((await runCase('later-class')).report);h.tick();assert.equal(h.sends.length,0);h.at(NOW+86400000);h.report(report);h.tick();h.tick();assert.equal(h.sends.length,1);assert.equal(h.checks.length,2);
});
