import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../m1/manager-read-client.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
  let time = 1000000, sequence = 0;
  const timers = [];
  class Clock extends Date { static now() { return time; } }
  const context = vm.createContext({ Date: Clock, crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') },
    setTimeout: (fn, delay) => timers.push({ fn, at: time + delay }) });
  vm.runInContext(source, context);
  const client = context.GIBM1ReadClient;
  return { client, now: () => time, add: ms => { time += ms; },
    async finish(promise) {
      let settled = false, value, error;
      promise.then(result => { settled = true; value = result; }, failure => { settled = true; error = failure; });
      for (let i = 0; i < 200 && !settled; i++) {
        await flush();
        if (settled) break;
        timers.sort((a, b) => a.at - b.at);
        const timer = timers.shift();
        assert.ok(timer, 'read must settle or schedule one bounded continuation');
        time = Math.max(time, timer.at); timer.fn();
      }
      assert.equal(settled, true);
      if (error) throw error;
      return value;
    }
  };
}
const pending = ticket => ({ ok: true, state: 'pending', requestId: ticket.requestId, deadlineAt: ticket.deadlineAt, expiresAt: ticket.expiresAt });

test('a 35-second callback is collected through short status calls to the same original ticket', async () => {
  const h = harness(), ticket = h.client.createTicket(), calls = [], retained = [];
  const result = await h.finish(h.client.run({ ticket, retain: value => retained.push(structuredClone(value)), send: async (request, options) => {
    assert.equal(retained[0].dispatched, true, 'persist the ticket before start dispatch');
    calls.push({ ...request, timeoutMs: options.timeoutMs, at: h.now() });
    return h.now() - ticket.startedAt >= 35000 ? { ok: true, pendingDays: 2 } : pending(ticket);
  } }));
  assert.equal(result.pendingDays, 2);
  assert.equal(calls[0].operation, 'start');
  assert.ok(calls.slice(1).every(call => call.operation === 'status'));
  assert.ok(calls.every(call => call.requestId === ticket.requestId && call.timeoutMs <= 25000));
  assert.ok(h.now() - ticket.startedAt >= 35000 && h.now() - ticket.startedAt < 50000);
  assert.equal(new Set(calls.map(call => call.requestId)).size, 1);
});

test('lost start delivery continues by status, and a reloaded client resumes without redispatch', async () => {
  const h = harness(), ticket = h.client.createTicket(), calls = [];
  let retained;
  const result = await h.finish(h.client.run({ ticket, retain: value => { retained = structuredClone(value); }, send: async request => {
    calls.push(request.operation);
    if (calls.length === 1) { h.add(25000); throw new Error('Delivery interrupted'); }
    return { ok: true, pendingDays: 3 };
  } }));
  assert.equal(result.pendingDays, 3);
  assert.deepEqual(calls, ['start', 'status']);
  let resume;
  await h.client.run({ ticket: retained, send: async request => { resume = request; return { ok: true }; } });
  assert.equal(resume.operation, 'status'); assert.equal(resume.requestId, ticket.requestId);
});

test('missing callback has one 50-second deadline and remains within existing rate limits', async () => {
  const counts = [];
  for (const name of ['badge', 'admin', 'addition-check']) {
    const h = harness(), ticket = h.client.createTicket(); let calls = 0;
    await assert.rejects(h.finish(h.client.run({ ticket, send: async (_request, options) => {
      calls++; assert.ok(options.timeoutMs <= 25000 && options.timeoutMs > 0); return pending(ticket);
    } })), /unavailable/);
    assert.equal(h.now() - ticket.startedAt, 50000, name);
    assert.equal(calls, 12, name); counts.push(calls);
  }
  assert.ok(counts[0] + counts[1] < 40);
  assert.ok(counts[2] < 20);
});

test('only an authoritative missing ticket permits one atomic same-ID start recovery', async () => {
  const h = harness(), ticket = h.client.createTicket(), calls = [], retained = [];
  const value = await h.finish(h.client.run({ ticket, retain: entry => retained.push(structuredClone(entry)), send: async request => {
    calls.push({ ...request });
    if (calls.length === 1) throw new Error('Start did not reach the server');
    if (calls.length === 2) throw Object.assign(new Error('Ticket is absent'), { status: 404, data: { code: 'READ_TICKET_MISSING' } });
    if (calls.length === 3) { assert.equal(retained.at(-1).missingStartRetried, true); return pending(ticket); }
    return { ok: true, pendingDays: 2 };
  } }));
  assert.equal(value.pendingDays, 2);
  assert.deepEqual(calls.map(call => call.operation), ['start', 'status', 'start', 'status']);
  assert.ok(calls.every(call => call.requestId === ticket.requestId));
  const resumed = retained.at(-1); let starts = 0;
  await assert.rejects(h.finish(h.client.run({ ticket: resumed, send: async request => {
    if (request.operation === 'start') starts++;
    throw Object.assign(new Error('Still absent'), { status: 404, data: { code: 'READ_TICKET_MISSING' } });
  } })), /unavailable/);
  assert.equal(starts, 0, 'the single recovery decision survives reopening');
});

test('auth, binding conflict and expiry stop immediately; transient status failures cannot extend the budget', async () => {
  for (const status of [400, 401, 403, 409, 410, 422]) {
    const h = harness(); let calls = 0;
    await assert.rejects(h.client.run({ ticket: h.client.createTicket(), send: async () => { calls++; throw Object.assign(new Error('Rejected'), { status }); } }), error => error.status === status);
    assert.equal(calls, 1);
  }
  const h = harness(), ticket = h.client.createTicket(), operations = [];
  await assert.rejects(h.finish(h.client.run({ ticket, send: async request => { operations.push(request.operation); throw Object.assign(new Error('Temporary delivery failure'), { status: operations.length === 1 ? 503 : 404 }); } })), /unavailable/);
  assert.equal(h.now() - ticket.startedAt, 50000);
  assert.equal(operations.filter(value => value === 'start').length, 1);
});

test('expired or mismatched metadata, stale final delivery and failed persistence never become success', async () => {
  for (const change of [{ requestId: '00000000-0000-4000-8000-000000000099' }, { deadlineAt: 0 }, { expiresAt: 'later' }]) {
    const h = harness(), ticket = h.client.createTicket();
    await assert.rejects(h.client.run({ ticket, send: async () => ({ ...pending(ticket), ...change }) }), /unavailable/);
  }
  const h = harness(), ticket = h.client.createTicket();
  await assert.rejects(h.client.run({ ticket, send: async () => { h.add(50000); return { ok: true, pendingDays: 0 }; } }), /unavailable/);
  let sent = false;
  await assert.rejects(h.client.run({ ticket: h.client.createTicket(), retain: () => { throw new Error('Storage unavailable'); }, send: async () => { sent = true; } }), /Storage unavailable/);
  assert.equal(sent, false);
  const expired = { ...h.client.createTicket(), deadlineAt: h.now() - 1 };
  await assert.rejects(h.client.run({ ticket: expired, send: async () => { sent = true; } }), /unavailable/);
  assert.equal(sent, false);
});

test('an old session cannot accept a late result or continue polling', async () => {
  const h = harness(), ticket = h.client.createTicket(); let current = true, calls = 0;
  await assert.rejects(h.client.run({ ticket, current: () => current, send: async () => { calls++; current = false; return { ok: true, pendingDays: 0 }; } }), /unavailable/);
  assert.equal(calls, 1);
});
