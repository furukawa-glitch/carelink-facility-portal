/**
 * Vercel Serverless: ブラウザ → 同一オリジン → ここ → Google Apps Script
 * （script.google.com への直 fetch は本番ドメインで CORS に阻まれ Failed to fetch になりやすい）
 */

function resolveGasEnv() {
  const gasUrl = String(
    process.env.VITE_NEAR_MISS_APPS_SCRIPT_URL || process.env.NEAR_MISS_APPS_SCRIPT_URL || ''
  ).trim();
  /** 本番は NEAR_MISS_APP_SECRET を優先（VITE_ が古い値のまま残ると GAS と不一致になりやすい） */
  const secret = String(
    process.env.NEAR_MISS_APP_SECRET || process.env.VITE_NEAR_MISS_APP_SECRET || ''
  ).trim();
  return { gasUrl, secret };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

/**
 * Vercel / 一部環境では req.body が未パースのため、ストリームから読む
 * @param {import('http').IncomingMessage} req
 */
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
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const { gasUrl, secret } = resolveGasEnv();
  if (!gasUrl || !secret) {
    return sendJson(res, 500, {
      ok: false,
      error:
        'GAS proxy: VITE_NEAR_MISS_APPS_SCRIPT_URL とシークレット（NEAR_MISS_APP_SECRET または VITE_NEAR_MISS_APP_SECRET）を Vercel の Environment Variables に設定してください。',
    });
  }

  const payload = await readJsonPayload(req);

  const { action, ...rest } = payload;
  if (!action || typeof action !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'Missing action' });
  }

  try {
    const gasRes = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, action, ...rest }),
    });
    const text = await gasRes.text();
    res.statusCode = gasRes.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return sendJson(res, 500, { ok: false, error: msg });
  }
}
