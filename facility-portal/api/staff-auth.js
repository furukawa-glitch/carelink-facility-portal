/**
 * Vercel Serverless: 職員ログイン（職員コード + パスワード）
 * POST /api/staff-auth
 *
 * actions: login | validate | list | create | reset_password | set_active | bootstrap
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
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
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveEnv() {
  const supabaseUrl = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
  ).trim();
  const sessionSecret = String(process.env.STAFF_SESSION_SECRET || process.env.CARE_SYNC_SECRET || '').trim();
  const bootstrapSecret = String(process.env.STAFF_BOOTSTRAP_SECRET || '').trim();
  const defaultOrgId = String(
    process.env.CARELINK_ORGANIZATION_ID || process.env.VITE_CARELINK_ORGANIZATION_ID || '',
  ).trim();
  return { supabaseUrl, serviceKey, sessionSecret, bootstrapSecret, defaultOrgId };
}

/** @param {string} password */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * @param {string} password
 * @param {string} stored
 */
function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  if (!salt || !hash) return false;
  try {
    const test = scryptSync(String(password), salt, 64).toString('hex');
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 */
function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * @param {string} token
 * @param {string} secret
 */
function verifyToken(token, secret) {
  const raw = String(token ?? '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @param {string} serviceKey
 * @param {string} pathQuery
 */
async function supabaseGet(url, serviceKey, pathQuery) {
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${pathQuery}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${pathQuery}: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * @param {string} url
 * @param {string} serviceKey
 * @param {string} path
 * @param {string} method
 * @param {unknown} body
 */
async function supabaseWrite(url, serviceKey, path, method, body) {
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {unknown} row */
function publicStaffRow(row) {
  if (!row || typeof row !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  return {
    id: String(r.id ?? ''),
    staffCode: String(r.staff_code ?? ''),
    displayName: String(r.display_name ?? ''),
    isAdmin: Boolean(r.is_admin),
    active: Boolean(r.active),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {ReturnType<typeof resolveEnv>} env
 */
async function requireAdminSession(payload, env) {
  const token = String(payload.sessionToken ?? '').trim();
  const session = verifyToken(token, env.sessionSecret);
  if (!session || !session.sub || !session.org) {
    throw new Error('管理者としてログインし直してください。');
  }
  if (!session.adm) {
    throw new Error('職員アカウント管理には管理者権限が必要です。');
  }
  const rows = await supabaseGet(
    env.supabaseUrl,
    env.serviceKey,
    `staff_accounts?id=eq.${encodeURIComponent(String(session.sub))}&organization_id=eq.${encodeURIComponent(String(session.org))}&select=id,staff_code,display_name,is_admin,active`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.active || !row.is_admin) {
    throw new Error('管理者アカウントが無効です。');
  }
  return { session, orgId: String(session.org) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST only' });
    return;
  }

  const env = resolveEnv();
  if (!env.supabaseUrl || !env.serviceKey) {
    sendJson(res, 503, { ok: false, error: 'Supabase が未設定です（SUPABASE_SERVICE_ROLE_KEY 等）。' });
    return;
  }
  if (!env.sessionSecret) {
    sendJson(res, 503, { ok: false, error: 'STAFF_SESSION_SECRET（または CARE_SYNC_SECRET）が未設定です。' });
    return;
  }

  const body = await readJsonPayload(req);
  const action = String(body.action ?? '').trim();

  try {
    if (action === 'login') {
      const orgId = String(body.organizationId ?? env.defaultOrgId ?? '').trim();
      const staffCode = String(body.staffCode ?? '')
        .trim()
        .replace(/\s+/g, '');
      const password = String(body.password ?? '');
      if (!orgId) {
        sendJson(res, 400, { ok: false, error: 'organizationId が未設定です。' });
        return;
      }
      if (!staffCode || !password) {
        sendJson(res, 400, { ok: false, error: '職員コードとパスワードを入力してください。' });
        return;
      }
      const rows = await supabaseGet(
        env.supabaseUrl,
        env.serviceKey,
        `staff_accounts?organization_id=eq.${encodeURIComponent(orgId)}&staff_code=eq.${encodeURIComponent(staffCode)}&select=id,staff_code,display_name,password_hash,is_admin,active`,
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row || !row.active) {
        sendJson(res, 401, { ok: false, error: '職員コードまたはパスワードが違います。' });
        return;
      }
      if (!verifyPassword(password, row.password_hash)) {
        sendJson(res, 401, { ok: false, error: '職員コードまたはパスワードが違います。' });
        return;
      }
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const token = signToken(
        {
          sub: row.id,
          org: orgId,
          code: row.staff_code,
          name: row.display_name,
          adm: Boolean(row.is_admin),
          exp: expiresAt,
        },
        env.sessionSecret,
      );
      sendJson(res, 200, {
        ok: true,
        token,
        expiresAt,
        staff: {
          id: row.id,
          staffCode: row.staff_code,
          displayName: row.display_name,
          isAdmin: Boolean(row.is_admin),
        },
      });
      return;
    }

    if (action === 'validate') {
      const token = String(body.sessionToken ?? '').trim();
      const session = verifyToken(token, env.sessionSecret);
      if (!session) {
        sendJson(res, 200, { ok: false, valid: false });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        valid: true,
        staff: {
          id: String(session.sub ?? ''),
          staffCode: String(session.code ?? ''),
          displayName: String(session.name ?? ''),
          isAdmin: Boolean(session.adm),
        },
        expiresAt: Number(session.exp ?? 0),
      });
      return;
    }

    if (action === 'list') {
      const { orgId } = await requireAdminSession(body, env);
      const rows = await supabaseGet(
        env.supabaseUrl,
        env.serviceKey,
        `staff_accounts?organization_id=eq.${encodeURIComponent(orgId)}&select=id,staff_code,display_name,is_admin,active,created_at,updated_at&order=staff_code.asc`,
      );
      sendJson(res, 200, {
        ok: true,
        staff: (Array.isArray(rows) ? rows : []).map(publicStaffRow).filter(Boolean),
      });
      return;
    }

    if (action === 'create') {
      const { orgId } = await requireAdminSession(body, env);
      const staffCode = String(body.staffCode ?? '')
        .trim()
        .replace(/\s+/g, '');
      const displayName = String(body.displayName ?? '').trim();
      const password = String(body.password ?? '');
      const isAdmin = Boolean(body.isAdmin);
      if (!staffCode || !displayName || password.length < 4) {
        sendJson(res, 400, {
          ok: false,
          error: '職員コード・氏名・パスワード（4文字以上）を入力してください。',
        });
        return;
      }
      const created = await supabaseWrite(env.supabaseUrl, env.serviceKey, 'staff_accounts', 'POST', {
        organization_id: orgId,
        staff_code: staffCode,
        display_name: displayName,
        password_hash: hashPassword(password),
        is_admin: isAdmin,
        active: true,
      });
      const row = Array.isArray(created) ? created[0] : created;
      sendJson(res, 200, { ok: true, staff: publicStaffRow(row) });
      return;
    }

    if (action === 'reset_password') {
      const { orgId } = await requireAdminSession(body, env);
      const staffAccountId = String(body.staffAccountId ?? '').trim();
      const password = String(body.password ?? '');
      if (!staffAccountId || password.length < 4) {
        sendJson(res, 400, { ok: false, error: '職員と新パスワード（4文字以上）を指定してください。' });
        return;
      }
      const updated = await supabaseWrite(
        env.supabaseUrl,
        env.serviceKey,
        `staff_accounts?id=eq.${encodeURIComponent(staffAccountId)}&organization_id=eq.${encodeURIComponent(orgId)}`,
        'PATCH',
        { password_hash: hashPassword(password) },
      );
      const row = Array.isArray(updated) ? updated[0] : updated;
      sendJson(res, 200, { ok: true, staff: publicStaffRow(row) });
      return;
    }

    if (action === 'set_active') {
      const { orgId } = await requireAdminSession(body, env);
      const staffAccountId = String(body.staffAccountId ?? '').trim();
      const active = Boolean(body.active);
      if (!staffAccountId) {
        sendJson(res, 400, { ok: false, error: '職員を指定してください。' });
        return;
      }
      const updated = await supabaseWrite(
        env.supabaseUrl,
        env.serviceKey,
        `staff_accounts?id=eq.${encodeURIComponent(staffAccountId)}&organization_id=eq.${encodeURIComponent(orgId)}`,
        'PATCH',
        { active },
      );
      const row = Array.isArray(updated) ? updated[0] : updated;
      sendJson(res, 200, { ok: true, staff: publicStaffRow(row) });
      return;
    }

    if (action === 'bootstrap') {
      const orgId = String(body.organizationId ?? env.defaultOrgId ?? '').trim();
      const secret = String(body.bootstrapSecret ?? '').trim();
      const staffCode = String(body.staffCode ?? '')
        .trim()
        .replace(/\s+/g, '');
      const displayName = String(body.displayName ?? '').trim();
      const password = String(body.password ?? '');
      if (!env.bootstrapSecret) {
        sendJson(res, 503, { ok: false, error: 'STAFF_BOOTSTRAP_SECRET が未設定です。' });
        return;
      }
      if (secret !== env.bootstrapSecret) {
        sendJson(res, 403, { ok: false, error: 'ブートストラップ秘密鍵が違います。' });
        return;
      }
      if (!orgId || !staffCode || !displayName || password.length < 4) {
        sendJson(res, 400, { ok: false, error: '組織ID・職員コード・氏名・パスワードが必要です。' });
        return;
      }
      const existing = await supabaseGet(
        env.supabaseUrl,
        env.serviceKey,
        `staff_accounts?organization_id=eq.${encodeURIComponent(orgId)}&select=id&limit=1`,
      );
      if (Array.isArray(existing) && existing.length > 0) {
        sendJson(res, 409, { ok: false, error: '既に職員アカウントがあります。管理者ログインから追加してください。' });
        return;
      }
      const created = await supabaseWrite(env.supabaseUrl, env.serviceKey, 'staff_accounts', 'POST', {
        organization_id: orgId,
        staff_code: staffCode,
        display_name: displayName,
        password_hash: hashPassword(password),
        is_admin: true,
        active: true,
      });
      const row = Array.isArray(created) ? created[0] : created;
      sendJson(res, 200, { ok: true, staff: publicStaffRow(row) });
      return;
    }

    sendJson(res, 400, { ok: false, error: `不明な action: ${action}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendJson(res, 500, { ok: false, error: msg });
  }
}
