import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePromotions } from '../netlify/functions/m1-promotions.mts';
import { createProductionDeviceCredential, PRODUCTION_DEVICE_COOKIE } from '../netlify/functions/_lib/m1-production-runtime.mjs';
import { apiLookupMetadata } from '../m1/promotions-client.mjs';

const NOW = Date.parse('2026-09-14T15:00:00Z');
const ORIGIN = 'https://deploy-preview-86--gib-live.netlify.app';
const SITE = 'synthetic-api-routing-site';
const ENV = {
  GIB_PROMOTIONS_TEST_ENABLED:'true', GIB_PROMOTIONS_TEST_INSTALLATION:'rev', GIB_PROMOTIONS_TEST_ORIGIN:ORIGIN,
  GIB_PROMOTIONS_TEST_SITE_ID:SITE, GIB_PROMOTIONS_TEST_WEBHOOK_URL:'https://script.google.com/macros/s/SYNTHETIC_TEST_READER/exec',
  GIB_PROMOTIONS_TEST_BRIDGE_SECRET:'synthetic-routing-bridge-01234567890123456789',
  GIB_PROMOTIONS_TEST_DEVICE_SECRET:'synthetic-routing-device-01234567890123456789',
  GIB_PROMOTIONS_TEST_INSTALL_SECRET:'synthetic-routing-install-01234567890123456789', GIB_PROMOTIONS_TEST_INSTALL_RUN_ID:'synthetic-routing-run',
  GIB_PROMOTIONS_TEST_API_ENABLED:'true', GIB_PROMOTIONS_TEST_API_SETUP_ENABLED:'true',
  GIB_PROMOTIONS_TEST_API_DEPLOYMENT_ID:'SYNTHETIC_API_EXECUTABLE_123456789',
  GIB_PROMOTIONS_TEST_API_CLIENT_ID:'12345678-synthetic.apps.googleusercontent.com',
  GIB_PROMOTIONS_TEST_API_CLIENT_SECRET:'synthetic-routing-client-01234567890123456789',
  GIB_PROMOTIONS_TEST_API_OWNER_EMAIL:'revbjjops@gmail.com', GIB_PROMOTIONS_TEST_API_WORKBOOK_ID:'SYNTHETIC_TEST_WORKBOOK_123456789',
  GIB_PROMOTIONS_LIVE_ENABLED:'true', GIB_PROMOTIONS_LIVE_INSTALLATION:'rev', GIB_PROMOTIONS_LIVE_SITE_ID:SITE,
  GIB_PROMOTIONS_LIVE_WEBHOOK_URL:'https://script.google.com/macros/s/SYNTHETIC_LIVE_READER/exec',
  GIB_PROMOTIONS_LIVE_BRIDGE_SECRET:'synthetic-routing-live-bridge-01234567890123456789',
  GIB_M1_PRODUCTION_DEVICE_TOKEN:'synthetic-routing-production-device-01234567890123456789'
};
function request(body={operation:'bootstrap'}, {live=false,headers={},signal}={}) {
  const origin = live ? 'https://gib-live.netlify.app' : ORIGIN;
  const secret = live ? ENV.GIB_M1_PRODUCTION_DEVICE_TOKEN : ENV.GIB_PROMOTIONS_TEST_DEVICE_SECRET;
  const cookie = (live ? PRODUCTION_DEVICE_COOKIE : '__Host-gib_m1_promotions_test_device') + '='
    + createProductionDeviceCredential(secret, size=>Buffer.alloc(size, 0x36), NOW);
  return new Request(origin+'/api/m1-promotions', {method:'POST', headers:{Host:new URL(origin).host,Origin:origin,
    'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(body),...(signal?{signal}:{})});
}
const wrapper = envelope => ({bridge:envelope.payload.mode,target:envelope.payload.target,installation:'rev',
  requestNonce:envelope.payload.nonce,result:{ok:true,data:{marker:'SYNTHETIC_CURRENT_RECORD'}}});
function harness(changes={}) {
  const apiCalls=[];const webCalls=[];
  const deps={env:ENV,siteId:SITE,installationId:'rev',now:NOW,
    apiRead:async(envelope,config,options)=>{apiCalls.push({envelope,config,options});return {wrapper:wrapper(envelope),diagnostics:{phase:'complete',ms:1200,errorCode:'none',attempts:1}};},
    fetch:async(url,options)=>{const envelope=JSON.parse(options.body);webCalls.push({url,envelope});
      return new Response(JSON.stringify(wrapper(envelope)),{headers:{'Content-Type':'application/json'}});},...changes};
  return {apiCalls,webCalls,run:r=>handlePromotions(r,deps)};
}

test('enabled TEST bootstrap/student reads use a fresh signed API request with no web-app request',async()=>{
  const h=harness();const nonces=[];
  for(const body of[{operation:'bootstrap'},{operation:'readStudent',studentId:'synthetic-student-1'}]){
    const response=await h.run(request(body));assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,data:{marker:'SYNTHETIC_CURRENT_RECORD'}});
    assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-GIB-TEST-Transport-Kind'),'google-api');
    assert.deepEqual(apiLookupMetadata(response.headers.get('X-GIB-TEST-API')),{phase:'complete',ms:1200,errorCode:'none',attempts:1});
    const call=h.apiCalls.at(-1);assert.deepEqual(call.envelope.payload.request,body);assert.equal(call.config.enabled,true);
    assert.ok(call.options.signal instanceof AbortSignal);assert.equal(call.options.signal.aborted,false);nonces.push(call.envelope.payload.nonce);
  }
  assert.equal(h.apiCalls.length,2);assert.equal(h.webCalls.length,0);assert.notEqual(nonces[0],nonces[1]);
});

test('authorization, origin, input and completed-comparison guards run before API dispatch',async()=>{
  for(const [body,headers,status] of [[{operation:'bootstrap'},{Cookie:''},401],[{operation:'bootstrap'},{Origin:'https://evil.invalid'},403],
    [{operation:'bootstrap',privateUrl:'https://evil.invalid'},{},400],[{operation:'bootstrap'},{'X-GIB-TEST-Transport':'A'},400]]){
    const h=harness();assert.equal((await h.run(request(body,{headers}))).status,status);assert.equal(h.apiCalls.length,0);assert.equal(h.webCalls.length,0);
  }
});

test('incomplete configuration and API failures fail closed without replay or web-app fallback',async()=>{
  const broken=harness({env:{...ENV,GIB_PROMOTIONS_TEST_API_CLIENT_SECRET:''}});
  const unavailable=await broken.run(request());assert.equal(unavailable.status,503);assert.equal(broken.apiCalls.length,0);assert.equal(broken.webCalls.length,0);
  for(const errorCode of ['ACCESS_DENIED','TOKEN_REVOKED','TIMEOUT','API_RESULT','NETWORK']){
    let attempts=0;const h=harness({apiRead:async()=>{attempts++;throw Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'),{diagnostics:{phase:'api',ms:2500,errorCode,attempts:1}});}});
    const response=await h.run(request());assert.equal(response.status,503);const text=await response.text();assert.equal(text.includes('SYNTHETIC_PRIVATE_ERROR'),false);
    assert.equal(JSON.parse(text).error.retryable,false);assert.equal(apiLookupMetadata(response.headers.get('X-GIB-TEST-API')).errorCode,errorCode);
    assert.equal(attempts,1);assert.equal(h.webCalls.length,0);
  }
});

test('wrong nonce, target, fields and malformed confirmation cannot become current records',async()=>{
  for(const change of [v=>({...v,requestNonce:'other'}),v=>({...v,target:'live'}),v=>({...v,extra:'private'}),v=>({...v,result:{ok:'true'}})]){
    const h=harness({apiRead:async e=>({wrapper:change(wrapper(e)),diagnostics:{phase:'complete',ms:1,errorCode:'none',attempts:1}})});
    const response=await h.run(request());assert.equal(response.status,503);assert.equal(h.webCalls.length,0);
    assert.equal(apiLookupMetadata(response.headers.get('X-GIB-TEST-API')).errorCode,'ENVELOPE');
  }
});

test('TEST writes, save reconciliation, disabled API reads and LIVE retain their existing transport',async()=>{
  const write={operation:'recordPromotion',studentId:'synthetic-student-1',requestId:'synthetic-save-1',expectedRevision:1,action:'stripe',approverName:'TEST Coach'};
  for(const [body,options,enabled] of [[write,{},'true'],[{operation:'checkSave',requestId:'synthetic-save-1'},{},'true'],
    [{operation:'bootstrap'},{},'false'],[{operation:'bootstrap'},{live:true},'true']]){
    const h=harness({env:{...ENV,GIB_PROMOTIONS_TEST_API_ENABLED:enabled}});const response=await h.run(request(body,options));
    assert.equal(response.status,200);assert.equal(h.apiCalls.length,0);assert.equal(h.webCalls.length,1);assert.equal(response.headers.get('X-GIB-TEST-Transport-Kind'),null);
  }
});

test('cancelling the browser request reaches the single API read and cannot dispatch a fallback',async()=>{
  const controller=new AbortController();let signal;let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const h=harness({apiRead:async(_e,_c,options)=>{signal=options.signal;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const pending=h.run(request({operation:'bootstrap'},{signal:controller.signal}));await ready;controller.abort();
  assert.equal((await pending).status,503);assert.equal(signal.aborted,true);assert.equal(h.webCalls.length,0);
});

test('API diagnostic parser excludes private, unbounded and retry-shaped metadata',()=>{
  const valid={phase:'api',ms:2500,errorCode:'ACCESS_DENIED',attempts:1};assert.deepEqual(apiLookupMetadata(JSON.stringify(valid)),valid);
  for(const value of [null,'private',JSON.stringify({...valid,url:'https://private.invalid'}),...[
    {...valid,attempts:2},{...valid,phase:'private'},{...valid,errorCode:'PRIVATE_TOKEN'},{...valid,ms:-1},{...valid,ms:3600001},{...valid,ms:1.5}
  ].map(JSON.stringify)])assert.equal(apiLookupMetadata(value),null);
});

test('already cancelled or just-completed obsolete API reads cannot return a successful record',async()=>{
  const before=new AbortController();before.abort();const undispatched=harness();
  assert.equal((await undispatched.run(request({operation:'bootstrap'},{signal:before.signal}))).status,503);
  assert.equal(undispatched.apiCalls.length,0);assert.equal(undispatched.webCalls.length,0);
  const finishing=new AbortController();const h=harness({apiRead:async e=>{
    finishing.abort();return {wrapper:wrapper(e),diagnostics:{phase:'complete',ms:1,errorCode:'none',attempts:1}};
  }});
  assert.equal((await h.run(request({operation:'bootstrap'},{signal:finishing.signal}))).status,503);assert.equal(h.webCalls.length,0);
});
