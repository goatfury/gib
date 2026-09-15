import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { handlePromotionsApiOAuth } from '../netlify/functions/m1-promotions-api-oauth.mts';
import { createProductionDeviceCredential } from '../netlify/functions/_lib/m1-production-runtime.mjs';
import { promotionsRuntimeConfig, createPromotionsEnvelope } from '../netlify/functions/_lib/promotions-runtime.mts';
import {
  API_TEST_ORIGIN, API_OAUTH_PATH, API_CALLBACK_PATH, API_CREDENTIAL_KEY, API_SCOPES,
  promotionsApiConfig, encryptApiRecord, decryptApiRecord, runPromotionsApiRead, apiStore, apiError
} from '../netlify/functions/_lib/promotions-api.mts';
import { safeOAuthFailureDiagnostic } from '../netlify/functions/_lib/promotions-api-oauth.mts';

const NOW=Date.parse('2026-09-14T15:00:00Z');
const SITE='synthetic-test-site';
const ENV={
  GIB_PROMOTIONS_TEST_ENABLED:'true',GIB_PROMOTIONS_TEST_INSTALLATION:'rev',GIB_PROMOTIONS_TEST_ORIGIN:API_TEST_ORIGIN,GIB_PROMOTIONS_TEST_SITE_ID:SITE,
  GIB_PROMOTIONS_TEST_WEBHOOK_URL:'https://script.google.com/macros/s/SYNTHETIC_EXISTING_TEST_ENDPOINT/exec',
  GIB_PROMOTIONS_TEST_BRIDGE_SECRET:'SYNTHETIC_PRIVATE_BRIDGE_01234567890123456789',
  GIB_PROMOTIONS_TEST_DEVICE_SECRET:'SYNTHETIC_PRIVATE_DEVICE_01234567890123456789',
  GIB_PROMOTIONS_TEST_INSTALL_SECRET:'SYNTHETIC_PRIVATE_INSTALL_01234567890123456789',GIB_PROMOTIONS_TEST_INSTALL_RUN_ID:'synthetic-api-proof-20260914',
  GIB_PROMOTIONS_TEST_API_ENABLED:'true',GIB_PROMOTIONS_TEST_API_SETUP_ENABLED:'true',GIB_PROMOTIONS_TEST_API_DEPLOYMENT_ID:'SYNTHETIC_API_DEPLOYMENT_123456789',
  GIB_PROMOTIONS_TEST_API_CLIENT_ID:'12345678-synthetic.apps.googleusercontent.com',GIB_PROMOTIONS_TEST_API_CLIENT_SECRET:'SYNTHETIC_PRIVATE_CLIENT_SECRET_0123456789',
  GIB_PROMOTIONS_TEST_API_OWNER_EMAIL:'revbjjops@gmail.com',GIB_PROMOTIONS_TEST_API_WORKBOOK_ID:'SYNTHETIC_TEST_WORKBOOK_123456789'
};
const runtime=promotionsRuntimeConfig(ENV,{siteId:SITE,installationId:'rev',requestOrigin:API_TEST_ORIGIN});
const CONFIG=promotionsApiConfig(ENV,runtime);
const device=createProductionDeviceCredential(ENV.GIB_PROMOTIONS_TEST_DEVICE_SECRET,size=>Buffer.alloc(size,0x36),NOW);
const privateAccess='SYNTHETIC_PRIVATE_ACCESS_TOKEN';
const privateRefresh='SYNTHETIC_PRIVATE_REFRESH_TOKEN';
const fingerprint=value=>createHash('sha256').update(value).digest('hex');
test('Netlify can extract OAuth routes as literal strings without resolving runtime imports',()=>{
  const source=readFileSync(new URL('../netlify/functions/m1-promotions-api-oauth.mts',import.meta.url),'utf8');
  const pathLiteral=source.match(/export\s+const\s+config\s*=\s*\{\s*path\s*:\s*(\[[^\]]*\])/u)?.[1];
  assert.ok(pathLiteral,'the exported configuration must contain a literal path array');
  assert.deepEqual(JSON.parse(pathLiteral.replace(/'/gu,'"')),[API_OAUTH_PATH,API_CALLBACK_PATH]);
});
function memoryStore(){
  const records=new Map();const writes=[];let revision=0;
  return{records,writes,async getWithMetadata(key){return records.get(key)||null;},async set(key,value,condition){
    assert.ok(condition?.onlyIfNew===true||typeof condition?.onlyIfMatch==='string');
    const previous=records.get(key);writes.push({key,value,condition});
    if(condition.onlyIfNew&&previous||condition.onlyIfMatch&&previous?.etag!==condition.onlyIfMatch)return{modified:false};
    const record={data:JSON.parse(value),etag:String(++revision)};records.set(key,record);return{modified:true};
  }};
}
function request(operation='status',overrides={}){
  return new Request(API_TEST_ORIGIN+API_OAUTH_PATH,{method:'POST',headers:{Host:new URL(API_TEST_ORIGIN).host,Origin:API_TEST_ORIGIN,
    'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',Cookie:'__Host-gib_m1_promotions_test_device='+device,...overrides.headers},
    body:JSON.stringify(overrides.body||{operation}),...(overrides.signal?{signal:overrides.signal}:{})});
}
function callback(start,overrides={}){
  const authorization=new URL(start.body.data.authorizationUrl);
  const url=new URL(API_TEST_ORIGIN+API_CALLBACK_PATH);url.searchParams.set('state',authorization.searchParams.get('state'));url.searchParams.set('code','SYNTHETIC_PRIVATE_AUTH_CODE');
  for(const[key,value]of Object.entries(overrides.query||{})){if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value);}
  return new Request(url,{headers:{Host:url.host,Cookie:start.cookie,'Sec-Fetch-Site':'cross-site',...overrides.headers},...(overrides.signal?{signal:overrides.signal}:{})});
}
async function body(response){return{status:response.status,headers:response.headers,body:await response.json()};}
function harness(changes={}){
  const store=changes.store||memoryStore();const calls=[];
  const deps={env:ENV,siteId:SITE,installationId:'rev',now:NOW,store,fetch:async(url,options)=>{
    calls.push({url,options});assert.equal(options.redirect,'manual');assert.ok(options.signal instanceof AbortSignal);
    if(url==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:privateAccess,refresh_token:privateRefresh,token_type:'Bearer',expires_in:3600,scope:API_SCOPES.join(' ')}));
    if(url==='https://www.googleapis.com/oauth2/v2/userinfo')return new Response(JSON.stringify({email:'revbjjops@gmail.com',verified_email:true}));
    if(url==='https://script.googleapis.com/v1/scripts/'+CONFIG.deploymentId+':run'){
      const value=JSON.parse(options.body);assert.equal(value.devMode,false);
      return new Response(JSON.stringify({done:true,response:{result:value.function==='configureTestReader'?{ok:true,status:'configured'}:
        {bridge:runtime.mode,target:'test',installation:'rev',requestNonce:value.parameters[0].payload.nonce,result:{ok:true,data:{testOnly:true}}}}}));
    }
    throw new Error('Unexpected fixture URL');
  },...changes};
  return{store,calls,deps,run:input=>handlePromotionsApiOAuth(input,deps)};
}
async function start(h){const response=await h.run(request('start'));const value=await body(response);assert.equal(value.status,200);return{...value,cookie:response.headers.get('set-cookie').split(';')[0]};}
async function connect(h){const pending=await start(h);const response=await h.run(callback(pending));assert.equal(response.status,303);assert.match(response.headers.get('location'),/result=connected$/u);return pending;}
function assertNoPrivate(value){const text=JSON.stringify(value);for(const secret of[privateAccess,privateRefresh,'SYNTHETIC_PRIVATE_AUTH_CODE',...Object.entries(ENV).filter(([key])=>key.endsWith('_SECRET')).map(([,value])=>value)])assert.equal(text.includes(secret),false);}
function readEnvelope(operation='bootstrap'){return createPromotionsEnvelope(runtime,device,operation==='readStudent'?{operation,studentId:'synthetic-student-1'}:{operation},NOW);}

test('API configuration is opt-in and pinned to the existing TEST site, exact preview and Ops account',()=>{
  assert.ok(CONFIG);assert.equal(CONFIG.enabled,true);assert.equal(CONFIG.setupEnabled,true);
  for(const patch of[{GIB_PROMOTIONS_TEST_API_ENABLED:'false',GIB_PROMOTIONS_TEST_API_SETUP_ENABLED:'false'},{GIB_PROMOTIONS_TEST_API_CLIENT_SECRET:''},
    {GIB_PROMOTIONS_TEST_API_OWNER_EMAIL:'other@gmail.com'},{GIB_PROMOTIONS_TEST_API_DEPLOYMENT_ID:'https://evil.invalid/'},
    {GIB_PROMOTIONS_TEST_API_CLIENT_ID:'wrong'}, {GIB_PROMOTIONS_TEST_SITE_ID:'other'}])assert.equal(promotionsApiConfig({...ENV,...patch},runtime),null);
  for(const patch of[{target:'live'},{installation:'richmond'},{origin:'https://deploy-preview-85--gib-live.netlify.app'},{origin:'https://gib-live.netlify.app'}])assert.equal(promotionsApiConfig(ENV,{...runtime,...patch}),null);
  assert.ok(promotionsApiConfig({...ENV,GIB_PROMOTIONS_TEST_API_ENABLED:'false'},runtime),'setup-only configuration is supported');
});

test('OAuth status/start require current TEST cookie and same-origin checks; missing secret reveals only configured=false to authorized status',async()=>{
  for(const operation of['status','start'])for(const headers of[{Cookie:''},{Origin:'https://evil.invalid'},{'Sec-Fetch-Site':'cross-site'},{Host:'evil.invalid'},{'Content-Type':'text/plain'}]){
    const h=harness();const response=await h.run(request(operation,{headers}));assert.equal(response.status,401);assert.equal(h.calls.length,0);assert.equal(h.store.writes.length,0);assertNoPrivate(await response.text());
  }
  const h=harness({env:{...ENV,GIB_PROMOTIONS_TEST_API_CLIENT_SECRET:''}});
  assert.deepEqual((await body(await h.run(request()))).body,{ok:true,data:{configured:false,connected:false,setupEnabled:true}});
  assert.equal((await h.run(request('start'))).status,503);assert.equal(h.calls.length,0);
  const normal=harness();assert.deepEqual((await body(await normal.run(request()))).body,{ok:true,data:{configured:true,connected:false,setupEnabled:true}});
});

test('start requests only approved scopes, offline consent, PKCE and a one-use browser-bound Lax cookie with encrypted state',async()=>{
  const h=harness();const pending=await start(h);const url=new URL(pending.body.data.authorizationUrl);
  assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.pathname,'/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'),API_SCOPES.join(' '));assert.equal(url.searchParams.get('include_granted_scopes'),'false');
  assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('prompt'),'consent');assert.equal(url.searchParams.get('login_hint'),'revbjjops@gmail.com');
  assert.equal(url.searchParams.get('redirect_uri'),API_TEST_ORIGIN+API_CALLBACK_PATH);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  for(const attribute of['Secure','HttpOnly','SameSite=Lax','Max-Age=600','Path=/'])assert.ok(pending.headers.get('set-cookie').includes(attribute));
  const key='rev/test/oauth-state/'+fingerprint(url.searchParams.get('state'));
  const raw=h.store.records.get(key).data;const state=decryptApiRecord(CONFIG,key,raw);
  assert.equal(state.browserHash,fingerprint(pending.cookie.split('=')[1]));assert.equal(state.status,'pending');assert.equal(state.expiresAt,NOW+600000);
  assert.equal(Buffer.from(fingerprint(state.verifier),'hex').toString('base64url'),url.searchParams.get('code_challenge'));
  assert.equal(JSON.stringify(raw).includes(state.verifier),false);assert.equal(JSON.stringify(raw).includes(state.browserHash),false);
  assertNoPrivate(pending.body);assert.equal(h.calls.length,0);
});

test('callback works without the Strict device cookie, verifies Ops, initializes only new TEST properties, and stores encrypted refresh credentials',async()=>{
  const h=harness();const pending=await connect(h);
  assert.equal(h.calls.length,3);assert.deepEqual(h.calls.map(call=>new URL(call.url).hostname),['oauth2.googleapis.com','www.googleapis.com','script.googleapis.com']);
  const tokenRequest=new URLSearchParams(h.calls[0].options.body);assert.equal(tokenRequest.get('client_secret'),ENV.GIB_PROMOTIONS_TEST_API_CLIENT_SECRET);
  assert.equal(tokenRequest.get('redirect_uri'),CONFIG.redirectUri);assert.equal(tokenRequest.get('grant_type'),'authorization_code');assert.ok(tokenRequest.get('code_verifier'));
  assert.equal(h.calls[1].options.headers.Authorization,'Bearer '+privateAccess);
  const initializer=JSON.parse(h.calls[2].options.body);assert.equal(initializer.function,'configureTestReader');assert.equal(initializer.parameters.length,1);
  assert.deepEqual(initializer.parameters[0],{TEST_OWNER_EMAIL:CONFIG.ownerEmail,TEST_WORKBOOK_ID:CONFIG.workbookId,TEST_BRIDGE_ORIGIN:CONFIG.origin,
    TEST_BRIDGE_SECRET:runtime.bridgeSecret,TEST_BRIDGE_MODE:runtime.mode,TEST_BRIDGE_INSTALLATION:'rev'});
  const stored=h.store.records.get(API_CREDENTIAL_KEY);assert.ok(stored);assertNoPrivate(stored.data);
  const credential=decryptApiRecord(CONFIG,API_CREDENTIAL_KEY,stored.data);assert.equal(credential.refreshToken,privateRefresh);assert.equal(credential.initialized,true);
  assert.equal(Object.hasOwn(credential,'accessToken'),false);assert.equal(Object.hasOwn(credential,'clientSecret'),false);
  const status=await body(await h.run(request()));assert.deepEqual(status.body.data,{configured:true,connected:true,setupEnabled:true});assertNoPrivate(status.body);
  const repeat=await h.run(callback(pending));assert.match(repeat.headers.get('location'),/result=expired$/u);assert.equal(h.calls.length,3);
  assert.equal((await h.run(request('start'))).status,409);assert.equal(h.calls.length,3);
});

test('forged, duplicate, expired and racing callback state cannot exchange twice or change credentials',async()=>{
  for(const variant of['cookie','missing','expiry','duplicate']){
    const h=harness();const pending=await start(h);let input=callback(pending);
    if(variant==='cookie')input=callback(pending,{headers:{Cookie:'__Host-gib_m1_promotions_api_state='+'A'.repeat(43)}});
    if(variant==='missing')input=callback(pending,{query:{state:null}});
    if(variant==='expiry')h.deps.now=NOW+600001;
    if(variant==='duplicate'){const url=new URL(input.url);url.searchParams.append('state',url.searchParams.get('state'));input=new Request(url,{headers:input.headers});}
    const response=await h.run(input);assert.match(response.headers.get('location'),/result=expired$/u);assert.equal(h.calls.length,0);assert.equal(h.store.records.has(API_CREDENTIAL_KEY),false);
  }
  const h=harness();const pending=await start(h);
  const results=await Promise.all([h.run(callback(pending)),h.run(callback(pending))]);
  assert.equal(results.filter(response=>response.headers.get('location').endsWith('result=connected')).length,1);
  assert.equal(h.calls.length,3);assert.equal(h.store.writes.filter(write=>write.key===API_CREDENTIAL_KEY).length,1);
});

test('wrong identity, denied or expanded scope and missing refresh token fail before initializer; failed initializer never stores a credential',async()=>{
  for(const variant of['other-owner','unverified','scope-extra','scope-missing','no-refresh','initializer-error','initializer-timeout','denied']){
    const h=harness();const original=h.deps.fetch;
    h.deps.fetch=async(url,options)=>{
      const response=await original(url,options);const value=await response.json();
      if(url.includes('/token')){
        if(variant==='scope-extra')value.scope+=' https://www.googleapis.com/auth/drive';
        if(variant==='scope-missing')value.scope=API_SCOPES[0];if(variant==='no-refresh')delete value.refresh_token;
      }
      if(url.includes('/userinfo')){if(variant==='other-owner')value.email='other@gmail.com';if(variant==='unverified')value.verified_email=false;}
      if(url.includes(':run')){if(variant==='initializer-error')return new Response(JSON.stringify({done:true,error:{message:'SYNTHETIC_PRIVATE_ERROR'}}));if(variant==='initializer-timeout')throw new DOMException('SYNTHETIC_PRIVATE_ERROR','TimeoutError');}
      return new Response(JSON.stringify(value));
    };
    const pending=await start(h);const response=await h.run(callback(pending,variant==='denied'?{query:{error:'access_denied',code:null}}:{}));
    assert.equal(response.status,303);assert.equal(h.store.records.has(API_CREDENTIAL_KEY),false);assertNoPrivate([...response.headers]);
    assert.ok(response.headers.get('location').endsWith('result=denied')||response.headers.get('location').endsWith('result=failed'));
    if(['other-owner','unverified','scope-extra','scope-missing','no-refresh','denied'].includes(variant))assert.equal(h.calls.some(call=>call.url.includes(':run')),false);
    const previous=h.calls.length;await h.run(callback(pending));assert.equal(h.calls.length,previous,'failed code/state is not replayed');
  }
});

test('at-rest encryption rejects changed ciphertext and cross-client, site, workbook, deployment or record substitution',()=>{
  const value={refreshToken:privateRefresh};const encrypted=encryptApiRecord(CONFIG,API_CREDENTIAL_KEY,value);
  assertNoPrivate(encrypted);assert.deepEqual(decryptApiRecord(CONFIG,API_CREDENTIAL_KEY,encrypted),value);
  const damaged={...encrypted,ciphertext:(encrypted.ciphertext[0]==='A'?'B':'A')+encrypted.ciphertext.slice(1)};
  assert.throws(()=>decryptApiRecord(CONFIG,API_CREDENTIAL_KEY,damaged),{code:'STORE'});
  for(const field of['origin','siteId','clientId','deploymentId','workbookId','ownerEmail','installSecret'])assert.throws(()=>decryptApiRecord({...CONFIG,[field]:CONFIG[field]+'different'},API_CREDENTIAL_KEY,encrypted),{code:'STORE'});
  assert.throws(()=>decryptApiRecord(CONFIG,'another-key',encrypted),{code:'STORE'});
});

test('API reads refresh server authorization once and call only the pinned read function with the original fresh envelope',async()=>{
  const h=harness();await connect(h);h.calls.length=0;
  const signals=[];const original=h.deps.fetch;h.deps.fetch=(url,options)=>{signals.push(options.signal);return original(url,options);};
  const nonces=[];
  for(const operation of['bootstrap','readStudent']){
    const envelope=readEnvelope(operation);nonces.push(envelope.payload.nonce);const signal=AbortSignal.timeout(1000);
    const result=await runPromotionsApiRead(envelope,CONFIG,{...h.deps,signal});
    assert.equal(result.wrapper.requestNonce,envelope.payload.nonce);assert.equal(result.wrapper.result.ok,true);
    assert.deepEqual(result.diagnostics,{phase:'complete',ms:result.diagnostics.ms,errorCode:'none',attempts:1});assertNoPrivate(result.diagnostics);
    const token=new URLSearchParams(h.calls.at(-2).options.body);assert.equal(token.get('grant_type'),'refresh_token');assert.equal(token.get('refresh_token'),privateRefresh);
    const sent=JSON.parse(h.calls.at(-1).options.body);assert.equal(sent.function,'readPromotions');assert.equal(sent.devMode,false);assert.deepEqual(sent.parameters,[envelope]);
    assert.equal(signals.at(-2),signal);assert.equal(signals.at(-1),signal);
  }
  assert.equal(h.calls.length,4);assert.notEqual(nonces[0],nonces[1]);
  for(const operation of['recordPromotion','confirmRank','registerStudent','correctLatest','checkSave'])await assert.rejects(runPromotionsApiRead(readEnvelope(operation),CONFIG,h.deps),{code:'CONFIG'});
  assert.equal(h.calls.length,4);
});

test('revocation, access denial, redirects, timeout and malformed API replies fail closed with no logical retry or fallback',async()=>{
  for(const variant of['revoked','401','scope','redirect','timeout','api-error','not-done','large','bad-json']){
    const h=harness();await connect(h);h.calls.length=0;const original=h.deps.fetch;
    h.deps.fetch=async(url,options)=>{
      const normal=await original(url,options);
      if(url.includes('/token')){
        if(variant==='revoked')return new Response(JSON.stringify({error:'invalid_grant',error_description:'SYNTHETIC_PRIVATE_ERROR'}),{status:400});
        if(variant==='scope')return new Response(JSON.stringify({access_token:privateAccess,token_type:'Bearer',expires_in:3600,scope:API_SCOPES.join(' ')+' profile'}));
      }
      if(url.includes(':run')){
        if(variant==='401')return new Response('{"error":"SYNTHETIC_PRIVATE_ERROR"}',{status:401});
        if(variant==='redirect')return new Response('',{status:302,headers:{location:'https://evil.invalid/PRIVATE_TOKEN'}});
        if(variant==='timeout')throw new DOMException('SYNTHETIC_PRIVATE_ERROR','TimeoutError');
        if(variant==='api-error')return new Response('{"done":true,"error":{"message":"SYNTHETIC_PRIVATE_ERROR"}}');
        if(variant==='not-done')return new Response('{"done":false}');
        if(variant==='large')return new Response('A'.repeat(1000001));
        if(variant==='bad-json')return new Response('<html>SYNTHETIC_PRIVATE_ERROR</html>');
      }
      return normal;
    };
    const error=await runPromotionsApiRead(readEnvelope(),CONFIG,h.deps).then(()=>null,error=>error);
    assert.ok(error);assert.equal(error.diagnostics.attempts,1);assertNoPrivate({message:error.message,diagnostics:error.diagnostics});
    assert.equal(h.calls.length,['revoked','scope'].includes(variant)?1:2);assert.equal(h.calls.some(call=>call.url.includes('script.google.com')),false);
    if(variant==='revoked')assert.equal(error.code,'TOKEN_REVOKED');if(variant==='timeout')assert.equal(error.code,'TIMEOUT');
  }
});

test('one shared deadline cancels stalled response bodies and storage; no post-deadline store mutation begins',async()=>{
  const h=harness();await connect(h);h.calls.length=0;
  const abort=new AbortController();let cancelled=false;const original=h.deps.fetch;
  h.deps.fetch=async(url,options)=>url.includes(':run')?new Response(new ReadableStream({start(){setImmediate(()=>abort.abort(new DOMException('PRIVATE_TIMEOUT','TimeoutError')));},cancel(){cancelled=true;}})):original(url,options);
  await assert.rejects(runPromotionsApiRead(readEnvelope(),CONFIG,{...h.deps,signal:abort.signal}),{code:'TIMEOUT'});assert.equal(cancelled,true);
  const storeAbort=new AbortController();const hanging={getWithMetadata:()=>new Promise(()=>{}),set:()=>{throw new Error('must not write');}};
  const pending=runPromotionsApiRead(readEnvelope(),CONFIG,{store:hanging,signal:storeAbort.signal});setImmediate(()=>storeAbort.abort(new DOMException('PRIVATE_TIMEOUT','TimeoutError')));
  await assert.rejects(pending,{code:'TIMEOUT'});
  let writes=0;const bound=await apiStore({store:{getWithMetadata:async()=>null,set:async()=>{writes++;return{modified:true};}}},storeAbort.signal).catch(error=>error);
  assert.equal(bound.name,'TimeoutError');assert.equal(writes,0);
  const laterAbort=new AbortController();let reads=0;
  const created=await apiStore({store:{getWithMetadata:async()=>{reads++;return null;},set:async()=>{writes++;return{modified:true};}}},laterAbort.signal);
  laterAbort.abort(new DOMException('PRIVATE_TIMEOUT','TimeoutError'));
  await assert.rejects(created.getWithMetadata('key'),{name:'TimeoutError'});
  await assert.rejects(created.set('key','value',{onlyIfNew:true}),{name:'TimeoutError'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,0);assert.equal(writes,0);
});

test('callback cancellation before initialization confirmation cannot store a credential',async()=>{
  const h=harness();const pending=await start(h);const abort=new AbortController();const original=h.deps.fetch;
  h.deps.signal=abort.signal;
  h.deps.fetch=async(url,options)=>{
    if(url.includes(':run'))return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});setImmediate(()=>abort.abort(new DOMException('PRIVATE_TIMEOUT','TimeoutError')));});
    return original(url,options);
  };
  const response=await h.run(callback(pending));assert.match(response.headers.get('location'),/result=failed$/u);assert.equal(h.store.records.has(API_CREDENTIAL_KEY),false);
});

test('callback failure preserves only safe phase/code/time, scope facts and HTTP status in log and redirect',async t=>{
  const logs=[];t.mock.method(console,'info',value=>logs.push(JSON.parse(value)));
  for(const variant of ['scope','api-http','state','identity','token-network']){
    const h=harness();const original=h.deps.fetch;
    h.deps.fetch=async(url,options)=>{
      if(variant==='api-http'&&url.includes(':run'))return new Response(JSON.stringify({message:privateAccess,url:privateRefresh}),{status:403});
      if(variant==='token-network'&&url.includes('/token'))throw new Error(privateAccess);
      const response=await original(url,options);const value=await response.json();
      if(variant==='scope'&&url.includes('/token'))value.scope+=' openid '+privateAccess;
      if(variant==='identity'&&url.includes('/userinfo'))value.email=privateAccess;
      return new Response(JSON.stringify(value));
    };
    const pending=await start(h);const response=await h.run(callback(pending,variant==='state'?{query:{state:null}}:{}));
    const query=new URL(response.headers.get('location')).searchParams;const record=logs.at(-1);
    assert.equal(record.kind,'GIB_TEST_API_OAUTH_FAILURE');assert.equal(response.status,303);assertNoPrivate([...response.headers]);assertNoPrivate(record);
    assert.ok(Number.isInteger(record.ms)&&record.ms>=0&&record.ms<=3600000);assert.equal(query.get('ms'),String(record.ms));
    assert.equal(query.get('phase'),record.phase);assert.equal(query.get('code'),record.code);assert.equal(h.store.records.has(API_CREDENTIAL_KEY),false);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    if(variant==='scope'){
      assert.equal(record.phase,'token');assert.equal(record.code,'TOKEN_SCOPE');assert.equal(record.expectedScopesPresent,true);assert.equal(record.unexpectedScopeCount,2);assert.equal(record.openidPresent,true);
      assert.equal(query.get('expectedScopesPresent'),'true');assert.equal(query.get('unexpectedScopeCount'),'2');assert.equal(query.get('openidPresent'),'true');
      assert.equal(h.calls.some(call=>call.url.includes('/userinfo')||call.url.includes(':run')),false,'scope validation still blocks before identity/initialization');
    }
    if(variant==='api-http'){assert.equal(record.phase,'api');assert.equal(record.code,'ACCESS_DENIED');assert.equal(record.httpStatus,403);assert.equal(query.get('httpStatus'),'403');}
    if(variant==='state'){assert.equal(record.phase,'state');assert.equal(record.code,'STATE');assert.equal(h.calls.length,0);}
    if(variant==='identity'){assert.equal(record.phase,'identity');assert.equal(record.code,'TOKEN_IDENTITY');}
    if(variant==='token-network'){assert.equal(record.phase,'token');assert.equal(record.code,'NETWORK');}
    for(const name of ['state','cookie','url','scope','message','accessToken','refreshToken'])assert.equal(query.has(name),false);
  }
  assert.equal(logs.length,5);
});

test('diagnostic formatter rejects unknown error properties and logging failure cannot change callback handling',async t=>{
  const malformed=Object.assign(apiError(privateAccess,privateRefresh),{httpStatus:privateAccess,scope:privateRefresh,message:privateAccess,unexpectedScopeCount:privateAccess});
  assert.deepEqual(safeOAuthFailureDiagnostic(malformed,'setup',Infinity),{phase:'other',code:'OTHER',ms:0});
  for(const patch of [{unexpectedScopeCount:21},{openidPresent:privateAccess},{expectedScopesPresent:'true'},{httpStatus:600}]){
    const error=Object.assign(apiError('TOKEN_SCOPE','token'),{expectedScopesPresent:true,unexpectedScopeCount:1,openidPresent:true,...patch,private:privateAccess});
    const record=safeOAuthFailureDiagnostic(error,'setup',-10);assertNoPrivate(record);assert.equal(record.ms,0);assert.equal(record.httpStatus,undefined);
    if(!Object.hasOwn(patch,'httpStatus'))assert.deepEqual(Object.keys(record).sort(),['code','ms','phase']);
  }
  t.mock.method(console,'info',()=>{throw new Error(privateAccess);});
  const h=harness();const pending=await start(h);const response=await h.run(callback(pending,{query:{state:null}}));
  assert.equal(response.status,303);assert.equal(new URL(response.headers.get('location')).searchParams.get('code'),'STATE');
  assert.equal(h.calls.length,0);assert.equal(h.store.records.has(API_CREDENTIAL_KEY),false);
});
