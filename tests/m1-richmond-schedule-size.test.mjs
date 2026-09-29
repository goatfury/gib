import assert from 'node:assert/strict';
import test from 'node:test';
import bootstrap from '../m1/richmond-schedule.json' with { type: 'json' };
import { RICHMOND_MAX_UPSTREAM_BYTES, RICHMOND_SCHEDULE_BLOCK_ID, parseRichmondScheduleHtml, richmondContentHash } from '../netlify/functions/_lib/m1-richmond-schedule-core.mjs';
import { fetchRichmondCurrentSchedule } from '../netlify/functions/_lib/m1-richmond-schedule.mjs';
import { assembleManagerRead } from '../netlify/functions/m1-manager-review.mjs';
import { deploymentInstallationProfile } from '../netlify/functions/_lib/m1-installation.mjs';
import { datesThrough } from '../netlify/functions/_lib/m1-manager-review.mjs';
const NOW=Date.parse('2026-09-29T18:00:00Z');
function html(bytes, unsafe='') {
  const paragraphs=Object.entries(bootstrap.days).map(([day,labels])=>`<p><strong>${day}</strong></p>`+labels.map(label=>{
    const [,start,,end,period,title]=/^(\d{1,2}:\d{2}) (AM|PM)–(\d{1,2}:\d{2}) (AM|PM) (.+)$/.exec(label);
    return `<p>${start}-${end}${period} - ${title}</p>`;
  }).join('')).join('');
  const content=`<!doctype html><html><body><div id="${RICHMOND_SCHEDULE_BLOCK_ID}"><div class="sqs-html-content">${paragraphs}${unsafe}</div></div><!--é 🥋--></body></html>`;
  return content+' '.repeat(bytes-Buffer.byteLength(content));
}
function streamResponse(text,{declared='43618',chunks=16381}={}) {
  const bytes=Buffer.from(text),state={offset:0,reads:0,cancelled:false};
  const body=new ReadableStream({pull(controller){state.reads++;if(state.offset===bytes.length){controller.close();return;}const end=Math.min(bytes.length,state.offset+chunks);controller.enqueue(bytes.subarray(state.offset,end));state.offset=end;},cancel(){state.cancelled=true;}},{highWaterMark:0});
  const response=new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Length':declared,'Content-Encoding':'gzip'}});
  return {response,state};
}
test('the measured legitimate 2.27 MB official-page shape parses the exact approved23 classes despite compressed length',async()=>{
  const expected=richmondContentHash(bootstrap.days),input=html(2268972);
  // Small chunks across the Unicode suffix exercise the streaming decoder
  // without paying millions of synthetic reads for irrelevant page padding.
  const split=Buffer.from(input.slice(0,input.indexOf('<!--'))),suffix=Buffer.from(input.slice(input.indexOf('<!--')));
  let phase=0,offset=0;
  const response=new Response(new ReadableStream({pull(c){if(phase++===0){c.enqueue(split);return;}if(offset<20){c.enqueue(suffix.subarray(offset,++offset));return;}c.enqueue(suffix.subarray(offset));c.close();}}),{headers:{'Content-Type':'text/html','Content-Length':'43618','Content-Encoding':'gzip'}});
  const result=await fetchRichmondCurrentSchedule(async(_url,options)=>{assert.equal(options.redirect,'manual');assert.ok(options.signal instanceof AbortSignal);return response;},NOW);
  assert.equal(result.contentHash,expected);assert.equal(Object.values(result.days).flat().length,23);assert.equal(result.fetchedAt,new Date(NOW).toISOString());
});
test('exact3MiB parses; a decoded stream over the cap cancels before reading its remaining body even with a tiny declared length',async()=>{
  assert.equal(RICHMOND_MAX_UPSTREAM_BYTES,3*1024*1024);
  assert.deepEqual(parseRichmondScheduleHtml(html(RICHMOND_MAX_UPSTREAM_BYTES)),bootstrap.days);
  const over=streamResponse(html(RICHMOND_MAX_UPSTREAM_BYTES+131072),{declared:'1',chunks:65536});
  await assert.rejects(()=>fetchRichmondCurrentSchedule(async()=>over.response,NOW),e=>e.code==='oversized-response');
  assert.equal(over.state.cancelled,true);assert.ok(over.state.offset<=RICHMOND_MAX_UPSTREAM_BYTES+65536);assert.ok(over.state.offset<RICHMOND_MAX_UPSTREAM_BYTES+131072);
  assert.throws(()=>parseRichmondScheduleHtml(html(RICHMOND_MAX_UPSTREAM_BYTES+1)),e=>e.code==='oversized-or-empty-upstream');
});
test('declared oversize, truncated stream and executable schedule markup remain rejected',async()=>{
  let read=false;
  await assert.rejects(()=>fetchRichmondCurrentSchedule(async()=>({ok:true,status:200,url:'',headers:new Headers({'Content-Type':'text/html','Content-Length':String(RICHMOND_MAX_UPSTREAM_BYTES+1)}),text:async()=>{read=true;return html(2268972);}}),NOW),e=>e.code==='oversized-response');assert.equal(read,false);
  const broken=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([60]));c.error(new Error('Synthetic interrupted body'));}}),{headers:{'Content-Type':'text/html'}});
  await assert.rejects(()=>fetchRichmondCurrentSchedule(async()=>broken,NOW),/Synthetic interrupted body/);
  const malicious=streamResponse(html(2268972,'<script>alert(1)</script>'));
  await assert.rejects(()=>fetchRichmondCurrentSchedule(async()=>malicious.response,NOW),e=>e.code==='executable-or-unexpected-markup');
});
test('normal manager assembly consumes the real fresh schedule dependency and remains unavailable on oversized fallback',async()=>{
  const scope={target:'test',profile:deploymentInstallationProfile('richmond','test')};
  const ledger={ok:true,complete:true,schema:'m1-manager-review/v1',target:'test',gym:'richmond',from:'2026-09-07',to:'2026-09-29',days:datesThrough('2026-09-29').map(date=>({date,attendanceHash:'a'.repeat(64),records:[],warnings:[],review:null}))};
  const memory=()=>({value:null,storedAt:0,lastAttemptAt:0,lastFailureReason:'',storageWarning:''});
  const deps={installationId:'richmond',environment:'test',now:NOW,store:null,memory:memory(),addedStore:{getWithMetadata:async()=>null},fetchImpl:async()=>streamResponse(html(2268972)).response};
  const request=new Request('https://gib-richmond-test.netlify.app/api/m1-manager-review');
  const result=await assembleManagerRead(ledger,request,scope,deps);assert.equal(result.ok,true);assert.equal(result.gym,'richmond');assert.equal(result.days.length,23);assert.equal(result.days.at(-1).classes.length,4);
  await assert.rejects(()=>assembleManagerRead(ledger,request,scope,{...deps,memory:memory(),fetchImpl:async()=>streamResponse(html(RICHMOND_MAX_UPSTREAM_BYTES+1)).response}),/Current schedule unavailable/);
});
