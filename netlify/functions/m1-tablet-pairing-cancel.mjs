import { handleTabletPairingOperation } from './_lib/m1-tablet-pairing-handler.mjs';

export const TABLET_PAIRING_CANCEL_PATH = '/api/m1-tablet-pairing-cancel';

export const config = {
  // Netlify requires a literal route value during function extraction.
  path: '/api/m1-tablet-pairing-cancel',
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};

export function handleTabletPairingCancel(request, dependencies = {}) {
  return handleTabletPairingOperation(
    request,
    'cancel',
    TABLET_PAIRING_CANCEL_PATH,
    dependencies
  );
}

export default request => handleTabletPairingCancel(request);
