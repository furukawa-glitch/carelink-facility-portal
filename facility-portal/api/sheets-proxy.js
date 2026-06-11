/**
 * Google Sheets API をサーバー経由で呼ぶ（APIキーのリファラー制限・CORS を回避）
 * GET /api/sheets-proxy/v4/spreadsheets/...
 *
 * Vite 単体では api/[[...path]] の catch-all が効かないため、vercel.json の rewrite でここに集約する。
 */

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/** @param {import('http').IncomingMessage} req */
function sheetsPathFromRequest(req) {
  const rawUrl = String(req.url ?? '');
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const prefix = '/api/sheets-proxy';
  if (!pathname.startsWith(prefix)) return '';
  return pathname.slice(prefix.length) || '/';
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

  const pathOnly = sheetsPathFromRequest(req);
  if (!pathOnly.startsWith('/v4/spreadsheets/')) {
    sendJson(res, 400, { ok: false, error: 'Invalid sheets path' });
    return;
  }

  const rawUrl = String(req.url ?? '');
  const qIdx = rawUrl.indexOf('?');
  const params = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '');
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
