import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { fetchComparisonAutomatic, fetchComparisonHttps, readComparisonBody, comparisonErrorCode } from '../netlify/functions/_lib/promotions-transport-compare.mts';

const FIRST='https://script.google.com/macros/s/PRIVATE_DEPLOYMENT/exec';
const CONTENT='https://script.googleusercontent.com/macros/echo?user_content_key=PRIVATE%2f%2B+%252F&order=2&order=1#PRIVATE_fragment';
const diagnostics={
  hostCategory:url=>new URL(url).hostname==='script.google.com'?'google-script':new URL(url).hostname==='script.googleusercontent.com'?'google-content':'other',
  pathCategory:url=>new URL(url).pathname.endsWith('/exec')?'web-app-exec':new URL(url).pathname==='/macros/echo'?'content-response':'other',
  responseType:response=>response.headers.get('content-type')==='application/json'?'json':'other'
};
const options=signal=>({method:'POST',body:JSON.stringify({synthetic:'PRIVATE_ENVELOPE'}),headers:{'Content-Type':'application/json',Accept:'application/json'},signal,redirect:'follow'});
const rawHeaders=headers=>Object.entries(headers).flatMap(([key,value])=>[Buffer.from(key),Buffer.from(value)]);

function dispatcherHarness(replies) {
  const calls=[];
  const delegate={dispatch(opts,handler){
    const call={...opts,bytes:[]};calls.push(call);
    let stopped=false;
    handler.onConnect(error=>{stopped=true;if(error)handler.onError(error);});
    queueMicrotask(async()=>{
      try {
        if(opts.body)for await(const chunk of opts.body)call.bytes.push(Buffer.from(chunk));
        call.body=Buffer.concat(call.bytes).toString();
        const reply=typeof replies==='function'?replies(call,calls.length):replies[calls.length-1];
        if(stopped)return;
        handler.onHeaders(reply.status||200,rawHeaders(reply.headers||{}),()=>{},'OK');
        if(reply.body&&!stopped)handler.onData(Buffer.from(reply.body));
        if(!stopped)handler.onComplete([]);
      }catch(error){handler.onError(error);}
    });
    return true;
  }};
  return{calls,delegate};
}

test('B uses actual native automatic fetch and guards its 302 GET without rewriting the opaque content query',async()=>{
  const h=dispatcherHarness([{status:302,headers:{location:CONTENT}},{headers:{'content-type':'application/json'},body:'{"ok":true}'}]);
  const trace=[];const signal=AbortSignal.timeout(1000);
  const response=await fetchComparisonAutomatic(globalThis.fetch,FIRST,options(signal),trace,diagnostics,()=>h.delegate);
  assert.equal(await readComparisonBody(response,signal),'{"ok":true}');
  assert.equal(h.calls.length,2);assert.deepEqual(h.calls.map(call=>call.method),['POST','GET']);
  assert.equal(h.calls[0].body,options(signal).body);assert.equal(h.calls[1].body,'');
  assert.equal(h.calls[1].path,'/macros/echo?user_content_key=PRIVATE%2f%2B+%252F&order=2&order=1');
  assert.deepEqual(trace.map(hop=>[hop.status,hop.destination]),[[302,'google-content'],[200,'none']]);
  assert.equal(JSON.stringify(trace).includes('PRIVATE'),false);
});

test('B permits a Google 307 POST but refuses every foreign or unsafe redirect before dispatching its body',async()=>{
  for(const location of [CONTENT,'https://untrusted.invalid/PRIVATE','https://accounts.google.com/PRIVATE','http://script.google.com/PRIVATE','https://script.google.com:8443/PRIVATE','https://user:PRIVATE@script.google.com/PRIVATE']){
    const h=dispatcherHarness([{status:307,headers:{location}},{headers:{'content-type':'application/json'},body:'{"ok":true}'}]);
    const signal=AbortSignal.timeout(1000);const trace=[];
    if(location===CONTENT){
      const response=await fetchComparisonAutomatic(globalThis.fetch,FIRST,options(signal),trace,diagnostics,()=>h.delegate);
      await readComparisonBody(response,signal);
      assert.equal(h.calls.length,2);assert.equal(h.calls[1].method,'POST');assert.equal(h.calls[1].body,h.calls[0].body);
    }else{
      await assert.rejects(fetchComparisonAutomatic(globalThis.fetch,FIRST,options(signal),trace,diagnostics,()=>h.delegate));
      assert.equal(h.calls.length,1,'signed POST must never be forwarded to a denied redirect');
    }
    assert.equal(JSON.stringify(trace).includes('PRIVATE'),false);
  }
});

test('B keeps native redirect limit and cancellation with no logical retry or shared-pool mutation',async()=>{
  const h=dispatcherHarness(()=>({status:302,headers:{location:CONTENT}}));
  const trace=[];const signal=AbortSignal.timeout(1000);
  await assert.rejects(fetchComparisonAutomatic(globalThis.fetch,FIRST,options(signal),trace,diagnostics,()=>h.delegate));
  assert.equal(h.calls.length,21);assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
  const abort=new AbortController();abort.abort();
  await assert.rejects(fetchComparisonAutomatic(globalThis.fetch,FIRST,options(abort.signal),[],diagnostics,()=>{throw new Error('Must not get dispatcher for aborted request');}));
  assert.equal(Object.hasOwn(h.delegate,'destroy'),false);assert.equal(Object.hasOwn(h.delegate,'close'),false);
});

function httpsHarness(replies){
  const calls=[];
  const requestImpl=(url,init,callback)=>{
    const req=new EventEmitter();const connection=new EventEmitter();
    const incoming=new PassThrough();
    const call={url,init,req,incoming,destroyed:0,body:undefined};calls.push(call);
    req.reusedSocket=false;
    req.destroy=error=>{call.destroyed++;incoming.destroy(error);if(error)queueMicrotask(()=>req.emit('error',error));return req;};
    const aborted=()=>req.destroy(Object.assign(new Error('PRIVATE_CANCELLED'),{name:'AbortError',code:'ABORT_ERR'}));
    init.signal.addEventListener('abort',aborted,{once:true});
    incoming.on('close',()=>init.signal.removeEventListener('abort',aborted));
    incoming.on('error',()=>{});
    req.end=body=>{
      call.body=body;
      queueMicrotask(()=>{
        req.emit('socket',connection);connection.emit('lookup',null,'PRIVATE_ADDRESS',4,'PRIVATE_HOST');connection.emit('connect');connection.emit('secureConnect');
        const reply=typeof replies==='function'?replies(call,calls.length):replies[calls.length-1];
        if(reply.error){req.destroy(reply.error);return;}
        incoming.statusCode=reply.status||200;
        incoming.rawHeaders=Object.entries(reply.headers||{}).flat();
        callback(incoming);
        if(!reply.stall)incoming.end(reply.body||'');
        reply.afterHeaders?.();
      });
    };
    return req;
  };
  return{calls,requestImpl};
}

test('C creates verified fresh HTTPS connections, preserves each Location and records only safe milestone timings',async()=>{
  const h=httpsHarness([{status:302,headers:{location:CONTENT}},{headers:{'content-type':'application/json'},body:'{"ok":true}'}]);
  const signal=AbortSignal.timeout(1000);const trace=[],sockets=[];
  const response=await fetchComparisonHttps(FIRST,options(signal),trace,sockets,diagnostics,h.requestImpl);
  assert.equal(await readComparisonBody(response,signal),'{"ok":true}');
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].url,CONTENT);
  assert.deepEqual(h.calls.map(call=>call.init.method),['POST','GET']);assert.equal(h.calls[1].body,undefined);
  assert.deepEqual(h.calls[1].init.headers,{Accept:'application/json'});assert.ok(h.calls[0].destroyed>0);
  for(const call of h.calls){assert.equal(call.init.agent,false);assert.equal(call.init.rejectUnauthorized,true);assert.equal(call.init.signal,signal);}
  assert.equal(sockets.length,2);
  for(const socket of sockets){for(const field of ['dnsMs','connectMs','tlsMs','headersMs'])assert.ok(Number.isInteger(socket[field])&&socket[field]>=0);assert.equal(socket.reused,false);assert.equal(socket.errorCode,'none');}
  assert.equal(JSON.stringify({trace,sockets}).includes('PRIVATE'),false);
});

test('C preserves Google 307 bodies, blocks denied destinations and stops at 20 redirects without reusing a content URL',async()=>{
  for(const [location,status,allowed]of[[CONTENT,307,true],['https://untrusted.invalid/PRIVATE',307,false],['https://accounts.google.com/PRIVATE',302,false],['http://script.google.com/PRIVATE',302,false]]){
    const h=httpsHarness([{status,headers:{location}},{headers:{'content-type':'application/json'},body:'{"ok":true}'}]);
    const signal=AbortSignal.timeout(1000);const trace=[],sockets=[];
    if(allowed){const response=await fetchComparisonHttps(FIRST,options(signal),trace,sockets,diagnostics,h.requestImpl);await readComparisonBody(response,signal);assert.equal(h.calls[1].init.method,'POST');assert.equal(h.calls[1].body,h.calls[0].body);}
    else{await assert.rejects(fetchComparisonHttps(FIRST,options(signal),trace,sockets,diagnostics,h.requestImpl),{code:'REDIRECT_POLICY'});assert.equal(h.calls.length,1);assert.ok(h.calls[0].destroyed>0);}
    assert.equal(JSON.stringify({trace,sockets}).includes('PRIVATE'),false);
  }
  const loop=httpsHarness((_call,index)=>({status:302,headers:{location:CONTENT.replace('order=2',`order=${index}`)}}));
  await assert.rejects(fetchComparisonHttps(FIRST,options(AbortSignal.timeout(1000)),[],[],diagnostics,loop.requestImpl),{code:'REDIRECT_LIMIT'});
  assert.equal(loop.calls.length,21);assert.equal(new Set(loop.calls.map(call=>call.url)).size,21);assert.ok(loop.calls.every(call=>call.destroyed>0));
});

test('C deadline destroys a stalled request/body, with one attempt and no sensitive error details',async()=>{
  const abort=new AbortController();
  const h=httpsHarness([{headers:{'content-type':'application/json'},stall:true,afterHeaders:()=>setImmediate(()=>abort.abort())}]);
  const trace=[],sockets=[];
  const response=await fetchComparisonHttps(FIRST,options(abort.signal),trace,sockets,diagnostics,h.requestImpl);
  await assert.rejects(readComparisonBody(response,abort.signal));
  assert.equal(h.calls.length,1);assert.ok(h.calls[0].destroyed>0);assert.equal(h.calls[0].incoming.destroyed,true);
  assert.equal(JSON.stringify({trace,sockets}).includes('PRIVATE'),false);
});

test('C bounds decompressed bytes and destroys an oversized response; DNS/TLS errors are sanitized',async()=>{
  const h=httpsHarness([{headers:{'content-type':'application/json','content-encoding':'gzip'},body:gzipSync(Buffer.alloc(1000001,0x41))}]);
  const signal=AbortSignal.timeout(1000);
  const response=await fetchComparisonHttps(FIRST,options(signal),[],[],diagnostics,h.requestImpl);
  await assert.rejects(readComparisonBody(response,signal),{code:'BODY_TOO_LARGE'});
  assert.equal(h.calls.length,1);
  for(const code of ['ENOTFOUND','ERR_TLS_CERT_ALTNAME_INVALID','PRIVATE_UNKNOWN_CODE']){
    const h=httpsHarness([{error:Object.assign(new Error('PRIVATE_URL PRIVATE_ADDRESS'),{code})}]);
    const trace=[],sockets=[];
    await assert.rejects(fetchComparisonHttps(FIRST,options(signal),trace,sockets,diagnostics,h.requestImpl));
    assert.equal(sockets[0].errorCode,code==='PRIVATE_UNKNOWN_CODE'?'OTHER':code);assert.equal(sockets[0].headersMs,null);
    assert.equal(JSON.stringify({trace,sockets}).includes('PRIVATE'),false);assert.equal(h.calls.length,1);assert.ok(h.calls[0].destroyed>0);
  }
  assert.equal(comparisonErrorCode({cause:{code:'UND_ERR_CONNECT_TIMEOUT'}}),'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(comparisonErrorCode({name:'AbortError',code:'ABORT_ERR',cause:{name:'TimeoutError'}}),'TIMEOUT');
});
