'use strict';
(() => {
  const profile = {
  "schema": "gib-m1-installation-profile/v1",
  "installationId": "rev",
  "gymName": "Revolution BJJ",
  "siteCode": "Rev",
  "deviceLabel": "Revolution BJJ front desk",
  "storagePrefix": "gib_m1_",
  "scheduleSource": {
    "mode": "rev-website",
    "endpoint": "/api/m1-schedule"
  },
  "featureFlags": {
    "staffClock": true
  },
  "backend": {
    "enabled": true,
    "transportTarget": "rev"
  }
};
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
