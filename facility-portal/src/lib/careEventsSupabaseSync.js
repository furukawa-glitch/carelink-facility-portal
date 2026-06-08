/**
 * 生活記録 → Supabase（/api/care-sync 経由）。
 * VITE_CARE_CLOUD_SYNC=1 のときのみ動作。未設定時は no-op（現状運用と同じ）。
 */

const SYNC_DEBOUNCE_MS = 3_000;
const MAX_BATCH = 200;
const DEFAULT_PULL_LIMIT = 5000;
const DEFAULT_PULL_SINCE_DAYS = 21;

/** @type {Map<string, Record<string, unknown>>} */
const pendingById = new Map();
let flushTimer = 0;
let flushing = false;

function isCloudSyncEnabled() {
  const flag = String(import.meta.env.VITE_CARE_CLOUD_SYNC ?? '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  // 本番でシークレットと組織IDが揃っていれば自動ON（VITE_CARE_CLOUD_SYNC=1 がなくても同期）
  return Boolean(syncSecret()) && Boolean(organizationId());
}

function syncSecret() {
  return String(import.meta.env.VITE_CARE_SYNC_SECRET ?? '').trim();
}

function organizationId() {
  return String(import.meta.env.VITE_CARELINK_ORGANIZATION_ID ?? '').trim();
}

/** @param {Record<string, unknown>} body */
export async function careSyncPost(body) {
  return postCareSync(body);
}

async function postCareSync(body) {
  const secret = syncSecret();
  if (!secret) return { ok: false, skipped: true, reason: 'no_secret' };
  const res = await fetch('/api/care-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, organizationId: organizationId(), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(json.error ?? `care-sync HTTP ${res.status}`));
  }
  return json;
}

function scheduleFlush() {
  if (!isCloudSyncEnabled()) return;
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void flushCareEventsCloudSync();
  }, SYNC_DEBOUNCE_MS);
}

/**
 * 1件または複数件をキュー（logCareEvent / 一覧表保存後）
 * @param {Record<string, unknown> | Record<string, unknown>[]} events
 */
export function queueCareEventsCloudSync(events) {
  if (!isCloudSyncEnabled()) return;
  const list = Array.isArray(events) ? events : [events];
  for (const e of list) {
    const id = String(e?.id ?? '').trim();
    if (!id) continue;
    pendingById.set(id, e);
  }
  scheduleFlush();
}

/** キューを即送信 */
export async function flushCareEventsCloudSync() {
  if (!isCloudSyncEnabled() || flushing || pendingById.size === 0) return { ok: true, upserted: 0 };
  flushing = true;
  const batch = [...pendingById.values()].slice(0, MAX_BATCH);
  for (const e of batch) {
    const id = String(e?.id ?? '').trim();
    if (id) pendingById.delete(id);
  }
  try {
    const result = await postCareSync({ action: 'upsert_events', events: batch });
    if (pendingById.size > 0) scheduleFlush();
    return result;
  } finally {
    flushing = false;
  }
}

/**
 * 23:59 / 手動バックアップ後に日次スナップショットをクラウドへ
 * @param {{ snapshotYmd: string; facilityLabel: string; trigger: string; eventCount: number; payload: object; facilityId?: string }} snap
 */
export async function uploadCareDailySnapshotCloud(snap) {
  if (!isCloudSyncEnabled()) return { ok: true, skipped: true };
  return postCareSync({
    action: 'upsert_snapshot',
    snapshot: {
      snapshot_ymd: snap.snapshotYmd,
      facility_label: snap.facilityLabel,
      trigger: snap.trigger,
      event_count: snap.eventCount,
      payload: snap.payload,
      facility_id: snap.facilityId ?? null,
    },
  });
}

export function isCareCloudSyncConfigured() {
  return isCloudSyncEnabled() && Boolean(syncSecret()) && Boolean(organizationId());
}

/** 本番 API（Vercel サーバ側の Supabase 鍵）が使えるか */
export async function probeCareCloudSyncServer() {
  if (!isCareCloudSyncConfigured()) {
    return {
      ok: false,
      clientConfigured: false,
      serverConfigured: false,
      error:
        'このアプリのビルドに VITE_CARELINK_ORGANIZATION_ID と VITE_CARE_SYNC_SECRET がありません。Vercel で設定して再デプロイしてください。',
    };
  }
  try {
    const res = await fetch('/api/care-sync-status', { cache: 'no-store' });
    if (res.ok) {
      const status = await res.json().catch(() => ({}));
      if (!status?.ready) {
        const missing = Array.isArray(status?.missing) ? status.missing.join('、') : '';
        return {
          ok: false,
          clientConfigured: true,
          serverConfigured: false,
          error:
            String(status?.hint ?? '').trim() ||
            `Vercel サーバ未設定（${missing || 'SUPABASE_SERVICE_ROLE_KEY 等'}）。設定後に再デプロイが必要です。`,
          missing: status?.missing,
        };
      }
    }
    const json = await postCareSync({ action: 'ping' });
    return { ok: true, clientConfigured: true, serverConfigured: true, ...json };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, clientConfigured: true, serverConfigured: false, error: msg };
  }
}

/** @returns {{ enabled: boolean; configured: boolean; label: string; hint: string }} */
export function getCareCloudSyncStatus() {
  const enabled = isCloudSyncEnabled();
  const hasSecret = Boolean(syncSecret());
  const hasOrg = Boolean(organizationId());
  const configured = enabled && hasSecret && hasOrg;
  if (!hasSecret || !hasOrg) {
    return {
      enabled: false,
      configured: false,
      label: 'クラウド同期オフ',
      hint: '記録はこの端末のブラウザだけに保存されます。全PCで共有するには Vercel に CARE_SYNC_SECRET・組織ID・Supabase キーを設定してください。',
    };
  }
  if (!enabled) {
    return {
      enabled: false,
      configured: false,
      label: 'クラウド同期オフ',
      hint: '同期は無効化されています（VITE_CARE_CLOUD_SYNC=0）。記録はこの端末のみです。',
    };
  }
  return {
    enabled: true,
    configured: true,
    label: 'クラウド同期（設定確認中…）',
    hint:
      '生活記録・傷病一覧CSVの病名を全PCで共有します。Vercel にはクライアント用（VITE_）に加え、サーバ用の SUPABASE_SERVICE_ROLE_KEY・CARE_SYNC_SECRET・VITE_SUPABASE_URL も必要です。',
  };
}

/**
 * クラウドからイベントを取得してローカルにマージ。
 * @param {{ sinceTs?: string; limit?: number }} [opts]
 */
export async function pullCareEventsCloudSync(opts = {}) {
  if (!isCloudSyncEnabled()) return { ok: true, pulled: 0, merged: 0, skipped: true };
  let sinceTs = String(opts?.sinceTs ?? '').trim();
  if (!sinceTs && opts?.sinceDays !== 0) {
    const days = Number(opts?.sinceDays ?? DEFAULT_PULL_SINCE_DAYS);
    const since = new Date();
    since.setDate(since.getDate() - (Number.isFinite(days) && days > 0 ? days : DEFAULT_PULL_SINCE_DAYS));
    sinceTs = since.toISOString();
  }
  const limitRaw = Number(opts?.limit ?? DEFAULT_PULL_LIMIT);
  const limit = Math.max(100, Math.min(5000, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_PULL_LIMIT));
  const result = await postCareSync({ action: 'pull_events', sinceTs, limit });
  const events = Array.isArray(result?.events) ? result.events : [];
  if (!events.length) return { ok: true, pulled: 0, merged: 0 };
  const report = await import('../services/ReportService.js');
  const merged = report.mergeCareEventsFromCloud(events);
  return { ok: true, pulled: events.length, merged: Number(merged ?? 0) };
}

/** この端末の全記録をクラウドへ一括送信（初回移行・復旧用） */
export async function pushAllLocalCareEventsCloud() {
  if (!isCloudSyncEnabled()) return { ok: true, skipped: true, upserted: 0 };
  const report = await import('../services/ReportService.js');
  const all = report.getAllCareEvents();
  if (!all.length) return { ok: true, upserted: 0 };
  let upserted = 0;
  for (let i = 0; i < all.length; i += MAX_BATCH) {
    const batch = all.slice(i, i + MAX_BATCH);
    const result = await postCareSync({ action: 'upsert_events', events: batch });
    upserted += Number(result?.upserted ?? batch.length);
  }
  return { ok: true, upserted };
}

/**
 * pull → ローカル反映 → UI 更新用
 * @param {{ reload?: boolean }} [opts]
 */
export async function pullAndApplyCareEventsCloud(opts = {}) {
  const result = await pullCareEventsCloudSync();
  if (opts.reload !== false && (Number(result?.merged ?? 0) > 0 || Number(result?.pulled ?? 0) > 0)) {
    const report = await import('../services/ReportService.js');
    report.reloadCareEventsFromStorage();
  }
  return result;
}
