import { splitAttendanceDigest, renderAttendanceDigest } from './m1-attendance-digest.mjs';

export const MANAGER_ATTENDANCE_POLICY = 'manager-actionable/v1';
export function validReportingEvidence(value, gym, target) {
  return value && Object.keys(value).sort().join('|') === 'deviceCount|gym|schema|state|target'
    && value.schema === 'm1-reporting-evidence/v1' && value.gym === gym && value.target === target
    && (value.state === 'unknown' && value.deviceCount === null
      || value.state === 'none-observed' && value.deviceCount === 0
      || value.state === 'observed' && Number.isSafeInteger(value.deviceCount) && value.deviceCount > 0 && value.deviceCount <= 100);
}

// Local release proposal: a manager message is a projection, never the source
// of coverage truth. The immutable operator capture retains ALL raw failures,
// historical dates and original attendance items. No registry/enrollment change.
export function managerAttendanceEmail(digest, configuration, uploadAssessment) {
  const route = splitAttendanceDigest(digest, configuration)[0];
  if (configuration.target !== 'production' || configuration.gyms.length !== 1 || configuration.emailFirst !== true)
    throw new Error('Manager email requires the own-gym production email scope.');
  const evidence = uploadAssessment?.monitoring;
  if (!validReportingEvidence(evidence, route.gym, configuration.target)) throw new Error('Reporting evidence binding unavailable.');
  const own = route.digest;
  const managerFailures = own.readFailures.filter(failure => {
    if (failure.code === 'HISTORICAL_SCHEDULE_UNAVAILABLE') return false;
    if (failure.component === 'uploads') return evidence.state === 'observed';
    // A recorded unresolved class-status decision remains distinct from a
    // schedule API/setup failure. It never alleges an absent instructor.
    return failure.code === 'CLASS_STATUS_UNCONFIRMED';
  }).map(failure => failure.component === 'uploads' ? { ...failure,
    message: failure.message + ' Check the tablet\'s saved-upload warnings during normal use; tell Andrew if they do not clear.' } : failure);
  const manager = { ...own, readFailures: managerFailures,
    shouldCapture: Boolean(own.itemCount || managerFailures.length) };
  const coverageConfirmed = own.readFailures.length === 0;
  let rendered = manager.shouldCapture ? renderAttendanceDigest(manager) : null;
  if (rendered && !coverageConfirmed && own.readFailures.length !== managerFailures.length) {
    const note = 'This message lists the attendance problems and device warnings that need attention. It is not a complete all-clear for every upload or check.';
    rendered = { ...rendered, text: rendered.text + '\n\n' + note,
      html: rendered.html.replace('</main>', '<p>' + note + '</p></main>') };
  }
  return { schema: 'm1-daily-email-check/v2', policy: MANAGER_ATTENDANCE_POLICY, gym: route.gym, date: own.date,
    complete: true, shouldSend: manager.shouldCapture, rendered, issueCount: own.itemCount,
    unconfirmedChecks: own.readFailures.length, managerWarningCount: managerFailures.length,
    operatorFaultCount: own.readFailures.length - managerFailures.length, coverageConfirmed,
    reportingEvidence: structuredClone(evidence) };
}
