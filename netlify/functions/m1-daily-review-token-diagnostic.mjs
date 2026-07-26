import { createHash } from 'node:crypto';

const PREVIEW_HOST = /^deploy-preview-43--gib-live\.netlify\.app$/i;
const NONCE_SHA256 = '8f36fb1da108f8839697733dbcfc8df2931a0ef563137d737fb8f3ca2165a76f';

function fingerprint(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export default async function handler(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return json(404, { ok: false });
  }

  if (request.method !== 'POST' || !PREVIEW_HOST.test(url.hostname)) {
    return json(404, { ok: false });
  }

  const nonce = request.headers.get('x-gib-diagnostic-nonce') || '';
  const nonceHash = createHash('sha256').update(nonce, 'utf8').digest('hex');
  if (nonceHash !== NONCE_SHA256) {
    return json(404, { ok: false });
  }

  const token = String(process.env.GIB_TEST_WEBHOOK_TOKEN ?? '');
  return json(200, {
    ok: true,
    metadata: {
      length: [...token].length,
      beginsWhitespace: /^\s/u.test(token),
      endsWhitespace: /\s$/u.test(token),
      beginsQuote: /^["']/u.test(token),
      endsQuote: /["']$/u.test(token),
      sha256Prefix: fingerprint(token)
    }
  });
}
