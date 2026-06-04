/**
 * 生活記録 + 施設ストア（傷病一覧の病名・予定カレンダー等）をまとめて pull
 */

import { pullAndApplyCareEventsCloud } from './careEventsSupabaseSync.js';
import { pullAndMergeFacilityPortalStores } from './facilityPortalStoreSync.js';

/** @returns {Promise<{ merged?: number; pulled?: number; storesMerged?: number; injuryChanged?: number }>} */
export async function pullAllCloudDataAndApply() {
  const pull = await pullAndApplyCareEventsCloud();
  const stores = await pullAndMergeFacilityPortalStores();
  const merged = Number(pull?.merged ?? 0) + Number(stores?.storesMerged ?? 0);
  return {
    ...pull,
    ...stores,
    merged,
    injuryChanged: Number(stores?.injuryChanged ?? 0),
  };
}
