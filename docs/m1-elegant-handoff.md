# M1 Elegant Admin and Temporary Classes — TEST handoff

Status: **TEST-ready for usability review; not production-ready.** The authorized Richmond hosted tests and final-candidate browser gaps are closed. No merge or production release occurred.

## Exact source and review target

- Final tested source: `75c10e2eface27cbe044e319ae4c91addd01a092`.
- Branch: `feature/m1-elegant-admin-classes-20260907`, pushed for isolated review.
- Draft PR: [https://github.com/goatfury/gib/pull/83](https://github.com/goatfury/gib/pull/83).
- Primary working review: [https://gib-richmond-test.netlify.app/m1/admin/](https://gib-richmond-test.netlify.app/m1/admin/).
- Immutable Richmond: [https://6a9f67af1d87dea4f042ecf5--gib-richmond-test.netlify.app/m1/admin/](https://6a9f67af1d87dea4f042ecf5--gib-richmond-test.netlify.app/m1/admin/).
- Immutable Revolution: [https://6a9f670c5231ee000863f6f7--gib-live.netlify.app/m1/admin/](https://6a9f670c5231ee000863f6f7--gib-live.netlify.app/m1/admin/).

Use the existing TEST Admin entry with Andrew Smith or Stuart Turner. No private production secret is required. Later documentation-only branch commits do not replace these exact tested artifacts.

Andrew explicitly authorized publishing the candidate and in-scope fixes to the **existing Richmond TEST site only**. The original c34cf62 candidate was published first; actual hosted checks then found three defects, all fixed in the final source above. No credential values were exposed, copied into evidence or broadened in scope.

## What changed for Stu

Daily Review is the main workspace, with What needs attention, Fix a record and Add a class. A one-off defaults to one date; choosing a limited series reveals weekdays and an inclusive range, with the exact dates shown before saving. The existing temporary-class date model is reused. Changes persist centrally for that gym and reach separate kiosks alongside the regular website timetable. Device maintenance and local-only recovery remain secondary.

The final hosted fixes prevent early login from racing initialization, keep older Staff Clock correction forms open while editing, and let plain multiline Notes sync without relaxing formula, length or other control-character safeguards. No payroll split, compensation rule or unrelated feature was added.

## Completed verification

- Full final automated suite: **791/791 passed**, zero failures or skips, including inline-script checks. New regression tests failed before their fixes and passed afterward.
- Richmond identity: verified site `42736c77-e3c8-40aa-ba97-4f935d0999ad`, generated `richmond/test` browser and server profiles, actual `test/richmond` class responses and `test:true` login. The existing TEST receiver destination hash stayed unchanged. The site uses Netlify's published context for its existing TEST credentials; it is still a separate TEST application.
- Exact final Richmond artifact: seven relevant served files on stable and immutable hosts matched the archived source/build fingerprints. Revolution's immutable deployment reports the exact final commit and remains an unpublished deploy preview.
- Richmond real hosted flow, independent Admin and kiosk sessions: a same-day late one-off saved from the phone layout, survived reload and reached the already-open kiosk by polling. A Tuesday/Thursday series previewed exactly September 29, October 1, October 6 and October 8; invalid reversed dates were rejected. Creating classes created no attendance.
- Two synthetic instructors signed into the same Richmond class with separate permanent IDs and real backend acknowledgments. A forgotten instructor correction saved and read back 0.5 hours. Multiline quoted Notes survived real sync and review.
- Offline Richmond kiosk: cached choices and queued sign-in survived reload; a newly saved central class stayed absent until reconnection. Recovery received the new choice and acknowledgment. Replaying the exact confirmed row returned already exists.
- Canceling October 1 then correcting the future series kept the cancellation and prior revisions. Explicit local-only import preserved the original bytes, suppressed duplicate classes and remained idempotent. An expired September 1 occurrence remained available in Daily Review, where a real missing-instructor correction saved and read back 0.5 hours.
- Canceling the remaining one-off dates removed its kiosk choice while all four existing teaching records stayed byte-for-byte identical, including IDs and hours. They remained visibly accessible under History and audit.
- Gym separation: live TEST reads returned only the appropriate gym's class namespace; Revolution's actual Daily Review contained none of the Richmond synthetic instructor prefix. Richmond Staff Clock stayed hidden/disabled in kiosk and Admin.
- Final Revolution Staff correction: actual Find a shift → Adjust → Review → Confirm changed the retained synthetic shift from 02:11–03:17 (1.1 hours) to 02:15–03:15 (1 hour). Fresh backend lookup preserved source IDs and original timestamps; the permanent audit contained both originals and corrections. Immediate login waited for initialization and remained active.
- Both profiles' actual PIN setup, mismatch prevention, logout, wrong-PIN denial and correct-PIN entry passed. Real Export clicks downloaded CSVs whose **complete seven-column contents** matched the source rows, including commas, quotes and multiline Notes. Ledger, queue and permanent IDs were unchanged. Revolution covered 1 and 0.5 hours; Richmond used existing 1-hour rules.
- Supplemental actual-hosted calendar checks used browser date emulation with real GET responses: correct series present September 29/October 6/October 8, absent canceledOctober 1 and expiredOctober 9. Twelve New York midnight/daylight-saving boundary checks passed. These are simulated-date checks, not claims of actual future use.
- Phone 390×844, desktop 1440×1000, tablet portrait 768×1024 and landscape 1024×768 layouts were visually inspected. Controls were reachable, no horizontal overflow or obstructed controls were found, and the final flows produced no page JavaScript errors.

Detailed sanitized receipts, synthetic record identities, before/after audits, deployment fingerprints, parsed verification and the actual downloaded CSV contents are preserved in [m1-elegant-qa.json](m1-elegant-qa.json). Earlier evidence is explicitly labeled as a prior checkpoint. Working screenshots and raw test receipts remain under the task's work directory.

## Genuine limitations and remaining release work

The browser export test exercised the unchanged hosted kiosk in a secure cross-origin frame, where the browser genuinely denies native file picking and the existing download fallback runs. There were no app/API shims, mocked responses or weakened headers. The standalone operating-system Save dialog was not exercised. A proposed Richmond QA duration-rule change was rejected before execution; the successful export test used existing rules instead. No Richmond setting changed.

No physical tablets were touched. Phone/tablet sizes and future dates were browser emulation. Before a separately authorized live release, review the native Save path and the real target devices, agree on the production added-class storage/write route and rollout/rollback plan, recheck the latest live baseline, and obtain explicit merge/deployment approval. The shared-class endpoint deliberately has no production write path today. Do not simply promote this TEST artifact or broaden TEST credentials into production.

The recovered Richmond delivery/connection hotfix remains preserved; provenance is in [m1-elegant-baseline.md](m1-elegant-baseline.md). No real business records, September 5 payment issue, payroll calculations, production receivers/settings or protected branches were changed. Synthetic TEST examples and history remain intentionally retained.

## Live status and TEST rollback

Final read-only check at 2026-09-08 01:52:24 UTC also confirmed remote main remains `3b85fe4a6a93695d2dea95a1b5e41354e24f9ac6`; PR #83 is open, draft and unmerged.

- Revolution production remains `6a95d82e6ea2ad000986b4ea`.
- Richmond production remains `6a9c7a2fec9f71d5ff660a57`.
- Richmond TEST is published as `6a9f67af1d87dea4f042ecf5` only under the user's TEST authorization.
- Original Richmond TEST rollback retained: `6a89d9b82eadf535cb568857`; interim c34cf62 deployment also retained: `6a9f6361e51d8ab53db794f6`.
- If TEST rollback is requested, republish the retained original deployment on **gib-richmond-test only**. This restores TEST code and leaves shared TEST records/history intact. Neither live gym needs rollback.

Next owner decision: whether this single workspace makes routine administration straightforward enough for Stu. That usability decision does not authorize production release.
