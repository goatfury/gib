# Attendance reminders and forgotten clock-outs — Revolution TEST

This work is confined to https://deploy-preview-89--gib-live.netlify.app/m1/admin/ and the separate Revolution TEST Google project. PR89 remains draft and unmerged. Both production gyms, Richmond deployments and permissions are outside this change. No TEST records move to live data, and neither Walter record is a QA fixture.

## Daily digest

The digest is a capture, not an email send. There is no email provider or enabled send branch. Andrew and Stu have named recipient configuration slots, but their addresses are unset. Setting a recipient does not grant Admin access. The only connected deployed gym for this capture is Revolution TEST; multiple gyms are tested with isolated fixtures.

The proposed default is **10 p.m. America/New_York**, subject to confirmation that all classes have finished. The source schedule contains start times, not verified end times. Payroll duration defaults are not used to invent class finishes. Until the closing cutoff is confirmed, unattended jobs record dated schedule observations but do not claim missing attendance or create a scheduled digest. Manual captures clearly report missing schedule/finish evidence. Admin configuration requires an explicit confirmation that the chosen cutoff is after the final class.

Install `testRevolutionAttendanceDigestTick` as a time-driven, every-15-minutes trigger through the separate TEST project's Google editor. The job runs without a browser. The configured cutoff makes the first successful tick at or after that time due; Google's timer may add scheduling delay. A fixed authenticated TEST callback carries current authoritative read results to the preview's capture endpoint. The existing external-request permission is used; no mail or programmatic-trigger permission is added. Stop at any unexpected Google consent prompt. Creating a Netlify scheduled function would not run on this deploy preview.

Each Google request is persisted before dispatch and has a 60-second binding. It uses the existing server-side action credential, a distinct signed schema, the exact gym and a fixed destination. Authoritative read locks are released before delivery. Full attendance and rendered captures stay behind existing Admin authentication. Netlify persists each request and the daily outbox before capture; the daily date is the message identity. Concurrent or repeated jobs recover that same message instead of creating duplicates. A separate manual capture identity does not consume the daily slot. Captured content is immutable; later data appears in the next daily digest. Capture failures and requests remain available for recovery. Separate sanitized Google receipts expire after 24 hours; later successes cannot erase them.

The digest lists a finished scheduled occurrence only when it has no valid instructor sign-in. One valid instructor satisfies this check; additional-instructor correction stays available. An unreviewed day alone is not an email trigger and is never automatically marked complete. Existing attendance warnings, unresolved class questions, contradictory cancellations and hourly Staff Clock problems remain visible. A resolved cancellation is excluded. Late uploads and corrections are reread for the next digest.

Current weekly schedules are evidence only for the current gym date. Dated observations and authoritative saved day snapshots provide history; the system does not copy today's schedule into unknown historical dates. Missing historical schedule coverage, unavailable attendance, and unavailable Staff Clock reads appear as separate failed checks, never invented missing instructors or an all-clear.

## Staff Clock recovery

An employee with an unfinished earlier shift can choose **Start a new shift instead**, then propose the previous finish or select **I'm not sure**. The new clock-in gets its own permanent ID and actual start time. The old raw punch stays unchanged and unresolved. The proposal is not paid time and is not automatically approved. The new shift can be clocked out normally while the earlier one awaits a manager.

The browser keeps the complete original request in a separate recovery journal before sending. Reload and reconnect check authoritative evidence for that same request. An incomplete or mismatched receipt retains the original operation and blocks a replacement. Safe retries reuse its ID and timestamp. Neither the instructor queue nor existing Staff Clock storage is cleared.

Authorized managers review proposals inside the existing Staff Clock Admin section. Approval reuses the audited missed-punch correction path under its existing lock. The append-only recovery journal retains the employee's proposal, timestamps, original punches and manager decision. Approval validates the previous shift boundary and prevents impossible dates or overlaps; genuine overnight shifts retain their ordinary clock-out path. An unknown finish remains a question for the manager, never guessed hours. Staff Clock items remain separate from instructor attendance even when both appear in the digest.

## Verification and limits

The final task receipt records the reviewed commit, TEST deployment, Google version, hosted synthetic QA and required CI. Unit fixtures cover multi-gym behavior without deploying Richmond. Existing instructor review, correction, addition recovery and payroll evidence is reused where unchanged.

Real email delivery, real recipients, live use and a Stu session are not verified or authorized. Historical missing Google callbacks and the old browser response cutoff remain separate incidents; this work does not claim to have established their common cause or eliminated upstream failures. Any incomplete save evidence must remain pending and recover using the original request.
