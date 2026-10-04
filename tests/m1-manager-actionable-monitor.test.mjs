import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, runCase, worker, DATE, NOW, manifest, ID } from './fixtures/m1-manager-actionable-cases.mjs';
import { managerAttendanceEmail } from '../netlify/functions/_lib/m1-manager-attendance-email.mjs';
import { recordUploadEvidence, assessUploadEvidence } from '../netlify/functions/_lib/m1-upload-evidence.mjs';
const PRIOR={date:DATE,startedAt:1791072321651,state:'submitted',requestId:'64272404-1e40-4514-819e-833f10a93e6d',attemptedAt:1791072329862,hash:'c03e2ead3982db006d1b296d7b1a0cbd1531f181b404a554a5169cc1f131bddd',checkConfirmed:true,completedAt:1791072331780,code:'GOOGLE_ACCEPTED_SEND'};
function seed(h,patch={}) {h.values.set('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE','2026-10-01');h.values.set('M1_ATTENDANCE_EMAIL_FIRST_DAY_'+DATE,JSON.stringify({...PRIOR,...patch}));}
async function day(h,kind,date,extra={}) {h.at(NOW+(Date.parse(date)-Date.parse(DATE)));const {report,capture}=await runCase(kind,'rev',date,NOW+(Date.parse(date)-Date.parse(DATE)));h.report({...report,...extra});return {result:h.tick(),report,capture};}

test('verified actual October3 no-report warning suppresses later unchanged fault, not the daily check',async()=>{
 const h=worker('rev','2026-10-04',NOW+86400000);seed(h);const {result,report,capture}=await day(h,'no-reporter','2026-10-04');
 assert.equal(report.shouldSend,true,'first warning remains the server policy');assert.equal(result.state,'no-manager-action');h.tick();
 assert.equal(h.sends.length,0);assert.equal(h.checks.length,1);assert.equal(h.claim().code,'UNCHANGED_MONITOR_FAULT_ALREADY_WARNED');
 assert.equal(h.claim().coverageConfirmed,false);assert.equal(h.claim().monitorState.active[0].lastWarning.payloadHash,PRIOR.hash);
 assert.equal(h.claim().monitorState.active[0].lastWarning.requestId,PRIOR.requestId);assert.equal(capture.readFailures[0].component,'uploads');
 const before=h.claim();await day(h,'no-reporter','2026-10-05');assert.equal(h.sends.length,0);assert.equal(h.checks.length,2);
 assert.equal(h.claim().monitorState.active[0].lastWarning.date,DATE);assert.equal(before.monitorState.active[0].signature,h.claim().monitorState.active[0].signature);
});

test('a first no-report or failed integration warning is not globally disabled',async()=>{
 for(const kind of ['no-reporter','integration-failed']){const h=worker();await day(h,kind,DATE);assert.equal(h.sends.length,1);assert.equal(h.claim().state,'submitted');assert.equal(h.claim().coverageConfirmed,false);}
 const h=worker();h.tick();assert.equal(h.sends.length,1);assert.equal(h.claim().checkConfirmed,false);
 h.at(NOW+86400000);h.tick();assert.equal(h.sends.length,1);assert.equal(h.checks.length,2);assert.equal(h.claim().code,'UNCHANGED_MONITOR_FAULT_ALREADY_WARNED');
});

test('date/time/age-only and retained historical noise cannot reclassify the same fault',async()=>{
 const h=worker('rev','2026-10-04',NOW+86400000);seed(h);const a=(await runCase('no-reporter','rev','2026-10-04',NOW+86400000)).report;
 const b=(await runCase('no-reporter','rev','2026-10-05',NOW+2*86400000)).report;assert.deepEqual(a.monitorFaults,b.monitorFaults);
 h.report({...a,operatorFaultCount:a.operatorFaultCount+1,unconfirmedChecks:a.unconfirmedChecks+1});h.tick();assert.equal(h.sends.length,0);
 const history=await runCase('history-only');assert.equal(history.report.shouldSend,false);assert.equal(history.capture.readFailures[0].dates.length,24);assert.equal(history.report.coverageConfirmed,false);
 const s1=await runCase('known-stale','rev','2026-10-04',NOW+86400000),s2=await runCase('known-stale','rev','2026-10-05',NOW+2*86400000);assert.deepEqual(s1.report.monitorFaults,s2.report.monitorFaults);
});

for(const kind of ['missing-plus-internal','incorrect-plus-internal','known-pending','known-stale','known-read-failed','integration-failed'])test('known no-report fault does not hide new/actual '+kind,async()=>{
 const h=worker('rev','2026-10-04',NOW+86400000);seed(h);const {report,capture}=await day(h,kind,'2026-10-04');assert.equal(h.sends.length,1);h.tick();assert.equal(h.sends.length,1);
 assert.equal(h.sends[0].body,report.rendered.text);assert.equal(h.sends[0].htmlBody,report.rendered.html);assert.equal(h.sends[0].to,'info@revolutionbjj.com');assert.equal(h.sends[0].bcc,'andrew@revolutionbjj.com');assert.equal(h.sends[0].replyTo,'andrew@revolutionbjj.com');assert.equal(h.sends[0].cc,undefined);
 assert.doesNotMatch(h.sends[0].body+h.sends[0].htmlBody,/2026-09-07|2026-09-30|Historical schedule coverage/);
 assert.equal(/Please reply[^\n<]*correction/i.test(h.sends[0].body),kind.includes('plus-internal'));
 if(kind.includes('plus-internal'))assert.equal(capture.readFailures.find(f=>f.code==='HISTORICAL_SCHEDULE_UNAVAILABLE').dates.length,24);
});

test('pending rows always remain actionable when row identity change cannot be proven',async()=>{
 const h=worker();await day(h,'known-pending',DATE);await day(h,'known-pending','2026-10-04');assert.equal(h.sends.length,2);assert.equal(h.claim().monitorState.active.length,0);
});

test('healthy recovery clears active fault lineage without unsolicited clean email; recurrence alerts',async()=>{
 const h=worker('rev','2026-10-04',NOW+86400000);seed(h);h.values.set('GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE',DATE);await day(h,'complete-clean','2026-10-04');assert.equal(h.sends.length,0);assert.equal(h.claim().coverageConfirmed,true);assert.equal(h.claim().state,'suppressed');assert.equal(h.claim().monitorState.active.length,0);assert.equal(h.claim().monitorState.noLongerObserved.length,1);
 await day(h,'no-reporter','2026-10-05');assert.equal(h.sends.length,1);assert.equal(h.claim().coverageConfirmed,false);
});

test('uncertain prior send is not repeated; next day still assesses and a new real problem alerts',async()=>{
 const h=worker();h.failSend();await day(h,'no-reporter',DATE);h.tick();assert.equal(h.claim().state,'uncertain');assert.equal(h.sends.length,1);
 await day(h,'no-reporter','2026-10-04');assert.equal(h.sends.length,1);assert.equal(h.checks.length,2);assert.equal(h.claim().coverageConfirmed,false);
 await day(h,'missing-plus-internal','2026-10-05');assert.equal(h.sends.length,2);assert.equal(h.checks.length,3);assert.equal(h.claim().state,'uncertain');
});

test('seed cannot be invented from capture hash, different request, uncertain outcome or wrong day claim',async()=>{
 for(const patch of [{hash:'87fdc8adf173496a5acfd2d27b92006a2a48130fdd849a669e772fbbd1767d9f'},{requestId:'00000000-0000-4000-8000-000000000001'},{state:'uncertain'},{code:'SEND_OUTCOME_UNCERTAIN'}]){
  const h=worker('rev','2026-10-04',NOW+86400000);seed(h,patch);await day(h,'no-reporter','2026-10-04');assert.equal(h.sends.length,1);
 }
});

test('lineage is bound to original permanent own-gym day claim and fails closed on tampering',async()=>{
 const h=worker();await day(h,'no-reporter',DATE);const current=h.claim();current.monitorState.target='test';h.values.set('M1_ATTENDANCE_EMAIL_FIRST_DAY_'+DATE,JSON.stringify(current));h.at(NOW+86400000);assert.throws(()=>h.tick(),/LINEAGE/);assert.equal(h.sends.length,1);
 const f=worker();f.report((await runCase('known-pending')).report);f.failClaim();assert.throws(()=>f.tick(),/persistence/);assert.equal(f.sends.length,0);assert.equal(f.checks.length,0);
});

for(const kind of CASES)test('Richmond retains released v1 decision/render: '+kind,async()=>{
 const {report}=await runCase(kind,'richmond'),h=worker('richmond');assert.equal(report.schema,'m1-daily-email-check/v1');assert.equal(report.shouldSend,!['complete-clean','later-class'].includes(kind));h.report(report);h.tick();h.tick();assert.equal(h.sends.length,report.shouldSend?1:0);assert.equal(h.claim().monitorState,undefined);
});

test('new report/lineage policy cannot cross gym, target, date or semantics',async()=>{
 const report=(await runCase('no-reporter')).report,h=worker();assert.equal(h.context.gibM1EmailFirstReportValid_(report,{gym:'rev'},DATE),true);
 for(const patch of [{gym:'richmond'},{date:'2026-10-02'},{policy:'manager-actionable/v1'},{coverageConfirmed:true},{monitorFaults:[]},{reportingEvidence:{...report.reportingEvidence,target:'test'}}])assert.equal(h.context.gibM1EmailFirstReportValid_({...report,...patch},{gym:'rev'},DATE),false);
 assert.equal(h.context.gibM1EmailFirstReportValid_(report,{gym:'richmond'},DATE),false);
});

test('later class is not a missing sign-in until following ordinary assessment',async()=>{
 const h=worker(),late=await day(h,'later-class',DATE);assert.equal(h.sends.length,0);assert.equal(h.claim().state,'suppressed');
 const prior=await runCase('later-class');
 const {report}=await runCase('complete-clean','rev','2026-10-04',NOW+86400000,f=>{f.schedules.days[f.schedules.days.length-2]=prior.fixture.schedules.days.at(-1);});
 assert.equal(report.issueCount,1);assert.match(report.rendered.text,/2026-10-03.*8:00 PM Local QA late class/);
 h.at(NOW+86400000);h.report(report);h.tick();h.tick();assert.equal(h.sends.length,1);assert.equal(h.checks.length,2);
});

test('exact no-report plus 24 retained history gaps suppresses next warning and preserves raw dates',async()=>{
 const h=worker('rev','2026-10-04',NOW+86400000);seed(h);
 const {report,capture}=await runCase('no-reporter','rev','2026-10-04',NOW+86400000,f=>{f.schedules.days=f.schedules.days.map(d=>d.date<'2026-10-01'?{date:d.date,status:'unavailable',code:'MISSING_DATED_SCHEDULE'}:d);});
 assert.equal(report.issueCount,0);assert.equal(report.managerWarningCount,1);assert.equal(report.operatorFaultCount,1);
 assert.doesNotMatch(report.rendered.text+report.rendered.html,/2026-09-07|2026-09-30|Historical schedule coverage/);
 const dates=capture.readFailures.find(f=>f.code==='HISTORICAL_SCHEDULE_UNAVAILABLE').dates;
 assert.equal(dates.length,24);assert.equal(dates[0],'2026-09-07');assert.equal(dates.at(-1),'2026-09-30');
 h.report(report);h.tick();assert.equal(h.sends.length,0);assert.equal(h.claim().coverageConfirmed,false);assert.equal(h.claim().operatorFaultCount,1);
 assert.equal(h.claim().monitorState.active[0].lastWarning.payloadHash,PRIOR.hash);
});

test('known stale reporter age is repeat noise; a different reporter set is a meaningful change',async()=>{
 const h=worker();await day(h,'known-stale',DATE);await day(h,'known-stale','2026-10-04');assert.equal(h.sends.length,1);assert.equal(h.checks.length,2);
 const date='2026-10-05',now=NOW+2*86400000;
 const {report}=await runCase('known-stale','rev',date,now,async f=>{await recordUploadEvidence(f.uploadStore,manifest(date,{deviceId:ID.slice(0,-1)+'5'}),now-300001);});
 h.at(now);h.report(report);h.tick();assert.equal(h.sends.length,2);assert.equal(h.claim().coverageConfirmed,false);
});

for(const patch of [{pendingCount:1},{unconfirmedCount:1},{manifestComplete:false}])test('a stale reporter cannot conceal newly changed upload evidence '+JSON.stringify(patch),async()=>{
 const h=worker();await day(h,'known-stale',DATE);
 const date='2026-10-04',now=NOW+86400000;
 const {report}=await runCase('known-stale','rev',date,now,async f=>{await recordUploadEvidence(f.uploadStore,manifest(date,{sequence:2,...patch}),now-300001);});
 h.at(now);h.report(report);h.tick();assert.equal(h.sends.length,2,'new pending/incomplete upload evidence must not be suppressed as an unchanged stale fault');
 assert.equal(h.claim().coverageConfirmed,false);assert.equal(report.monitorFaults[0].repeatable,false);
});

test('an earlier stale device cannot hide a later device with newly pending uploads',async()=>{
 const h=worker(),addSecond=async(f,patch={})=>recordUploadEvidence(f.uploadStore,manifest(f.date,{deviceId:ID.slice(0,-1)+'5',...patch}),f.now);
 const first=await runCase('known-stale','rev',DATE,NOW,f=>addSecond(f));h.report(first.report);h.tick();assert.equal(h.sends.length,1);
 const date='2026-10-04',now=NOW+86400000;
 const next=await runCase('known-stale','rev',date,now,f=>addSecond(f,{pendingCount:1}));h.at(now);h.report(next.report);h.tick();
 assert.equal(h.sends.length,2);assert.equal(next.report.monitorFaults[0].reason,'TABLET_UPLOADS_PENDING');assert.equal(next.report.monitorFaults[0].repeatable,false);
});

test('known pending report remains visible when a sibling report or attendance read is unavailable',async()=>{
 const {fixture}=await runCase('known-stale');
 await recordUploadEvidence(fixture.uploadStore,manifest(DATE,{deviceId:ID.slice(0,-1)+'5',pendingCount:1}),NOW);
 const get=fixture.uploadStore.getWithMetadata;
 fixture.uploadStore.getWithMetadata=async key=>{if(key==='devices/'+ID)throw Error('Fake sibling read unavailable');return get(key);};
 const result=await assessUploadEvidence({target:'production',profile:{installationId:'rev'}},{ok:false},DATE,NOW,{uploadStore:fixture.uploadStore});
 assert.equal(result.ok,false);assert.equal(result.reason,'TABLET_UPLOADS_PENDING');
});

test('an unconfirmed authoritative row receipt is not concealed by a stale otherwise clean report',async()=>{
 const h=worker();await day(h,'known-stale',DATE);
 const date='2026-10-04',now=NOW+86400000;
 const {report}=await runCase('known-stale','rev',date,now,f=>recordUploadEvidence(f.uploadStore,manifest(date,{sequence:2,rowIds:['gib-m1-'+ID],savedCount:1}),now-300001));
 assert.equal(report.monitorFaults[0].reason,'SPREADSHEET_RECEIPTS_UNCONFIRMED');assert.equal(report.monitorFaults[0].repeatable,false);
 h.at(now);h.report(report);h.tick();assert.equal(h.sends.length,2);assert.equal(h.claim().coverageConfirmed,false);
});
