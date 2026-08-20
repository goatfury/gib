const SOURCE_URL = 'https://raw.githubusercontent.com/jasonhjohnson/strait-of-hormuz-data/main/data/transits.csv';
const START_DATE = '2025-09-01';
const TIMEOUT_MS = 12_000;
export const PRE_CRISIS_PORTWATCH_MEDIAN = 73;

export function parseTransitCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (!/^date,n_total,n_tanker,n_cargo/.test(lines[0] || '')) throw new Error('Unexpected transit CSV header');
  const records = [];
  for (const line of lines.slice(1)) {
    const [date, total, tanker, cargo] = line.split(',');
    if (!date || date < START_DATE) continue;
    const row = { date, total: Number(total), tanker: Number(tanker), cargo: Number(cargo) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    if (![row.total, row.tanker, row.cargo].every(Number.isFinite)) continue;
    if (row.total < 0 || row.tanker < 0 || row.cargo < 0) continue;
    if (row.tanker + row.cargo !== row.total) continue;
    records.push(row);
  }
  if (records.length < 120) throw new Error(`Transit series too short: ${records.length}`);
  return records;
}

async function getRecords() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(SOURCE_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Oil-Flow-Atlas/1.0' },
    });
    if (!response.ok) throw new Error(`Source returned ${response.status}`);
    return parseTransitCsv(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

export default async () => {
  try {
    const records = await getRecords();
    return new Response(JSON.stringify({
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      source: 'IMF PortWatch daily commercial transits via the daily-refreshed straits.live data mirror',
      sourceUrl: SOURCE_URL,
      scope: 'Commercial AIS-tracked tanker and cargo vessels. Dark and military vessels are excluded.',
      preCrisisPortWatchMedian: PRE_CRISIS_PORTWATCH_MEDIAN,
      broaderIndustryNormal: 'approximately 130–138 vessels/day under wider industry definitions',
      latestPublishedDate: records.at(-1)?.date || null,
      records,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=21600, stale-while-revalidate=86400',
        'Netlify-Cache-Tag': 'hormuz-traffic-data',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      schemaVersion: 1,
      error: `Traffic source failed: ${error?.name || 'Error'}`,
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
};

export const config = { path: '/api/hormuz_traffic' };
