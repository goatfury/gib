import { createPromotionsTransport } from './promotions-client.mjs?v=2026-09-14-promotions-repair-d';

const META_KEYS = ['arm','nodeVersion','undiciVersion','context','region','deploymentId','instanceId','invocation','warm','endpointHash','deadlineMs','maxResponseBytes','redirectLimit','errorCode'];
const SOCKET_KEYS = ['hop','dnsMs','connectMs','tlsMs','headersMs','reused','errorCode'];
const SAFE_CODES = new Set(['none','OTHER','ABORT_ERR','TIMEOUT','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ERR_STREAM_PREMATURE_CLOSE','BODY_TOO_LARGE','REDIRECT_POLICY','REDIRECT_LIMIT','CONTENT_ENCODING']);
const hash = (value,length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/u.test(value);
const ms = value => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 3600000;
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
export function comparisonMetadata(text) {
  try {
    if (typeof text !== 'string' || text.length > 4000) return null;
    const v=JSON.parse(text);
    if (!exact(v,META_KEYS) || !['preflight','A','B','C'].includes(v.arm)
      || !/^v?\d+\.\d+\.\d+$/u.test(v.nodeVersion) || !/^(?:\d+\.\d+\.\d+|unknown)$/u.test(v.undiciVersion)
      || !['production','deploy-preview','branch-deploy','dev','unknown'].includes(v.context)
      || !/^(?:[a-z]{2}(?:-[a-z]+)+-\d|unknown)$/u.test(v.region)
      || !(v.deploymentId==='unknown'||hash(v.deploymentId,24)) || !hash(v.instanceId,24) || !hash(v.endpointHash,64)
      || !Number.isSafeInteger(v.invocation) || v.invocation<1 || typeof v.warm!=='boolean'
      || v.deadlineMs!==25000 || v.maxResponseBytes!==1000000 || v.redirectLimit!==20 || !SAFE_CODES.has(v.errorCode)) return null;
    return v;
  } catch {return null;}
}
export function socketMetadata(text) {
  try {
    if (typeof text!=='string'||text.length>12000) return null;
    const v=JSON.parse(text);
    return Array.isArray(v)&&v.length<=21&&v.every(h=>exact(h,SOCKET_KEYS)&&Number.isSafeInteger(h.hop)&&h.hop>=1&&h.hop<=21
      &&['dnsMs','connectMs','tlsMs','headersMs'].every(k=>ms(h[k]))&&typeof h.reused==='boolean'&&SAFE_CODES.has(h.errorCode))?v:null;
  }catch{return null;}
}
export function withinComparisonBudget(state,now=Date.now()) {
  return state.attempts<12 && (!state.startedAt || now-state.startedAt<900000);
}

if (typeof document!=='undefined') {
  const status=document.getElementById('status'),results=document.getElementById('results'),preflight=document.getElementById('preflight');
  const buttons=[...document.querySelectorAll('[data-arm]')];
  const key='pr86-transport-comparison-20260914-1';
  let state={startedAt:null,attempts:0,preflight:null,records:[]},busy=false,active;
  try { const saved=JSON.parse(sessionStorage.getItem(key)); if(saved&&Number.isInteger(saved.attempts)&&Array.isArray(saved.records)) state=saved; } catch {}
  const allowed=location.origin==='https://deploy-preview-86--gib-live.netlify.app';
  function render() {
    results.textContent=JSON.stringify(state,null,2);
    preflight.disabled=!allowed||busy||Boolean(state.preflight);
    buttons.forEach(b=>{b.disabled=!allowed||busy||!state.preflight||!withinComparisonBudget(state);});
    sessionStorage.setItem(key,JSON.stringify(state));
  }
  async function run(arm) {
    if(!allowed||busy||arm!=='preflight'&&(!state.preflight||!withinComparisonBudget(state)))return;
    if(arm==='preflight'&&state.preflight)return;
    busy=true;active=new AbortController();
    if(arm!=='preflight'){state.startedAt??=Date.now();state.attempts+=1;}
    status.textContent=`Running ${arm}; ${state.attempts}/12 probes. No other request is running.`;render();
    let metadata=null,sockets=null,observation=null;
    const transport=createPromotionsTransport(async(url,options)=>{
      const response=await fetch(url,{...options,signal:AbortSignal.any([options.signal,active.signal]),headers:{...options.headers,'X-GIB-TEST-Transport':arm}});
      metadata=comparisonMetadata(response.headers.get('X-GIB-TEST-Comparison'));
      sockets=socketMetadata(response.headers.get('X-GIB-TEST-Socket-Trace'));
      return response;
    },{testOnly:true,onDiagnostic:record=>{observation=record;}});
    let ok=false;
    try{await transport({operation:'bootstrap'});ok=true;}catch{}finally{
      if(arm==='preflight'){if(ok&&metadata?.arm==='preflight'&&metadata.context==='deploy-preview')state.preflight=metadata;}
      else {const record={trial:state.attempts,arm,metadata,sockets,observation};state.records.push(record);console.info('Promotions TEST comparison',JSON.stringify(record));}
      busy=false;active=null;status.textContent=`${arm}: ${ok?'validated response':'failed'}. ${state.attempts}/12 probes retained.`;render();
    }
  }
  preflight.addEventListener('click',()=>run('preflight'));
  buttons.forEach(button=>button.addEventListener('click',()=>run(button.dataset.arm)));
  window.addEventListener('pagehide',()=>active?.abort());
  render();
  if(!allowed)status.textContent='This engineering harness is disabled outside the existing PR86 TEST origin.';
}
