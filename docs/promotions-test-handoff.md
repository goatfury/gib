# Promotions TEST handoff

Status: **INTEGRATED INSTRUCTOR TEST READY FOR REVIEW — all technical, hosted workflow, visual, and independent native workbook checks passed.** Andrew's confirmation that the integrated interface is visible remains pending. The current evidence below belongs to the integrated kiosk. Earlier Google-owner reference results are retained separately as historical evidence.

Current nonproduction kiosk: https://deploy-preview-85--gib-live.netlify.app/m1/

Work remains on `prototype/promotions-log-test-20260913`. Promotions PR #85 remains draft, unmerged, separate, and TEST only. The kiosk hotfix in PR #84 was separately authorized, merged, and published at both gyms; preserve those released kiosks. No production promotions release, live migration, live workbook change, or additional sharing is authorized.

## Current instructor workflow and trust model

The requested model follows the paper promotion book: a trusted instructor uses an authorized gym tablet to look up a student or record a promotion they have awarded. The instructor selects their name as attribution. There is no individual Google login, instructor password, digital-signature claim, or separate approval step for each promotion. This trust model is the chosen direction; it is not an undecided entry policy.

The candidate integrates **Belt & Stripe Log** beside **Sign-In** in the Revolution TEST kiosk. Tablet authorization is required before lookup or recording. The selected instructor is distinct from the technical identity reaching Google Sheets: the backend operates under the dedicated Ops owner, while integrated history records authorized-device provenance. The retained `approver_id` and `approver_label` fields carry selected-instructor attribution for compatibility; they do not introduce an approval workflow. The pilot currently offers fictional TEST instructors, not a verified production roster.

The flow finds a student, shows recorded rank and history, previews one stripe/degree or a belt change, and records the New York date, before/after rank, selected instructor, recorder provenance, and permanent event/request identities. Missing students use explicit registration; unknown ranks use individual current-rank confirmation; identical names retain distinguishing labels. Corrections append an audit entry and preserve the original. An unclear record does not require a whole-book history audit before other students can be handled.

Lookup and form details clear after **60 seconds without activity**. A confirmed save returns to Sign-In after **3 seconds**; later touches do not extend that success display. Clear/Back returns immediately. An uncertain save retains its exact pending request separately for Check save or Retry this entry. Clearing the visible lookup must not discard that unresolved transaction, create a new request, or allow a late response to reopen private details. Suspended timers are checked when the page resumes.

## Candidate implementation and workbook views

The integration spans `m1/index.html`, the `m1/promotions-*` client/template/style/lifecycle files, TEST configuration/setup, the promotions server route/runtime, and the signed tablet entry path in `promotions/Code.gs`. The older `promotions/Index.html` owner page remains reference material. The final application revision, **`2e1947641cb9440235b1f33d44b92fe483606ad5`**, is pushed, deployed, and artifact-verified. It includes the registration/current-rank preview guidance fix discovered during actual hosted QA. Do not label the earlier `42ea4ae` integrated checkpoint or `9c73042` owner reference as the final application, or their historical test counts as the final complete-suite pass.

Lookup and writes use the configured Revolution TEST server route. The candidate validates the authorized tablet, exact TEST installation/origin, and signed server-to-Google request. Every tablet write, including registration, requires a selected TEST instructor. An endpoint URL or instructor selection alone must not grant access. Connection values and credentials stay in private configuration, outside public source, screenshots, and handoff evidence.

`Promotion History` remains the rank authority. `Students` is its current derived view, updated on confirmed writes or reconciliation; workbook views must not silently disagree. Shared save locking, exact request fingerprints, and expected revisions protect retries and concurrent entries. Unknown confirmations, duplicate identities, zero stripes, degrees, and corrections retain their earlier behavior.

Current TEST work preserves all six legacy tabs as source history. The proposed production mapping distinguishes those source blocks from current Students; it is not a permanent live-view policy already applied. Live labels, formulas, migration, or tab changes need later explicit release approval. The pure preparation utility and synthetic tests in `docs/promotions-legacy-mapping.md` preserve native values, dates, notes, unknowns, and references. They perform no migration or workbook writes and do not yet make every earlier source award a complete imported event history.

## Approved TEST deployment and current integrated evidence

Andrew's explicit “sure” approved the bounded Google TEST deployment-access change. **Version 3 is deployed**, executing as the existing dedicated Ops owner with access set to Anyone and application-level signed authorization enforced for the tablet route. This enables server requests without an interactive Google login; the URL alone does not authorize lookup or recording. No new OAuth grant, workbook sharing, account substitution, or project was created.

Earlier OAuth consent remains complete for the dedicated Ops project: primary-email access plus see/edit/create/delete access to Sheets accessible to that account, including live operational spreadsheets. Do not request identical OAuth consent again. That consent and the approved TEST deployment do not authorize production release or live operational edits. Preserve the superseded wrong-account project and existing sessions.

The Revolution TEST Netlify configuration now contains the nine required private keys scoped to TEST functions. The final integrated kiosk is deployed and verified at the public nonproduction URL. Private configuration values, Google identifiers, and backend URLs remain outside this document and public artifacts.

Verified current results:

- **`npm test`: 948 passed, zero failures, zero skipped**, on the final application source. This includes the retained kiosk checks and integrated promotion lifecycle, mounted-client, authorization, transport, and history regressions.
- At the first integrated native checkpoint, hosted kiosk controls had recorded **four integrated events**: a stripe, its audited correction, a black-belt degree, and a belt transition. Native workbook verification showed **9 Students and 24 History events**. Two authorized-device recorder identities remained separate from the fictional selected instructors. A duplicate click created only one event. The completed final checkpoint below includes the later hosted actions.
- During the degree save, an actual page reload returned to clean Sign-In while preserving the unresolved request. **Check save reconciled the original event once.** A later pending belt request also reconciled once through Check save. Intermittent Google transport timeouts left an unconfirmed intent; the interface did not falsely report Not saved.
- The prior **20 History events and all six legacy tabs remained exact** at the native checkpoint. The four new events and current Students view were checked against the expected ranks and audit fields.
- The final deployment matched **68 of 68 artifact hashes**. All **22 excluded private/source paths returned 404**. Both live kiosks' **56 checked assets and deployment identities remained unchanged** during this TEST integration.
- Actual concurrent-browser QA saved TEST Ellis from Brown Belt two to three stripes with Avery selected in Edge. Another browser's older Brown Belt two-stripe draft, with Blake selected, was rejected as changed in another session. Refresh showed Brown Belt three stripes.
- Both labeled TEST Jordan candidates were visible. The Morning student's White Belt one-to-two stripe save succeeded with Avery selected; a fresh Evening lookup still showed White Belt three stripes, unchanged.
- Explicit registration created **TEST Integration Unknown / Integrated fixture** with Blake selected and an unknown rank. On the final artifact, verified-baseline confirmation saved White Belt zero stripes with Blake selected. A fresh browser document read White Belt zero and **Date not recorded** for the latest promotion; expanded history showed both registration and rank confirmation with Blake and **Authorized TEST tablet**. The baseline confirmation did not invent a promotion award or date. Registration guidance explains the separate student identity, and current-rank guidance distinguishes a verified baseline from a new award.
- An actual unknown-student lookup was cleared before its response arrived. After more than 30 seconds, the page still showed clean Sign-In with no old student details restored.
- Final hosted viewport screenshots were inspected at **390 × 844, 820 × 1180, 1180 × 820, and 1440 × 900**. Page content fit the viewport at each size (`clientWidth` equaled `scrollWidth`); normal viewport images confirmed the interface was clear. A full-page screenshot stitching artifact was distinguished from the actual page. The final fresh document had **no console errors or warnings**, and Arrow Down then Enter selected a search result.
- Actual hosted typing at approximately 33 seconds renewed lookup activity. The query remained visible at approximately 72 seconds from the start, about 38 seconds after typing, then returned to clean Sign-In when checked about 70 seconds after typing. The **3-second confirmed-save return** was also observed in the hosted UI. These are actual elapsed-time observations in addition to the exact-deadline automated tests.
- Actual hosted navigation respected an active Sign-In draft. The promotion checks created no Sign-In or payroll records. Earlier mocked browser checks supplement these final hosted results.
- **Independent final native verification passed: 10 Students and 28 History events**, including eight integrated entries recorded by two authorized-device identities with separate selected-instructor attribution. All prior 24 events and all six legacy tabs retained exact native content. Ellis was Brown Belt three stripes, Jordan Morning White Belt two, Jordan Evening White Belt three, and the newly registered unknown student was confirmed at White Belt zero. Every Students view matched authoritative History; correction links, unique event/request identities, and New York dates passed verification. Native Students/History visual checks passed, and the original legacy visual evidence remained valid with exact native preservation. The TEST workbook remained private and solely Ops-owned.

## Review delivery and later release boundary

All technical acceptance checks are complete for this TEST review: final hosted workflow, copy, privacy, visual, console, deployment, and independent native workbook verification passed. The authorized preview opens at **https://deploy-preview-85--gib-live.netlify.app/m1/** with clean Sign-In and the neighboring Belt & Stripe Log entry.

No physical tablet, physical sleep/resume cycle, or hardware/OS keyboard was tested. Automated suspended-page checks and browser viewport/keyboard checks do not replace those physical checks. The permanent release gate in `docs/m1-release-checklist.md` remains in force for a later production release; these physical release checks do not block review of the isolated TEST preview.

The final authorized preview was opened visibly in the in-app browser, showing clean Sign-In with the neighboring log entry. Andrew has been asked to confirm that the new integrated interface is visible; **his visibility confirmation remains pending**. The older owner-page visibility confirmation below does not satisfy that step.

## Historical evidence: Google-owner reference only

These results belong to the previous owner-authenticated reference workflow. They do not prove new tablet authorization, instructor entry, inactivity behavior, server connection, or hosted kiosk integration.

- Earlier complete automated run: **848 passed, zero failures/skips**, including **32 promotions tests** and the retained M1 baseline. A later lock-timeout literal correction passed the same 32 promotions tests. Reference revision `9c73042f944dd9b4e6207c837d95ed7d53ddd1a8` passed **34 promotions tests**, including native-literal and uncertain-save regressions. The older complete-suite result is not a run on the current integrated candidate.
- Actual Chromium with simulated `google.script.run`: **16 reference-source workflow groups passed**, including duplicates, missing/unknown students, failure recovery, late replies, and callback ordering. Phone 390px, tablet 820px, and laptop 1440px layouts were inspected; suggestions were bounded and controls at least 48px. The approximately 30-second request timeout was exercised. These were simulated Google transport checks.
- Native baseline visual sanity passed across the private workbook's eight tabs, initially containing **8 baseline student/history records** and **6 preserved legacy tabs**, including duplicates, unknown rank, blanks, `?`, `Transplant`, and `Early 2014`. Subsequent native Students/History inspection showed nine students and twelve added events with expected dates, ranks, and references.
- Actual version-2 reference-app layout checks passed at 1440px, 820px, and 390px. Fresh documents showed the corrected rank and unknown-registration/zero-stripe case with history intact. Console errors were empty. These were hosted owner-page checks, not integrated kiosk checks.
- The real owner session's recorded identity was independently verified as the dedicated Ops account. A fresh anonymous request redirected to Google login without reference-app data. Nonowner/blank-identity guards had automated coverage; a signed-in wrong-account browser test was not performed. The old anonymous redirect is not the acceptance criterion for the authorized-tablet route.

Private evidence includes `work/promotions-final-tests.log`, `work/promotions-ui-qa/report.json`, the private fixture baseline, repair and recovery records, and `work/promotions-fixture/integrated-final-native-verification-private.json`. Exact accounts, workbook/project/deployment identifiers, backend URLs and hashes, and connection configuration stay outside the repository and public evidence.

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

Browser viewport checks are not a physical-device pass. The approved TEST integration is deployed and technically ready for review; Andrew's visibility confirmation is pending. PR #85 remains draft and unmerged. No production promotions release, live migration, additional sharing, or live operational edits are authorized. Preserve both released kiosks and the live promotion workbook.
