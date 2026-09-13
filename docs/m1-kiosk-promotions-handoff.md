# Kiosk privacy hotfix and promotions TEST continuation

TEST only. No merge or live release is authorized by this handoff.

## Independently releasable kiosk change

- Baseline main: `93dba9ec39903793ba1acbd8fc9196f0bed15bdd` (PR #83).
- Frozen application: `2bda629f872c70a957dcd4b67e658cc6de22f4df`.
- Permanent test/checklist revision: `b70ae7dccdd02fa503aa68976846bd830b4cd2d3`.
- Branch: `hotfix/m1-kiosk-walk-away-20260913`; draft PR [https://github.com/goatfury/gib/pull/84](https://github.com/goatfury/gib/pull/84).
- Revolution candidate: [https://6aa69c52a5e6850008327824--gib-live.netlify.app/m1/](https://6aa69c52a5e6850008327824--gib-live.netlify.app/m1/), automatic PR build of `b70ae7dc` with unchanged `2bda629f` application source.
- Richmond candidate: [https://6aa69c2931deb2da3772f393--gib-richmond-test.netlify.app/m1/](https://6aa69c2931deb2da3772f393--gib-richmond-test.netlify.app/m1/), `2bda629f` plus the generated Richmond TEST profile.

The original confirmation starts the deadline: five seconds for Staff Clock, fifteen seconds for Instructor Sign-In. Done remains available; Undo retains its existing unsent-record protection. Expiry removes completed personal form/confirmation fields, including hidden text, without deleting records, queues, configuration, or another active interaction. Late acknowledgments update delivery only while their own confirmation remains current. Resume, focus, visibility, and back-navigation check absolute deadlines. Local-save failures retain input. Pending delivery has a nonpersonal count. No blanket inactivity reset was added.

The complete automated suite passed **842 tests**, including 26 new next-person regressions. Independent application-source review found no actionable issues. GitHub's required check passed. The reusable gate is [m1-release-checklist.md](m1-release-checklist.md), with a configurable hosted runner at [test-m1-kiosk-next-person.cjs](../tools/test-m1-kiosk-next-person.cjs). The kiosk is separately release-ready; no live release is authorized.

Actual browser Back testing caught native notes and class-checkbox restoration. The final candidate disables native restoration on the personal name/notes/selection fields and passes actual Back followed by the next person's transaction at both gyms. Admin choices are untouched.

## Hosted QA evidence, 2026-09-13

| Exact final artifact flow | Result |
| --- | --- |
| Revolution Instructor Back, next person, untouched confirmation | PASS; 15.021 seconds; two exact receiver IDs, two hours, real CSV download |
| Richmond Instructor Back, next person, untouched confirmation | PASS; 15.023 seconds; two exact IDs in independent private TEST-sheet read, two hours, real CSV download |
| Revolution Staff Clock in/out | PASS; 5.077/5.064 seconds; both exact receiver IDs/timestamps, one completed five-second TEST shift |

Earlier full browser runs on source `56889378` verified optional Done, Undo with no send during its window, active input, rapid next users, offline recovery, lost HTTP-200 acknowledgment/retry, delayed Staff acknowledgment, and browser suspension/resume. Staff's six completed shifts matched all twelve original timestamps and 53 seconds. The final source adds only class-checkbox native-restoration prevention plus build labels; its affected Back/next-person workflows and both Staff directions were then repeated on the exact final URLs. All interrupted-run synthetic IDs were independently reconciled, with Undo rows absent. Final queues are empty. No browser JavaScript errors occurred.

Phone, tablet, and laptop screenshots were visually reviewed; controls and long synthetic names fit and neutral screens contain no previous personal data. Browser touch/keyboard input and real elapsed timers were exercised. Suspension and device dimensions were browser emulation, not a physical-tablet hardware pass. CSV coverage used the actual browser download fallback; the optional OS save picker was not exercised. Richmond TEST Admin record reads returned 504, so persistence was verified independently through bounded, exact-ID private Sheets reads. This existing TEST read limitation is not reported as a passing Admin lookup.

Sanitized aggregate evidence is [m1-kiosk-privacy-qa.json](m1-kiosk-privacy-qa.json). Raw synthetic checkpoints/screenshots remain in the task's private work area; no private workbook identifiers or real records are published.

## TEST deployment evidence and boundaries

Only the isolated Richmond TEST site's published slot changed; Netlify calls its context `production`, but generated installation, accepted hosts, receiver, and data target are all Richmond **TEST**. Its previous TEST deployment was `6aa05bdc7037af9db8c3c846`. A TEST rollback, if necessary, restores that deployment on the Richmond TEST site only. No rollback has been performed.

The Richmond full build uses the existing lockfile's physical production dependencies and a public asset allowlist. All 28 served public files matched the frozen artifact; six excluded source/configuration paths returned 404. Both candidates passed TEST backend readiness. Earlier manual no-build artifacts had a storage/packaging failure and are excluded from review; they never qualified for transaction QA.

Revolution live remains `6aa06fd14a529800081626d8`; Richmond live remains `6aa05f7230bf02ecf3cfb48a`. Current main and the original released application are unchanged. Richmond Staff Clock remains disabled. Existing Richmond connection/delivery fixes are preserved. No credentials, production settings, physical devices, real attendance/payroll records, or live spreadsheet cells changed. No messages were sent on Andrew's behalf.

## Promotions boundary and inspected legacy mapping

The private live workbook was inspected through connected Google Sheets, read-only. Do not put its identifier, real names, or raw rows in this repository or preview assets. The six source tabs have different schemas: White Belt has an Instructor column before its stripe history; the other colored belts have rank labels and repeated historical stripe/belt blocks; Black Belt has an unlabeled column, separate Date/Rank awarded fields, and older history; Former student contains mixed sections and embedded headers. Preserve text, native date values, blanks, unknowns, annotations, and original cell coordinates before interpretation. Repeated name labels are not student identities.

Promotion implementation will remain separate from this hotfix and from payroll. The intended TEST flow uses a private synthetic workbook, stable student/event identities, one authoritative append-only history, server-enforced idempotency and stale-revision protection, explicit rank resolution, and audited corrections. Approver selection and authenticated recorder identity must remain distinct. No live migration or automated student moves are authorized.

Production permissions are undecided. Do not treat the existing name-only TEST Admin shortcut as proof of manager identity, and do not grant all instructors access. A protected TEST entry must use a verified manager identity and fictional approvers. Google connector read/write access alone does not prove application-backend integration. A new private Apps Script may need owner OAuth approval; no such permission has been approved or bypassed.
