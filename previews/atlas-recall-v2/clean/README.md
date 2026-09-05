# Atlas Recall clean review

This is the only maintained source for the Atlas review site. The published root is normal HTML with fingerprinted local CSS, JavaScript and geography data. There are no iframes, runtime patches, base64 payloads, service workers or third-party runtime requests.

- Site: `atlas-recall-v2-review-019fb86e`
- Site ID: `d744facc-e06b-4809-8757-4e14ea0e8d9c`
- Branch: `atlas-recall-v2-review`
- Build: `node previews/atlas-recall-v2/clean/build.mjs`
- Publish only `clean/dist`, never the repository root.

`countries.json` and `world-map.svg` were recovered from the working original 197-country game. `game.js` is the integrated state machine; `styles.css` is the responsive layout; `index.html` is the build template. A build replaces the map marker and asset names before publishing. The final root `index.html` is already fully expanded and directly serves the game.

World view and Auto zoom always start fresh. Only first completed-round capital baseline and best capital count are stored locally. Shown answers do not score within that round. Country aliases are retained; fuzzy answers require Enter. Country/capital names shared by a city-state count independently for both.

`public-qa.mjs` tests the exact public URL in Chromium at 1366×768 and mobile widths. It captures the initial state, capital prompt, spelling feedback, both hint stages, skipped capital, complete key, reset and timeout. The public fingerprint must match `build.json`; deployment success alone is not a QA pass.

Deployment credentials are passed to the runner only in an authenticated encrypted ephemeral envelope. The private key exists solely in the running job, and the session files are removed before the clean source commit. No credential is included in source or published assets. The runner deploys from a directory outside the monorepo so other sites and serverless functions cannot be included.

September 5 refinement: moving to another country or pressing blank Enter skips the pending capital without revealing or disqualifying it. Show is the only reveal action. Recalled map countries can be clicked or keyboard-selected to revisit their capitals. The map labels the latest answer or hovered recalled country, and a lavender outline marks recalled capitals. Feedback always reflects the latest answer.
