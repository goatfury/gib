// Isolated QA fixtures only: no services, no saved business rows, no real MailApp.
import {buildAttendanceDigest,defaultDigestConfiguration,splitAttendanceDigest} from '../../netlify/functions/_lib/m1-attendance-digest.mjs';
import {datesThrough} from '../../netlify/functions/_lib/m1-manager-review.mjs';
export const DATE='2026-10-02',NOW=Date.parse('2026-10-03T00:06:00Z');
export const scope=(gym='rev')=>({target:'production',profile:{installationId:gym,environment:'production',gymName:gym==='rev'?'Revolution BJJ':'Richmond BJJ'},liveFeatures:{reminders:true}});
export function fixture(kind,gym='rev') {
 const configuration=defaultDigestConfiguration(scope(gym),{GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true'});
 const ledger={ok:true,schema:'m1-manager-review/v1',target:'production',complete:true,gym,from:'2026-09-07',to:DATE,
  days:datesThrough(DATE).map(date=>({date,attendanceHash:'a'.repeat(64),records:[],warnings:[],review:null}))};
 const schedules=[{gym,timezone:'America/New_York',days:datesThrough(DATE).map(date=>({date,status:'complete',observedAt:date+'T12:00:00.000Z',sourceVersion:'isolated-QA-'+date,occurrences:[]}))}];
 const snapshot={gym,attendance:{ok:true,ledger},uploads:{ok:true,complete:true}};
 if(kind==='missing'||kind==='mixed')schedules[0].days.at(-1).occurrences.push({label:'6:00 PM Isolated QA class',startAt:DATE+'T22:00:00.000Z',endAt:DATE+'T23:00:00.000Z',cancelled:false});
 if(kind==='upload')snapshot.uploads={ok:false,reason:'TABLET_REPORT_NOT_RECEIVED'};
 if(kind==='failed'){snapshot.attendance={ok:false};snapshot.uploads={ok:false,reason:'UPLOAD_EVIDENCE_READ_UNAVAILABLE'};}
 if(kind==='stale')schedules[0].days=schedules[0].days.map(day=>day.date<'2026-10-01'?{date:day.date,status:'unavailable',code:'MISSING_DATED_SCHEDULE'}:day);
 if(kind==='mixed'){snapshot.uploads={ok:false,reason:'TABLET_UPLOADS_PENDING'};schedules[0].days[schedules[0].days.length-2]={date:'2026-10-01',status:'unavailable',code:'CURRENT_SCHEDULE_UNAVAILABLE'};}
 return {jobDate:DATE,now:NOW,configuration,snapshots:[snapshot],schedules};
}
export function renderFixture(kind,gym='rev') {
 const input=fixture(kind,gym),digest=buildAttendanceDigest(input),route=splitAttendanceDigest(digest,input.configuration)[0];
 return {input,digest,route};
}
export const CASES=['missing','upload','failed','stale','mixed','clean'];
