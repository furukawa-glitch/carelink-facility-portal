/**
 * Vercel Serverless: 生活記録 → Supabase（service_role、ブラウザに鍵を出さない）
 * POST /api/care-sync  { secret, action, organizationId, events?, snapshot? }
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

/**
 * @param {string} url
 * @param {string} serviceKey
 * @param {string} path
 * @param {string} method
 * @param {unknown} body
 */
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

/**
 * @param {string} url
 * @param {string} serviceKey
 * @param {string} path
 */
/**
 * 他PCへ Realtime broadcast（保存直後に pull トリガー）
 * @param {string} url
 * @param {string} serviceKey
 * @param {string} organizationId
 */
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

/**
 * @param {string} url
 * @param {string} serviceKey
 * @param {string} organizationId
 * @param {Record<string, unknown>} input
 */
async function ensureFacility(url, serviceKey, organizationId, input) {
  const sheetTitle = String(input.facility ?? input.sourceSheetTitle ?? input.source_sheet_title ?? '').trim();
  if (!sheetTitle) return null;
  const row = {
    organization_id: organizationId,
    sheet_title: sheetTitle,
    tab_label: String(input.tabLabel ?? input.tab_label ?? sheetTitle).trim() || sheetTitle,
    link_key: String(input.linkKey ?? input.link_key ?? '').trim() || null,
    updated_at: new Date().toISOString(),
  };
  await supabaseRest(url, serviceKey, 'facilities?on_conflict=organization_id,sheet_title', 'POST', [row]);
  const rows = await supabaseSelectJson(
    url,
    serviceKey,
    `facilities?organization_id=eq.${organizationId}&sheet_title=eq.${encodeURIComponent(sheetTitle)}&select=id,sheet_title,tab_label&limit=1`
  );
  return rows[0] ?? null;
}

/** @param {string} organizationId @param {string|null} facilityId @param {Record<string, unknown>} r */
function mapResidentUpsertRow(organizationId, facilityId, r) {
  const name = String(r.name ?? '').trim();
  if (!name) return null;
  const legacy = String(r.legacyRowKey ?? r.legacy_row_key ?? r.id ?? '').trim();
  const dbId = String(r.dbId ?? r.db_id ?? '').trim();
  const row = {
    organization_id: organizationId,
    facility_id: facilityId,
    legacy_row_key: legacy || null,
    name,
    name_kana: String(r.nameKana ?? r.name_kana ?? '').trim() || null,
    room: String(r.room ?? '').trim() || null,
    sheet_status: String(r.sheetStatus ?? r.sheet_status ?? '在籍').trim() || '在籍',
    care_level_label: String(r.careLevelLabel ?? r.care_level_label ?? '').trim() || null,
    condition_note: String(r.condition ?? r.condition_note ?? '').trim() || null,
    home_doctor: String(r.homeDoctor ?? r.home_doctor ?? '').trim() || null,
    insurance_label: String(r.insuranceLabel ?? r.insurance_label ?? '').trim() || null,
    insurance_category: String(r.insuranceCategory ?? r.insurance_category ?? '').trim() || null,
    birth_date_label: String(r.birthDateLabel ?? r.birth_date_label ?? '').trim() || null,
    gender_label: String(r.genderLabel ?? r.gender_label ?? '').trim() || null,
    source_sheet_title: String(r.sourceSheetTitle ?? r.facility ?? r.source_sheet_title ?? '').trim() || null,
    is_enteral: Boolean(r.isEnteral ?? r.is_enteral),
    is_medical_insurance_target: Boolean(r.isMedicalInsuranceTarget ?? r.is_medical_insurance_target),
    medical_insurance_target_label:
      String(r.medicalInsuranceTargetLabel ?? r.medical_insurance_target_label ?? '').trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (dbId) row.id = dbId;
  return row;
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

    if (action === 'upsert_snapshot') {
      const snap = payload.snapshot;
      if (!snap || typeof snap !== 'object') {
        sendJson(res, 400, { ok: false, error: 'snapshot required' });
        return;
      }
      const ymd = String(snap.snapshot_ymd ?? snap.snapshotYmd ?? '').trim();
      if (!ymd) {
        sendJson(res, 400, { ok: false, error: 'snapshot_ymd required' });
        return;
      }
      const row = {
        organization_id: organizationId,
        facility_id: snap.facility_id ?? snap.facilityId ?? null,
        snapshot_ymd: ymd,
        facility_label: String(snap.facility_label ?? snap.facilityLabel ?? '').trim(),
        trigger: String(snap.trigger ?? 'manual').trim(),
        event_count: Number(snap.event_count ?? snap.eventCount ?? 0) || 0,
        payload: snap.payload ?? snap,
      };
      await supabaseRest(
        supabaseUrl,
        serviceKey,
        'care_daily_snapshots?on_conflict=organization_id,facility_id,snapshot_ymd,trigger',
        'POST',
        [row]
      );
      sendJson(res, 200, { ok: true, snapshot: ymd });
      return;
    }

    if (action === 'pull_events') {
      const sinceTs = String(payload.sinceTs ?? '').trim();
      const parsedSince = sinceTs ? new Date(sinceTs) : null;
      const limitRaw = Number(payload.limit ?? 1500);
      const limit = Math.max(100, Math.min(5000, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 1500));
      const sinceIso = parsedSince && Number.isFinite(parsedSince.getTime()) ? parsedSince.toISOString() : '';
      const whereSince = sinceIso ? `&event_ts=gt.${encodeURIComponent(sinceIso)}` : '';
      const rows = await supabaseSelectJson(
        supabaseUrl,
        serviceKey,
        `care_events?organization_id=eq.${organizationId}${whereSince}&select=payload,event_ts&order=event_ts.desc&limit=${limit}`
      );
      const events = rows
        .map((r) => (r && typeof r.payload === 'object' ? r.payload : null))
        .filter(Boolean);
      sendJson(res, 200, { ok: true, events, count: events.length });
      return;
    }

    if (action === 'upsert_facility_store') {
      const storeType = String(payload.storeType ?? payload.store_type ?? '').trim();
      const facilityLinkKey = String(payload.facilityLinkKey ?? payload.facility_link_key ?? '').trim();
      if (!storeType || !facilityLinkKey) {
        sendJson(res, 400, { ok: false, error: 'storeType and facilityLinkKey required' });
        return;
      }
      const updatedAt = String(payload.updatedAt ?? payload.updated_at ?? new Date().toISOString()).trim();
      const row = {
        organization_id: organizationId,
        store_type: storeType,
        facility_link_key: facilityLinkKey,
        payload: payload.payload ?? null,
        updated_at: updatedAt,
      };
      await supabaseRest(
        supabaseUrl,
        serviceKey,
        'facility_portal_stores?on_conflict=organization_id,store_type,facility_link_key',
        'POST',
        [row]
      );
      void broadcastCareEventsUpdated(supabaseUrl, serviceKey, organizationId);
      sendJson(res, 200, { ok: true, upserted: 1 });
      return;
    }

    if (action === 'pull_facility_stores') {
      const storeTypes = Array.isArray(payload.storeTypes)
        ? payload.storeTypes.map((s) => String(s ?? '').trim()).filter(Boolean)
        : [];
      let path = `facility_portal_stores?organization_id=eq.${organizationId}&select=store_type,facility_link_key,payload,updated_at&order=updated_at.desc&limit=200`;
      if (storeTypes.length === 1) {
        path += `&store_type=eq.${encodeURIComponent(storeTypes[0])}`;
      } else if (storeTypes.length > 1) {
        const quoted = storeTypes.map((s) => `"${String(s).replace(/"/g, '')}"`).join(',');
        path += `&store_type=in.(${quoted})`;
      }
      const rows = await supabaseSelectJson(supabaseUrl, serviceKey, path);
      sendJson(res, 200, { ok: true, stores: rows, count: rows.length });
      return;
    }

    if (action === 'pull_residents') {
      const rows = await supabaseSelectJson(
        supabaseUrl,
        serviceKey,
        `residents?organization_id=eq.${organizationId}&select=id,legacy_row_key,name,name_kana,room,sheet_status,care_level_label,condition_note,home_doctor,insurance_label,insurance_category,medical_insurance_target_label,is_medical_insurance_target,birth_date_label,age_label,gender_label,meal_count_this_month,is_enteral,source_sheet_title,facility_id,facilities(sheet_title,tab_label)&order=name.asc&limit=5000`
      );
      sendJson(res, 200, { ok: true, residents: rows, count: rows.length });
      return;
    }

    if (action === 'upsert_resident') {
      const raw = payload.resident;
      if (!raw || typeof raw !== 'object') {
        sendJson(res, 400, { ok: false, error: 'resident required' });
        return;
      }
      const fac = await ensureFacility(supabaseUrl, serviceKey, organizationId, raw);
      const row = mapResidentUpsertRow(organizationId, fac?.id ?? null, raw);
      if (!row) {
        sendJson(res, 400, { ok: false, error: 'name required' });
        return;
      }
      if (row.id) {
        await supabaseRest(supabaseUrl, serviceKey, 'residents?on_conflict=organization_id,id', 'POST', [row]);
      } else if (row.legacy_row_key) {
        await supabaseRest(
          supabaseUrl,
          serviceKey,
          'residents?on_conflict=organization_id,legacy_row_key',
          'POST',
          [row]
        );
      } else {
        row.legacy_row_key = `app::${Date.now()}::${row.name}`;
        await supabaseRest(supabaseUrl, serviceKey, 'residents', 'POST', [row]);
      }
      let saved = null;
      if (row.id) {
        const byId = await supabaseSelectJson(
          supabaseUrl,
          serviceKey,
          `residents?id=eq.${encodeURIComponent(String(row.id))}&select=id,legacy_row_key,name,name_kana,room,sheet_status,care_level_label,condition_note,home_doctor,source_sheet_title,facilities(sheet_title,tab_label)&limit=1`
        );
        saved = byId[0] ?? null;
      } else if (row.legacy_row_key) {
        const byLegacy = await supabaseSelectJson(
          supabaseUrl,
          serviceKey,
          `residents?organization_id=eq.${organizationId}&legacy_row_key=eq.${encodeURIComponent(String(row.legacy_row_key))}&select=id,legacy_row_key,name,name_kana,room,sheet_status,care_level_label,condition_note,home_doctor,source_sheet_title,facilities(sheet_title,tab_label)&limit=1`
        );
        saved = byLegacy[0] ?? null;
      }
      sendJson(res, 200, { ok: true, resident: saved, id: saved?.id ?? row.id ?? null });
      return;
    }

    if (action === 'import_residents_batch') {
      const list = Array.isArray(payload.residents) ? payload.residents : [];
      if (!list.length) {
        sendJson(res, 200, { ok: true, imported: 0 });
        return;
      }
      /** @type {Record<string, unknown>[]} */
      const rows = [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const fac = await ensureFacility(supabaseUrl, serviceKey, organizationId, raw);
        const row = mapResidentUpsertRow(organizationId, fac?.id ?? null, raw);
        if (row) rows.push(row);
      }
      if (!rows.length) {
        sendJson(res, 400, { ok: false, error: 'no valid residents' });
        return;
      }
      await supabaseRest(
        supabaseUrl,
        serviceKey,
        'residents?on_conflict=organization_id,legacy_row_key',
        'POST',
        rows
      );
      sendJson(res, 200, { ok: true, imported: rows.length });
      return;
    }

    if (action === 'deactivate_resident') {
      const rid = String(payload.residentId ?? payload.resident_id ?? '').trim();
      if (!rid) {
        sendJson(res, 400, { ok: false, error: 'residentId required' });
        return;
      }
      await supabaseRest(
        supabaseUrl,
        serviceKey,
        `residents?id=eq.${encodeURIComponent(rid)}&organization_id=eq.${organizationId}`,
        'PATCH',
        { sheet_status: '退去', updated_at: new Date().toISOString() }
      );
      sendJson(res, 200, { ok: true, deactivated: rid });
      return;
    }

    sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendJson(res, 500, { ok: false, error: msg });
  }
}
