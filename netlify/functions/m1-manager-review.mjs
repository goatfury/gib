import { addedClassesScope } from './m1-added-classes.mjs';
import { handleM1Schedule } from './m1-schedule.mjs';
import { defaultAddedClassesStore, publicAddedClasses, readAddedClasses } from './_lib/m1-added-classes.mjs';
import { jsonResponse, readJson, requireAdmin, runtimeConfig, postGoogle, googleFailureClass } from './_lib/m1-common.mjs';
import { MANAGER_REVIEW_ENABLED } from './_lib/m1-manager-review.generated.mjs';
import { REVIEW_START, TIMEZONE, localNow, periodFor, validateRead, dayPlan, proposedReview } from './_lib/m1-manager-review.mjs';
import temporaryClasses from '../../m1/temporary-classes-core.js';

export const config = { path: '/api/m1-manager-review', rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export async function handleManagerReview(request, dependencies = {}) {
  const url = new URL(request.url);
  if (!(dependencies.enabled ?? MANAGER_REVIEW_ENABLED) || url.pathname !== config.path || url.search || url.hash || !['GET', 'POST'].includes(request.method)) return jsonResponse(404, { ok: false, message: 'TEST pilot unavailable.' });
  const scope = addedClassesScope(new Request(new URL('/api/m1-added-classes', url), { headers: request.headers }), dependencies);
  if (!scope || scope.target !== 'test') return jsonResponse(403, { ok: false, message: 'This pilot is available only in TEST.' });
  const profile = scope.profile;
  const runtime = runtimeConfig(dependencies.env || process.env, { admin: true, requestUrl: request.url, installationId: profile.installationId, environment: profile.environment, activation: profile.activation });
  if (!runtime || runtime.target !== 'test') return jsonResponse(503, { ok: false, message: 'TEST receiver unavailable.' });
  const now = new Date(dependencies.now ?? Date.now());
  const today = localNow(now).date;
  const envelope = { gym: profile.installationId, from: REVIEW_START, to: today };
  let input = { action: 'badge' }, adminName;
  if (request.method === 'POST') {
    const auth = requireAdmin(request, runtime, +now);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, 32768);
    if (parsed.response) return parsed.response;
    input = parsed.value;
    adminName = auth.session.adminName;
    if (!input || !['read', 'partial', 'complete', 'void'].includes(input.action)) return jsonResponse(400, { ok: false, message: 'Choose a review action.' });
  }
  const call = async (action, data) => {
    const google = await postGoogle(runtime, action, { ...envelope, ...data }, dependencies.fetch || fetch);
    if (!google.readable || google.value?.ok !== true) {
      const error = new Error(google.value?.conflict ? 'Attendance or another review changed. Refresh this day.' : 'Central saving or reading could not be confirmed. Retry safely; do not assume the day is complete.');
      if (google.value?.conflict) error.status = 409;
      error.code = googleFailureClass(google);
      throw error;
    }
    return google.value;
  };
  const load = async () => {
    const [ledger, schedule, added] = await Promise.all([
      call('managerReviewRead', { check: ['partial', 'complete'].includes(input.action) ? input : null, adminName }),
      dependencies.schedule ? Promise.resolve(dependencies.schedule) : handleM1Schedule(new Request(new URL('/api/m1-schedule', url)), dependencies).then(response => response.json()),
      (async () => {
        const store = dependencies.addedStore || await defaultAddedClassesStore('test');
        const { value } = await readAddedClasses(store, profile.installationId, +now, 'test');
        return publicAddedClasses(value, +now);
      })()
    ]);
    validateRead(ledger, profile.installationId, today);
    if (schedule?.current !== true || schedule.timezone !== TIMEZONE || !schedule.days || !temporaryClasses.validateDocument(added, profile.installationId, 'test') || !added.current) throw new Error('The current schedule could not be confirmed. Review is unavailable until a fresh read succeeds.');
    const days = ledger.days.map(day => dayPlan(day, schedule, added, now));
    return { ledger, schedule, added, days };
  };
  try {
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
      if (loaded.ledger.receipt?.requestId === input.requestId && loaded.ledger.receipt.saved === true) receipt = loaded.ledger.receipt;
      else {
        const day = loaded.ledger.days.find(day => day.date === input.date);
        if (!day) throw new Error('Choose a date in the cleanup period.');
        let review;
        try { review = proposedReview(input, day, loaded.schedule, loaded.added, now); }
        catch (error) { error.status = 409; throw error; }
        receipt = await call('managerReviewSave', { date: input.date, adminName, review });
        if (receipt.saved !== true || receipt.requestId !== input.requestId || !Number.isInteger(receipt.revision)) throw new Error('The review save was not confirmed.');
        return jsonResponse(200, { ok: true, test: true, receipt });
      }
    }
    const count = loaded.days.filter(day => !day.complete).length;
    // Public kiosk response is deliberately an aggregate. No dates, reviewer or attendance data.
    if (request.method === 'GET') return jsonResponse(200, { ok: true, pendingDays: count, asOf: now.toISOString() });
    return jsonResponse(200, { ok: true, test: true, gym: profile.installationId, site: profile.siteCode, timezone: TIMEZONE, today, cleanupStart: REVIEW_START, period: periodFor(today), asOf: new Date().toISOString(), pendingDays: count, days: loaded.days, ...(receipt ? { receipt } : {}) });
  } catch (error) {
    return jsonResponse(error.status || 503, { ok: false, message: error.message || 'Review unavailable. Nothing is being marked caught up.', ...(error.code ? { code: error.code } : {}) });
  }
}
export default (request, context) => handleManagerReview(request, { context });
