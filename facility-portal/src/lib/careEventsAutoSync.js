/**
 * 生活記録の自動クラウド同期（全PCで手動ボタン不要）。
 * 起動時 pull・定期 pull・タブ復帰時 pull+push・Realtime・初回のみローカル全件送信。
 */

import {
  flushCareEventsCloudSync,
  isCareCloudSyncConfigured,
  pullAndApplyCareEventsCloud,
  pushAllLocalCareEventsCloud,
} from './careEventsSupabaseSync.js';
import {
  flushFacilityPortalStoresCloud,
  pullAndMergeFacilityPortalStores,
  pushAllFacilityPortalStoresCloud,
} from './facilityPortalStoreSync.js';
import { CARE_EVENTS_SYNC_EVENT, startCareEventsRealtimeSync } from './careEventsRealtimeSync.js';

const BOOTSTRAP_LS_KEY = 'carelink_care_cloud_bootstrap_done_v1';
const AUTO_PULL_INTERVAL_MS = 60_000;

let bootstrapStarted = false;

function dispatchSyncEvent(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CARE_EVENTS_SYNC_EVENT, { detail }));
}

/**
 * クラウド pull → 未送信キュー flush
 * @param {(result: { merged?: number; pulled?: number }) => void} [onApplied]
 */
export async function syncCareEventsNow(onApplied) {
  if (!isCareCloudSyncConfigured()) return { ok: true, skipped: true };
  let pull = { ok: true, pulled: 0, merged: 0 };
  let stores = { storesMerged: 0 };
  try {
    pull = await pullAndApplyCareEventsCloud();
    stores = await pullAndMergeFacilityPortalStores();
    const merged = Number(pull?.merged ?? 0) + Number(stores?.storesMerged ?? 0);
    if (merged > 0 || Number(pull?.pulled ?? 0) > 0 || Number(stores?.pulled ?? 0) > 0) {
      dispatchSyncEvent({ ...pull, ...stores, merged });
      onApplied?.({ ...pull, ...stores, merged });
    }
  } catch {
    /* 継続 */
  }
  try {
    await flushCareEventsCloudSync();
    await flushFacilityPortalStoresCloud();
  } catch {
    /* 継続 */
  }
  return { ...pull, ...stores };
}

/**
 * この端末にだけ溜まっている記録を、初回1回だけクラウドへ載せる（確認ダイアログなし）
 */
async function runCloudBootstrapOnce(onApplied) {
  if (!isCareCloudSyncConfigured()) return;
  if (localStorage.getItem(BOOTSTRAP_LS_KEY) === '1') return;
  try {
    const report = await import('../services/ReportService.js');
    const all = report.getAllCareEvents();
    if (!all.length) {
      localStorage.setItem(BOOTSTRAP_LS_KEY, '1');
      return;
    }
    const result = await pushAllLocalCareEventsCloud();
    const storesResult = await pushAllFacilityPortalStoresCloud();
    localStorage.setItem(BOOTSTRAP_LS_KEY, '1');
    const detail = {
      upserted: Number(result?.upserted ?? 0) + Number(storesResult?.upserted ?? 0),
      bootstrap: true,
    };
    dispatchSyncEvent(detail);
    onApplied?.(detail);
  } catch {
    /* 次回起動で再試行 */
  }
}

/**
 * @param {(result: object) => void} [onApplied]
 * @returns {() => void} cleanup
 */
export function startCareEventsAutoSync(onApplied) {
  if (!isCareCloudSyncConfigured()) return () => {};

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    void syncCareEventsNow(onApplied);
  };

  void syncCareEventsNow(onApplied).then(() => {
    if (!bootstrapStarted) {
      bootstrapStarted = true;
      void runCloudBootstrapOnce(onApplied);
    }
  });

  const stopRealtime = startCareEventsRealtimeSync(onApplied);
  const intervalId = window.setInterval(() => void syncCareEventsNow(onApplied), AUTO_PULL_INTERVAL_MS);
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);

  const flushOnHide = () => {
    void flushCareEventsCloudSync();
  };
  window.addEventListener('pagehide', flushOnHide);

  return () => {
    stopRealtime();
    window.clearInterval(intervalId);
    window.removeEventListener('focus', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', flushOnHide);
  };
}
