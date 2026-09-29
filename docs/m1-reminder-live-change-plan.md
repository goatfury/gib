# PR89 live change plan — not applied or authorized

This supersedes the older supervised Revolution-only pilot plan. September29,2026: sender, recipients, hidden BCC,20:00 Eastern and the prospective Revolution reminder rule are settled. Real sending/scheduling remain off. No production change or merge has been made.

## Release status and the exact implementation boundary

Reminder eligibility is implemented and verified in TEST. Current TEST sending and forgotten-clock-out recovery **cannot simply be enabled in production**:

| Boundary in current source | Necessary live-source change, before a release can be approved |
| --- | --- |
| `m1-attendance-digest.mjs` digestGym/default configuration/ledger validation; digest, job, workflow and warning endpoints | Add an explicit production scope selected only by the verified installation/runtime plus a default-off activation gate. Request bodies must never choose target/gym/origin. Preserve existing Admin and server authentication. |
| Digest outbox, daily workflow/history, dated schedules and MailApp delivery | Select separate production namespaces and production-bound message/request identities from that scope. Keep all existing TEST records and historical receipts in place. Do not copy or reinterpret TEST decisions, dates, messages or attempts as live. Preserve immutable identities, original-attempt readback, CAS ownership, retired retries and no-backlog behavior. |
| `GibM1AttendanceDigest.gs`, `GibM1MailApp.gs`, production entrypoints and manifests | Bind each live wrapper to its existing exact production Sheet/target/installation locks, fixed own-gym callback destination and revbjjops execution identity. Add production-specific default-off send controls and sender/To/BCC allowlists. Keep TEST faults/rehearsals/proof routes excluded. No provider fallback, resend of uncertain attempts or inbox access. |
| `staff-recovery-client.mjs`, Admin recovery gates, `GibM1StaffRecovery.gs` | Add the approved Revolution production scope behind a default-off recovery gate. Keep employee authentication, exact punch/shift matching, append-only proposal/decision journal, reviewer confirmation and original-request recovery. The existing `staffRecoveryEnabled_` is TEST-only; changing a UI label would not enable this safely. Keep its fault hooks TEST-only. Richmond stays disabled at every layer. |
| Richmond production reviewer validation/UI/session/Google boundary | Add the exact verified application identity **Trey Martin** only to the Richmond production Admin scope behind its activation gate. Revolution must still reject Trey; no Sheet/editor/hosting access. Do not grant access through a global name list. |

These are code changes, not missing recipient/time facts or a reason to investigate historical Google incidents again. They have **not** been implemented or verified as production paths in this preparation. A merge/send switch alone is unsafe. The next engineering step is the guarded production-target conversion above, tested with isolated fake production-scoped inputs; it needs no real records or sending. Required checks must cover only its newly exposed boundaries plus mandatory CI. Existing workflow evidence remains reusable.

## Exact intended production configuration

| Item | Revolution | Richmond |
| --- | --- | --- |
| Existing hosting site | gib-live | gib-richmond-live |
| Existing production wrapper | integrations/google-apps-script/production/Code.gs | integrations/google-apps-script/richmond-production/Code.gs |
| Sender / execution account | revbjjops@gmail.com | revbjjops@gmail.com |
| To | info@revolutionbjj.com | info@richmondbjj.com |
| BCC | andrew@revolutionbjj.com | andrew@revolutionbjj.com |
| CC | none | none |
| Due time |20:00 America/New_York|20:00 America/New_York|
| Staff Clock recovery | existing Revolution staff identities; manager approval required | disabled |
| Reviewer | Stuart Turner, existing scoped Admin access | Trey Martin, new Richmond-only scoped Admin access |
| Reminder policy | prospective Sep29 rule; known later exceptions retained | actual dated explicit ranges; late classes next day |

Use each profile's existing canonical production origin for correction links and signed callbacks; verify the site's current configured origin immediately before assembling the release. Do not substitute a preview or guess an alternate hostname. Initial BCC is a transport BCC only, absent from visible To/CC/body. `GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW=false` removes BCC from future messages without rewriting originals. All new production activation switches start OFF; their exact implemented names must be recorded with the frozen production-capable revision before approval.

## Live Google consent preparation

The live manifests currently execute as **USER_DEPLOYING**. This setting alone does not prove the account is revbjjops; TEST authorization does not authorize either production project. Before presenting consent, verify each existing live deployment's actual executing account in its own editor/deployment panel. Do not change ownership or use Andrew's personal account. If the current deployment cannot run as revbjjops with existing authorized business access, stop with that exact account/access boundary.

Proposed scope additions to the **existing** production projects:

- Both: `https://www.googleapis.com/auth/script.send_mail` (MailApp send-only) and `https://www.googleapis.com/auth/userinfo.email` (verify execution identity). No Gmail/inbox scope.
- Richmond also: `https://www.googleapis.com/auth/script.external_request` for its fixed authenticated application callback; Revolution already declares this scope.
- Retain the existing spreadsheets/drive.readonly scopes. Do not add trigger-management scope or broaden Sheet sharing.

Prepare source/manifests offline first. After explicit production-permission approval, surface the exact business-account Google consent screen, one action at a time. Verify the no-send identity/quota helper afterward. Do not silently grant consent, send a message to test it, or treat a successful helper as delivery.

## Receiver-first cutover proposed for later approval

1. Freeze the production-capable source, exact per-gym bundles/routes/runtime hashes, off-switch settings, existing receiver deployment versions and site checkpoints. Prevent a main auto-deploy from bypassing the receiver-first sequence. Current verified production site checkpoints: Revolution `6aad7f89edef4d000822cf60`; Richmond `6aa6ac11e275bbfe21c7c787`. Recheck them at cutover; do not overwrite newer work.
2. Verify live execution identities; obtain only the scoped Google consent above. Publish compatible receivers to their existing deployments with new send/schedule/recovery gates off. Keep all existing tokens, target locks, Sheet bindings, original IDs and audit schemas. Initialize only necessary empty journals after approved schema readback; copy no TEST data.
3. Publish matching own-gym UI/functions, still off. Before enabling new writes or sending, verify authenticated production **read-only** scope, current records, own-gym protected links and unchanged ordinary instructor/Staff behavior. No synthetic production record or Walter correction.
4. Apply only the approved application access change for Trey Martin in Richmond. Verify the signed scope permits Richmond correction tools and denies Revolution; grant no direct Sheet/editor/hosting access. Preserve pending saves before enabling the new Revolution staff recovery interface.
5. Activate reminders only after a separate explicit sending/schedule approval. Use the existing Google scheduler path, one timer per gym. The existing quarter-hour tick checks local20:00 and sends the latest eligible opportunity once; Google may dispatch after20:00. This is not an exact-to-the-minute delivery guarantee. No backlog or routine all-clear email. Keep timing expectations explicit in that approval.

## History and failure behavior

Keep all known older unresolved items. A separate “Checks that could not be completed” section explains dates lacking reliable coverage; it never calls them missing people. Richmond's retained TEST example has three Sep23 missing classes and22 unassessable dates. These TEST facts must not be copied into live; the live digest must reread its own authoritative records. No historical-calendar reconstruction or historical exclusion decision is required for the conservative behavior already approved.

Failed reads remain uncertain and keep warnings. Ordinary sign-in/clock-in/correction/payroll work is not blocked by email status. Unknown sends are not resent; the next eligible day's fresh assessment can include still-unresolved work. A MailApp success means submitted, never delivered. Preserve old missing-callback/browser-cutoff/storage incidents as history. Investigate only a demonstrated risk or new failure, not the mere existence of those incidents.

## Stop conditions and rollback

- Stop new reminders immediately for wrong gym/recipient/BCC, an unauthorized scope, duplicate application attempts, corrupted identity/history, false all-clear, lost audit or any interference with ordinary sign-in/clock-in. Do not retry an uncertain original send.
- Turn production sending off at both application and Google gates; disable the affected timer. Do not revoke the credentials or delete receipts/journals. Retain pending delivery/read/decision history for safe original-request recovery.
- For review/recovery rollback, first stop new work and retain a receiver capable of confirming existing pending saves/proposals/VOID/audits. Restore the matching previous website artifact only after checking that capability. A website rollback cannot justify deleting Staff Recovery or Manager Reviews history or clearing a browser queue.
- Restore the recorded receiver version only if it can still read/reconcile every operation written since cutover. Otherwise leave the compatible receiver and disable new feature entry points. Never restore an older workbook, guess worked hours or replay TEST records. Richmond Staff Clock remains off.

## Approval boundary

No production approval is requested while the production-target conversion above is unfinished. Once that exact disabled package is tested, the proposed approval would cover publishing those named receiver/site revisions, the stated Google consent and Trey Richmond-only application access. Turning on real sending and the two recurring timers must be explicitly included in a later activation approval; it is not implied by a deploy or TEST pass.
