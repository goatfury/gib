import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { uploadManifest } from '../m1/upload-evidence.mjs';
import { CASES, renderFixture } from './fixtures/m1-email-repair-cases.mjs';
import { recordUploadEvidence, assessUploadEvidence } from '../netlify/functions/_lib/m1-upload-evidence.mjs';
import { buildAttendanceDigest, defaultDigestConfiguration, splitAttendanceDigest } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { datesThrough, localNow } from '../netlify/functions/_lib/m1-manager-review.mjs';
import { emailFirstSettings } from '../tools/package-m1-disabled-release.mjs';
import { handleAttendanceDigestJob } from '../netlify/functions/m1-attendance-digest-job.mjs';
import { makeDigestBinding, digestSignature } from '../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { replyQueue } from '../netlify/functions/_lib/m1-reply-intake.mjs';
import { handleUploadEvidence } from '../netlify/functions/m1-upload-evidence.mjs';
import { createProductionDeviceCredential, PRODUCTION_DEVICE_COOKIE } from '../netlify/functions/_lib/m1-production-runtime.mjs';

const NOW = Date.parse('2026-10-02T00:05:00Z'), DATE = '2026-10-01';
const DEVICE = '00000000-0000-4000-8000-000000000001';
const ROW = 'gib-m1-00000000-0000-4000-8000-000000000002';
const scope = (gym = 'rev') => ({ target: 'production', profile: { installationId: gym, environment: 'production', gymName: gym === 'rev' ? 'Revolution BJJ' : 'Richmond BJJ' }, liveFeatures: { reminders: true } });
const ledger = (date = DATE, gym = 'rev') => ({ ok: true, schema: 'm1-manager-review/v1', target: 'production', complete: true, gym, from: '2026-09-07', to: date,
  days: datesThrough(date).map(date => ({ date, attendanceHash: 'a'.repeat(64), records: [], warnings: [], review: null })) });
const state = (patch = {}) => ({ version: 2, ledger: [{ RowID: ROW, Date: DATE, Status: '', __syncedAt: new Date(NOW).toISOString(), __syncResult: 'added' }], queue: [], ...patch });
test('upload metadata requires the existing authorized tablet and exact published gym; denial never opens storage', async () => {
  const env={GIB_M1_PRODUCTION_SYNC_ENABLED:'true',GIB_M1_PRODUCTION_ORIGIN:'https://gib-live.netlify.app',
    GIB_M1_PRODUCTION_WEBHOOK_URL:'https://script.google.com/macros/s/TEST_RECEIVER_PLACEHOLDER/exec',
    GIB_M1_PRODUCTION_WEBHOOK_TOKEN:'test isolated receiver secret 0123456789',GIB_M1_PRODUCTION_DEVICE_TOKEN:'test isolated device secret 0123456789',
    GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED:'true'};
  const context={site:{name:'gib-live',id:'f748e737-11e3-4fab-8e8c-bf185eab29ff'},deploy:{context:'production',published:true}};
  const uploadStore=store(), credential=createProductionDeviceCredential(env.GIB_M1_PRODUCTION_DEVICE_TOKEN,()=>Buffer.alloc(32,7),NOW);
  const request=(patch={})=>new Request('https://gib-live.netlify.app/api/m1-upload-evidence',{method:'POST',headers:{Host:'gib-live.netlify.app',Origin:'https://gib-live.netlify.app','Sec-Fetch-Site':'same-origin','Content-Type':'application/json',Cookie:PRODUCTION_DEVICE_COOKIE+'='+credential,...patch},body:JSON.stringify(uploadManifest(state(),DEVICE,1,new Date(NOW)))});
  const dependencies={env,context,installationId:'rev',environment:'production',activation:'active',clock:()=>NOW,uploadStore};
  assert.equal((await handleUploadEvidence(request({Cookie:''}),dependencies)).status,401);
  assert.equal((await handleUploadEvidence(request({Origin:'https://gib-richmond-live.netlify.app'}),dependencies)).status,403);
  assert.equal((await handleUploadEvidence(request(),{...dependencies,context:{...context,deploy:{context:'deploy-preview',published:false}}})).status,403);
  assert.equal(uploadStore.entries.size,0);
  assert.equal((await handleUploadEvidence(request(),dependencies)).status,200);
  assert.equal(uploadStore.entries.size,1);
});
function store() {
  const entries = new Map(); let serial = 0;
  return { entries, async list({prefix}) { return { blobs: [...entries].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({key, etag:value.etag})) }; },
    async getWithMetadata(key) { return structuredClone(entries.get(key) || null); },
    async set(key, raw, condition) { const before = entries.get(key); if (condition.onlyIfNew && before || condition.onlyIfMatch && before?.etag !== condition.onlyIfMatch) return {modified:false};
      entries.set(key, {data:JSON.parse(raw),etag:String(++serial)}); return {modified:true}; } };
}
function schedules(date = DATE, gym = 'rev') { return [{ gym, timezone: 'America/New_York', days: datesThrough(date).map(date => ({ date, status:'complete', observedAt:date+'T12:00:00.000Z', sourceVersion:'isolated-date-'+date, occurrences:[] })) }]; }

test('full canonical manifest and every durable row receipt prove normal uploads; saved rows or one partial upload do not', async () => {
  const s = store(), read = ledger(); read.days.at(-1).records.push({recordId:ROW,date:DATE,classLabel:'6:00 PM QA fixture',instructor:'QA fixture',duration:1,reviewRequired:false});
  const manifest = uploadManifest(state(),DEVICE,1,new Date(NOW));
  await recordUploadEvidence(s,manifest,NOW);
  assert.deepEqual(await assessUploadEvidence(scope(),{ok:true,ledger:read},DATE,NOW,{uploadStore:s}), {ok:true,complete:true,deviceCount:1,checkedRows:1,
    monitoring:{schema:'m1-reporting-evidence/v1',gym:'rev',target:'production',state:'observed',deviceCount:1}});
  for (const patch of [{pendingCount:1},{unconfirmedCount:1},{manifestComplete:false},{savedCount:2,manifestComplete:false}]) {
    const partial = store(); await recordUploadEvidence(partial,{...manifest,...patch},NOW);
    assert.equal((await assessUploadEvidence(scope(),{ok:true,ledger:read},DATE,NOW,{uploadStore:partial})).ok,false);
  }
  assert.equal((await assessUploadEvidence(scope(),{ok:true,ledger:read},DATE,NOW,{uploadStore:store()})).ok,false,'saved Sheet rows alone prove nothing about the tablet queue');
});
test('offline/silent tablet, no uploads, unavailable records, omitted saved row and a stale second tablet stay unconfirmed', async () => {
  const manifest=uploadManifest(state(),DEVICE,1,new Date(NOW)), s=store(), read=ledger();
  await recordUploadEvidence(s,manifest,NOW);
  assert.equal((await assessUploadEvidence(scope(),{ok:true,ledger:read},DATE,NOW,{uploadStore:s})).ok,false,'reported full manifest missing in Sheet');
  assert.equal((await assessUploadEvidence(scope(),{ok:false},DATE,NOW,{uploadStore:s})).ok,false);
  read.days.at(-1).records.push({recordId:ROW,date:DATE,classLabel:'6:00 PM QA fixture',instructor:'QA fixture',duration:1,reviewRequired:false});
  assert.equal((await assessUploadEvidence(scope(),{ok:true,ledger:read},DATE,NOW+300001,{uploadStore:s})).ok,false,'offline after a good upload');
  await recordUploadEvidence(s,{...manifest,deviceId:'00000000-0000-4000-8000-000000000003'},NOW-300001);
  assert.equal((await assessUploadEvidence(scope(),{ok:true,ledger:read},DATE,NOW,{uploadStore:s})).ok,false,'one live tablet cannot hide another silent tablet');
});
test('old report cannot overwrite a newer partial queue; recovery confirms original rows without creating attendance', async () => {
  const s=store(), manifest=uploadManifest(state(),DEVICE,2,new Date(NOW));
  await recordUploadEvidence(s,{...manifest,pendingCount:1},NOW);
  await assert.rejects(recordUploadEvidence(s,{...manifest,sequence:1},NOW),/UNAVAILABLE/);
  await recordUploadEvidence(s,{...manifest,sequence:3},NOW);
  assert.equal(s.entries.size,1); assert.equal(s.entries.get('devices/'+DEVICE).data.manifest.pendingCount,0);
  assert.equal(state().queue.length,0); assert.equal(state().ledger.length,1);
});
test('missing attendance and unsuccessful upload check are separate, late classes roll forward, and complete clean checks suppress email', () => {
  const config=defaultDigestConfiguration(scope(),{GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true'}), read=ledger(), dated=schedules();
  const occurrence={label:'6:00 PM QA fixture',startAt:'2026-10-01T22:00:00.000Z',endAt:'2026-10-01T23:00:00.000Z',cancelled:false};
  dated[0].days.at(-1).occurrences.push(occurrence);
  const snapshot={gym:'rev',attendance:{ok:true,ledger:read},uploads:{ok:false}};
  const input={jobDate:DATE,snapshots:[snapshot],schedules:dated,configuration:config,now:NOW};
  let result=buildAttendanceDigest(input); assert.equal(result.itemCount,1); assert.equal(result.readFailures[0].component,'uploads');
  snapshot.attendance={ok:false}; result=buildAttendanceDigest(input); assert.equal(result.itemCount,0); assert.equal(result.readFailures.length,2);
  snapshot.attendance={ok:true,ledger:read}; snapshot.uploads={ok:true,complete:true};
  read.days.at(-1).records.push({recordId:ROW,date:DATE,classLabel:occurrence.label,instructor:'QA fixture',duration:1,reviewRequired:false});
  assert.equal(buildAttendanceDigest(input).shouldCapture,false);
  read.days.at(-1).records=[]; dated[0].days.at(-1).occurrences[0]={...occurrence,label:'8:00 PM QA later class',startAt:'2026-10-02T00:00:00.000Z',endAt:'2026-10-02T01:00:00.000Z'};
  assert.equal(buildAttendanceDigest(input).itemCount,0);
  const next=ledger('2026-10-02'); const nextSchedules=schedules('2026-10-02'); nextSchedules[0].days[nextSchedules[0].days.length-2]=dated[0].days.at(-1);
  assert.equal(buildAttendanceDigest({...input,jobDate:'2026-10-02',now:NOW+86400000,snapshots:[{...snapshot,attendance:{ok:true,ledger:next}}],schedules:nextSchedules}).itemCount,1);
  const rendered=splitAttendanceDigest(buildAttendanceDigest({...input,snapshots:[{...snapshot,uploads:{ok:false}}]}),config)[0].rendered;
  assert.match(rendered.text,/No correction reply is requested/); assert.doesNotMatch(rendered.text,/Please reply.*corrections/i); assert.doesNotMatch(rendered.html+rendered.text,/correction screen|\/m1\/admin\//);
});

function timerHarness(gym='rev') {
  let now=NOW, failSend=false, failCheck=false, failClaim=false;
  const values=new Map(Object.entries({GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true',GIB_M1_ATTENDANCE_EMAIL_FIRST_READY:'v1',GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE:DATE,
    GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED:'true',GIB_M1_MAILAPP_LIVE_SEND_ENABLED:'true',GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW:'true',
    GIB_M1_MAILAPP_LIVE_RECIPIENTS_JSON:JSON.stringify({to:[gym==='rev'?'info@revolutionbjj.com':'info@richmondbjj.com'],cc:[],bcc:['andrew@revolutionbjj.com']})}));
  const sends=[], checks=[]; let report={schema:'m1-daily-email-check/v1',gym,date:DATE,complete:true,shouldSend:false,rendered:null,issueCount:0,unconfirmedChecks:0};
  class ClockDate extends Date { constructor(value) { super(value===undefined?now:value); } static now() { return now; } }
  const context={Date:ClockDate,console:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:key=>values.get(key)??null,setProperty(key,value){if(failClaim&&key.startsWith('M1_ATTENDANCE_EMAIL_FIRST_DAY_'))throw Error('isolated persistence failure');values.set(key,value);}})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    Utilities:{getUuid:()=>DEVICE,formatDate(date,zone,format){const local=localNow(date);return format==='HH:mm'?String(Math.floor(local.minutes/60)).padStart(2,'0')+':'+String(local.minutes%60).padStart(2,'0'):local.date;}},
    gibM1LiveReminderScope_:()=>({gym,target:'production'}),gibM1LiveInstallation_:()=>({gym,target:'production'}),
    Session:{getEffectiveUser:()=>({getEmail:()=> 'revbjjops@gmail.com'})},
    managerHash_:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    configuredReceiverSecret_:()=> 'isolated-transport',configuredAdminActionSecret_:()=> 'isolated-admin',
    gibM1DigestDispatch_(binding){checks.push(binding); if(failCheck)throw Error('isolated unavailable records/site'); return {ok:true,dailyEmail:{...report,date:binding.jobDate}};},
    GIB_M1_DIGEST_SCHEMA_:'m1-attendance-digest-job/v1',
    MailApp:{getRemainingDailyQuota:()=>100,sendEmail(options){const claim=JSON.parse(values.get('M1_ATTENDANCE_EMAIL_FIRST_DAY_'+localNow(new Date(now)).date));assert.equal(claim.state,'call-pending');sends.push(options);if(failSend)throw Error('isolated uncertain Google call');}}};
  vm.createContext(context);
  for(const file of ['GibM1MailApp.gs','GibM1AttendanceEmailFirst.gs'])vm.runInContext(readFileSync(new URL('../integrations/google-apps-script/'+file,import.meta.url),'utf8'),context);
  return {context,values,sends,checks,tick:()=>context.gibM1AttendanceEmailFirstTick_(),at:value=>{now=value;},report:value=>{report={...report,...value};},failSend:()=>{failSend=true;},failCheck:value=>{failCheck=value;},failClaim:()=>{failClaim=true;}};
}
test('scheduled check runs with no browser/tablet/Admin, suppresses clean checks and owns exactly one daily opportunity',()=>{
  const h=timerHarness(); h.at(NOW-6*60000);h.tick();assert.equal(h.checks.length,0);
  h.at(NOW);assert.equal(h.tick().state,'suppressed');h.tick();h.at(NOW+15*60000);h.tick();assert.equal(h.checks.length,1);assert.equal(h.sends.length,0);
});
for(const gym of ['rev','richmond'])test(gym+' known reporting device with unavailable records/website still warns using approved To/BCC/Reply-To; uncertain send is never replayed and next day proceeds',()=>{
  const h=timerHarness(gym);h.values.set('M1_ATTENDANCE_EMAIL_FIRST_DAY_'+DATE,JSON.stringify({date:DATE,startedAt:NOW,state:'suppressed',checkConfirmed:true,
    reportingEvidence:{schema:'m1-reporting-evidence/v1',gym,target:'production',state:'observed',deviceCount:1}}));
  h.at(NOW+86400000);h.failCheck(true);h.failSend();assert.equal(h.tick().state,'uncertain');
  assert.equal(h.sends.length,1);assert.equal(h.sends[0].to,gym==='rev'?'info@revolutionbjj.com':'info@richmondbjj.com');
  assert.equal(h.sends[0].bcc,'andrew@revolutionbjj.com');assert.equal(h.sends[0].replyTo,'andrew@revolutionbjj.com');assert.equal(h.sends[0].cc,undefined);
  assert.doesNotMatch(h.sends[0].body+h.sends[0].htmlBody,/Please reply.*correction/i);
  assert.match(h.sends[0].body,/Could not confirm/);assert.match(h.sends[0].body,/not a count/);h.tick();h.tick();assert.equal(h.sends.length,1);
  h.at(NOW+2*86400000);h.tick();assert.equal(h.checks.length,2);
  if(gym==='rev') {
    assert.equal(h.sends.length,1);
    assert.equal(JSON.parse(h.values.get('M1_ATTENDANCE_EMAIL_FIRST_DAY_2026-10-03')).code,'UNCHANGED_MONITOR_FAULT_ALREADY_WARNED');
  } else {
    assert.equal(h.sends.length,2);assert.match(h.sends[1].body,/Earlier daily checks/);
  }
  if(gym==='rev')assert.equal(JSON.parse(h.values.get('M1_ATTENDANCE_EMAIL_FIRST_DAY_2026-10-03')).missedChecks[0],'2026-10-02');
  else assert.equal(JSON.parse(h.values.get('M1_ATTENDANCE_EMAIL_FIRST_DAY_2026-10-03')).monitorState,undefined);
});
test('missed checks produce one fresh warning, a later complete assessment retires check uncertainty, and prior claims remain',()=>{
  const h=timerHarness();h.at(NOW+86400000);assert.equal(h.tick().state,'submitted');assert.equal(h.sends.length,1);assert.match(h.sends[0].body,/complete.*clean/);assert.doesNotMatch(h.sends[0].body+h.sends[0].htmlBody,/Please reply.*correction/i);
  h.at(NOW+2*86400000);assert.equal(h.tick().state,'suppressed');assert.equal(h.sends.length,1);assert.ok(h.values.has('M1_ATTENDANCE_EMAIL_FIRST_DAY_2026-10-02'));
});
test('failed durable claim cannot send; deployment settings leave corrections, access, recovery and real sending off',()=>{
  const h=timerHarness();h.failClaim();assert.throws(()=>h.tick());assert.equal(h.sends.length,0);assert.equal(h.checks.length,0);
  for(const gym of ['rev','richmond']){const settings=emailFirstSettings(gym);assert.equal(settings.GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED,'true');
    for(const key of ['GIB_M1_MANAGER_REVIEW_LIVE_PILOT','GIB_M1_STAFF_RECOVERY_LIVE_ENABLED','GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED','GIB_M1_MAILAPP_LIVE_SEND_ENABLED'])assert.equal(settings[key],'false');}
});
test('deployed signed email-first job can be verified read-only, without central writes or a second sender',async()=>{
  const env={GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true',GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED:'true',
    GIB_M1_PRODUCTION_WEBHOOK_URL:'https://script.google.com/macros/s/TEST_RECEIVER_PLACEHOLDER/exec',
    GIB_M1_PRODUCTION_WEBHOOK_TOKEN:'isolated-receiver-secret-0123456789',GIB_M1_ADMIN_ACTION_TOKEN:'isolated-admin-secret-0123456789',GIB_M1_ADMIN_PASSPHRASE:'isolated amber forest meadow',
    GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED:'true',GIB_M1_MAILAPP_LIVE_SEND_ENABLED:'true'};
  const digestStore=store(), uploadStore=store(), body=JSON.stringify({...makeDigestBinding(DEVICE,'scheduled',NOW,'production'),gyms:[{gym:'rev',attendance:{ok:true,ledger:ledger()},staff:{ok:true,complete:true,items:[],notApplicable:true}}]});
  const makeRequest=(signature=digestSignature(body,env.GIB_M1_ADMIN_ACTION_TOKEN))=>new Request('https://gib-live.netlify.app/api/m1-attendance-digest-job',{method:'POST',headers:{'Content-Type':'application/json','X-GIB-M1-Digest-Signature':signature,'X-GIB-M1-Digest-Check':'read-only-v1'},body});
  const dependencies={env,installationId:'rev',clock:()=>NOW,context:{site:{name:'gib-live',id:'f748e737-11e3-4fab-8e8c-bf185eab29ff'},deploy:{context:'production',published:true}},
    digestStore,uploadStore,loadSchedules:async()=>schedules()[0],fetch:async()=>{throw Error('No other sender or network allowed in this isolated check');},traceLog(){}};
  const response=await handleAttendanceDigestJob(makeRequest(),dependencies);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.readOnly,true);assert.equal(result.dailyEmail.unconfirmedChecks,1);assert.equal(result.dailyEmail.shouldSend,true,'a first no-report warning still follows the accepted policy');
  assert.equal(result.dailyEmail.coverageConfirmed,false);assert.equal(result.dailyEmail.operatorFaultCount,0);assert.equal(result.dailyEmail.managerWarningCount,1);assert.equal(result.dailyEmail.reportingEvidence.state,'none-observed');
  assert.equal(digestStore.entries.size,0);assert.equal(uploadStore.entries.size,0);
  assert.equal((await handleAttendanceDigestJob(makeRequest('0'.repeat(64)),dependencies)).status,403);assert.equal(digestStore.entries.size,0);
});
test('failed event registration keeps the existing email and durably exposes the old-route fallback', async () => {
  const env = { GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED: 'true', GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED: 'true', GIB_M1_REPLY_INTAKE_ENABLED: 'true',
    GIB_M1_PRODUCTION_WEBHOOK_URL: 'https://script.google.com/macros/s/TEST_RECEIVER_PLACEHOLDER/exec',
    GIB_M1_PRODUCTION_WEBHOOK_TOKEN: 'isolated-receiver-secret-0123456789', GIB_M1_ADMIN_ACTION_TOKEN: 'isolated-admin-secret-0123456789', GIB_M1_ADMIN_PASSPHRASE: 'isolated amber forest meadow',
    GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED: 'true', GIB_M1_MAILAPP_LIVE_SEND_ENABLED: 'true' };
  const replyStore = store(), originalSet = replyStore.set.bind(replyStore);
  replyStore.set = async (key, ...args) => { if (key.includes('/events/')) throw Error('event store failed'); return originalSet(key, ...args); };
  const body = JSON.stringify({ ...makeDigestBinding(DEVICE, 'scheduled', NOW, 'production'), gyms: [{ gym: 'rev', attendance: { ok: true, ledger: ledger() }, staff: { ok: true, complete: true, items: [], notApplicable: true } }] });
  const request = new Request('https://gib-live.netlify.app/api/m1-attendance-digest-job', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GIB-M1-Digest-Signature': digestSignature(body, env.GIB_M1_ADMIN_ACTION_TOKEN) }, body });
  const response = await handleAttendanceDigestJob(request, { env, installationId: 'rev', clock: () => NOW, context: { site: { name: 'gib-live', id: 'f748e737-11e3-4fab-8e8c-bf185eab29ff' }, deploy: { context: 'production', published: true } },
    replyStore, digestStore: store(), uploadStore: store(), loadSchedules: async () => schedules()[0], traceLog() {}, fetch: async () => { throw Error('No real network or send'); } });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.dailyEmail.shouldSend, true); assert.doesNotMatch(result.dailyEmail.rendered.subject, /\[GiB/);
  assert.equal(result.replyRouteFault.code, 'event-registration-unavailable');
  const queue = await replyQueue(replyStore, 'rev', NOW); assert.equal(queue.routing.code, 'route-degraded');
  assert.equal(queue.routing.unresolvedFaults[0].eventId, DEVICE);
});
test('background Sheet reader works with manager screen disabled and preserves originals and review history',()=>{
  const records=[{rowId:ROW,date:DATE,classLabel:'6:00 PM QA fixture',instructor:'QA fixture',duration:1,status:''}], original=structuredClone(records);
  const history={date:DATE,gym:'rev',revision:1,decisions:[{label:'earlier class',outcome:'unknown'}]};
  const context={Date,console:{log(){}},gibM1LiveReminderScope_:()=>({gym:'rev',target:'production'}),adminActionAuthorized_:body=>body.token==='isolated',todayNewYork_:()=>DATE,
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},openExpectedSpreadsheet_:()=>({}),signinsSheet_:()=>({}),readSignins_:()=>({records}),
    managerReviewAction_(){throw Error('Disabled correction screen must not be called');},managerJournal_:()=>({events:[history]}),
    adminSyncAuditRows_:()=>[],adminSyncReceiptRecord_:()=>false,
    validCalendarDate_:value=>/^\d{4}-\d{2}-\d{2}$/.test(value),activeRecord_:row=>row.status!=='VOID',reviewRecordIssue_:()=>false,
    publicRecord_:row=>({recordId:row.rowId,date:row.date,classLabel:row.classLabel,instructor:row.instructor,duration:row.duration,reviewRequired:false}),
    managerAttendanceHash_:rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  vm.createContext(context);vm.runInContext(readFileSync(new URL('../integrations/google-apps-script/GibM1AttendanceEmailFirst.gs',import.meta.url),'utf8'),context);
  const read=context.gibM1AttendanceBackgroundRead_({token:'isolated',target:'production',gym:'rev',from:'2026-09-07',to:DATE});
  assert.equal(read.days.at(-1).records[0].recordId,ROW);assert.equal(read.days.at(-1).review.revision,1);assert.deepEqual(records,original);
  assert.throws(()=>context.gibM1AttendanceBackgroundRead_({token:'wrong',target:'production',gym:'rev',from:'2026-09-07',to:DATE}));
});

for (const gym of ['rev','richmond']) for (const kind of CASES) test(gym+' scheduled worker uses normal rendered '+kind+' email without a real send',()=>{
  const fixture=renderFixture(kind,gym),h=timerHarness(gym);h.at(Date.parse('2026-10-03T00:06:00Z'));
  h.values.set('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE','2026-10-02');
  h.report({shouldSend:fixture.digest.shouldCapture,rendered:fixture.route.rendered,issueCount:fixture.digest.itemCount,unconfirmedChecks:fixture.digest.readFailures.length});
  const result=h.tick();
  if(kind==='clean'){assert.equal(result.state,'suppressed');assert.equal(h.sends.length,0);return;}
  assert.equal(result.state,'submitted');assert.equal(h.sends.length,1);const captured=h.sends[0];
  assert.equal(captured.subject,fixture.route.rendered.subject);assert.equal(captured.body,fixture.route.rendered.text);assert.equal(captured.htmlBody,fixture.route.rendered.html);
  assert.equal(/Please reply[^\n<]*correction/i.test(captured.body+captured.htmlBody),['missing','mixed'].includes(kind));
  assert.equal(captured.replyTo,'andrew@revolutionbjj.com');assert.equal(captured.bcc,'andrew@revolutionbjj.com');assert.equal(captured.cc,undefined);
  h.tick();assert.equal(h.sends.length,1,'the permanent day claim survives the wording change');
});
