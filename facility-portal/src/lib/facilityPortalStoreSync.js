/**
 * 予定カレンダー・往診カレンダー等（localStorage）のクラウド同期
 */

import { careSyncPost, isCareCloudSyncConfigured } from './careEventsSupabaseSync.js';

export const FACILITY_STORE_WEEKLY_PLANS = 'weekly_plans';
export const FACILITY_STORE_HOME_VISIT = 'home_visit_calendar';
export const FACILITY_STORE_INJURY_DISEASE = 'injury_disease_by_resident';
export const FACILITY_STORE_ENTERAL_MENU = 'enteral_nutrition_menu';
export const FACILITY_STORE_BATH_SCHEDULE = 'bath_schedule';
export const FACILITY_STORE_RESIDENT_SCHEDULE = 'resident_daily_schedule';
export const FACILITY_STORE_BULK_DRAFT = 'bulk_table_draft';
/** 組織全体で1つ（利用者IDキー） */
export const FACILITY_STORE_ORG_KEY = '__org__';

const LS_WEEKLY = 'carelink_os_weekly_plans_v1';
const LS_HOME_VISIT = 'carelink_os_home_visit_calendar_v1';
const LS_INJURY_DISEASE = 'carelink_os_injury_disease_by_resident_v1';
const LS_ENTERAL_MENU = 'carelink_os_enteral_nutrition_menu_v1';
const LS_BATH_SCHEDULE = 'carelink_os_bath_schedule_v1';
const LS_RESIDENT_PLANS = 'carelink_os_resident_daily_plans_v1';
const LS_RESIDENT_RECURRING = 'carelink_os_resident_recurring_plans_v1';
const LS_RESIDENT_PLANS_META = 'carelink_os_resident_daily_plans_meta_v1';
const LS_BULK_DRAFT = 'carelink_os_bulk_table_draft_v1';
const LS_BULK_DRAFT_META = 'carelink_os_bulk_table_draft_meta_v1';
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
  const weeklyAll = readJson(LS_WEEKLY, {});
  const homeAll = readJson(LS_HOME_VISIT, {});
  let injuryAll = readJson(LS_INJURY_DISEASE, {});
  let enteralAll = readJson(LS_ENTERAL_MENU, {});
  let bathAll = readJson(LS_BATH_SCHEDULE, {});
  let residentPlansAll = readJson(LS_RESIDENT_PLANS, {});
  let residentRecurringAll = readJson(LS_RESIDENT_RECURRING, {});
  let residentMetaAll = readJson(LS_RESIDENT_PLANS_META, {});
  let bulkDraftAll = readJson(LS_BULK_DRAFT, {});
  let bulkDraftMetaAll = readJson(LS_BULK_DRAFT_META, {});

  for (const row of rows) {
    const type = String(row?.store_type ?? '').trim();
    const linkKey = String(row?.facility_link_key ?? '').trim();
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
      const remoteAt = String(remote.updatedAt ?? remote.updated_at ?? '');
      const localAt = String(local?.updatedAt ?? '');
      if (!local || remoteAt >= localAt) {
        homeAll[linkKey] = remote;
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
  const storesMerged =
    weeklyChanged +
    homeChanged +
    injuryChanged +
    enteralChanged +
    bathChanged +
    residentScheduleChanged +
    bulkDraftChanged;
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
    storesMerged,
  };
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
  const k = String(facilityLinkKey ?? '').trim();
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
  const k = String(facilityLinkKey ?? '').trim();
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
