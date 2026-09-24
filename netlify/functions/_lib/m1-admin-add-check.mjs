import { sanitizeAdminAdditionPayload, sanitizeDailyReviewPayload } from './m1-admin-contracts.mjs';

// This proof is deliberately narrower than the write receipt: only the exact
// retained Admin-created row and its one matching audit can confirm a save.
// Absence, an existing-event result, or ambiguous history never permits resend.
export function additionReceiptFromDailyReview(input, original, adminName) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join('|') !== ['ok', 'test', 'adminName', 'date', 'records', 'warnings', 'auditHistory'].sort().join('|')
    || input.ok !== true || input.test !== true || input.adminName !== adminName) return null;
  const daily = sanitizeDailyReviewPayload({ ok: input.ok, date: input.date, records: input.records,
    warnings: input.warnings, auditHistory: input.auditHistory }, original.date, { managerReviewTestSite: 'Rev' });
  if (!daily || daily.warnings.length) return null;
  const linkedRecordId = `gib-admin-${original.requestId}`;
  const rows = daily.records.filter(row => row.recordId === linkedRecordId);
  const audits = daily.auditHistory.filter(audit => audit.linkedRecordId === linkedRecordId);
  if (rows.length !== 1 || audits.length !== 1) return null;
  const row = rows[0], audit = audits[0];
  const attributedNotes = `Admin-added | Admin: ${adminName} | Reason: ${original.reason}${original.notes ? ` | Notes: ${original.notes}` : ''}`;
  if (row.source !== 'Admin-added' || row.reviewRequired || !row.timestamp
    || row.notes !== attributedNotes || row.site !== 'Rev'
    || ['date', 'classLabel', 'duration', 'instructor', 'site'].some(key => row[key] !== original[key])
    || audit.result !== 'added' || audit.adminName !== adminName || audit.classDate !== original.date
    || ['classLabel', 'duration', 'instructor', 'site', 'reason'].some(key => audit[key] !== original[key])) return null;
  return sanitizeAdminAdditionPayload({ ok: true, result: 'added', requestId: original.requestId,
    linkedRecordId, linkedDisplayId: row.displayId, auditActionNumber: audit.actionNumber,
    confirmation: { adminName, date: original.date, classLabel: original.classLabel, duration: original.duration,
      instructor: original.instructor, site: original.site, reason: original.reason, notes: original.notes }
  }, { ...original, adminName });
}
