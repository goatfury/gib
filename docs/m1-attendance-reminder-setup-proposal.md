# Regular attendance reminders — setup proposal, not activation

Prepared September 27, 2026. Use the existing business Resend account, `revbjjops@gmail.com`, with separate messages for each gym. Keep sending, delivery-event ingestion and recurring scheduling off until the remaining setup and its TEST verification are approved. This proposal changes no account, recipient, permission, deployment or record.

## Proposed choices and verified limits

| Item | Proposal | Evidence / remaining fact |
| --- | --- | --- |
| Revolution recipient | Stu Turner only | His identity and existing Admin eligibility are verified. His exact business email is still unknown. |
| Richmond recipient | Trey only | His manager role is established by existing business instructions. His exact business email is still unknown, and he is absent from the current Admin allowlists. |
| Andrew | No copy by default | Optional copying requires a separately confirmed business address and approval. The completed owner-only TEST email does not opt Andrew into recurring copies. |
| Service | Existing `revbjjops@gmail.com` Resend account | The original synthetic message was accepted, reported delivered and confirmed in the recipient's inbox. Preserve that completed test; do not send it again. |
| Sender | Recommend `GIB attendance <attendance@notify.revolutionbjj.com>` **only if that domain is confirmed business-controlled and approved** | The official business website establishes the domain's business use, not DNS administration or mail authorization. The main agent's September 27 read of the existing business Resend Domains page showed **No domains yet**. This proposed address/domain is not configured or verified. |
| Revolution time | Proposed daily `22:00` (10 p.m.), `America/New_York` — unconfirmed | Final class finishes and exceptional/overnight sessions are unknown. A start-time schedule or payroll duration cannot establish this cutoff. |
| Richmond time | Proposed daily `22:00` (10 p.m.), `America/New_York` — unconfirmed | The published latest ordinary finish is `21:00` (9 p.m.), which supports the proposal only. Added classes and exceptional/overnight sessions still need confirmation. |

Scoped repo/history and existing business Drive notes were already checked for the recipient addresses; they identify Stu and Trey but do not establish either address. The public Richmond contact address is not evidence of Trey's mailbox. No personal inbox or personal account is a setup route.

Richmond's current published timetable explicitly ends ordinary weekday classes at 9 p.m., Saturday at 1 p.m. and Sunday at 11 a.m.: https://www.richmondbjj.com/schedule . Revolution publishes start times without reliable finishes: https://revolutionbjj.com/schedule/ . Neither proves coverage of added classes, exceptions or historical days. The current digest source assigns `endAt: null` to string schedule labels; Richmond's displayed ranges are not silently treated as stored finish evidence.

## Access and sender setup

The inspected Netlify source allows `Andrew Smith` and `Stuart Turner` in `netlify/functions/_lib/m1-common.mjs:14`; `m1-admin-login.mjs:29–40` checks that list and existing login requirements. Google source independently lists the same names in `integrations/google-apps-script/GibM1Receiver.gs:33`, and its correction/review handlers validate them. Trey is absent from both. These are source checks, not a new live sign-in or deployed-editor verification. Before Richmond activation, a separately approved change must give Trey the intended Richmond-only access consistently through the UI, Netlify validation and Google receiver; adding his email or globally adding his name is insufficient. Existing permissions remain unchanged.

The proposed application permissions for Trey are **Richmond only**:

- Read Richmond manager review and Daily Review records; add or correct instructor attendance through existing audited paths, including forgotten additional instructors and unlisted classes.
- Remove an invalid attendance entry through the existing audited VOID path, preserving the original record and history.
- Record class decisions such as “Didn't happen” or “Don't know,” save partial progress, and mark an eligible day complete while preserving pending/upcoming-class safeguards.
- Review and approve or reject hourly Staff Clock finish-time questions only where that function is already enabled and authorized for his existing role. Richmond's current profile disables Staff Clock; this proposed access grant does not enable it or authorize a separate Staff Clock rollout.

These application permissions confer no Revolution access and no direct Google Sheet, Apps Script editor, Netlify or Resend access. Stu's existing access stays unchanged. The inspected business notes call the Richmond reviewer Trey; this proposal does not infer a new login identity from that name.

After domain approval, use the existing business Resend account to add the chosen notification subdomain. Its authorized DNS administrator must install Resend's exact generated verification records and confirm verification. Preserve existing root mail records; do not replace the business's working mailbox routing. Keep open/click tracking off. No Google mailbox access is needed. Resend recommends a sending subdomain to separate mail reputation: https://resend.com/docs/dashboard/domains/introduction .

Using that shared sender for Richmond as well requires explicit business-ownership/brand approval. Revolution's website or Trey's role does not establish that authority. Do not treat the proposal as permission to configure either gym's domain.

## Delivery evidence, before sending is enabled

Prepare the existing TEST callback destination:

https://deploy-preview-89--gib-live.netlify.app/api/m1-attendance-delivery-receipt

The main agent's September 27 read of the existing business account at https://resend.com/webhooks showed **No webhooks yet**. In that account, the proposed subscription is limited to `email.delivered`, `email.bounced` and `email.failed`. Privately install its distinct signing secret as `GIB_M1_WORKFLOW_TEST_RESEND_WEBHOOK_SECRET`; keep `GIB_M1_WORKFLOW_TEST_RECEIPTS_ENABLED` off until an authorized TEST verification. This is setup preparation, not a request to create or enable it now. The handler verifies the signed original bytes and matches the provider message, sender and recipient before retaining delivery evidence. Provider acceptance alone stays visibly unconfirmed. No mailbox or tracking permissions are part of this proposal. Official setup: https://resend.com/docs/webhooks/introduction .

The implemented workflow is Revolution TEST only; there is no reviewed regular-use live endpoint in this proposal. Before activation, each intended gym/environment needs its reviewed live endpoint, receiver/delivery authentication and isolation, deployment and approval. The preview address and TEST credentials must not become a live callback by accident.

## When sending remains uncertain

The system can retry the exact original message for up to 23 hours, within Resend's documented 24-hour duplicate-protection period: https://resend.com/docs/dashboard/emails/idempotency-keys . If it still cannot establish whether that message was accepted, it stops sending that message and holds later reminders for the same gym. It does not clear attendance warnings or prevent staff from using the existing correction tools.

An authorized operator must then check the original message's retained receipt and Resend history. If acceptance or delivery is proved, reconcile that original evidence; if it remains unknown, leave it held. Do not press a new-send workaround, clear history, change the date, or create a replacement identity. A safe operator-owned reconciliation procedure still needs to be demonstrated before regular use; this intervention is not being passed to ordinary staff or accepted as an undisclosed reliability compromise. The history repair retains original records and uses bounded pages and indexes instead of the lifetime 256-message list. It introduces no deletion policy and does not release an unresolved send simply because it is old.

## One next fact

**Identify the authorized DNS administrator for `revolutionbjj.com` and confirm that this business controls the domain.** That determines whether the proposed sender can be used without creating another account or disrupting working email. Recipient addresses and the actual closing cutoff remain explicit subsequent setup requirements, not guesses. The main agent verified the existing business account's empty Domains page at https://resend.com/domains without adding or changing anything.

The two working gyms, Richmond deployments, Walter records, all existing IDs/audits, the completed single-email test and PR86 remain unchanged. PR89 stays draft and unmerged. This document authorizes no send, timer, access grant or live release.
