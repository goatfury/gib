import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Execute the shipped client, with only the browser DOM and Google RPC boundary
// replaced. These ordering tests complement the real browser layout/input checks.
const html = readFileSync(new URL('../promotions/Index.html', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const source = html.match(/<script>([\s\S]*?)<\/script>/u)[1];
const formIds = [...html.match(/<form id="entryForm"[\s\S]*?<\/form>/u)[0].matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]);
const student = (id, revision = 1, marks = 1) => ({
  studentId:id, displayName:`TEST Student ${id}`, distinguishingLabel:`Group ${id}`,
  status:'active', rankKnown:true, belt:'White Belt', marks, markType:'stripes',
  revision, lastEventId:revision > 1 ? `event-${id}-${revision}` : '', legacyRefs:'', historyNote:''
});

function createHarness() {
  const elements = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.hidden = false;
      this.disabled = false; this.style = {}; this.attributes = new Map(); this.events = new Map(); this.text = '';
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    get firstElementChild() { return this.children[0]; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, handler) { this.events.set(type, handler); }
    querySelectorAll() { return formIds.map(id => elements.get(id)).filter(element => /^(INPUT|SELECT|TEXTAREA|BUTTON)$/u.test(element.tagName)); }
    scrollIntoView() {}
  }
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/gu)) {
    const element = new Element(match[1]);
    element.hidden = /\bhidden\b/u.test(match[0]);
    elements.set(match[2], element);
  }
  const requests = [];
  const context = vm.createContext({
    document:{ getElementById:id => elements.get(id), createElement:tag => new Element(tag) },
    crypto:webcrypto, Intl, Date, console,
    setTimeout:() => 1, clearTimeout:() => {},
    google:{ script:{ get run() {
      const call = {};
      const chain = {
        withSuccessHandler(handler) { call.success = handler; return chain; },
        withFailureHandler(handler) { call.failure = handler; return chain; },
        promotionRequest(payload) { call.payload = JSON.parse(JSON.stringify(payload)); requests.push(call); }
      };
      return chain;
    } } }
  });
  context.window = context;
  context.addEventListener = () => {};
  const marker = '  bootstrap();\n})();';
  assert.ok(source.includes(marker), 'Client bootstrap boundary is present');
  vm.runInContext(source.replace(marker, '  globalThis.client = { state, selectStudent, openDraft, readDraftControls, submitEntry, sendPending };\n' + marker), context);
  const take = (operation, id) => {
    const index = requests.findIndex(call => call.payload.operation === operation && (!id || call.payload.studentId === id));
    assert.ok(index >= 0, `Expected ${operation} RPC`);
    return requests.splice(index, 1)[0];
  };
  const respond = (call, data) => call.success({ ok:true, data });
  respond(take('bootstrap'), { testOnly:true, todayNY:'2026-09-13', recorderLabel:'Signed-in TEST manager', approvers:[{ id:'TEST-COACH-A', label:'TEST Coach Avery' }], students:[student('A'), student('B')] });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const choose = async (id, current = student(id), history = []) => {
    const promise = context.client.selectStudent(id);
    respond(take('readStudent', id), { student:current, history });
    await promise;
  };
  const beginStripe = () => {
    context.client.openDraft('stripe');
    elements.get('approverChoice').value = 'TEST-COACH-A';
    const promise = context.client.submitEntry({ preventDefault() {} });
    return { promise, call:take('recordPromotion') };
  };
  const saved = (call, current = student('A', 2, 2)) => ({
    student:current, viewPending:false,
    receipt:{ eventId:'event-A-2', requestId:call.payload.requestId, studentId:'A', revision:2,
      eventKind:'STRIPE', eventDateNY:'2026-09-13', before:student('A'), after:student('A', 2, 2),
      approverLabel:'TEST Coach Avery', recorderIdentity:'TEST manager', reason:'' }
  });
  return { context, elements, requests, take, respond, flush, choose, beginStripe, saved };
}

test('late A save after A→B→A retires the exact submitted draft rather than awarding again', async () => {
  const h = createHarness(); await h.flush(); await h.choose('A');
  const save = h.beginStripe();
  await h.choose('B');
  await h.choose('A', student('A', 2, 2));
  h.respond(save.call, h.saved(save.call)); await save.promise;
  assert.equal(h.context.client.state.draft, null);
  assert.equal(h.context.client.state.drafts.has('A'), false);
  assert.equal(h.elements.get('editor').hidden, true);
  await h.context.client.submitEntry({ preventDefault() {} });
  assert.equal(h.requests.filter(call => call.payload.operation === 'recordPromotion').length, 0);
});

test('precommit read returned after save confirmation cannot roll back rank or history', async () => {
  const h = createHarness(); await h.flush(); await h.choose('A');
  const save = h.beginStripe(); await h.choose('B');
  const readingA = h.context.client.selectStudent('A'); const staleRead = h.take('readStudent', 'A');
  h.respond(save.call, h.saved(save.call)); await save.promise;
  h.respond(staleRead, { student:student('A'), history:[] }); await readingA;
  assert.equal(h.context.client.state.selected.revision, 2);
  assert.equal(h.context.client.state.selected.marks, 2);
  assert.equal(h.context.client.state.history[0].eventId, 'event-A-2');
  assert.equal(h.context.client.state.draft, null);
});

test('late save preserves another student’s draft and an actively typed search', async () => {
  const h = createHarness(); await h.flush(); await h.choose('B');
  h.context.client.openDraft('belt'); h.elements.get('beltChoice').value = 'Blue Belt';
  h.elements.get('approverChoice').value = 'TEST-COACH-A'; h.context.client.readDraftControls();
  await h.choose('A'); const save = h.beginStripe(); await h.choose('B');
  h.elements.get('studentSearch').value = 'Another TEST name'; h.elements.get('studentSearch').events.get('input')();
  h.respond(save.call, h.saved(save.call)); await save.promise;
  assert.equal(h.context.client.state.selected.studentId, 'B');
  assert.equal(h.context.client.state.draft.kind, 'belt');
  assert.equal(h.elements.get('beltChoice').value, 'Blue Belt');
  assert.equal(h.elements.get('studentSearch').value, 'Another TEST name');
});

test('unknown save outcome and Check save keep the exact original retry payload and ID', async () => {
  const h = createHarness(); await h.flush(); await h.choose('A'); const save = h.beginStripe();
  save.call.success({ ok:false, error:{ code:'UNAVAILABLE', message:'Lost confirmation', retryable:true } });
  await save.promise;
  const checkPromise = h.context.client.sendPending(true); const check = h.take('checkSave');
  assert.equal(check.payload.requestId, save.call.payload.requestId);
  h.respond(check, { status:'not_found' }); await checkPromise;
  const retryPromise = h.context.client.sendPending(false); const retry = h.take('recordPromotion');
  assert.deepEqual(retry.payload, save.call.payload);
  h.respond(retry, h.saved(retry)); await retryPromise;
  assert.equal(h.context.client.state.pending, null);
});

test('closing and reopening missing-student entry preserves the identifying draft', async () => {
  const h = createHarness(); await h.flush(); h.context.client.openDraft('register');
  h.elements.get('newName').value = 'TEST New Student'; h.elements.get('newIdentity').value = 'Evening group';
  h.elements.get('newHistoryNote').value = 'Earlier date unknown'; h.context.client.readDraftControls();
  h.elements.get('closeEditor').events.get('click')(); h.context.client.openDraft('register');
  assert.equal(h.elements.get('newName').value, 'TEST New Student');
  assert.equal(h.elements.get('newIdentity').value, 'Evening group');
  assert.equal(h.elements.get('newHistoryNote').value, 'Earlier date unknown');
});

test('retained owner view reads repairs concisely and corrects only across identity repairs', async () => {
  const h = createHarness(); await h.flush();
  const original = student('A',2,2), repaired = { ...student('A',4,2), displayName:'TEST Student A Fullname' };
  const repair = { eventId:'fixture-name-repair', revision:4, eventKind:'REPAIR', before:original, after:repaired,
    reason:'SYNTHETIC-RAW-AUDIT-MUST-NOT-DISPLAY', repair:{ field:'identity', before:{ displayName:original.displayName }, after:{ displayName:repaired.displayName }, evidence:{ interpretation:'Split name cells preserve the complete name.' } } };
  const award = { eventId:'fixture-award',revision:2,eventKind:'STRIPE',before:student('A'),after:original };
  await h.choose('A',repaired,[award,repair]);
  assert.equal(h.elements.get('correctLatest').hidden,false);
  assert.match(h.elements.get('historyList').textContent,/TEST Student A → TEST Student A Fullname/u);
  assert.equal(h.elements.get('historyList').textContent.includes(repair.reason),false);
  h.context.client.openDraft('correct');
  assert.equal(h.context.client.state.draft.correctsEventId,award.eventId);
  assert.equal(h.context.client.state.draft.expectedRevision,4);
  const rankRepair = { eventId:'fixture-rank-repair',revision:3,eventKind:'REPAIR',before:original,after:original,repair:{ field:'rank',before:original,after:original } };
  await h.choose('A',repaired,[award,rankRepair,repair]);
  assert.equal(h.elements.get('correctLatest').hidden,true);
});
