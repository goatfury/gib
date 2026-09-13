# Promotions TEST handoff

Status: **INTEGRATED INSTRUCTOR TEST CANDIDATE — hosted integration QA and Google deployment-access approval are pending.** The earlier Google-owner reference app passed its own hosted checks and review delivery. Those results do not establish that the new instructor/tablet workflow is deployed, verified, or ready for review.

Work remains on `prototype/promotions-log-test-20260913`. Promotions PR #85 remains draft, unmerged, separate, and TEST only. The kiosk hotfix in PR #84 was separately authorized, merged, and published at both gyms; preserve those released kiosks. No production promotions release, live migration, live workbook change, or additional sharing is authorized.

## Current instructor workflow and trust model

The requested model follows the paper promotion book: a trusted instructor uses an authorized gym tablet to look up a student or record a promotion they have awarded. The instructor selects their name as attribution. There is no individual Google login, instructor password, digital-signature claim, or separate approval step for each promotion. This trust model is the chosen direction; it is not an undecided entry policy.

The candidate integrates **Belt & Stripe Log** beside **Sign-In** in the Revolution TEST kiosk. Tablet authorization is required before lookup or recording. The selected instructor is distinct from the technical identity reaching Google Sheets: the backend operates under the dedicated Ops owner, while integrated history records authorized-device provenance. The retained `approver_id` and `approver_label` fields carry selected-instructor attribution for compatibility; they do not introduce an approval workflow. The pilot currently offers fictional TEST instructors, not a verified production roster.

The flow finds a student, shows recorded rank and history, previews one stripe/degree or a belt change, and records the New York date, before/after rank, selected instructor, recorder provenance, and permanent event/request identities. Missing students use explicit registration; unknown ranks use individual current-rank confirmation; identical names retain distinguishing labels. Corrections append an audit entry and preserve the original. An unclear record does not require a whole-book history audit before other students can be handled.

Lookup and form details clear after **60 seconds without activity**. A confirmed save returns to Sign-In after **3 seconds**; later touches do not extend that success display. Clear/Back returns immediately. An uncertain save retains its exact pending request separately for Check save or Retry this entry. Clearing the visible lookup must not discard that unresolved transaction, create a new request, or allow a late response to reopen private details. Suspended timers are checked when the page resumes.

## Candidate implementation and workbook views

The integration spans `m1/index.html`, the `m1/promotions-*` client/template/style/lifecycle files, TEST configuration/setup, the promotions server route/runtime, and the signed tablet entry path in `promotions/Code.gs`. The older `promotions/Index.html` owner page remains reference material. The current integrated candidate has passed its local automated and supplemental browser checks; hosted integration remains pending. Do not label the older `9c73042` reference revision as current integrated source or its historical test counts as a current complete-suite pass.

Lookup and writes use the configured Revolution TEST server route. The candidate validates the authorized tablet, exact TEST installation/origin, and signed server-to-Google request. Every tablet write, including registration, requires a selected TEST instructor. An endpoint URL or instructor selection alone must not grant access. Connection values and credentials stay in private configuration, outside public source, screenshots, and handoff evidence.

`Promotion History` remains the rank authority. `Students` is its current derived view, updated on confirmed writes or reconciliation; workbook views must not silently disagree. Shared save locking, exact request fingerprints, and expected revisions protect retries and concurrent entries. Unknown confirmations, duplicate identities, zero stripes, degrees, and corrections retain their earlier behavior.

Current TEST work preserves all six legacy tabs as source history. The proposed production mapping distinguishes those source blocks from current Students; it is not a permanent live-view policy already applied. Live labels, formulas, migration, or tab changes need later explicit release approval. The pure preparation utility and synthetic tests in `docs/promotions-legacy-mapping.md` preserve native values, dates, notes, unknowns, and references. They perform no migration or workbook writes and do not yet make every earlier source award a complete imported event history.

## Pending Google deployment access and integrated QA

The earlier reference deployment ran as the accessing Google user with access restricted to its owner. That configuration does not establish the requested no-Google-login tablet workflow. The integrated signed backend route needs the TEST deployment to execute as the dedicated Ops owner and accept server requests without interactive Google sign-in, while retaining application authorization checks. **Approval for this Google deployment-access change is pending.** Previous Sheets consent does not approve that change.

Earlier OAuth consent is already complete for the dedicated Ops project: primary-email access plus see/edit/create/delete access to Sheets accessible to that account, including live operational spreadsheets. Do not request identical OAuth consent again. It grants neither production release nor additional sharing and is separate from the pending deployment-access choice. Preserve the superseded wrong-account project and existing sessions; no new project or account substitution is required.

Current integrated-candidate evidence: **`npm test`: 946 passed, zero failures, zero skipped.** Root also inspected the current interface in actual Chromium at phone, tablet, and laptop sizes using a mocked API. These local browser checks are supplemental; they do not prove the hosted server connection, tablet authorization, or durable integrated writes.

The current `Code.gs` head source was staged and saved in Google, then compared exactly with the intended text in the editor. The existing `/exec` version-2 deployment remains unchanged. A new TEST deployment dialog is staged to execute as the dedicated Ops owner with access set to Anyone; **the final Deploy button has not been clicked and approval remains pending**. No integrated-candidate Netlify configuration or deployment, and no new workbook writes, have occurred.

After the approved TEST deployment/configuration is concrete, verify through the same hosted kiosk controls an instructor will use:

- Authorized-tablet lookup and entry without Google login, plus unauthorized lookup/write denial.
- Selected-instructor attribution separated from backend/device identity in native history readback.
- Stripe/degree, belt, missing/unknown student, duplicate-name, correction, stale-session, and same-request recovery flows.
- The 60-second inactivity clear, 3-second confirmed return, Back, suspended-page recovery, and late responses, without losing an uncertain request.
- Laptop, tablet, and phone layouts, console sanity, unchanged Sign-In behavior, current Students/history agreement, and unchanged legacy source cells.

Integrated hosted checks and delivery through a directly accessible nonproduction kiosk preview are **pending**. No integrated deployment or review-ready result is claimed here.

## Historical evidence: Google-owner reference only

These results belong to the previous owner-authenticated reference workflow. They do not prove new tablet authorization, instructor entry, inactivity behavior, server connection, or hosted kiosk integration.

- Earlier complete automated run: **848 passed, zero failures/skips**, including **32 promotions tests** and the retained M1 baseline. A later lock-timeout literal correction passed the same 32 promotions tests. Reference revision `9c73042f944dd9b4e6207c837d95ed7d53ddd1a8` passed **34 promotions tests**, including native-literal and uncertain-save regressions. The older complete-suite result is not a run on the current integrated candidate.
- Actual Chromium with simulated `google.script.run`: **16 reference-source workflow groups passed**, including duplicates, missing/unknown students, failure recovery, late replies, and callback ordering. Phone 390px, tablet 820px, and laptop 1440px layouts were inspected; suggestions were bounded and controls at least 48px. The approximately 30-second request timeout was exercised. These were simulated Google transport checks.
- Native baseline visual sanity passed across the private workbook's eight tabs, initially containing **8 baseline student/history records** and **6 preserved legacy tabs**, including duplicates, unknown rank, blanks, `?`, `Transplant`, and `Early 2014`. Subsequent native Students/History inspection showed nine students and twelve added events with expected dates, ranks, and references.
- Actual version-2 reference-app layout checks passed at 1440px, 820px, and 390px. Fresh documents showed the corrected rank and unknown-registration/zero-stripe case with history intact. Console errors were empty. These were hosted owner-page checks, not integrated kiosk checks.
- The real owner session's recorded identity was independently verified as the dedicated Ops account. A fresh anonymous request redirected to Google login without reference-app data. Nonowner/blank-identity guards had automated coverage; a signed-in wrong-account browser test was not performed. The old anonymous redirect is not the acceptance criterion for the authorized-tablet route.

Private evidence includes `work/promotions-final-tests.log`, `work/promotions-ui-qa/report.json`, and the private fixture baseline, repair, recovery, and final native-verification records. Exact accounts, workbook/project/deployment identifiers, URLs, backend hashes, and connection configuration stay outside the repository and public evidence.

## Historical save recovery and native checkpoint

The first owner-reference TEST Alex stripe appended once, but native Sheets consumed an initial apostrophe in its copied legacy reference. Strict readback failed and the old response incorrectly said Not saved. The fix preserved native literal escaping and classified post-append/readback failures as uncertain confirmation, without weakening historical validation. Only the damaged TEST `Promotion History!Y10` reference was restored through native string-value entry; the promotion identity, request, rank, and date were not replaced. Retrying the **same original UI request** recovered that event and rebuilt Students. This is real post-commit failure/retry evidence; an intentional network-drop test was not performed.

Completed owner-reference transactions:

- TEST Alex: one-to-two stripes, then an audited correction back to one, preserving both events.
- TEST Taylor: Black Belt five-to-six degrees without an ordinary stripe limit.
- TEST Rowan: Purple Belt four-to-five stripes, then Brown Belt zero, retaining earlier history.
- Duplicate-name TEST Jordan records: Morning White Belt zero-to-one; Evening White Belt two-to-three, as separate students.
- TEST Casey: unknown-rank confirmation to White Belt two stripes, then promotion to three.
- TEST Quinn: unknown-rank registration, rejected duplicate name/label registration, then White Belt zero confirmation.
- TEST Ellis: one-to-two saved; another tab's stale revision-one submission was rejected and Refresh showed two.
- TEST Morgan: archived record stayed read-only, with history available.

Independent native verification passed at **9 Students and 20 History events: 8 baseline plus 12 hosted events**. Final ranks, statuses, revisions, last-event references, and sequences matched. Student/event/request identities were unique; rejected duplicate/stale attempts and recovery created no extras. Correction link and reason matched. Every hosted reference entry had the verified Ops recorder, New York date `2026-09-13`, valid UTC timestamp/fingerprint, and separate fictional instructor attribution.

Original History rows retained native values, types, and formats. The repaired stripe and correction matched captured checkpoints. All six legacy grids, types, formulas, formats, properties, and original source references stayed unchanged. Students agreed with History. Original Students rank flags became text booleans under their imported format; authoritative history retained native booleans. That difference was documented. The workbook stayed solely Ops-owned, unshared, and on New York time. This is the retained pre-integration checkpoint, not proof of a new integrated write.

## Historical delivery and release boundary

Andrew confirmed the old owner's Add one stripe form was visible in Codex's right panel. An earlier external-browser error exposed no account identity, so its cause was not established. Delivery was verified in the Ops-signed-in Codex browser for the reference only. The new instructor review target must be the authorized TEST kiosk preview and must not depend on that Google owner session.

Browser viewport checks are not a physical-device pass. The historical reference workflow and current local checks are complete; integrated hosted checks, Google deployment-access approval, and instructor-facing delivery remain outstanding. This document neither grants those approvals nor claims the candidate deployed or ready. PR #85 remains draft and unmerged. No production promotions release, live migration, additional sharing, or live operational edits are authorized. Preserve both released kiosks and the live promotion workbook.
