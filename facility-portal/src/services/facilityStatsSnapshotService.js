/**
 * 施設別名簿集計の「月別スナップショット」（このブラウザの localStorage のみ）。
 * 再取得のたびに、選択中の表示月キーで上書き保存し、先月の在籍・床数などを後から参照できるようにする。
 */

const LS_KEY = 'carelink_facility_stats_snapshots_v1';
const MAX_MONTHS = 48;

/** @returns {Record<string, { fetchedAt: string; facilities: unknown[] }>} */
function readStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, { fetchedAt: string; facilities: unknown[] }>} map */
function writeStore(map) {
  const keys = Object.keys(map).sort();
  const pruned = {};
  for (const k of keys.slice(-MAX_MONTHS)) pruned[k] = map[k];
  localStorage.setItem(LS_KEY, JSON.stringify(pruned));
}

/**
 * @param {string} yearMonth YYYY-MM
 * @returns {{ yearMonth: string; fetchedAt: string; facilities: unknown[] } | null}
 */
export function getFacilityStatsSnapshot(yearMonth) {
  const ym = String(yearMonth ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  const map = readStore();
  const row = map[ym];
  if (!row || !Array.isArray(row.facilities)) return null;
  return {
    yearMonth: ym,
    fetchedAt: String(row.fetchedAt ?? ''),
    facilities: row.facilities,
  };
}

/**
 * @param {string} yearMonth YYYY-MM
 * @param {{ facilities: unknown[]; fetchedAt: string }} payload
 */
export function saveFacilityStatsSnapshot(yearMonth, payload) {
  const ym = String(yearMonth ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return;
  const facilities = payload?.facilities;
  if (!Array.isArray(facilities)) return;
  const map = readStore();
  map[ym] = {
    fetchedAt: String(payload?.fetchedAt ?? new Date().toISOString()),
    facilities: JSON.parse(JSON.stringify(facilities)),
  };
  writeStore(map);
}

/** @returns {string[]} 新しい月順 */
export function listFacilityStatsSnapshotMonths() {
  const map = readStore();
  return Object.keys(map)
    .filter((k) => /^\d{4}-\d{2}$/.test(k))
    .sort((a, b) => b.localeCompare(a, 'en'));
}
