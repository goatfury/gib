import { createHash, createHmac, randomUUID } from 'node:crypto';
import { addedClassesScope } from '../m1-added-classes.mjs';
import { constantTimeSecretEqual, runtimeConfig } from './m1-common.mjs';
import { MANAGER_REVIEW_ENABLED as pilotEnabled } from './m1-manager-review.generated.mjs';
import { REVIEW_START, localNow, validateRead } from './m1-manager-review.mjs';

// This proof is deliberately pinned to one unpublished Revolution TEST preview.
export const PROOF_ORIGIN = 'https://deploy-preview-89--gib-live.netlify.app';
export const PROOF_PATH = '/api/m1-test-read-proof';
export const CALLBACK_PATH = '/api/m1-test-read-result';
export const CALLBACK_URL = PROOF_ORIGIN + CALLBACK_PATH;
export const PROOF_SCHEMA = 'm1-test-read-callback/v1';
export const PROOF_TTL_MS = 60_000;
export const SIGNATURE_HEADER = 'X-GIB-M1-Read-Signature';
export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const signature = (text, secret) => createHmac('sha256', secret).update(`${PROOF_SCHEMA}\n${text}`, 'utf8').digest('hex');
export const key = (id, part) => `test/rev/${id}/${part}`;
export class ProofError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new ProofError(status, message); };
const exactKeys = (value, keys) => value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
export function proofRuntime(request, path, dependencies) {
  const url = new URL(request.url);
  if (!(dependencies.enabled ?? pilotEnabled) || url.origin !== PROOF_ORIGIN || url.pathname !== path || url.search || url.hash) return null;
  const scope = addedClassesScope(new Request(`${url.origin}/api/m1-added-classes`, { headers: request.headers }), dependencies);
  if (scope?.target !== 'test' || scope.profile.installationId !== 'rev') return null;
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: scope.profile.installationId, environment: scope.profile.environment });
  return runtime?.target === 'test' ? runtime : null;
}
export async function proofStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'gib-m1-read-callback-proof-test-v1', consistency: 'strong' });
}
export async function readEntry(store, id, part) {
  const entry = await store.getWithMetadata(key(id, part), { type: 'json', consistency: 'strong' });
  if (entry && (!entry.etag || !entry.data)) fail(503, 'Temporary central storage is incomplete.');
  return entry?.data || null;
}
export function makeBinding(id, now, action = 'managerReviewRead') {
  return { schema: PROOF_SCHEMA, requestId: id, target: 'test', gym: 'rev', action, from: REVIEW_START, to: localNow(new Date(now)).date, createdAt: now, expiresAt: now + PROOF_TTL_MS };
}
export function validateBinding(binding, now) {
  if (!exactKeys(binding, ['schema', 'requestId', 'target', 'gym', 'action', 'from', 'to', 'createdAt', 'expiresAt'])
    || !validId(binding.requestId) || binding.schema !== PROOF_SCHEMA || binding.target !== 'test' || binding.gym !== 'rev' || !['managerReviewRead', 'managerReviewBadgeRead'].includes(binding.action)
    || binding.from !== REVIEW_START || !Number.isSafeInteger(binding.createdAt) || binding.createdAt > now
    || binding.expiresAt !== binding.createdAt + PROOF_TTL_MS || binding.to !== localNow(new Date(binding.createdAt)).date) fail(409, 'Read request does not match the proof.');
  if (now >= binding.expiresAt || localNow(new Date(now)).date !== binding.to) fail(410, 'Read proof expired. Run a fresh read.');
  return binding;
}
export function bindingText(binding) {
  return JSON.stringify(['schema', 'requestId', 'target', 'gym', 'action', 'from', 'to', 'createdAt', 'expiresAt'].map(field => binding[field]));
}
export function validateResult(payload, binding, now) {
  if (!exactKeys(payload, ['binding', 'readAt', 'result'])) fail(422, 'Incomplete callback.');
  validateBinding(payload.binding, now);
  if (bindingText(payload.binding) !== bindingText(binding)) fail(409, 'Callback belongs to a different read request.');
  if (!Number.isSafeInteger(payload.readAt) || payload.readAt < binding.createdAt || payload.readAt >= binding.expiresAt || payload.readAt > now) fail(422, 'Callback snapshot time is invalid.');
  try { validateRead(payload.result, binding.gym, binding.to); }
  catch { fail(422, 'The complete authoritative read was not received.'); }
  return payload;
}
export async function acceptResult(store, raw, suppliedSignature, runtime, now) {
  if (!/^[0-9a-f]{64}$/.test(suppliedSignature || '') || !constantTimeSecretEqual(suppliedSignature, signature(raw, runtime.adminActionToken))) fail(403, 'Callback authentication failed.');
  let payload;
  try { payload = JSON.parse(raw); } catch { fail(400, 'Invalid callback JSON.'); }
  if (!validId(payload?.binding?.requestId)) fail(400, 'Invalid read request identity.');
  const id = payload.binding.requestId;
  const pending = await readEntry(store, id, 'pending');
  if (!pending) fail(404, 'No pending read request.');
  validateBinding(pending.binding, now);
  validateResult(payload, pending.binding, now);
  const digest = hash(raw);
  const receipt = { digest, receivedAt: now, payload };
  // Immutable create-only result: concurrent callbacks cannot replace one another.
  await store.set(key(id, 'result'), JSON.stringify(receipt), { onlyIfNew: true });
  const saved = await readEntry(store, id, 'result');
  if (!saved) fail(503, 'Callback storage could not be confirmed.');
  if (saved.digest !== digest) fail(409, 'Conflicting callback rejected.');
  if (hash(JSON.stringify(saved.payload)) !== digest) fail(503, 'Callback storage is incomplete.');
  return { ok: true, accepted: true, requestId: id };
}
export async function readProof(store, id, now) {
  const pending = await readEntry(store, id, 'pending');
  if (!pending) fail(404, 'No pending read request.');
  validateBinding(pending.binding, now);
  const [saved, dispatch] = await Promise.all([readEntry(store, id, 'result'), readEntry(store, id, 'dispatch')]);
  const common = { requestId: id, expiresAt: pending.binding.expiresAt, dispatch, ordinaryReplyUsed: false };
  if (!saved) return { ok: true, state: 'pending', ...common };
  if (hash(JSON.stringify(saved.payload)) !== saved.digest || !Number.isSafeInteger(saved.receivedAt) || saved.receivedAt < pending.binding.createdAt || saved.receivedAt >= pending.binding.expiresAt) fail(503, 'Stored callback is incomplete.');
  validateResult(saved.payload, pending.binding, now);
  return { ok: true, state: 'received', ...common, readAt: saved.payload.readAt, receivedAt: saved.receivedAt, latencyMs: saved.receivedAt - pending.binding.createdAt, digest: saved.digest, result: saved.payload.result };
}
export async function dispatchProof(store, pending, runtime, dependencies = {}) {
  const clock = dependencies.clock || Date.now;
  const started = clock();
  const timing = { method: 'POST', host: 'script.google.com', status: null, elapsedMs: 0, outcome: 'unavailable', ordinaryReplyUsed: false };
  try {
    validateBinding(pending.binding, started);
    const response = await (dependencies.fetch || fetch)(runtime.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify({ token: runtime.webhookToken, adminActionToken: runtime.adminActionToken, target: 'test', action: 'managerReviewReadCallbackProof', gym: 'rev', from: pending.binding.from, to: pending.binding.to, adminName: pending.reviewer, binding: pending.binding }),
      // Fault injection: never follow or consume ContentService, even if it works.
      redirect: 'manual', signal: AbortSignal.timeout(25_000)
    });
    timing.status = response.status;
    timing.outcome = 'ordinary-reply-discarded';
    await response.body?.cancel();
  } catch (error) { timing.outcome = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'unavailable'; }
  timing.elapsedMs = Math.max(0, clock() - started);
  // No credentials, redirect URL, response body, identity or raw error is logged.
  console.info('M1_TEST_CALLBACK_DISPATCH', JSON.stringify({ requestId: pending.binding.requestId, ...timing }));
  try {
    if (clock() < pending.binding.expiresAt && await readEntry(store, pending.binding.requestId, 'pending')) await store.set(key(pending.binding.requestId, 'dispatch'), JSON.stringify(timing), { onlyIfNew: true });
  }
  catch { console.warn('M1_TEST_CALLBACK_DISPATCH_RECEIPT_UNAVAILABLE'); }
}

// Activity-driven collection is bounded by the number of temporary requests in
// this TEST-only store. Nothing here can address attendance or audit storage.
export async function cleanupExpiredReads(store, now) {
  for await (const page of store.list({ prefix: 'test/rev/', paginate: true })) {
    const ids = [...new Set(page.blobs.map(b => /^test\/rev\/([0-9a-f-]{36})\/(?:pending|result|dispatch)$/.exec(b.key)?.[1]).filter(validId))];
    for (let offset = 0; offset < ids.length; offset += 10) await Promise.all(ids.slice(offset, offset + 10).map(async id => {
      const pending = await readEntry(store, id, 'pending');
      if (pending && (!Number.isSafeInteger(pending.binding?.expiresAt) || pending.binding.expiresAt > now)) return;
      await Promise.all(['result', 'dispatch'].map(part => store.delete(key(id, part))));
      await store.delete(key(id, 'pending'));
    }));
  }
}

// Only the normal Revolution TEST initial read and public aggregate call this.
// Saves and same-request reconciliation continue through their original path.
export async function loadCallbackLedger(request, runtime, reviewer, dependencies = {}) {
  const path = new URL(request.url).pathname;
  if (path !== '/api/m1-manager-review' || !proofRuntime(request, path, dependencies)) fail(403, 'Revolution TEST read required.');
  if (typeof dependencies.context?.waitUntil !== 'function') fail(503, 'Review status unavailable.');
  const clock = dependencies.clock || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = clock();
  const store = dependencies.store || await proofStore();
  await cleanupExpiredReads(store, started);
  const id = randomUUID();
  const pending = { binding: makeBinding(id, clock(), reviewer ? 'managerReviewRead' : 'managerReviewBadgeRead'), ...(reviewer ? { reviewer } : {}) };
  const saved = await store.set(key(id, 'pending'), JSON.stringify(pending), { onlyIfNew: true });
  const confirmed = await readEntry(store, id, 'pending');
  if (saved?.modified !== true || JSON.stringify(confirmed) !== JSON.stringify(pending)) fail(503, 'Review status unavailable.');
  dependencies.context.waitUntil(dispatchProof(store, confirmed, runtime, dependencies));
  // Leave headroom under the platform's 60-second synchronous limit. Delivery
  // has its original 25-second budget and is never retried by this waiter.
  const deadline = Math.min(started + 50_000, pending.binding.expiresAt);
  while (clock() < deadline) {
    const result = await readProof(store, id, clock());
    if (result.state === 'received') {
      validateBinding(pending.binding, clock());
      console.info('M1_TEST_MANAGER_CALLBACK_READ', JSON.stringify({ requestId: id, purpose: pending.binding.action, elapsedMs: clock() - started, callbackMs: result.latencyMs, state: 'received' }));
      return result.result;
    }
    await sleep(Math.min(1000, deadline - clock()));
  }
  console.warn('M1_TEST_MANAGER_CALLBACK_READ', JSON.stringify({ requestId: id, purpose: pending.binding.action, elapsedMs: clock() - started, state: 'unavailable' }));
  fail(503, 'Review status unavailable. No fresh central read was confirmed.');
}
