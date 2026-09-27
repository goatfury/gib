import { createHmac, randomUUID } from 'node:crypto';
import { digestHash, splitAttendanceDigest, DIGEST_ORIGIN } from './m1-attendance-digest.mjs';
import { validId } from './m1-test-read-callback.mjs';
import { validateDigestBinding } from './m1-attendance-digest-outbox.mjs';
import { readPolicyDigestEmailDelivery, deliverPolicyDigestEmail, requestDigestEmailProvider } from './m1-attendance-digest-email-delivery.mjs';

const STORE = 'gib-m1-digest-test-workflow-v1', SCHEMA = 'm1-digest-workflow/v1';
export const WORKFLOW_DISPATCH_SCHEMA = 'm1-attendance-delivery-background/v1';
export const WORKFLOW_DISPATCH_HEADER = 'X-GIB-M1-Workflow-Signature';
export const WORKFLOW_DISPATCH_PATH = '/api/m1-attendance-delivery-background';
export const workflowDispatchSignature = (raw, secret) => createHmac('sha256', secret).update(WORKFLOW_DISPATCH_SCHEMA + '\n' + raw, 'utf8').digest('hex');
const FRESH_MS = 30 * 60000, MAX_MESSAGES = 256, MAX_ATTEMPTS = 6;
const BACKOFF = [15, 30, 60, 120, 240].map(minutes => minutes * 60000);
const clock = deps => (deps.clock || Date.now)();
const env = (deps, name) => deps.env ? deps.env[name] : globalThis.Netlify?.env?.get(name);
const key = id => 'workflow/messages/' + id;
const canonical = message => ({ messageId: message?.messageId, from: message?.from, to: message?.to, cc: message?.cc,
  subject: message?.subject, html: message?.html, text: message?.text, synthetic: message?.synthetic, target: message?.target });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
const safeAddress = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(value);
const validMessage = message => exact(message, ['messageId', 'hash', 'from', 'to', 'cc', 'subject', 'html', 'text', 'synthetic', 'target'])
  && /^m1-test-scheduled-(rev|richmond)-\d{4}-\d{2}-\d{2}$/.test(message.messageId) && message.target === 'test' && typeof message.synthetic === 'boolean'
  && typeof message.from === 'string' && message.from.length > 0 && message.from.length <= 300 && !/[\r\n]/.test(message.from)
  && Array.isArray(message.to) && message.to.length === 1 && message.to.every(safeAddress)
  && Array.isArray(message.cc) && message.cc.length <= 1 && message.cc.every(safeAddress) && new Set([...message.to, ...message.cc]).size === message.to.length + message.cc.length
  && typeof message.subject === 'string' && message.subject.length > 0 && message.subject.length <= 998 && !/[\r\n]/.test(message.subject)
  && ['html', 'text'].every(field => typeof message[field] === 'string' && message[field].length > 0 && message[field].length <= 200000)
  && /^[a-f0-9]{64}$/.test(message.hash) && digestHash(canonical(message)) === message.hash;
function requireScope(scope) {
  if (scope?.target !== 'test' || scope.profile?.installationId !== 'rev') throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
}
async function storeFor(deps) {
  if (deps.workflowStore || deps.digestStore) return deps.workflowStore || deps.digestStore;
  const { getStore } = await import('@netlify/blobs'); return getStore({ name: STORE, consistency: 'strong' });
}
async function read(store, path) {
  const value = await store.getWithMetadata(path, { type: 'json', consistency: 'strong' });
  if (value && (!value.data || typeof value.etag !== 'string' || !value.etag)) throw new Error('WORKFLOW_STORAGE_INCOMPLETE');
  return value || null;
}
async function write(store, path, value, before) {
  const result = await store.set(path, JSON.stringify(value), before ? { onlyIfMatch: before.etag } : { onlyIfNew: true });
  const after = await read(store, path);
  if (![true, false].includes(result?.modified) || !after || (result.modified && digestHash(after.data) !== digestHash(value))) throw new Error('WORKFLOW_STORAGE_UNCONFIRMED');
  return { ...after, modified: result.modified };
}
async function register(store, id) {
  for (let count = 0; count < 3; count++) {
    const before = await read(store, 'workflow/index'), ids = before?.data.ids || [];
    if (!Array.isArray(ids) || ids.length > MAX_MESSAGES || ids.some(value => !/^m1-test-scheduled-(rev|richmond)-\d{4}-\d{2}-\d{2}$/.test(value))) throw new Error('WORKFLOW_INDEX_INVALID');
    if (ids.includes(id)) return;
    if (ids.length >= MAX_MESSAGES) throw new Error('WORKFLOW_HISTORY_CAPACITY');
    if ((await write(store, 'workflow/index', { ids: [...ids, id] }, before)).modified) return;
  }
  throw new Error('WORKFLOW_INDEX_UNCONFIRMED');
}
function deliveryDeps(store, deps) {
  return { ...deps, deliveryStore: { getWithMetadata: (path, options) => store.getWithMetadata('workflow/delivery/' + path, options),
    set: (path, value, options) => store.set('workflow/delivery/' + path, value, options) } };
}
function policyFor(configuration, deps) {
  const simulator = deps.simulatedProvider;
  const gate = message => {
    if (deps.processorLease && clock(deps) >= deps.processorLease.expiresAt) return { state: 'disabled', code: 'WORKFLOW_LEASE_EXPIRED' };
    if (!validMessage(message)) return { state: 'blocked', code: 'INVALID_SCHEDULED_MESSAGE' };
    if (simulator) return message.synthetic === true && typeof simulator.identity === 'string' && simulator.identity.length <= 100 && typeof simulator.send === 'function'
      ? null : { state: 'blocked', code: 'SYNTHETIC_PROVIDER_REQUIRED' };
    if (env(deps, 'GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED') !== 'true') return { state: 'disabled', code: 'SCHEDULED_SENDING_DISABLED' };
    const approved = String(env(deps, 'GIB_M1_ATTENDANCE_DIGEST_VERIFIED_RECIPIENTS') || '').split(',').map(value => value.trim());
    if (!configuration.cutoffConfirmed || env(deps, 'GIB_M1_ATTENDANCE_DIGEST_VERIFIED_SENDER') !== message.from
      || ![...message.to, ...message.cc].every(address => approved.includes(address))) return { state: 'blocked', code: 'SCHEDULED_CONFIGURATION_UNVERIFIED' };
    const credential = env(deps, 'GIB_M1_DIGEST_TEST_RESEND_API_KEY');
    return typeof credential === 'string' && credential.length > 0 && credential.length <= 1024 && !/\s/.test(credential) ? null : { state: 'disabled', code: 'SCHEDULED_PROVIDER_UNAVAILABLE' };
  };
  return { canonical, validMessage, gate,
    credentialFingerprint: () => digestHash(simulator ? 'm1-digest-simulator/v1\n' + simulator.identity : 'm1-digest-test-email-resend-credential/v1\n' + env(deps, 'GIB_M1_DIGEST_TEST_RESEND_API_KEY')),
    request: (message, options, signal) => simulator ? simulator.send(structuredClone(message), { signal }) : requestDigestEmailProvider(message, options, signal) };
}
function retryDecision(delivery, now) {
  if (delivery.state === 'not-started') return { state: 'unconfirmed', code: 'FIRST_ATTEMPT_CLAIM_PENDING', nextAttemptAt: null };
  if (delivery.state === 'accepted') return { state: 'unconfirmed', code: 'PROVIDER_ACCEPTANCE_ONLY', nextAttemptAt: null };
  if (delivery.state === 'pending') return { state: 'unconfirmed', code: 'ATTEMPT_IN_PROGRESS', nextAttemptAt: null };
  if (delivery.state === 'blocked') return { state: 'failed', code: delivery.code, nextAttemptAt: null };
  const receipt = delivery.receipts?.at(-1), count = delivery.attemptCount || 0;
  const uncertain = delivery.receipts?.some(value => !value || value.state === 'unknown') || delivery.state === 'unknown';
  const permanent = receipt?.state === 'rejected' && ![408, 409, 429].includes(receipt.httpStatus);
  if (permanent) return { state: uncertain ? 'unconfirmed' : 'failed', code: 'PERMANENT_PROVIDER_REJECTION', nextAttemptAt: null };
  if (!delivery.retryAllowed || count >= MAX_ATTEMPTS || now >= delivery.retryBefore) return { state: uncertain ? 'unconfirmed' : 'failed', code: 'MANUAL_RECONCILIATION_REQUIRED', nextAttemptAt: null };
  const startedAt = delivery.lastAttemptAt ?? receipt?.startedAt ?? (delivery.retryBefore - 23 * 60 * 60000);
  const nextAttemptAt = startedAt + BACKOFF[Math.min(Math.max(0, count - 1), BACKOFF.length - 1)];
  return { state: uncertain ? 'unconfirmed' : 'retrying', code: 'AUTOMATIC_RETRY_PENDING', nextAttemptAt: nextAttemptAt < delivery.retryBefore ? nextAttemptAt : null };
}
async function records(store) {
  const index = await read(store, 'workflow/index');
  if (!index) return [];
  if (!Array.isArray(index.data.ids) || index.data.ids.length > MAX_MESSAGES) throw new Error('WORKFLOW_INDEX_INVALID');
  return Promise.all(index.data.ids.map(async id => {
    const entry = await read(store, key(id));
    if (!entry || entry.data.schema !== SCHEMA || entry.data.messageId !== id || (entry.data.message && !validMessage(entry.data.message))) throw new Error('WORKFLOW_MESSAGE_UNAVAILABLE');
    return entry;
  }));
}
async function priorDeliveryBarrier(store, gym, message, options, policy) {
  for (const previous of await records(store)) {
    if (previous.data.gym !== gym || previous.data.messageId === message.messageId || !previous.data.firstAttemptAt) continue;
    // Workflow summaries can lag a lost reply. Only the validated original
    // provider ledger may establish acceptance or a definite rejection.
    const delivery = await readPolicyDigestEmailDelivery(previous.data.message, options, policy);
    if (delivery.state === 'accepted') {
      const receipt = await latestDeliveryEvidence(store, previous.data.message, delivery, clock(options));
      if (receipt?.type === 'email.bounced' && receipt.permanentFailure === true
        && JSON.stringify(previous.data.message.to) === JSON.stringify(message.to)) return 'PRIOR_PERMANENT_RECIPIENT_BOUNCE';
      continue;
    }
    if (delivery.state === 'rejected') {
      const sameRoute = previous.data.message.from === message.from
        && JSON.stringify(previous.data.message.to) === JSON.stringify(message.to)
        && JSON.stringify(previous.data.message.cc) === JSON.stringify(message.cc);
      if (!sameRoute) continue;
      const permanent = delivery.receipts.map((receipt, index) => receipt.state === 'rejected' && ![408, 409, 429].includes(receipt.httpStatus) ? index : -1).filter(index => index >= 0);
      if (!permanent.length) continue;
      const retained = await read(store, 'workflow/delivery/messages/' + previous.data.messageId);
      if (!retained || retained.data.attempts?.length !== delivery.attemptCount) throw new Error('WORKFLOW_PRIOR_DELIVERY_UNCONFIRMED');
      // A new date/body or an OFF/ON toggle is not a repair. An existing
      // verified sender/recipient or provider-credential change is the narrow
      // repair boundary, and cannot release an unknown-acceptance original.
      if (permanent.some(index => retained.data.attempts[index].credentialFingerprint === policy.credentialFingerprint())) return 'PRIOR_PERMANENT_REJECTION_UNCHANGED';
      continue;
    }
    return 'PRIOR_ACCEPTANCE_UNCONFIRMED';
  }
  return null;
}
async function healthEvidence(store, input, now) {
  const value = { requestId: input.binding.requestId, checkedAt: input.binding.createdAt, expiresAt: input.binding.createdAt + FRESH_MS,
    digestHash: digestHash(input.digest), complete: input.digest.readFailures.length === 0, itemCount: input.digest.itemCount, due: input.due,
    configured: input.configuration.cutoffConfirmed === true, observedAt: now,
    gyms: input.digest.groups.map(group => ({ gym: group.gym, itemCount: group.items.length, complete: !input.digest.readFailures.some(failure => failure.gym === group.gym) })) };
  for (let count = 0; count < 3; count++) {
    const before = await read(store, 'workflow/health');
    if (before && (before.data.checkedAt > value.checkedAt || (before.data.checkedAt === value.checkedAt && !before.data.complete && value.complete))) return before.data;
    if (before?.data.requestId === value.requestId) {
      if (before.data.digestHash !== value.digestHash) throw new Error('WORKFLOW_CHECK_CONFLICT');
      return before.data;
    }
    if ((await write(store, 'workflow/health', value, before)).modified) return value;
  }
  throw new Error('WORKFLOW_HEALTH_UNCONFIRMED');
}

// One scheduled tick uses its newly authenticated read, never a previous daily
// capture, to decide whether an unattempted message is still needed.
async function processWorkflow(input, deps = {}) {
  requireScope(deps.scope);
  const now = clock(deps); validateDigestBinding(input.binding, now);
  if (input.binding.mode !== 'scheduled' || !['due', 'not-due', 'awaiting-configuration'].includes(input.due)
    || input.digest.date !== input.binding.jobDate || Date.parse(input.digest.generatedAt) < input.binding.createdAt || Date.parse(input.digest.generatedAt) > now) throw new Error('WORKFLOW_FRESH_CHECK_REQUIRED');
  const routes = splitAttendanceDigest(input.digest, input.configuration), store = await storeFor(deps);
  const evidence = await healthEvidence(store, input, now), policy = policyFor(input.configuration, deps), options = deliveryDeps(store, deps);
  if (evidence.checkedAt > input.binding.createdAt || evidence.requestId !== input.binding.requestId) return workflowHealth(deps.scope, deps);
  for (const previous of await records(store)) {
    if (previous.data.firstAttemptAt && previous.data.claimUntil && clock(deps) >= previous.data.claimUntil) {
      const retained = await readPolicyDigestEmailDelivery(previous.data.message, options, policy);
      if (retained.state === 'not-started') {
        // A complete central read proves there is no provider claim. Only after
        // the fenced first-call lease expires may fresh data replace this draft.
        await write(store, key(previous.data.messageId), { ...previous.data, firstAttemptAt: null, claimUntil: null,
          state: 'prepared', code: 'NO_PROVIDER_ATTEMPT_CONFIRMED', delivery: retained }, previous);
        continue;
      }
    }
    if (!previous.data.firstAttemptAt && previous.data.date < input.binding.jobDate && previous.data.checkAt <= input.binding.createdAt
      && routes.some(route => route.gym === previous.data.gym && !route.digest.readFailures.length)) {
      await write(store, key(previous.data.messageId), { ...previous.data, state: 'suppressed', code: 'SUPERSEDED_BY_FRESH_CHECK', checkAt: input.binding.createdAt }, previous);
    }
  }
  let attempts = 0;
  for (const route of routes) {
    const messageId = 'm1-test-scheduled-' + route.gym + '-' + input.binding.jobDate;
    let before = await read(store, key(messageId));
    if (before?.data.firstAttemptAt || before?.data.checkAt > input.binding.createdAt) continue;
    const canPrepare = route.routeStatus === 'ready';
    const message = canPrepare ? { messageId, from: env(deps, 'GIB_M1_ATTENDANCE_DIGEST_FROM') || 'GIB Revolution TEST <onboarding@resend.dev>',
      to: route.to, cc: route.cc, ...route.rendered, synthetic: input.digest.syntheticRehearsal === true, target: 'test' } : null;
    if (message) message.hash = digestHash(canonical(message));
    const gated = message ? policy.gate(message, deps) : null;
    const value = { schema: SCHEMA, messageId, gym: route.gym, date: input.binding.jobDate, checkAt: input.binding.createdAt,
      firstAttemptAt: null, state: route.routeStatus === 'suppressed' ? 'suppressed' : route.routeStatus === 'blocked' ? 'not-configured' : input.due !== 'due' ? 'not-due' : 'prepared',
      code: route.code, message, attemptCount: 0, nextAttemptAt: null, retryBefore: null, delivery: null };
    if (value.state === 'prepared' && gated) { value.state = 'not-configured'; value.code = gated.code; }
    const priorBarrier = value.state === 'prepared' ? await priorDeliveryBarrier(store, route.gym, message, options, policy) : null;
    if (priorBarrier) value.code = priorBarrier;
    const saved = await write(store, key(messageId), value, before);
    await register(store, messageId); // Publish the index only after its complete message exists.
    if (!saved.modified || value.state !== 'prepared' || priorBarrier) continue;
    if (attempts >= MAX_ATTEMPTS) continue;
    // CAS freezes the fresh message before the shared engine claims its first
    // attempt. A later check cannot rewrite this body or its recipient list.
    const latest = await read(store, 'workflow/health');
    if (latest?.data.requestId !== input.binding.requestId || clock(deps) >= input.binding.expiresAt) continue;
    const claimUntil = clock(deps) + 60000;
    const claimed = await write(store, key(messageId), { ...value, firstAttemptAt: clock(deps), claimUntil, state: 'unconfirmed', code: 'ATTEMPT_CLAIMED' }, saved);
    if (!claimed.modified) continue;
    const firstPolicy = { ...policy, gate: (...args) => clock(deps) >= claimUntil ? { state: 'disabled', code: 'FIRST_ATTEMPT_LEASE_EXPIRED' } : policy.gate(...args) };
    const delivery = await deliverPolicyDigestEmail(message, options, firstPolicy);
    attempts++;
    await write(store, key(messageId), { ...claimed.data, delivery, attemptCount: delivery.attemptCount || 0, retryBefore: delivery.retryBefore || null,
      ...retryDecision(delivery, clock(deps)) }, claimed);
  }
  // The Google timer also recovers prior-day attempts. No newer digest can
  // mutate them or reset their original 23-hour identity window.
  for (const entry of await records(store)) {
    if (!entry.data.firstAttemptAt) continue;
    const delivery = await readPolicyDigestEmailDelivery(entry.data.message, options, policy);
    let decision = await evidenceDecision(store, entry.data.message, delivery, clock(deps));
    if (attempts < MAX_ATTEMPTS && decision.nextAttemptAt !== null && clock(deps) >= decision.nextAttemptAt && !policy.gate(entry.data.message, deps)) {
      const sent = await deliverPolicyDigestEmail(entry.data.message, options, policy);
      attempts++;
      decision = await evidenceDecision(store, entry.data.message, sent, clock(deps));
      await write(store, key(entry.data.messageId), { ...entry.data, delivery: sent, attemptCount: sent.attemptCount || 0,
        retryBefore: sent.retryBefore || null, ...decision }, entry);
    } else {
      await write(store, key(entry.data.messageId), { ...entry.data, delivery, attemptCount: delivery.attemptCount || 0,
        retryBefore: delivery.retryBefore || null, ...decision }, entry);
    }
  }
  return workflowHealth(deps.scope, deps);
}

export async function processAttendanceWorkflow(input, deps = {}) {
  requireScope(deps.scope);
  const store = await storeFor(deps), now = clock(deps), previous = await read(store, 'workflow/processor');
  if (previous?.data.expiresAt > now) return { ...(await workflowHealth(deps.scope, deps)), pending: true };
  const lease = { owner: randomUUID(), expiresAt: now + 10 * 60000 };
  const claimed = await write(store, 'workflow/processor', lease, previous);
  if (!claimed.modified) return { ...(await workflowHealth(deps.scope, deps)), pending: true };
  try { return await processWorkflow(input, { ...deps, processorLease: lease }); }
  finally {
    const current = await read(store, 'workflow/processor');
    if (current?.data.owner === lease.owner) await write(store, 'workflow/processor', { owner: lease.owner, expiresAt: 0 }, current);
  }
}

export async function workflowHealth(scope, deps = {}) {
  requireScope(scope);
  const store = await storeFor(deps), now = clock(deps), check = (await read(store, 'workflow/health'))?.data;
  const items = (await records(store)).filter(entry => entry.data.gym === scope.profile.installationId), codes = [];
  if (check && (!Number.isSafeInteger(check.checkedAt) || check.expiresAt !== check.checkedAt + FRESH_MS || !Array.isArray(check.gyms))) throw new Error('WORKFLOW_HEALTH_UNAVAILABLE');
  const own = check?.gyms.find(gym => gym.gym === scope.profile.installationId);
  const failedCount = items.filter(entry => ['failed', 'retrying'].includes(entry.data.state)).length;
  const unconfirmedCount = items.filter(entry => entry.data.firstAttemptAt && entry.data.state === 'unconfirmed').length;
  const pendingCount = items.filter(entry => !entry.data.firstAttemptAt && !['suppressed', 'not-due'].includes(entry.data.state)).length;
  if (check?.configured && now >= check.expiresAt) codes.push('CHECK_OVERDUE');
  if (check && own?.complete !== true) codes.push('CHECK_INCOMPLETE');
  if (failedCount) codes.push('DELIVERY_FAILED');
  if (unconfirmedCount) codes.push('DELIVERY_UNCONFIRMED');
  if (!check?.configured || items.some(entry => entry.data.state === 'not-configured')) codes.push('CONFIGURATION_REQUIRED');
  const head = (await read(store, 'workflow/job-head'))?.data;
  if (head && (!Number.isSafeInteger(head.checkedAt) || !['queued', 'running', 'complete', 'needs-fresh-check', 'dispatch-unconfirmed'].includes(head.state))) throw new Error('WORKFLOW_HEALTH_UNAVAILABLE');
  if (head && (!check || head.checkedAt > check.checkedAt || head.jobId === check.requestId)) {
    if (head.state === 'needs-fresh-check') codes.push('CHECK_INCOMPLETE');
    else if (head.state !== 'complete') codes.push('DELIVERY_UNCONFIRMED');
  }
  const state = codes.includes('CHECK_OVERDUE') ? 'check-overdue' : codes.includes('CHECK_INCOMPLETE') ? 'check-incomplete'
    : codes.includes('DELIVERY_FAILED') ? 'delivery-failed' : codes.includes('DELIVERY_UNCONFIRMED') ? 'delivery-unconfirmed'
    : codes.includes('CONFIGURATION_REQUIRED') ? 'not-configured' : own?.itemCount ? 'attention' : 'clear';
  return { ok: true, target: 'test', state, codes, checkedAt: check ? new Date(check.checkedAt).toISOString() : null, expiresAt: check ? new Date(check.expiresAt).toISOString() : null,
    pendingCount, failedCount, unconfirmedCount };
}

async function jobHead(store, job) {
  const value = { jobId: job.input.binding.requestId, checkedAt: job.input.binding.createdAt, state: job.state };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await read(store, 'workflow/job-head');
    if (before?.data.checkedAt > value.checkedAt || (before?.data.jobId === value.jobId && before.data.state === 'complete')) return;
    if ((await write(store, 'workflow/job-head', value, before)).modified) return;
  }
  throw new Error('WORKFLOW_JOB_STATUS_UNCONFIRMED');
}

// The ordinary Google callback awaits only durable enqueue and the platform's
// 202 acknowledgment. Provider work belongs to the supported background function.
export async function enqueueAttendanceWorkflow(input, runtime, deps = {}) {
  requireScope(deps.scope);
  validateDigestBinding(input.binding, clock(deps));
  if (runtime?.target !== 'test' || input.binding.mode !== 'scheduled') throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
  splitAttendanceDigest(input.digest, input.configuration);
  const store = await storeFor(deps), id = input.binding.requestId, path = 'workflow/jobs/' + id;
  const value = { schema: WORKFLOW_DISPATCH_SCHEMA, input: structuredClone(input), inputHash: digestHash(input), state: 'queued', createdAt: clock(deps), leaseUntil: null };
  const saved = await write(store, path, value, null);
  if (saved.data.inputHash !== value.inputHash || digestHash(saved.data.input) !== value.inputHash) throw new Error('WORKFLOW_JOB_CONFLICT');
  if (!saved.modified) return { queued: true, jobId: id, state: saved.data.state };
  await jobHead(store, saved.data);
  const raw = JSON.stringify({ jobId: id });
  try {
    const response = await (deps.backgroundFetch || deps.fetch || fetch)(DIGEST_ORIGIN + WORKFLOW_DISPATCH_PATH, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', [WORKFLOW_DISPATCH_HEADER]: workflowDispatchSignature(raw, runtime.adminActionToken) },
      body: raw, signal: AbortSignal.timeout(25000) });
    await response.body?.cancel();
    if (response.status !== 202) throw new Error('WORKFLOW_DISPATCH_UNCONFIRMED');
    return { queued: true, jobId: id, state: 'queued' };
  } catch {
    const current = await read(store, path);
    if (current.data.state === 'queued') {
      const updated = await write(store, path, { ...current.data, state: 'dispatch-unconfirmed' }, current);
      await jobHead(store, updated.data);
    }
    throw new Error('WORKFLOW_DISPATCH_UNCONFIRMED');
  }
}

export async function executeAttendanceWorkflowJob(jobId, scope, deps = {}) {
  requireScope(scope);
  if (!validId(jobId)) throw new Error('WORKFLOW_JOB_INVALID');
  const store = await storeFor(deps), path = 'workflow/jobs/' + jobId, before = await read(store, path), now = clock(deps);
  if (!before || before.data.schema !== WORKFLOW_DISPATCH_SCHEMA || before.data.input?.binding.requestId !== jobId
    || before.data.inputHash !== digestHash(before.data.input)) throw new Error('WORKFLOW_JOB_UNAVAILABLE');
  if (before.data.state === 'complete') return { complete: true, jobId };
  if (before.data.leaseUntil > now) return { complete: false, jobId, pending: true };
  if (now >= before.data.input.binding.expiresAt) {
    const expired = await write(store, path, { ...before.data, state: 'needs-fresh-check', leaseUntil: null }, before);
    await jobHead(store, expired.data); return { complete: false, jobId, needsFreshCheck: true };
  }
  const claimed = await write(store, path, { ...before.data, state: 'running', leaseUntil: now + 10 * 60000 }, before);
  if (!claimed.modified) return { complete: false, jobId, pending: true };
  await jobHead(store, claimed.data);
  try {
    const result = await processAttendanceWorkflow(claimed.data.input, { ...deps, scope });
    const completed = await write(store, path, { ...claimed.data, state: result.pending ? 'queued' : 'complete', leaseUntil: null }, claimed);
    await jobHead(store, completed.data);
    return { complete: !result.pending, jobId, pending: Boolean(result.pending) };
  } catch {
    const failed = await write(store, path, { ...claimed.data, state: 'needs-fresh-check', leaseUntil: null }, claimed);
    await jobHead(store, failed.data);
    throw new Error('WORKFLOW_JOB_UNCONFIRMED');
  }
}

async function latestDeliveryEvidence(store, message, delivery, now) {
  if (delivery.state !== 'accepted' || !delivery.providerId) return null;
  const index = await read(store, 'workflow/provider-evidence/' + delivery.providerId + '/index');
  if (!index) return null;
  if (!Array.isArray(index.data.ids) || index.data.ids.length > 20) throw new Error('WORKFLOW_EVIDENCE_UNAVAILABLE');
  const matches = [];
  for (const id of index.data.ids) {
    const event = (await read(store, 'workflow/provider-evidence/' + delivery.providerId + '/' + id))?.data;
    if (!event) throw new Error('WORKFLOW_EVIDENCE_UNAVAILABLE');
    if (event.from === message.from && JSON.stringify(event.to) === JSON.stringify(message.to)
      && Date.parse(event.occurredAt) >= (delivery.receipts?.[0]?.startedAt || now) - 300000) matches.push(event);
  }
  matches.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || Number(a.type === 'email.delivered') - Number(b.type === 'email.delivered'));
  return matches[0] || null;
}
async function evidenceDecision(store, message, delivery, now) {
  const ordinary = retryDecision(delivery, now), receipt = await latestDeliveryEvidence(store, message, delivery, now);
  if (receipt && ['email.failed', 'email.bounced'].includes(receipt.type)) return { state: 'failed', code: receipt.permanentFailure === true ? 'PERMANENT_RECIPIENT_BOUNCE' : 'PROVIDER_DELIVERY_FAILED', nextAttemptAt: null };
  return receipt?.type === 'email.delivered' ? message.cc.length ? { state: 'unconfirmed', code: 'CC_DELIVERY_UNCONFIRMED', nextAttemptAt: null }
    : { state: 'delivered', code: 'PROVIDER_DELIVERY_CONFIRMED', nextAttemptAt: null } : ordinary;
}

// This entry is called only after the separate disabled-by-default webhook
// endpoint verifies the provider signature over its original raw bytes.
export async function recordWorkflowDeliveryEvidence(event, deps = {}) {
  requireScope(deps.scope);
  const fields = ['eventId', 'providerId', 'type', 'occurredAt', 'from', 'to'];
  const shapeValid = exact(event, fields) || (exact(event, [...fields, 'permanentFailure']) && event.permanentFailure === true && event.type === 'email.bounced');
  if (deps.deliveryEvidenceVerified !== true || !shapeValid
    || !/^[A-Za-z0-9_-]{1,100}$/.test(event.eventId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.providerId)
    || !['email.delivered', 'email.bounced', 'email.failed'].includes(event.type) || !Number.isFinite(Date.parse(event.occurredAt))
    || new Date(event.occurredAt).toISOString() !== event.occurredAt || Date.parse(event.occurredAt) > clock(deps) + 300000
    || typeof event.from !== 'string' || event.from.length > 300 || /[\r\n]/.test(event.from)
    || !Array.isArray(event.to) || event.to.length !== 1 || !event.to.every(safeAddress)) throw new Error('WORKFLOW_EVIDENCE_INVALID');
  const store = await storeFor(deps), prefix = 'workflow/provider-evidence/' + event.providerId + '/';
  const originals = await records(store);
  let candidate;
  for (const entry of originals) {
    if (entry.data.gym !== deps.scope.profile.installationId || !entry.data.firstAttemptAt || entry.data.message.from !== event.from
      || JSON.stringify(entry.data.message.to) !== JSON.stringify(event.to)) continue;
    const retained = await readPolicyDigestEmailDelivery(entry.data.message, deliveryDeps(store, deps), { canonical, validMessage });
    if (retained.state === 'pending' || (retained.state === 'accepted' && retained.providerId === event.providerId)) { candidate = entry; break; }
  }
  if (!candidate) return { ok: true, matched: false, state: 'ignored' };
  // An early signed event may precede provider acceptance. It must still match
  // an actual in-flight original, and each original admits only bounded IDs.
  if (candidate.data.delivery?.providerId !== event.providerId) {
    const indexPath = 'workflow/pending-provider-index/' + candidate.data.messageId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await read(store, indexPath), ids = before?.data.ids || [];
      if (!Array.isArray(ids) || ids.length > 20) throw new Error('WORKFLOW_EVIDENCE_UNAVAILABLE');
      if (ids.includes(event.providerId)) break;
      if (ids.length === 20) return { ok: true, matched: false, state: 'ignored' };
      if ((await write(store, indexPath, { ids: [...ids, event.providerId] }, before)).modified) break;
      if (attempt === 2) throw new Error('WORKFLOW_EVIDENCE_UNCONFIRMED');
    }
  }
  const prior = await read(store, prefix + event.eventId);
  if (prior && digestHash(prior.data) !== digestHash(event)) throw new Error('WORKFLOW_EVIDENCE_CONFLICT');
  if (!prior && digestHash((await write(store, prefix + event.eventId, event, null)).data) !== digestHash(event)) throw new Error('WORKFLOW_EVIDENCE_CONFLICT');
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await read(store, prefix + 'index'), ids = before?.data.ids || [];
    if (!Array.isArray(ids) || ids.length > 20) throw new Error('WORKFLOW_EVIDENCE_UNAVAILABLE');
    if (ids.includes(event.eventId)) break;
    if (ids.length === 20) throw new Error('WORKFLOW_EVIDENCE_CAPACITY');
    if ((await write(store, prefix + 'index', { ids: [...ids, event.eventId] }, before)).modified) break;
    if (attempt === 2) throw new Error('WORKFLOW_EVIDENCE_UNCONFIRMED');
  }
  let matched = false, state = 'pending';
  for (const entry of await records(store)) {
    if (entry.data.gym !== deps.scope.profile.installationId || entry.data.delivery?.state !== 'accepted' || entry.data.delivery.providerId !== event.providerId) continue;
    const decision = await evidenceDecision(store, entry.data.message, entry.data.delivery, clock(deps));
    if (decision.code === 'PROVIDER_ACCEPTANCE_ONLY') continue;
    matched = true; state = decision.state;
    await write(store, key(entry.data.messageId), { ...entry.data, ...decision }, entry);
  }
  return { ok: true, matched, state };
}
export async function workflowMessages(scope, deps = {}) {
  requireScope(scope);
  const store = await storeFor(deps);
  return { ok: true, target: 'test', messages: (await records(store)).map(entry => structuredClone(entry.data)) };
}
