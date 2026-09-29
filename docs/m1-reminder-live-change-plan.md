# PR89 disabled live release package — implemented, not released

September29,2026. The production-capable source mapped by the previous plan is implemented and isolated verification exercises its enabled paths. PR89 stays draft/unmerged. Production deployment, Google consent, live permissions, sending and timers are not authorized by this preparation.

## Implemented code

- `m1-release-scope.mjs` reuses exact canonical origin, published site ID, installation/profile and production receiver checks. Independent switches accept only exact `true`; missing/invalid settings keep features off. HTTP input never selects environment, gym, recipients or destination. Build/client gates also require the correct production profile and canonical origin.
- Each gym uses its fixed own live callback/correction origin. TEST retains its original stores/identities. Live stores are `gib-m1-digest-production-{gym}-{digest|workflow|delivery}-v1`; pending reads, captures, daily decisions, attempts and dated schedules are target-bound. Daily identities are `m1-production-scheduled-{gym}-{localDate}`. No TEST history or records are copied into live.
- Production Google bundles contain their existing own wrapper/Sheet/target/provisioning locks plus `GibM1LiveFeatures`, manager read, digest and MailApp source. Only Revolution includes Staff recovery. Neither includes TEST callback proof source. Rehearsal/fault helpers reject production. Live HTTP status rejects synthetic/example/rehearsal actions. Existing authentication and authoritative validation remain.
- The Google send path verifies effective business account, own private recipient allowlist and separate send gates. It claims the original gym/day durably before MailApp. A call that may have happened is never repeated after a crash, lost reply, reload, lease expiry or provider change. No Resend fallback. Submitted means submitted, not delivered. Next eligible day assesses current records afresh, includes older unresolved work and retires obsolete retries; no backlog or routine all-clear email.
- Revolution recovery uses existing tablet authorization and Admin authentication. Original requests/punches, proposals, on-page approval, complete audit proof and original-request recovery remain. It is independent of the old manager-review pilot switch. Reminders can read retained Staff questions with new recovery entry disabled. Richmond Staff Clock stays disabled throughout.
- Trey Martin's application access is enabled only by the Richmond live gate on its active own installation. Revolution rejects Trey. Deactivation invalidates his session while retained audits remain readable. No Sheet/editor/hosting rights are granted.
- Tablet warnings remain aggregate-only and do not block ordinary sign-ins, clocking, corrections or payroll. Live reminder history is Admin-authenticated, session-bound, read-only and rejects failed/incomplete/stale results instead of showing an all-clear.

## Confirmed settings

| Setting | Revolution | Richmond |
| --- | --- | --- |
| Sender / execution account | revbjjops@gmail.com | revbjjops@gmail.com |
| To | Stu: info@revolutionbjj.com | Trey: info@richmondbjj.com |
| Initial BCC | andrew@revolutionbjj.com | andrew@revolutionbjj.com |
| CC | none | none |
| Daily opportunity |20:00 America/New_York, DST-aware|20:00 America/New_York, DST-aware|
| Own canonical origin | https://gib-live.netlify.app | https://gib-richmond-live.netlify.app |
| Staff Clock | Revolution only | disabled |

`GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW=false` removes BCC from future messages without rewriting originals. BCC is hidden transport information, absent from visible To/CC/body; the Google allowlist must match the selected routing. No sender/recipient/time fact remains unsettled.

The approved Revolution reminder-only rule applies prospectively from2026-09-29: reliably observed classes starting before20:00 without explicit finishes become reminder-eligible at20:00. Known later finishes win. No actual endAt, payroll hours or historical schedules are invented. Richmond's explicit late finishes become next-day eligible. Unknown coverage remains a separate “could not check” section; known unresolved attendance stays listed. The retained three Richmond TEST missing classes and22 unassessable dates are evidence, not migration input. Missing second instructors still require staffing evidence or manager knowledge.

## Exact disabled controls

All values below remain `false` in the prepared live baseline and initial later publication:

| Control | Boundary |
| --- | --- |
| GIB_M1_ATTENDANCE_REMINDERS_LIVE_ENABLED | own site build/server and Google |
| GIB_M1_STAFF_RECOVERY_LIVE_ENABLED | Revolution build/server and Google |
| GIB_RICHMOND_TREY_ADMIN_LIVE_ENABLED | Richmond build/server and Google |
| GIB_M1_ATTENDANCE_DIGEST_SEND_ENABLED | existing application send gate |
| GIB_M1_MAILAPP_LIVE_SEND_ENABLED | application and Google send gates |
| GIB_M1_ATTENDANCE_DIGEST_LIVE_SCHEDULE_ENABLED | Google scheduler |

Older `GIB_M1_MANAGER_REVIEW_PILOT` / `GIB_M1_MANAGER_REVIEW_LIVE_PILOT` stay false in this disabled live baseline. Existing production sync, Richmond activation/write protections, device cookies, credentials and passphrases remain unchanged. TEST history and controls remain separate.

## Exact offline release package

`tools/package-m1-disabled-release.mjs <reviewed-GitHub-SHA> <empty-output-directory> <existing-netlify-cli-root>` prepares two separate public/functions/Google artifacts. It uses isolated generated profiles and explicit off settings, no credentials/network/upload, no private files or records. It reuses pinned packager14.5.4/client26.0.1 and existing Node22. Actual client verification checks every archive hash, function route, runtime and stream/background mode. Only the pre-existing tablet-pairing cleanup schedule remains; no reminder timer is embedded or installed.

Each `build.json` records exact source/public/Google/archive hashes, own profile, off settings and client metadata. The portable manifest retains confined relative paths. Its relocated `.netlify/functions/manifest.json` has a120-second client cache lifetime: regenerate and revalidate that cache from the same portable artifacts at an approved upload; never silently fall back after expiry.

The disabled baseline also keeps unrelated promotions off. Immediately before later cutover, verify unchanged actual live promotion settings; preserve any newer unrelated enabled behavior and freeze that matching build rather than overwrite it with this baseline. No live settings were read or changed merely to assemble this package.

Isolated tests exercise actual enabled production server and Google entrypoints with fake Sheets/storage/MailApp and signed callbacks: own To/hidden BCC; wrong origin/site/gym/identity/target/settings; concurrent workers; interrupted sends/storage and reload; durable clean/incomplete decisions; next-day older work; original Staff requests/approvals/audits; Trey corrections and deactivation history; failed/session-changed UI reads. One focused independent review found and confirmed repairs to the UI GET adapter, scoped Trey VOID validation and reminder-only Staff read independence. Candidate/check/package results are retained in the checkpoint; old local HEAD is not used as the source label.

## Later live identity and Google consent

Both existing manifests use USER_DEPLOYING. This alone is not proof of the executing account. TEST authorization does not authorize either live project. At the later approved release, verify each existing live project's actual deployment account in its editor, using business access only. No ownership changes, new Google account/project or personal inbox.

Prepared scope additions, not granted:

- Both: `https://www.googleapis.com/auth/script.send_mail` and `https://www.googleapis.com/auth/userinfo.email` — MailApp send-only and execution identity.
- Richmond additionally: `https://www.googleapis.com/auth/script.external_request` — fixed authenticated digest callback. Revolution already has it.
- Retain existing spreadsheets/drive.readonly scopes. No Gmail/inbox scope, trigger-management scope or Trey Sheet/editor/hosting access.

Under explicit later permission approval, Codex surfaces each exact business-account consent page. No-send `authorizeProductionMailApp` verifies locked own installation, effective revbjjops account and quota without writing or emailing. Later approved `prepareProductionMailAppLedger` validates/creates only the own header-only MailApp Attempts journal and readiness `GIB_M1_MAILAPP_LIVE_LEDGER_READY=v1`. Ordinary send requests cannot silently recreate missing/unreadable history. Private `GIB_M1_MAILAPP_LIVE_RECIPIENTS_JSON` must match `{to:[own confirmed To],cc:[],bcc:[initial confirmed BCC]}`. Existing receiver tokens/locks are retained.

## Receiver-first release and rollback for later approval

1. Freeze candidate/hashes. Recheck live versions, account identities and unchanged settings at cutover; preserve newer work. Previous site checkpoints are Revolution6aad7f89edef4d000822cf60 and Richmond6aa6ac11e275bbfe21c7c787, not fresh readbacks in this task. Prevent main auto-deploy from bypassing receiver-first compatibility.
2. After separate consent/publication approval, publish compatible receivers to their existing own live deployment IDs with every new gate off. Verify target locks/schemas/current records read-only. Initialize only the approved header journal; do not provision/reset an existing installation or copy TEST data.
3. Publish matching own site/functions, still off. Verify current authenticated read-only records, ordinary sign-in/Staff behavior and protected correction links. Create no production fixture and perform no Walter correction.
4. Activate Revolution Staff recovery and Trey Richmond-only app access only if explicitly included in a later activation approval, with matching build/server/Google controls. Preserve original pending requests. Richmond Staff Clock remains off.
5. Real sending and timers require explicit activation approval. One business-account timer per gym uses the existing quarter-hour tick to evaluate20:00 local opportunity. Dispatch may be later; no exact-minute delivery guarantee and no backlog bursts. No timer is installed now.

Stop for wrong gym/recipients, duplicate application attempts, invalid storage/history, false all-clear, missing audit or ordinary-work interference. Disable send/schedule gates at both boundaries and the affected timers. Preserve every attempt/receipt; an already submitted email cannot be recalled. Disable new recovery/Trey entry controls while keeping historical reads and original-request reconciliation. Before restoring a prior site, keep a receiver able to confirm all pending saves/proposals/VOID/audits. Restore an old receiver only if it can confirm every operation since cutover; otherwise retain the compatible receiver with new work off. Never restore old Sheets, delete journals, guess hours or clear browser queues/pending saves.

## What a later approval changes

A disabled release approval would authorize the named live receiver/site publication, the stated business-account Google consent, no-send identity check and header-only attempt-ledger preparation. It would not implicitly authorize a merge, new app access, recovery entry, email sending or recurring timers. Each activation must be explicitly included in its later approval.

Source implementation is complete once the required checks/package receipts pass; the project is not live or launch-ready solely from isolated tests. Live account verification, private consent, approved publication and production read-only validation remain external release prerequisites. Historical Google reply failures, missing callbacks, browser cutoff and storage incidents remain separate and are not claimed fixed. Unknown sends can miss that day's reminder under the accepted policy; unresolved work remains available and is assessed next day. Submitted does not mean delivered.
