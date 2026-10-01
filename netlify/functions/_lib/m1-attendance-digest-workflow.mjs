import { createHmac, randomUUID } from 'node:crypto';
import { digestHash, splitAttendanceDigest, digestGym, digestOrigin, digestPrefix, digestStoreName, latestEligibleOpportunity } from './m1-attendance-digest.mjs';
export { latestEligibleOpportunity } from './m1-attendance-digest.mjs';
import { validId } from './m1-test-read-callback.mjs';
import { validateDigestBinding } from './m1-attendance-digest-outbox.mjs';
import { readPolicyDigestEmailDelivery, deliverPolicyDigestEmail } from './m1-attendance-digest-email-delivery.mjs';
import { readMailAppDelivery, deliverMailApp } from './m1-mailapp-delivery.mjs';
import { postGoogle, runtimeConfig } from './m1-common.mjs';
import { historyRoot, historyGroup, historyRoundRobin, historyPage, changeHistoryMessage, migrateHistory, supersedeHistoryDrafts, queueHistoryWake, historyWakePending, drainHistoryWakes, advanceHistoryGeneration, readHistoryOpportunity, claimHistoryOpportunity, finishHistoryOpportunity, requireHistoryProcessor } from './m1-attendance-workflow-history.mjs';

const STORE = 'gib-m1-digest-test-workflow-v1', SCHEMA = 'm1-digest-workflow/v1';
export const WORKFLOW_DISPATCH_SCHEMA = 'm1-attendance-delivery-background/v1';
export const WORKFLOW_DISPATCH_HEADER = 'X-GIB-M1-Workflow-Signature';
export const WORKFLOW_DISPATCH_PATH = '/api/m1-attendance-delivery-background';
export const workflowDispatchSignature = (raw, secret) => createHmac('sha256', secret).update(WORKFLOW_DISPATCH_SCHEMA + '\n' + raw, 'utf8').digest('hex');
const FRESH_MS = 30 * 60000, MAX_ATTEMPTS = 6;
const BACKOFF = [15, 30, 60, 120, 240].map(minutes => minutes * 60000);
const clock = deps => (deps.clock || Date.now)();
const env = (deps, name) => deps.env ? deps.env[name] : globalThis.Netlify?.env?.get(name);
const retainedUncertainty = delivery => delivery.provider === 'mailapp'
  ? delivery.state === 'unknown' && Number.isSafeInteger(delivery.attemptCount) && delivery.attemptCount > 0
    && delivery.attemptCount <= MAX_ATTEMPTS && delivery.retryAllowed === false && delivery.durableAttempt === true
  : ['pending', 'unknown'].includes(delivery.state)
  && ['ATTEMPT_IN_PROGRESS', 'ACCEPTANCE_UNKNOWN', 'MANUAL_RECONCILIATION_REQUIRED'].includes(delivery.code)
  && Number.isSafeInteger(delivery.attemptCount) && delivery.attemptCount > 0 && Number.isSafeInteger(delivery.retryBefore)
  && Array.isArray(delivery.receipts) && delivery.receipts.length === delivery.attemptCount;
const retired = (value, head) => Boolean(head && value.date < head.data.opportunityDate);
const retirement = (value, head) => retired(value, head) ? { automaticRetriesRetired: true, retiredByOpportunity: head.data.opportunityDate, nextAttemptAt: null } : {};
const key = id => 'workflow/messages/' + id;
const canonical = message => ({ messageId: message?.messageId, from: message?.from, to: message?.to, cc: message?.cc,
  subject: message?.subject, html: message?.html, text: message?.text, synthetic: message?.synthetic, target: message?.target,
  ...(Object.hasOwn(message || {}, 'bcc') ? { bcc: message.bcc } : {}) });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
const safeAddress = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(value);
const validMessage = message => exact(message, ['messageId', 'hash', 'from', 'to', 'cc', 'subject', 'html', 'text', 'synthetic', 'target', ...(Object.hasOwn(message || {}, 'bcc') ? ['bcc'] : [])])
  && /^m1-(?:test|production)-scheduled-(rev|richmond)-\d{4}-\d{2}-\d{2}$/.test(message.messageId) && ['test', 'production'].includes(message.target) && message.messageId.startsWith('m1-' + message.target + '-scheduled-') && (message.target !== 'production' || message.synthetic === false) && typeof message.synthetic === 'boolean'
  && typeof message.from === 'string' && message.from.length > 0 && message.from.length <= 300 && !/[\r\n]/.test(message.from)
  && Array.isArray(message.to) && message.to.length === 1 && message.to.every(safeAddress)
  && Array.isArray(message.cc) && message.cc.length <= 1 && message.cc.every(safeAddress) && new Set([...message.to, ...message.cc]).size === message.to.length + message.cc.length
  && (!Object.hasOwn(message, 'bcc') || Array.isArray(message.bcc) && message.bcc.length <= 1 && message.bcc.every(safeAddress)
    && new Set([...message.to, ...message.cc, ...message.bcc].map(address => address.toLowerCase())).size === message.to.length + message.cc.length + message.bcc.length)
  && typeof message.subject === 'string' && message.subject.length > 0 && message.subject.length <= 998 && !/[\r\n]/.test(message.subject)
  && ['html', 'text'].every(field => typeof message[field] === 'string' && message[field].length > 0 && message[field].length <= 200000)
  && /^[a-f0-9]{64}$/.test(message.hash) && digestHash(canonical(message)) === message.hash;
function requireScope(scope) {
  if (!digestGym(scope)) throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
}
// The existing two-gym proposal rehearsal owns an isolated store and explicitly
// disables both send gates. It prepares synthetic bodies without a provider.
function captureOnlyRehearsal(deps) {
  return digestGym(deps.scope) === 'rev' && deps.scope.syntheticRehearsal === true && Boolean(deps.workflowStore)
    && deps.env?.GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED === 'false' && deps.env?.GIB_M1_MAILAPP_TEST_SEND_ENABLED === 'false'
    && !deps.simulatedProvider && !deps.mailappRuntime && !deps.transformMessage;
}
function scopedRoutes(input, deps) {
  requireScope(deps.scope);
  const routes = splitAttendanceDigest(input.digest, input.configuration), gym = digestGym(deps.scope);
  const isolatedSimulator = deps.simulatedProvider && input.digest.syntheticRehearsal === true && input.configuration.syntheticRehearsal === true;
  const isolatedCapture = captureOnlyRehearsal(deps) && input.digest.syntheticRehearsal === true
    && input.configuration.syntheticRehearsal === true && input.configuration.sendingEnabled === false;
  if (!isolatedSimulator && !isolatedCapture && (routes.length !== 1 || routes[0].gym !== gym)) throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
  if (input.digest.target !== deps.scope.target || routes.some(route => route.digest.target !== deps.scope.target)
    || (deps.scope.target === 'production' && (input.digest.syntheticRehearsal === true || input.configuration.syntheticRehearsal === true))) throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
  return routes;
}
const runtimeFor = deps => deps.mailappRuntime || runtimeConfig(deps.env || process.env, {
  admin: true, requestUrl: digestOrigin(deps.scope) + WORKFLOW_DISPATCH_PATH,
  installationId: digestGym(deps.scope), environment: deps.scope.profile.environment, activation: deps.scope.profile.activation
});
async function storeFor(deps) {
  if (deps.workflowStore || deps.digestStore) return deps.workflowStore || deps.digestStore;
  const { getStore } = await import('@netlify/blobs'); return getStore({ name: digestStoreName(deps.scope, 'workflow'), consistency: 'strong' });
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
function deliveryDeps(store, deps) {
  return { ...deps, deliveryStore: { getWithMetadata: (path, options) => store.getWithMetadata('workflow/delivery/' + path, options),
    set: (path, value, options) => store.set('workflow/delivery/' + path, value, options) } };
}
// Legacy provider records remain authoritative for their original day. Choosing
// Google can never reopen an attempted Resend day, or silently fall back to it.
const googlePolicy = deps => !deps.simulatedProvider || deps.simulatedProvider.kind === 'mailapp';
const senderFor = deps => googlePolicy(deps) ? 'revbjjops@gmail.com'
  : env(deps, 'GIB_M1_ATTENDANCE_DIGEST_FROM') || 'GIB Revolution TEST <onboarding@resend.dev>';
async function readDelivery(message, options, policy) {
  try {
    const google = await read(options.deliveryStore, 'mailapp/messages/' + message.messageId);
    const legacy = await read(options.deliveryStore, 'messages/' + message.messageId);
    if (google && legacy) return { state: 'blocked', code: 'WORKFLOW_PROVIDER_HISTORY_CONFLICT', retryAllowed: false };
    if (google || !legacy && googlePolicy(options)) return readMailAppDelivery(message, options, policy);
    const retained = await readPolicyDigestEmailDelivery(message, options, policy);
    return googlePolicy(options) ? { ...retained, retryAllowed: false } : retained;
  } catch { return { state: 'unknown', code: 'DELIVERY_STORAGE_UNAVAILABLE', retryAllowed: false }; }
}
async function deliverMessage(message, options, policy) {
  if (googlePolicy(options)) return deliverMailApp(message, options, policy);
  // This branch is reachable only by the isolated legacy evidence simulator.
  return deliverPolicyDigestEmail(message, options, policy);
}
function policyFor(configuration, deps) {
  const simulator = deps.simulatedProvider;
  const gate = message => {
    if (deps.processorLease && clock(deps) >= deps.processorLease.expiresAt) return { state: 'disabled', code: 'WORKFLOW_LEASE_EXPIRED' };
    if (!validMessage(message)) return { state: 'blocked', code: 'INVALID_SCHEDULED_MESSAGE' };
    if (simulator) return (message.synthetic === true || deps.scope.target === 'production' && message.synthetic === false) && typeof simulator.identity === 'string' && simulator.identity.length <= 100 && typeof simulator.send === 'function'
      ? null : { state: 'blocked', code: 'SYNTHETIC_PROVIDER_REQUIRED' };
    if (deps.scope.target === 'production' && (env(deps, 'GIB_M1_MAILAPP_LIVE_SEND_ENABLED') !== 'true' || env(deps, 'GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED') !== 'true')) return { state: 'disabled', code: 'SCHEDULED_SENDING_DISABLED' };
    if (env(deps, 'GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED') !== 'true') return { state: 'disabled', code: 'SCHEDULED_SENDING_DISABLED' };
    const approved = String(env(deps, 'GIB_M1_ATTENDANCE_DIGEST_VERIFIED_RECIPIENTS') || '').split(',').map(value => value.trim());
    if (!configuration.cutoffConfirmed || env(deps, 'GIB_M1_ATTENDANCE_DIGEST_VERIFIED_SENDER') !== message.from
      || ![...message.to, ...message.cc, ...(message.bcc || [])].every(address => approved.includes(address))) return { state: 'blocked', code: 'SCHEDULED_CONFIGURATION_UNVERIFIED' };
    if (message.from !== 'revbjjops@gmail.com' || !message.messageId.startsWith(digestPrefix(deps.scope))) return { state: 'blocked', code: 'MAILAPP_TEST_SCOPE_REQUIRED' };
    const runtime = runtimeFor(deps);
    return runtime?.target === deps.scope.target && (runtime.installationId || 'rev') === digestGym(deps.scope) ? null : { state: 'disabled', code: 'SCHEDULED_PROVIDER_UNAVAILABLE' };
  };
  return { canonical, validMessage, gate,
    beforeDispatch: async message => {
      const store = await storeFor(deps);
      await requireHistoryProcessor(store, deps.processorLease, () => clock(deps));
      const head = await readHistoryOpportunity(store, message.messageId.startsWith('m1-' + deps.scope.target + '-scheduled-rev-') ? 'rev' : 'richmond');
      if (head?.data.messageId !== message.messageId || await historyWakePending(store)) throw new Error('WORKFLOW_PROCESSOR_SUPERSEDED');
    },
    credentialFingerprint: () => digestHash(simulator ? 'm1-digest-simulator/v1\n' + simulator.identity : 'm1-mailapp-business/v1\nrevbjjops@gmail.com'),
    request: async (message, options, signal) => {
      if (simulator) return simulator.send(structuredClone(message), { ...options, signal });
      const runtime = runtimeFor(deps);
      if (runtime?.target !== deps.scope.target || (runtime.installationId || 'rev') !== digestGym(deps.scope)) throw new Error('MAILAPP_TEST_SCOPE_REQUIRED');
      const response = await postGoogle(runtime, options.action, { gym: digestGym(deps.scope), ...(digestGym(deps.scope) === 'richmond' ? { installation: 'richmond', environment: deps.scope.target } : {}), binding: options.binding, message }, deps.fetch || fetch);
      if (!response.readable) throw new Error('MAILAPP_RESPONSE_UNAVAILABLE');
      return response.value;
    } };
}
function retryDecision(delivery, now) {
  if (delivery.provider === 'mailapp' && delivery.state === 'rejected' && delivery.durableAttempt === true
    && delivery.attemptCount < MAX_ATTEMPTS && now < delivery.retryBefore) {
    const nextAttemptAt = delivery.lastAttemptAt + BACKOFF[Math.min(delivery.attemptCount - 1, BACKOFF.length - 1)];
    return { state: 'retrying', code: 'PROVEN_NO_SEND_RECHECK_PENDING', nextAttemptAt: nextAttemptAt < delivery.retryBefore ? nextAttemptAt : null };
  }
  if (delivery.provider === 'mailapp' && delivery.state !== 'not-started') return {
    state: delivery.state === 'submitted' ? 'submitted' : delivery.state === 'unknown' ? 'unconfirmed' : 'failed',
    code: delivery.code, nextAttemptAt: null
  };
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
async function records(store, ids) {
  ids ||= (await historyPage(store)).ids;
  return Promise.all(ids.map(async id => {
    const entry = await read(store, key(id));
    if (!entry || entry.data.schema !== SCHEMA || entry.data.messageId !== id || (entry.data.message && !validMessage(entry.data.message))) throw new Error('WORKFLOW_MESSAGE_UNAVAILABLE');
    return entry;
  }));
}
const routeGroup = (gym, message, fingerprint) => 'reject/' + gym + '/' + digestHash([message.from, message.to, message.cc, fingerprint]);
// Adding or removing a blind copy cannot clear an existing sender/primary-route
// rejection. Original route group keys remain valid across the BCC extension.
const recipientGroup = (gym, message) => 'bounce/' + gym + '/' + digestHash(message.to);
const uncertainRouteGroup = (gym, message) => 'uncertain-route/' + gym + '/' + digestHash([message.from, message.to]);
function projector(store, deps) {
  return async entry => {
    const value = entry.data;
    if (!value || value.schema !== SCHEMA || value.messageId !== 'm1-' + deps.scope.target + '-scheduled-' + value.gym + '-' + value.date
      || !['rev', 'richmond'].includes(value.gym) || value.message && !validMessage(value.message)) throw new Error('WORKFLOW_MESSAGE_UNAVAILABLE');
    const groups = [], options = deliveryDeps(store, deps), policy = { canonical, validMessage };
    let state = value.state;
    if (value.firstAttemptAt) {
      const delivery = await readDelivery(value.message, options, policy), decision = await evidenceDecision(store, value.message, delivery, clock(deps));
      const opportunity = await readHistoryOpportunity(store, value.gym), old = retired(value, opportunity);
      state = decision.state;
      if (retainedUncertainty(delivery)) groups.push(uncertainRouteGroup(value.gym, value.message));
      if (delivery.state === 'blocked' || delivery.state === 'unknown' && !retainedUncertainty(delivery)) groups.push('unsafe/' + value.gym);
      if ((delivery.provider !== 'mailapp' || delivery.state === 'rejected' && delivery.durableAttempt && delivery.attemptCount < MAX_ATTEMPTS)
        && !old && Number.isSafeInteger(delivery.retryBefore) && clock(deps) < delivery.retryBefore && ['unknown', 'pending', 'rejected'].includes(delivery.state)) groups.push('retry/' + value.gym);
      if (delivery.state === 'accepted') {
        groups.push('provider/' + delivery.providerId);
        if (decision.code === 'PERMANENT_RECIPIENT_BOUNCE') groups.push(recipientGroup(value.gym, value.message));
      }
      const permanent = delivery.receipts?.map((receipt, index) => receipt?.state === 'rejected' && ![408, 409, 429].includes(receipt.httpStatus) ? index : -1).filter(index => index >= 0) || [];
      if (delivery.state !== 'accepted' && permanent.length) {
        const ledger = await read(store, 'workflow/delivery/messages/' + value.messageId);
        if (!ledger || ledger.data.attempts?.length !== delivery.attemptCount) throw new Error('WORKFLOW_PRIOR_DELIVERY_UNCONFIRMED');
        permanent.forEach(index => groups.push(routeGroup(value.gym, value.message, ledger.data.attempts[index].credentialFingerprint)));
      }
      if (!['accepted', 'submitted', 'rejected'].includes(delivery.state) && (!old || !retainedUncertainty(delivery))) groups.push('unknown/' + value.gym);
    } else if (!['suppressed', 'not-due'].includes(state)) groups.push('draft/' + value.gym);
    return { messageId: value.messageId, gym: value.gym, date: value.date, sourceEtag: entry.etag, groups: [...new Set(groups)], unattempted: !value.firstAttemptAt, checkAt: value.checkAt,
      counts: { failed: Number(['failed', 'retrying'].includes(state)), unconfirmed: Number(Boolean(value.firstAttemptAt) && state === 'unconfirmed'),
        pending: Number(!value.firstAttemptAt && !['suppressed', 'not-due'].includes(state)), configuration: Number(state === 'not-configured') } };
  };
}
async function writeMessage(store, value, before, deps, guardEpoch) {
  if (deps.processorLease) await requireHistoryProcessor(store, deps.processorLease, () => clock(deps));
  return changeHistoryMessage(store, value.messageId, { etag: before?.etag || null, value,
    ...(deps.processorLease && value.firstAttemptAt && !before?.data.firstAttemptAt ? { processorLease: deps.processorLease } : {}),
    requiresNoWake: Boolean(value.firstAttemptAt && !before?.data.firstAttemptAt), ...(guardEpoch === undefined ? {} : { guardEpoch }) }, projector(store, deps), undefined, () => clock(deps));
}
export async function migrateWorkflowHistory(scope, deps = {}) {
  requireScope(scope); deps = { ...deps, scope }; const store = await storeFor(deps);
  return migrateHistory(store, projector(store, { ...deps, scope }));
}
// Read-only cross-namespace guard for a fixed, approved TEST message. It never
// migrates, reprojects, clears or copies a retained delivery barrier.
export async function readWorkflowDeliveryHold(message, scope, deps = {}) {
  requireScope(scope); deps = { ...deps, scope };
  if (!validMessage(message) || !message.messageId.startsWith(digestPrefix(scope))) throw new Error('WORKFLOW_MESSAGE_UNAVAILABLE');
  const store = await storeFor(deps), initial = await historyRoot(store, { incomplete: true });
  if (initial && (!initial.data.migration.complete || initial.data.pending) || await historyWakePending(store)) return 'PRIOR_DELIVERY_HISTORY_PENDING';
  if (await provisionalRecipientBarrier(store, digestGym(scope), message.to, { ...deps, scope }, false)) return 'PRIOR_PERMANENT_RECIPIENT_PROOF_UNRESOLVED';
  if (!initial) {
    if (await read(store, 'workflow/index')) return 'PRIOR_DELIVERY_HISTORY_PENDING';
    return null;
  }
  const fingerprint = digestHash('m1-mailapp-business/v1\nrevbjjops@gmail.com');
  const groups = await Promise.all(['unsafe/' + digestGym(scope), recipientGroup(digestGym(scope), message), routeGroup(digestGym(scope), message, fingerprint)].map(name => historyGroup(store, name, 1)));
  if ((await historyRoot(store, { incomplete: true }))?.etag !== initial.etag || await historyWakePending(store)) return 'PRIOR_DELIVERY_HISTORY_PENDING';
  return groups.some(group => group.count) ? 'PRIOR_DELIVERY_HOLD' : null;
}
async function priorDeliveryBarrier(store, gym, message, options, policy, guard = {}) {
  const initial = await historyRoot(store);
  if (await historyWakePending(store)) return 'PRIOR_DELIVERY_HISTORY_PENDING';
  if (await provisionalRecipientBarrier(store, gym, message.to, options)) return 'PRIOR_PERMANENT_RECIPIENT_PROOF_UNRESOLVED';
  const sets = await Promise.all(['unknown/' + gym, routeGroup(gym, message, policy.credentialFingerprint()), recipientGroup(gym, message)].map(name => historyGroup(store, name)));
  for (const previous of await records(store, [...new Set(sets.flatMap(value => value.ids))])) {
    if (previous.data.gym !== gym || previous.data.messageId === message.messageId || !previous.data.firstAttemptAt) continue;
    // Workflow summaries can lag a lost reply. Only the validated original
    // provider ledger may establish acceptance or a definite rejection.
    const delivery = await readDelivery(previous.data.message, options, policy);
    if (delivery.state === 'submitted') continue;
    if (delivery.state === 'accepted') {
      const receipt = await latestDeliveryEvidence(store, previous.data.message, delivery, clock(options));
      if (receipt?.type === 'email.bounced' && receipt.permanentFailure === true
        && JSON.stringify(previous.data.message.to) === JSON.stringify(message.to)) return 'PRIOR_PERMANENT_RECIPIENT_BOUNCE';
      await changeHistoryMessage(store, previous.data.messageId, null, projector(store, options));
      continue;
    }
    if (delivery.state === 'rejected' || retainedUncertainty(delivery)) {
      const sameRoute = previous.data.message.from === message.from
        && JSON.stringify(previous.data.message.to) === JSON.stringify(message.to)
        && JSON.stringify(previous.data.message.cc) === JSON.stringify(message.cc);
      const permanent = delivery.receipts.map((receipt, index) => receipt?.state === 'rejected' && ![408, 409, 429].includes(receipt.httpStatus) ? index : -1).filter(index => index >= 0);
      if (sameRoute && permanent.length) {
        const retained = await read(store, 'workflow/delivery/messages/' + previous.data.messageId);
        if (!retained || retained.data.attempts?.length !== delivery.attemptCount) throw new Error('WORKFLOW_PRIOR_DELIVERY_UNCONFIRMED');
      // A new date/body or an OFF/ON toggle is not a repair. An existing
      // verified sender/recipient or provider-credential change is the narrow
      // repair boundary, and cannot release an unknown-acceptance original.
        if (permanent.some(index => retained.data.attempts[index].credentialFingerprint === policy.credentialFingerprint())) return 'PRIOR_PERMANENT_REJECTION_UNCHANGED';
      }
      if (delivery.state === 'rejected' || previous.data.date < message.messageId.slice(-10)) continue;
    }
    return 'PRIOR_ACCEPTANCE_UNCONFIRMED';
  }
  const final = await historyRoot(store);
  if (initial.etag !== final.etag || await historyWakePending(store)) return 'PRIOR_DELIVERY_HISTORY_PENDING';
  guard.epoch = final.data.epoch;
  return sets.some(value => value.count > value.ids.length) ? 'PRIOR_DELIVERY_HISTORY_PENDING' : null;
}
async function healthEvidence(store, input, now, deps) {
  const policy = policyFor(input.configuration, deps);
  const value = { requestId: input.binding.requestId, checkedAt: input.binding.createdAt, expiresAt: input.binding.createdAt + FRESH_MS,
    digestHash: digestHash(input.digest), complete: input.digest.readFailures.length === 0, itemCount: input.digest.itemCount, due: input.due,
    configured: input.configuration.cutoffConfirmed === true, observedAt: now,
    gyms: input.digest.groups.map(group => ({ gym: group.gym, itemCount: group.items.length, complete: !input.digest.readFailures.some(failure => failure.gym === group.gym),
      deliveryRoute: { from: senderFor(deps),
        to: input.configuration.routing[group.gym].reviewer.address ? [input.configuration.routing[group.gym].reviewer.address] : [],
        cc: input.configuration.routing[group.gym].cc.map(person => person.address), fingerprint: policy.credentialFingerprint(),
        ...(Object.hasOwn(input.configuration.routing[group.gym], 'bcc') ? { bcc: input.configuration.routing[group.gym].bcc.map(person => person.address) } : {}) } })) };
  for (let count = 0; count < 3; count++) {
    const before = await read(store, 'workflow/health');
    if (before && (before.data.checkedAt > value.checkedAt || (before.data.checkedAt === value.checkedAt && !before.data.complete && value.complete))) return before.data;
    if (before?.data.requestId === value.requestId) {
      if (before.data.digestHash !== value.digestHash) throw new Error('WORKFLOW_CHECK_CONFLICT');
      return before.data;
    }
    await requireHistoryProcessor(store, deps.processorLease, () => clock(deps));
    if ((await write(store, 'workflow/health', value, before)).modified) return value;
  }
  throw new Error('WORKFLOW_HEALTH_UNCONFIRMED');
}

// One scheduled tick uses its newly authenticated read, never a previous daily
// capture, to decide whether an unattempted message is still needed.
async function processWorkflow(input, deps = {}) {
  requireScope(deps.scope);
  const now = clock(deps); validateDigestBinding(input.binding, now, deps.scope.target);
  if (input.binding.mode !== 'scheduled' || !['due', 'not-due', 'awaiting-configuration'].includes(input.due)
    || input.digest.date !== input.binding.jobDate || Date.parse(input.digest.generatedAt) < input.binding.createdAt || Date.parse(input.digest.generatedAt) > now) throw new Error('WORKFLOW_FRESH_CHECK_REQUIRED');
  const routes = scopedRoutes(input, deps), store = await storeFor(deps);
  if (input.dueByGym && (!exact(input.dueByGym, routes.map(route => route.gym))
    || Object.values(input.dueByGym).some(due => !['due', 'not-due', 'awaiting-configuration'].includes(due)))) throw new Error('WORKFLOW_FRESH_CHECK_REQUIRED');
  if (input.opportunityDueByGym && (!exact(input.opportunityDueByGym, routes.map(route => route.gym))
    || Object.values(input.opportunityDueByGym).some(due => !['due', 'not-due', 'awaiting-configuration'].includes(due)))) throw new Error('WORKFLOW_FRESH_CHECK_REQUIRED');
  if (!(await migrateWorkflowHistory(deps.scope, deps)).complete) throw new Error('WORKFLOW_HISTORY_MIGRATION_PENDING');
  await drainWorkflowWakes(store, deps);
  const evidence = await healthEvidence(store, input, now, deps), policy = policyFor(input.configuration, deps), options = deliveryDeps(store, deps);
  if (evidence.checkedAt > input.binding.createdAt || evidence.requestId !== input.binding.requestId) return workflowHealth(deps.scope, deps);
  const opportunities = new Map();
  for (const route of routes) {
    const opportunity = latestEligibleOpportunity(input.configuration, input.binding.createdAt, route.gym);
    const gym = input.configuration.gyms.find(gym => gym.id === route.gym);
    if (!input.dueByGym && gym.dailyLocalTime && gym.dailyLocalTime !== input.configuration.dailyLocalTime) throw new Error('WORKFLOW_GYM_DUE_REQUIRED');
    const due = input.dueByGym?.[route.gym] ?? input.due;
    const eligible = Boolean(opportunity && (input.opportunityDueByGym ? input.opportunityDueByGym[route.gym] === 'due' : opportunity.beforeCutoff || due === 'due'));
    const head = eligible ? await claimHistoryOpportunity(store, { gym: route.gym, opportunityDate: opportunity.date,
      messageId: 'm1-' + deps.scope.target + '-scheduled-' + route.gym + '-' + opportunity.date, assessmentDate: input.binding.jobDate,
      assessedAt: input.binding.createdAt, requestId: input.binding.requestId, digestHash: digestHash(route.digest) }, deps.processorLease, () => clock(deps)) : await readHistoryOpportunity(store, route.gym);
    opportunities.set(route.gym, { opportunity, head, eligible });
    if (!route.digest.readFailures.length) {
      await requireHistoryProcessor(store, deps.processorLease, () => clock(deps));
      await supersedeHistoryDrafts(store, route.gym, input.binding.createdAt);
    }
  }
  const oldDrafts = await Promise.all(routes.flatMap(route => ['draft/' + route.gym, 'unknown/' + route.gym]).map(name => historyGroup(store, name)));
  const dueOriginals = await Promise.all(routes.map(route => historyRoundRobin(store, 'retry/' + route.gym)));
  const active = [...new Set([...(await historyPage(store)).ids, ...oldDrafts.flatMap(group => group.ids), ...dueOriginals.flatMap(group => group.ids)])];
  for (const previous of await records(store, active)) {
    if (!routes.some(route => route.gym === previous.data.gym)) continue;
    if (captureOnlyRehearsal(deps) && previous.data.firstAttemptAt) throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
    if (previous.data.firstAttemptAt && previous.data.claimUntil && clock(deps) >= previous.data.claimUntil) {
      const retained = await readDelivery(previous.data.message, options, policy);
      if (retained.state === 'not-started') {
        // A complete central read proves there is no provider claim. Only after
        // the fenced first-call lease expires may fresh data replace this draft.
        await writeMessage(store, { ...previous.data, firstAttemptAt: null, claimUntil: null,
          state: 'prepared', code: 'NO_PROVIDER_ATTEMPT_CONFIRMED', delivery: retained }, previous, deps);
        continue;
      }
    }
    const opportunityHead = opportunities.get(previous.data.gym)?.head;
    if (previous.data.firstAttemptAt && retired(previous.data, opportunityHead)) {
      const delivery = await readDelivery(previous.data.message, options, policy);
      await writeMessage(store, { ...previous.data, delivery, ...await evidenceDecision(store, previous.data.message, delivery, clock(deps)),
        ...retirement(previous.data, opportunityHead) }, previous, deps);
      continue;
    }
    if (!previous.data.firstAttemptAt && previous.data.date < input.binding.jobDate && previous.data.checkAt <= input.binding.createdAt
      && routes.some(route => route.gym === previous.data.gym && !route.digest.readFailures.length)) {
      await writeMessage(store, { ...previous.data, state: 'suppressed', code: 'SUPERSEDED_BY_FRESH_CHECK', checkAt: input.binding.createdAt }, previous, deps);
    }
  }
  let attempts = 0;
  for (const route of routes) {
    const { opportunity, head, eligible } = opportunities.get(route.gym), date = opportunity?.date || input.binding.jobDate;
    const messageId = 'm1-' + deps.scope.target + '-scheduled-' + route.gym + '-' + date;
    let before = await read(store, key(messageId));
    if (head && (head.data.opportunityDate !== date || head.data.decision !== 'open' || head.data.requestId !== input.binding.requestId)) continue;
    if (before?.data.firstAttemptAt) {
      const retained = await readDelivery(before.data.message, options, policy);
      if (head && ['accepted', 'submitted', 'rejected', 'pending'].includes(retained.state) || head && retainedUncertainty(retained))
        await finishHistoryOpportunity(store, head, 'message', deps.processorLease, () => clock(deps));
      continue;
    }
    if (before?.data.checkAt > input.binding.createdAt) continue;
    const canPrepare = route.routeStatus === 'ready';
    const assessment = 'Reminder opportunity: ' + date + '. Fresh assessment: ' + input.digest.generatedAt + ' (' + input.binding.jobDate + ', America/New_York).';
    const rendered = route.rendered && { subject: route.rendered.subject + ' · reminder ' + date,
      text: assessment + '\n\n' + route.rendered.text, html: route.rendered.html.replace('<h1 ', '<p>' + assessment + '</p><h1 ') };
    let message = canPrepare ? { messageId, from: senderFor(deps),
      to: route.to, cc: route.cc, ...rendered, synthetic: input.digest.syntheticRehearsal === true, target: deps.scope.target,
      ...(Object.hasOwn(route, 'bcc') ? { bcc: route.bcc } : {}) } : null;
    if (message && deps.transformMessage) {
      const transformed = deps.transformMessage(structuredClone(message));
      if (!exact(transformed, Object.keys(message)) || ['messageId', 'from', 'to', 'cc', 'bcc', 'synthetic', 'target'].some(field =>
        JSON.stringify(transformed[field]) !== JSON.stringify(message[field]))) throw new Error('WORKFLOW_MESSAGE_TRANSFORM_INVALID');
      message = transformed;
    }
    if (message) message.hash = digestHash(canonical(message));
    if (message && !validMessage(message)) throw new Error('WORKFLOW_MESSAGE_TRANSFORM_INVALID');
    const gated = message ? policy.gate(message, deps) : null;
    const value = { schema: SCHEMA, messageId, gym: route.gym, date, assessmentDate: input.binding.jobDate, checkAt: input.binding.createdAt,
      firstAttemptAt: null, state: !eligible ? 'not-due' : route.routeStatus === 'suppressed' ? 'suppressed' : route.routeStatus === 'blocked' ? 'not-configured' : 'prepared',
      code: route.code, message, attemptCount: 0, nextAttemptAt: null, retryBefore: null, delivery: null };
    if (value.state === 'prepared' && gated) { value.state = 'not-configured'; value.code = gated.code; }
    const priorBarrier = value.state === 'prepared' ? await priorDeliveryBarrier(store, route.gym, message, options, policy) : null;
    if (priorBarrier) value.code = priorBarrier;
    const saved = await writeMessage(store, value, before, deps);
    if (saved.modified && head && value.state === 'suppressed') await finishHistoryOpportunity(store, head, 'clean', deps.processorLease, () => clock(deps));
    if (!saved.modified || value.state !== 'prepared' || priorBarrier) continue;
    if (attempts >= MAX_ATTEMPTS) continue;
    // CAS freezes the fresh message before the shared engine claims its first
    // attempt. A later check cannot rewrite this body or its recipient list.
    const latest = await read(store, 'workflow/health');
    if (latest?.data.requestId !== input.binding.requestId || clock(deps) >= input.binding.expiresAt || await historyWakePending(store)) continue;
    const guard = {}, confirmedBarrier = await priorDeliveryBarrier(store, route.gym, message, options, policy, guard);
    if (confirmedBarrier) { await writeMessage(store, { ...saved.data, code: confirmedBarrier }, saved, deps); continue; }
    const claimUntil = clock(deps) + 60000;
    const claimed = await writeMessage(store, { ...value, firstAttemptAt: clock(deps), claimUntil, state: 'unconfirmed', code: 'ATTEMPT_CLAIMED' }, saved, deps, guard.epoch);
    if (!claimed.modified) continue;
    const firstPolicy = { ...policy, gate: (...args) => clock(deps) >= claimUntil ? { state: 'disabled', code: 'FIRST_ATTEMPT_LEASE_EXPIRED' } : policy.gate(...args),
      beforeDispatch: async () => {
        await requireHistoryProcessor(store, deps.processorLease, () => clock(deps));
        const currentHead = await readHistoryOpportunity(store, route.gym), currentCheck = await read(store, 'workflow/health');
        if (clock(deps) >= claimUntil || currentHead?.etag !== head?.etag || currentHead?.data.decision !== 'open'
          || currentCheck?.data.requestId !== input.binding.requestId || await historyWakePending(store)) throw new Error('WORKFLOW_PROCESSOR_SUPERSEDED');
      } };
    const delivery = await deliverMessage(message, options, firstPolicy);
    attempts++;
    await writeMessage(store, { ...claimed.data, delivery, attemptCount: delivery.attemptCount || 0, retryBefore: delivery.retryBefore || null,
      ...retryDecision(delivery, clock(deps)) }, claimed, deps);
    const confirmed = await readDelivery(message, options, policy);
    if (head && (['accepted', 'submitted', 'rejected', 'pending'].includes(confirmed.state) || retainedUncertainty(confirmed)))
      await finishHistoryOpportunity(store, head, 'message', deps.processorLease, () => clock(deps));
  }
  // The Google timer also recovers prior-day attempts. No newer digest can
  // mutate them or reset their original 23-hour identity window.
  for (const entry of await records(store, [...new Set([...active, ...(await historyPage(store)).ids])])) {
    if (!routes.some(route => route.gym === entry.data.gym) || !entry.data.firstAttemptAt) continue;
    const head = await readHistoryOpportunity(store, entry.data.gym);
    let delivery = await readDelivery(entry.data.message, options, policy);
    // At most one current-day status check per tick. An existing Google claim
    // authorizes only this read; it can never authorize another send.
    if (delivery.provider === 'mailapp' && retainedUncertainty(delivery) && !retired(entry.data, head)
      && head?.data.opportunityDate === entry.data.date && attempts < MAX_ATTEMPTS) {
      delivery = await deliverMailApp(entry.data.message, options, policy);
      attempts++;
    }
    let decision = await evidenceDecision(store, entry.data.message, delivery, clock(deps));
    if (!retired(entry.data, head) && head?.data.opportunityDate === entry.data.date && attempts < MAX_ATTEMPTS && decision.nextAttemptAt !== null && clock(deps) >= decision.nextAttemptAt && !policy.gate(entry.data.message, deps)) {
      const sent = await deliverMessage(entry.data.message, options, policy);
      attempts++;
      decision = await evidenceDecision(store, entry.data.message, sent, clock(deps));
      await writeMessage(store, { ...entry.data, delivery: sent, attemptCount: sent.attemptCount || 0,
        retryBefore: sent.retryBefore || null, ...decision }, entry, deps);
    } else {
      await writeMessage(store, { ...entry.data, delivery, attemptCount: delivery.attemptCount || 0,
        retryBefore: delivery.retryBefore || null, ...decision, ...retirement(entry.data, head) }, entry, deps);
    }
  }
  await drainWorkflowWakes(store, deps);
  return workflowHealth(deps.scope, deps);
}

export async function processAttendanceWorkflow(input, deps = {}) {
  scopedRoutes(input, deps);
  const store = await storeFor(deps), now = clock(deps), previous = await read(store, 'workflow/processor');
  const pending = async () => {
    try { return { ...(await workflowHealth(deps.scope, deps)), pending: true }; }
    catch (error) {
      if (!String(error?.message).startsWith('WORKFLOW_HISTORY_')) throw error;
      return { ok: true, target: deps.scope.target, state: 'check-incomplete', codes: ['CHECK_INCOMPLETE'], checkedAt: null, expiresAt: null,
        pendingCount: 0, failedCount: 0, unconfirmedCount: 0, pending: true };
    }
  };
  if (previous?.data.expiresAt > now) return pending();
  const lease = { owner: randomUUID(), expiresAt: now + 10 * 60000 };
  const claimed = await write(store, 'workflow/processor', lease, previous);
  if (!claimed.modified) return pending();
  try { return await processWorkflow(input, { ...deps, processorLease: lease }); }
  finally {
    const current = await read(store, 'workflow/processor');
    if (current?.data.owner === lease.owner) await write(store, 'workflow/processor', { owner: lease.owner, expiresAt: 0 }, current);
  }
}

export async function workflowHealth(scope, deps = {}) {
  requireScope(scope); deps = { ...deps, scope };
  deps = { ...deps, scope };
  const store = await storeFor(deps), now = clock(deps), check = (await read(store, 'workflow/health'))?.data;
  const history = await historyRoot(store, { incomplete: true }), codes = [];
  if (history && (!history.data.migration.complete || history.data.pending) || await historyWakePending(store)) codes.push('CHECK_INCOMPLETE');
  if (check && (!Number.isSafeInteger(check.checkedAt) || check.expiresAt !== check.checkedAt + FRESH_MS || !Array.isArray(check.gyms))) throw new Error('WORKFLOW_HEALTH_UNAVAILABLE');
  const own = check?.gyms.find(gym => gym.gym === scope.profile.installationId);
  const counts = history?.data.counts[scope.profile.installationId];
  const opportunity = await readHistoryOpportunity(store, scope.profile.installationId);
  if (history && !history.data.pending && history.data.migration.complete && (await historyGroup(store, 'unsafe/' + scope.profile.installationId, 1)).count) codes.push('CHECK_INCOMPLETE');
  let unconfirmedCount = opportunity ? 0 : counts?.unconfirmed || 0;
  let currentFailed = 0;
  if (opportunity) {
    const current = await read(store, key(opportunity.data.messageId));
    if (opportunity.data.decision === 'open' || !current) codes.push('CHECK_INCOMPLETE');
    if (current?.data.firstAttemptAt) {
      const delivery = await readDelivery(current.data.message, deliveryDeps(store, deps), { canonical, validMessage });
      const decision = await evidenceDecision(store, current.data.message, delivery, now);
      unconfirmedCount = Number(decision.state === 'unconfirmed');
      currentFailed = Number(['failed', 'retrying'].includes(decision.state));
      if (delivery.state === 'blocked' || delivery.state === 'unknown' && !retainedUncertainty(delivery)) codes.push('CHECK_INCOMPLETE');
    }
  }
  const historicalUnconfirmedCount = Math.max(0, (counts?.unconfirmed || 0) - unconfirmedCount);
  let failedCount = opportunity ? currentFailed : counts?.failed || 0;
  const route = own?.deliveryRoute;
  if (route) {
    if (!exact(route, ['from', 'to', 'cc', 'fingerprint', ...(Object.hasOwn(route, 'bcc') ? ['bcc'] : [])]) || typeof route.from !== 'string' || !Array.isArray(route.to) || route.to.length > 1
      || !route.to.every(safeAddress) || !Array.isArray(route.cc) || route.cc.length > 1 || !route.cc.every(safeAddress)
      || Object.hasOwn(route, 'bcc') && (!Array.isArray(route.bcc) || route.bcc.length > 1 || !route.bcc.every(safeAddress))
      || !/^[a-f0-9]{64}$/.test(route.fingerprint)) throw new Error('WORKFLOW_HEALTH_UNAVAILABLE');
    if (route.to.length && history && !history.data.pending && history.data.migration.complete) {
      const holds = await Promise.all([routeGroup(scope.profile.installationId, route, route.fingerprint), recipientGroup(scope.profile.installationId, route)].map(name => historyGroup(store, name, 1)));
      const provisional = await provisionalRecipientBarrier(store, scope.profile.installationId, route.to, deps, false);
      failedCount = Math.max(failedCount, ...holds.map(group => group.count), Number(provisional));
    }
  }
  const historicalFailedCount = Math.max(0, (counts?.failed || 0) - currentFailed), pendingCount = counts?.pending || 0;
  if (check?.configured && now >= check.expiresAt) codes.push('CHECK_OVERDUE');
  if (check && own?.complete !== true) codes.push('CHECK_INCOMPLETE');
  if (failedCount) codes.push('DELIVERY_FAILED');
  if (unconfirmedCount) codes.push('DELIVERY_UNCONFIRMED');
  if (!check?.configured || counts?.configuration) codes.push('CONFIGURATION_REQUIRED');
  const head = (await read(store, 'workflow/job-head'))?.data;
  if (head && (!Number.isSafeInteger(head.checkedAt) || !['queued', 'running', 'complete', 'needs-fresh-check', 'dispatch-unconfirmed'].includes(head.state))) throw new Error('WORKFLOW_HEALTH_UNAVAILABLE');
  if (head && (!check || head.checkedAt > check.checkedAt || head.jobId === check.requestId)) {
    if (head.state === 'needs-fresh-check') codes.push('CHECK_INCOMPLETE');
    else if (head.state !== 'complete') codes.push('DELIVERY_UNCONFIRMED');
  }
  const after = await historyRoot(store, { incomplete: true });
  if (after?.etag !== history?.etag || (await readHistoryOpportunity(store, scope.profile.installationId))?.etag !== opportunity?.etag) throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
  if (await historyWakePending(store) && !codes.includes('CHECK_INCOMPLETE')) codes.push('CHECK_INCOMPLETE');
  const state = codes.includes('CHECK_OVERDUE') ? 'check-overdue' : codes.includes('CHECK_INCOMPLETE') ? 'check-incomplete'
    : codes.includes('DELIVERY_FAILED') ? 'delivery-failed' : codes.includes('DELIVERY_UNCONFIRMED') ? 'delivery-unconfirmed'
    : codes.includes('CONFIGURATION_REQUIRED') ? 'not-configured' : own?.itemCount ? 'attention' : 'clear';
  return { ok: true, target: deps.scope.target, state, codes, checkedAt: check ? new Date(check.checkedAt).toISOString() : null, expiresAt: check ? new Date(check.expiresAt).toISOString() : null,
    pendingCount, failedCount, unconfirmedCount, historicalUnconfirmedCount, historicalFailedCount, opportunityDate: opportunity?.data.opportunityDate || null };
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
  validateDigestBinding(input.binding, clock(deps), deps.scope.target);
  if (runtime?.target !== deps.scope.target || (runtime.installationId || 'rev') !== digestGym(deps.scope) || input.binding.mode !== 'scheduled') throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
  scopedRoutes(input, deps);
  const store = await storeFor(deps), id = input.binding.requestId, path = 'workflow/jobs/' + id;
  const value = { schema: WORKFLOW_DISPATCH_SCHEMA, input: structuredClone(input), inputHash: digestHash(input), state: 'queued', createdAt: clock(deps), leaseUntil: null };
  const saved = await write(store, path, value, null);
  if (saved.data.inputHash !== value.inputHash || digestHash(saved.data.input) !== value.inputHash) throw new Error('WORKFLOW_JOB_CONFLICT');
  if (!saved.modified) return { queued: true, jobId: id, state: saved.data.state };
  await jobHead(store, saved.data);
  const raw = JSON.stringify({ jobId: id });
  try {
    const response = await (deps.backgroundFetch || deps.fetch || fetch)(digestOrigin(deps.scope) + WORKFLOW_DISPATCH_PATH, { method: 'POST', redirect: 'error',
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
  requireScope(scope); deps = { ...deps, scope };
  if (!validId(jobId)) throw new Error('WORKFLOW_JOB_INVALID');
  const store = await storeFor(deps), path = 'workflow/jobs/' + jobId, before = await read(store, path), now = clock(deps);
  if (!before || before.data.schema !== WORKFLOW_DISPATCH_SCHEMA || before.data.input?.binding.requestId !== jobId
    || before.data.inputHash !== digestHash(before.data.input)) throw new Error('WORKFLOW_JOB_UNAVAILABLE');
  scopedRoutes(before.data.input, { ...deps, scope });
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
    // The supported background invocation completes the finite legacy upgrade
    // in bounded batches. If its read expires meanwhile, the next fresh tick
    // resumes normal work; migration never authorizes dispatch of stale data.
    const migrationDeadline = clock(deps) + 5 * 60000;
    for (let batch = 0; batch < 16; batch++) {
      if ((await migrateWorkflowHistory(scope, deps)).complete) break;
      if (clock(deps) >= migrationDeadline) throw new Error('WORKFLOW_HISTORY_MIGRATION_PENDING');
    }
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
  return receipt?.type === 'email.delivered' ? message.cc.length || message.bcc?.length ? { state: 'unconfirmed', code: message.bcc?.length ? 'BCC_DELIVERY_UNCONFIRMED' : 'CC_DELIVERY_UNCONFIRMED', nextAttemptAt: null }
    : { state: 'delivered', code: 'PROVIDER_DELIVERY_CONFIRMED', nextAttemptAt: null } : ordinary;
}
async function persistDeliveryEvidence(store, event) {
  const prefix = 'workflow/provider-evidence/' + event.providerId + '/';
  const prior = await read(store, prefix + event.eventId);
  if (prior && digestHash(prior.data) !== digestHash(event)) throw new Error('WORKFLOW_EVIDENCE_CONFLICT');
  if (!prior && digestHash((await write(store, prefix + event.eventId, event, null)).data) !== digestHash(event)) throw new Error('WORKFLOW_EVIDENCE_CONFLICT');
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await read(store, prefix + 'index'), ids = before?.data.ids || [];
    if (!Array.isArray(ids) || ids.length > 20) throw new Error('WORKFLOW_EVIDENCE_UNAVAILABLE');
    if (ids.includes(event.eventId)) return;
    if (ids.length === 20) throw new Error('WORKFLOW_EVIDENCE_CAPACITY');
    if ((await write(store, prefix + 'index', { ids: [...ids, event.eventId] }, before)).modified) return;
  }
  throw new Error('WORKFLOW_EVIDENCE_UNCONFIRMED');
}
const provisionalHoldPrefix = (gym, to) => 'workflow/provisional-recipient/' + gym + '/' + digestHash(to) + '/';
async function addProvisionalRecipientHold(store, gym, event) {
  if (event.type !== 'email.bounced' || event.permanentFailure !== true) return;
  const prefix = provisionalHoldPrefix(gym, event.to), marker = prefix + 'applied/' + digestHash([event.providerId, event.eventId]);
  if (await read(store, marker)) return;
  for (let count = 0; count < 3; count++) {
    const head = await read(store, prefix + 'head'), id = randomUUID();
    await write(store, prefix + 'nodes/' + id, { id, providerId: event.providerId, eventId: event.eventId, next: head?.data.id || null }, null);
    if ((await write(store, prefix + 'head', { id }, head)).modified) {
      await write(store, marker, { providerId: event.providerId, eventId: event.eventId }, null); return;
    }
  }
  throw new Error('WORKFLOW_RECIPIENT_PROOF_UNCONFIRMED');
}
async function provisionalRecipientBarrier(store, gym, to, deps, advance = true) {
  const prefix = provisionalHoldPrefix(gym, to);
  let cursor;
  for (let count = 0; count < 8; count++) {
    const head = await read(store, prefix + 'head'), id = !advance && cursor !== undefined ? cursor : head?.data.id;
    if (!id) return false;
    const node = (await read(store, prefix + 'nodes/' + id))?.data;
    if (!node || node.id !== id) throw new Error('WORKFLOW_RECIPIENT_PROOF_UNAVAILABLE');
    const originalEvent = (await read(store, 'workflow/provider-evidence/' + node.providerId + '/' + node.eventId))?.data;
    if (!originalEvent || originalEvent.permanentFailure !== true || JSON.stringify(originalEvent.to) !== JSON.stringify(to)) throw new Error('WORKFLOW_RECIPIENT_PROOF_UNAVAILABLE');
    const bound = await historyGroup(store, 'provider/' + node.providerId, 8);
    if (bound.count > bound.ids.length) throw new Error('WORKFLOW_PROVIDER_ID_AMBIGUOUS');
    let resolved = false;
    for (const original of await records(store, bound.ids)) {
      if (original.data.gym !== gym || original.data.message.from !== originalEvent.from || JSON.stringify(original.data.message.to) !== JSON.stringify(to)) continue;
      const delivery = await readDelivery(original.data.message, deliveryDeps(store, deps), { canonical, validMessage });
      const latest = await latestDeliveryEvidence(store, original.data.message, delivery, clock(deps));
      if (delivery.state === 'accepted' && delivery.providerId === node.providerId && latest?.type === 'email.delivered'
        && Date.parse(latest.occurredAt) > Date.parse(originalEvent.occurredAt)) resolved = true;
    }
    if (!resolved) return true;
    if (advance) await write(store, prefix + 'head', { id: node.next }, head);
    else cursor = node.next;
  }
  return true; // bounded continuation; never infer clear from an unread tail
}
async function drainWorkflowWakes(store, deps) {
  return drainHistoryWakes(store, async node => {
    // The published wake owns all event/index/source updates. No delayed writer
    // can commit new evidence after its wake has already been removed.
    await persistDeliveryEvidence(store, node.event);
    // Provider-keyed provisional evidence is not assigned to a same-address
    // message. An exact later accepted provider ID is the only binding.
    if (node.messageId === null) {
      await addProvisionalRecipientHold(store, digestGym(deps.scope), node.event);
      await advanceHistoryGeneration(store); return;
    }
    const entry = (await records(store, [node.messageId]))[0];
    const delivery = await readDelivery(entry.data.message, deliveryDeps(store, deps), { canonical, validMessage });
    if (delivery.state === 'pending') { await changeHistoryMessage(store, node.messageId, null, projector(store, deps)); return; }
    const decision = await evidenceDecision(store, entry.data.message, delivery, clock(deps));
    await writeMessage(store, { ...entry.data, delivery, attemptCount: delivery.attemptCount || 0,
      retryBefore: delivery.retryBefore || null, ...decision }, entry, deps);
  });
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
  const store = await storeFor(deps);
  if (!await read(store, 'workflow/history/root') && !await read(store, 'workflow/index')) return { ok: true, matched: false, state: 'ignored' };
  if (!(await migrateWorkflowHistory(deps.scope, deps)).complete) throw new Error('WORKFLOW_HISTORY_MIGRATION_PENDING');
  const provider = await historyGroup(store, 'provider/' + event.providerId, 16);
  if (provider.count > provider.ids.length) throw new Error('WORKFLOW_PROVIDER_ID_AMBIGUOUS');
  const uncertain = await historyGroup(store, uncertainRouteGroup(deps.scope.profile.installationId, event));
  const legacyUnknown = await historyGroup(store, 'unknown/' + deps.scope.profile.installationId);
  const originals = await records(store, [...new Set([...provider.ids, ...uncertain.ids, ...legacyUnknown.ids, ...(await historyPage(store)).ids])]);
  let candidate, provisionalAttempt;
  for (const entry of originals) {
    if (entry.data.gym !== deps.scope.profile.installationId || !entry.data.firstAttemptAt || entry.data.message.from !== event.from
      || JSON.stringify(entry.data.message.to) !== JSON.stringify(event.to)) continue;
    const retained = await readDelivery(entry.data.message, deliveryDeps(store, deps), { canonical, validMessage });
    if (retained.state === 'accepted' && retained.providerId === event.providerId) { candidate = entry; break; }
    if (retained.provider !== 'mailapp' && retainedUncertainty(retained) && !provisionalAttempt) {
      const ledger = await read(store, 'workflow/delivery/messages/' + entry.data.messageId);
      const attempt = ledger?.data.attempts?.at(-1);
      if (!attempt || ledger.data.attempts.length !== retained.attemptCount) throw new Error('WORKFLOW_EVIDENCE_UNAVAILABLE');
      if (Date.parse(event.occurredAt) < ledger.data.createdAt - 300000) continue;
      provisionalAttempt = attempt.attemptId;
    }
  }
  if (!candidate && !provisionalAttempt) return { ok: true, matched: false, state: 'ignored' };
  // An early signed event may precede provider acceptance. It must still match
  // an actual in-flight original, and each original admits only bounded IDs.
  if (!candidate) {
    const indexPath = 'workflow/provisional-provider-budget/' + provisionalAttempt;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await read(store, indexPath), ids = before?.data.ids || [];
      if (!Array.isArray(ids) || ids.length > 20) throw new Error('WORKFLOW_EVIDENCE_UNAVAILABLE');
      if (ids.includes(event.providerId)) break;
      if (ids.length === 20) return { ok: true, matched: false, state: 'ignored' };
      if ((await write(store, indexPath, { ids: [...ids, event.providerId] }, before)).modified) break;
      if (attempt === 2) throw new Error('WORKFLOW_EVIDENCE_UNCONFIRMED');
    }
  }
  const prefix = 'workflow/provider-evidence/' + event.providerId + '/';
  const prior = await read(store, prefix + event.eventId);
  if (prior && digestHash(prior.data) !== digestHash(event)) throw new Error('WORKFLOW_EVIDENCE_CONFLICT');
  const intentKey = 'workflow/history/event-intents/' + digestHash([event.providerId, event.eventId]);
  const intended = await write(store, intentKey, event, null);
  if (digestHash(intended.data) !== digestHash(event)) throw new Error('WORKFLOW_EVIDENCE_CONFLICT');
  await queueHistoryWake(store, candidate?.data.messageId || null, event);
  await drainWorkflowWakes(store, deps);
  if (!candidate) return { ok: true, matched: false, state: 'pending' };
  const actual = (await records(store, [candidate.data.messageId]))[0].data;
  return actual.delivery?.state === 'accepted' && actual.delivery.providerId === event.providerId
    ? { ok: true, matched: true, state: actual.state } : { ok: true, matched: false, state: 'pending' };
}
export async function workflowMessages(scope, deps = {}) {
  requireScope(scope); deps = { ...deps, scope };
  const store = await storeFor(deps);
  const root = await historyRoot(store), page = await historyPage(store, deps.historyCursor);
  const opportunities = new Map(await Promise.all(['rev', 'richmond'].map(async gym => [gym, await readHistoryOpportunity(store, gym)])));
  const retained = await records(store, page.ids), captureOnly = captureOnlyRehearsal({ ...deps, scope });
  if (captureOnly && retained.some(entry => entry.data.firstAttemptAt || entry.data.message && entry.data.message.synthetic !== true)) throw new Error('WORKFLOW_TEST_SCOPE_REQUIRED');
  const messages = retained.filter(entry => deps.simulatedProvider || captureOnly || entry.data.gym === digestGym(scope))
    .map(entry => ({ ...structuredClone(entry.data), ...retirement(entry.data, opportunities.get(entry.data.gym)) }));
  for (const [gym, before] of opportunities) if ((await readHistoryOpportunity(store, gym))?.etag !== before?.etag) throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
  if ((await historyRoot(store))?.etag !== root?.etag || await historyWakePending(store)) throw new Error('WORKFLOW_HISTORY_TRANSITION_PENDING');
  return { ok: true, target: scope.target, messages, nextCursor: page.nextCursor, historyComplete: true };
}
