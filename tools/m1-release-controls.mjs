// Build and server source only. Handlers also require
// the existing exact published-site, installation, origin and receiver checks.
export const LIVE_ORIGINS = Object.freeze({ rev: 'https://gib-live.netlify.app', richmond: 'https://gib-richmond-live.netlify.app' });
export const LIVE_RECIPIENTS = Object.freeze({ rev: 'info@revolutionbjj.com', richmond: 'info@richmondbjj.com' });
export const BUSINESS_SENDER = 'revbjjops@gmail.com';
export const INITIAL_BCC = 'andrew@revolutionbjj.com';
export function liveControls(env = {}, gym) {
  return Object.freeze({
    reminders: ['rev', 'richmond'].includes(gym) && env.GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED === 'true',
    staffRecovery: gym === 'rev' && env.GIB_M1_STAFF_RECOVERY_LIVE_ENABLED === 'true',
    richmondReviewer: gym === 'richmond' && env.GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED === 'true'
  });
}
