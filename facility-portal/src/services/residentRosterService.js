/**
 * 名簿のハイブリッド運用：スプレッドシートを種にしつつ、アプリ／Supabase をマスタにする
 */

import { careSyncPost } from '../lib/careEventsSupabaseSync.js';
import { mapAppResidentToSyncPayload, mapDbResidentRowToApp } from '../lib/residentRosterMapper.js';
import { facilityDefBySheetTitle } from '../config/carelinkFacilities.js';

const LOCAL_ROSTER_KEY = 'carelink_resident_roster_v1';

function syncSecret() {
  return String(import.meta.env.VITE_CARE_SYNC_SECRET ?? '').trim();
}

function organizationId() {
  return String(import.meta.env.VITE_CARELINK_ORGANIZATION_ID ?? '').trim();
}

/** 名簿DB（Supabase経由）が使えるか */
export function isResidentRosterCloudEnabled() {
  const flag = String(import.meta.env.VITE_CARE_CLOUD_SYNC ?? '').trim();
  if (flag === '0') return false;
  if (flag === '1') return Boolean(syncSecret()) && Boolean(organizationId());
  return Boolean(syncSecret()) && Boolean(organizationId());
}

function localRosterStorageKey() {
  const org = organizationId() || 'local';
  return `${LOCAL_ROSTER_KEY}:${org}`;
}

/** @returns {Record<string, unknown>[]} */
function readLocalRosterResidents() {
  try {
    const raw = localStorage.getItem(localRosterStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.residents) ? parsed.residents : [];
  } catch {
    return [];
  }
}

/** @param {Record<string, unknown>[]} residents */
function writeLocalRosterResidents(residents) {
  localStorage.setItem(
    localRosterStorageKey(),
    JSON.stringify({ residents, updatedAt: new Date().toISOString() })
  );
}

/** @returns {Promise<Record<string, unknown>[]>} */
export async function pullResidentsFromCloud(opts = {}) {
  if (!isResidentRosterCloudEnabled()) return [];
  const json = await careSyncPost({ action: 'pull_residents' });
  const rows = Array.isArray(json.residents) ? json.residents : [];
  return mapDbRowsToApp(rows, opts);
}

/** @param {Record<string, unknown>[]} rows @param {{ includeInactive?: boolean }} [opts] */
function mapDbRowsToApp(rows, opts = {}) {
  const out = [];
  for (const row of rows) {
    const mapped = mapDbResidentRowToApp(row, opts);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} resident
 * @returns {Promise<Record<string, unknown>>}
 */
export async function upsertResidentToCloud(resident) {
  const payload = mapAppResidentToSyncPayload(resident);
  const def = facilityDefBySheetTitle(payload.facility);
  const json = await careSyncPost({
    action: 'upsert_resident',
    resident: {
      ...payload,
      linkKey: def?.linkKey ?? '',
      tabLabel: def?.tabLabel ?? payload.facility,
    },
  });
  const row = json.resident;
  if (row && typeof row === 'object') {
    const mapped = mapDbResidentRowToApp(row);
    if (mapped) return mapped;
  }
  return { ...resident, dbId: String(json.id ?? resident.dbId ?? '').trim() || resident.dbId };
}

/**
 * @param {string} dbId
 */
export async function deactivateResidentInCloud(dbId) {
  await careSyncPost({ action: 'deactivate_resident', residentId: String(dbId ?? '').trim() });
}

/**
 * スプレッドシートの名簿を Supabase に取り込み（既存行は legacy_row_key で更新）
 * @returns {Promise<{ imported: number; source: string }>}
 */
export async function importSheetSeedToCloud() {
  const { fetchResidentsFromSheetSeedOnly } = await import('./GoogleSheetService.js');
  const { residents, source } = await fetchResidentsFromSheetSeedOnly();
  if (!residents.length) {
    throw new Error('スプレッドシートから名簿を読み取れませんでした。');
  }
  const batch = residents.map((r) => {
    const p = mapAppResidentToSyncPayload(r);
    const def = facilityDefBySheetTitle(p.facility);
    return { ...p, linkKey: def?.linkKey ?? '', tabLabel: def?.tabLabel ?? p.facility };
  });
  const json = await careSyncPost({ action: 'import_residents_batch', residents: batch });
  return { imported: Number(json.imported) || batch.length, source: String(source ?? 'sheet') };
}

/**
 * クラウド未設定時：端末内に名簿を保存
 * @param {Record<string, unknown>[]} residents
 */
export function saveLocalRosterResidents(residents) {
  writeLocalRosterResidents(residents);
}

/**
 * DB → ローカル → null（シート読込へ）の順で名簿を試す
 * @returns {Promise<{ residents: Record<string, unknown>[]; source: string; mode: string } | null>}
 */
export async function loadResidentsFromRosterMaster() {
  if (isResidentRosterCloudEnabled()) {
    try {
      const residents = await pullResidentsFromCloud();
      if (residents.length > 0) {
        return { residents, source: 'roster_db', mode: 'hybrid_db' };
      }
    } catch (e) {
      console.warn('[名簿] クラウド取得失敗', e);
    }
  }

  const local = readLocalRosterResidents().filter((r) => {
    const status = String(r.sheetStatus ?? '在籍').trim();
    return !status || status === '在籍' || /在籍|入居/u.test(status);
  });
  if (local.length > 0) {
    return { residents: local, source: 'roster_local', mode: 'hybrid_local' };
  }

  return null;
}

/** ローカル名簿にスプレッドシートをマージ保存（クラウド未設定向け） */
export async function importSheetSeedToLocal() {
  const { fetchResidentsFromSheetSeedOnly } = await import('./GoogleSheetService.js');
  const { residents } = await fetchResidentsFromSheetSeedOnly();
  if (!residents.length) throw new Error('スプレッドシートから名簿を読み取れませんでした。');
  writeLocalRosterResidents(residents);
  return { imported: residents.length };
}
