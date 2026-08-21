const PROFILES = Object.freeze({
  rev: Object.freeze({
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'rev',
    gymName: 'Revolution BJJ',
    siteCode: 'Rev',
    deviceLabel: 'Revolution BJJ front desk',
    storagePrefix: 'gib_m1_',
    scheduleSource: Object.freeze({
      mode: 'rev-website',
      endpoint: '/api/m1-schedule'
    }),
    featureFlags: Object.freeze({ staffClock: true }),
    backend: Object.freeze({ enabled: true, transportTarget: 'rev' })
  }),
  richmond: Object.freeze({
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'richmond',
    gymName: 'Richmond BJJ',
    siteCode: 'Richmond',
    deviceLabel: 'Richmond TEST preview device',
    storagePrefix: 'gib_m1_richmond_',
    scheduleSource: Object.freeze({
      mode: 'test-only',
      endpoint: ''
    }),
    featureFlags: Object.freeze({ staffClock: false }),
    backend: Object.freeze({ enabled: false, transportTarget: 'none' })
  })
});

export function installationProfile(installationId) {
  const id = String(installationId == null ? '' : installationId)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
  return PROFILES[id] || null;
}

export function validInstallationProfile(value) {
  const canonical = installationProfile(value?.installationId);
  if (!canonical || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  return JSON.stringify(value) === JSON.stringify(canonical);
}

export function scopedStorageKey(profile, revKey) {
  if (!validInstallationProfile(profile)) throw new Error('A valid installation profile is required.');
  const key = String(revKey || '');
  if (!/^gib_m1_[a-z0-9_]+$/u.test(key)) throw new Error('A canonical M1 storage key is required.');
  return profile.installationId === 'rev'
    ? key
    : `${profile.storagePrefix}${key.slice('gib_m1_'.length)}`;
}

export function ownsInstallationStorageKey(profile, key) {
  if (!validInstallationProfile(profile)) return false;
  const candidate = String(key || '');
  if (profile.installationId === 'richmond') return candidate.startsWith(profile.storagePrefix);
  return candidate.startsWith('gib_m1_')
    && !candidate.startsWith('gib_m1_richmond_');
}

export function browserInstallationProfileSource(profile) {
  if (!validInstallationProfile(profile)) throw new Error('A valid installation profile is required.');
  return `'use strict';
(() => {
  const profile = ${JSON.stringify(profile, null, 2)};
  Object.freeze(profile.scheduleSource);
  Object.freeze(profile.featureFlags);
  Object.freeze(profile.backend);
  Object.freeze(profile);
  Object.defineProperty(globalThis, 'M1_INSTALLATION_PROFILE', {
    value: profile,
    enumerable: false,
    configurable: false,
    writable: false
  });
  document.documentElement.dataset.m1Installation = profile.installationId;
  document.documentElement.dataset.m1StaffClock = String(profile.featureFlags.staffClock);
})();
`;
}
