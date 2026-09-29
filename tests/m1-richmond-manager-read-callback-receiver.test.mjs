import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
const NOW=Date.parse('2026-09-29T18:00:00Z'),ID='00000000-0000-4000-8000-000000000001';
const source=name=>readFileSync(new URL('../integrations/google-apps-script/'+name,import.meta.url),'utf8');
function harness(){
  const properties=new Map([['GIB_M1_RICHMOND_TEST_SPREADSHEET_ID','synthetic-richmond-sheet'],['GIB_M1_DEPLOYMENT_TARGET_LOCK','test'],['GIB_M1_INSTALLATION_LOCK','richmond'],['GIB_M1_ENVIRONMENT_LOCK','test'],['GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED','richmond-test-v1']]);
  const sent=[],logs=[];let locked=false,reads=0,acquired=0,released=0,clock=NOW,uuid=0;
  const options={lostReply:false,wrongSheet:false,busy:false};
  const ctx=vm.createContext({Date:class extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}},JSON,
    console:{log:x=>logs.push(x),warn:x=>logs.push(x)},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)||'',setProperty:(k,v)=>properties.set(k,v),getKeys:()=>[...properties.keys()],deleteProperty:k=>properties.delete(k)})},
    ScriptApp:{getScriptId:()=> 'synthetic-richmond-script'},
    LockService:{getScriptLock:()=>({tryLock(ms){assert.equal(ms,10000);assert.equal(locked,false);if(options.busy)return false;locked=true;acquired++;return true;},releaseLock(){assert.equal(locked,true);locked=false;released++;}})},
    SpreadsheetApp:{openById:id=>{assert.equal(id,'synthetic-richmond-sheet');return {getName:()=>options.wrongSheet?'RBJJ M1 — TEST':'Richmond BJJ M1 — TEST',getSheetByName:()=>null};},flush(){throw Error('No writes');}},
    ContentService:{MimeType:{JSON:'application/json'},createTextOutput:text=>{if(options.lostReply&&text.includes('CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE'))throw Error('PRIVATE ordinary reply failed');return{getContent:()=>text,setMimeType(){return this;}};}},
    Utilities:{Charset:{UTF_8:'utf8'},DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(alg,text)=>[...createHash(alg).update(text,'utf8').digest()],base64EncodeWebSafe:bytes=>Buffer.from(bytes).toString('base64url'),
      formatDate:()=> '2026-09-29',getUuid:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`,newBlob:text=>({getBytes:()=>[...Buffer.from(text,'utf8')]}),
      computeHmacSha256Signature(text,secret,charset){assert.equal(charset,'utf8');return [...createHmac('sha256',secret).update(text,'utf8').digest()];}},
    UrlFetchApp:{fetch(url,init){assert.equal(locked,false,'authoritative lock released before callback');sent.push({url,init});return{getResponseCode:()=>200,getContentText:()=>JSON.stringify({ok:true,accepted:true,requestId:ID})};},getRequest(){assert.equal(locked,false);return{};}}
  });
  for(const file of ['richmond-test/Code.gs','GibM1Receiver.gs','GibM1ManagerReview.gs','GibM1TestReadCallback.gs'])vm.runInContext(source(file),ctx,{filename:file});
  ctx.todayNewYork_=()=> '2026-09-29';ctx.signinsSheet_=()=>({});
  ctx.readSignins_=()=>{assert.equal(locked,true);reads++;return{records:[]};};
  const body=()=>({token:ctx.gibM1DerivedReceiverSecret_(),adminActionToken:ctx.gibM1DerivedAdminActionSecret_(),target:'test',installation:'richmond',environment:'test',action:'managerReviewReadCallback',gym:'richmond',from:'2026-09-07',to:'2026-09-29',adminName:'Trey Martin',binding:{schema:'m1-test-read-callback/v1',requestId:ID,target:'test',gym:'richmond',action:'managerReviewRead',from:'2026-09-07',to:'2026-09-29',createdAt:NOW,expiresAt:NOW+60000}});
  return{ctx,properties,sent,logs,options,body,post:value=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(value)}}).getContent()),counts:()=>({locked,reads,acquired,released}),clock:value=>clock=value};
}
test('actual locked Richmond wrapper reads through its ordinary attendance lock and delivers a complete gym-bound private callback',()=>{
  const h=harness(),body=h.body();h.ctx.testRichmondStartReadTrace();
  assert.deepEqual(h.post(body),{ok:false,code:'CALLBACK_PROOF_ORDINARY_REPLY_UNAVAILABLE'});assert.equal(h.sent.length,1);
  assert.deepEqual(h.counts(),{locked:false,reads:1,acquired:1,released:1});
  const {url,init}=h.sent[0],payload=JSON.parse(init.payload);assert.equal(url,'https://gib-richmond-test.netlify.app/api/m1-test-read-result');assert.deepEqual(payload.binding,body.binding);assert.equal(payload.result.gym,'richmond');assert.equal(payload.result.days.length,23);assert.equal(payload.result.complete,true);
  assert.equal(init.headers['X-GIB-M1-Read-Signature'],createHmac('sha256',body.adminActionToken).update('m1-test-read-callback/v1\n'+init.payload,'utf8').digest('hex'));assert.equal(init.followRedirects,false);
  const receipts=[...h.properties].filter(([k])=>k.startsWith('M1_TEST_READ_TRACE_V1_')).map(([,v])=>JSON.parse(v));assert.equal(receipts[0].acknowledged,true);assert.equal(receipts[0].requestId,ID);
  assert.doesNotMatch(JSON.stringify([receipts,h.logs]),/Trey|synthetic-richmond|https:/);assert.equal(h.ctx.gibM1TestReadCallbackEnabled_(),false,'Revolution fault/Staff/proof helpers remain off');
  assert.throws(()=>h.ctx.testRevolutionLateBadgeCallback());h.ctx.authorizeRichmondTestReadCallback();assert.equal(h.sent.length,1,'consent preparation sends no request');
});
test('Richmond badge uses no reviewer and ignores a broken ordinary reply after successful callback',()=>{
  const h=harness(),body=h.body();body.binding.action='managerReviewBadgeRead';delete body.adminName;h.options.lostReply=true;
  assert.equal(h.post(body).ok,false);assert.equal(h.sent.length,1);assert.equal(JSON.parse(h.sent[0].init.payload).result.gym,'richmond');assert.deepEqual(h.counts(),{locked:false,reads:1,acquired:1,released:1});
  const invented=harness(),bad=invented.body();bad.binding.action='managerReviewBadgeRead';invented.post(bad);assert.equal(invented.sent.length,0);assert.equal(invented.counts().reads,0);
});
test('Richmond read callback fails closed before data for wrong authentication, scope, binding, action, unknown fields and expired request',()=>{
  const changes=[b=>b.token='wrong',b=>b.adminActionToken='wrong',b=>b.gym='rev',b=>b.installation='rev',b=>b.environment='production',b=>b.target='production',b=>b.action='managerReviewReadCallbackProof',b=>b.binding.gym='rev',b=>b.binding.target='production',b=>b.binding.action='managerReviewSave',b=>b.binding.action='adminAdditionCheckRead',b=>b.binding.action='staffClockRead',b=>b.adminName='Unapproved User',b=>b.callbackUrl='https://example.invalid',b=>b.check={},b=>b.binding.extra=true,b=>b.binding.createdAt=NOW+1,b=>b.binding.expiresAt=NOW];
  for(const change of changes){const h=harness(),body=h.body();change(body);assert.equal(h.post(body).ok,false);assert.equal(h.sent.length,0);assert.equal(h.counts().reads,0);}
  for(const key of ['GIB_M1_DEPLOYMENT_TARGET_LOCK','GIB_M1_INSTALLATION_LOCK','GIB_M1_ENVIRONMENT_LOCK','GIB_M1_RICHMOND_TEST_PROVISIONING_CLOSED','GIB_M1_RICHMOND_TEST_SPREADSHEET_ID']){const h=harness(),body=h.body();h.properties.set(key,'wrong');h.post(body);assert.equal(h.sent.length,0);assert.equal(h.counts().reads,0);}
});
test('Richmond unavailable lock, wrong authoritative Sheet and incomplete read never deliver success or write',()=>{
  for(const mode of ['busy','wrongSheet','incomplete']){const h=harness();if(mode==='incomplete')h.ctx.readSignins_=()=>{throw Error('PRIVATE read failure');};else h.options[mode]=true;h.post(h.body());assert.equal(h.sent.length,0);assert.equal(h.counts().locked,false);}
});
