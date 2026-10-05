import { splitAttendanceDigest, renderAttendanceDigest, digestHash } from './m1-attendance-digest.mjs';

export const MANAGER_ATTENDANCE_POLICY = 'rev-repeat-unchanged-monitor/v1';
export function validReportingEvidence(value, gym, target) {
  return value && Object.keys(value).sort().join('|') === 'deviceCount|gym|schema|state|target'
    && value.schema === 'm1-reporting-evidence/v1' && value.gym === gym && value.target === target
    && (value.state === 'unknown' && value.deviceCount === null
      || value.state === 'none-observed' && value.deviceCount === 0
      || value.state === 'observed' && Number.isSafeInteger(value.deviceCount) && value.deviceCount > 0 && value.deviceCount <= 100);
}

export function managerAttendanceEmail(digest, configuration, uploadAssessment) {
  const route = splitAttendanceDigest(digest, configuration)[0], own = route.digest;
  if (configuration.target !== 'production' || configuration.gyms.length !== 1 || configuration.emailFirst !== true)
    throw new Error('Manager email requires the own-gym production email scope.');
  // No Richmond policy change: retain the released v1 decision/render exactly.
  if (route.gym !== 'rev') return { schema:'m1-daily-email-check/v1', gym:route.gym, date:own.date,
    complete:true, shouldSend:own.shouldCapture, rendered:route.rendered,
    issueCount:own.itemCount, unconfirmedChecks:own.readFailures.length };
  const evidence = uploadAssessment?.monitoring;
  if (!validReportingEvidence(evidence, 'rev', 'production')) throw new Error('Reporting evidence binding unavailable.');
  const managerFailures = own.readFailures.filter(f => f.code !== 'HISTORICAL_SCHEDULE_UNAVAILABLE');
  // Pending rows, unknown records/class decisions and incomplete manifests
  // always alert: the current schema cannot prove their rows unchanged.
  const faults = managerFailures.map(f => {
    const reason = f.component === 'uploads' ? uploadAssessment.reason : null;
    const repeatable = f.component === 'uploads'
      ? ['TABLET_REPORT_NOT_RECEIVED','TABLET_REPORT_STALE','UPLOAD_EVIDENCE_READ_UNAVAILABLE'].includes(reason)
      : ['ATTENDANCE_UNAVAILABLE','SCHEDULE_COVERAGE_UNAVAILABLE','STAFF_UNAVAILABLE'].includes(f.code);
    const key = [MANAGER_ATTENDANCE_POLICY, 'rev', 'production', f.component, f.code, reason,
      f.component === 'uploads' ? evidence.state : null,
      f.component === 'uploads' ? evidence.deviceCount : null,
      f.component === 'uploads' ? uploadAssessment.reporterSetHash ?? null : null];
    return { signature:digestHash(key), component:f.component, code:f.code, reason, repeatable };
  }).sort((a,b) => a.signature.localeCompare(b.signature));
  const manager = { ...own, readFailures: managerFailures,
    shouldCapture: Boolean(own.itemCount || managerFailures.length) };
  const coverageConfirmed = own.readFailures.length === 0;
  let rendered = manager.shouldCapture ? renderAttendanceDigest(manager) : null;
  if (rendered && own.readFailures.length !== managerFailures.length) {
    const note = 'This message lists the attendance problems and current unconfirmed checks. It is not a complete all-clear for every upload or check.';
    rendered = { ...rendered, text: rendered.text + '\n\n' + note,
      html: rendered.html.replace('</main>', '<p>' + note + '</p></main>') };
  }
  return { schema: 'm1-daily-email-check/v2', policy: MANAGER_ATTENDANCE_POLICY, gym: route.gym, date: own.date,
    complete: true, shouldSend: manager.shouldCapture, rendered, issueCount: own.itemCount,
    unconfirmedChecks: own.readFailures.length, managerWarningCount: managerFailures.length,
    operatorFaultCount: own.readFailures.length - managerFailures.length, coverageConfirmed,
    reportingEvidence: structuredClone(evidence), monitorFaults: faults };
}
