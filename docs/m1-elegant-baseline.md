# M1 Elegant Admin candidate baseline — 7 September 2026

This candidate starts from `origin/main` commit `3b85fe4a6a93695d2dea95a1b5e41354e24f9ac6` on the isolated branch `feature/m1-elegant-admin-classes-20260907`. The Richmond production upload contains additional code changes; those changes were recovered and preserved before the candidate UI work. No production deployment, setting, receiver, Sheet, tablet, or business record was changed during this baseline inspection.

## Deployment evidence

- Revolution's recorded release is deploy `6a95d82e6ea2ad000986b4ea`, the release of `3b85fe4`.
- Richmond's current uploaded release is deploy `6a9c7a2fec9f71d5ff660a57`, at [https://6a9c7a2fec9f71d5ff660a57--gib-richmond-live.netlify.app](https://6a9c7a2fec9f71d5ff660a57--gib-richmond-live.netlify.app). Netlify reports `context=production`, `commit_ref=null`, `branch=null`, and title `Deploy triggered by upload`. The upload must not be described as an exact checkout of main.
- The earlier Richmond release of `3b85fe4` is deploy `6a95da5a67486889844f50a3`.
- Netlify metadata was read through the existing authenticated CLI. Authentication values were not extracted or copied. Code was read with GET from the immutable Richmond deploy URL, not from business-data endpoints.

## Recovered Richmond changes

All 31 tracked Netlify source files and all tracked HTML, JavaScript, CSS, and JSON files under `m1/` were compared with the frozen main commit. The following five existing code files differ; the generated browser/server installation profiles differ as expected between Revolution and Richmond production. Netlify's 123-file deployed manifest confirms the two connection-page files are the only added files under `m1/` and `netlify/`; they were recovered from the deployed link and script reference.

| File | Existing Richmond behavior preserved |
| --- | --- |
| `m1/index.html` | Visible sending status; sign-in delivery note; bounded activation request; activation retry on normal timer/wake-ups when the initial check failed; upload diagnostics; updated offline revision |
| `m1/sync-core.mjs` | Fixed failure categories, bounded counts-only delivery history, and plain-language sending status |
| `m1/staff-clock-client.mjs` | Updated imported asset revision only |
| `netlify/functions/m1-kiosk-sync.mjs` | Fixed diagnostic response category only for an opted-in authorized Richmond production tablet |
| `netlify/functions/m1-tablet-status.mjs` | Fixed connection-check response category after existing Richmond tablet authorization |
| `m1/connection.html` | Richmond connection-check page |
| `m1/connection-check.mjs` | Connection check and bounded local delivery-history display |

The server changes preserve the normal response bodies and existing origin, configuration, and device checks. The browser history excludes names, row IDs, URLs, credentials, and upstream responses. A failed initial activation can retry; a later operator choice to turn automatic sending off remains respected.

The five changed existing files and two added files were copied exactly from the immutable deploy before feature edits. Scratch originals are retained outside the repository in `../richmond-hotfix/`; `../richmond-hotfix.patch` contains the recovered diff. Generated production installation profiles were not copied into the candidate.

| Recovered file | SHA-256 before candidate edits |
| --- | --- |
| `m1/index.html` | `672c66b6f51b0ed1114304eefa320df235919699ea6b8180cfe43f0119641197` |
| `m1/sync-core.mjs` | `248c63410f2f4bdbaf59d0a33e725a1ff3f3c383382df9e44e7ebcd69b4af742` |
| `m1/staff-clock-client.mjs` | `183a3438509c715a479bf69e2851920a10dcc1c6f2a01ed97625581e0d1a558a` |
| `netlify/functions/m1-kiosk-sync.mjs` | `504640ddb8e9d94c73c29468c382718e4fd41ef88498a7493217e9188524d6d6` |
| `netlify/functions/m1-tablet-status.mjs` | `8592747329abce91b9edc370c9d912b60de13c499886b79793ba3152294cab76` |

Netlify function digests changed between the August and September uploads, including functions whose source is identical. Runtime packaging also changed from Node 22 to Node 24. Those bundle digests alone are not evidence of additional source changes; the source comparison above supplies the code evidence.

## Existing isolated TEST route

- Revolution: use a fresh draft deploy on site `gib-live` (`f748e737-11e3-4fab-8e8c-bf185eab29ff`) and its immutable deploy URL. Source `runtimeTarget` pins both `deploy-preview-N--gib-live.netlify.app` and the 24-character immutable deploy host to `test`, independent of Netlify's context label. The exact canonical production hostname remains production.
- Richmond: use a fresh draft deploy on site `gib-richmond-test` (`42736c77-e3c8-40aa-ba97-4f935d0999ad`), with the generated installation fixed to `richmond/test` and `GIB_M1_ENVIRONMENT=test`. Only the stable TEST hostname and its immutable deploy hosts are accepted. Richmond production hosts are not accepted by that TEST profile.
- Build each gym profile separately before deployment. Keep the generated browser and server profiles together. The current build command is `npm run build`; the build profile comes from the nonsecret installation/environment settings.
- TEST Admin's existing UI selects Andrew Smith or Stuart Turner and uses `Enter TEST Admin`. The server accepts `testShortcut: true` only when the runtime is TEST and its own TEST server configuration validates. A production passphrase is not needed for TEST, and the TEST shortcut is rejected by production.
- Server-side TEST receivers and credentials remain separate from production. TEST sign-ins require clearly fake TEST names. Do not use the canonical production host to exercise candidate flows.

The initial source inspection did not invoke a business-data endpoint or authenticate an Admin session. The follow-up below checks TEST entry without retaining session values. The candidate's later QA must verify actual TEST persistence, reload, schedule behavior, and required regression cases before review.

## Follow-up TEST entry checks

On 7 September 2026, these existing deployments returned HTTP 200 for their public installation profile and Admin page, and HTTP 200 with `ok: true` and `test: true` for the existing TEST login shortcut:

- Richmond published TEST release: [https://6a89d9b82eadf535cb568857--gib-richmond-test.netlify.app](https://6a89d9b82eadf535cb568857--gib-richmond-test.netlify.app).
- Revolution unpublished PR #81 preview: [https://6a959e585aa884000807e132--gib-live.netlify.app](https://6a959e585aa884000807e132--gib-live.netlify.app), commit `6523b8a3b6bd8bd7ce7d080b12dbf9a28dc21515`.

Both public schedule APIs returned HTTP 200, the correct gym, seven days, `current: true`, `fallback: none`, and no storage warning. No Google business-data endpoint was invoked. This does not prove Google receiver persistence or availability. No production credential was submitted; session values were neither exposed nor retained.

### Richmond draft configuration blocker

The existing unpublished Richmond CLI draft [https://6a89ca3d60b367f1aab5d04e--gib-richmond-test.netlify.app](https://6a89ca3d60b367f1aab5d04e--gib-richmond-test.netlify.app) returns HTTP 503 on the same TEST login request: `Admin service is not configured for this environment.`

Its generated browser/server installation profiles, `m1-common.mjs`, and `m1-admin-login.mjs` are byte-identical to the working published Richmond TEST release. Value-free environment metadata identifies the missing draft scope:

| Richmond TEST setting | Contexts | Relevant scope |
| --- | --- | --- |
| `GIB_RICHMOND_TEST_WEBHOOK_TOKEN` | `production` only | `functions` included |
| `GIB_RICHMOND_TEST_ADMIN_ACTION_TOKEN` | `production` only | `functions` included |
| `GIB_RICHMOND_TEST_WEBHOOK_URL` | `all` | `functions` included |
| `GIB_M1_INSTALLATION` | `all` | `builds` and `functions` included |
| `GIB_M1_ENVIRONMENT` | `all` | `builds` and `functions` included |

The two TEST credential variables are marked secret. Their values were not accessed or returned; only names, scopes, and context labels were inspected. No environment setting was changed. Changing the nonsecret installation/environment build settings alone cannot make the existing Richmond draft backend available. Revolution's three TEST backend settings already include `deploy-preview` in their function contexts, consistent with its successful preview login.

### CLI draft context evidence

The Richmond unpublished CLI draft above has `deploy_source: cli`, `context: deploy-preview`, `published_at: null`, `branch: null`, and `manual_deploy: false`. The `manual_deploy` flag is therefore not a reliable filter for locating CLI drafts.

The installed CLI source describes `--context` as selecting environment variables for the local build. Its `createSiteDeploy` request sends `draft`, `branch`, `include_upload_url`, and `deploy_source`, with no explicit `context` field. Netlify assigned the historical draft's `deploy-preview` context. The CLI also reads function-scope settings for bundle configuration; that code uses `AWS_LAMBDA_JS_RUNTIME` and does not copy arbitrary settings into deployed runtime variables. `--context production` is not a demonstrated fix for draft-only runtime configuration.

Use a standard draft and verify the new deployment's actual metadata. The shared-class guard can retain its accepted `deploy-preview`/`branch-deploy` labels and unpublished-deployment requirement; this evidence does not justify widening it to `dev` or `production`.
