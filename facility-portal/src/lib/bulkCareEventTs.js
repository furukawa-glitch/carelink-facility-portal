import { tokyoDateHourToIso } from './hourlyCareGrid.js';

function localYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MEAL_SLOT_HOUR = Object.freeze({ 朝: 8, 昼: 12, 夜: 18, 夕: 18 });

/** @param {unknown} slot */
export function normalizeBulkMealSlot(slot) {
  const t = String(slot ?? '').trim();
  if (t === '夕') return '夜';
  if (t === '朝' || t === '昼' || t === '夜') return t;
  return '';
}

/**
 * @param {unknown} meta
 * @param {string} ts
 */
export function resolveBulkMealSlotForEvent(meta, ts) {
  const fromMeta = normalizeBulkMealSlot(meta?.mealSlot);
  if (fromMeta) return fromMeta;
  const t = new Date(String(ts ?? ''));
  if (!Number.isFinite(t.getTime())) return '';
  const h = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: 'numeric',
      hour12: false,
    }).format(t)
  );
  if (!Number.isFinite(h)) return '';
  if (h <= 9) return '朝';
  if (h <= 15) return '昼';
  return '夜';
}

/**
 * 一覧表保存時の careEvents.ts（対象日の暦日に紐づける）
 * @param {string} ymd YYYY-MM-DD
 * @param {'vital' | 'meal' | 'excretion' | 'enteral' | 'fluid_intake' | 'patrol'} kind
 * @param {{ mealSlot?: string; hour?: number; useNowIfToday?: boolean }} [opts]
 */
export function bulkCareEventTs(ymd, kind, opts = {}) {
  const day = String(ymd ?? '').trim();
  const useNow = opts.useNowIfToday !== false;
  if (useNow && day === localYmd()) return new Date().toISOString();

  if (Number.isFinite(opts.hour)) return tokyoDateHourToIso(day, opts.hour);

  if (kind === 'meal') {
    const slot = normalizeBulkMealSlot(opts.mealSlot);
    return tokyoDateHourToIso(day, MEAL_SLOT_HOUR[slot] ?? 12);
  }

  if (kind === 'enteral') {
    const slot = normalizeBulkMealSlot(opts.mealSlot);
    if (slot) return tokyoDateHourToIso(day, MEAL_SLOT_HOUR[slot] ?? 12);
  }

  const defaultHour = {
    vital: 9,
    excretion: 15,
    enteral: 11,
    fluid_intake: 10,
    patrol: 12,
  }[kind];
  return tokyoDateHourToIso(day, defaultHour ?? 12);
}

/** ログ文字列から一覧表の食事列を復元（旧形式「主食8割」も可） */
export function parseMealAmountFieldsFromLog(mealAmount) {
  const s = String(mealAmount ?? '').trim();
  if (!s) {
    return { mealStaple: '', mealSide: '', mealStapleForm: '', mealSideForm: '' };
  }
  const staple = s.match(/主食(?:\(([^)]+)\))?(\d{1,2}割)?/u);
  const side = s.match(/副食(?:\(([^)]+)\))?(\d{1,2}割)?/u);
  return {
    mealStapleForm: String(staple?.[1] ?? '').trim(),
    mealStaple: String(staple?.[2] ?? '').trim(),
    mealSideForm: String(side?.[1] ?? '').trim(),
    mealSide: String(side?.[2] ?? '').trim(),
  };
}
