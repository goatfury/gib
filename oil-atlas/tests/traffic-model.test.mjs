import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransitCsv, PRE_CRISIS_PORTWATCH_MEDIAN } from '../netlify/functions/hormuz-traffic.mjs';

const header = 'date,n_total,n_tanker,n_cargo';
const filler = Array.from({ length: 120 }, (_, i) => {
  const day = String((i % 28) + 1).padStart(2, '0');
  const month = String(9 + Math.floor(i / 28)).padStart(2, '0');
  const year = Number(month) > 12 ? 2026 : 2025;
  const adjustedMonth = Number(month) > 12 ? String(Number(month) - 12).padStart(2, '0') : month;
  return `${year}-${adjustedMonth}-${day},73,40,33`;
});

// Replace four dated rows with the actual collapse sequence while keeping the fixture long enough.
filler[0] = '2026-02-28,51,33,18';
filler[1] = '2026-03-01,18,5,13';
filler[2] = '2026-03-02,4,1,3';
filler[3] = '2026-03-04,0,0,0';

const records = parseTransitCsv([header, ...filler].join('\n'));

test('daily transit parser preserves the actual four-day cliff', () => {
  const byDate = new Map(records.map((row) => [row.date, row]));
  assert.equal(byDate.get('2026-02-28').total, 51);
  assert.equal(byDate.get('2026-03-01').total, 18);
  assert.equal(byDate.get('2026-03-02').total, 4);
  assert.equal(byDate.get('2026-03-04').total, 0);
});

test('tanker and cargo categories sum to every total', () => {
  for (const row of records) assert.equal(row.tanker + row.cargo, row.total);
});

test('consistent PortWatch visual baseline remains distinct from broader industry scope', () => {
  assert.equal(PRE_CRISIS_PORTWATCH_MEDIAN, 73);
});

test('parser rejects inconsistent category totals', () => {
  const broken = [header, ...filler, '2026-08-16,3,3,3'].join('\n');
  assert.equal(parseTransitCsv(broken).some((row) => row.date === '2026-08-16'), false);
});
