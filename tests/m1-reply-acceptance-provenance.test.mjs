import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { prepareReplyAcceptance } from '../netlify/functions/_lib/m1-reply-acceptance.mjs';
import { prepareReplyEvent, recordReplyPoll, replyQueue, replyEvent } from '../netlify/functions/_lib/m1-reply-intake.mjs';
import { replyProjection, verifyReplyProjection } from '../netlify/functions/_lib/m1-reply-projection.mjs';
const intake = readFileSync(new URL('../integrations/google-apps-script/GibM1ReplyIntake.gs',import.meta.url),'utf8');
const acceptance = readFileSync(new URL('../integrations/google-apps-script/GibM1ReplyAcceptance.gs',import.meta.url),'utf8');
const portable = {}; vm.createContext(portable);
vm.runInContext(readFileSync(new URL('../tools/m1-reply-sheet-portable.js',import.meta.url),'utf8'),portable);
const NOW=Date.parse('2026-10-11T01:00:00Z'), EVENT='33333333-3333-4333-8333-333333333333';
const uid=n=>'44444444-4444-4444-8444-'+String(n).padStart(12,'0');
const mailbox='revbjjops@gmail.com', manager=g=>g==='rev'?'info@revolutionbjj.com':'info@richmondbjj.com';
const plain=v=>JSON.parse(JSON.stringify(v));
const scope=gym=>({target:'production',profile:{installationId:gym,environment:'production',activation:'active'},liveFeatures:{reminders:true}});
function memory(){ const values=new Map();return{values,async getWithMetadata(k){return structuredClone(values.get(k)||null);},
  async list({prefix}){return{blobs:[...values.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};},
  async set(k,v,{onlyIfNew}={}){if(onlyIfNew&&values.has(k))return{modified:false};values.set(k,{data:JSON.parse(v),etag:String(values.size+1)});return{modified:true};}}; }
function normalize(gym,subject,body,when,n){
  const c={Utilities:{base64DecodeWebSafe:v=>Buffer.from(v,'base64url'),newBlob:v=>({getDataAsString:()=>Buffer.from(v).toString('utf8')})}};
  vm.createContext(c);vm.runInContext(intake,c); const headers=v=>Object.entries(v).map(([name,value])=>({name,value}));
  const threadId='abcdef0000000000',sent='<probe-parent@example.invalid>';
  const m={id:'abcdef12345678'+String(n).padStart(2,'0'),threadId,internalDate:String(when),payload:{mimeType:'text/plain',body:{data:Buffer.from(body).toString('base64url')},
    headers:headers({From:manager(gym),To:mailbox,Subject:'Re: '+subject,'Message-ID':'<probe-'+n+'@example.invalid>','In-Reply-To':sent,References:sent,
      'Authentication-Results':'mx.google.com; dmarc=pass header.from='+manager(gym).split('@')[1]})}};
  const thread={messages:[{id:'abcdef9999999999',threadId,labelIds:['SENT'],internalDate:String(NOW-900),payload:{headers:headers({From:mailbox,To:manager(gym),'Reply-To':mailbox,Subject:subject,'Message-ID':sent})}}]};
  return plain(c.gibM1ReplyNormalize_(m,thread,{gym}));
}
for(const gym of ['rev','richmond']){
  test(gym+' trusted TEST ONLY provenance survives phrase/plain/later-expired-lease replies through parent notices',async()=>{
    const store=memory(), env={GIB_M1_REPLY_INTAKE_ENABLED:'true',GIB_M1_REPLY_ACCEPTANCE_EVENT_ID:EVENT,GIB_M1_REPLY_ACCEPTANCE_START_AT:String(NOW-1000),GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT:String(NOW+1799000)};
    const registered=await prepareReplyAcceptance({schema:'m1-reply-intake/v1',action:'prepare-acceptance',gym,target:'production',eventId:EVENT,requestId:uid(1),createdAt:NOW,expiresAt:NOW+60000},scope(gym),env,NOW,
      (check,s,report)=>prepareReplyEvent(check,s,report,{replyStore:store}));
    const bodies=['ACCEPT '+gym.toUpperCase()+' - TEST ONLY; no attendance or payroll change.','Thanks, received.','Got it, thanks.'];
    for(let i=0;i<bodies.length;i++){
      const when=i===2?NOW+7200000:NOW+i*1000;
      const m=normalize(gym,registered.subject,bodies[i],when,i+1);
      await recordReplyPoll(store,gym,{requestId:uid(i+2),scanFrom:NOW-1000,scanThrough:when,createdAt:when,status:'complete',messages:[m]},when);
    }
    const end=NOW+7200000,queue=await replyQueue(store,gym,end);
    assert.equal(queue.items.length,3);
    for(const item of queue.items){assert.equal(item.testProvenance,'gib-reply-acceptance/v1');assert.equal(item.testLabel,'TEST ONLY');assert.equal(item.state,'no-attendance-question');assert.deepEqual(item.questions,[]);assert.ok(bodies.includes(item.body));}
    const snapshot=await replyProjection(store,gym,end,uid(8));
    assert.equal(snapshot.schema,'m1-reply-sheet/v2');assert.equal(snapshot.replyHeaders.length,19);
    for(const row of snapshot.replies){assert.equal(row[17],'TEST ONLY');assert.ok(bodies.includes(row[11]));}
    const input={gym,before:snapshot.health,replies:snapshot.replies,after:snapshot.health,now:end};
    const parent=plain(portable.GibReplySheetVerifier.verify(input));
    assert.deepEqual(parent,plain(verifyReplyProjection(input)));
    assert.equal(parent.replyNotices.length,3);
    for(const notice of parent.replyNotices){assert.equal(notice.testOnly,true);assert.equal(notice.label,'TEST ONLY');assert.match(notice.text,/^TEST ONLY - /);assert.ok(bodies.includes(notice.replyText));}
    assert.equal(parent.attendanceWritesEnabled,false);assert.equal(parent.payrollReleaseEnabled,false);
    const receipts=parent.replyNotices.map(n=>[gym,'reply',n.sourceId,n.sourceVersion,end,'persisted-owner-message']);
    assert.equal(portable.GibReplySheetVerifier.verify({...input,receipts}).replyNotices.length,0);
  });
  test(gym+' untrusted body or message field cannot label an ordinary event as a test',async()=>{
    const store=memory(), check={binding:{requestId:EVENT,jobDate:'2026-10-10',createdAt:NOW-1000},digest:{groups:[{gym,items:[]}]},snapshots:[],schedules:[]};
    const report=await prepareReplyEvent(check,scope(gym),{rendered:{subject:'Ordinary attendance',text:'',html:''}},{replyStore:store});
    const message={...normalize(gym,report.rendered.subject,'TEST ONLY',NOW,9),testProvenance:'gib-reply-acceptance/v1'};
    await recordReplyPoll(store,gym,{requestId:uid(9),scanFrom:NOW-1000,scanThrough:NOW,createdAt:NOW,status:'complete',messages:[message]},NOW);
    const queue=await replyQueue(store,gym,NOW);assert.equal(queue.items[0].testProvenance,undefined);
    const s=await replyProjection(store,gym,NOW,uid(10));assert.equal(s.replies[0][17],'');
    const out=portable.GibReplySheetVerifier.verify({gym,before:s.health,replies:s.replies,after:s.health,now:NOW});
    assert.equal(out.replyNotices[0].testOnly,false);assert.equal(out.replyNotices[0].replyText,'TEST ONLY');
    assert.throws(()=>replyEvent({...check,testProvenance:'forged'},scope(gym),{rendered:{subject:'Ordinary attendance'}}),/REPLY_EVENT_INVALID/);
  });
  test(gym+' one-time cutover init and continuation preserve older start/cursor independently of sender lease',()=>{
    const props=new Map(),writes=[],calls=[], c={Date:{now:()=>NOW},console:{log(){}},Utilities:{getUuid:()=>uid(11)},
      PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)??null,setProperty:(k,v)=>{writes.push(k);props.set(k,v);}})},
      LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
    vm.createContext(c);vm.runInContext(intake,c);vm.runInContext(acceptance,c);
    c.gibM1ReplyScope_=()=>({gym,target:'production'});
    const init=c.prepareBusinessReplyAcceptanceIntakeWindow();assert.equal(init.initialized,true);assert.equal(init.startAt,NOW);assert.deepEqual(writes,['GIB_M1_REPLY_START_AT']);
    props.set('GIB_M1_REPLY_START_AT',String(NOW-4*3600000));props.set('GIB_M1_REPLY_SCAN_THROUGH',String(NOW-3600000));props.set('GIB_M1_REPLY_INTAKE_ENABLED','true');
    props.set('GIB_M1_REPLY_ACCEPTANCE_START_AT',String(NOW-1000));props.set('GIB_M1_REPLY_ACCEPTANCE_EXPIRES_AT',String(NOW+1799000));
    writes.length=0;
    const resumed=c.prepareBusinessReplyAcceptanceIntakeWindow();assert.equal(resumed.initialized,false);assert.equal(resumed.startAt,NOW-4*3600000);assert.equal(resumed.scanThrough,NOW-3600000);assert.equal(resumed.senderSetupChanged,false);assert.deepEqual(writes,[]);
    c.gibM1ReplyGet_=path=>{calls.push(path);return path==='profile'?{emailAddress:mailbox}:{messages:[]};};
    c.gibM1ReplyPost_=(_,input)=>{assert.equal(input.scanFrom,NOW-3600000-600000);return{newRelevant:[],requestId:input.requestId};};
    assert.equal(c.pollBusinessAttendanceReplies().status,'complete');
    assert.equal(props.get('GIB_M1_REPLY_START_AT'),String(NOW-4*3600000));assert.equal(props.get('GIB_M1_REPLY_SCAN_THROUGH'),String(NOW-120000));
    assert.deepEqual(writes,['GIB_M1_REPLY_SCAN_THROUGH']);assert.equal(calls.length,2);
    assert.equal([...props.keys()].some(k=>k.startsWith('GIB_M1_REPLY_ACCEPTANCE_CLAIM')),false);
  });
  test(gym+' missing/invalid cutover with retained cursor is held without rewriting either value',()=>{
    for(const pair of [[null,String(NOW-3600000)],[String(NOW-60000),String(NOW-3600000)],['bad',null]]){
      const props=new Map([['GIB_M1_REPLY_START_AT',pair[0]],['GIB_M1_REPLY_SCAN_THROUGH',pair[1]]]),writes=[];
      const c={Date:{now:()=>NOW},gibM1ReplyScope_:()=>({gym,target:'production'}),PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)??null,setProperty:(k,v)=>writes.push([k,v])})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
      vm.createContext(c);vm.runInContext(acceptance,c);assert.throws(()=>c.prepareBusinessReplyAcceptanceIntakeWindow(),/REPLY_START_REQUIRED/);assert.deepEqual(writes,[]);
    }
  });
}
