/**
 * ヒヤリ周知の「スタッフ名簿」用: 勤務表（アプリ内シフト希望・登録）から氏名を集める。
 * 求人シートとは独立。施設キーは carelinkFacilities の linkKey と一致するものだけ。
 */

import { CARELINK_FACILITIES } from '../config/carelinkFacilities.js';
import { loadPreferences } from './ShiftScheduleService.js';

function normStaffKey(name) {
  return String(name ?? '')
    .replace(/\u3000/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @returns {{
 *   byFacility: Record<string, { id: string; name: string; department?: string }[]>;
 *   global: null;
 *   meta: { rowCount: number; source: string; hasFacilityCol: boolean; hasTagCol: boolean };
 *   sheetTitle: string;
 *   spreadsheetId: string;
 *   syncedAt: string;
 * }}
 */
export function buildNearMissRosterPayloadFromShiftPreferences() {
  const prefs = loadPreferences();
  /** @type {Record<string, { id: string; name: string; department?: string }[]>} */
  const byFacility = {};
  for (const f of CARELINK_FACILITIES) {
    byFacility[f.linkKey] = [];
  }
  /** @type {Map<string, Set<string>>} */
  const seenByFacility = new Map();

  for (const p of prefs) {
    const lk = String(p.facilityLinkKey ?? '').trim();
    const rawName = String(p.staffName ?? '').trim();
    const nk = normStaffKey(rawName);
    if (!lk || !nk) continue;
    if (!Object.prototype.hasOwnProperty.call(byFacility, lk)) {
      byFacility[lk] = [];
    }
    let set = seenByFacility.get(lk);
    if (!set) {
      set = new Set();
      seenByFacility.set(lk, set);
    }
    if (set.has(nk)) continue;
    set.add(nk);
    const id = `shift:${lk}:${set.size}:${nk.slice(0, 24)}`;
    const department = String(p.department ?? '').trim();
    byFacility[lk].push({ id, name: nk, department });
  }

  for (const lk of Object.keys(byFacility)) {
    byFacility[lk].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  let rowCount = 0;
  for (const arr of Object.values(byFacility)) {
    rowCount += arr.length;
  }

  const syncedAt = new Date().toISOString();
  return {
    byFacility,
    global: null,
    meta: {
      rowCount,
      source: 'shift_schedule',
      hasFacilityCol: true,
      hasTagCol: false,
    },
    sheetTitle: '勤務表（アプリ内シフト登録）',
    spreadsheetId: 'local',
    syncedAt,
  };
}
