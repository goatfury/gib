# M1 Elegant Admin and Temporary Classes — release handoff

Status: **PARTIAL RELEASE — Richmond is live and verified; Revolution is held.** Final shared-class, browser-upgrade and export/PIN checks passed. A new c91 Revolution Staff correction returned an unreadable confirmation, and its saved outcome cannot yet be verified. PR #83 remains draft and unmerged. Exact application source: `c91ab68b838259eccb6bb37b3d23c5dfbfab0908`.

## Scope and operator entry

- Richmond Admin: [https://gib-richmond-live.netlify.app/m1/admin/](https://gib-richmond-live.netlify.app/m1/admin/).
- Revolution Admin (prior live release, unchanged): [https://gib-live.netlify.app/m1/admin/](https://gib-live.netlify.app/m1/admin/).
- Separate Richmond TEST: [https://gib-richmond-test.netlify.app/m1/admin/](https://gib-richmond-test.netlify.app/m1/admin/).
- Review branch: `feature/m1-elegant-admin-classes-20260907`; PR [https://github.com/goatfury/gib/pull/83](https://github.com/goatfury/gib/pull/83).

The new workspace is published at Richmond; Revolution still runs its previous release. In the candidate, Daily Review is the main workspace, with What needs attention, Fix a record and Add a class. A one-off defaults to one date. A limited series shows its weekdays, inclusive range and exact dates before saving. Shared classes reach that gym's online kiosks alongside the regular website timetable; scheduling alone creates no teaching or payroll records. Existing local classes remain intact and require an explicit import to share them. Two instructors retain separate records and permanent IDs. No compensation rule or unrelated feature was added.

Andrew first authorized the existing Richmond TEST publication and then explicitly authorized a safe live rollout. The original TEST source was corrected to 75c10e2 after hosted testing. Release source c91ab68 adds the required production boundary, retains exact legacy class labels for duration matching, and updates the offline shell version. It preserves the prior login-initialization, Staff correction-form and multiline Notes fixes.

## Release safeguards and unchanged behavior

The shared-class service opens production storage only for the exact gym site identity, canonical HTTPS origin and currently published production deployment. It uses existing production Admin authentication and page tokens. Richmond also requires its already-active production profile and existing write flag. TEST credentials were not copied or broadened. Unknown origins, other gyms and TEST-signed sessions cannot select production class storage.

Added classes use a separate production store and gym-specific keys. No TEST classes, attendance or history are migrated into production. Class writes do not call the existing Google attendance/payroll receivers. Existing receiver settings, secrets, duration rules, IDs, local storage prefixes and physical tablets remain untouched. Richmond's recovered delivery/connection hotfix is retained; provenance remains in [m1-elegant-baseline.md](m1-elegant-baseline.md). Richmond Staff Clock stays disabled; Revolution retains it.

Both production artifacts were archived from the exact c91ab68 revision: all 141 non-generated source files matched the frozen archive. Each gym's generated browser/server profiles matched its retained live profile byte for byte. The full local suite passed 816/816, with zero failures or skips. Required GitHub and Netlify checks also passed for that application source. Manual Windows artifacts use CRLF line endings; deployment verification checks exact artifact bytes and separately compares normalized source against Git. Linux builds may use LF without changing the application source.

## TEST verification on the release source

The detailed receipts and earlier full scenario coverage are preserved in [m1-elegant-qa.json](m1-elegant-qa.json), with 75c10e2 explicitly treated as a prior TEST checkpoint.

Final c91ab68 hosted TEST checks used independent real Admin and kiosk sessions at both gyms. Create, update, cancel, central readback, separate kiosk delivery (normal reloads on Revolution; unforced polling on Richmond), legacy import, exact internal spaces, duplicate prevention and immutable history passed. Actual Daily Review record IDs/counts and correction audit remained unchanged after scheduling. Richmond Staff Clock stayed hidden. Desktop and 390px phone layouts were visually inspected; no page JavaScript errors occurred.

Same-origin browser upgrades from the prior shell to c91ab68 passed on both TEST hosts. Existing local classes, duration rules, PIN protections, ledger fields and permanent IDs survived. A synthetic queued row per gym recovered through the real TEST receiver and each queue reached zero. A second offline reload served the new shell with the local choices intact. Fresh disposable browser contexts were used; no operator browser storage or physical tablet was changed.

Earlier actual hosted checks covered one-offs and inclusive limited series; two synthetic instructors; forgotten-instructor and Notes corrections; expiry and cancellation with history; offline delivery and duplicate-safe retries; gym isolation; and Revolution Staff Clock correction with original times and permanent audit retained. Both gyms' actual PIN flows and exported CSV contents passed, including all seven columns, quotes, commas and multiline Notes. Those earlier scenario checks remain clearly labeled 75c10e2 evidence. c91ab68 additionally passed fresh actual PIN setup/mismatch/logout/wrong/right flows and full CSV downloads at both gyms, with every seven-column field verified, including quoted multiline Notes and exact duration values. Export preserved ledger, queue and permanent IDs. Richmond received its two real TEST acknowledgments. Revolution missed readable acknowledgments, but actual subsequent Daily Review confirmed both exact original row IDs; no rows were recreated and a later kiosk queue drain is not claimed. The native operating-system Save path was not exercised.

Timing observations are retained honestly: one Richmond update was not observed within the first 45 seconds; subsequent unforced update, cancellation and import reached the same kiosk through successful roughly 30-second polling. One Revolution Daily Review request returned 504 and the next real read succeeded. The upgrade queue also recovered a lost confirmation through an already-exists response without creating another row. No sustained delivery or data-loss defect reproduced. The UI continues to distinguish saved centrally from delivery to a particular tablet.

## Production verification checkpoints

Richmond published deployment `6aa05f7230bf02ecf3cfb48a` at 2026-09-08T19:18:45.508Z passed independent production checks: nine source/artifact comparisons, production/richmond namespace with no TEST data, unauthenticated empty POST denied 401, current website timetable, production login-page controls, disabled Staff Clock, and desktop/phone visual sanity with no page exceptions. Revolution was not published. Final read-only site checks at 2026-09-08T19:44:25Z confirmed Richmond current `6aa05f7230bf02ecf3cfb48a`, Revolution unchanged `6a95d82e6ea2ad000986b4ea`, Richmond TEST current `6aa05bdc7037af9db8c3c846`, and all original rollback deployments retained and ready. These are the verified rollout checkpoints. Documentation-only branch pushes may create newer TEST previews; no main build or Revolution production publication is authorized by a green automated check alone while the Staff hold remains.

## Revolution release hold — resolve before merge or publication

The final c91 Staff test first encountered stale-view and timeout responses. A later actual Admin session loaded the retained QA Test Staff shift on August 26, verified its original punch IDs/timestamps, and reviewed a change from 02:15–03:15 to 02:20–03:05 (0.75 hours). Exactly one Confirm adjustment was submitted. The service returned 502 `STAFF_TIME_ADJUST_HTML`, meaning there was no complete readable confirmation. This is an unknown outcome, not proof that nothing saved.

Subsequent read-only attempts could not confirm the saved shift or audit. One waited for unrelated panels that timed out; the final targeted reroute removed that dependency but its initial Staff review itself returned 502. No adjustment was resubmitted, and no credential, app state or safety check was bypassed. The code path is unchanged from the earlier 75c10e2 success, so a new code regression has not been established; that historical success does not replace this final-source check.

Next safe route: once the TEST Staff service responds, use its actual **Find a shift** control for **QA Test Staff**, **2026-08-26**. First inspect source IDs `gib-m1-staff-170c31b2-b72c-4eff-9822-801c53d7a5c1` and `gib-m1-staff-4f72d022-b374-4a28-bdab-95f6aaffbadf`, effective times and permanent audit for reason `QA TEST Release c91 Staff adjusted synthetic 45-minute interval; DO NOT PAY`. Original timestamps must remain 02:11 and 03:17. Resolve that attempt before any retry. Complete the final-source correction and durable readback before publishing Revolution or merging PR #83. The existing September 8 authorization continues to cover this same safe rollout once the hold is resolved; do not request duplicate approval or ask Andrew to act as the first tester.

The exact Revolution c91 artifact remains held at `work/gib-rev-production-c91ab68`; its source and both generated profiles were verified before the hold. Richmond has no enabled Staff Clock and its own requested flows and live checks passed, so its verified release remains published. No release rollback was performed.

## Limits and operational follow-through

Production smoke checks use public reads, visible login/kiosk controls and an unauthenticated empty request that must be denied. They do not create fake business records or claim a successful authenticated production transaction. End-to-end mutations were exercised against real TEST backends; injected boundary tests are labeled separately.

No physical tablets or native operating-system Save dialog were exercised. The actual browser download fallback and full exported contents passed in a secure cross-origin frame where the browser denies native file picking; no app/API shims or relaxed headers were used. Existing tablets receive the updated shell on a normal online reload; an already-open offline page can retain its current shell until then. There is no forced tablet refresh or storage reset in this release. A normal operator session on the actual device remains the operational follow-through; it is not a substitute for the completed browser QA. No email or message was sent to Stu.

## Retained rollback points

- Richmond live: site `9b7757a9-70f4-4977-9ca2-270b41e34007`, original deployment `6a9c7a2fec9f71d5ff660a57`.
- Revolution live: site `f748e737-11e3-4fab-8e8c-bf185eab29ff`, original deployment `6a95d82e6ea2ad000986b4ea`.
- Richmond TEST: site `42736c77-e3c8-40aa-ba97-4f935d0999ad`, original deployment `6a89d9b82eadf535cb568857`.

To undo Richmond's code release, publish its retained original deployment on gib-richmond-live and verify the canonical kiosk/Admin pages. This does not erase class history or attendance. It removes the new shared-class UI/service from that deployment, while leaving new shared data retained for recovery. Revolution automatically publishes main builds, so any rollback must also be coordinated with subsequent main releases; this task does not change that setting. Richmond is an existing manual-upload site and must be deployed separately from a GitHub merge.
