import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { digestHash } from '../netlify/functions/_lib/m1-attendance-digest.mjs';
import { REPLY_HEADERS, HEALTH_HEADERS, RECEIPT_HEADERS, PROJECTION_SCHEMA } from '../netlify/functions/_lib/m1-reply-projection.mjs';
const source = readFileSync(new URL('../integrations/google-apps-script/GibM1ReplyProjection.gs', import.meta.url), 'utf8');
const NOW = 1791720000000, ID = '11111111-1111-4111-8111-111111111111', SHEET = 'approved_business_sheet_id_1234567890', OWNER = 'revbjjops@gmail.com';
const plain = v => JSON.parse(JSON.stringify(v));
test('hosted verifier needs no Node or crypto and matches independent SHA256 vectors including Unicode',()=>{
  const context={}; vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../tools/m1-reply-sheet-portable.js',import.meta.url),'utf8'),context);
  assert.equal(context.GibReplySheetVerifier.hash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for(const value of ['', '😀 Kids’ BJJ', '\ud800',...Array.from({length:140},(_,i)=>'λ=x'.repeat(i)),{rows:[['rev',false,123,'=SUM(A1)']]}]) assert.equal(context.GibReplySheetVerifier.hash(value),digestHash(value));
});
function harness(gym = 'rev') {
  const name = gym === 'rev' ? 'Revolution' : 'Richmond', calls = [], contents = new Map();
  const props = new Map([['GIB_M1_REPLY_REVIEW_SHEET_ID', SHEET], ['GIB_M1_REPLY_PROJECTION_ENABLED', 'true']]);
  const tabs = [{sheetId:1,title:name+' Replies',gridProperties:{rowCount:1000,columnCount:26}}, {sheetId:2,title:name+' Health',gridProperties:{rowCount:1000,columnCount:26}}];
  let now = NOW, released = 0;
  const state = { shared:false, owner:OWNER, extraPermission:false, nextPage:false, failWrite:false, corruptRead:false, busy:false, failPost:false };
  const row = [gym, 'a'.repeat(64), 'b'.repeat(64), ID, NOW, 'manager@example.invalid', 'abcdef1234567890', 'abcdef1234567891', 'c'.repeat(64), 'needs-review', 'received', '=IMPORTXML("https://example.invalid", "//x")', false, false, '[]', '[]', ID];
  row.push(digestHash(row));
  const health = HEALTH_HEADERS.map(()=> ''); Object.assign(health,{0:'current',1:gym,2:'healthy',3:NOW,4:NOW-120000,7:ID,8:NOW,9:1,10:digestHash([row]),11:0,12:digestHash([]),13:'d'.repeat(64),14:'ready'});health[21]=digestHash(health.slice(0,-1));
  const snapshot = {ok:true,schema:PROJECTION_SCHEMA,gym,generation:ID,tabs:{replies:tabs[0].title,health:tabs[1].title},replyHeaders:REPLY_HEADERS,healthHeaders:HEALTH_HEADERS,receiptHeaders:RECEIPT_HEADERS,replies:[row],health:[health]};
  const context = { GIB_M1_REPLY_SCHEMA_:'m1-reply-intake/v1', GIB_M1_REPLY_MAILBOX_:OWNER,
    Date:{now:()=>now}, PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k)})},
    LockService:{getUserLock:()=>({tryLock:()=>!state.busy,releaseLock:()=>released++}),getScriptLock:()=>{throw Error('Must not acquire outgoing/attendance ScriptLock');}},
    ScriptApp:{getOAuthToken:()=> 'fake-google-only-token'},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},getUuid:()=>ID,computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()],newBlob:v=>({getBytes:()=>Buffer.from(v)})},
    gibM1ReplyScope_:()=>({gym,target:'production'}),
    gibM1ReplyPost_:(_,input)=>{if(state.failPost)throw Error('Netlify down');return plain({...snapshot,projectionFaultAccepted:input.projectionFault?digestHash(input.projectionFault):null});},
    UrlFetchApp:{fetch:(url,options)=>{
      calls.push({url,options:plain(options)}); assert.ok(/^https:\/\/(?:www|sheets)\.googleapis\.com\//.test(url)); assert.equal(options.followRedirects,false);
      let data;
      if(url.includes('/permissions?'))data={permissions:[{type:'user',role:'owner',emailAddress:state.owner},...(state.extraPermission?[{type:'anyone',role:'reader'}]:[])],...(state.nextPage?{nextPageToken:'more'}:{})};
      else if(url.includes('/drive/v3/files/'))data={id:SHEET,mimeType:'application/vnd.google-apps.spreadsheet',shared:state.shared,owners:[{emailAddress:state.owner}]};
      else if(url.endsWith(':batchUpdate')) {
        if(state.failWrite)return{getResponseCode:()=>503,getContentText:()=>'{"error":"unavailable"}'};
        const body=JSON.parse(options.payload);assert.ok(body.requests.every(r=>[1,2].includes((r.updateCells?.range||r.updateSheetProperties?.properties).sheetId)));
        for(const request of body.requests) if(request.updateCells){const update=request.updateCells; contents.set(update.range.sheetId,update.rows.map(r=>r.values.map(c=>{
          assert.ok(!('formulaValue' in c.userEnteredValue));return Object.values(c.userEnteredValue)[0];})));}
        data={};
      } else if(url.includes('/values:batchGet?')) { data={valueRanges:[1,2].map(id=>({values:plain(contents.get(id))}))}; if(state.corruptRead)data.valueRanges[0].values[1][11]='corrupt'; }
      else data={spreadsheetId:SHEET,sheets:tabs.map(properties=>({properties}))};
      return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(data)};
    }} };
  vm.createContext(context);vm.runInContext(source,context);
  return { context, props, state, calls, contents, advance:()=>now+=3600000, released:()=>released };
}
for(const gym of ['rev','richmond'])test(gym+' projection writes literal cells to only its approved tabs and reads back hashes',()=>{
  const h=harness(gym),result=h.context.publishBusinessAttendanceReplyProjection();
  assert.equal(result.ok,true);assert.equal(h.contents.get(1)[1][11],'=IMPORTXML("https://example.invalid", "//x")');
  assert.equal(h.contents.get(2)[1][1],gym);assert.equal(h.calls.filter(c=>c.options.method==='post').length,1);assert.equal(h.released(),1);
  assert.equal(h.props.has('GIB_M1_REPLY_PROJECTION_FAULT'),false);
});
test('projection rejects wrong owner, public/shared, paginated permissions and missing destination before data writes',()=>{
  for(const patch of [{owner:'personal@example.invalid'},{shared:true},{extraPermission:true},{nextPage:true}]){
    const h=harness();Object.assign(h.state,patch);assert.throws(()=>h.context.publishBusinessAttendanceReplyProjection(),/PROJECTION_FAILED/);
    assert.equal(h.calls.some(c=>c.options.method==='post'),false);assert.equal(h.released(),1);
  }
  const h=harness();h.props.delete('GIB_M1_REPLY_REVIEW_SHEET_ID');assert.throws(()=>h.context.publishBusinessAttendanceReplyProjection(),/PROJECTION_FAILED/);assert.equal(h.calls.length,0);
});
test('projection remains off by default and a read-only destination check cannot write cells',()=>{
  const h=harness();h.props.delete('GIB_M1_REPLY_PROJECTION_ENABLED');assert.equal(h.context.publishBusinessAttendanceReplyProjection().enabled,false);assert.equal(h.calls.length,0);
  assert.equal(h.context.verifyBusinessReplyProjectionDestination().private,true);assert.equal(h.calls.some(c=>c.options.method==='post'),false);
});
test('failed write and unconfirmed readback retain an episode until recovery is canonically acknowledged',()=>{
  for(const mode of ['failWrite','corruptRead','failPost']){
    const h=harness();h.state[mode]=true;assert.throws(()=>h.context.publishBusinessAttendanceReplyProjection(),/PROJECTION_FAILED/);
    let fault=JSON.parse(h.props.get('GIB_M1_REPLY_PROJECTION_FAULT'));assert.equal(fault.failureCount,1);assert.equal(fault.recoveredAt,'');
    h.advance();h.state[mode]=false;assert.equal(h.context.publishBusinessAttendanceReplyProjection().ok,true);
    fault=JSON.parse(h.props.get('GIB_M1_REPLY_PROJECTION_FAULT'));assert.equal(fault.recoveredAt,NOW+3600000);
    h.advance();h.context.publishBusinessAttendanceReplyProjection();assert.equal(h.props.has('GIB_M1_REPLY_PROJECTION_FAULT'),false);
  }
});
test('a new failure during pending recovery remains in the same retained episode until acknowledged',()=>{
  const h=harness();h.state.failWrite=true;assert.throws(()=>h.context.publishBusinessAttendanceReplyProjection());h.state.failWrite=false;h.advance();h.context.publishBusinessAttendanceReplyProjection();
  h.advance();h.state.failPost=true;assert.throws(()=>h.context.publishBusinessAttendanceReplyProjection());
  const fault=JSON.parse(h.props.get('GIB_M1_REPLY_PROJECTION_FAULT'));assert.equal(fault.firstFailureAt,NOW);assert.equal(fault.lastFailureAt,NOW+7200000);assert.equal(fault.failureCount,2);assert.equal(fault.recoveredAt,'');
});
test('concurrent projection is explicit and never takes the outgoing ScriptLock',()=>{
  const h=harness();h.state.busy=true;assert.throws(()=>h.context.publishBusinessAttendanceReplyProjection(),/PROJECTION_BUSY/);assert.equal(h.calls.length,0);
});
