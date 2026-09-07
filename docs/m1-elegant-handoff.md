# M1 Elegant Admin and Temporary Classes — TEST handoff

Status: frozen TEST candidate with Revolution flows verified. Full two-gym acceptance remains blocked by Richmond TEST Admin access. This is not a production release.

## Source and review deployments

- Source: `c34cf62ab8742167dbac06a7b4a66843a4638efc`, including the status display fix and final server cancellation fixes. Browser files are byte-identical to `f1b385f`.
- Branch: `feature/m1-elegant-admin-classes-20260907`, pushed for isolated review.
- Draft PR #83: [https://github.com/goatfury/gib/pull/83](https://github.com/goatfury/gib/pull/83). Nothing merged into main.
- Revolution: [https://6a9f47b1a3ba58000842fb26--gib-live.netlify.app/m1/admin/](https://6a9f47b1a3ba58000842fb26--gib-live.netlify.app/m1/admin/).
- Richmond: [https://6a9f4818343c6eb16fd0d45f--gib-richmond-test.netlify.app/m1/admin/](https://6a9f4818343c6eb16fd0d45f--gib-richmond-test.netlify.app/m1/admin/).

Both final immutable deployments were verified as `ready`, `context: deploy-preview`, and `published_at: null`. Revolution reports the exact source commit above. Richmond was created from an archive of that commit, built separately with matching `richmond/test` browser and server profiles; the deployed browser and changed server source fingerprints match the local artifact. The published Richmond TEST release remains `6a89d9b82eadf535cb568857`.

## Verified at this checkpoint

- Final automated suite: **783/783 passed**, no skips.
- HTML/inline-script validation: six HTML files checked; five inline scripts passed.
- Exact-final Revolution browser flow: a fake one-off class for today at `00:03` saved successfully despite its past start time. A separate kiosk received it, completed two fake instructor sign-ins with confirmed acknowledgments, and Daily Review displayed both. The website schedule remained present.
- Exact-final regression flows: a missed instructor sign-in saved 0.5 hours; a cached class worked offline; the waiting queue survived reload; recovery and replay safely returned `already exists`.
- Exact-final class history: an edit after a cancelled occurrence preserved the `1 October` cancellation. Legacy import preserved the original saved bytes, repeated import avoided duplicates, past `1 September` review remained available, and an expired class stayed out of today's kiosk.
- Read-only kiosk checks with the browser date simulated to five dates showed the class present on `29 September`, `6 October`, and `8 October`, absent on the cancelled `1 October`, and absent after expiry on `9 October`. These were simulated-date checks.
- The unchanged browser files retain the phone/laptop visual checks completed on `f1b385f`. Earlier real-browser Staff Clock checks on `42eabbe` saved missed in/out entries and read back an audited `4:00` to `4:05` adjustment; those Staff Clock paths remain unchanged.
- Richmond's new shared-class GET endpoint returned HTTP 200 with `target: test`, `gymId: richmond`, version 0, and empty series/history. This was a read-only check; no Richmond class data was written.

- Exact-final cancellation: cancelling the remaining dates removed the kiosk choice; a fresh Daily Review response retained all four synthetic teaching records byte-for-byte, including their identities and hours. No page JavaScript errors occurred during the final Revolution flows.

Detailed sanitized results are retained in [m1-elegant-qa.json](m1-elegant-qa.json). Earlier draft checks are labeled with their own revisions. The immutable links above remain the review artifacts even if a later documentation-only commit creates another automatic draft.

### Remaining limitations

Payroll/export behavior is covered by automated contract tests. The browser export/PIN flow was not exercised. Richmond Admin end-to-end testing remains blocked as described below.

## Richmond blocker

Richmond TEST Admin login returns HTTP 503: `Admin service is not configured for this environment.` The existing TEST webhook and Admin action credential variables are scoped only to Netlify's `production` context, so an unpublished preview does not receive them. Installation/environment settings already cover all contexts; changing those nonsecret build settings alone cannot resolve the login failure.

Only variable names, scopes, and context labels were inspected. No credential values were accessed or exposed, and no settings were changed. Richmond's Admin save and reload flows remain blocked until its TEST preview configuration is addressed through an approved path. The existing published TEST release's successful login does not establish preview readiness.

Proposed continuation, **not yet approved**: publish the frozen candidate only to the existing `gib-richmond-test` site, which already has working TEST credentials, then complete Richmond's browser flows. This would change the published TEST site only. Neither gym's production site or production data would be part of that action.

## Release and rollback considerations

- Shared added-class reads and writes are restricted by the deployed TEST profile, permitted TEST host/site, deployment context, and request checks. Writes also require the existing TEST Admin session. Revolution requires an unpublished preview or branch deployment; Richmond is restricted to its separate TEST site/profile. No production shared-class write path was added.
- The separately uploaded Richmond delivery/connection hotfix was recovered and preserved before this candidate. Its provenance is recorded in [m1-elegant-baseline.md](m1-elegant-baseline.md).
- Main, the production sites, production receivers, business records, and production settings remain unchanged. No merge or production promotion has occurred. A production release requires separate authorization after the remaining QA and configuration decisions are complete.
- The final read-only deployment check confirmed the production IDs remain Revolution `6a95d82e6ea2ad000986b4ea` and Richmond `6a9c7a2fec9f71d5ff660a57`.
- No live-system rollback is needed. To pause review, stop using these isolated previews. Fake shared TEST classes persist across previews and can be cancelled through the TEST manager while retaining their history; no production record restoration is involved.
