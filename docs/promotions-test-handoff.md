# Promotions TEST handoff

Status: implementation and simulated integration checks pass; **the hosted Google workflow is not verified or ready for owner review**. The separately frozen kiosk hotfix in PR #84 was explicitly authorized and merged as `1f16dd6ac2e5a1c974b50a98d14f31dbc2453b31`; both gyms have published it, with final release verification recorded in PR #84. Promotions remains separate and TEST only.

Application: `f00bea9b2bf225bce311d2f6b680088f31452bd8` on `prototype/promotions-log-test-20260913`, based on main `93dba9e`. Core files are `promotions/Code.gs`, `promotions/Index.html`, and `promotions/appsscript.json`. No production deployment or live migration is authorized.

## Implemented

The protected TEST flow finds a student, previews one stripe/degree or a belt change, and records the promotion with its New York date, before/after rank, fictional approver, authenticated recorder, and permanent event/request identities. Missing students require explicit registration; unknown ranks require explicit confirmation; identical names retain separate identifying labels. Corrections append an audit entry and preserve the original.

`Promotion History` is the sole rank authority. `Students` is a derived view. A shared save lock, exact request fingerprints, and expected revisions prevent duplicate retries and stale concurrent awards. Lost responses retain the same request; recovery checks repair the derived view or report it pending. Late callbacks preserve another student's input and cannot restore a submitted draft or downgrade a confirmed rank.

The manifest specifies Google access `MYSELF` and execution `USER_ACCESSING`. Both the page and every callable data operation require nonblank active and effective Google identities matching the privately configured owner. This has automated coverage; real hosted enforcement remains unverified. Selecting an approver is explicitly not authentication or proof of approval. Production entry/approval policy remains an owner decision.

## Verified evidence

- Final automated run: **848 passed, zero failures/skips**, including **32 promotions tests**. This also covers the retained M1 baseline. Command: `npm test`. After that run, Google rejected a numeric separator in the server lock timeout; the equivalent literal was corrected, all 32 promotions tests passed again, and the actual Google editor accepted the saved backend. The interface is unchanged from the browser-tested revision.
- Actual Chromium with simulated `google.script.run`: **16 final-source workflow groups passed**, including duplicate submissions, missing/unknown students, failure recovery, late replies, and corrected callback ordering. Phone 390px, tablet 820px, and laptop 1440px layouts were visually inspected; suggestions stay bounded and controls are at least 48px. The unchanged request timeout was exercised for approximately 30 seconds. These checks do not prove Google authentication or durable backend writes.
- The separate private synthetic workbook contains **8 baseline student/history records** and **6 preserved legacy tabs**. Synthetic blanks, unknown dates, annotations, duplicate names, and black-belt degrees are retained. Local fixture renders and native data readback were checked. **Native workbook visual sanity has not been confirmed.** No actual promotion has yet been verified through the hosted application and an independent persisted readback.

Task-private evidence remains outside the repository: `work/promotions-final-tests.log`, `work/promotions-ui-qa/report.json`, and `work/promotions-fixture/native-verification.json`. Earlier failing checkpoints are superseded by the final evidence. Private connection configuration must remain outside source, screenshots, and public evidence.

## Blocker and continuation

The exact reviewed backend, interface, and owner-only manifest are saved in a new private Google Apps Script project. Its development entry point reaches Google authorization; no consent has been granted and no app promotion has been written. Private project/deployment identifiers are saved only in task-private configuration.

The connector owns the private synthetic workbook, while the staged app is owned by and restricted to a different existing manager account. Fresh workbook metadata confirms it remains owner-only. The app executes as the accessing user, so connector ownership does not authorize this manager to append history or rebuild the student view. No identity was switched and no authentication guard was weakened.

The proposed grant is Editor on this one synthetic workbook to the configured app manager. The separate app consent requests `spreadsheets` (read, edit, create, and delete Google Sheets accessible to that account) and `userinfo.email` (read its primary email). These Google permissions extend beyond the synthetic workbook; the exact-workbook guard constrains app behavior, not the OAuth scope. Confirm the signing-in identity before consent. Exact recipient, workbook, project and signing-in account stay in task-private configuration and the owner approval request.

Automatic approval review rejected the requested access grant to the existing TEST manager. That grant remains unapplied. The manager's access and any required Google OAuth approval must be resolved before completing native visual QA and the owner-only hosted integration. No account permissions were broadened as a workaround.

Executable continuation prompt:

> Continue from `docs/promotions-test-handoff.md` and application `f00bea9b2bf225bce311d2f6b680088f31452bd8`. After Andrew explicitly approves the access grant for the existing TEST manager to the private synthetic workbook and any required Google OAuth permissions, use the existing private task configuration to finish the Google Apps Script TEST deployment with MYSELF access and USER_ACCESSING execution. Verify the configured owner succeeds and unauthorized or blank identities cannot read or write. Browser-test stripe/degree, belt change, audited correction, duplicate names, unknown/missing ranks, double taps, concurrent/stale edits, and failed/lost responses against the real synthetic workbook. Confirm dates, approver versus recorder, exact event IDs/counts, and before/after history through an independent fresh session and native sheet readback. Visually inspect the native workbook and phone/tablet/laptop app. Preserve all six legacy tabs and keep both live gyms and the live promotion workbook unchanged. Return the working protected TEST review entry point and update this handoff with exact deployment and final evidence. Do not merge, release production, migrate live students, or change the separately frozen kiosk PR #84 without separate approval.
