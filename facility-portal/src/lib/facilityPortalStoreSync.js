/**
 * 予定カレンダー・往診カレンダー等（localStorage）のクラウド同期
 */

import { careSyncPost, isCareCloudSyncConfigured } from './careEventsSupabaseSync.js';
import { canonicalFacilityLinkKey } from '../config/carelinkFacilities.js';

export const FACILITY_STORE_WEEKLY_PLANS = 'weekly_plans';
export const FACILITY_STORE_HOME_VISIT = 'home_visit_calendar';
export const FACILITY_STORE_INJURY_DISEASE = 'injury_disease_by_resident';
export const FACILITY_STORE_ENTERAL_MENU = 'enteral_nutrition_menu';
export const FACILITY_STORE_BATH_SCHEDULE = 'bath_schedule';
export const FACILITY_STORE_RESIDENT_SCHEDULE = 'resident_daily_schedule';
export const FACILITY_STORE_BULK_DRAFT = 'bulk_table_draft';
export const FACILITY_STORE_NURSING_DIRECTIVES = 'nursing_directives';
export const FACILITY_STORE_FACILITY_NOTICE = 'facility_notice';
export const FACILITY_STORE_MOVE_IN_OUT_LOG = 'move_in_out_log';
export const FACILITY_STORE_BEREAVEMENT_LETTERS = 'bereavement_letters';
/** 組織全体で1つ（利用者IDキー） */
export const FACILITY_STORE_ORG_KEY = '__org__';

const LS_WEEKLY = 'carelink_os_weekly_plans_v1';
const LS_NURSING = 'carelink_os_nursing_directives_v1';
const LS_NURSING_META = 'carelink_os_nursing_directives_meta_v1';
const LS_FACILITY_NOTICE = 'carelink_os_facility_notice_v1';
const LS_HOME_VISIT = 'carelink_os_home_visit_calendar_v1';
const LS_INJURY_DISEASE = 'carelink_os_injury_disease_by_resident_v1';
const LS_ENTERAL_MENU = 'carelink_os_enteral_nutrition_menu_v1';
const LS_BATH_SCHEDULE = 'carelink_os_bath_schedule_v1';
const LS_RESIDENT_PLANS = 'carelink_os_resident_daily_plans_v1';
const LS_RESIDENT_RECURRING = 'carelink_os_resident_recurring_plans_v1';
const LS_RESIDENT_PLANS_META = 'carelink_os_resident_daily_plans_meta_v1';
const LS_BULK_DRAFT = 'carelink_os_bulk_table_draft_v1';
const LS_BULK_DRAFT_META = 'carelink_os_bulk_table_draft_meta_v1';
const LS_MOVE_IN_OUT = 'carelink_move_in_out_log_v1';
const LS_BEREAVEMENT = 'carelink_bereavement_letter_drafts_v1';
const FLUSH_DEBOUNCE_MS = 2_000;

/** @type {Set<string>} */
const pendingKeys = new Set();
let flushTimer = 0;
let flushing = false;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

/**
 * @param {unknown[]} a
 * @param {unknown[]} b
 */
function mergePlanLists(a, b) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();
  for (const p of [...a, ...b]) {
    if (!p || typeof p !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (p);
    const id = String(row.id ?? `${row.date}_${row.time}_${row.title}`);
    const prev = byId.get(id);
    const ts = String(row.ts ?? '');
    const pts = String(prev?.ts ?? '');
    if (!prev || ts >= pts) byId.set(id, row);
  }
  return [...byId.values()]
    .sort((x, y) =>
      `${String(x.date ?? '')} ${String(x.time ?? '')}`.localeCompare(
        `${String(y.date ?? '')} ${String(y.time ?? '')}`,
        'ja'
      )
    )
    .slice(-90);
}

/**
 * @param {{ store_type?: string; facility_link_key?: string; payload?: unknown; updated_at?: string }[]} rows
 */
/**
 * 往診カレンダーは「日付単位の和集合」でマージする。
 * remote 丸ごと置換だと、別月だけの payload を受けたときに前月が消えるため。
 * @param {any} local
 * @param {any} remote
 */
function mergeHomeVisitRecord(local, remote) {
  if (!remote || typeof remote !== 'object') return local ?? null;
  if (!local || typeof local !== 'object') return remote;
  const byDate = new Map();
  for (const d of Array.isArray(local.days) ? local.days : []) {
    const date = String(d?.date ?? '').trim();
    if (date) byDate.set(date, d);
  }
  for (const d of Array.isArray(remote.days) ? remote.days : []) {
    const date = String(d?.date ?? '').trim();
    if (date) byDate.set(date, d);
  }
  const days = Array.from(byDate.values()).sort((a, b) =>
    String(a?.date ?? '').localeCompare(String(b?.date ?? ''))
  );
  const remoteAt = String(remote.updatedAt ?? remote.updated_at ?? '');
  const localAt = String(local.updatedAt ?? '');
  const newer = remoteAt >= localAt ? remote : local;
  return {
    yearMonth: String(newer.yearMonth ?? remote.yearMonth ?? local.yearMonth ?? '').trim(),
    clinicName: String(newer.clinicName ?? remote.clinicName ?? local.clinicName ?? '').trim(),
    updatedAt: remoteAt >= localAt ? remoteAt : localAt,
    sourceFileName: String(newer.sourceFileName ?? '').trim(),
    days,
  };
}

/**
 * @param {Record<string, { label?: string; importedAt?: string }>} local
 * @param {Record<string, { label?: string; importedAt?: string }>} remote
 */
function mergeInjuryDiseaseStore(local, remote) {
  const out = { ...local };
  for (const [id, row] of Object.entries(remote || {})) {
    const rid = String(id ?? '').trim();
    if (!rid || !row || typeof row !== 'object') continue;
    const label = String(row.label ?? '').trim();
    if (!label) continue;
    const prev = out[rid];
    const prevAt = String(prev?.importedAt ?? '');
    const newAt = String(row.importedAt ?? '');
    if (!prev || newAt >= prevAt) out[rid] = row;
  }
  return out;
}

/**
 * @param {Record<string, unknown>} local
 * @param {Record<string, unknown>} remote
 */
function mergeEnteralMenuFacilityStore(local, remote) {
  const out = { ...local };
  for (const [linkKey, row] of Object.entries(remote || {})) {
    const k = String(linkKey ?? '').trim();
    if (!k || !row || typeof row !== 'object') continue;
    const prev = out[k];
    const prevAt = String(prev?.savedAt ?? '');
    const newAt = String(row.savedAt ?? '');
    if (!prev || newAt >= prevAt) out[k] = row;
  }
  return out;
}

/**
 * @param {Record<string, unknown> | null | undefined} local
 * @param {Record<string, unknown> | null | undefined} remote
 */
/**
 * @param {unknown} payload
 * @returns {{ savedAt: string; directives: unknown[] }}
 */
/**
 * @param {unknown[]} local
 * @param {unknown[]} remote
 */
function mergeNursingDirectiveLists(local, remote) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();
  for (const d of [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])]) {
    if (!d || typeof d !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (d);
    const id = String(row.id ?? row.ts ?? '').trim();
    if (!id) continue;
    const prev = byId.get(id);
    const ts = String(row.ts ?? '');
    const pts = String(prev?.ts ?? '');
    if (!prev || ts >= pts) byId.set(id, row);
  }
  return [...byId.values()]
    .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? ''), 'ja'))
    .slice(0, 30);
}

function parseNursingDirectivesPayload(payload) {
  if (Array.isArray(payload)) {
    return { savedAt: '', directives: payload };
  }
  if (payload && typeof payload === 'object') {
    const row = /** @type {Record<string, unknown>} */ (payload);
    return {
      savedAt: String(row.savedAt ?? ''),
      directives: Array.isArray(row.directives) ? row.directives : [],
    };
  }
  return { savedAt: '', directives: [] };
}

/**
 * @param {{ text?: string; updatedAt?: string } | null | undefined} local
 * @param {{ text?: string; updatedAt?: string } | null | undefined} remote
 */
function mergeFacilityNoticeRow(local, remote) {
  if (!remote || typeof remote !== 'object') return local ?? null;
  const remoteAt = String(remote.updatedAt ?? '');
  const localAt = String(local?.updatedAt ?? '');
  if (!local || remoteAt >= localAt) {
    return {
      text: String(remote.text ?? '').trim(),
      updatedAt: remoteAt || new Date().toISOString(),
    };
  }
  return local;
}

/**
 * @param {unknown[]} local
 * @param {{ logs?: unknown[]; savedAt?: string } | unknown[] | null | undefined} remote
 */
function mergeMoveInOutLogStore(local, remote) {
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote)
    ? remote
    : Array.isArray(remote?.logs)
      ? remote.logs
      : [];
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();
  for (const x of [...localList, ...remoteList]) {
    if (!x || typeof x !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (x);
    const id = String(row.id ?? '').trim();
    if (!id) continue;
    const prev = byId.get(id);
    const at = String(row.createdAt ?? '');
    const pat = String(prev?.createdAt ?? '');
    if (!prev || at >= pat) byId.set(id, row);
  }
  return [...byId.values()]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, 3000);
}

/**
 * @param {Record<string, unknown>} local
 * @param {{ drafts?: Record<string, unknown>; savedAt?: string } | Record<string, unknown> | null | undefined} remote
 */
function mergeBereavementLetterStore(local, remote) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  const remoteDrafts =
    remote && typeof remote === 'object' && !Array.isArray(remote) && remote.drafts && typeof remote.drafts === 'object'
      ? remote.drafts
      : remote && typeof remote === 'object' && !Array.isArray(remote)
        ? remote
        : {};
  for (const [id, row] of Object.entries(remoteDrafts)) {
    const key = String(id ?? '').trim();
    if (!key || !row || typeof row !== 'object') continue;
    const prev = out[key];
    const at = String(row.updatedAt ?? '');
    const pat = String(prev?.updatedAt ?? '');
    if (!prev || at >= pat) out[key] = row;
  }
  return out;
}

function mergeResidentScheduleFacilityStore(local, remote) {
  if (!remote || typeof remote !== 'object') return local ?? null;
  const remoteAt = String(remote.savedAt ?? '');
  const localAt = String(local?.savedAt ?? '');
  const localResidents = local?.residents && typeof local.residents === 'object' ? local.residents : {};
  const remoteResidents = remote.residents && typeof remote.residents === 'object' ? remote.residents : {};
  const localRecurring = local?.recurring && typeof local.recurring === 'object' ? local.recurring : {};
  const remoteRecurring = remote.recurring && typeof remote.recurring === 'object' ? remote.recurring : {};
  const remoteIsNewer = !localAt || remoteAt >= localAt;
  return {
    savedAt: remoteIsNewer ? remoteAt || localAt : localAt || remoteAt,
    residents: remoteIsNewer
      ? { ...localResidents, ...remoteResidents }
      : { ...remoteResidents, ...localResidents },
    recurring: remoteIsNewer
      ? { ...localRecurring, ...remoteRecurring }
      : { ...remoteRecurring, ...localRecurring },
  };
}

function applyFacilityStoresToLocal(rows) {
  let weeklyChanged = 0;
  let homeChanged = 0;
  let injuryChanged = 0;
  let enteralChanged = 0;
  let bathChanged = 0;
  let residentScheduleChanged = 0;
  let bulkDraftChanged = 0;
  let nursingChanged = 0;
  let facilityNoticeChanged = 0;
  let moveInOutChanged = 0;
  let bereavementChanged = 0;
  const weeklyAll = readJson(LS_WEEKLY, {});
  const nursingAll = readJson(LS_NURSING, {});
  const nursingMetaAll = readJson(LS_NURSING_META, {});
  const facilityNoticeAll = readJson(LS_FACILITY_NOTICE, {});
  const homeAll = readJson(LS_HOME_VISIT, {});
  let injuryAll = readJson(LS_INJURY_DISEASE, {});
  let enteralAll = readJson(LS_ENTERAL_MENU, {});
  let bathAll = readJson(LS_BATH_SCHEDULE, {});
  let residentPlansAll = readJson(LS_RESIDENT_PLANS, {});
  let residentRecurringAll = readJson(LS_RESIDENT_RECURRING, {});
  let residentMetaAll = readJson(LS_RESIDENT_PLANS_META, {});
  let bulkDraftAll = readJson(LS_BULK_DRAFT, {});
  let bulkDraftMetaAll = readJson(LS_BULK_DRAFT_META, {});
  let moveInOutAll = readJson(LS_MOVE_IN_OUT, []);
  let bereavementAll = readJson(LS_BEREAVEMENT, {});

  for (const row of rows) {
    const type = String(row?.store_type ?? '').trim();
    const linkKey = canonicalFacilityLinkKey(String(row?.facility_link_key ?? '').trim());
    if (!linkKey) continue;
    if (type === FACILITY_STORE_WEEKLY_PLANS) {
      const remote = Array.isArray(row.payload) ? row.payload : [];
      const local = Array.isArray(weeklyAll[linkKey]) ? weeklyAll[linkKey] : [];
      const merged = mergePlanLists(local, remote);
      if (JSON.stringify(merged) !== JSON.stringify(local)) {
        weeklyAll[linkKey] = merged;
        weeklyChanged++;
      }
    } else if (type === FACILITY_STORE_HOME_VISIT) {
      const remote = row.payload && typeof row.payload === 'object' ? row.payload : null;
      if (!remote) continue;
      const local = homeAll[linkKey];
      const merged = mergeHomeVisitRecord(local, remote);
      if (merged && JSON.stringify(merged) !== JSON.stringify(local)) {
        homeAll[linkKey] = merged;
        homeChanged++;
      }
    } else if (type === FACILITY_STORE_INJURY_DISEASE) {
      const remote =
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
      const merged = mergeInjuryDiseaseStore(injuryAll, remote);
      if (JSON.stringify(merged) !== JSON.stringify(injuryAll)) {
        injuryAll = merged;
        injuryChanged = 1;
      }
    } else if (type === FACILITY_STORE_ENTERAL_MENU) {
      const remote =
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
      const merged = mergeEnteralMenuFacilityStore(enteralAll, remote);
      if (JSON.stringify(merged) !== JSON.stringify(enteralAll)) {
        enteralAll = merged;
        enteralChanged = 1;
      }
    } else if (type === FACILITY_STORE_BATH_SCHEDULE) {
      const remote = row.payload && typeof row.payload === 'object' ? row.payload : null;
      if (!remote) continue;
      const local = bathAll[linkKey];
      const remoteAt = String(remote.savedAt ?? remote.updated_at ?? '');
      const localAt = String(local?.savedAt ?? '');
      if (!local || remoteAt >= localAt) {
        bathAll[linkKey] = remote;
        bathChanged = 1;
      }
    } else if (type === FACILITY_STORE_RESIDENT_SCHEDULE) {
      const remote = row.payload && typeof row.payload === 'object' ? row.payload : null;
      if (!remote) continue;
      const localPayload = {
        savedAt: String(residentMetaAll[linkKey]?.scheduleSavedAt ?? ''),
        residents: residentPlansAll[linkKey] ?? {},
        recurring: residentRecurringAll[linkKey] ?? {},
      };
      const merged = mergeResidentScheduleFacilityStore(localPayload, remote);
      const residentScheduleDirty =
        JSON.stringify(merged.residents ?? {}) !== JSON.stringify(localPayload.residents ?? {}) ||
        JSON.stringify(merged.recurring ?? {}) !== JSON.stringify(localPayload.recurring ?? {}) ||
        String(merged.savedAt ?? '') !== String(localPayload.savedAt ?? '');
      if (merged && residentScheduleDirty) {
        if (merged.residents && typeof merged.residents === 'object') {
          residentPlansAll[linkKey] = merged.residents;
        }
        if (merged.recurring && typeof merged.recurring === 'object') {
          residentRecurringAll[linkKey] = merged.recurring;
        }
        residentMetaAll[linkKey] = {
          ...(residentMetaAll[linkKey] && typeof residentMetaAll[linkKey] === 'object'
            ? residentMetaAll[linkKey]
            : {}),
          scheduleSavedAt: String(merged.savedAt ?? new Date().toISOString()),
        };
        residentScheduleChanged = 1;
      }
    } else if (type === FACILITY_STORE_BULK_DRAFT) {
      const remote = row.payload && typeof row.payload === 'object' ? row.payload : null;
      if (!remote) continue;
      const remoteAt = String(remote.savedAt ?? remote.updated_at ?? '');
      const localAt = String(bulkDraftMetaAll.savedAt ?? '');
      if (!localAt || remoteAt >= localAt) {
        if (remote.drafts && typeof remote.drafts === 'object') {
          bulkDraftAll = { ...bulkDraftAll, ...remote.drafts };
          bulkDraftMetaAll.savedAt = remoteAt || new Date().toISOString();
          bulkDraftChanged = 1;
        }
      }
    } else if (type === FACILITY_STORE_NURSING_DIRECTIVES) {
      const { savedAt: remoteSavedAt, directives: remoteList } = parseNursingDirectivesPayload(row.payload);
      const remoteAt =
        String(remoteSavedAt ?? '').trim() ||
        String(row.updated_at ?? '').trim();
      const localList = Array.isArray(nursingAll[linkKey]) ? nursingAll[linkKey] : [];
      const merged = mergeNursingDirectiveLists(localList, remoteList);
      if (JSON.stringify(merged) !== JSON.stringify(localList)) {
        nursingAll[linkKey] = merged;
        const localAt = String(nursingMetaAll[linkKey] ?? '').trim();
        nursingMetaAll[linkKey] = remoteAt && remoteAt >= localAt ? remoteAt : localAt || remoteAt;
        nursingChanged = 1;
      }
    } else if (type === FACILITY_STORE_FACILITY_NOTICE) {
      const remote =
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : null;
      if (!remote) continue;
      const local = facilityNoticeAll[linkKey];
      const merged = mergeFacilityNoticeRow(
        local && typeof local === 'object' ? local : null,
        remote
      );
      if (merged && JSON.stringify(merged) !== JSON.stringify(local)) {
        facilityNoticeAll[linkKey] = merged;
        facilityNoticeChanged = 1;
      }
    } else if (type === FACILITY_STORE_MOVE_IN_OUT_LOG) {
      const merged = mergeMoveInOutLogStore(moveInOutAll, row.payload);
      if (JSON.stringify(merged) !== JSON.stringify(moveInOutAll)) {
        moveInOutAll = merged;
        moveInOutChanged = 1;
      }
    } else if (type === FACILITY_STORE_BEREAVEMENT_LETTERS) {
      const merged = mergeBereavementLetterStore(bereavementAll, row.payload);
      if (JSON.stringify(merged) !== JSON.stringify(bereavementAll)) {
        bereavementAll = merged;
        bereavementChanged = 1;
      }
    }
  }

  if (weeklyChanged) writeJson(LS_WEEKLY, weeklyAll);
  if (homeChanged) writeJson(LS_HOME_VISIT, homeAll);
  if (injuryChanged) writeJson(LS_INJURY_DISEASE, injuryAll);
  if (enteralChanged) writeJson(LS_ENTERAL_MENU, enteralAll);
  if (bathChanged) {
    writeJson(LS_BATH_SCHEDULE, bathAll);
    void import('./bathingSchedule.js').then((m) => {
      for (const [fk, rec] of Object.entries(bathAll)) {
        if (rec && typeof rec === 'object') m.applyBathScheduleToDailyPlans(fk, rec);
      }
    });
  }
  if (residentScheduleChanged) {
    writeJson(LS_RESIDENT_PLANS, residentPlansAll);
    writeJson(LS_RESIDENT_RECURRING, residentRecurringAll);
    writeJson(LS_RESIDENT_PLANS_META, residentMetaAll);
  }
  if (bulkDraftChanged) {
    writeJson(LS_BULK_DRAFT, bulkDraftAll);
    writeJson(LS_BULK_DRAFT_META, bulkDraftMetaAll);
  }
  if (nursingChanged) {
    writeJson(LS_NURSING, nursingAll);
    writeJson(LS_NURSING_META, nursingMetaAll);
    void import('../services/ReportService.js').then((m) => {
      const keys = rows
        .filter((row) => String(row?.store_type ?? '').trim() === FACILITY_STORE_NURSING_DIRECTIVES)
        .map((row) => String(row?.facility_link_key ?? '').trim())
        .filter(Boolean);
      if (keys.length) m.reconcileNursingDirectivesFromCareEvents([...new Set(keys)]);
    });
  }
  if (facilityNoticeChanged) {
    writeJson(LS_FACILITY_NOTICE, facilityNoticeAll);
  }
  if (moveInOutChanged) {
    writeJson(LS_MOVE_IN_OUT, moveInOutAll);
  }
  if (bereavementChanged) {
    writeJson(LS_BEREAVEMENT, bereavementAll);
  }
  if (nursingChanged || facilityNoticeChanged || moveInOutChanged || bereavementChanged) {
    if (typeof window !== 'undefined') {
      void import('../services/ReportService.js').then((m) => {
        window.dispatchEvent(new Event(m.FACILITY_BOARD_STORAGE_EVENT));
      });
    }
  }
  const storesMerged =
    weeklyChanged +
    homeChanged +
    injuryChanged +
    enteralChanged +
    bathChanged +
    residentScheduleChanged +
    bulkDraftChanged +
    nursingChanged +
    facilityNoticeChanged +
    moveInOutChanged +
    bereavementChanged;
  if (storesMerged > 0 && typeof window !== 'undefined') {
    void import('./careEventsRealtimeSync.js').then((m) => {
      window.dispatchEvent(
        new CustomEvent(m.CARE_EVENTS_SYNC_EVENT, {
          detail: { storesMerged, weeklyChanged, residentScheduleChanged },
        })
      );
    });
  }
  return {
    weeklyChanged,
    homeChanged,
    injuryChanged,
    enteralChanged,
    bathChanged,
    residentScheduleChanged,
    bulkDraftChanged,
    nursingChanged,
    facilityNoticeChanged,
    moveInOutChanged,
    bereavementChanged,
    storesMerged,
  };
}

/** 看護重要指示の保存直後にクラウドへ送る */
export function queueNursingDirectivesCloudSync(facilityLinkKey) {
  queueFacilityPortalStoreSync(FACILITY_STORE_NURSING_DIRECTIVES, facilityLinkKey);
}

/** 本日の周知事項の保存直後にクラウドへ送る */
export function queueFacilityNoticeCloudSync(facilityLinkKey) {
  queueFacilityPortalStoreSync(FACILITY_STORE_FACILITY_NOTICE, facilityLinkKey);
}

/** 入退所ログ（死亡退去含む）をクラウドへ送る */
export function queueMoveInOutLogCloudSync() {
  queueFacilityPortalStoreSync(FACILITY_STORE_MOVE_IN_OUT_LOG, FACILITY_STORE_ORG_KEY);
}

/** ご家族への手紙（逝去半年）をクラウドへ送る */
export function queueBereavementLettersCloudSync() {
  queueFacilityPortalStoreSync(FACILITY_STORE_BEREAVEMENT_LETTERS, FACILITY_STORE_ORG_KEY);
}

/** 経管メニュー下書き保存後にクラウドへ送る */
export function queueEnteralMenuCloudSync(facilityLinkKey) {
  queueFacilityPortalStoreSync(FACILITY_STORE_ENTERAL_MENU, FACILITY_STORE_ORG_KEY);
  void facilityLinkKey;
}

/** 入浴予定表保存後にクラウドへ送る */
export function queueBathScheduleCloudSync(facilityLinkKey) {
  queueFacilityPortalStoreSync(FACILITY_STORE_BATH_SCHEDULE, facilityLinkKey);
}

/** 利用者予定（1か月・毎週）保存後にクラウドへ送る */
export function queueResidentScheduleCloudSync(facilityLinkKey) {
  queueFacilityPortalStoreSync(FACILITY_STORE_RESIDENT_SCHEDULE, facilityLinkKey);
}

/** 一覧表の入力下書きをクラウドへ送る（組織共通） */
export function queueBulkTableDraftCloudSync() {
  queueFacilityPortalStoreSync(FACILITY_STORE_BULK_DRAFT, FACILITY_STORE_ORG_KEY);
}

/** 傷病一覧CSV取り込み後にクラウドへ送る */
export function queueInjuryDiseaseCloudSync() {
  queueFacilityPortalStoreSync(FACILITY_STORE_INJURY_DISEASE, FACILITY_STORE_ORG_KEY);
}

/**
 * @param {string} storeType
 * @param {string} facilityLinkKey
 */
export function queueFacilityPortalStoreSync(storeType, facilityLinkKey) {
  if (!isCareCloudSyncConfigured()) return;
  const k = canonicalFacilityLinkKey(facilityLinkKey);
  const t = String(storeType ?? '').trim();
  if (!k || !t) return;
  pendingKeys.add(`${t}:${k}`);
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void flushFacilityPortalStoresCloud();
  }, FLUSH_DEBOUNCE_MS);
}

/** キュー登録と送信を連続実行（予定カレンダー等の保存直後用） */
export async function syncFacilityStoreNow(storeType, facilityLinkKey) {
  if (!isCareCloudSyncConfigured()) return { ok: true, skipped: true, upserted: 0 };
  const k = canonicalFacilityLinkKey(facilityLinkKey);
  const t = String(storeType ?? '').trim();
  if (!k || !t) return { ok: true, upserted: 0 };
  pendingKeys.add(`${t}:${k}`);
  if (flushTimer) {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
  }
  return flushFacilityPortalStoresCloud();
}

export async function flushFacilityPortalStoresCloud() {
  if (!isCareCloudSyncConfigured() || flushing || pendingKeys.size === 0) {
    return { ok: true, upserted: 0 };
  }
  flushing = true;
  const keys = [...pendingKeys];
  pendingKeys.clear();
  let upserted = 0;
  try {
    for (const key of keys) {
      const [storeType, facilityLinkKey] = key.split(':');
      if (!storeType || !facilityLinkKey) continue;
      let payload = null;
      let updatedAt = new Date().toISOString();
      if (storeType === FACILITY_STORE_WEEKLY_PLANS) {
        const all = readJson(LS_WEEKLY, {});
        payload = Array.isArray(all[facilityLinkKey]) ? all[facilityLinkKey] : [];
        const last = payload[payload.length - 1];
        if (last?.ts) updatedAt = String(last.ts);
      } else if (storeType === FACILITY_STORE_HOME_VISIT) {
        const all = readJson(LS_HOME_VISIT, {});
        payload = all[facilityLinkKey] ?? null;
        if (!payload) continue;
        updatedAt = String(payload.updatedAt ?? updatedAt);
      } else if (storeType === FACILITY_STORE_INJURY_DISEASE) {
        payload = readJson(LS_INJURY_DISEASE, {});
        const times = Object.values(payload)
          .map((r) => String(r?.importedAt ?? ''))
          .filter(Boolean)
          .sort();
        if (times.length) updatedAt = times[times.length - 1];
      } else if (storeType === FACILITY_STORE_ENTERAL_MENU) {
        payload = readJson(LS_ENTERAL_MENU, {});
        const times = Object.values(payload)
          .map((r) => String(r?.savedAt ?? ''))
          .filter(Boolean)
          .sort();
        if (times.length) updatedAt = times[times.length - 1];
        if (!Object.keys(payload).length) continue;
      } else if (storeType === FACILITY_STORE_BATH_SCHEDULE) {
        const all = readJson(LS_BATH_SCHEDULE, {});
        payload = all[facilityLinkKey] ?? null;
        if (!payload) continue;
        updatedAt = String(payload.savedAt ?? updatedAt);
      } else if (storeType === FACILITY_STORE_BULK_DRAFT) {
        const drafts = readJson(LS_BULK_DRAFT, {});
        const meta = readJson(LS_BULK_DRAFT_META, {});
        if (!drafts || !Object.keys(drafts).length) continue;
        updatedAt = String(meta.savedAt ?? updatedAt);
        payload = { savedAt: updatedAt, drafts };
      } else if (storeType === FACILITY_STORE_RESIDENT_SCHEDULE) {
        const plansAll = readJson(LS_RESIDENT_PLANS, {});
        const recurringAll = readJson(LS_RESIDENT_RECURRING, {});
        const metaAll = readJson(LS_RESIDENT_PLANS_META, {});
        const residents = plansAll[facilityLinkKey];
        const recurring = recurringAll[facilityLinkKey];
        if (
          (!residents || !Object.keys(residents).length) &&
          (!recurring || !Object.keys(recurring).length)
        ) {
          continue;
        }
        updatedAt = String(metaAll[facilityLinkKey]?.scheduleSavedAt ?? updatedAt);
        payload = {
          savedAt: updatedAt,
          residents: residents && typeof residents === 'object' ? residents : {},
          recurring: recurring && typeof recurring === 'object' ? recurring : {},
        };
      } else if (storeType === FACILITY_STORE_NURSING_DIRECTIVES) {
        const all = readJson(LS_NURSING, {});
        const metaAll = readJson(LS_NURSING_META, {});
        const directives = Array.isArray(all[facilityLinkKey]) ? all[facilityLinkKey] : [];
        if (!directives.length && !metaAll[facilityLinkKey]) continue;
        updatedAt = String(metaAll[facilityLinkKey] ?? updatedAt);
        payload = { savedAt: updatedAt, directives };
      } else if (storeType === FACILITY_STORE_FACILITY_NOTICE) {
        const all = readJson(LS_FACILITY_NOTICE, {});
        payload = all[facilityLinkKey] ?? null;
        if (!payload || typeof payload !== 'object') continue;
        updatedAt = String(payload.updatedAt ?? updatedAt);
      } else if (storeType === FACILITY_STORE_MOVE_IN_OUT_LOG) {
        const logs = readJson(LS_MOVE_IN_OUT, []);
        if (!Array.isArray(logs) || !logs.length) continue;
        const times = logs.map((x) => String(x?.createdAt ?? '')).filter(Boolean).sort();
        updatedAt = times[times.length - 1] ?? updatedAt;
        payload = { savedAt: updatedAt, logs };
      } else if (storeType === FACILITY_STORE_BEREAVEMENT_LETTERS) {
        const drafts = readJson(LS_BEREAVEMENT, {});
        if (!drafts || !Object.keys(drafts).length) continue;
        const times = Object.values(drafts)
          .map((x) => String(x?.updatedAt ?? ''))
          .filter(Boolean)
          .sort();
        updatedAt = times[times.length - 1] ?? updatedAt;
        payload = { savedAt: updatedAt, drafts };
      } else {
        continue;
      }
      await careSyncPost({
        action: 'upsert_facility_store',
        storeType,
        facilityLinkKey,
        payload,
        updatedAt,
      });
      upserted++;
    }
    if (pendingKeys.size > 0) {
      if (flushTimer) window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => {
        flushTimer = 0;
        void flushFacilityPortalStoresCloud();
      }, FLUSH_DEBOUNCE_MS);
    }
    return { ok: true, upserted };
  } finally {
    flushing = false;
  }
}

export async function pullAndMergeFacilityPortalStores() {
  if (!isCareCloudSyncConfigured()) return { ok: true, skipped: true, storesMerged: 0 };
  const result = await careSyncPost({
    action: 'pull_facility_stores',
    storeTypes: [
      FACILITY_STORE_WEEKLY_PLANS,
      FACILITY_STORE_HOME_VISIT,
      FACILITY_STORE_INJURY_DISEASE,
      FACILITY_STORE_ENTERAL_MENU,
      FACILITY_STORE_BATH_SCHEDULE,
      FACILITY_STORE_RESIDENT_SCHEDULE,
      FACILITY_STORE_BULK_DRAFT,
      FACILITY_STORE_NURSING_DIRECTIVES,
      FACILITY_STORE_FACILITY_NOTICE,
      FACILITY_STORE_MOVE_IN_OUT_LOG,
      FACILITY_STORE_BEREAVEMENT_LETTERS,
    ],
  });
  const rows = Array.isArray(result?.stores) ? result.stores : [];
  if (!rows.length) return { ok: true, pulled: 0, storesMerged: 0 };
  const applied = applyFacilityStoresToLocal(rows);
  return {
    ok: true,
    pulled: rows.length,
    storesMerged: Number(applied.storesMerged ?? 0),
    weeklyChanged: applied.weeklyChanged,
    homeChanged: applied.homeChanged,
    injuryChanged: applied.injuryChanged,
    enteralChanged: applied.enteralChanged,
    bathChanged: applied.bathChanged,
    residentScheduleChanged: applied.residentScheduleChanged,
    bulkDraftChanged: applied.bulkDraftChanged,
    nursingChanged: applied.nursingChanged,
    facilityNoticeChanged: applied.facilityNoticeChanged,
    moveInOutChanged: applied.moveInOutChanged,
    bereavementChanged: applied.bereavementChanged,
  };
}

/** 初回: ローカルの予定・往診カレンダーをクラウドへ */
export async function pushAllFacilityPortalStoresCloud() {
  if (!isCareCloudSyncConfigured()) return { ok: true, skipped: true, upserted: 0 };
  const weeklyAll = readJson(LS_WEEKLY, {});
  const homeAll = readJson(LS_HOME_VISIT, {});
  let upserted = 0;
  for (const [facilityLinkKey, plans] of Object.entries(weeklyAll)) {
    if (!facilityLinkKey || !Array.isArray(plans) || !plans.length) continue;
    const last = plans[plans.length - 1];
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_WEEKLY_PLANS,
      facilityLinkKey,
      payload: plans,
      updatedAt: String(last?.ts ?? new Date().toISOString()),
    });
    upserted++;
  }
  for (const [facilityLinkKey, rec] of Object.entries(homeAll)) {
    if (!facilityLinkKey || !rec || typeof rec !== 'object') continue;
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_HOME_VISIT,
      facilityLinkKey,
      payload: rec,
      updatedAt: String(rec.updatedAt ?? new Date().toISOString()),
    });
    upserted++;
  }
  const injuryAll = readJson(LS_INJURY_DISEASE, {});
  if (injuryAll && typeof injuryAll === 'object' && Object.keys(injuryAll).length) {
    const times = Object.values(injuryAll)
      .map((r) => String(r?.importedAt ?? ''))
      .filter(Boolean)
      .sort();
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_INJURY_DISEASE,
      facilityLinkKey: FACILITY_STORE_ORG_KEY,
      payload: injuryAll,
      updatedAt: times[times.length - 1] ?? new Date().toISOString(),
    });
    upserted++;
  }
  const enteralAll = readJson(LS_ENTERAL_MENU, {});
  if (enteralAll && typeof enteralAll === 'object' && Object.keys(enteralAll).length) {
    const times = Object.values(enteralAll)
      .map((r) => String(r?.savedAt ?? ''))
      .filter(Boolean)
      .sort();
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_ENTERAL_MENU,
      facilityLinkKey: FACILITY_STORE_ORG_KEY,
      payload: enteralAll,
      updatedAt: times[times.length - 1] ?? new Date().toISOString(),
    });
    upserted++;
  }
  const bathAll = readJson(LS_BATH_SCHEDULE, {});
  for (const [facilityLinkKey, rec] of Object.entries(bathAll)) {
    if (!facilityLinkKey || !rec || typeof rec !== 'object') continue;
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_BATH_SCHEDULE,
      facilityLinkKey,
      payload: rec,
      updatedAt: String(rec.savedAt ?? new Date().toISOString()),
    });
    upserted++;
  }
  const plansAll = readJson(LS_RESIDENT_PLANS, {});
  const recurringAll = readJson(LS_RESIDENT_RECURRING, {});
  const metaAll = readJson(LS_RESIDENT_PLANS_META, {});
  const bulkDraftAll = readJson(LS_BULK_DRAFT, {});
  const bulkDraftMeta = readJson(LS_BULK_DRAFT_META, {});
  if (bulkDraftAll && Object.keys(bulkDraftAll).length) {
    const updatedAt = String(bulkDraftMeta.savedAt ?? new Date().toISOString());
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_BULK_DRAFT,
      facilityLinkKey: FACILITY_STORE_ORG_KEY,
      payload: { savedAt: updatedAt, drafts: bulkDraftAll },
      updatedAt,
    });
    upserted++;
  }
  const nursingAll = readJson(LS_NURSING, {});
  const nursingMetaAll = readJson(LS_NURSING_META, {});
  for (const [facilityLinkKey, directives] of Object.entries(nursingAll)) {
    if (!facilityLinkKey || !Array.isArray(directives) || !directives.length) continue;
    const updatedAt = String(nursingMetaAll[facilityLinkKey] ?? new Date().toISOString());
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_NURSING_DIRECTIVES,
      facilityLinkKey,
      payload: { savedAt: updatedAt, directives },
      updatedAt,
    });
    upserted++;
  }
  const facilityNoticeAll = readJson(LS_FACILITY_NOTICE, {});
  for (const [facilityLinkKey, row] of Object.entries(facilityNoticeAll)) {
    if (!facilityLinkKey || !row || typeof row !== 'object') continue;
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_FACILITY_NOTICE,
      facilityLinkKey,
      payload: row,
      updatedAt: String(row.updatedAt ?? new Date().toISOString()),
    });
    upserted++;
  }
  const moveInOutLogs = readJson(LS_MOVE_IN_OUT, []);
  if (Array.isArray(moveInOutLogs) && moveInOutLogs.length) {
    const times = moveInOutLogs.map((x) => String(x?.createdAt ?? '')).filter(Boolean).sort();
    const updatedAt = times[times.length - 1] ?? new Date().toISOString();
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_MOVE_IN_OUT_LOG,
      facilityLinkKey: FACILITY_STORE_ORG_KEY,
      payload: { savedAt: updatedAt, logs: moveInOutLogs },
      updatedAt,
    });
    upserted++;
  }
  const bereavementDrafts = readJson(LS_BEREAVEMENT, {});
  if (bereavementDrafts && typeof bereavementDrafts === 'object' && Object.keys(bereavementDrafts).length) {
    const times = Object.values(bereavementDrafts)
      .map((x) => String(x?.updatedAt ?? ''))
      .filter(Boolean)
      .sort();
    const updatedAt = times[times.length - 1] ?? new Date().toISOString();
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_BEREAVEMENT_LETTERS,
      facilityLinkKey: FACILITY_STORE_ORG_KEY,
      payload: { savedAt: updatedAt, drafts: bereavementDrafts },
      updatedAt,
    });
    upserted++;
  }
  for (const facilityLinkKey of new Set([
    ...Object.keys(plansAll),
    ...Object.keys(recurringAll),
  ])) {
    if (!facilityLinkKey) continue;
    const residents = plansAll[facilityLinkKey];
    const recurring = recurringAll[facilityLinkKey];
    if (
      (!residents || !Object.keys(residents).length) &&
      (!recurring || !Object.keys(recurring).length)
    ) {
      continue;
    }
    const updatedAt = String(metaAll[facilityLinkKey]?.scheduleSavedAt ?? new Date().toISOString());
    await careSyncPost({
      action: 'upsert_facility_store',
      storeType: FACILITY_STORE_RESIDENT_SCHEDULE,
      facilityLinkKey,
      payload: {
        savedAt: updatedAt,
        residents: residents && typeof residents === 'object' ? residents : {},
        recurring: recurring && typeof recurring === 'object' ? recurring : {},
      },
      updatedAt,
    });
    upserted++;
  }
  return { ok: true, upserted };
}
