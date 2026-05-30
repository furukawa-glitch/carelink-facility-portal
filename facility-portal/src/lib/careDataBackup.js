import { pruneCareEventsBeyondRetention, CARE_RECORD_RETENTION_YEARS } from './careRecordRetention.js';
import { idbSaveAllCareEvents } from './careEventsIdb.js';
import * as Report from '../services/ReportService.js';

/** 生活記録・バイタル等の手動バックアップ／復元 */
export const CARE_BACKUP_VERSION = 1;

/** @type {readonly string[]} */
export const CARE_BACKUP_LS_KEYS = Object.freeze([
  'carelink_os_care_events_v1',
  'carelink_os_resident_vitals_v1',
  'carelink_os_bulk_table_draft_v1',
  'carelink_os_nursing_directives_v1',
  'carelink_os_weekly_plans_v1',
  'carelink_os_last_stool_v1',
  'carelink_os_last_urine_v1',
  'carelink_os_small_stool_tally_v1',
  'carelink_os_resident_alert_thresholds_v1',
  'carelink_os_resident_monitor_alert_mute_until_v1',
  'carelink_os_emergency_contact_v1',
  'carelink_os_disability_service_progress_v1',
  'carelink_os_visit_nursing_special_v1',
  'carelink_os_facility_notice_v1',
  'carelink_os_facility_handover_v1',
  'carelink_os_resident_surround_memo_v1',
  'carelink_os_day_service_v1',
  'carelink_os_monthly_report_import_v1',
  'carelink_os_resident_medication_profile_v1',
]);

function readLsJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLsJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function localYmdHm() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${ymd}-${hm}`;
}

/**
 * @returns {{ payload: object; stats: { careEvents: number; vitals: number; keys: number } }}
 */
export function buildCareDataBackupPayload() {
  /** @type {Record<string, unknown>} */
  const store = {};
  for (const key of CARE_BACKUP_LS_KEYS) {
    if (key === 'carelink_os_care_events_v1') continue;
    const val = readLsJson(key);
    if (val != null) store[key] = val;
  }
  store['carelink_os_care_events_v1'] = Report.getAllCareEvents();
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('carelink_os_')) continue;
    if (store[k] !== undefined) continue;
    const val = readLsJson(k);
    if (val != null) store[k] = val;
  }
  const events = Array.isArray(store['carelink_os_care_events_v1']) ? store['carelink_os_care_events_v1'] : [];
  const vitals =
    store['carelink_os_resident_vitals_v1'] && typeof store['carelink_os_resident_vitals_v1'] === 'object'
      ? Object.keys(store['carelink_os_resident_vitals_v1'])
      : [];
  return {
    payload: {
      carelinkBackupVersion: CARE_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      app: 'carelink-facility-portal',
      retentionPolicy: {
        years: CARE_RECORD_RETENTION_YEARS,
        description: `生活記録は${CARE_RECORD_RETENTION_YEARS}年間保存（法定保存期間）。それ以前の記録のみ自動削除対象。`,
      },
      store,
    },
    stats: {
      careEvents: events.length,
      vitals: vitals.length,
      keys: Object.keys(store).length,
    },
  };
}

/** @param {string} [facilityLabel] */
export function downloadCareDataBackupJson(facilityLabel = '') {
  const { payload, stats } = buildCareDataBackupPayload();
  const safeFac = String(facilityLabel ?? '')
    .trim()
    .replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]+/gu, '_')
    .slice(0, 24);
  const name = `carelink-backup${safeFac ? `-${safeFac}` : ''}-${localYmdHm()}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(name, blob);
  return stats;
}

/**
 * @param {unknown} parsed
 * @returns {parsed is { store: Record<string, unknown> }}
 */
function isBackupPayload(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && parsed.store && typeof parsed.store === 'object');
}

/**
 * @param {Record<string, unknown>} incomingStore
 * @param {'merge' | 'replace'} mode
 */
export function restoreCareDataBackup(incomingStore, mode = 'merge') {
  if (!incomingStore || typeof incomingStore !== 'object') {
    throw new Error('バックアップ形式が不正です');
  }
  let restoredKeys = 0;
  let mergedEvents = 0;

  for (const [key, val] of Object.entries(incomingStore)) {
    if (!key.startsWith('carelink_os_')) continue;

    if (key === 'carelink_os_care_events_v1' && mode === 'merge' && Array.isArray(val)) {
      const existing = readLsJson(key);
      const cur = Array.isArray(existing) ? existing : [];
      const byId = new Map(cur.map((e) => [String(e?.id ?? ''), e]));
      for (const ev of val) {
        const id = String(ev?.id ?? '');
        if (id && !byId.has(id)) {
          byId.set(id, ev);
          mergedEvents += 1;
        } else if (!id) {
          byId.set(`imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ev);
          mergedEvents += 1;
        }
      }
      const merged = pruneCareEventsBeyondRetention(Array.from(byId.values()));
      writeLsJson(key, merged);
      void idbSaveAllCareEvents(merged);
      restoredKeys += 1;
      continue;
    }

    if (key === 'carelink_os_care_events_v1' && Array.isArray(val)) {
      const pruned = pruneCareEventsBeyondRetention(val);
      writeLsJson(key, pruned);
      void idbSaveAllCareEvents(pruned);
      restoredKeys += 1;
      continue;
    }

    if (mode === 'replace' || readLsJson(key) == null) {
      writeLsJson(key, val);
      restoredKeys += 1;
    } else if (key === 'carelink_os_resident_vitals_v1' && typeof val === 'object' && val) {
      const existing = readLsJson(key);
      writeLsJson(key, { ...(typeof existing === 'object' && existing ? existing : {}), ...val });
      restoredKeys += 1;
    }
  }

  return { restoredKeys, mergedEvents };
}

/**
 * @param {File | null | undefined} file
 * @param {'merge' | 'replace'} mode
 */
export async function importCareDataBackupFromFile(file, mode = 'merge') {
  const f = file;
  if (!f) throw new Error('ファイルが選択されていません');
  const text = await f.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('JSON の読み込みに失敗しました');
  }
  if (!isBackupPayload(parsed)) {
    throw new Error('CareLink バックアップファイルではありません（store がありません）');
  }
  return restoreCareDataBackup(parsed.store, mode);
}
