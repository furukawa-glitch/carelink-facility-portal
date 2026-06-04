/**

 * 生活記録の自動クラウド同期（全PCで手動ボタン不要）。

 * 起動時 pull・定期 pull・タブ復帰時 pull+push・Realtime・初回のみローカル全件送信。

 */



import { pullAllCloudDataAndApply } from './cloudDataSync.js';

import {

  flushCareEventsCloudSync,

  isCareCloudSyncConfigured,

  pushAllLocalCareEventsCloud,

} from './careEventsSupabaseSync.js';

import {

  flushFacilityPortalStoresCloud,

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

 * クラウドへ送る → クラウドから取る

 * @param {(result: object) => void} [onApplied]

 * @param {{ fullPush?: boolean }} [opts] fullPush: 手動同期時にローカル全件を再送信

 */

export async function syncCareEventsNow(onApplied, opts = {}) {

  if (!isCareCloudSyncConfigured()) return { ok: true, skipped: true };



  const fullPush = opts.fullPush === true;

  /** @type {Record<string, unknown>} */

  const out = {

    ok: true,

    pulled: 0,

    merged: 0,

    storesMerged: 0,

    pushedEvents: 0,

    pushedStores: 0,

  };



  await flushCareEventsCloudSync();

  await flushFacilityPortalStoresCloud();



  if (fullPush) {

    const pe = await pushAllLocalCareEventsCloud();

    const ps = await pushAllFacilityPortalStoresCloud();

    out.pushedEvents = Number(pe?.upserted ?? 0);

    out.pushedStores = Number(ps?.upserted ?? 0);

  }



  const pull = await pullAllCloudDataAndApply({ reload: true });

  Object.assign(out, pull);

  out.merged = Number(pull?.merged ?? 0);

  out.pulled = Number(pull?.pulled ?? 0);

  out.storesMerged = Number(pull?.storesMerged ?? 0);

  if (fullPush) {
    const report = await import('../services/ReportService.js');
    out.localEventCount = report.getAllCareEvents().length;
    onApplied?.(out);
  }

  const shouldNotify =
    fullPush ||
    Number(out.merged ?? 0) > 0 ||
    Number(out.storesMerged ?? 0) > 0 ||
    Number(out.pushedEvents ?? 0) > 0 ||
    Number(out.pushedStores ?? 0) > 0 ||
    Number(out.pulled ?? 0) > 0;

  if (shouldNotify) {
    dispatchSyncEvent(out);
    if (!fullPush) onApplied?.(out);
  }

  return out;

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

    const upserted = Number(result?.upserted ?? 0) + Number(storesResult?.upserted ?? 0);

    if (upserted > 0) {

      localStorage.setItem(BOOTSTRAP_LS_KEY, '1');

      const detail = { upserted, bootstrap: true };

      dispatchSyncEvent(detail);

      onApplied?.(detail);

    }

  } catch {

    /* 次回起動で再試行（BOOTSTRAP フラグは立てない） */

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

    void syncCareEventsNow(onApplied).catch(() => {});

  };



  void syncCareEventsNow(onApplied)

    .catch(() => {})

    .then(() => {

      if (!bootstrapStarted) {

        bootstrapStarted = true;

        void runCloudBootstrapOnce(onApplied);

      }

    });



  const stopRealtime = startCareEventsRealtimeSync(onApplied);

  const intervalId = window.setInterval(() => void syncCareEventsNow(onApplied).catch(() => {}), AUTO_PULL_INTERVAL_MS);

  window.addEventListener('focus', onVisible);

  document.addEventListener('visibilitychange', onVisible);



  const flushOnHide = () => {

    void flushCareEventsCloudSync();

    void flushFacilityPortalStoresCloud();

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


