import { managerReviewScope } from './_lib/m1-manager-scope.mjs';
import { handleM1Schedule } from './m1-schedule.mjs';
import { defaultAddedClassesStore, publicAddedClasses, readAddedClasses } from './_lib/m1-added-classes.mjs';
import { jsonResponse, readJson, requireAdmin, runtimeConfig, postGoogle, googleFailureClass } from './_lib/m1-common.mjs';
import { MANAGER_REVIEW_ENABLED } from './_lib/m1-manager-review.generated.mjs';
import { REVIEW_START, TIMEZONE, localNow, periodFor, validateRead, dayPlan, proposedReview } from './_lib/m1-manager-review.mjs';
import temporaryClasses from '../../m1/temporary-classes-core.js';
import { postGoogle as prePrPostGoogle } from './_lib/m1-google-pre-pr-control.mjs';
import { traceGoogle } from './_lib/m1-google-trace.mjs';
import { nativeHttpsControl } from './_lib/m1-google-native-control.mjs';
import { randomUUID } from 'node:crypto';
import { callbackRuntime, READ_ID_HEADER, READ_OPERATION_HEADER, validId, createReadTrace, traceReadStage, loadCallbackLedger, readCallbackTicket } from './_lib/m1-test-read-callback.mjs';

export const config = { path: '/api/m1-manager-review', rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

async function managerCalendar(request, scope, dependencies, now) {
  const trace = dependencies.readTrace || (() => {}), url = new URL(request.url);
  const [schedule, added] = await Promise.all([
    traceReadStage(trace, 'schedule', async () => {
      const value = dependencies.schedule || await handleM1Schedule(new Request(new URL('/api/m1-schedule', url)), dependencies).then(response => response.json());
      if (value?.current !== true || value.timezone !== TIMEZONE || !value.days) throw new Error('Current schedule unavailable.');
      return value;
    }),
    traceReadStage(trace, 'added-classes', async () => {
      const store = dependencies.addedStore || await defaultAddedClassesStore(scope.target);
      const { value } = await readAddedClasses(store, scope.profile.installationId, +now, scope.target);
      const added = publicAddedClasses(value, +now);
      if (!temporaryClasses.validateDocument(added, scope.profile.installationId, scope.target) || !added.current) throw new Error('Current added classes unavailable.');
      return added;
    })
  ]);
  return { schedule, added };
}
function plannedManagerRead(ledger, calendar, scope, now, trace = () => {}) {
  validateRead(ledger, scope.profile.installationId, localNow(now).date, scope.target);
  const days = ledger.days.map(day => dayPlan(day, calendar.schedule, calendar.added, now));
  trace('review.validation', 'ok');
  return { ledger, ...calendar, days };
}
function managerResponse(loaded, scope, now) {
  const today = localNow(now).date;
  return { ok: true, target: scope.target, test: scope.target === 'test', gym: scope.profile.installationId, site: scope.profile.siteCode,
    timezone: TIMEZONE, today, cleanupStart: REVIEW_START, period: periodFor(today), asOf: now.toISOString(),
    pendingDays: loaded.days.filter(day => !day.complete).length, days: loaded.days };
}
// Addition reconciliation and normal manager display use the same complete,
// target-bound ledger/calendar validation. This never writes or confirms a save.
export async function assembleManagerRead(ledger, request, scope, dependencies = {}) {
  const now = new Date(dependencies.now ?? Date.now());
  const calendar = await managerCalendar(request, scope, dependencies, now);
  return managerResponse(plannedManagerRead(ledger, calendar, scope, now, dependencies.readTrace), scope, now);
}

function confirmedReviewReceipt(receipt, original) {
  const required = ['saved', 'requestId', 'revision'], allowed = [...required, 'ok', 'retry'];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || required.some(key => !Object.hasOwn(receipt, key)) || Object.keys(receipt).some(key => !allowed.includes(key))
    || !Number.isSafeInteger(original.revision) || original.revision < 0
    || typeof original.requestId !== 'string' || !/^manager-[a-zA-Z0-9-]{16,100}$/.test(original.requestId)
    || receipt.saved !== true || receipt.requestId !== original.requestId
    || !Number.isSafeInteger(receipt.revision) || receipt.revision !== original.revision + 1
    || (Object.hasOwn(receipt, 'ok') && receipt.ok !== true)
    || (Object.hasOwn(receipt, 'retry') && (receipt.retry !== true || receipt.ok !== true))) {
    throw Object.assign(new Error('The original review save was not confirmed. Keep its request and check it again.'), { status: 503, code: 'MANAGER_REVIEW_SAVE_UNCONFIRMED' });
  }
  return receipt;
}

export async function handleManagerReview(request, dependencies = {}) {
  const url = new URL(request.url);
  if (!(dependencies.enabled ?? MANAGER_REVIEW_ENABLED) || url.pathname !== config.path || url.search || url.hash || !['GET', 'POST'].includes(request.method)) return jsonResponse(404, { ok: false, message: 'Manager pilot unavailable.' });
  const scope = managerReviewScope(request, dependencies);
  if (!scope) return jsonResponse(403, { ok: false, message: 'This pilot is unavailable on this deployment.' });
  const target = scope.target;
  const profile = scope.profile;
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
  if (!runtime || runtime.target !== target) return jsonResponse(503, { ok: false, message: 'Scoped receiver unavailable.' });
  const now = new Date(dependencies.now ?? Date.now());
  const today = localNow(now).date;
  const envelope = { gym: profile.installationId, from: REVIEW_START, to: today };
  // Explicit diagnostic controls use the same public aggregate read, receiver,
  // payload and validation. They cannot select a write or return private data.
  const transportControl = request.headers.get('X-GIB-M1-Transport-Control');
  if (transportControl && target !== 'test') return jsonResponse(403, { ok: false, message: 'Diagnostics are TEST-only.' });
  if (transportControl && (request.method !== 'GET' || !['pre-pr', 'current', 'native-https', 'runtime'].includes(transportControl))) return jsonResponse(400, { ok: false, message: 'Read-only TEST control required.' });
  if (['native-https', 'runtime'].includes(transportControl) && profile.installationId !== 'rev') return jsonResponse(403, { ok: false, message: 'Revolution TEST experiment only.' });
  if (transportControl === 'runtime') return jsonResponse(200, { ok: true, experiment: 'https-pairs-v1', gym: 'rev', target: 'test', node: process.versions.node, undici: process.versions.undici || 'unknown', deploy: dependencies.context?.deploy?.id || process.env.DEPLOY_ID || null });
  let input = { action: 'badge' }, adminName;
  if (request.method === 'POST') {
    const auth = requireAdmin(request, runtime, +now);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, 32768);
    if (parsed.response) return parsed.response;
    input = parsed.value;
    adminName = auth.session.adminName;
    if (!input || !['read', 'partial', 'complete', 'void'].includes(input.action)) return jsonResponse(400, { ok: false, message: 'Choose a review action.' });
    if (input.action === 'void' && target !== 'test') return jsonResponse(403, { ok: false, message: 'Use the existing Daily Review correction controls.' });
  }
  const callbackRead = Boolean(callbackRuntime(request, config.path, dependencies)) && !transportControl && ['read', 'badge'].includes(input.action);
  const ticketRequested = request.method === 'GET' ? request.headers.has(READ_OPERATION_HEADER) : input.action === 'read' && Object.hasOwn(input, 'readRequest');
  const ticket = ticketRequested ? request.method === 'GET'
    ? { operation: request.headers.get(READ_OPERATION_HEADER), requestId: request.headers.get(READ_ID_HEADER) } : input.readRequest : null;
  if (ticketRequested && (!callbackRead || !ticket || typeof ticket !== 'object' || Array.isArray(ticket)
    || Object.keys(ticket).sort().join('|') !== 'operation|requestId' || !['start', 'status'].includes(ticket.operation) || !validId(ticket.requestId))) {
    return jsonResponse(400, { ok: false, message: 'An identified Revolution read ticket is required.' });
  }
  const trace = callbackRead ? createReadTrace(ticket?.requestId || randomUUID(), dependencies, request.headers.get(READ_ID_HEADER)) : () => {};
  const respond = (status, value) => {
    const response = jsonResponse(status, value);
    if (callbackRead) response.headers.set(READ_ID_HEADER, trace.requestId);
    trace('response', 'ready', status); // Browser receipt is logged separately; this is not proof of delivery.
    return response;
  };
  trace('request', 'accepted');
  const call = async (action, data) => {
    const wireData = { ...envelope, ...data };
    const google = ['pre-pr', 'native-https'].includes(transportControl)
      ? await traceGoogle({ target: runtime.target, enabled: true, action, gym: profile.installationId, variant: transportControl }, () => prePrPostGoogle(runtime, action, wireData, transportControl === 'native-https' ? dependencies.nativeHttps || nativeHttpsControl : dependencies.fetch || fetch))
      : await postGoogle({ ...runtime, installationId: profile.installationId, testTrace: target === 'test', testNativeHttps: target === 'test' && !transportControl, testReadRetry: target === 'test' && !transportControl && ['badge', 'read'].includes(input.action) }, action, wireData, dependencies.fetch || fetch, dependencies.nativeHttps || dependencies.fetch || nativeHttpsControl);
    if (!google.readable || google.value?.ok !== true) {
      const error = new Error(google.value?.conflict ? 'Attendance or another review changed. Refresh this day.' : 'Central saving or reading could not be confirmed. Retry safely; do not assume the day is complete.');
      if (google.value?.conflict) error.status = 409;
      error.code = googleFailureClass(google);
      throw error;
    }
    return google.value;
  };
  const load = async () => {
    const [ledger, calendar] = await Promise.all([
      callbackRead ? loadCallbackLedger(request, runtime, adminName, { ...dependencies, readTrace: trace }) : call('managerReviewRead', { check: ['partial', 'complete'].includes(input.action) ? input : null, adminName }),
      managerCalendar(request, scope, { ...dependencies, readTrace: trace }, now)
    ]);
    return plannedManagerRead(ledger, calendar, scope, now, trace);
  };
  const reviewSave = ['partial', 'complete'].includes(input.action), saveStarted = (dependencies.clock || Date.now)();
  let saveStage = reviewSave ? 'review.pre-save-read' : null;
  try {
    if (ticket) {
      const read = await readCallbackTicket(request, runtime, adminName, ticket, { ...dependencies, readTrace: trace });
      if (read.state === 'pending') return respond(202, { ok: true, ...read });
      const value = await assembleManagerRead(read.result, request, scope, { ...dependencies, readTrace: trace });
      const deliveredAt = (dependencies.clock || Date.now)();
      if (deliveredAt >= read.deadlineAt || deliveredAt >= read.expiresAt || localNow(new Date(deliveredAt)).date !== value.today) {
        throw Object.assign(new Error('Read observation ended before delivery.'), { status: 410 });
      }
      return respond(200, request.method === 'GET' ? { ok: true, pendingDays: value.pendingDays, asOf: value.asOf } : value);
    }
    let loaded = await load();
    let receipt;
    if (input.action === 'void') {
      if (typeof input.recordId !== 'string' || typeof input.fingerprint !== 'string' || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 240) throw new Error('Select one TEST record and enter a reason.');
      receipt = await call('managerReviewVoid', { adminName, date: input.date, recordId: input.recordId, fingerprint: input.fingerprint, reason: input.reason });
      if (receipt.removed !== true || receipt.recordId !== input.recordId) throw new Error('The correction was not confirmed.');
      // The receiver has already read back the permanent status and audit under its lock.
      // Let the browser fetch the new view separately instead of risking a third
      // Apps Script round trip inside one bounded hosting request.
      return jsonResponse(200, { ok: true, test: true, receipt });
    } else if (['partial', 'complete'].includes(input.action)) {
      // A lost response can be checked using the original request, even after later changes.
      // A present but invalid receipt is ambiguous, never permission to save again.
      if (Object.hasOwn(loaded.ledger, 'receipt')) {
        saveStage = 'review.checked-receipt';
        receipt = confirmedReviewReceipt(loaded.ledger.receipt, input);
      }
      else {
        saveStage = 'review.pre-save-validation';
        const day = loaded.ledger.days.find(day => day.date === input.date);
        if (!day) throw new Error('Choose a date in the cleanup period.');
        let review;
        try { review = proposedReview(input, day, loaded.schedule, loaded.added, now); }
        catch (error) { error.status = 409; throw error; }
        saveStage = 'review.save-dispatch';
        receipt = await call('managerReviewSave', { date: input.date, adminName, review });
        saveStage = 'review.save-receipt';
        receipt = confirmedReviewReceipt(receipt, input);
        return jsonResponse(200, { ok: true, target, test: target === 'test', receipt });
      }
    }
    const count = loaded.days.filter(day => !day.complete).length;
    // Public kiosk response is deliberately an aggregate. No dates, reviewer or attendance data.
    if (request.method === 'GET') return respond(200, { ok: true, pendingDays: count, asOf: now.toISOString() });
    return respond(200, { ok: true, target, test: target === 'test', gym: profile.installationId, site: profile.siteCode, timezone: TIMEZONE, today, cleanupStart: REVIEW_START, period: periodFor(today), asOf: new Date().toISOString(), pendingDays: count, days: loaded.days, ...(receipt ? { receipt } : {}) });
  } catch (error) {
    trace('review', 'failed', error.status || 503);
    if (reviewSave) {
      try { (dependencies.traceLog || console.warn)('M1_MANAGER_REVIEW_SAVE_STAGE', JSON.stringify({
        requestId: /^manager-[a-zA-Z0-9-]{16,100}$/.test(input.requestId || '') ? input.requestId : null,
        stage: saveStage, status: error.status || 503, code: /^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : 'UNCONFIRMED',
        elapsedMs: Math.max(0, (dependencies.clock || Date.now)() - saveStarted)
      })); } catch {} // Diagnostics cannot change save confirmation or recovery.
    }
    return respond(error.status || 503, { ok: false, message: ['read', 'badge'].includes(input.action) ? 'Review status unavailable. No fresh central read was confirmed.' : error.message || 'Review unavailable. Nothing is being marked caught up.', ...(error.code ? { code: error.code } : {}), ...(reviewSave ? { stage: saveStage } : {}) });
  }
}
export default (request, context) => handleManagerReview(request, { context });
