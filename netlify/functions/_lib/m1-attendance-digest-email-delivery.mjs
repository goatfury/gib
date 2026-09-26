import { randomUUID } from 'node:crypto';
import { digestHash } from './m1-attendance-digest.mjs';

const MESSAGE_ID = 'm1-test-email-andrew-20260926-v1';
const SENDER = 'GIB Revolution TEST <onboarding@resend.dev>';
const STORE = 'gib-m1-digest-test-delivery-v1';
const SCHEMA = 'm1-digest-test-email-delivery/v1';
const RECEIPT_SCHEMA = 'm1-digest-test-email-attempt/v1';
const PROVIDER_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 25000, LEASE_MS = 60000, RETRY_MS = 23 * 60 * 60 * 1000, MAX_ATTEMPTS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
const stamp = value => Number.isSafeInteger(value) && value >= 0;
const clock = deps => (deps.now || deps.clock || Date.now)();
const env = (deps, name) => deps.env ? deps.env[name] : globalThis.Netlify?.env?.get(name);
// Retained only server-side: a provider key may select another account with a separate dedupe namespace.
const credentialFingerprint = deps => digestHash('m1-digest-test-email-resend-credential/v1\n' + env(deps, 'GIB_M1_DIGEST_TEST_RESEND_API_KEY'));
const scopeIsValid = deps => deps.scope?.target === 'test' && deps.scope.profile?.installationId === 'rev';
const messageKey = id => 'messages/' + id;
const receiptKey = (id, attemptId) => 'attempts/' + id + '/' + attemptId;
const canonical = message => ({ messageId: message?.messageId, from: message?.from, to: message?.to,
  subject: message?.subject, html: message?.html, text: message?.text, synthetic: message?.synthetic, target: message?.target });
export const hashTestDigestEmail = message => digestHash(canonical(message));

function validMessage(message) {
  return exact(message, ['messageId', 'hash', 'from', 'to', 'subject', 'html', 'text', 'synthetic', 'target'])
    && message.messageId === MESSAGE_ID && message.from === SENDER && message.synthetic === true && message.target === 'test'
    && Array.isArray(message.to) && message.to.length === 1 && typeof message.to[0] === 'string'
    && message.to[0].length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(message.to[0])
    && typeof message.subject === 'string' && message.subject.length > 0 && message.subject.length <= 998 && !/[\r\n]/.test(message.subject)
    && typeof message.html === 'string' && message.html.length > 0 && message.html.length <= 200000
    && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 200000
    && /^[0-9a-f]{64}$/.test(message.hash) && message.hash === hashTestDigestEmail(message);
}

function base(message, state, code, details = {}) {
  return { state, code, messageId: MESSAGE_ID, hash: typeof message?.hash === 'string' && /^[0-9a-f]{64}$/.test(message.hash) ? message.hash : null,
    deliveryConfirmed: false, attemptCount: 0, retryAllowed: false, ...details };
}
function gate(message, deps) {
  if (!scopeIsValid(deps)) return base(message, 'blocked', 'TEST_REVOLUTION_REQUIRED');
  if (env(deps, 'GIB_M1_DIGEST_TEST_SEND_ENABLED') !== 'true') return base(message, 'disabled', 'TEST_SENDING_DISABLED');
  if (!validMessage(message)) return base(message, 'blocked', 'INVALID_TEST_MESSAGE');
  if (env(deps, 'GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_ID') !== message.messageId
    || env(deps, 'GIB_M1_DIGEST_TEST_APPROVED_MESSAGE_HASH') !== message.hash
    || env(deps, 'GIB_M1_DIGEST_TEST_APPROVED_RECIPIENT') !== message.to[0]) return base(message, 'blocked', 'EXACT_MESSAGE_APPROVAL_REQUIRED');
  const key = env(deps, 'GIB_M1_DIGEST_TEST_RESEND_API_KEY');
  if (typeof key !== 'string' || !key || key.length > 1024 || /\s/.test(key)) return base(message, 'disabled', 'TEST_PROVIDER_NOT_CONFIGURED');
  return null;
}
async function storeFor(deps) {
  if (deps.deliveryStore) return deps.deliveryStore;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE, consistency: 'strong' });
}
async function readEntry(store, key) {
  const found = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (found && (!found.data || typeof found.etag !== 'string' || !found.etag)) throw new Error('STORAGE_INCOMPLETE');
  return found;
}
function validLedger(ledger, message) {
  if (!exact(ledger, ['schema', 'message', 'createdAt', 'attempts']) || ledger.schema !== SCHEMA || !validMessage(ledger.message)
    || !stamp(ledger.createdAt) || !Array.isArray(ledger.attempts) || !ledger.attempts.length || ledger.attempts.length > MAX_ATTEMPTS
    || ledger.message.hash !== message.hash || hashTestDigestEmail(ledger.message) !== hashTestDigestEmail(message)) return false;
  const ids = new Set();
  return ledger.attempts.every((attempt, index) => {
    const valid = exact(attempt, ['attemptId', 'startedAt', 'leaseUntil', 'credentialFingerprint']) && UUID.test(attempt.attemptId)
      && typeof attempt.credentialFingerprint === 'string' && /^[0-9a-f]{64}$/.test(attempt.credentialFingerprint)
      && !ids.has(attempt.attemptId) && stamp(attempt.startedAt) && attempt.leaseUntil === attempt.startedAt + LEASE_MS
      && (index === 0 ? attempt.startedAt === ledger.createdAt : attempt.startedAt >= ledger.attempts[index - 1].startedAt)
      && attempt.startedAt < ledger.createdAt + RETRY_MS;
    ids.add(attempt.attemptId); return valid;
  });
}
function validReceipt(receipt, message, attempt) {
  return exact(receipt, ['schema', 'messageId', 'hash', 'attemptId', 'startedAt', 'finishedAt', 'state', 'category', 'httpStatus', 'providerId'])
    && receipt.schema === RECEIPT_SCHEMA && receipt.messageId === message.messageId && receipt.hash === message.hash
    && receipt.attemptId === attempt.attemptId && receipt.startedAt === attempt.startedAt
    && stamp(receipt.finishedAt) && receipt.finishedAt >= attempt.startedAt
    && ['accepted', 'rejected', 'unknown'].includes(receipt.state)
    && ['PROVIDER_ACCEPTED', 'PROVIDER_REJECTED', 'PROVIDER_UNCERTAIN', 'PROVIDER_RESPONSE_INVALID', 'PROVIDER_NETWORK_FAILURE', 'PROVIDER_TIMEOUT', 'DISPATCH_DISABLED'].includes(receipt.category)
    && (receipt.httpStatus === null || Number.isInteger(receipt.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599)
    && (receipt.state === 'accepted' ? receipt.category === 'PROVIDER_ACCEPTED' && receipt.httpStatus >= 200 && receipt.httpStatus <= 299
      && typeof receipt.providerId === 'string' && UUID.test(receipt.providerId)
      : receipt.providerId === null && (receipt.state === 'rejected' ? receipt.category === 'PROVIDER_REJECTED'
        && receipt.httpStatus >= 400 && receipt.httpStatus <= 499 && ![408, 409].includes(receipt.httpStatus)
        : !['PROVIDER_ACCEPTED', 'PROVIDER_REJECTED'].includes(receipt.category)));
}
async function retainedState(store, message, now) {
  const entry = await readEntry(store, messageKey(message.messageId));
  if (!entry) return { entry: null, result: base(message, 'not-started', 'NO_RETAINED_DELIVERY') };
  if (!validLedger(entry.data, message)) return { entry, result: base(message, 'blocked', 'RETAINED_MESSAGE_MISMATCH') };
  const ledger = entry.data, attemptCount = ledger.attempts.length, retryBefore = ledger.createdAt + RETRY_MS;
  const found = await Promise.all(ledger.attempts.map(attempt => readEntry(store, receiptKey(message.messageId, attempt.attemptId))));
  if (found.some((receipt, index) => receipt && !validReceipt(receipt.data, message, ledger.attempts[index])))
    return { entry, result: base(message, 'blocked', 'RETAINED_RECEIPT_INVALID', { attemptCount, retryBefore }) };
  const receipts = found.map(receipt => receipt?.data || null), accepted = receipts.filter(receipt => receipt?.state === 'accepted');
  if (new Set(accepted.map(receipt => receipt.providerId)).size > 1)
    return { entry, result: base(message, 'blocked', 'CONFLICTING_PROVIDER_RECEIPTS', { attemptCount, retryBefore }) };
  if (accepted.length) return { entry, result: base(message, 'accepted', 'PROVIDER_ACCEPTANCE_CONFIRMED',
    { attemptCount, providerId: accepted[0].providerId, acceptedAt: accepted[0].finishedAt, receipts }) };
  const latest = ledger.attempts.at(-1), lastReceipt = receipts.at(-1);
  if (!lastReceipt && now < latest.leaseUntil) return { entry, result: base(message, 'pending', 'ATTEMPT_IN_PROGRESS', { attemptCount, retryBefore, receipts }) };
  const retryAllowed = now >= ledger.createdAt && now < retryBefore && attemptCount < MAX_ATTEMPTS;
  if (receipts.every(receipt => receipt?.state === 'rejected')) return { entry, result: base(message, 'rejected', retryAllowed ? 'PROVIDER_REJECTION_CONFIRMED' : 'MANUAL_RECONCILIATION_REQUIRED',
    { attemptCount, retryBefore, retryAllowed, receipts }) };
  return { entry, result: base(message, 'unknown', retryAllowed ? 'ACCEPTANCE_UNKNOWN' : 'MANUAL_RECONCILIATION_REQUIRED',
    { attemptCount, retryBefore, retryAllowed, receipts }) };
}

// Readback remains available after the send switch is turned off. It never dispatches or modifies storage.
export async function readTestDigestEmailDelivery(message, deps = {}) {
  if (!scopeIsValid(deps)) return base(message, 'blocked', 'TEST_REVOLUTION_REQUIRED');
  if (!validMessage(message)) return base(message, 'blocked', 'INVALID_TEST_MESSAGE');
  const now = clock(deps);
  if (!stamp(now)) return base(message, 'blocked', 'CLOCK_UNAVAILABLE');
  try { return (await retainedState(await storeFor(deps), message, now)).result; }
  catch { return base(message, 'unknown', 'DELIVERY_STORAGE_UNAVAILABLE'); }
}

async function providerAttempt(message, attempt, deps) {
  const controller = new AbortController(); let timeout, timedOut = false;
  const result = { state: 'unknown', category: 'PROVIDER_NETWORK_FAILURE', httpStatus: null, providerId: null };
  try {
    const response = await Promise.race([
      (async () => {
        const received = await (deps.fetch || globalThis.fetch)(PROVIDER_URL, { method: 'POST', redirect: 'error',
          headers: { Authorization: 'Bearer ' + env(deps, 'GIB_M1_DIGEST_TEST_RESEND_API_KEY'), 'Content-Type': 'application/json', 'Idempotency-Key': message.messageId },
          body: JSON.stringify({ from: message.from, to: message.to, subject: message.subject, html: message.html, text: message.text }), signal: controller.signal });
        const status = received?.status;
        if (!Number.isInteger(status) || status < 100 || status > 599) return { ...result, category: 'PROVIDER_RESPONSE_INVALID' };
        if (status >= 400 && status <= 499 && ![408, 409].includes(status)) return { state: 'rejected', category: 'PROVIDER_REJECTED', httpStatus: status, providerId: null };
        if (status < 200 || status > 299) return { ...result, category: 'PROVIDER_UNCERTAIN', httpStatus: status };
        let body;
        try { const raw = await received.text(); if (raw.length > 4096) throw new Error('Response too large'); body = JSON.parse(raw); }
        catch { return { ...result, category: 'PROVIDER_RESPONSE_INVALID', httpStatus: status }; }
        return exact(body, ['id']) && typeof body.id === 'string' && UUID.test(body.id)
          ? { state: 'accepted', category: 'PROVIDER_ACCEPTED', httpStatus: status, providerId: body.id }
          : { ...result, category: 'PROVIDER_RESPONSE_INVALID', httpStatus: status };
      })(),
      new Promise((resolve, reject) => { timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Timed out')); }, TIMEOUT_MS); })
    ]);
    Object.assign(result, response);
  } catch { if (timedOut) result.category = 'PROVIDER_TIMEOUT'; }
  finally { clearTimeout(timeout); }
  const finishedAt = clock(deps);
  return { schema: RECEIPT_SCHEMA, messageId: message.messageId, hash: message.hash, attemptId: attempt.attemptId,
    startedAt: attempt.startedAt, finishedAt: stamp(finishedAt) && finishedAt >= attempt.startedAt ? finishedAt : attempt.startedAt, ...result };
}

// One awaited provider request per invocation, with no automatic retries. Resend retains its key for 24h;
// an uncertain attempt may retry only the exact original payload within our shorter 23h window.
export async function deliverTestDigestEmail(message, deps = {}) {
  const unavailable = gate(message, deps);
  if (unavailable) return unavailable;
  // Snapshot caller input before any await; the durable body and every retry must remain identical.
  const immutable = { ...canonical(message), to: [...message.to], hash: message.hash };
  const now = clock(deps);
  if (!stamp(now)) return base(immutable, 'blocked', 'CLOCK_UNAVAILABLE');
  let store, attempt, ledger;
  try {
    store = await storeFor(deps);
    const retained = await retainedState(store, immutable, now);
    if (!['not-started', 'unknown', 'rejected'].includes(retained.result.state) || retained.entry && !retained.result.retryAllowed) return retained.result;
    const fingerprint = credentialFingerprint(deps);
    if (retained.entry?.data.attempts.some((previous, index) => previous.credentialFingerprint !== fingerprint
      && (!retained.result.receipts[index] || retained.result.receipts[index].state === 'unknown')))
      return base(immutable, 'unknown', 'PROVIDER_CREDENTIAL_RECONCILIATION_REQUIRED', { attemptCount: retained.entry.data.attempts.length });
    const attemptId = (deps.uuid || randomUUID)();
    if (!UUID.test(attemptId)) return base(immutable, 'blocked', 'ATTEMPT_ID_INVALID');
    attempt = { attemptId, startedAt: now, leaseUntil: now + LEASE_MS, credentialFingerprint: fingerprint };
    ledger = retained.entry ? { ...retained.entry.data, attempts: [...retained.entry.data.attempts, attempt] }
      : { schema: SCHEMA, message: immutable, createdAt: now, attempts: [attempt] };
    if (!validLedger(ledger, immutable)) return base(immutable, 'blocked', 'ATTEMPT_CLAIM_INVALID');
    const written = await store.set(messageKey(immutable.messageId), JSON.stringify(ledger), retained.entry ? { onlyIfMatch: retained.entry.etag } : { onlyIfNew: true });
    if (written?.modified !== true) return (await retainedState(store, immutable, clock(deps))).result;
    const saved = await readEntry(store, messageKey(immutable.messageId));
    if (!saved || digestHash(saved.data) !== digestHash(ledger)) return base(immutable, 'unknown', 'PENDING_STORAGE_UNCONFIRMED');
  } catch { return base(immutable, 'unknown', 'PENDING_STORAGE_UNCONFIRMED'); }
  const dispatchTime = clock(deps);
  if (!stamp(dispatchTime) || dispatchTime < now || dispatchTime >= ledger.createdAt + RETRY_MS)
    return base(immutable, 'unknown', 'MANUAL_RECONCILIATION_REQUIRED', { attemptCount: ledger.attempts.length });
  const changedGate = gate(immutable, deps) || credentialFingerprint(deps) !== attempt.credentialFingerprint;
  const receipt = changedGate ? { schema: RECEIPT_SCHEMA, messageId: immutable.messageId, hash: immutable.hash,
    attemptId: attempt.attemptId, startedAt: attempt.startedAt, finishedAt: dispatchTime, state: 'unknown', category: 'DISPATCH_DISABLED', httpStatus: null, providerId: null }
    : await providerAttempt(immutable, attempt, deps);
  try {
    const key = receiptKey(immutable.messageId, attempt.attemptId);
    const saved = await store.set(key, JSON.stringify(receipt), { onlyIfNew: true });
    const confirmed = await readEntry(store, key);
    if (![true, false].includes(saved?.modified) || !confirmed || digestHash(confirmed.data) !== digestHash(receipt))
      return base(immutable, 'unknown', 'RESULT_STORAGE_UNCONFIRMED', { attemptCount: ledger.attempts.length });
    return (await retainedState(store, immutable, clock(deps))).result;
  } catch { return base(immutable, 'unknown', 'RESULT_STORAGE_UNCONFIRMED', { attemptCount: ledger.attempts.length }); }
}
