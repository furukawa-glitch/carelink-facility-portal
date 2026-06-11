/**
 * Google Sheets API をサーバー経由で呼ぶ（APIキーのリファラー制限・CORS を回避）
 * GET /api/sheets-proxy/v4/spreadsheets/...
 */

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'GET only' });
    return;
  }

  const apiKey = String(
    process.env.VITE_GOOGLE_SHEETS_API_KEY ?? process.env.GOOGLE_SHEETS_API_KEY ?? ''
  ).trim();
  if (!apiKey) {
    sendJson(res, 503, {
      ok: false,
      error: 'VITE_GOOGLE_SHEETS_API_KEY が Vercel に設定されていません。',
    });
    return;
  }

  const raw = String(req.url ?? '');
  const pathOnly = raw.replace(/^\/api\/sheets-proxy/, '').split('?')[0];
  if (!pathOnly.startsWith('/v4/spreadsheets/')) {
    sendJson(res, 400, { ok: false, error: 'Invalid sheets path' });
    return;
  }

  const qIdx = raw.indexOf('?');
  const params = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
  params.set('key', apiKey);
  const target = `https://sheets.googleapis.com${pathOnly}?${params.toString()}`;

  try {
    const upstream = await fetch(target, { cache: 'no-store' });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendJson(res, 502, { ok: false, error: msg });
  }
}
