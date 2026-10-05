import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAttendanceDigest,splitAttendanceDigest} from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import {assessUploadEvidence,recordUploadEvidence} from '../netlify/functions/_lib/m1-upload-evidence.mjs';
import {uploadManifest,startUploadEvidence} from '../m1/upload-evidence.mjs';
import {DATE,NOW,CASES,fixture,renderFixture,scope} from './fixtures/m1-email-repair-cases.mjs';
const owner=JSON.parse(readFileSync(new URL('./fixtures/m1-october2-owner-email.json',import.meta.url),'utf8'));
const asks=rendered=>/Please reply[^\n<]*correction/i.test(rendered.text+rendered.html);
for(const gym of ['rev','richmond'])for(const kind of CASES)test(gym+' normal rendering: '+kind,()=>{
 const input=fixture(kind,gym),before=structuredClone(input),digest=buildAttendanceDigest(input),route=splitAttendanceDigest(digest,input.configuration)[0];
 assert.deepEqual(input,before,'rendering must not edit attendance, history or schedules');
 assert.deepEqual(route.to,[gym==='rev'?'info@revolutionbjj.com':'info@richmondbjj.com']);assert.deepEqual(route.cc,[]);assert.deepEqual(route.bcc,['andrew@revolutionbjj.com']);
 if(kind==='clean'){assert.equal(route.routeStatus,'suppressed');assert.equal(route.rendered,null);assert.equal(digest.shouldCapture,false);return;}
 const rendered=route.rendered;assert.ok(rendered?.subject);assert.match(rendered.html,/<h1[^>]*>[^<]+<\/h1>/);assert.doesNotMatch(rendered.text+rendered.html,/Open authenticated correction screen|\/m1\/admin\//);
 assert.equal(asks(rendered),['missing','mixed'].includes(kind));
 if(asks(rendered)) {assert.match(rendered.text,/corrections only for the specific attendance problems listed below/);assert.match(rendered.text,/2026-10-02 — 6:00 PM Isolated QA class — instructor: not identified; no valid instructor sign-in recorded in the spreadsheet/);assert.match(rendered.text,/reply goes to Andrew/);assert.match(rendered.text,/original records and correction history/);}
 else{assert.match(rendered.subject,/attendance check unconfirmed/);assert.match(rendered.html,/>Attendance check could not be confirmed<\/h1>/);assert.match(rendered.text,/No correction reply is requested/);assert.doesNotMatch(rendered.html,/Attendance that needs attention<\/h1>/);assert.equal(digest.itemCount,0);}
 if(['upload','mixed'].includes(kind))assert.match(rendered.text,/Could not confirm that every saved instructor sign-in reached the spreadsheet/);
 if(kind==='upload')assert.match(rendered.text,/No tablet upload report has been received/);
 if(kind==='failed')assert.match(rendered.text,/Instructor attendance could not be checked. This is not a missing-instructor count/);
 if(kind==='stale'){assert.match(rendered.text,/24 dates \(2026-09-07 through 2026-09-30\), before daily monitoring began/);assert.match(rendered.text,/retained setup\/history gap, not a new attendance problem/);assert.equal(digest.readFailures[0].code,'HISTORICAL_SCHEDULE_UNAVAILABLE');}
 if(kind==='mixed'){assert.match(rendered.text,/separate unconfirmed checks do not establish additional missing sign-ins/);assert.match(rendered.text,/pending uploads/);assert.match(rendered.text,/incomplete check, not evidence of missing sign-ins/);}
});
test('exact owner-supplied October 2 email regression retains both uncertainties without requesting corrections',()=>{
 assert.equal(owner.concrete_attendance_corrections_listed,0);assert.equal(owner.provenance.managerFeedbackConveyedBy,'Andrew');assert.match(owner.stu_reply,/not any corrections needed/);
 const {input,digest}=renderFixture('clean');digest.readFailures=owner.findings.map((message,i)=>({gym:'rev',component:i?'schedule':'uploads',code:i?'SCHEDULE_COVERAGE_UNAVAILABLE':'UPLOAD_COMPLETENESS_UNCONFIRMED',message,url:'https://gib-live.netlify.app/m1/admin/?reviewDate='+DATE+'#sign-ins'}));
 digest.shouldCapture=true;
 const rendered=splitAttendanceDigest(digest,input.configuration)[0].rendered;
 for(const message of owner.findings){assert.ok(rendered.text.includes(message));assert.ok(rendered.html.includes(message));}
 assert.equal(asks(rendered),false);assert.ok(!rendered.text.includes(owner.correction_request));assert.match(rendered.subject,/unconfirmed/);assert.match(rendered.text,/Late uploads and corrections are checked again/);
});
test('retained old real attendance problems survive even when historical schedules are unavailable',()=>{
 const input=fixture('stale'),day=input.snapshots[0].attendance.ledger.days[0];day.records.push({recordId:'isolated-QA-original',date:day.date,classLabel:'6:00 PM Isolated QA historical class',instructor:'Isolated QA Instructor',duration:1,reviewRequired:true});
 const digest=buildAttendanceDigest(input),rendered=splitAttendanceDigest(digest,input.configuration)[0].rendered;
 assert.equal(digest.itemCount,1);assert.equal(asks(rendered),true);assert.match(rendered.text,/2026-09-07 — 6:00 PM Isolated QA historical class — instructor: Isolated QA Instructor; the saved sign-in is flagged for review/);assert.match(rendered.text,/Historical schedule coverage remains unconfirmed/);
});
test('a generic unreadable record or old unknown class decision is retained uncertainty, not a concrete correction',()=>{
 const input=fixture('stale'),day=input.snapshots[0].attendance.ledger.days[0];day.warnings.push({code:'UNREADABLE_RECORD',message:'An older attendance row could not be read.'});
 day.review={revision:1,action:'partial',decisions:[{label:'6:00 PM Isolated QA historical class',outcome:'unknown'}],snapshot:{base:null},attendanceHash:'a'.repeat(64),scheduleHash:'b'.repeat(64),time:'2026-09-08T12:00:00.000Z'};
 const digest=buildAttendanceDigest(input),rendered=splitAttendanceDigest(digest,input.configuration)[0].rendered;
 assert.equal(digest.itemCount,0);assert.equal(asks(rendered),false);assert.match(rendered.text,/older attendance row could not be read/);assert.match(rendered.text,/class status is still/);assert.match(rendered.text,/No missing sign-in was established/);
});
function store(){const entries=new Map();let serial=0;return{entries,async list(){return{blobs:[...entries.keys()].map(key=>({key}))};},async getWithMetadata(key){return structuredClone(entries.get(key)||null);},async set(key,raw){entries.set(key,{data:JSON.parse(raw),etag:String(++serial)});return{modified:true};}};}
test('upload investigation reasons distinguish never-received, stale, incomplete, pending, unavailable and row receipt failures',async()=>{
 const input=fixture('clean'),attendance=input.snapshots[0].attendance,s=store(),device='00000000-0000-4000-8000-000000000001',row='gib-m1-00000000-0000-4000-8000-000000000002';
 const state={version:2,ledger:[{RowID:row,Date:DATE,Status:'',__syncedAt:new Date(NOW).toISOString(),__syncResult:'added'}],queue:[]},manifest=uploadManifest(state,device,1,new Date(NOW));
 const receivedAttendance=structuredClone(attendance);
 receivedAttendance.ledger.days.at(-1).records.push({recordId:row,date:DATE,classLabel:'6:00 PM Isolated QA class',instructor:'Isolated QA Instructor',duration:1,reviewRequired:false});
 assert.equal((await assessUploadEvidence(scope(),attendance,DATE,NOW,{uploadStore:s})).reason,'TABLET_REPORT_NOT_RECEIVED');
 let sequence=0;
 for(const[patch,age,reason]of [[{},300001,'TABLET_REPORT_STALE'],[{manifestComplete:false},0,'TABLET_MANIFEST_INCOMPLETE'],[{pendingCount:1},0,'TABLET_UPLOADS_PENDING'],[{unconfirmedCount:1},0,'TABLET_UPLOADS_PENDING'],[{},0,'SPREADSHEET_RECEIPTS_UNCONFIRMED']]){
  await recordUploadEvidence(s,{...manifest,...patch,sequence:++sequence},NOW-age);assert.equal((await assessUploadEvidence(scope(),age?receivedAttendance:attendance,DATE,NOW,{uploadStore:s})).reason,reason);
 }
 assert.equal((await assessUploadEvidence(scope(),{ok:false},DATE,NOW,{uploadStore:s})).reason,'UPLOAD_EVIDENCE_READ_UNAVAILABLE');
 attendance.ledger.days.at(-1).records.push({recordId:row,date:DATE,classLabel:'6:00 PM Isolated QA class',instructor:'Isolated QA Instructor',duration:1,reviewRequired:false});
 assert.equal((await assessUploadEvidence(scope(),attendance,DATE,NOW,{uploadStore:s})).complete,true);
});
test('tablet evidence producer reports the canonical manifest without changing ledger, queue, authentication or other storage',async()=>{
 const device='00000000-0000-4000-8000-000000000001',row='gib-m1-00000000-0000-4000-8000-000000000002',state={version:2,ledger:[{RowID:row,Date:DATE,Status:''}],queue:[{RowID:row,Date:DATE}]};
 const original=structuredClone(state),entries=new Map([['canonical',JSON.stringify(state)],['unrelated','preserve']]),requests=[],events=[];
 const report=startUploadEvidence({storage:{getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)},stateKey:'canonical',installationKey:k=>'isolated-'+k,getState:()=>state,cryptoApi:{randomUUID:()=>device},now:()=>new Date(NOW),schedule:(fn,ms)=>{assert.equal(ms,60000);},windowTarget:{navigator:{onLine:true},addEventListener:(e,fn)=>events.push(e)},documentTarget:{addEventListener(){}},fetchImpl:async(url,options)=>{requests.push({url,options});return{ok:true};}});
 await report();assert.ok(requests.length>=1);assert.deepEqual(state,original);assert.equal(entries.get('canonical'),JSON.stringify(original));assert.equal(entries.get('unrelated'),'preserve');
 const request=requests[0];assert.equal(request.url,'/api/m1-upload-evidence');assert.equal(request.options.credentials,'same-origin');assert.equal(JSON.parse(request.options.body).pendingCount,1);assert.ok(events.includes('online'));
});

test('an excluded unreadable row prevents a false missing sign-in allegation for that day',()=>{
 const input=fixture('missing');input.snapshots[0].attendance.ledger.days.at(-1).warnings.push({code:'UNREADABLE_SIGNIN',message:'One Sheet row for this date is incomplete and was not included.'});
 const digest=buildAttendanceDigest(input),rendered=splitAttendanceDigest(digest,input.configuration)[0].rendered;
 assert.equal(digest.itemCount,0);assert.equal(asks(rendered),false);assert.match(rendered.text,/row for this date is incomplete/);assert.doesNotMatch(rendered.text,/no valid instructor sign-in recorded/);
});
test('a present collision-review sign-in is listed once as a record problem, not also as missing',()=>{
 const input=fixture('missing');input.snapshots[0].attendance.ledger.days.at(-1).records.push({recordId:'isolated-QA-present',date:DATE,classLabel:'6:00 PM Isolated QA class',instructor:'Isolated QA Instructor',duration:1,reviewRequired:true});
 const digest=buildAttendanceDigest(input),rendered=splitAttendanceDigest(digest,input.configuration)[0].rendered;
 assert.equal(digest.itemCount,1);assert.equal(asks(rendered),true);assert.match(rendered.text,/Isolated QA Instructor; the saved sign-in is flagged for review/);assert.doesNotMatch(rendered.text,/no valid instructor sign-in recorded/);
});

function readableIdConflictInput(gym='rev') {
 const input=fixture('missing',gym),day=input.snapshots[0].attendance.ledger.days.at(-1),occurrences=input.schedules[0].days.at(-1).occurrences;
 occurrences[0].label='6:00 PM Isolated QA Class A';
 occurrences.push({label:'7:00 PM Isolated QA Class B',startAt:DATE+'T23:00:00.000Z',endAt:'2026-10-03T00:00:00.000Z',cancelled:false});
 const record={recordId:'isolated-QA-shared',date:DATE,classLabel:occurrences[0].label,instructor:'Isolated QA Instructor A',duration:1,reviewRequired:false};
 // The background Sheet reader retains both readable rows and warns on each.
 for(let i=0;i<2;i++){day.records.push({...record});day.warnings.push({code:'RECORD_ID_CONFLICT',message:'An attendance record has an ambiguous permanent ID.'});}
 return input;
}
for(const gym of ['rev','richmond'])test(gym+' readable ID conflicts retain a different finished class missing sign-in in the rendered email',()=>{
 const input=readableIdConflictInput(gym),before=structuredClone(input),digest=buildAttendanceDigest(input),route=splitAttendanceDigest(digest,input.configuration)[0],rendered=route.rendered;
 assert.deepEqual(input,before,'original rows, warnings, schedules and history must remain unchanged');
 assert.deepEqual(digest.groups[0].items.map(item=>item.kind).sort(),['attendance-conflict','missing-instructor']);
 const conflict=DATE+' — 6:00 PM Isolated QA Class A — instructor: Isolated QA Instructor A; the saved sign-in has a duplicate permanent attendance ID.';
 const missing=DATE+' — 7:00 PM Isolated QA Class B — instructor: not identified; no valid instructor sign-in recorded in the spreadsheet.';
 for(const body of [rendered.text,rendered.html.replace(/<[^>]+>/g,'')]){assert.ok(body.includes(conflict));assert.ok(body.includes(missing));}
 assert.equal(asks(rendered),true);assert.match(rendered.text,/corrections only for the specific attendance problems listed below/);
 assert.match(rendered.text,/separate unconfirmed checks do not establish additional missing sign-ins/);
 assert.equal(digest.readFailures.length,2,'retained-row warnings are still reported');
 assert.deepEqual(route.to,[gym==='rev'?'info@revolutionbjj.com':'info@richmondbjj.com']);assert.deepEqual(route.cc,[]);assert.deepEqual(route.bcc,['andrew@revolutionbjj.com']);
});
test('excluded or unknown warnings remain conservative even alongside readable ID conflicts',()=>{
 for(const code of ['UNREADABLE_SIGNIN','UNREADABLE_SIGNIN_DATE','UNKNOWN_ATTENDANCE_WARNING']) {
  const input=readableIdConflictInput();input.snapshots[0].attendance.ledger.days.at(-1).warnings.push({code,message:'An attendance row could not be read completely.'});
  const digest=buildAttendanceDigest(input),rendered=splitAttendanceDigest(digest,input.configuration)[0].rendered;
  assert.equal(digest.itemCount,1,code);assert.equal(digest.groups[0].items[0].kind,'attendance-conflict',code);
  assert.match(rendered.text,/Class A.*duplicate permanent attendance ID/);assert.match(rendered.text,/attendance row could not be read completely/);
  assert.doesNotMatch(rendered.text+rendered.html,/Class B|no valid instructor sign-in recorded/);
 }
});
