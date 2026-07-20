import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGET = 'https://6a5d70003c4efd9e026ee2b3--tecmo-super-bo-apocalypse-preview.netlify.app/';
const OUT = path.resolve('qa-public');
await mkdir(OUT, { recursive: true });

const report = {
  target: TARGET,
  fetchedAt: new Date().toISOString(),
  ok: false,
  status: null,
  finalUrl: null,
  contentType: null,
  bytes: 0,
  sha256: null,
  markers: {},
  error: null,
};

try {
  const response = await fetch(TARGET, { redirect: 'follow' });
  const source = await response.text();
  report.ok = response.ok;
  report.status = response.status;
  report.finalUrl = response.url;
  report.contentType = response.headers.get('content-type');
  report.bytes = Buffer.byteLength(source);
  report.sha256 = createHash('sha256').update(source).digest('hex');

  const markerPatterns = {
    twoMinuteQuarter: /QUARTER_SECONDS\s*=\s*(?:120|2\s*\*\s*60)\b/,
    oldFiveMinuteQuarter: /QUARTER_SECONDS\s*=\s*5\s*\*\s*60\b/,
    ballCameraTelemetry: /cameraSubject|footballScreenX|activeCarrierVisible|footballWorldX/gi,
    offscreenBoTelemetry: /boOffscreenDirection|boOffscreenDistance|boVisible/gi,
    cleanStartTelemetry: /freshGameSceneClean|giantSkeletonCorpseCount|skeletonCorpseCount/gi,
    q2Story: /ALIENS INVADE EARTH|DESTROY THE MOTHERSHIP|ALIEN INVASION/gi,
    q3Story: /OLYMPUS TAKES THE FIELD|DEFEAT THE GODS|ZEUS WAITS/gi,
    q4Story: /ONLY BO SURVIVES|LAST GAME ON EARTH|BEAT THE MACHINES/gi,
    qaApi: /__tecmoBoQA/,
    snapshotApi: /__tecmoBoSnapshot/,
  };
  for (const [name, expression] of Object.entries(markerPatterns)) {
    const matches = source.match(expression) || [];
    report.markers[name] = { present: matches.length > 0, count: matches.length };
  }

  await writeFile(path.join(OUT, 'live-source.html'), source);
} catch (error) {
  report.error = String(error?.stack || error);
}

await writeFile(path.join(OUT, 'metadata.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Ball Camera Cut QA Evidence</title><style>body{font:16px system-ui;max-width:860px;margin:40px auto;padding:0 20px;background:#111;color:#eee}a{color:#7ee7ff}pre{white-space:pre-wrap;background:#1b1b1b;padding:18px;border-radius:8px}</style><h1>Ball Camera Cut QA Evidence</h1><p><a href="metadata.json">metadata.json</a> · <a href="live-source.html">exact captured source</a></p><pre id="out">Loading…</pre><script>fetch('metadata.json').then(r=>r.json()).then(x=>out.textContent=JSON.stringify(x,null,2)).catch(e=>out.textContent=String(e))</script>`);

console.log(JSON.stringify(report));
process.exitCode = 0;
