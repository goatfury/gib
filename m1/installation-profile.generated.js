'use strict';
(() => {
  const profile = {
  "schema": "gib-m1-installation-profile/v1",
  "installationId": "rev",
  "gymName": "Revolution BJJ",
  "siteCode": "Rev",
  "deviceLabel": "Revolution BJJ front desk",
  "storagePrefix": "gib_m1_",
  "allowedOrigin": "https://gib-live.netlify.app",
  "scheduleSource": {
    "mode": "rev-website",
    "endpoint": "/api/m1-schedule"
  },
  "featureFlags": {
    "staffClock": true,
    "staffClockPairing": true
  },
  "staffClockPairing": {
    "origin": "https://gib-live.netlify.app",
    "expiresInSeconds": 300
  },
  "backend": {
    "enabled": true,
    "transportTarget": "rev"
  }
};
  Object.freeze(profile.scheduleSource);
  Object.freeze(profile.featureFlags);
  if (profile.staffClockPairing) Object.freeze(profile.staffClockPairing);
  Object.freeze(profile.backend);
  Object.freeze(profile);
  Object.defineProperty(globalThis, 'M1_INSTALLATION_PROFILE', {
    value: profile,
    enumerable: false,
    configurable: false,
    writable: false
  });
  Object.defineProperty(globalThis, 'M1_INSTALLATION_PROFILE_VALID', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
  document.documentElement.dataset.m1Installation = profile.installationId;
  document.documentElement.dataset.m1Environment = profile.environment || '';
  document.documentElement.dataset.m1StaffClock = String(profile.featureFlags.staffClock);
  document.documentElement.dataset.m1StaffClockPairing = String(profile.featureFlags.staffClockPairing);

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
