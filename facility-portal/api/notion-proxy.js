/**
 * Notion API をサーバー経由で呼ぶ（トークンをブラウザに出さない）
 * POST/GET /notion-api/... → Vercel rewrite 経由で /api/notion-proxy
 */

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/** @param {import('http').IncomingMessage} req */
function notionPathFromRequest(req) {
  const rawUrl = String(req.url ?? '');
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const prefix = '/api/notion-proxy';
  if (pathname.startsWith(prefix)) {
    const fromPathname = pathname.slice(prefix.length) || '/';
    if (fromPathname !== '/') return fromPathname;
  }
  const rewritePath = req.query?.path;
  if (rewritePath != null) {
    const segments = Array.isArray(rewritePath)
      ? rewritePath.map((p) => String(p ?? ''))
      : [String(rewritePath)];
    const joined = segments.filter(Boolean).join('/');
    if (joined) return `/${joined}`;
  }
  return '';
}

/** @param {import('http').IncomingMessage} req */
async function readJsonPayload(req) {
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export default async function handler(req, res) {
  const token = String(
    process.env.VITE_NOTION_INTEGRATION_TOKEN || process.env.NOTION_INTEGRATION_TOKEN || ''
  ).trim();
  if (!token) {
    sendJson(res, 503, {
      ok: false,
      error: 'VITE_NOTION_INTEGRATION_TOKEN が Vercel に設定されていません。',
    });
    return;
  }

  const notionPath = notionPathFromRequest(req);
  if (!notionPath) {
    sendJson(res, 400, { ok: false, error: 'Notion API path が不正です。' });
    return;
  }

  const method = String(req.method ?? 'GET').toUpperCase();
  const url = `https://api.notion.com/v1${notionPath}`;
  const body = method === 'POST' || method === 'PATCH' ? await readJsonPayload(req) : undefined;

  try {
    const upstream = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  } catch (e) {
    sendJson(res, 502, {
      ok: false,
      error: e instanceof Error ? e.message : 'Notion プロキシエラー',
    });
  }
}
