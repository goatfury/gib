// Fake authenticated bindings, fake business identity and in-memory records.
// Actual candidate handlers/renderers/Google worker; NO external service calls.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { processDigestJob, makeDigestBinding } from '../../netlify/functions/_lib/m1-attendance-digest-outbox.mjs';
import { managerAttendanceEmail } from '../../netlify/functions/_lib/m1-manager-attendance-email.mjs';
import { recordUploadEvidence } from '../../netlify/functions/_lib/m1-upload-evidence.mjs';
import { datesThrough, localNow } from '../../netlify/functions/_lib/m1-manager-review.mjs';
export const DATE='2026-10-03',NOW=Date.parse('2026-10-04T00:05:31Z'),ID='00000000-0000-4000-8000-000000000004';
export const scope=gym=>({target:'production',profile:{installationId:gym,environment:'production',gymName:gym==='rev'?'Revolution BJJ':'Richmond BJJ'},liveFeatures:{reminders:true}});
export function memoryStore() {
 const entries=new Map();let serial=0;
 return {entries,async list({prefix}){return {blobs:[...entries].filter(([k])=>k.startsWith(prefix)).map(([key])=>({key}))};},
  async getWithMetadata(key){return structuredClone(entries.get(key)||null);},
  async set(key,raw,c={}){const old=entries.get(key);if(c.onlyIfNew&&old||c.onlyIfMatch&&old?.etag!==c.onlyIfMatch)return {modified:false};entries.set(key,{data:JSON.parse(raw),etag:String(++serial)});return {modified:true};}};
}
export function input(gym='rev',date=DATE,now=NOW) {
 const ledger={ok:true,schema:'m1-manager-review/v1',target:'production',complete:true,gym,from:'2026-09-07',to:date,days:datesThrough(date).map(date=>({date,attendanceHash:'a'.repeat(64),records:[],warnings:[],review:null}))};
 const schedules={gym,timezone:'America/New_York',days:datesThrough(date).map(date=>({date,status:'complete',observedAt:date+'T12:00:00.000Z',sourceVersion:'fake-local-'+date,occurrences:[]}))};
 return {date,now,ledger,schedules,digestStore:memoryStore(),uploadStore:memoryStore()};
}
export function manifest(date=DATE,patch={}) {return {schema:'m1-upload-evidence/v1',deviceId:ID,sequence:1,date,coverageFrom:new Date(Date.parse(date+'T12:00Z')-86400000).toISOString().slice(0,10),manifestComplete:true,rowIds:[],savedCount:0,pendingCount:0,unconfirmedCount:0,...patch};}
export const CASES=['history-only','no-reporter','known-pending','known-stale','integration-failed','known-read-failed','missing-plus-internal','incorrect-plus-internal','complete-clean','later-class'];
export async function runCase(kind,gym='rev',date=DATE,now=NOW) {
 const f=input(gym,date,now);
 if(!['no-reporter','integration-failed','missing-plus-internal','incorrect-plus-internal'].includes(kind))await recordUploadEvidence(f.uploadStore,manifest(date,kind==='known-pending'?{pendingCount:1}:{}),kind==='known-stale'?now-300001:now);
 if(kind==='integration-failed')f.uploadStore.list=async()=>{throw Error('Fake unavailable report service');};
 if(kind==='known-read-failed')f.uploadStore.getWithMetadata=async()=>{throw Error('Fake unreadable known report');};
 if(['history-only','missing-plus-internal','incorrect-plus-internal'].includes(kind))f.schedules.days=f.schedules.days.map(day=>day.date<'2026-10-01'?{date:day.date,status:'unavailable',code:'MISSING_DATED_SCHEDULE'}:day);
 if(kind==='missing-plus-internal')f.schedules.days.at(-1).occurrences.push({label:'6:00 PM Local QA class',startAt:date+'T22:00:00.000Z',endAt:date+'T23:00:00.000Z',cancelled:false});
 if(kind==='incorrect-plus-internal')f.ledger.days.at(-1).records.push({recordId:'gib-admin-fake-local-original',date,classLabel:'6:00 PM Local QA class',instructor:'Local QA Instructor',duration:1,reviewRequired:true});
 if(kind==='later-class')f.schedules.days.at(-1).occurrences.push({label:'8:00 PM Local QA late class',startAt:new Date(Date.parse(date+'T00:00Z')+86400000).toISOString(),endAt:new Date(Date.parse(date+'T01:00Z')+86400000).toISOString(),cancelled:false});
 let report;
 await processDigestJob({binding:makeDigestBinding(ID,'scheduled',now,'production'),gyms:[{gym,attendance:{ok:true,ledger:f.ledger},staff:{ok:true,complete:true,items:[],notApplicable:true}}]},scope(gym),{
  env:{GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true'},clock:()=>now,digestStore:f.digestStore,uploadStore:f.uploadStore,loadSchedules:async()=>f.schedules,
  onDigestCheck:async check=>{report=managerAttendanceEmail(check.digest,check.configuration,check.uploadAssessment);},fetch:async()=>{throw Error('No external network in local fixture');}});
 const capture=f.digestStore.entries.get('outbox/m1-production-daily-'+(gym==='richmond'?'richmond-':'')+date)?.data;
 return {report,capture,fixture:f};
}
export function worker(gym='rev',date=DATE,now=NOW) {
 let clock=now,report=null,fail=false,failClaim=false,serial=0;
 const values=new Map(Object.entries({GIB_M1_ATTENDANCE_EMAIL_FIRST_ENABLED:'true',GIB_M1_ATTENDANCE_EMAIL_FIRST_READY:'v1',GIB_M1_ATTENDANCE_EMAIL_FIRST_START_DATE:date,GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED:'true',GIB_M1_MAILAPP_LIVE_SEND_ENABLED:'true',GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW:'true',GIB_M1_MAILAPP_LIVE_RECIPIENTS_JSON:JSON.stringify({to:[gym==='rev'?'info@revolutionbjj.com':'info@richmondbjj.com'],cc:[],bcc:['andrew@revolutionbjj.com']})}));
 const sends=[],checks=[];
 class ClockDate extends Date{constructor(v){super(v===undefined?clock:v);}static now(){return clock;}}
 const context={Date:ClockDate,console:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>values.get(k)??null,setProperty(k,v){if(failClaim&&k.startsWith('M1_ATTENDANCE_EMAIL_FIRST_DAY_'))throw Error('Fake claim persistence failure');values.set(k,v);}})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  Utilities:{getUuid:()=>ID.slice(0,-1)+String(++serial),formatDate(d,z,format){const l=localNow(d);return format==='HH:mm'?String(Math.floor(l.minutes/60)).padStart(2,'0')+':'+String(l.minutes%60).padStart(2,'0'):l.date;}},
  gibM1LiveReminderScope_:()=>({gym,target:'production'}),gibM1LiveInstallation_:()=>({gym,target:'production'}),Session:{getEffectiveUser:()=>({getEmail:()=> 'revbjjops@gmail.com'})},managerHash_:v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),configuredReceiverSecret_:()=> 'fake-local-transport',configuredAdminActionSecret_:()=> 'fake-local-admin',
  gibM1DigestDispatch_(binding){checks.push(binding);if(!report)throw Error('Fake monitor unavailable');return {ok:true,dailyEmail:report};},GIB_M1_DIGEST_SCHEMA_:'m1-attendance-digest-job/v1',
  MailApp:{getRemainingDailyQuota:()=>100,sendEmail(v){const claim=JSON.parse(values.get('M1_ATTENDANCE_EMAIL_FIRST_DAY_'+localNow(new Date(clock)).date));if(claim.state!=='call-pending')throw Error('Claim must precede fake send');sends.push(v);if(fail)throw Error('Fake uncertain submission');}}};
 vm.createContext(context);for(const f of ['GibM1MailApp.gs','GibM1AttendanceEmailFirst.gs'])vm.runInContext(readFileSync(new URL('../../integrations/google-apps-script/'+f,import.meta.url),'utf8'),context);
 return {context,values,sends,checks,tick:()=>context.gibM1AttendanceEmailFirstTick_(),report:v=>{report=v;},at:v=>{clock=v;},failSend:()=>{fail=true;},failClaim:()=>{failClaim=true;},claim:()=>JSON.parse(values.get('M1_ATTENDANCE_EMAIL_FIRST_DAY_'+localNow(new Date(clock)).date))};
}
