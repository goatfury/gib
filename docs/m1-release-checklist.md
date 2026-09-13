# M1 reusable release checklist

Run this gate for every change to shared-kiosk sign-in, Staff Clock, confirmation, local persistence, sync, or offline-shell behavior. Use a fresh isolated TEST deployment and synthetic records. A passing automated suite alone is not hosted-browser evidence or authorization to publish to production.

## Candidate and destination

- [ ] Record the exact application revision, immutable TEST deployment URLs, installation profiles, and build identifiers. Confirm each write reaches its intended TEST backend before entering records.
- [ ] Run the complete M1 automated suite, including `tests/m1-kiosk-next-person.test.mjs`, and the required repository checks. Record failures and limitations honestly.
- [ ] Use the exact deployed artifact in laptop, tablet, and phone layouts. Keep production data, settings, devices, credentials, and private identifiers out of test assets and public evidence.

## Permanent next-person gate

**Complete a transaction, never press Done, walk away, then approach as a different person and complete the next transaction.**

Run the following on both gyms' Instructor Sign-In and on Revolution Staff Clock for both clock-in and clock-out. Richmond Staff Clock must remain disabled. Use actual elapsed time and ordinary touch/pointer and keyboard input on the hosted candidate; simulated timers and direct function calls are supplementary coverage only.

- [ ] Start with person A, complete a durable transaction, and leave the confirmation untouched. It clears at about five seconds for Staff Clock and at the existing 15-second Undo deadline for Instructor Sign-In.
- [ ] Verify the name, notes, selected classes, confirmation text, time, and shift detail from the completed interaction have cleared. Person B can then complete a transaction with no stuck buttons or old details.
- [ ] Press Done early, then immediately begin person B's form. The old deadline and acknowledgment must never clear that input, reopen person A's confirmation, steal focus, or change another active interaction. Exercise a Staff Clock confirmation while an instructor form is in progress too.
- [ ] Undo an instructor sign-in before the deadline: the original form returns and only its unsent batch is removed from both ledger and queue. Attempt sync while Undo is available and verify nothing from that batch is sent. Repeat after an early Done and after a real 15-second wait; verify the intended batch becomes sendable exactly when Undo ends.
- [ ] Suspend/background the page across each deadline, then resume or navigate back. Expired confirmation details clear on return even when the normal timer did not run. Do not interpret browser lifecycle emulation as a physical-tablet sleep pass.
- [ ] Delay the acknowledgment until just before, and again until after, the original deadline. The response must not restart the deadline. Start person B before the old response arrives and verify the response does not affect that form.
- [ ] Save offline, wait without pressing Done, and verify neutral controls plus a nonpersonal pending-sync message where appropriate. Reconnect and verify the same durable IDs are accepted once and the queue drains only after readable acknowledgment.
- [ ] Simulate local save failure and failed Undo persistence. Report failure truthfully, preserve unsaved input or the original undoable record, and do not display a false success. Clearly label injected failure evidence.

## Record and neighboring-flow checks

- [ ] Compare before/after saved records, permanent IDs, queued rows, teaching hours, Staff Clock totals, and exported CSV contents. There must be no lost or duplicate transaction, changed duration, or accidental deletion from an unrelated batch.
- [ ] Exercise rapid consecutive users and duplicate taps. Preserve authentication, device configuration, schedule selections for an unrelated active form, and Admin operations.
- [ ] Smoke-test shared temporary classes, Admin corrections, and exports with synthetic TEST records. Inspect the confirmation's hidden text as well as visible details; hiding a personal result is not clearing it.
- [ ] Verify normal online reload and the offline shell serve the candidate. Record the actual browser inputs, elapsed-time observations, response/recovery evidence, screenshots, and any JavaScript errors without private data.

## Release decision

- [ ] Freeze the exact tested kiosk artifact independently of later feature work. Link its revision, TEST deployment, and evidence in the current release handoff; distinguish implementation, TEST verification, and live deployment.
- [ ] Mark the gate passed only after the real next-person workflows and every non-hardware check pass. Disclose any physical device or native download path not exercised.
- [ ] Obtain explicit approval before merging or publishing either live gym. Preserve the existing Richmond deployment/profile and Revolution main auto-deployment boundaries. No TEST review constitutes a live-release approval.

For a separately approved initial production cutover, also follow [m1-production-cutover.md](m1-production-cutover.md). That historical data-cutoff procedure does not replace this reusable release gate.
