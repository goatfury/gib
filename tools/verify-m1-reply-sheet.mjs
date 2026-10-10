// Offline verifier for connector-read values. Never opens credentials, changes
// the Sheet, creates a schedule, sends mail or writes attendance/payroll.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyReplyProjection } from '../netlify/functions/_lib/m1-reply-projection.mjs';
if (!process.argv[2]) throw new Error('Provide a local JSON file containing gym, before, replies, after, receipts and now.');
const input = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
console.log(JSON.stringify(verifyReplyProjection(input), null, 2));
