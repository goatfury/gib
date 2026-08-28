import { handleTabletPairingOperation } from './_lib/m1-tablet-pairing-handler.mjs';

export const TABLET_PAIRING_POLL_PATH = '/api/m1-tablet-pairing-poll';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-tablet-pairing-poll',
  rateLimit: {
    windowLimit: 120,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

export function handleTabletPairingPoll(request, dependencies = {}) {
  return handleTabletPairingOperation(
    request,
    'poll',
    TABLET_PAIRING_POLL_PATH,
    dependencies
  );
}

export default request => handleTabletPairingPoll(request);
