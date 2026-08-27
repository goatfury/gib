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
  'richmond:test': Object.freeze({
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'richmond',
    gymName: 'Richmond BJJ',
    siteCode: 'Richmond',
    deviceLabel: 'Richmond TEST Browser',
    storagePrefix: 'gib_m1_richmond_',
    environment: 'test',
    allowedOrigin: 'https://gib-richmond-test.netlify.app',
    scheduleSource: Object.freeze({
      mode: 'richmond-website',
      endpoint: '/api/m1-schedule'
    }),
    featureFlags: Object.freeze({ staffClock: false }),
    backend: Object.freeze({ enabled: true, transportTarget: 'richmond-test' })
  }),
  'richmond:production:pending': Object.freeze({
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'richmond',
    gymName: 'Richmond BJJ',
    siteCode: 'Richmond',
    deviceLabel: 'Richmond Front Desk Tablet',
    storagePrefix: 'gib_m1_richmond_production_',
    environment: 'production',
    allowedOrigin: 'https://gib-richmond-live.netlify.app',
    activation: 'pending',
    writesEnabled: false,
    scheduleSource: Object.freeze({
      mode: 'richmond-website',
      endpoint: '/api/m1-schedule'
    }),
    featureFlags: Object.freeze({ staffClock: false }),
    backend: Object.freeze({ enabled: true, transportTarget: 'richmond-production' })
  }),
  'richmond:production:active': Object.freeze({
    schema: 'gib-m1-installation-profile/v1',
    installationId: 'richmond',
    gymName: 'Richmond BJJ',
    siteCode: 'Richmond',
    deviceLabel: 'Richmond Front Desk Tablet',
    storagePrefix: 'gib_m1_richmond_production_',
    environment: 'production',
    allowedOrigin: 'https://gib-richmond-live.netlify.app',
    activation: 'active',
    writesEnabled: true,
    scheduleSource: Object.freeze({
      mode: 'richmond-website',
      endpoint: '/api/m1-schedule'
    }),
    featureFlags: Object.freeze({ staffClock: false }),
    backend: Object.freeze({ enabled: true, transportTarget: 'richmond-production' })
  })
});

function normalizedProfileValue(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
}

export function installationProfile(installationId, environment, activation = 'pending') {
  const id = normalizedProfileValue(installationId);
  if (id === 'rev') return PROFILES.rev;
  if (id !== 'richmond') return null;
  const targetEnvironment = normalizedProfileValue(environment) || 'test';
  if (targetEnvironment === 'test') return PROFILES['richmond:test'];
  if (targetEnvironment !== 'production') return null;
  const targetActivation = normalizedProfileValue(activation) || 'pending';
  return PROFILES[`richmond:production:${targetActivation}`] || null;
}

export function validInstallationProfile(value) {
  const canonical = installationProfile(
    value?.installationId,
    value?.environment,
    value?.activation
  );
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
  if (profile.installationId === 'richmond') {
    return candidate.startsWith(profile.storagePrefix)
      && (
        profile.environment !== 'test'
        || !candidate.startsWith('gib_m1_richmond_production_')
      );
  }
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
  document.documentElement.dataset.m1Environment = profile.environment || '';
  document.documentElement.dataset.m1StaffClock = String(profile.featureFlags.staffClock);

  if (
    typeof URL === 'undefined'
    || !document.head
    || typeof document.createElement !== 'function'
  ) return;

  const profileScript = document.currentScript;
  const baseUrl = profileScript && profileScript.src
    ? new URL('.', profileScript.src)
    : new URL('./', document.baseURI);
  const revision = profileScript && profileScript.src
    ? new URL(profileScript.src).searchParams.get('v') || ''
    : '';
  const assetUrl = path => {
    const url = new URL(path, baseUrl);
    if (revision) url.searchParams.set('v', revision);
    return url.href;
  };

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = assetUrl('kiosk-enhancements.css');
  document.head.appendChild(stylesheet);

  const enhancements = document.createElement('script');
  enhancements.type = 'module';
  enhancements.src = assetUrl('kiosk-enhancements.mjs');
  document.head.appendChild(enhancements);
})();
`;
}
