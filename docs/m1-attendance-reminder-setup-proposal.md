# Confirmed attendance reminder configuration

Andrew confirmed these settings on September 28, 2026. They supersede earlier recipient questions, the copies-off default, the 10 p.m. proposal and inactive Resend/Directnic sender plan. Historical messages and delivery records remain intact; they do not configure future reminders.

| Setting | Revolution | Richmond |
| --- | --- | --- |
| Sender | revbjjops@gmail.com | revbjjops@gmail.com |
| To | Stu — info@revolutionbjj.com | Trey — info@richmondbjj.com |
| Initial BCC | andrew@revolutionbjj.com | andrew@revolutionbjj.com |
| CC | None | None |
| Daily opportunity | 20:00 America/New_York | 20:00 America/New_York |
| Staff Clock | Existing Revolution capability | Disabled; do not enable |

America/New_York follows daylight saving time. Each gym receives its own message and only its own protected correction links. Andrew is a real BCC recipient, never a visible To/CC recipient or address in the rendered email body. Setting GIB_M1_ATTENDANCE_DIGEST_BCC_ANDREW=false removes BCC from future messages; existing immutable messages, attempts and receipts must not be rewritten.

## Approved Revolution reminder eligibility — September 29, 2026

Andrew approved the simple 8 p.m. rule going forward. For a reliably observed Revolution occurrence dated **2026-09-29 or later**, a class starting before 20:00 with no explicit finish is eligible for the reminder at 20:00 America/New_York. This is reminder eligibility only: `endAt` remains null, stored observations are unchanged, and no duration or payroll hours are created. Explicit later finishes take precedence. A class starting at/after 20:00 without its own finish remains uncertain. Ordinary current-schedule validation and retained dated observations continue automatically.

The 39 start-only labels below are no longer a prerequisite for forward reminder eligibility. They remain a useful record of the source's limits, not a new request to Andrew. The new rule does not apply to older dates or manufacture missing calendars. Richmond retains its explicit ranges; its 21:00 classes are excluded at 20:00 and are eligible in the next daily assessment.

Known unresolved items and unknown coverage remain separate. The saved Richmond TEST capture has three known September23 classes (07:00–08:00 BJJ No-Gi,18:00–19:00 Muay Thai Fundamentals,19:15–21:00 BJJ No-Gi Fundamentals). The06:00 canceled occurrence is excluded. Its separate email section says: **“Checks that could not be completed: The actual dated schedule or class finish times could not be confirmed for 22 dates. No missing instructors were inferred for those dates.”** This preserves older work without claiming that22 dates mean22 missing people. Warnings continue until reliable records/review evidence resolves them; no historical cutoff or silent exclusion is proposed.

See [the exact live change plan and remaining implementation boundary](m1-reminder-live-change-plan.md). The current sender and forgotten-clock-out paths still reject production; TEST success is not a deployable live release.

## TEST preparation boundary

Actual sending and recurring scheduling stay OFF. Captures are synthetic and are not delivered emails. Reuse the existing temporary Google timer rehearsal with an explicit near-term synthetic opportunity, isolated data and capture delivery. It does not activate the 8 p.m. schedule. Remove its temporary trigger and stop its lease after verification.

The existing Revolution TEST Google project executes as revbjjops@gmail.com and already has its approved send-only MailApp permission. No inbox access, new provider, DNS, account or paid mailbox is needed. The completed fictional Google email and Andrew's screenshot of its inbox arrival remain closed evidence; do not resend it.

## Daily behavior

At the latest eligible scheduled opportunity, obtain a fresh assessment, including older unresolved attendance and enabled Staff Clock questions. Repeated ticks and recovery retain one stable gym/date identity, including a complete clean/no-email decision. After downtime, assess only the latest eligible opportunity; do not send a backlog.

8 p.m. is the reminder time, not a recorded finish. Apply the approved prospective Revolution eligibility rule above; exclude known upcoming and still-running classes. A class with a known finish after 8 p.m. remains in dated coverage for the following daily assessment. Outside that rule, an unknown finish remains uncertain. A canceled occurrence remains excluded unless recorded teaching creates a contradiction needing review.

A successful complete check with no outstanding work produces no message. An incomplete check must say what could not be checked, never invent a missing sign-in or an all-clear. A day not reviewed is not the same as a missing sign-in. One instructor normally satisfies a class's sign-in requirement; identifying a missing second instructor needs an expected count/assignment or explicit manager knowledge.

Sending never resolves attendance or finish-time questions. Once a Google send may have happened, do not send that original again. Its uncertain result can mean that day's reminder is missed, as Andrew approved. The next due day uses fresh records and includes unresolved older work. Invalid recipients/configuration or unreadable/inconsistent anti-duplicate history still block sending. A completed MailApp call means submitted to Google, not delivered; no inbox access or bounce-monitoring system is added.

## Class finish evidence — checked September 29, 2026

Official sources read at approximately 14:27 UTC: https://www.richmondbjj.com/schedule and https://revolutionbjj.com/schedule/ . Richmond's published ranges match all 23 current entries in `m1/richmond-schedule.json`. Revolution's published list matches the 55 start-only entries in `m1/shared-schedule.json`; it supplies no finish times. The tables below use the app's exact labels, grouping only identical labels across weekdays. Neither source establishes a historical effective date. The JSON version dates are not proof that a schedule applied to every date since then.

Use a freshly validated current source only for that gym's current local date, then retain its dated observation. For an older date, an already-retained dated label containing an explicit range can establish its own finish without rewriting history. Do not apply today's weekly table to missing historical dates. Unknown historical coverage remains unavailable. Additional/unlisted classes require their own finish evidence; the confirmed 20:00 reminder, payroll duration, adjacent start times and assumed one-hour classes are not substitutes.

The narrow parser prepared in this branch derives a finish only from an occurrence's own explicit AM/PM-to-AM/PM range. It preserves existing stored observations and explicit timestamp objects. Invalid, reversed, ambiguous DST or implied overnight ranges fail closed rather than guessing. Twenty focused source tests passed, including all 23 Richmond mappings, unchanged historical observations, next-day coverage, and all 55 Revolution entries remaining uncertain. This is source/test evidence, not a claim that the repair has been deployed.

### Richmond: 23 current occurrences with explicit finishes

| Days | Exact app entry, including supported finish |
| --- | --- |
| Mon/Wed/Fri | 6:00 AM–7:00 AM Muay Thai Fundamentals |
| Mon/Wed/Fri | 7:00 AM–8:00 AM Brazilian Jiu-Jitsu No-Gi |
| Mon/Wed | 6:00 PM–7:00 PM Muay Thai Fundamentals |
| Mon/Fri | 7:15 PM–9:00 PM Brazilian Jiu-Jitsu Fundamentals |
| Tue/Thu | 6:00 AM–7:00 AM Muay Thai Mixed Levels |
| Tue/Thu | 7:00 AM–8:00 AM Brazilian Jiu-Jitsu Gi |
| Tue/Thu | 6:00 PM–7:00 PM Muay Thai Mixed Levels |
| Tue/Thu | 7:15 PM–9:00 PM Brazilian Jiu-Jitsu Mixed Levels |
| Wed | 7:15 PM–9:00 PM Brazilian Jiu-Jitsu No-Gi Fundamentals |
| Fri | 6:00 PM–7:00 PM Muay Thai Open Mat |
| Sat | 10:00 AM–11:00 AM Muay Thai Fundamentals |
| Sat | 11:15 AM–1:00 PM Brazilian Jiu-Jitsu Fundamentals |
| Sun | 10:00 AM–11:00 AM Ladies Muay Thai |

The weekday 19:15–21:00 classes are still running at the confirmed 20:00 reminder. Their saved dated occurrences remain eligible in the following assessment. Public weekly ranges do not establish holiday exceptions, cancellations or historical attendance.

### Revolution: 55 start-only occurrences — source limitation, not a forward reminder blocker

These39 grouped labels identify the complete current start-only list. The approved rule handles their prospective reminder eligibility. If actual finishes are supplied later, retain their effective dates; do not backfill older dates without separate evidence.

| Days | Exact app entry requiring a finish |
| --- | --- |
| Mon/Wed | 6:00 AM BJJ (Level 2) |
| Mon | 12:00 PM BJJ Kimuras (Level 2) |
| Mon/Tue/Wed/Thu | 4:30 PM Kids’ BJJ |
| Mon/Wed | 4:30 PM BJJ (Level 1) |
| Mon/Tue/Wed/Thu/Fri | 5:30 PM BJJ (Level 2) |
| Mon | 5:30 PM Muay Thai Drills |
| Mon | 5:30 PM Focus Class (Level 4) – tripod passing (changes every quarter) |
| Mon | 6:30 PM Takedown Drills (minimum white belt 2 stripes or yellow belt in judo) |
| Mon/Wed | 6:30 PM Muay Thai (Fundamentals/Intermediate, and intros when scheduled) |
| Mon | 6:30 PM Leglock Fundamentals (No-Gi, Level 3) |
| Mon | 7:00 PM BJJ (Level 2) |
| Mon/Wed | 7:00 PM No-Gi BJJ Intro Class/Level 1 BJJ |
| Tue | 6:00 AM BJJ (Level 4)/Gi BJJ Intro Class |
| Tue | 6:00 AM No-Gi BJJ (Level 2) |
| Tue/Thu | 12:00 PM BJJ (Level 2) |
| Tue/Thu | 5:30 PM Gi BJJ Intro Class/Level 1 |
| Tue/Wed | 5:30 PM BJJ (Level 4) |
| Tue/Thu | 6:30 PM Muay Thai (Int/Adv) |
| Tue | 6:30 PM BJJ Sweeps Class (Level 3) |
| Tue/Thu | 6:30 PM Judo |
| Tue | 7:00 PM BJJ Competition Class (Level 2, gi) |
| Wed | 12:00 PM No-Gi BJJ (Level 2) |
| Wed | 6:30 PM BJJ Drills (Level 3) |
| Wed | 7:00 PM BJJ (Level 4) |
| Thu | 6:00 AM No-Gi BJJ (Level 4) |
| Thu | 6:00 AM No-Gi BJJ (Level 2)/Gi BJJ Intro Class |
| Thu | 5:30 PM No-Gi BJJ (Level 4) |
| Thu | 6:30 PM Advanced Leglocks (No-Gi, Level 3) |
| Thu | 7:00 PM BJJ Competition Class (Level 2, no-gi) |
| Fri | 6:00 AM Drill/Roll Class – BJJ |
| Fri | 12:00 PM Drill/Roll Class – BJJ |
| Fri | 5:00 PM Takedown Drills (minimum white belt 2 stripes or yellow belt in judo) |
| Fri | 6:00 PM Muay Thai (Fundamentals/Intermediate) |
| Sat | 10:00 AM Kids’ BJJ |
| Sat | 10:00 AM Wrestling |
| Sat | 11:00 AM BJJ (Level 2) |
| Sat | 12:00 PM Conditioning |
| Sun | 12:00 PM BJJ Competition Class (Level 4, gi and no-gi) |
| Sun | 1:00 PM BJJ Open Mat |

## Richmond TEST preparation and remaining live prerequisites

Confirmed recipient info@richmondbjj.com does not grant correction access. Richmond's [official instructor page](https://www.richmondbjj.com/about-us2) identifies Trey Martin. The prepared TEST change adds that exact selected reviewer name only to the trusted Richmond TEST UI, signed session, attendance validators and isolated receiver. This uses the existing TEST name-selector login; it is not evidence that Trey has personally signed in or already has a production account. The global Revolution/production reviewer list is unchanged. No Sheet, editor or hosting access is granted, and Richmond Staff Clock remains disabled. Hosted verification and any separate live access approval must be recorded explicitly.

The existing Richmond TEST project is separate from both production receivers. On September 29, its version 5 deployment was positively verified as executing as `revbjjops@gmail.com`; the exact private project identity is retained in the local checkpoint. Prepared integration reuses the same locked Sheet, own-gym digest/history, fixed Richmond callback destination and disabled MailApp connection. The additional declared Google scopes are `script.external_request` (authenticated callbacks to the TEST app), `script.send_mail` (send only), and `userinfo.email` (verify the executing business sender). Existing Drive-readonly/Sheets scopes remain; no inbox or trigger-management scope is added. Declaring these scopes does not grant consent. The no-send authorization helper must complete before publishing the receiver. Synthetic Revolution-hosted routing and the completed timer rehearsal do not establish Richmond's actual receiver readiness.

Richmond's retained September 29 read failure is specific: initial POST to script.google.com returned 302 after 3,973 ms, then its fresh response URL returned HTTP 404 from script.googleusercontent.com after 15,553 ms. The existing second attempt also received 302 then 404. Google listed both version 5 executions as completed; their contents were unavailable. The prepared initial-read/badge repair uses the existing authenticated durable callback instead of the failed response URL, preserving complete record validation. Saves and save reconciliation remain separate.

## Consolidated launch work

1. Retain focused TEST evidence for routing, hidden BCC, 8 p.m. daily behavior, late classes, failures and browser-independent capture; remove temporary triggers.
2. Establish authoritative class finish coverage where stored schedules provide only start times; keep unknown coverage visibly incomplete meanwhile.
3. Complete Richmond's own receiver/scheduled-check integration and successful current-record/correction-screen verification; resolve its specific observed read failures without claiming Revolution tests prove it.
4. Complete the authorized Richmond-only TEST Trey checks and obtain the genuinely required business-account Google consent. Production Trey access and live Google consent remain separate launch requirements. No permission is granted by this document.
5. Prepare real Revolution and Richmond runtime settings, disabled until a separately approved release, including the confirmed recipients/BCC/schedule, durable attempt history and rollback. No additional email is authorized by configuration approval.
6. Obtain explicit production release, required live access/consent and activation approval after material reliability blockers are resolved. Keep clear warnings and original-request recovery for Google response, missing-callback or storage failures; the Staff read response-path repair is bounded TEST evidence, not a reliability guarantee.

No re-approval of the sender, addresses, BCC or 8 p.m. time is needed. Remaining approvals concern access, any new scopes and eventual live activation—not those settled choices.
