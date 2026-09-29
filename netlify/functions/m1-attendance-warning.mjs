import { jsonResponse } from './_lib/m1-common.mjs';
import { attendanceDigestScope } from './m1-attendance-digest.mjs';
import { workflowHealth } from './_lib/m1-attendance-digest-workflow.mjs';

export const config = { path: '/api/m1-attendance-warning', rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export const ATTENDANCE_WARNING_TEXT = Object.freeze({
  CHECK_OVERDUE: 'Attendance check overdue. Open Admin.',
  CHECK_INCOMPLETE: 'Attendance could not be fully checked. Open Admin.',
  DELIVERY_FAILED: 'Attendance email could not be sent. Open Admin.',
  DELIVERY_UNCONFIRMED: 'Attendance email delivery is unconfirmed. Open Admin.',
  CONFIGURATION_REQUIRED: 'Attendance reminders are not set up yet.'
});
const STATE_WARNING = Object.freeze({
  'check-overdue': 'CHECK_OVERDUE', 'check-incomplete': 'CHECK_INCOMPLETE',
  'delivery-failed': 'DELIVERY_FAILED', 'delivery-unconfirmed': 'DELIVERY_UNCONFIRMED',
  'not-configured': 'CONFIGURATION_REQUIRED', attention: null, clear: null
});

export async function handleAttendanceWarning(request, dependencies = {}) {
  const url = new URL(request.url);
  if (url.pathname !== config.path || url.search || url.hash || request.method !== 'GET')
    return jsonResponse(404, { ok: false, message: 'Attendance warning unavailable.' });
  const scope = attendanceDigestScope(request, dependencies);
  if (!scope) return jsonResponse(403, { ok: false, message: 'An enabled TEST installation is required.' });
  try {
    const health = await (dependencies.readHealth || workflowHealth)(scope, { ...dependencies, scope });
    if (!health || health.ok !== true || health.target !== 'test' || !Array.isArray(health.codes)
      || !Object.hasOwn(STATE_WARNING, health.state)
      || ['pendingCount', 'failedCount', 'unconfirmedCount'].some(key => !Number.isSafeInteger(health[key]) || health[key] < 0)
      || health.codes.some(code => !Object.hasOwn(ATTENDANCE_WARNING_TEXT, code))
      || (health.checkedAt !== null && !Number.isFinite(Date.parse(health.checkedAt)))) throw new Error('Invalid status');
    const codes = [...new Set(health.codes)], now = (dependencies.clock || Date.now)();
    if ((STATE_WARNING[health.state] && !codes.includes(STATE_WARNING[health.state]))
      || (health.state === 'clear' && (codes.length || health.pendingCount || health.failedCount || health.unconfirmedCount))
      || (health.failedCount > 0 && !codes.includes('DELIVERY_FAILED'))
      || (health.unconfirmedCount > 0 && !codes.includes('DELIVERY_UNCONFIRMED'))) throw new Error('Contradictory status');
    if (health.checkedAt !== null && Date.parse(health.checkedAt) > now + 5000) throw new Error('Future evidence');
    if (!codes.length && health.checkedAt === null) throw new Error('Missing evidence');
    if (health.checkedAt !== null && now - Date.parse(health.checkedAt) >= 30 * 60000 && !codes.includes('CHECK_OVERDUE')) codes.push('CHECK_OVERDUE');
    // Construct the public response from fixed categories, never forward private
    // message bodies, names, recipients, permanent IDs or provider receipts.
    const warnings = codes.map(code => ({ code, message: ATTENDANCE_WARNING_TEXT[code] }));
    return jsonResponse(200, { ok: true, target: 'test', gym: scope.profile.installationId,
      status: codes.length ? (codes.every(code => code === 'CONFIGURATION_REQUIRED') ? 'not-configured' : 'attention') : 'clear',
      warnings, checkedAt: health.checkedAt });
  } catch {
    return jsonResponse(503, { ok: false, target: 'test', gym: scope.profile.installationId, message: 'Attendance check status unavailable.' });
  }
}
export default (request, context) => handleAttendanceWarning(request, { context, env: process.env });
