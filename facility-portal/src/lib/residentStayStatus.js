/**
 * 利用者カード表示用: 入院中・入居予定・退院予定
 */

/**
 * @param {string} ymd
 */
export function formatStayDateLabel(ymd) {
  const s = String(ymd ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * @typedef {{
 *   hospitalized?: boolean;
 *   hospitalSince?: string;
 *   dischargePlannedDate?: string;
 *   moveInPlannedDate?: string;
 *   note?: string;
 *   updatedAt?: string;
 * }} ResidentStayStatus
 */

/**
 * @param {unknown} raw
 * @returns {ResidentStayStatus | null}
 */
export function normalizeResidentStayStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const hospitalized = Boolean(o.hospitalized);
  const hospitalSince = String(o.hospitalSince ?? '').trim();
  const dischargePlannedDate = String(o.dischargePlannedDate ?? '').trim();
  const moveInPlannedDate = String(o.moveInPlannedDate ?? '').trim();
  const note = String(o.note ?? '').trim();
  if (!hospitalized && !hospitalSince && !dischargePlannedDate && !moveInPlannedDate && !note) {
    return null;
  }
  return {
    hospitalized,
    hospitalSince,
    dischargePlannedDate,
    moveInPlannedDate,
    note,
    updatedAt: String(o.updatedAt ?? '').trim(),
  };
}

/**
 * @param {ResidentStayStatus | null | undefined} status
 * @returns {{ key: string; label: string; className: string }[]}
 */
export function buildResidentStayStatusBadges(status) {
  const s = normalizeResidentStayStatus(status);
  if (!s) return [];
  /** @type {{ key: string; label: string; className: string }[]} */
  const out = [];
  if (s.hospitalized) {
    let label = '入院中';
    if (s.hospitalSince) label += `（${formatStayDateLabel(s.hospitalSince)}〜）`;
    out.push({
      key: 'hospitalized',
      label,
      className: 'border-rose-500 bg-rose-600 text-white',
    });
  }
  if (s.dischargePlannedDate) {
    out.push({
      key: 'discharge',
      label: `退院予定 ${formatStayDateLabel(s.dischargePlannedDate)}`,
      className: 'border-amber-500 bg-amber-100 text-amber-950',
    });
  }
  if (s.moveInPlannedDate) {
    out.push({
      key: 'move_in',
      label: `入居予定 ${formatStayDateLabel(s.moveInPlannedDate)}`,
      className: 'border-teal-500 bg-teal-100 text-teal-950',
    });
  }
  return out;
}

export const STAY_STATUS_CHANGED_EVENT = 'carelink:resident-stay-status';

/**
 * @param {string} residentId
 */
export function notifyResidentStayStatusChanged(residentId) {
  try {
    window.dispatchEvent(
      new CustomEvent(STAY_STATUS_CHANGED_EVENT, { detail: { residentId: String(residentId ?? '').trim() } })
    );
  } catch {
    /* SSR / テスト */
  }
}
