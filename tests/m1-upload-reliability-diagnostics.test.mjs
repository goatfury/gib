import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.env.M1_UPLOAD_CONTRACT_BASELINE_ROOT
  ?pathToFileURL(process.env.M1_UPLOAD_CONTRACT_BASELINE_ROOT.replaceAll('\\','/')+'/')
  :new URL('../',import.meta.url);
const {startUploadEvidence}=await import(new URL('m1/upload-evidence.mjs',root));
const NOW=new Date('2026-10-03T00:05:00.000Z'),DEVICE='00000000-0000-4000-8000-000000000001';
function producer(fetchImpl, patch={}) {
  const state={version:2,ledger:[{RowID:'gib-m1-00000000-0000-4000-8000-000000000002',Date:'2026-10-02',Status:''}],queue:[]};
  const stored=new Map([['canonical',JSON.stringify(state)],['unrelated','preserve']]),events=[],statuses=[];
  const report=startUploadEvidence({storage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)},
    stateKey:'canonical',installationKey:key=>'own-'+key,getState:()=>state,
    cryptoApi:{randomUUID:()=>DEVICE},now:()=>NOW,schedule(){},
    windowTarget:{navigator:{onLine:true},addEventListener:(event,fn)=>events.push([event,fn])},
    documentTarget:{addEventListener(){}},fetchImpl,onStatus:value=>statuses.push(value),...patch});
  return {state,stored,events,statuses,report};
}
test('reporter diagnostics require an exact saved-report acknowledgment and preserve local records',async()=>{
  let mode='reject',calls=0;
  const f=producer(async(_url,options)=>{
    calls++;const manifest=JSON.parse(options.body);
    if(mode==='throw')throw new Error('private payload must not appear in diagnostics');
    if(mode==='reject')return new Response('private denial payload',{status:401});
    return new Response(JSON.stringify(mode==='wrong'?{ok:true,schema:'m1-upload-evidence/v1',sequence:manifest.sequence+1}
      :{ok:true,schema:'m1-upload-evidence/v1',sequence:manifest.sequence}),{status:200});
  });
  await new Promise(resolve=>setImmediate(resolve));
  const before=structuredClone(f.state),canonical=f.stored.get('canonical');
  assert.equal(f.statuses.at(-1)?.stage,'report-rejected');
  assert.equal(f.statuses.at(-1).status,401);
  mode='wrong';await f.report();assert.equal(f.statuses.at(-1).stage,'report-unconfirmed');
  mode='throw';await f.report();assert.equal(f.statuses.at(-1).stage,'report-unconfirmed');
  mode='saved';await f.report();assert.equal(f.statuses.at(-1).stage,'report-stored');
  assert.ok(calls>=4);assert.deepEqual(f.state,before);assert.equal(f.stored.get('canonical'),canonical);
  assert.equal(f.stored.get('unrelated'),'preserve');
  for(const status of f.statuses)assert.deepEqual(Object.keys(status).sort(),['schema','stage','status']);
  assert.doesNotMatch(JSON.stringify(f.statuses),/private|RowID|Instructor|cookie|token|000000/);
});
test('offline and unavailable local state are diagnosed without fabricating a report or enrolling a blank tablet',async()=>{
  let calls=0;
  const offline=producer(async()=>{calls++;},{windowTarget:{navigator:{onLine:false},addEventListener(){}}});
  await offline.report();assert.equal(calls,0);assert.equal(offline.statuses.at(-1)?.stage,'offline');
  const blank=producer(async()=>{calls++;},{getState:()=>({version:2,ledger:[],queue:[]})});
  await blank.report();assert.equal(calls,0);assert.equal(blank.statuses.at(-1)?.stage,'not-enrolled');
  assert.equal([...blank.stored.keys()].some(key=>key.startsWith('own-')),false);
  const unreadable=producer(async()=>{calls++;},{storage:{getItem:()=>'{bad',setItem(){assert.fail('must not change records');}}});
  await unreadable.report();assert.equal(calls,0);assert.equal(unreadable.statuses.at(-1)?.stage,'report-unconfirmed');
});
test('released startup path diagnoses an alias without starting or weakening the canonical reporter',async()=>{
  const source=readFileSync(new URL('m1/index.html',root),'utf8');
  const start=source.indexOf('  if (BACKEND_ENABLED && IS_PRODUCTION_SYNC_ORIGIN && globalThis.M1_MANAGER_REVIEW_CONFIG?.reminders === true) {');
  const end=source.indexOf('  if (BACKEND_ENABLED && (!IS_RICHMOND_PRODUCTION || RICHMOND_WRITES_ENABLED)) {',start);
  assert.ok(start>=0&&end>start);
  const notices=[],context={BACKEND_ENABLED:true,IS_PRODUCTION_SYNC_ORIGIN:false,
    M1_MANAGER_REVIEW_CONFIG:{reminders:true},console:{info:(...values)=>notices.push(values),warn:(...values)=>notices.push(values)}};
  vm.runInNewContext(source.slice(start,end),context);
  assert.match(JSON.stringify(notices),/reporter-origin-unavailable/);
  assert.match(JSON.stringify(notices),/Upload confirmation is unavailable at this address/);
  notices.length=0;context.M1_MANAGER_REVIEW_CONFIG.reminders=false;
  vm.runInNewContext(source.slice(start,end),context);assert.equal(notices.length,0,'disabled capability stays silent');
});

const {handleUploadEvidence}=await import(new URL('netlify/functions/m1-upload-evidence.mjs',root));
test('upload handler traces only bounded request stages and never opens storage on denial',async()=>{
  const traces=[],base='https://gib-live.netlify.app',requestId='isolated-request-12345678';
  const dependencies={installationId:'rev',environment:'production',activation:'active',
    env:{GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED:'true'},
    context:{site:{name:'gib-live',id:'f748e737-11e3-4fab-8e8c-bf185eab29ff'},deploy:{context:'production',published:true},requestId},
    traceLog:value=>traces.push(value),uploadStore:{set(){assert.fail('denied request must not persist');}}};
  const request=origin=>new Request(base+'/api/m1-upload-evidence',{method:'POST',
    headers:{Host:'gib-live.netlify.app',Origin:origin,'Sec-Fetch-Site':'same-origin',Cookie:'private-cookie-never-log'},body:'private-body-never-log'});
  assert.equal((await handleUploadEvidence(request('https://gib-richmond-live.netlify.app'),dependencies)).status,403);
  assert.equal(traces.at(-1)?.stage,'scope-rejected');assert.equal(traces.at(-1).originMatchesExpected,false);
  assert.equal((await handleUploadEvidence(request(base),dependencies)).status,401);
  assert.equal(traces.at(-1).stage,'runtime-unavailable');assert.equal(traces.at(-1).originMatchesExpected,true);
  assert.equal(traces.at(-1).requestId,requestId);
  assert.doesNotMatch(JSON.stringify(traces),/private|Cookie|body|token|Instructor|RowID/);
  assert.equal((await handleUploadEvidence(request(base),{...dependencies,traceLog(){throw Error('isolated log outage');}})).status,401,
    'diagnostic failure cannot change request safety or create a retry');
});
