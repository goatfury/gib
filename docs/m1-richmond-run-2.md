# Richmond M1 Run 2 resources

Run 2 uses four Richmond-only TEST resources. None reuses or changes a Revolution resource.

1. **Richmond TEST Sheet** — `Richmond BJJ M1 — TEST`, owned by `revbjjops@gmail.com`. It contains only the `Signins` and `Admin Audit` tabs, with the fixed M1 headers and no starting data rows.
2. **Richmond TEST Apps Script** — `Richmond BJJ M1 Receiver — TEST`, deployed as web-app version 3. It accepts only the Richmond TEST target, installation, environment, site, device, fake instructor names, and allowed Daily Review actions. Its one-time Sheet setup is permanently closed after success.
3. **Richmond TEST Netlify site** — `https://gib-richmond-test.netlify.app`. Its runtime is fixed to `GIB_M1_INSTALLATION=richmond` and `GIB_M1_ENVIRONMENT=test`, with separate Richmond-only webhook and Admin credentials stored on the server. Richmond Staff Clock is disabled.
4. **Authoritative Richmond schedule** — `https://www.richmondbjj.com/schedule`. The server reads the bounded Richmond schedule block, validates the result, caches the last known good schedule, and uses `m1/richmond-schedule.json` only when the website and cache are unavailable. It never falls back to Revolution's schedule.

The browser receives no Sheet ID, Apps Script ID or URL, or server credential. Richmond requests are accepted only from the stable Richmond TEST host or its immutable Netlify deploy URLs, and every request remains locked to `richmond` plus `test`.

Run 3 remains an independent review of the isolated Richmond TEST site and proof data. It must not merge this branch or create Richmond production resources.
