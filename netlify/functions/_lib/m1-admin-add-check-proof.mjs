import { createHash } from 'node:crypto';
import { validateAddition } from '../m1-admin-add.mjs';
import { safeAdditionTraceId } from './m1-google-trace.mjs';
import { sanitizeDailyReviewPayload } from './m1-admin-contracts.mjs';
import { additionReceiptFromDailyReview } from './m1-admin-add-check.mjs';
import { REVIEW_START, validateRead } from './m1-manager-review.mjs';

const fields = ['requestId', 'date', 'classLabel', 'duration', 'instructor', 'site', 'notes', 'reason'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

export function additionCheckHash(original, reviewer, target) {
  if (!['test', 'production'].includes(target) || !['Andrew Smith', 'Stuart Turner'].includes(reviewer)
    || !exact(original, fields)) throw new Error('Invalid original addition binding.');
  const validated = validateAddition(original, { preview: target === 'test' }, new Date(`${original.date}T17:00:00Z`));
  if (!validated || !safeAdditionTraceId(original.requestId) || original.site !== 'Rev'
    || fields.some(field => original[field] !== validated[field])
    || original.date < REVIEW_START
    || (target === 'production' && !original.requestId.startsWith('m1-'))
    || (original.requestId.startsWith('m1-') && original.requestId.slice(3, 13) !== original.date)) throw new Error('Invalid original addition binding.');
  return createHash('sha256').update(JSON.stringify(['adminAdditionCheckRead', target, 'rev', reviewer, ...fields.map(field => original[field])]), 'utf8').digest('hex');
}

export function validateAdditionCheckCallback(result, original, reviewer, target) {
  const originalHash = additionCheckHash(original, reviewer, target);
  if (!exact(result, ['ok', 'schema', 'target', 'gym', 'originalHash', 'date', 'reviewer', 'dailyRead', 'ledger'])
    || result.ok !== true || result.schema !== 'm1-admin-addition-check/v1' || result.target !== target
    || result.gym !== 'rev' || result.originalHash !== originalHash || result.date !== original.date || result.reviewer !== reviewer
    || !exact(result.dailyRead, ['ok', 'test', 'adminName', 'date', 'records', 'warnings', 'auditHistory'])
    || result.dailyRead.test !== (target === 'test') || result.dailyRead.adminName !== reviewer) throw new Error('Addition proof belongs to a different request.');
  const daily = result.dailyRead;
  if (!sanitizeDailyReviewPayload({ ok: daily.ok, date: daily.date, records: daily.records, warnings: daily.warnings, auditHistory: daily.auditHistory },
    original.date, target === 'production' ? { allowRevolutionRemoval: true } : { managerReviewTestSite: 'Rev' })) throw new Error('Addition proof is incomplete.');
  validateRead(result.ledger, 'rev', result.ledger?.to, target);
  if (original.date > result.ledger.to) throw new Error('Addition proof date is unavailable.');
  const receipt = additionReceiptFromDailyReview(daily, original, reviewer, target);
  // A callback may safely report a complete read without confirming this save.
  // Unreadable, duplicate or changed manager evidence must keep the journal open.
  const day = result.ledger.days.find(item => item.date === original.date);
  const records = result.ledger.days.flatMap(item => item.records);
  const matches = receipt ? records.filter(record => record.recordId === receipt.linkedRecordId) : [];
  const source = receipt ? daily.records.find(record => record.recordId === receipt.linkedRecordId) : null;
  const agrees = source && matches.length === 1 && ['recordId', 'timestamp', 'date', 'classLabel', 'duration', 'instructor', 'site', 'notes'].every(field => matches[0][field] === source[field]);
  return { receipt: receipt && day && !day.warnings.length && agrees ? receipt : null, ledger: result.ledger };
}
