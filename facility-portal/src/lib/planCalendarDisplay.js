/**
 * 施設予定カレンダー: 重要予定の判定・時刻順ソート・入退院等
 */

import { getResidentStayStatus } from '../services/ReportService.js';

export const PLAN_CALENDAR_EXPANDED_LS = 'carelink_plan_calendar_expanded_v1';

/** @param {string} t */
export function parsePlanTimeMinutes(t) {
  const s = String(t ?? '').trim();
  if (!s || s === '—' || s === '--') return 24 * 60 + 1;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return 24 * 60 + 1;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
export function comparePlansByTime(a, b) {
  const da = parsePlanTimeMinutes(String(a?.time ?? ''));
  const db = parsePlanTimeMinutes(String(b?.time ?? ''));
  if (da !== db) return da - db;
  return String(a?.title ?? '').localeCompare(String(b?.title ?? ''), 'ja');
}

/** @param {unknown[]} plans */
export function sortPlansByTime(plans) {
  return [...(Array.isArray(plans) ? plans : [])].sort(comparePlansByTime);
}

/** @param {string} name */
function residentShortName(name) {
  return String(name ?? '')
    .replace(/様\s*$/u, '')
    .trim();
}

/**
 * 施設カレンダーに載せる重要予定（往診・外部受診・入院・入居・退院）
 * @param {Record<string, unknown>} plan
 */
export function isImportantFacilityPlan(plan) {
  const source = String(plan?.source ?? '');
  const type = String(plan?.type ?? '').trim();
  const title = String(plan?.title ?? '').trim();

  if (source === 'home_visit_calendar' || source === 'stay_status') return true;
  if (type === '往診' || type === '受診' || type === '入院' || type === '入居' || type === '退院') {
    return true;
  }
  if (/往診/u.test(title)) return true;
  if (/面会/u.test(title) && type === '面会') return false;
  if (/外部.?受診|受診|病院|診察|入院|入居|退院/u.test(title)) return true;

  if (source === 'resident_schedule') {
    return type === '受診' || /受診|病院|外部/u.test(title);
  }
  if (source === 'google_calendar') {
    return type === '受診' || /受診|病院|診察|往診/u.test(title);
  }
  return false;
}

/** @param {unknown[]} plans */
export function filterImportantPlans(plans) {
  return (Array.isArray(plans) ? plans : []).filter((p) => p && isImportantFacilityPlan(p));
}

/**
 * 入居予定・退院予定・入院開始日をカレンダー行に変換
 * @param {Record<string, unknown>[]} residents
 * @param {string} ymd
 */
export function buildStayStatusPlansForDate(residents, ymd) {
  const y = String(ymd ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(y)) return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const res of residents || []) {
    const rid = String(res?.id ?? '').trim();
    if (!rid) continue;
    const st = getResidentStayStatus(rid);
    if (!st) continue;
    const short = residentShortName(res?.name);
    const room = String(res?.room ?? '').trim();
    const base = {
      date: y,
      source: 'stay_status',
      residentId: rid,
      residentName: short,
      room,
    };
    if (String(st.moveInPlannedDate ?? '').trim() === y) {
      out.push({
        ...base,
        id: `stay_movein_${rid}_${y}`,
        time: '09:00',
        type: '入居',
        title: `${short}様 入居予定`,
      });
    }
    if (String(st.dischargePlannedDate ?? '').trim() === y) {
      out.push({
        ...base,
        id: `stay_discharge_${rid}_${y}`,
        time: '09:00',
        type: '退院',
        title: `${short}様 退院予定`,
      });
    }
    if (String(st.hospitalSince ?? '').trim() === y) {
      out.push({
        ...base,
        id: `stay_admit_${rid}_${y}`,
        time: '08:00',
        type: '入院',
        title: `${short}様 入院`,
      });
    }
  }
  return sortPlansByTime(out);
}

/** @param {Record<string, unknown>} plan */
export function planTypeChipClass(plan) {
  const type = String(plan?.type ?? '');
  const source = String(plan?.source ?? '');
  if (source === 'home_visit_calendar' || type === '往診') {
    return 'border-violet-300 bg-violet-50/95 text-violet-950';
  }
  if (type === '入院') {
    return 'border-rose-300 bg-rose-50/95 text-rose-950';
  }
  if (type === '退院') return 'border-amber-300 bg-amber-50/95 text-amber-950';
  if (type === '入居') return 'border-teal-400 bg-teal-50/95 text-teal-950';
  if (type === '受診') return 'border-sky-300 bg-sky-50/95 text-sky-950';
  return 'border-teal-200 bg-teal-50/90 text-slate-900';
}
