/** 介護・生活記録の法定保存期間（年） */
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
 * 保存義務期間（5年）を超えたイベントのみ除外
 * @param {unknown[]} list
 * @returns {unknown[]}
 */
export function pruneCareEventsBeyondRetention(list) {
  if (!Array.isArray(list)) return [];
  const cutoff = Date.now() - CARE_RECORD_RETENTION_MS;
  return list.filter((e) => {
    if (e == null || typeof e !== 'object') return false;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) return true;
    return t >= cutoff;
  });
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
