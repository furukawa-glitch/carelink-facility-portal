/** 介護・生活記録の法定最低保存期間（年）。表示・監査用。自動削除には使わない。 */
export const CARE_RECORD_RETENTION_YEARS = 5;

export const CARE_RECORD_RETENTION_MS = CARE_RECORD_RETENTION_YEARS * 365.25 * 24 * 60 * 60 * 1000;

/**
 * @param {string | number | Date} ts
 * @returns {boolean}
 */
export function isCareRecordWithinRetention(ts) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return true;
  return Date.now() - t <= CARE_RECORD_RETENTION_MS;
}

/**
 * 不正行のみ除外。5年超の記録は自動削除しない（データ内に保持）。
 * @param {unknown[]} list
 * @returns {unknown[]}
 */
export function pruneCareEventsBeyondRetention(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e != null && typeof e === 'object');
}

/**
 * @param {unknown[]} list
 */
export function oldestCareEventYmd(list) {
  if (!Array.isArray(list) || !list.length) return '';
  let min = Infinity;
  for (const e of list) {
    const t = new Date(e?.ts).getTime();
    if (Number.isFinite(t) && t < min) min = t;
  }
  if (!Number.isFinite(min)) return '';
  const d = new Date(min);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {unknown[]} list
 */
export function careEventsRetentionSummary(list) {
  const arr = Array.isArray(list) ? list : [];
  const within = arr.filter((e) => isCareRecordWithinRetention(e?.ts));
  return {
    total: arr.length,
    withinRetention: within.length,
    oldestYmd: oldestCareEventYmd(arr),
    retentionYears: CARE_RECORD_RETENTION_YEARS,
  };
}
