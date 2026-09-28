import { randomUUID } from 'node:crypto';
import { digestHash } from './m1-attendance-digest.mjs';

const SCHEMA = 'm1-mailapp-delivery/v1', RECEIPT = 'm1-mailapp-receipt/v1', HEAD = 'm1-mailapp-status/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMEOUT_MS = 25000, RETRY_MS = 23 * 60 * 60 * 1000, MAX_ATTEMPTS = 6;
const GOOGLE_CODES = new Set(['MAILAPP_READY', 'MAILAPP_SUBMITTED', 'MAILAPP_AUTHENTICATION_REQUIRED', 'MAILAPP_SENDER_UNVERIFIED',
  'MAILAPP_MESSAGE_INVALID', 'MAILAPP_BINDING_INVALID', 'MAILAPP_REQUEST_INVALID', 'MAILAPP_LEDGER_UNAVAILABLE', 'MAILAPP_ORIGINAL_CONFLICT',
  'MAILAPP_STORAGE_UNCONFIRMED', 'MAILAPP_DISABLED', 'MAILAPP_RECIPIENTS_UNAPPROVED', 'MAILAPP_AUTHORIZATION_UNAVAILABLE',
  'MAILAPP_QUOTA_UNAVAILABLE', 'MAILAPP_CALL_UNCERTAIN', 'MAILAPP_RESULT_UNCONFIRMED']);
const LOCAL_CODES = new Set(['MAILAPP_NETWORK_FAILURE', 'MAILAPP_TIMEOUT', 'MAILAPP_RESPONSE_INVALID', 'MAILAPP_HTTP_FAILURE']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const stamp = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const clock = deps => (deps.now || deps.clock || Date.now)();
const key = id => 'mailapp/messages/' + id;
const receiptKey = (id, requestId) => 'mailapp/receipts/' + id + '/' + requestId;
const headKey = id => 'mailapp/status/' + id;
const canonical = message => ({ messageId: message.messageId, from: message.from, to: message.to, cc: message.cc,
  subject: message.subject, html: message.html, text: message.text, synthetic: message.synthetic, target: message.target });

function validMessage(message, policy) {
  try {
    return exact(message, ['messageId', 'hash', 'from', 'to', 'cc', 'subject', 'html', 'text', 'synthetic', 'target'])
      && /^m1-test-scheduled-rev-\d{4}-\d{2}-\d{2}$/.test(message.messageId) && iso(message.messageId.slice(-10) + 'T00:00:00.000Z')
      && message.from === 'revbjjops@gmail.com' && message.target === 'test' && typeof message.synthetic === 'boolean'
      && Array.isArray(message.to) && Array.isArray(message.cc) && /^[0-9a-f]{64}$/.test(message.hash)
      && policy?.validMessage(message) === true && digestHash(canonical(message)) === message.hash
      && digestHash(policy.canonical(message)) === message.hash;
  } catch { return false; }
}
function base(message, state, code, details = {}) {
  return { provider: 'mailapp', messageId: message?.messageId || null, hash: /^[0-9a-f]{64}$/.test(message?.hash) ? message.hash : null,
    state, code, attemptCount: 0, attemptedAt: null, lastAttemptAt: null, retryBefore: null, receipts: [],
    retryAllowed: false, deliveryConfirmed: false, ...details };
}
function validateInput(message, deps, policy) {
  if (deps.scope?.target !== 'test' || deps.scope?.profile?.installationId !== 'rev') return base(message, 'blocked', 'TEST_REVOLUTION_REQUIRED');
  if (!validMessage(message, policy)) return base(message, 'blocked', 'INVALID_MAILAPP_MESSAGE');
  if (!stamp(clock(deps))) return base(message, 'blocked', 'CLOCK_UNAVAILABLE');
  return null;
}
async function storeFor(deps) {
  if (deps.deliveryStore) return deps.deliveryStore;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'gib-m1-digest-test-delivery-v1', consistency: 'strong' });
}
async function readEntry(store, name) {
  const entry = await store.getWithMetadata(name, { type: 'json', consistency: 'strong' });
  if (entry !== null && (!entry || !entry.data || typeof entry.etag !== 'string' || !entry.etag)) throw new Error('MAILAPP_STORAGE_INVALID');
  return entry;
}
function binding(deps) {
  const createdAt = clock(deps), requestId = (deps.uuid || randomUUID)();
  if (!stamp(createdAt) || !UUID.test(requestId)) throw new Error('MAILAPP_BINDING_INVALID');
  return { schema: 'm1-mailapp-request/v1', requestId, createdAt, expiresAt: createdAt + 60000 };
}
function validBinding(value) {
  return exact(value, ['schema', 'requestId', 'createdAt', 'expiresAt']) && value.schema === 'm1-mailapp-request/v1'
    && UUID.test(value.requestId) && stamp(value.createdAt) && stamp(value.expiresAt) && value.expiresAt === value.createdAt + 60000;
}
function validReply(reply, message) {
  if (!exact(reply, ['ok', 'target', 'gym', 'messageId', 'hash', 'state', 'code', 'attemptedAt', 'completedAt', 'retrySafe'])
    || reply.target !== 'test' || reply.gym !== 'rev' || reply.messageId !== message.messageId || reply.hash !== message.hash
    || !GOOGLE_CODES.has(reply.code) || reply.ok !== ['MAILAPP_READY', 'MAILAPP_SUBMITTED'].includes(reply.code)
    || !['not-attempted', 'unknown', 'submitted'].includes(reply.state) || reply.retrySafe !== (reply.state === 'not-attempted')
    || reply.attemptedAt !== null && !iso(reply.attemptedAt) || reply.completedAt !== null && !iso(reply.completedAt)
    || reply.completedAt !== null && (reply.attemptedAt === null || Date.parse(reply.completedAt) < Date.parse(reply.attemptedAt))) return false;
  if (reply.state === 'submitted') return reply.code === 'MAILAPP_SUBMITTED' && reply.attemptedAt !== null && reply.completedAt !== null;
  if (reply.code === 'MAILAPP_SUBMITTED') return false;
  if (reply.state === 'not-attempted') return reply.attemptedAt === null && reply.completedAt === null
    && ['MAILAPP_READY', 'MAILAPP_DISABLED', 'MAILAPP_RECIPIENTS_UNAPPROVED', 'MAILAPP_AUTHORIZATION_UNAVAILABLE', 'MAILAPP_QUOTA_UNAVAILABLE'].includes(reply.code);
  return !['MAILAPP_READY', 'MAILAPP_DISABLED', 'MAILAPP_RECIPIENTS_UNAPPROVED', 'MAILAPP_AUTHORIZATION_UNAVAILABLE', 'MAILAPP_QUOTA_UNAVAILABLE'].includes(reply.code);
}
function validReceipt(value, message) {
  return exact(value, ['schema', 'messageId', 'hash', 'requestId', 'action', 'startedAt', 'finishedAt', 'httpStatus', 'code', 'result'])
    && value.schema === RECEIPT && value.messageId === message.messageId && value.hash === message.hash && UUID.test(value.requestId)
    && ['attendanceMailSend', 'attendanceMailStatus'].includes(value.action) && stamp(value.startedAt) && stamp(value.finishedAt)
    && !(value.action === 'attendanceMailSend' && value.code === 'MAILAPP_READY')
    && value.finishedAt >= value.startedAt && (value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    && (value.result === null ? LOCAL_CODES.has(value.code) : validReply(value.result, message) && value.code === value.result.code
      && (value.httpStatus === null || value.httpStatus >= 200 && value.httpStatus <= 299));
}
function claimDetails(claim) {
  return { attemptCount: claim.bindings.length, attemptedAt: claim.bindings[0].createdAt,
    lastAttemptAt: claim.bindings.at(-1).createdAt, retryBefore: claim.bindings[0].createdAt + RETRY_MS };
}
const noCall = receipt => receipt?.result?.state === 'not-attempted' && receipt.action === 'attendanceMailSend'
  && receipt.result.retrySafe === true && receipt.result.attemptedAt === null && receipt.result.completedAt === null;
async function retained(store, message, policy, now) {
  // Any old provider ledger is an immutable gym/day boundary, regardless of payload hash.
  if (await readEntry(store, 'messages/' + message.messageId)) return { result: base(message, 'blocked', 'MAILAPP_LEGACY_PROVIDER_RECORD') };
  const entry = await readEntry(store, key(message.messageId));
  if (!entry) return { result: base(message, 'not-started', 'NO_RETAINED_DELIVERY') };
  const claim = entry.data;
  if (!exact(claim, ['schema', 'message', 'bindings']) || claim.schema !== SCHEMA || !validMessage(claim.message, policy)
    || !Array.isArray(claim.bindings) || !claim.bindings.length || claim.bindings.length > MAX_ATTEMPTS
    || !claim.bindings.every((item, index) => validBinding(item) && item.createdAt < claim.bindings[0].createdAt + RETRY_MS
      && (!index || item.createdAt >= claim.bindings[index - 1].expiresAt))
    || new Set(claim.bindings.map(item => item.requestId)).size !== claim.bindings.length || digestHash(claim.message) !== digestHash(message))
    return { entry, result: base(message, 'blocked', 'RETAINED_MESSAGE_MISMATCH') };
  const details = claimDetails(claim), found = await Promise.all(claim.bindings.map(item => readEntry(store, receiptKey(message.messageId, item.requestId))));
  const head = await readEntry(store, headKey(message.messageId));
  if (head && (!exact(head.data, ['schema', 'messageId', 'hash', 'requestId', 'finishedAt']) || head.data.schema !== HEAD
    || head.data.messageId !== message.messageId || head.data.hash !== message.hash || !UUID.test(head.data.requestId) || !stamp(head.data.finishedAt)))
    return { entry, result: base(message, 'blocked', 'RETAINED_RECEIPT_INVALID', details) };
  const status = head ? await readEntry(store, receiptKey(message.messageId, head.data.requestId)) : null;
  if (found.some((item, index) => item && (!validReceipt(item.data, message) || item.data.action !== 'attendanceMailSend'
    || item.data.requestId !== claim.bindings[index].requestId || item.data.startedAt !== claim.bindings[index].createdAt))
    || head && (!status || !validReceipt(status.data, message)
      || status.data.action !== 'attendanceMailStatus' || status.data.requestId !== head.data.requestId || status.data.finishedAt !== head.data.finishedAt))
    return { entry, result: base(message, 'blocked', 'RETAINED_RECEIPT_INVALID', details) };
  const sends = found.map(item => item?.data || null), receipts = [...sends, status?.data].filter(Boolean);
  const submitted = receipts.filter(item => item.result?.state === 'submitted'), allNoCall = sends.every(noCall);
  if (sends.slice(0, -1).some((item, index) => !noCall(item) || item.finishedAt > claim.bindings[index + 1].createdAt) || allNoCall && status?.data.result?.attemptedAt
    || new Set(submitted.map(item => item.result.attemptedAt + '/' + item.result.completedAt)).size > 1)
    return { entry, result: base(message, 'blocked', 'CONFLICTING_MAILAPP_RECEIPTS', { ...details, receipts }) };
  const latestSend = sends.at(-1), latestStatus = status?.data;
  const selected = submitted[0] || (latestStatus?.result?.attemptedAt ? latestStatus : null)
    || (latestSend && (!latestStatus || latestSend.finishedAt >= latestStatus.finishedAt) ? latestSend : latestStatus);
  const state = submitted.length ? 'submitted' : allNoCall ? 'rejected' : 'unknown';
  const retryAllowed = state === 'rejected' && stamp(now) && now >= claim.bindings.at(-1).expiresAt
    && now < details.retryBefore && claim.bindings.length < MAX_ATTEMPTS;
  const code = state === 'unknown' && selected?.result?.state === 'not-attempted' ? sends.at(-1)?.code || 'MAILAPP_DISPATCH_UNCONFIRMED'
    : selected?.code || 'MAILAPP_DISPATCH_UNCONFIRMED';
  return { entry, result: base(message, state, code, { ...details, durableAttempt: true, receipts,
    retryAllowed,
    ...(selected?.result ? { googleResult: selected.result } : {}) }) };
}
async function request(message, action, requestBinding, deps, policy) {
  const controller = new AbortController(); let timer, timedOut = false;
  let result = null, httpStatus = null, code = 'MAILAPP_NETWORK_FAILURE';
  try {
    await Promise.race([(async () => {
      const response = await policy.request(message, { action, binding: requestBinding }, controller.signal);
      if (validReply(response, message)) { result = structuredClone(response); code = result.code; return; }
      if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) { code = 'MAILAPP_RESPONSE_INVALID'; return; }
      httpStatus = response.status;
      if (httpStatus < 200 || httpStatus > 299) { code = 'MAILAPP_HTTP_FAILURE'; return; }
      try {
        const raw = await response.text();
        if (typeof raw !== 'string' || raw.length > 4096) throw new Error('INVALID');
        const candidate = JSON.parse(raw);
        if (!validReply(candidate, message)) throw new Error('INVALID');
        result = candidate; code = result.code;
      } catch { code = 'MAILAPP_RESPONSE_INVALID'; }
    })(), new Promise((resolve, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('TIMEOUT')); }, TIMEOUT_MS); })]);
  } catch { code = timedOut ? 'MAILAPP_TIMEOUT' : 'MAILAPP_NETWORK_FAILURE'; }
  finally { clearTimeout(timer); }
  const now = clock(deps);
  return { schema: RECEIPT, messageId: message.messageId, hash: message.hash, requestId: requestBinding.requestId, action,
    startedAt: requestBinding.createdAt, finishedAt: stamp(now) && now >= requestBinding.createdAt ? now : requestBinding.createdAt,
    httpStatus, code, result };
}
async function saveReceipt(store, message, receipt) {
  const name = receiptKey(message.messageId, receipt.requestId);
  const write = await store.set(name, JSON.stringify(receipt), { onlyIfNew: true });
  const saved = await readEntry(store, name);
  if (![true, false].includes(write?.modified) || !saved || digestHash(saved.data) !== digestHash(receipt)) throw new Error('MAILAPP_STORAGE_UNCONFIRMED');
  if (receipt.action !== 'attendanceMailStatus') return;
  const current = await readEntry(store, headKey(message.messageId));
  if (current) {
    if (!exact(current.data, ['schema', 'messageId', 'hash', 'requestId', 'finishedAt']) || current.data.schema !== HEAD
      || current.data.messageId !== message.messageId || current.data.hash !== message.hash || !UUID.test(current.data.requestId)
      || !stamp(current.data.finishedAt)) throw new Error('MAILAPP_STORAGE_INVALID');
    const previous = await readEntry(store, receiptKey(message.messageId, current.data.requestId));
    if (!previous || !validReceipt(previous.data, message) || previous.data.action !== 'attendanceMailStatus'
      || previous.data.requestId !== current.data.requestId || previous.data.finishedAt !== current.data.finishedAt) throw new Error('MAILAPP_STORAGE_INVALID');
    // An older or less conclusive status cannot erase a confirmed submission.
    if (previous.data.result?.state === 'submitted' || previous.data.result?.attemptedAt && !receipt.result?.attemptedAt
      || receipt.result?.state !== 'submitted' && receipt.finishedAt < previous.data.finishedAt) return;
  }
  const head = { schema: HEAD, messageId: message.messageId, hash: message.hash, requestId: receipt.requestId, finishedAt: receipt.finishedAt };
  const updated = await store.set(headKey(message.messageId), JSON.stringify(head), current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
  if (![true, false].includes(updated?.modified)) throw new Error('MAILAPP_STORAGE_UNCONFIRMED');
  const confirmed = await readEntry(store, headKey(message.messageId));
  if (!confirmed || updated.modified && digestHash(confirmed.data) !== digestHash(head)) throw new Error('MAILAPP_STORAGE_UNCONFIRMED');
}
function gate(message, deps, policy) {
  const result = policy.gate(message, deps);
  if (!result) return null;
  return base(message, ['blocked', 'disabled', 'rejected'].includes(result.state) ? result.state : 'blocked',
    typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(result.code) ? result.code : 'MAILAPP_DISPATCH_DISABLED');
}

// Projection reads are local only: they never contact Google or create an attempt.
export async function readMailAppDelivery(message, deps = {}, policy) {
  const invalid = validateInput(message, deps, policy); if (invalid) return invalid;
  const immutable = { ...canonical(message), to: [...message.to], cc: [...message.cc], hash: message.hash };
  try { return (await retained(await storeFor(deps), immutable, policy, clock(deps))).result; }
  catch { return base(immutable, 'unknown', 'DELIVERY_STORAGE_UNAVAILABLE'); }
}

// An uncertain claim permits status reads only. A new dispatch requires every
// prior Send receipt to prove no call occurred, plus fresh readiness and a new CAS claim.
export async function deliverMailApp(message, deps = {}, policy) {
  const invalid = validateInput(message, deps, policy); if (invalid) return invalid;
  const immutable = { ...canonical(message), to: [...message.to], cc: [...message.cc], hash: message.hash };
  let store, original, claim;
  try {
    store = await storeFor(deps); original = await retained(store, immutable, policy, clock(deps));
    let preflight;
    if (original.entry) {
      if (['submitted', 'blocked'].includes(original.result.state)) return original.result;
      preflight = await request(immutable, 'attendanceMailStatus', binding(deps), deps, policy);
      await saveReceipt(store, immutable, preflight);
      original = await retained(store, immutable, policy, clock(deps));
      if (!original.result.retryAllowed || preflight.code !== 'MAILAPP_READY') return original.result;
    } else {
      if (original.result.state !== 'not-started') return original.result;
      const unavailable = gate(immutable, deps, policy); if (unavailable) return unavailable;
      preflight = await request(immutable, 'attendanceMailStatus', binding(deps), deps, policy);
    }
    if (!original.entry && preflight.result?.attemptedAt) {
      // Google already owns this identity. Retain that fact locally; never create a send opportunity.
      claim = { schema: SCHEMA, message: immutable, bindings: [binding(deps)] };
      const written = await store.set(key(immutable.messageId), JSON.stringify(claim), { onlyIfNew: true });
      if (written?.modified !== true) return (await retained(store, immutable, policy, clock(deps))).result;
      const saved = await readEntry(store, key(immutable.messageId));
      if (!saved || digestHash(saved.data) !== digestHash(claim)) return base(immutable, 'unknown', 'PENDING_STORAGE_UNCONFIRMED', claimDetails(claim));
      await saveReceipt(store, immutable, preflight);
      return (await retained(store, immutable, policy, clock(deps))).result;
    }
    if (preflight.result?.state !== 'not-attempted' || preflight.code !== 'MAILAPP_READY')
      return base(immutable, preflight.result?.state === 'submitted' ? 'submitted' : preflight.result?.state === 'not-attempted' ? 'rejected' : 'unknown', preflight.code,
        { ...(preflight.result ? { googleResult: preflight.result } : {}), receipts: [preflight],
          ...(preflight.result?.attemptedAt ? { attemptCount: 1, attemptedAt: Date.parse(preflight.result.attemptedAt), lastAttemptAt: Date.parse(preflight.result.attemptedAt) } : {}) });
    if (policy.beforeDispatch) await policy.beforeDispatch(immutable, deps);
    // Re-read after readiness and the ownership await: a peer may have claimed or stored contradictory evidence.
    const fresh = await retained(store, immutable, policy, clock(deps));
    if (original.entry ? fresh.entry?.etag !== original.entry.etag || !fresh.result.retryAllowed : fresh.result.state !== 'not-started') return fresh.result;
    const claimTime = clock(deps);
    if (!stamp(claimTime) || claimTime < preflight.startedAt || claimTime >= preflight.startedAt + 60000)
      return base(immutable, 'unknown', 'MAILAPP_PREFLIGHT_EXPIRED', original.entry ? claimDetails(original.entry.data) : {});
    claim = { schema: SCHEMA, message: immutable, bindings: [...(original.entry?.data.bindings || []), binding(deps)] };
    const changed = gate(immutable, deps, policy); if (changed) return { ...changed, ...(original.entry ? claimDetails(original.entry.data) : {}) };
    const written = await store.set(key(immutable.messageId), JSON.stringify(claim), original.entry ? { onlyIfMatch: original.entry.etag } : { onlyIfNew: true });
    // A thrown/ambiguous write never permits dispatch, even when readback later finds this claim.
    if (written?.modified !== true) return (await retained(store, immutable, policy, clock(deps))).result;
    const saved = await readEntry(store, key(immutable.messageId));
    if (!saved || digestHash(saved.data) !== digestHash(claim)) return base(immutable, 'unknown', 'PENDING_STORAGE_UNCONFIRMED', claimDetails(claim));
    const lastRead = await retained(store, immutable, policy, clock(deps));
    if (['blocked', 'submitted'].includes(lastRead.result.state)) return lastRead.result;
    const stopped = gate(immutable, deps, policy);
    if (stopped) return { ...stopped, ...claimDetails(claim) };
    const now = clock(deps);
    if (!stamp(now) || now < claim.bindings.at(-1).createdAt || now >= claim.bindings.at(-1).expiresAt || now >= claimDetails(claim).retryBefore)
      return base(immutable, 'unknown', 'MAILAPP_BINDING_EXPIRED', claimDetails(claim));
    if (policy.beforeDispatch) await policy.beforeDispatch(immutable, deps);
    // The ownership check can await storage. Recheck locally with no further await before dispatch.
    const finalGate = gate(immutable, deps, policy), finalTime = clock(deps);
    if (finalGate) return { ...finalGate, ...claimDetails(claim) };
    if (!stamp(finalTime) || finalTime < claim.bindings.at(-1).createdAt || finalTime >= claim.bindings.at(-1).expiresAt || finalTime >= claimDetails(claim).retryBefore)
      return base(immutable, 'unknown', 'MAILAPP_BINDING_EXPIRED', claimDetails(claim));
  } catch { return base(immutable, 'unknown', claim ? 'PENDING_STORAGE_UNCONFIRMED' : 'DELIVERY_STORAGE_UNAVAILABLE',
    claim ? claimDetails(claim) : original?.entry ? claimDetails(original.entry.data) : {}); }
  const receipt = await request(immutable, 'attendanceMailSend', claim.bindings.at(-1), deps, policy);
  try {
    await saveReceipt(store, immutable, receipt);
    return (await retained(store, immutable, policy, clock(deps))).result;
  } catch { return base(immutable, 'unknown', 'RESULT_STORAGE_UNCONFIRMED', claimDetails(claim)); }
}
