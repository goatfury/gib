import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {applyAcknowledgements} from '../../m1/sync-core.mjs';
import {uploadManifest} from '../../m1/upload-evidence.mjs';
import {buildAttendanceDigest, defaultDigestConfiguration, splitAttendanceDigest} from '../../netlify/functions/_lib/m1-attendance-digest.mjs';
import {pathToFileURL} from 'node:url';
import {localNow} from '../../netlify/functions/_lib/m1-manager-review.mjs';
const contractRoot=process.env.M1_UPLOAD_CONTRACT_BASELINE_ROOT
  ?pathToFileURL(process.env.M1_UPLOAD_CONTRACT_BASELINE_ROOT.replaceAll('\\','/')+'/')
  :new URL('../../',import.meta.url);
const {recordUploadEvidence,assessUploadEvidence}=await import(new URL('netlify/functions/_lib/m1-upload-evidence.mjs',contractRoot));

export const RECONCILIATION_NOW = Date.parse('2026-10-03T00:05:00.000Z');
export const RECONCILIATION_DATE = '2026-10-02';
export const RECONCILIATION_DEVICE = '00000000-0000-4000-8000-000000000001';

export function localUploadStore() {
  const entries = new Map(); let serial = 0;
  return {entries, async list({prefix}) { return {blobs:[...entries.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))}; },
    async getWithMetadata(key) {return structuredClone(entries.get(key)||null);},
    async set(key, raw, condition) {
      const before=entries.get(key);
      if (condition.onlyIfNew && before || condition.onlyIfMatch && before?.etag!==condition.onlyIfMatch) return {modified:false};
      entries.set(key,{data:JSON.parse(raw),etag:String(++serial)});return {modified:true};
    }};
}

export function backgroundReader(context, request, gym) {
  for (const file of ['GibM1LiveFeatures.gs','GibM1ManagerReview.gs','GibM1AttendanceEmailFirst.gs']) {
    vm.runInContext(readFileSync(new URL('integrations/google-apps-script/'+file,contractRoot),'utf8'),context);
  }
  return () => JSON.parse(JSON.stringify(context.gibM1AttendanceBackgroundRead_({
    ...request('attendanceBackgroundRead'),gym,from:'2026-09-07',to:RECONCILIATION_DATE
  })));
}

export async function assertReconciledUpload({context, request, post, gym, row, signins, audit}) {
  const scope={target:'production',profile:{installationId:gym,environment:'production',gymName:gym==='rev'?'Revolution BJJ':'Richmond BJJ'},liveFeatures:{reminders:true}};
  const addition=post(request('addMissedInstructor',{requestId:'isolated-upload-'+gym,adminName:'Andrew Smith',
    date:row.Date,classLabel:row['Class Label'],duration:row['Duration (hr)'],instructor:row.Instructor,
    site:row.Site,notes:row.Notes,reason:'Not Synced'}));
  assert.equal(addition.result,'added');
  audit=typeof audit==='function'?audit():audit;
  const original={version:2,ledger:[{...row,Status:''}],queue:[{...row}]};
  const initial=structuredClone(original),ack=post(request('kioskSignIn',{rows:[row]}));
  assert.deepEqual(ack.results,[{rowId:row.RowID,result:'already exists',linkedRecordId:addition.linkedRecordId}]);
  const applied=applyAcknowledgements(original,[row],{ok:true,production:true,results:ack.results},
    new Date(RECONCILIATION_NOW).toISOString(),{productionOrigin:true});
  assert.equal(applied.state.queue.length,0);
  assert.equal(applied.state.ledger[0].RowID,row.RowID);
  assert.equal(applied.state.ledger[0].__syncResult,'already exists');
  assert.deepEqual(original,initial,'ack application preserves the original durable state');
  const before=structuredClone(signins.values),auditBefore=structuredClone(audit.values);
  assert.deepEqual(post(request('kioskSignIn',{rows:[row]})).results,ack.results);
  assert.deepEqual(signins.values,before,'a retry creates no payable duplicate or extra receipt');
  assert.deepEqual(audit.values,auditBefore);
  assert.equal(signins.values.at(-1)[10],'VOID');

  const read=backgroundReader(context,request,gym),ledger=read(),day=ledger.days.at(-1);
  assert.equal(day.records.length,1,'the VOID receipt is never active attendance');
  assert.equal(day.records[0].recordId,addition.linkedRecordId);
  const manifest=uploadManifest(applied.state,RECONCILIATION_DEVICE,1,new Date(RECONCILIATION_NOW)),store=localUploadStore();
  assert.deepEqual(manifest.rowIds,[row.RowID],'the tablet retains its permanent original ID');
  await recordUploadEvidence(store,manifest,RECONCILIATION_NOW);
  const assess=central=>assessUploadEvidence(scope,{ok:true,ledger:central},RECONCILIATION_DATE,RECONCILIATION_NOW,{uploadStore:store});
  assert.deepEqual(await assess(ledger),{ok:true,complete:true,deviceCount:1,checkedRows:1},
    'an audited safe reconciliation confirms arrival of the original tablet record without making VOID payable');
  assert.deepEqual(signins.values,before,'background confirmation changes no original or audit record');
  assert.deepEqual(audit.values,auditBefore);
  assert.equal(ledger.uploadReceipts.length,1);
  const configuration=defaultDigestConfiguration(scope,{GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true'});
  const scheduled=[{gym,timezone:'America/New_York',days:ledger.days.map(value=>({date:value.date,status:'complete',
    observedAt:value.date+'T12:00:00.000Z',sourceVersion:'isolated-explicit-date',
    occurrences:value.date===RECONCILIATION_DATE?[{label:row['Class Label'],
      startAt:row['Class Label'].startsWith('9:00')?'2026-10-02T13:00:00.000Z':'2026-10-02T10:00:00.000Z',
      endAt:row['Class Label'].startsWith('9:00')?'2026-10-02T14:00:00.000Z':'2026-10-02T11:00:00.000Z',
      cancelled:false}]:[]}))}];
  const input={scope,configuration,jobDate:RECONCILIATION_DATE,now:RECONCILIATION_NOW,schedules:scheduled,
    snapshots:[{gym,attendance:{ok:true,ledger},uploads:await assess(ledger)}]};
  const cleanDigest=buildAttendanceDigest(input);
  assert.equal(cleanDigest.shouldCapture,false,'complete clean reconciliation preserves no-email behavior');
  // Continue the same receipt/manifest/read chain through the normal Google
  // daily worker. Only its external website response is a local fake carrying
  // the real assessor/renderer result; no browser, tablet or real MailApp runs.
  const timerProperties=context.PropertiesService.getScriptProperties();
  for (const [key,value] of Object.entries({GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true',
    GIB_M1_ATTENDANCE_EMAIL_FIRST_READY:'v1',GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE:RECONCILIATION_DATE,
    GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED:'true',GIB_M1_MAILAPP_LIVE_SEND_ENABLED:'true'})) timerProperties.setProperty(key,value);
  context.Session={getEffectiveUser:()=>({getEmail:()=> 'revbjjops@gmail.com'})};
  context.MailApp={getRemainingDailyQuota:()=>100,sendEmail(){assert.fail('complete reconciled attendance must not send');}};
  context.Utilities.getUuid=()=>RECONCILIATION_DEVICE;
  const originalFormatDate=context.Utilities.formatDate;
  context.Utilities.formatDate=(date,zone,format)=>{
    const clock=localNow(date);
    return format==='HH:mm'?String(Math.floor(clock.minutes/60)).padStart(2,'0')+':'+String(clock.minutes%60).padStart(2,'0')
      :originalFormatDate(date,zone,format);
  };
  vm.runInContext(readFileSync(new URL('integrations/google-apps-script/GibM1MailApp.gs',contractRoot),'utf8'),context);
  let dailyChecks=0;context.GIB_M1_DIGEST_SCHEMA_='m1-attendance-digest-job/v1';
  context.gibM1DigestDispatch_=binding=>{dailyChecks++;assert.equal(binding.jobDate,RECONCILIATION_DATE);
    return {ok:true,dailyEmail:{schema:'m1-daily-email-check/v1',gym,date:RECONCILIATION_DATE,complete:true,
      shouldSend:cleanDigest.shouldCapture,rendered:splitAttendanceDigest(cleanDigest,configuration)[0].rendered,
      issueCount:cleanDigest.itemCount,unconfirmedChecks:cleanDigest.readFailures.length}};};
  assert.equal(context.gibM1AttendanceEmailFirstTick_()?.state,'suppressed');
  context.gibM1AttendanceEmailFirstTick_();assert.equal(dailyChecks,1,'the completed daily claim prevents another check');
  const claim=JSON.parse(timerProperties.getProperty('M1_ATTENDANCE_EMAIL_FIRST_DAY_'+RECONCILIATION_DATE));
  assert.equal(claim.code,'COMPLETE_CLEAN_CHECK');
  assert.deepEqual(signins.values,before);assert.deepEqual(audit.values,auditBefore);

  for (const [patch,age,reason] of [
    [{pendingCount:1},0,'TABLET_UPLOADS_PENDING'],[{unconfirmedCount:1},0,'TABLET_UPLOADS_PENDING'],
    [{manifestComplete:false},0,'TABLET_MANIFEST_INCOMPLETE'],[{},300001,'TABLET_REPORT_STALE']
  ]) {
    const adverseStore=localUploadStore();await recordUploadEvidence(adverseStore,{...manifest,...patch},RECONCILIATION_NOW-age);
    const uploads=await assessUploadEvidence(scope,{ok:true,ledger},RECONCILIATION_DATE,RECONCILIATION_NOW,{uploadStore:adverseStore});
    assert.equal(uploads.reason,reason,'reconciliation never overrides freshness, queue or completeness gates');
    const digest=buildAttendanceDigest({...input,snapshots:[{gym,attendance:{ok:true,ledger},uploads}]});
    assert.equal(digest.itemCount,0);assert.equal(digest.shouldCapture,true);
    const rendered=splitAttendanceDigest(digest,configuration)[0].rendered;
    assert.match(rendered.text,gym==='richmond'?/The check for .* couldn.t confirm sign-in uploads\./:/haven.t identified a specific missing sign-in, so no correction reply is needed/);
    assert.doesNotMatch(rendered.text,/Please reply[^\n]*correction/);
  }

  // Local adversarial sheet fixtures only: an ordinary VOID row or a marker without
  // the unique same-gym active replacement, audit and chronology cannot prove arrival.
  const mutations=[
    ()=>{audit.values[1][8]='Unrelated reason';},
    ()=>{audit.values.push([...audit.values[1]]);},
    ()=>{signins.values[1][10]='VOID';},
    ()=>{signins.values.push([...signins.values[1]]);},
    ()=>{signins.values.push([...signins.values[2]]);},
    ()=>{signins.values[2][7]='Ordinary tablet';},
    ()=>{signins.values[2][6]=gym==='rev'?'Richmond':'Rev';},
    ()=>{signins.values[2][1]='2026-10-02 23:00:00';},
    ()=>{signins.values[2][9]='Different original notes';},
    ()=>{signins.values[1][5]='Different instructor';}
  ];
  for (const mutate of mutations) {
    signins.values.splice(0,signins.values.length,...structuredClone(before));
    audit.values.splice(0,audit.values.length,...structuredClone(auditBefore));
    mutate();
    const central=read();
    assert.equal(central.uploadReceipts.length,0,'invalid/ambiguous reconciliation is not emitted');
    assert.equal((await assess(central)).ok,false,'invalid reconciliation stays honestly unconfirmed');
  }
  signins.values.splice(0,signins.values.length,...structuredClone(before));
  audit.values.splice(0,audit.values.length,...structuredClone(auditBefore));
  for (const corrupt of [
    value=>{value.uploadReceipts[0].gym=gym==='rev'?'richmond':'rev';},
    value=>{value.uploadReceipts[0].target='test';},
    value=>{value.uploadReceipts[0].date='2026-10-01';},
    value=>{value.uploadReceipts.push({...value.uploadReceipts[0]});},
    value=>{value.uploadReceipts[0].linkedRecordId='gib-admin-unrelated';},
    value=>{value.days.at(-1).records=[];}
  ]) {
    const central=structuredClone(ledger);corrupt(central);
    assert.equal((await assess(central)).ok,false,'mismatched authority cannot confirm a manifest');
  }
  const legacy=structuredClone(ledger);delete legacy.uploadReceipts;
  assert.equal((await assess(legacy)).ok,false,'old readers remain fail-closed for this case');
  assert.deepEqual(signins.values,before);assert.deepEqual(audit.values,auditBefore);
}
