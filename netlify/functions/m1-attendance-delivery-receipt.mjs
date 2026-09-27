import { createHmac, timingSafeEqual } from 'node:crypto';
import { jsonResponse } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';

export const config = { path: '/api/m1-attendance-delivery-receipt', rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
const MAX_BYTES = 65536, TOLERANCE_SECONDS = 300;
const knownTypes = new Set(['email.delivered', 'email.bounced', 'email.failed']);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const readEnv = (dependencies, name) => dependencies.env ? dependencies.env[name] : globalThis.Netlify?.env?.get(name);
const safeString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const mailbox = value => safeString(value, 254) && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || secret.length > 256) return null;
  const text = secret.slice(6), key = Buffer.from(text, 'base64');
  return key.length >= 16 && key.length <= 128 && key.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '') ? key : null;
}

// Resend's documented Svix protocol, without a new dependency:
// https://resend.com/docs/webhooks/verify-webhooks-requests
// https://docs.svix.com/receiving/verifying-payloads/how-manual
// Authenticate exact bytes before parsing. IDs and attempt timestamps are signed;
// the original event ID remains stable across retries and rotation accepts any v1.
export function verifyResendReceipt(raw, headers, secret, now = Date.now()) {
  const key = signingKey(secret), id = headers.get('svix-id'), timestamp = headers.get('svix-timestamp'), signatures = headers.get('svix-signature');
  if (!key || !Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES || !Number.isSafeInteger(now)
    || !/^[A-Za-z0-9_-]{1,100}$/.test(id || '') || !/^[1-9][0-9]{0,10}$/.test(timestamp || '')
    || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > TOLERANCE_SECONDS
    || typeof signatures !== 'string' || !signatures.length || signatures.length > 2048) fail(403, 'DELIVERY_RECEIPT_AUTHENTICATION_FAILED');
  const expected = createHmac('sha256', key).update(id + '.' + timestamp + '.', 'utf8').update(raw).digest();
  const valid = signatures.split(' ').some(signature => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
    const value = Buffer.from(signature.slice(3), 'base64');
    return value.length === expected.length && timingSafeEqual(value, expected);
  });
  if (!valid) fail(403, 'DELIVERY_RECEIPT_AUTHENTICATION_FAILED');
  return id;
}

function deliveryEvent(raw, eventId, now) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail(400, 'DELIVERY_RECEIPT_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !safeString(value.type, 100)) fail(400, 'DELIVERY_RECEIPT_INVALID');
  // Open/click events, accepted sends and other provider features cannot alter
  // delivery status. They are not stored or forwarded to the workflow ledger.
  if (!knownTypes.has(value.type)) return null;
  const data = value.data, occurredAt = value.created_at;
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.email_id || '')
    || !safeString(data.from, 300) || !Array.isArray(data.to) || data.to.length !== 1
    || data.to.some(value => !mailbox(value)) || new Set(data.to).size !== data.to.length
    || typeof occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(occurredAt)
    || !Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString().slice(0, 19) !== occurredAt.slice(0, 19)
    || Date.parse(occurredAt) > now + TOLERANCE_SECONDS * 1000) fail(400, 'DELIVERY_RECEIPT_INVALID');
  return { eventId, providerId: data.email_id, type: value.type, occurredAt: new Date(occurredAt).toISOString(), from: data.from, to: [...data.to] };
}

export async function handleAttendanceDeliveryReceipt(request, dependencies = {}) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== config.path || url.search || url.hash) return jsonResponse(404, { ok: false, code: 'DELIVERY_RECEIPT_UNAVAILABLE' });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope) return jsonResponse(403, { ok: false, code: 'DELIVERY_RECEIPT_SCOPE_REQUIRED' });
  const secret = readEnv(dependencies, 'GIB_M1_WORKFLOW_TEST_RESEND_WEBHOOK_SECRET');
  if (readEnv(dependencies, 'GIB_M1_WORKFLOW_TEST_RECEIPTS_ENABLED') !== 'true' || !signingKey(secret))
    return jsonResponse(404, { ok: false, code: 'DELIVERY_RECEIPT_DISABLED' });
  const declared = request.headers.get('Content-Length');
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')
    || (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))
    || ![null, 'identity'].includes(request.headers.get('Content-Encoding'))) return jsonResponse(400, { ok: false, code: 'DELIVERY_RECEIPT_INVALID' });
  try {
    const raw = Buffer.from(await request.arrayBuffer());
    if (!raw.length || raw.length > MAX_BYTES || (declared && Number(declared) !== raw.length)) return jsonResponse(400, { ok: false, code: 'DELIVERY_RECEIPT_INVALID' });
    const now = (dependencies.clock || Date.now)(), eventId = verifyResendReceipt(raw, request.headers, secret, now);
    const event = deliveryEvent(raw, eventId, now);
    if (!event) return jsonResponse(200, { ok: true, ignored: true });
    const record = dependencies.recordEvidence || (await import('./_lib/m1-attendance-digest-workflow.mjs')).recordWorkflowDeliveryEvidence;
    // The workflow resolves the provider ID to its original scheduled message,
    // checks the exact sender/recipients/gym, and confirms durable receipt storage.
    const result = await record(event, { ...dependencies, scope, deliveryEvidenceVerified: true });
    if (result?.ok !== true) fail(503, 'DELIVERY_EVIDENCE_UNAVAILABLE');
    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (error?.code === 'WORKFLOW_EVIDENCE_CONFLICT' || error?.message === 'WORKFLOW_EVIDENCE_CONFLICT')
      return jsonResponse(409, { ok: false, code: 'DELIVERY_EVIDENCE_CONFLICT' });
    const code = ['DELIVERY_RECEIPT_AUTHENTICATION_FAILED', 'DELIVERY_RECEIPT_INVALID'].includes(error?.code) ? error.code : 'DELIVERY_EVIDENCE_UNAVAILABLE';
    const status = [400, 403, 404, 409, 503].includes(error?.status) ? error.status : 503;
    return jsonResponse(status, { ok: false, code });
  }
}
export default (request, context) => handleAttendanceDeliveryReceipt(request, { context });
