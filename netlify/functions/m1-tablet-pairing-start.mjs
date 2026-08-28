import { handleTabletPairingOperation } from './_lib/m1-tablet-pairing-handler.mjs';

export const TABLET_PAIRING_START_PATH = '/api/m1-tablet-pairing-start';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-tablet-pairing-start',
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

export function handleTabletPairingStart(request, dependencies = {}) {
  return handleTabletPairingOperation(
    request,
    'start',
    TABLET_PAIRING_START_PATH,
    dependencies
  );
}

export default request => handleTabletPairingStart(request);
