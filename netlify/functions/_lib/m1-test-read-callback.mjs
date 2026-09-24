import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constantTimeSecretEqual, runtimeConfig } from './m1-common.mjs';
import { managerReviewScope } from './m1-manager-scope.mjs';
import { REVIEW_START, localNow, validateRead } from './m1-manager-review.mjs';

// Fixed destinations are selected by trusted deployment scope, never request data.
export const PROOF_ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
export const LIVE_ORIGIN = 'https://gib-live.netlify.app';
export const PROOF_PATH = '/api/m1-test-read-proof';
export const CALLBACK_PATH = '/api/m1-test-read-result';
export const LIVE_CALLBACK_PATH = '/api/m1-manager-read-result';
export const CALLBACK_URL = PROOF_ORIGIN + CALLBACK_PATH;
export const PROOF_SCHEMA = 'm1-test-read-callback/v1';
export const callbackSchema = target => target === 'production' ? 'm1-manager-read-callback/v1' : PROOF_SCHEMA;
export const callbackURL = target => target === 'production' ? LIVE_ORIGIN + LIVE_CALLBACK_PATH : CALLBACK_URL;
export const PROOF_TTL_MS = 60_000;
export const SIGNATURE_HEADER = 'X-GIB-M1-Read-Signature';
export const READ_ID_HEADER = 'X-GIB-M1-Read-ID';
export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const signature = (text, secret, target = 'test') => createHmac('sha256', secret).update(`${callbackSchema(target)}\n${text}`, 'utf8').digest('hex');
export const key = (id, part, target = 'test') => `${target}/rev/${id}/${part}`;
export class ProofError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new ProofError(status, message); };
const exactKeys = (value, keys) => value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
export function proofRuntime(request, path, dependencies) {
  const runtime = callbackRuntime(request, path, dependencies);
  return runtime?.target === 'test' ? runtime : null;
}
export function callbackRuntime(request, path, dependencies) {
  const url = new URL(request.url);
  if (url.pathname !== path || url.search || url.hash) return null;
  const scope = managerReviewScope(request, dependencies);
  if (!scope || scope.profile.installationId !== 'rev') return null;
  const origin = scope.target === 'production' ? LIVE_ORIGIN : PROOF_ORIGIN;
  const paths = scope.target === 'production' ? ['/api/m1-manager-review', LIVE_CALLBACK_PATH] : ['/api/m1-manager-review', CALLBACK_PATH, PROOF_PATH];
  if (url.origin !== origin || !paths.includes(path)) return null;
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: scope.profile.installationId, environment: scope.profile.environment });
  return runtime?.target === scope.target ? runtime : null;
}
export function createReadTrace(id, dependencies = {}, clientId) {
  const clock = dependencies.clock || Date.now, started = clock();
  const trace = (stage, state, status) => {
    try { (dependencies.traceLog || console.info)('M1_TEST_READ_STAGE', JSON.stringify({
      requestId: validId(id) ? id : null, clientId: validId(clientId) ? clientId : null,
      invocation: /^[a-zA-Z0-9_-]{1,100}$/.test(dependencies.context?.requestId || '') ? dependencies.context.requestId : null,
      stage, state, elapsedMs: Math.max(0, clock() - started), status: Number.isInteger(status) ? status : null
    })); } catch {} // Observability must never become a read dependency.
  };
  trace.requestId = id;
  return trace;
}
export async function traceReadStage(trace, stage, work) {
  trace(stage, 'start');
  try { const result = await work(); trace(stage, 'ok'); return result; }
  catch (error) { trace(stage, 'failed', error?.status); throw error; }
}
export async function proofStore(options = {}, target = 'test') {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: target === 'production' ? 'gib-m1-manager-read-callback-production-v1' : 'gib-m1-read-callback-proof-test-v1', consistency: 'strong', ...options });
}
export async function readEntry(store, id, part, target = 'test') {
  const entry = await store.getWithMetadata(key(id, part, target), { type: 'json', consistency: 'strong' });
  if (entry && (!entry.etag || !entry.data)) fail(503, 'Temporary central storage is incomplete.');
  return entry?.data || null;
}
export function makeBinding(id, now, action = 'managerReviewRead', target = 'test') {
  return { schema: callbackSchema(target), requestId: id, target, gym: 'rev', action, from: REVIEW_START, to: localNow(new Date(now)).date, createdAt: now, expiresAt: now + PROOF_TTL_MS };
}
export function validateBinding(binding, now, target = 'test') {
  if (!exactKeys(binding, ['schema', 'requestId', 'target', 'gym', 'action', 'from', 'to', 'createdAt', 'expiresAt'])
    || !['test', 'production'].includes(target) || !validId(binding.requestId) || binding.schema !== callbackSchema(target) || binding.target !== target || binding.gym !== 'rev' || !['managerReviewRead', 'managerReviewBadgeRead'].includes(binding.action)
    || binding.from !== REVIEW_START || !Number.isSafeInteger(binding.createdAt) || binding.createdAt > now
    || binding.expiresAt !== binding.createdAt + PROOF_TTL_MS || binding.to !== localNow(new Date(binding.createdAt)).date) fail(409, 'Read request does not match the proof.');
  if (now >= binding.expiresAt || localNow(new Date(now)).date !== binding.to) fail(410, 'Read proof expired. Run a fresh read.');
  return binding;
}
export function bindingText(binding) {
  return JSON.stringify(['schema', 'requestId', 'target', 'gym', 'action', 'from', 'to', 'createdAt', 'expiresAt'].map(field => binding[field]));
}
export function validateResult(payload, binding, now, target = 'test') {
  if (!exactKeys(payload, ['binding', 'readAt', 'result'])) fail(422, 'Incomplete callback.');
  validateBinding(payload.binding, now, target);
  if (bindingText(payload.binding) !== bindingText(binding)) fail(409, 'Callback belongs to a different read request.');
  if (!Number.isSafeInteger(payload.readAt) || payload.readAt < binding.createdAt || payload.readAt >= binding.expiresAt || payload.readAt > now) fail(422, 'Callback snapshot time is invalid.');
  try { validateRead(payload.result, binding.gym, binding.to, target); }
  catch { fail(422, 'The complete authoritative read was not received.'); }
  return payload;
}
export async function acceptResult(store, raw, suppliedSignature, runtime, now, trace = () => {}) {
  const target = runtime.target;
  if (!['test', 'production'].includes(target) || !/^[0-9a-f]{64}$/.test(suppliedSignature || '') || !constantTimeSecretEqual(suppliedSignature, signature(raw, runtime.adminActionToken, target))) { trace('callback.authentication', 'failed', 403); fail(403, 'Callback authentication failed.'); }
  trace('callback.authentication', 'ok');
  let payload;
  try { payload = JSON.parse(raw); } catch { fail(400, 'Invalid callback JSON.'); }
  if (!validId(payload?.binding?.requestId)) fail(400, 'Invalid read request identity.');
  const id = payload.binding.requestId;
  const pending = await traceReadStage(trace, 'callback.pending.read', () => readEntry(store, id, 'pending', target));
  if (!pending) fail(404, 'No pending read request.');
  trace('callback.validation', 'start');
  validateBinding(pending.binding, now, target);
  validateResult(payload, pending.binding, now, target);
  trace('callback.validation', 'ok');
  const digest = hash(raw);
  const receipt = { digest, receivedAt: now, payload };
  // Immutable create-only result: concurrent callbacks cannot replace one another.
  await traceReadStage(trace, 'callback.result.write', () => store.set(key(id, 'result', target), JSON.stringify(receipt), { onlyIfNew: true }));
  const saved = await traceReadStage(trace, 'callback.result.readback', () => readEntry(store, id, 'result', target));
  if (!saved) fail(503, 'Callback storage could not be confirmed.');
  if (saved.digest !== digest) fail(409, 'Conflicting callback rejected.');
  if (hash(JSON.stringify(saved.payload)) !== digest) fail(503, 'Callback storage is incomplete.');
  trace('callback.acceptance', 'ok', 200);
  return { ok: true, accepted: true, requestId: id };
}
export async function readProof(store, id, now, target = 'test') {
  const pending = await readEntry(store, id, 'pending', target);
  if (!pending) fail(404, 'No pending read request.');
  validateBinding(pending.binding, now, target);
  const [saved, dispatch] = await Promise.all([readEntry(store, id, 'result', target), readEntry(store, id, 'dispatch', target)]);
  const common = { requestId: id, expiresAt: pending.binding.expiresAt, dispatch, ordinaryReplyUsed: false };
  if (!saved) return { ok: true, state: 'pending', ...common };
  if (hash(JSON.stringify(saved.payload)) !== saved.digest || !Number.isSafeInteger(saved.receivedAt) || saved.receivedAt < pending.binding.createdAt || saved.receivedAt >= pending.binding.expiresAt) fail(503, 'Stored callback is incomplete.');
  validateResult(saved.payload, pending.binding, now, target);
  return { ok: true, state: 'received', ...common, readAt: saved.payload.readAt, receivedAt: saved.receivedAt, latencyMs: saved.receivedAt - pending.binding.createdAt, digest: saved.digest, result: saved.payload.result };
}
export async function dispatchProof(store, pending, runtime, dependencies = {}) {
  const target = runtime.target;
  const clock = dependencies.clock || Date.now;
  const started = clock();
  const trace = dependencies.readTrace || createReadTrace(pending.binding.requestId, dependencies);
  const timing = { method: 'POST', host: 'script.google.com', status: null, elapsedMs: 0, outcome: 'unavailable', ordinaryReplyUsed: false };
  const confirmed = dependencies.confirmedCallbackSignal;
  const budget = AbortSignal.timeout(25_000);
  const signal = confirmed ? AbortSignal.any([budget, confirmed]) : budget;
  try {
    validateBinding(pending.binding, started, target);
    trace('dispatch', 'start');
    const response = await (dependencies.fetch || fetch)(runtime.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify({ token: runtime.webhookToken, adminActionToken: runtime.adminActionToken, target, action: target === 'test' ? 'managerReviewReadCallbackProof' : 'managerReviewReadCallback', gym: 'rev', from: pending.binding.from, to: pending.binding.to, adminName: pending.reviewer, binding: pending.binding }),
      // This read uses only its authenticated persisted callback, not ContentService.
      redirect: 'manual', signal
    });
    timing.status = response.status;
    timing.outcome = 'ordinary-reply-discarded';
    await response.body?.cancel();
  } catch (error) {
    // The winning abort reason is immutable: a later valid callback must not
    // relabel an ordinary request whose original timeout already fired.
    timing.outcome = confirmed?.aborted && signal.reason === confirmed.reason
      ? 'callback-confirmed' : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'unavailable';
  }
  timing.elapsedMs = Math.max(0, clock() - started);
  trace('dispatch', timing.outcome, timing.status);
  // No credentials, redirect URL, response body, identity or raw error is logged.
  console.info('M1_TEST_CALLBACK_DISPATCH', JSON.stringify({ requestId: pending.binding.requestId, ...timing }));
  try {
    if (clock() < pending.binding.expiresAt && await readEntry(store, pending.binding.requestId, 'pending', target)) await store.set(key(pending.binding.requestId, 'dispatch', target), JSON.stringify(timing), { onlyIfNew: true });
  }
  catch { console.warn('M1_TEST_CALLBACK_DISPATCH_RECEIPT_UNAVAILABLE'); }
}

// Activity-driven collection is bounded by the number of temporary requests in
// this target-specific temporary store. Never attendance or audit storage.
export async function cleanupExpiredReads(store, now, options = {}) {
  const target = options.target || 'test';
  if (!['test', 'production'].includes(target)) return;
  const clock = options.clock || Date.now, deadline = options.deadline ?? clock() + 5000;
  const seen = new Set();
  let pages = 0;
  for await (const page of store.list({ prefix: `${target}/rev/`, paginate: true })) {
    if (++pages > 2 || clock() >= deadline || options.signal?.aborted) break;
    const pattern = new RegExp(`^${target}/rev/([0-9a-f-]{36})/(?:pending|result|dispatch)$`);
    const ids = [...new Set(page.blobs.map(b => pattern.exec(b.key)?.[1]).filter(validId))];
    for (const id of ids) {
      if (clock() >= deadline || options.signal?.aborted || seen.size >= 30) return;
      if (seen.has(id)) continue;
      seen.add(id);
      const pending = await readEntry(store, id, 'pending', target);
      if (pending && (!Number.isSafeInteger(pending.binding?.expiresAt) || pending.binding.expiresAt > now)) continue;
      if (clock() >= deadline || options.signal?.aborted) return;
      await Promise.all(['result', 'dispatch'].map(part => store.delete(key(id, part, target))));
      if (clock() >= deadline || options.signal?.aborted) return;
      await store.delete(key(id, 'pending', target));
    }
    if (pages >= 2 || seen.size >= 30) break;
  }
}

export function scheduleReadCleanup(dependencies, trace, target = 'test') {
  // Separate store/fetch budget: aborting cleanup cannot abort a fresh read.
  // Register only after the read settles. Never await this on the response path.
  try {
    dependencies.context.waitUntil((async () => {
      trace('cleanup', 'start');
      try {
        const signal = AbortSignal.timeout(5000);
        const cleanupStore = dependencies.cleanupStore || dependencies.store || await proofStore({
          fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal })
        }, target);
        const started = Date.now();
        await cleanupExpiredReads(cleanupStore, (dependencies.clock || Date.now)(), { signal, deadline: started + 5000, target });
        trace('cleanup', signal.aborted ? 'bounded' : 'ok');
      } catch { trace('cleanup', 'unavailable'); }
    })());
  } catch { trace('cleanup', 'not-scheduled'); }
}

// Only the normal Revolution initial read and public aggregate call this.
// Saves and same-request reconciliation continue through their original path.
export async function loadCallbackLedger(request, runtime, reviewer, dependencies = {}) {
  const path = new URL(request.url).pathname;
  const scoped = callbackRuntime(request, path, dependencies);
  if (path !== '/api/m1-manager-review' || !scoped || scoped.target !== runtime.target) fail(403, 'Revolution scoped read required.');
  const target = runtime.target;
  if (typeof dependencies.context?.waitUntil !== 'function') fail(503, 'Review status unavailable.');
  const clock = dependencies.clock || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = clock();
  const trace = dependencies.readTrace || createReadTrace(randomUUID(), dependencies, request.headers.get(READ_ID_HEADER));
  const id = trace.requestId;
  try {
  const store = await traceReadStage(trace, 'storage.open', () => dependencies.store || proofStore({}, target));
  const pending = { binding: makeBinding(id, clock(), reviewer ? 'managerReviewRead' : 'managerReviewBadgeRead', target), ...(reviewer ? { reviewer } : {}) };
  const saved = await traceReadStage(trace, 'pending.write', () => store.set(key(id, 'pending', target), JSON.stringify(pending), { onlyIfNew: true }));
  const confirmed = await traceReadStage(trace, 'pending.readback', () => readEntry(store, id, 'pending', target));
  if (saved?.modified !== true || JSON.stringify(confirmed) !== JSON.stringify(pending)) fail(503, 'Review status unavailable.');
  const callbackConfirmed = new AbortController();
  dependencies.context.waitUntil(dispatchProof(store, confirmed, runtime, { ...dependencies, readTrace: trace, confirmedCallbackSignal: callbackConfirmed.signal }));
  // Leave headroom under the platform's 60-second synchronous limit. Delivery
  // has its original 25-second budget and is never retried by this waiter.
  const deadline = Math.min(started + 50_000, pending.binding.expiresAt);
  trace('callback.wait', 'start');
  while (clock() < deadline) {
    let result;
    trace('result.storage.read', 'start');
    try { result = await readProof(store, id, clock(), target); trace('result.storage.read', 'ok'); }
    catch (error) { trace('result.storage.read', 'failed', error?.status); throw error; }
    if (result.state === 'received') {
      validateBinding(pending.binding, clock(), target);
      // readProof has validated the persisted authoritative result, digest,
      // binding and snapshot time. Its unused ordinary reply can now stop.
      callbackConfirmed.abort(new DOMException('Authoritative callback confirmed', 'AbortError'));
      trace('callback.wait', 'received');
      console.info('M1_TEST_MANAGER_CALLBACK_READ', JSON.stringify({ requestId: id, purpose: pending.binding.action, elapsedMs: clock() - started, callbackMs: result.latencyMs, state: 'received' }));
      return result.result;
    }
    await sleep(Math.min(1000, deadline - clock()));
  }
  trace('callback.wait', 'unavailable', 503);
  console.warn('M1_TEST_MANAGER_CALLBACK_READ', JSON.stringify({ requestId: id, purpose: pending.binding.action, elapsedMs: clock() - started, state: 'unavailable' }));
  fail(503, 'Review status unavailable. No fresh central read was confirmed.');
  } finally { scheduleReadCleanup(dependencies, trace, target); }
}
