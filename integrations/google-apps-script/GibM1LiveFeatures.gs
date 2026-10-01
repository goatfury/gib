/* Included only in the separately provisioned production receiver bundles.
 * Missing/non-exact properties keep all new capabilities dormant. */
function gibM1LiveInstallation_() {
  try {
    if (typeof GIB_M1_ALLOWED_TARGET === 'undefined' || GIB_M1_ALLOWED_TARGET !== 'production'
      || configuredDeploymentTarget_() !== 'production' || !deploymentTargetAllowed_('production')
      || typeof gibM1RichmondTestScope_ === 'function' || typeof TEST_SPREADSHEET_ID !== 'undefined') return null;
    var properties = PropertiesService.getScriptProperties();
    if (properties.getProperty('GIB_M1_TEST_SPREADSHEET_ID') || properties.getProperty('GIB_M1_RICHMOND_TEST_SPREADSHEET_ID')) return null;
    if (typeof GIB_M1_RICHMOND_PRODUCTION_INSTALLATION_ !== 'undefined') {
      if (!gibM1RichmondProductionLocksValid_() || EXPECTED_SPREADSHEET_NAME !== 'Richmond BJJ M1 — PRODUCTION'
        || SPREADSHEET_ID !== properties.getProperty('GIB_M1_RICHMOND_PRODUCTION_SPREADSHEET_ID')) return null;
      return { gym: 'richmond', installation: 'richmond', environment: 'production', target: 'production',
        origin: 'https://gib-richmond-live.netlify.app', digestUrl: 'https://gib-richmond-live.netlify.app/api/m1-attendance-digest-job' };
    }
    if (typeof GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK === 'undefined' || GIB_M1_REQUIRE_PERSISTED_TARGET_LOCK !== true
      || properties.getProperty('GIB_M1_PROVISIONING_CLOSED') !== 'closed-v1'
      || !SPREADSHEET_ID || SPREADSHEET_ID !== properties.getProperty('GIB_M1_PRODUCTION_SPREADSHEET_ID')
      || EXPECTED_SPREADSHEET_NAME !== 'RBJJ M1 — PRODUCTION') return null;
    return { gym: 'rev', target: 'production', origin: 'https://gib-live.netlify.app',
      digestUrl: 'https://gib-live.netlify.app/api/m1-attendance-digest-job' };
  } catch (_) { return null; }
}
function gibM1LiveReminderScope_() {
  var scope = gibM1LiveInstallation_();
  return scope && PropertiesService.getScriptProperties().getProperty('GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED') === 'true' ? scope : null;
}
function gibM1LiveStaffRecoveryEnabled_() {
  var scope = gibM1LiveInstallation_();
  return Boolean(scope && scope.gym === 'rev' && PropertiesService.getScriptProperties().getProperty('GIB_M1_STAFF_RECOVERY_LIVE_ENABLED') === 'true');
}
function gibM1LiveTreyEnabled_() {
  var scope = gibM1LiveInstallation_();
  return Boolean(scope && scope.gym === 'richmond' && gibM1RichmondProductionWritesEnabled_()
    && PropertiesService.getScriptProperties().getProperty('GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED') === 'true');
}
function attendanceProductionDigestTick() {
  var scope = gibM1LiveReminderScope_();
  if (!scope || PropertiesService.getScriptProperties().getProperty('GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED') !== 'true') return;
  if (!gibM1MailAppActor_()) return; // no attendance read or attempt under another execution account
  if (typeof gibM1EmailFirstEnabled_ === 'function' && gibM1EmailFirstEnabled_()) return gibM1AttendanceEmailFirstTick_();
  return gibM1AttendanceDigestTick_();
}
// These editor helpers are a later, approved production consent/setup handoff.
// The authorization probe never sends or writes; no inbox scope is requested.
function authorizeProductionMailApp() {
  var scope = gibM1LiveInstallation_();
  if (!scope || !gibM1MailAppActor_()) throw new Error('MAILAPP_SENDER_UNVERIFIED');
  var quota = MailApp.getRemainingDailyQuota();
  if (!Number.isSafeInteger(quota) || quota < 0) throw new Error('MAILAPP_QUOTA_UNAVAILABLE');
  return { ok: true, target: 'production', gym: scope.gym, senderVerified: true, quotaAvailable: quota > 0 };
}
function prepareProductionMailAppLedger() {
  var scope = gibM1LiveInstallation_();
  if (!scope || !gibM1MailAppActor_()) throw new Error('MAILAPP_SENDER_UNVERIFIED');
  return gibM1PrepareMailAppLedger_(scope);
}
