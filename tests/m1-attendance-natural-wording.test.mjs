// Synthetic rendering only. No endpoint, business storage, account or real email.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,renderFixture,DATE} from './fixtures/m1-email-repair-cases.mjs';
import {buildAttendanceDigest,splitAttendanceDigest,renderAttendanceDigest} from '../netlify/functions/_lib/m1-attendance-digest.mjs';
const plain=html=>html.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
for(const [gym,manager] of [['rev','Stu'],['richmond','Trey']]){
 test(gym+' missing-only asks a natural dated class question, with identical text/HTML intent',()=>{
  const {route,digest}=renderFixture('missing',gym),r=route.rendered;
  assert.equal(r.subject,'Sign-in question for 6:00 PM Isolated QA class on '+DATE);
  assert.equal(r.text,'Hi '+manager+',\n\nWe don’t have an instructor sign-in for 6:00 PM Isolated QA class on '+DATE+'. Who taught it, or was it canceled?\n\nPlease reply here with any corrections and Andrew will update the record.');
  assert.ok(plain(r.html).includes('Hi '+manager+','));assert.ok(plain(r.html).includes('Who taught it, or was it canceled?'));
  assert.equal(digest.itemCount,1);assert.equal(route.routeStatus,'ready');assert.deepEqual(route.cc,[]);
  assert.doesNotMatch(r.text+plain(r.html),/GIB Attendance|To:|Subject:|corporate|payroll|correction screen|submission|authenticated/);
 });
 test(gym+' multiple questions keep every actual class/date and one reply instruction',()=>{
  const {route,digest}=renderFixture('multiple',gym),r=route.rendered;
  assert.equal(digest.itemCount,2);assert.equal((r.text.match(/Who taught it, or was it canceled\?/g)||[]).length,2);
  assert.equal((r.text.match(/Please reply here/g)||[]).length,1);assert.match(r.text,/6:00 PM Isolated QA class on 2026-10-02/);assert.match(r.text,/7:00 PM Isolated QA second class on 2026-10-02/);
  assert.ok(plain(r.html).includes('7:00 PM Isolated QA second class on '+DATE));
 });
 test(gym+' conflict describes the recorded problem and never alleges an absent sign-in',()=>{
  const r=renderFixture('conflict',gym).route.rendered;
  assert.match(r.text,/6:00 PM Isolated QA class on 2026-10-02.*Isolated QA Instructor.*marked for review/);
  assert.match(r.text,/What needs changing\?/);assert.doesNotMatch(r.text,/don’t have an instructor|forgot/);assert.ok(plain(r.html).includes('What needs changing?'));
 });
 test(gym+' uncertainty-only uses plain words, no attendance allegation or reply request',()=>{
  const r=renderFixture('upload',gym).route.rendered;assert.equal(r.subject,'Today’s sign-in check couldn’t finish');
  assert.match(r.text,new RegExp('^Hi '+manager+','));assert.match(r.text,/We couldn’t confirm that all the sign-ins reached the spreadsheet/);
  assert.match(r.text,/haven’t identified a specific missing sign-in, so no correction reply is needed/);
  assert.match(r.text,/Andrew will look into the check/);assert.doesNotMatch(r.text,/Please reply here|Who taught|forgot|offline tablet/);assert.ok(plain(r.html).includes('no correction reply is needed'));
 });
 test(gym+' mixed asks specific questions before a separate upload note',()=>{
  const r=renderFixture('mixed',gym).route.rendered;assert.ok(r.text.indexOf('Who taught it')<r.text.indexOf('Uploads not confirmed'));
  assert.match(r.text,/Please reply here with any corrections and Andrew will update the record/);assert.match(r.text,/This doesn’t identify another missing sign-in/);assert.ok(plain(r.html).includes('Uploads not confirmed'));
 });
 test(gym+' history stays separate and clean produces no email',()=>{
  const historical=renderFixture('stale',gym);assert.equal(historical.digest.readFailures[0].code,'HISTORICAL_SCHEDULE_UNAVAILABLE');
  assert.match(historical.route.rendered.text,/Older schedule checks/);assert.match(historical.route.rendered.text,/2026-09-07 through 2026-09-30/);
  assert.match(historical.route.rendered.text,/not new attendance problems/);assert.doesNotMatch(historical.route.rendered.text,/Please reply here|Who taught/);
  const clean=renderFixture('clean',gym);assert.equal(clean.route.rendered,null);assert.equal(clean.route.routeStatus,'suppressed');
 });
}
test('structured class/instructor values escape HTML and cannot inject subject headers; raw operator summaries are retained',()=>{
 const input=fixture('conflict','richmond');const label='6 PM QA <script>unsafe</script> & "class"',instructor='QA <img src=x onerror=unsafe> & instructor';
 input.schedules[0].days.at(-1).occurrences[0].label=label;Object.assign(input.snapshots[0].attendance.ledger.days.at(-1).records[0],{classLabel:label,instructor});
 const digest=buildAttendanceDigest(input),r=splitAttendanceDigest(digest,input.configuration)[0].rendered;
 assert.ok(r.text.includes(label));assert.ok(r.text.includes(instructor));assert.ok(r.html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));assert.ok(r.html.includes('&lt;img src=x onerror=unsafe&gt;'));
 assert.doesNotMatch(r.html,/<script>|<img/);assert.ok(digest.groups[0].items[0].summary.includes(instructor));
 input.schedules[0].days.at(-1).occurrences[0].label=label+'\r\nInjected header';input.snapshots[0].attendance.ledger.days.at(-1).records[0].classLabel=label+'\r\nInjected header';
 const safe=splitAttendanceDigest(buildAttendanceDigest(input),input.configuration)[0].rendered;assert.doesNotMatch(safe.subject,/[\r\n]/);
});
test('natural copy is based on structured details, never parsed from the legacy summary',()=>{
 const {input,digest}=renderFixture('missing');const item=digest.groups[0].items[0];assert.equal(item.attendance.classLabel,'6:00 PM Isolated QA class');
 item.summary='Unrelated legacy prose. Not the class identity.';const r=splitAttendanceDigest(digest,input.configuration)[0].rendered;
 assert.match(r.text,/6:00 PM Isolated QA class on 2026-10-02/);assert.doesNotMatch(r.text,/Unrelated legacy/);
});
test('optional structured copy remains strictly bound and legacy saved items remain readable',()=>{
 const {input,digest}=renderFixture('missing');const legacy=structuredClone(digest);delete legacy.groups[0].items[0].attendance;
 assert.equal(splitAttendanceDigest(legacy,input.configuration)[0].routeStatus,'ready');
 for(const patch of [{problem:'arbitrary'},{classLabel:''},{instructor:42}]){const bad=structuredClone(digest);Object.assign(bad.groups[0].items[0].attendance,patch);assert.throws(()=>splitAttendanceDigest(bad,input.configuration));}
});

test('structured cancellation, duration and duplicate conflicts name the actual problem, not a missing instructor',()=>{
 for(const kind of ['duration','schedule-cancellation','not-held','duplicate-id']){
  const input=fixture('conflict'),day=input.snapshots[0].attendance.ledger.days.at(-1),row=day.records[0];row.reviewRequired=false;
  if(kind==='duration')row.duration=0;
  if(kind==='schedule-cancellation')input.schedules[0].days.at(-1).occurrences[0].cancelled=true;
  if(kind==='not-held')day.review={revision:1,action:'partial',decisions:[{label:row.classLabel,outcome:'not-held'}],snapshot:{base:null},attendanceHash:'a'.repeat(64),scheduleHash:'b'.repeat(64),time:'2026-10-02T23:00:00.000Z'};
  if(kind==='duplicate-id')day.records.push({...row});
  const digest=buildAttendanceDigest(input),r=splitAttendanceDigest(digest,input.configuration)[0].rendered;
  assert.equal(digest.itemCount,1);assert.equal(digest.groups[0].items[0].attendance.problem,kind);
  assert.match(r.text,/6:00 PM Isolated QA class on 2026-10-02 lists Isolated QA Instructor/);assert.doesNotMatch(r.text,/don’t have an instructor|forgot/);
  assert.match(r.text,kind==='duration'?/zero or less.*How long/:kind==='duplicate-id'?/shares a record number/:kind==='not-held'?/marked as not held/:/schedule says the class was canceled/);
 }
});

test('plain manager copy requires an explicit single own-gym route; combined/legacy captures keep gym labels',()=>{
 const rev=renderFixture('missing','rev'),rich=renderFixture('missing','richmond');
 const combined=structuredClone(rev.digest);combined.groups.push(structuredClone(rich.digest.groups[0]));combined.itemCount+=rich.digest.itemCount;
 const capture=renderAttendanceDigest(combined);assert.ok(capture.text.includes('Revolution BJJ'));assert.ok(capture.text.includes('Richmond BJJ'));
 assert.doesNotMatch(capture.text,/^Hi Stu,/);assert.match(capture.text,/GIB Attendance reminder/);
 const wrong=structuredClone(rev.route.digest);wrong.routedGym='richmond';assert.doesNotMatch(renderAttendanceDigest(wrong).text,/^Hi (?:Stu|Trey),/);
 const legacy=structuredClone(rev.digest);assert.doesNotMatch(renderAttendanceDigest(legacy).text,/^Hi Stu,/);
 assert.match(rev.route.rendered.text,/^Hi Stu,/);assert.match(rich.route.rendered.text,/^Hi Trey,/);
});
