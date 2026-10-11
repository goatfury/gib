import { readFile, writeFile } from 'node:fs/promises';
import { reconcileReplyPayroll } from '../netlify/functions/_lib/m1-reply-intake.mjs';
// Supply a saved queue review plus independently obtained authoritative exports.
// This command cannot write attendance, mark a queue item complete, or pay anyone.
const [reviewPath, evidencePath, outputPath] = process.argv.slice(2);
if (!reviewPath || !evidencePath || !outputPath) throw new Error('Expected review.json evidence.json new-report.json');
const result = reconcileReplyPayroll(JSON.parse(await readFile(reviewPath, 'utf8')), JSON.parse(await readFile(evidencePath, 'utf8')));
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
if (result.state === 'held') process.exitCode = 2;
