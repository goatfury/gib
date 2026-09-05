# Richmond sign-in incident — open

## Outcome required

Trey must be able to use the Richmond sign-in tablet on Monday, September 7,
without remote troubleshooting. Andrew has the tablet at home until Monday
at the earliest. Keep driving the investigation toward that outcome; when
blocked, complete unaffected work and give one concrete unblock action.
Do not close the incident on a successful page load, diagnostic, or test suite.

## Verified facts

- Repository: `goatfury/gib`; working branch: `fix/richmond-startup-sync-retry`.
- Richmond kiosk: https://gib-richmond-live.netlify.app/m1/
- Read-only tablet check: https://gib-richmond-live.netlify.app/m1/connection.html
- Richmond Netlify site: `9b7757a9-70f4-4977-9ca2-270b41e34007`.
- Production sheet: `Richmond BJJ M1 — PRODUCTION` in connected Google Drive.
- On September 5, 23 active entries from August 31–September 5 reached the
  sheet after the tablet moved home. The old August 26 installation row is
  also present, marked VOID. This is not a payroll reconciliation.
- The user's tablet photo at 3:08:04 PM New York time shows: service reached,
  device accepted, automatic sending On, waiting 0, local history 24,
  last confirmed upload 2:50:36 PM, production sheet not confirmed.
- This is evidence about the home connection only. It does not establish
  what happened on the gym network.
- The failed check is the existing authenticated `ledgerStatus` request
  from Netlify to the Google receiver. The frontend diagnostic does not
  create sign-ins, change auto-sync, or read credentials.
- Sheet title, two tab names, and the eleven headers of each match the
  receiver's required schema in live Drive reads. The precise backend
  reason for the failed check is still unknown.
- After diagnostic release r2 on September 5, Andrew reported the tablet's
  diagnostic code as `CONFIRMED`. This establishes that the same authenticated
  read-only server-to-sheet check and both write gates passed on that attempt
  at home. The earlier failure is not currently reproduced; its cause is
  still unknown. Reporting improvements did not change receiver credentials,
  write settings, or the upstream ledger-status request.
- A fresh `Signins!A1:K100` read after that report still contains 24 records:
  23 OK and the one VOID installation row. There is no additional sign-in
  attributable to the read-only diagnostic and no new-write test in this turn.

## Changes already released

- A reproduced startup bug left Richmond auto-sync off after an initial
  status failure. The normal retry timer and wake events now retry that
  incomplete activation; a 30-second timeout releases stalled requests.
- Retry fix GitHub commit: `ed3ab5d13d65f0e14b58f9c59c45db9f052045a2`.
  The offline shell revision is `2026-09-05-richmond-sync-retry`.
  This fixes a demonstrated defect; it is not proof of the original cause.
- Initial connection check GitHub commit:
  `108e735b0a175cad7b2e5a491bf6f9fc70f298bb`.
- These changes were deployed only to Richmond. Revolution's last checked
  deploy was `6a95d82e6ea2ad000986b4ea` and was not changed here.
- Diagnostic r2 GitHub commit: `072e602f3f4da5adc80f98419bef8c15b8042f28`.
  Richmond deploy `6a9c70d796fffd63e00e47c3` was READY and published at
  `2026-09-05T19:43:43.188Z`. Live diagnostic assets matched the tested files.
  The full M1 suite passed 734 tests before this deployment. Coverage includes
  startup failure with Wi-Fi remaining online, wake retry, stalled-response
  timeout recovery, intentional-off preservation, and complete row
  acknowledgments. These checks do not simulate the physical gym network.

## Immediate next step and on-site completion

Andrew should tap **Return to sign-in** on the connection page. This restores
the normal kiosk, whose timers perform automatic retries; the read-only
connection page itself does not send queued entries. No reset or extra test
payroll entry is needed for this step.

When the tablet is back at Richmond, verify that a normal instructor sign-in
arrives in the production sheet. A dated Richmond row alone does not prove
physical location: establish that the tablet has returned to the gym before
calling this an on-site success. Do not diagnose failure from an empty Monday
range unless actual attempted use is known. If delivery fails, use the same
tablet's connection diagnostic on the gym network to select the next branch
below and check its waiting count. Do not repeat the unsupported Wi-Fi claim.

The incident remains open. No scheduled monitoring has been created yet.

## Pre-Monday recovery investigation continued

Andrew rejected ending the work at a passing home access check. Further source
inspection demonstrated an observability defect: uploads saved only a generic
latest error, the next successful upload removed it, and delivery status was
hidden in Admin. The old failure cannot be recovered from that missing history.

The `2026-09-05-richmond-delivery-history` update adds:

- Richmond-only delivery status on the normal kiosk: entries waiting to send,
  automatic sending off, or all saved entries confirmed sent. Empty history is
  not called successful delivery; the confirmation modal specifies local save.
- A bounded, counts-only local history of upload and activation outcomes, with
  timestamps and fixed error categories. Consecutive matching attempts coalesce.
  A subsequent successful upload retains the preceding failure. No names,
  RowIDs, credentials, upstream replies, or network-location claims are stored.
- An optional fixed failure header on existing authorized Richmond upload
  requests. It distinguishes tablet-to-service failures from service-to-Google
  failures without relaxing origin, device, receiver, or acknowledgment checks.
- History visible under **Recent sending history** on the existing connection
  page. This does not provide unattended remote access to the tablet.

The new integration tests execute the kiosk's actual sign-in, sync and wake
functions through the real Netlify handler with injected network boundaries and
synthetic data. They cover failed sends followed by reload and wake, a reply
lost after server acceptance, a stalled response body followed by recovery,
offline status, unauthorized requests, Google network and HTML failures,
malformed replies, and rejected rows. Existing receiver tests independently
cover idempotency. The full suite passed 741 tests. No production rows were
created by these tests. These are software fault simulations, not a test of
the physical tablet or Richmond network.

After deployment, verify live assets and browser layout before asking Andrew
to load the update on the actual tablet. The final on-site delivery requirement
and original-cause uncertainty remain open.

### Release blocked by automatic approval review

The tested change is saved in GitHub commit
`e78dcfaf94f00a8a35b296a0696c4cdfba3bd597` on the working branch (local equivalent
`6ee12ef`, tree `a424e70278152837599c5d23414e9530b2d5f853`). It is **not live**.
The last checked Richmond deployment is still `6a9c70d796fffd63e00e47c3`.

The connected Netlify deploy tool returned its normal source-upload command.
Automatic approval review rejected the upload, first questioning the proxy
destination. Netlify's official agent-setup documentation confirmed that the
exact hostname is Netlify's own MCP service, and the connected project read
confirmed the existing Richmond site. A retry with that new evidence was
rejected again, now specifically requiring user-authored authorization to
transmit potentially private project source to Netlify. Do not retry or use
another upload route until Andrew explicitly authorizes that disclosure.
The interrupted upload's generated ZIP was moved out of the repository.

The next permission request is to publish this tested update to the existing
Richmond Netlify site and read only Richmond sign-in function logs for August
31–September 5, if retained. Historical logs could help establish whether
requests reached the service before the tablet moved home; their retention
and diagnostic usefulness are not yet established. The earlier account-log
access denial also remains in force until explicitly authorized. Do not ask
Andrew to refresh the tablet for a release that has not been published.

## Active diagnostic route

The connection page requests `details-v1` using
`X-GIB-M1-Connection-Check`. Only an authorized Richmond tablet receives the
fixed `X-GIB-M1-Check-Code` category. Ordinary activation JSON, authentication,
write gates, and the upstream request remain unchanged. No account logs,
upstream bodies, identifiers, or credentials are exposed.

Use the actual tablet's reported code to select the next investigation:

- `TIMEOUT_OR_NETWORK`, `HTTP_FAILURE`, `HTML_RESPONSE`, or incomplete/invalid
  reply: inspect the server-to-Google delivery path and receiver availability.
- `RECEIVER_REJECTED`: distinguish receiver authentication, receiver schema
  validation, and lock contention. The receiver currently combines these
  into one rejection; this code alone does not identify which one occurred.
- `CONTRACT_MISMATCH`: compare the deployed receiver's exact response with
  the Netlify validator. Do not relax target or write checks to make it green.
- `WRITES_DISABLED` or `SERVER_WRITES_DISABLED`: verify the intended existing
  configuration and authorization before changing any gate.
- `CONFIRMED`: the read-only access check passed now; it is not a new-write
  canary or proof of gym connectivity.

## Access constraints

Browser access to Netlify's account logs was denied, and a subsequent request
was rejected by automatic approval review for repeating that denied access
without explicit authorization. Do not retry or bypass that restriction.
The app's narrowly scoped, authorized-device diagnostic is an independent
route and does not read those account logs. Broad secret-variable reads were
also rejected earlier; do not repeat them or disclose server credentials.

Do not reset the tablet, clear its history, change admin credentials, alter
Revolution, create fake production payroll entries, or void recovered entries
as part of this incident without the appropriate user instruction.

## Completion evidence still required

1. Explain and resolve the failed server-to-sheet check, or demonstrate a
   transient failure with sufficient evidence rather than assuming one.
2. Verify the exact live Richmond release and recovery behavior; preserve
   local entries until complete acknowledgments arrive.
3. Confirm a normal sign-in from the actual tablet at Richmond arrives in
   the production sheet. Home tests cannot substitute for this.
4. Only then report the Richmond operational outcome. Broader remote-customer
   readiness additionally needs visible upload status and useful remote
   diagnostics; it has not been established.
