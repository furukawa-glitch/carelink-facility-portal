/**
 * Vercel Serverless: 生活記録 → Supabase（service_role、ブラウザに鍵を出さない）
 * POST /api/care-sync  { secret, action, organizationId, events?, snapshot? }
 *
 * ※ facility-portal/api/care-sync.js と同一仕様（同じ Supabase・組織・シークレットを使うこと）。
 *   入力アプリでは upsert_events / pull_residents / ping を主に使用します。
 */

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

function resolveCareSyncEnv() {
  const supabaseUrl = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
  ).trim();
  const secret = String(process.env.CARE_SYNC_SECRET || process.env.VITE_CARE_SYNC_SECRET || '').trim();
  const defaultOrgId = String(
    process.env.CARELINK_ORGANIZATION_ID || process.env.VITE_CARELINK_ORGANIZATION_ID || ''
  ).trim();
  return { supabaseUrl, serviceKey, secret, defaultOrgId };
}

async function supabaseRest(url, serviceKey, path, method, body) {
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${path}: ${res.status} ${text.slice(0, 400)}`);
  }
}

/** 他PCへ Realtime broadcast（保存直後に pull トリガー） */
async function broadcastCareEventsUpdated(url, serviceKey, organizationId) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url, serviceKey);
    const topic = `carelink-sync:${organizationId}`;
    const channel = sb.channel(topic, { config: { broadcast: { self: false } } });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('realtime subscribe timeout')), 8000);
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          resolve(undefined);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timeout);
          reject(err ?? new Error(String(status)));
        }
      });
    });
    await channel.send({
      type: 'broadcast',
      event: 'events_updated',
      payload: { at: new Date().toISOString() },
    });
    await sb.removeChannel(channel);
  } catch {
    // broadcast 失敗は upsert 成功を阻害しない（ポーリングがフォールバック）
  }
}

async function supabaseSelectJson(url, serviceKey, path) {
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${path}: ${res.status} ${text.slice(0, 400)}`);
  }
  const json = await res.json().catch(() => []);
  return Array.isArray(json) ? json : [];
}

/** @param {Record<string, unknown>} e */
function mapCareEventRow(organizationId, e) {
  const clientId = String(e.id ?? e.client_event_id ?? '').trim();
  if (!clientId) return null;
  const tsRaw = String(e.ts ?? e.event_ts ?? '').trim();
  const parsed = tsRaw ? new Date(tsRaw) : new Date();
  const eventTs = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  return {
    organization_id: organizationId,
    client_event_id: clientId,
    resident_id: String(e.residentId ?? e.resident_id ?? '').trim() || null,
    resident_name: String(e.residentName ?? e.resident_name ?? '').trim() || null,
    facility_sheet_title: String(e.facilitySheetTitle ?? e.facility_sheet_title ?? '').trim() || null,
    event_type: String(e.type ?? e.event_type ?? 'other').trim() || 'other',
    event_ts: eventTs,
    payload: e,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST only' });
    return;
  }

  const { supabaseUrl, serviceKey, secret, defaultOrgId } = resolveCareSyncEnv();
  if (!supabaseUrl || !serviceKey || !secret) {
    sendJson(res, 503, {
      ok: false,
      error:
        'care-sync: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CARE_SYNC_SECRET を Vercel に設定してください。',
    });
    return;
  }

  const payload = await readJsonPayload(req);
  if (String(payload.secret ?? '') !== secret) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  const organizationId = String(payload.organizationId ?? defaultOrgId ?? '').trim();
  if (!organizationId) {
    sendJson(res, 400, { ok: false, error: 'organizationId required' });
    return;
  }

  const action = String(payload.action ?? 'upsert_events').trim();

  try {
    if (action === 'ping') {
      sendJson(res, 200, { ok: true, server: true, organizationId });
      return;
    }

    if (action === 'upsert_events') {
      const rawEvents = Array.isArray(payload.events) ? payload.events : [];
      const rows = rawEvents.map((e) => mapCareEventRow(organizationId, e)).filter(Boolean);
      if (!rows.length) {
        sendJson(res, 200, { ok: true, upserted: 0 });
        return;
      }
      await supabaseRest(supabaseUrl, serviceKey, 'care_events?on_conflict=organization_id,client_event_id', 'POST', rows);
      void broadcastCareEventsUpdated(supabaseUrl, serviceKey, organizationId);
      sendJson(res, 200, { ok: true, upserted: rows.length });
      return;
    }

    if (action === 'pull_residents') {
      // 列名を固定指定すると DB スキーマ差異（legacy_row_key 無し等）で 400 になるため、
      // select=* で全列取得し、施設の埋め込みも任意化（失敗時は素の列だけにフォールバック）。
      let rows = [];
      try {
        rows = await supabaseSelectJson(
          supabaseUrl,
          serviceKey,
          `residents?organization_id=eq.${organizationId}&select=*,facilities(sheet_title,tab_label)&order=name.asc&limit=5000`
        );
      } catch {
        rows = await supabaseSelectJson(
          supabaseUrl,
          serviceKey,
          `residents?organization_id=eq.${organizationId}&select=*&order=name.asc&limit=5000`
        );
      }
      sendJson(res, 200, { ok: true, residents: rows, count: rows.length });
      return;
    }

    sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendJson(res, 500, { ok: false, error: msg });
  }
}
