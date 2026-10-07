// Offline examples: public schedule labels, synthetic records, no services or sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAttendanceDigest, defaultDigestConfiguration, splitAttendanceDigest} from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import {datesThrough} from '../netlify/functions/_lib/m1-manager-review.mjs';
import {fixture, renderFixture, scope, CASES} from './fixtures/m1-email-repair-cases.mjs';

const schedule=JSON.parse(readFileSync(new URL('../m1/richmond-schedule.json',import.meta.url),'utf8'));
const classes=[
  ['2026-10-02',schedule.days.Friday[2]],['2026-10-02',schedule.days.Friday[3]],
  ['2026-10-04',schedule.days.Sunday[0]],['2026-10-05',schedule.days.Monday[3]],
  ['2026-10-06',schedule.days.Tuesday[2]]
];
function fiveClassInput() {
  const jobDate='2026-10-06',days=datesThrough(jobDate);
  return {jobDate,now:Date.parse('2026-10-07T00:06:00Z'),configuration:defaultDigestConfiguration(scope('richmond'),{GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true'}),
    snapshots:[{gym:'richmond',attendance:{ok:true,ledger:{ok:true,schema:'m1-manager-review/v1',target:'production',complete:true,gym:'richmond',from:days[0],to:jobDate,
      days:days.map(date=>({date,attendanceHash:'a'.repeat(64),records:[],warnings:[],review:null}))}},uploads:{ok:false,reason:'TABLET_UPLOADS_PENDING'}}],
    schedules:[{gym:'richmond',timezone:'America/New_York',days:days.map(date=>date<'2026-10-01'?{date,status:'unavailable',code:'MISSING_DATED_SCHEDULE'}:
      {date,status:'complete',observedAt:date+'T12:00:00.000Z',sourceVersion:'isolated-QA-'+date,
        occurrences:classes.filter(item=>item[0]===date).map(([,label])=>({label,startAt:date+'T14:00:00.000Z',endAt:date+'T15:00:00.000Z',cancelled:false}))})}]};
}

test('Richmond asks once, groups five exact class names and times by readable date, and puts upload uncertainty first',()=>{
  const input=fiveClassInput(),digest=buildAttendanceDigest(input),before=structuredClone(digest);
  const {rendered}=splitAttendanceDigest(digest,input.configuration)[0];
  assert.equal(digest.itemCount,5);assert.equal(digest.readFailures.length,2);assert.deepEqual(digest,before,'rendering cannot remove the retained history or upload failure');
  assert.ok(rendered.text.startsWith('Hi Trey,\n\n'));
  assert.equal((rendered.text.match(/Who taught/g)||[]).length,1);
  assert.match(rendered.text,/Who taught these classes\? If any were canceled, just say so\./);
  const warning='We couldn’t confirm that all saved sign-ins reached the spreadsheet.';
  assert.equal((rendered.text.match(/saved sign-ins reached the spreadsheet/g)||[]).length,1);
  assert.ok(rendered.text.indexOf(warning)<rendered.text.indexOf('Who taught'));
  assert.ok(rendered.html.includes(warning));assert.ok(rendered.html.indexOf(warning)<rendered.html.indexOf('Who taught'));
  const headings=['Friday, October 2','Sunday, October 4','Monday, October 5','Tuesday, October 6'];
  let previous=0;for(const heading of headings){const index=rendered.text.indexOf(heading);assert.ok(index>previous);previous=index;assert.ok(rendered.html.includes('<strong>'+heading+'</strong>'));}
  for(const [date,label] of classes){assert.equal((rendered.text.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length,date==='2026-10-02'&&label===schedule.days.Friday[3]||date==='2026-10-05'?2:1);assert.ok(rendered.text.includes('• '+label));assert.ok(rendered.html.includes('<li>'+label+'</li>'));}
  assert.equal((rendered.text.match(/^• /gm)||[]).length,5);assert.equal((rendered.html.match(/<ul>/g)||[]).length,4);
  assert.ok(rendered.text.endsWith('Reply here and Andrew will update the records.'));
  assert.doesNotMatch(rendered.text+rendered.html,/Older schedule checks|setup gaps|2026-09|Please reply here with any corrections|goati|\/m1\/admin\//);
});

test('Richmond retains every current warning and send decision while dropping repetitive historical setup prose',()=>{
  for(const kind of CASES){const {digest,route}=renderFixture(kind,'richmond');
    assert.equal(route.routeStatus,kind==='clean'?'suppressed':'ready');
    if(kind==='clean'){assert.equal(route.rendered,null);continue;}
    assert.equal(digest.shouldCapture,true);assert.equal(digest.itemCount,['missing','mixed'].includes(kind)?1:0);
    assert.equal(digest.readFailures.length,{missing:0,upload:1,failed:2,stale:1,mixed:2}[kind]);
    if(!['missing','mixed'].includes(kind))assert.doesNotMatch(route.rendered.text,/Who taught|Reply here/);
  }
});

test('Richmond historical-only uncertainty never claims a completed all-clear or requests corrections',()=>{
  const {digest,route}=renderFixture('stale','richmond');
  assert.equal(digest.readFailures[0].code,'HISTORICAL_SCHEDULE_UNAVAILABLE');
  assert.equal(route.rendered.text,'Hi Trey,\n\nSome earlier sign-in checks are still incomplete.');
  assert.doesNotMatch(route.rendered.text,/Who taught|Reply here|complete check|no problems were found|reached the spreadsheet/);
});

test('Richmond preserves flagged record details and safely escapes class labels instead of calling them missing sign-ins',()=>{
  const input=fixture('missing','richmond'),label='6:00 PM <QA & practice>';
  input.schedules[0].days.at(-1).occurrences[0].label=label;
  input.snapshots[0].attendance.ledger.days.at(-1).records.push({recordId:'gib-m1-00000000-0000-4000-8000-000000000002',date:input.jobDate,classLabel:label,instructor:'QA <instructor>',duration:1,reviewRequired:true});
  const digest=buildAttendanceDigest(input),{rendered}=splitAttendanceDigest(digest,input.configuration)[0];
  assert.equal(digest.itemCount,1);assert.equal(digest.groups[0].items[0].kind,'attendance-conflict');
  assert.match(rendered.text,/Could you check these sign-ins and reply with what needs changing\?/);
  assert.ok(rendered.text.includes(label+' — QA <instructor>; marked for review'));
  assert.ok(rendered.html.includes('6:00 PM &lt;QA &amp; practice&gt; — QA &lt;instructor&gt;; marked for review'));
  assert.doesNotMatch(rendered.text,/Who taught|without a sign-in/);assert.doesNotMatch(rendered.html,/<QA|<instructor>/);
});

test('Richmond keeps class-status and record-read warnings that still require attention',()=>{
  const input=fixture('missing','richmond'),day=input.snapshots[0].attendance.ledger.days.at(-1);
  day.warnings.push({code:'QA_RECORD_READ_UNAVAILABLE',message:'QA sign-in could not be read.'});
  day.review={date:input.jobDate,gym:'richmond',revision:1,action:'partial',attendanceHash:'a'.repeat(64),scheduleHash:'b'.repeat(64),
    time:input.jobDate+'T23:00:00.000Z',snapshot:{},decisions:[{label:'QA earlier class',outcome:'unknown'}]};
  const digest=buildAttendanceDigest(input),{rendered}=splitAttendanceDigest(digest,input.configuration)[0];
  assert.equal(digest.itemCount,0);assert.ok(digest.readFailures.some(f=>f.code==='ATTENDANCE_RECORD_UNCONFIRMED'));
  assert.ok(digest.readFailures.some(f=>f.code==='CLASS_STATUS_UNCONFIRMED'));
  assert.match(rendered.text,/QA sign-in could not be read\./);assert.match(rendered.text,/QA earlier class/);
  assert.doesNotMatch(rendered.text,/Who taught|Reply here/);
});
