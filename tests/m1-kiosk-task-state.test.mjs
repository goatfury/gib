import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const html = readFileSync(new URL('../m1/index.html', import.meta.url), 'utf8');
const start = html.indexOf('  function kioskTaskState(');
const end = html.indexOf('  function renderKioskTaskStatus(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(html.slice(start, end), context);
const current = {canonical:{current:true,status:{reason:null,storageWarning:null}}};
const ready = {phase:'ready',localCount:0,cacheFailed:false};
function state(schedule=current, added=ready, phase='ready') {
  context.args=[schedule,added,phase];
  return vm.runInContext('kioskTaskState(...args)',context);
}
function plain(result) {
  assert.doesNotMatch(result.text, /revbjj-|richmondbjj-|\d{4}-\d{2}-\d{2}|fetched|hash|config|all.*upload|uploads.*complete|spreadsheet.*confirmed/iu);
}
test('available classes give one next action without alleging complete spreadsheet uploads',()=>{
  const result=state(); assert.equal(result.warning,false);
  assert.match(result.text,/name.*classes.*Sign In/u); plain(result);
});
test('unknown and fallback class checks remain a warning, without alleging missing attendance',()=>{
  for(const schedule of [{},{canonical:{current:false,status:{}}}]) {
    const result=state(schedule,ready,'error'); assert.equal(result.warning,true);
    assert.match(result.text,/could not be checked.*saved or backup.*confirm your class/u);
    assert.doesNotMatch(result.text,/missing.*sign.in|failed.*sign.in/iu); plain(result);
  }
});
test('server backup and tablet offline-cache failures retain their distinct evidence',()=>{
  let result=state({canonical:{current:true,status:{storageWarning:'last-known-good-storage-not-updated'}}});
  assert.equal(result.warning,true); assert.match(result.text,/backup could not be updated/u); assert.doesNotMatch(result.text,/on this tablet/u); plain(result);
  result=state({canonical:{current:true,status:{storageWarning:'browser-cache-not-updated'}}});
  assert.equal(result.warning,true); assert.match(result.text,/on this tablet for offline use/u); plain(result);
});
test('unconfirmed added classes and unshared local classes stay visible as separate limitations',()=>{
  for(const phase of ['failed','cached']) {
    const result=state(current,{phase,localCount:1,cacheFailed:true});
    assert.equal(result.warning,true); assert.match(result.text,/could not be checked.*may be out of date/u);
    assert.match(result.text,/could not be saved for offline use/u); assert.match(result.text,/saved only on this tablet/u); plain(result);
  }
});
test('disabled and overridden class schedules never masquerade as a current normal schedule',()=>{
  for(const mode of ['disabled','manual','url']) {
    const result=state({override:true,mode},ready); assert.equal(result.warning,true);
    assert.match(result.text,mode==='disabled'?/Classes are unavailable/u:/website updates are paused/u); plain(result);
  }
});
test('in-progress class checks remain an explicit checking state',()=>{
  const result=state(current,{phase:'loading',localCount:0},'loading');
  assert.equal(result.warning,false); assert.match(result.text,/Checking today.*saved schedule.*Checking added/u); plain(result);
});
