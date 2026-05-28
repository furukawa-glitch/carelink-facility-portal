/**
 * 勤務希望・勤務表（介護記録アプリとは別データ）。
 * ブラウザ localStorage に保存。
 *
 * v2: 勤務形態（夜勤○回／日勤○回／休み○日／パート時間帯／自由）＋月次自動生成
 */

import { getShiftDepartmentsForLinkKey } from '../config/carelinkFacilities.js';
import { fetchHrStaffSheetBundle } from './StaffRosterSheetService.js';

const LS_KEY_V2 = 'carelink_shift_prefs_v2';
const LS_KEY_V1 = 'carelink_shift_prefs_v1';

const WEEK_JA = ['月', '火', '水', '木', '金', '土', '日'];

/** 千音寺の看護シフト行（勤務表の部署） */
export const CHIONJI_NURSE_DEPARTMENT = '千音寺看護師';

/** 千音寺の訪問介護ケアサポート勤務表（★日・★早・日A～D、★夜A/B・明、×・有・集計行など） */
export const CHIONJI_CARE_DEPARTMENT = '千音寺介護';

/** 北名古屋の訪問看護ケアサポート等の勤務表行（Excel の「準」と整合） */
export const KITANAGOYA_NURSE_DEPARTMENT = '北名古屋看護';

/** 北名古屋の訪問介護ケアサポート勤務表（日・早・★日A/B、夜A/B・明、BA～BG、×・有・週休・食事数など） */
export const KITANAGOYA_CARE_DEPARTMENT = '北名古屋介護';

/** 北名古屋有料（有料ホーム等：日・早・×・有・時間帯セル・行事行・早昼遅番・食事数） */
export const KITANAGOYA_PAID_CARE_DEPARTMENT = '北名古屋有料';

/** 愛西のデイサービス勤務表（キリンデイサービス様式などの行単位） */
export const AISAI_DAY_SERVICE_DEPARTMENT = '愛西デイサービス';

/** 愛西の訪問介護勤務表（夜勤A～D・早・E・明・×・有などのExcel行） */
export const AISAI_HOME_CARE_DEPARTMENT = '愛西訪問介護';

/** 愛西有料（有料老人ホーム等の勤務表・夜・時間数・×・有） */
export const AISAI_PAID_CARE_DEPARTMENT = '愛西有料';

/** 愛西の訪問看護ケアサポート勤務表（日・夜・明・×・有・看護日勤集計・週休） */
export const AISAI_NURSING_DEPARTMENT = '愛西看護';

/** 中川本館・グループハウスくまさん（中川シフト：夜A/B・明・看日・数値パターン・千音寺など） */
export const NAKAGAWA_KUMASAN_DEPARTMENT = 'グループハウスくまさん';

/** 帳票・画面用の勤務時間の説明 */
export const CHIONJI_NIGHT_SHIFT_FULL_JA = '夜勤: 17時～翌9時（休憩1時間）';
export const CHIONJI_NIGHT_SHIFT_SHORT_JA = 'ショート夜勤(S): 21時～6時（休憩1時間）';

/** 北名古屋看護のExcel準拠（夜は共通、準＝ショート夜） */
export const KITANAGOYA_NIGHT_SHIFT_FULL_JA = CHIONJI_NIGHT_SHIFT_FULL_JA;
export const KITANAGOYA_NIGHT_SHIFT_SHORT_JA = '準夜: 21時～6時（休憩1時間）（帳票の記号は「準」）';

/**
 * ショート夜勤の月回数入力・帳票記号（S／準）の対象部署
 * @param {unknown} department
 */
export function isNursingShortNightDepartment(department) {
  const d = String(department ?? '').trim();
  return (
    d === CHIONJI_NURSE_DEPARTMENT || d === KITANAGOYA_NURSE_DEPARTMENT || d === AISAI_NURSING_DEPARTMENT
  );
}

/** @typedef {'night_count' | 'day_count' | 'off_count' | 'paid_leave_count' | 'part_time' | 'free_text'} WorkMode */

/**
 * @typedef {Object} ShiftPreference
 * @property {string} id
 * @property {string} facilityLinkKey
 * @property {string} staffName
 * @property {string} [department] 部署（所属）— carelinkFacilities の shiftDepartments から選択
 * @property {number[]} ngWeekdayMon0 0=月 … 6=日
 * @property {WorkMode} [mode]
 * @property {number} [nightCount] 月あたり夜勤回数
 * @property {number} [dayCount] 月あたり日勤回数
 * @property {number} [offCount] 月あたり休みの日数（NG曜日以外から割当）
 * @property {number} [paidLeaveCount] 月あたり年休（有休）日数
 * @property {string} [partTimeStart] "09:00"
 * @property {string} [partTimeEnd] "16:00"
 * @property {'weekdays' | 'all_except_ng'} [partScope]
 * @property {string} preferredShiftText
 * @property {string} note
 * @property {string} updatedAt ISO
 * @property {string} [staffId] NearMiss の職員ID（スタッフ本人入力と紐づけ）
 * @property {'staff' | 'manager'} [submittedBy]
 * @property {boolean} [canNightShift] 夜勤・ショート夜勤の自動割当に含める（既定 true）
 * @property {number} [shortNightCount] 千音寺看護師・北名古屋看護・愛西看護: ショート夜勤の月回数（帳票は S または 準）
 * @property {string[]} [offHopeYmdList] カレンダー上の休み希望日（YYYY-MM-DD）。スタッフ入力や帳票の「休（希望）」に上書き反映
 * @property {Record<string, string>} [requestedShiftByYmd] スタッフ入力の希望シフト（YYYY-MM-DD -> 休希望/夜勤入り希望/明け希望/年休希望/日勤希望/早番希望）
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOffHopeYmdList(raw) {
  if (!Array.isArray(raw)) return [];
  const set = new Set();
  for (const x of raw) {
    const s = String(x ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) set.add(s);
  }
  return [...set].sort();
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeRequestedShiftByYmd(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const ymd = String(k ?? '').trim();
    const label = String(v ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    if (
      label === '休希望' ||
      label === '夜勤入り希望' ||
      label === '明け希望' ||
      label === '年休希望' ||
      label === '日勤希望' ||
      label === '早番希望'
    ) {
      out[ymd] = label;
    }
  }
  return out;
}

function migrateV1toV2() {
  try {
    const raw = localStorage.getItem(LS_KEY_V1);
    if (!raw || localStorage.getItem(LS_KEY_V2)) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const migrated = arr.map((p) => ({
      ...p,
      mode: 'free_text',
      nightCount: undefined,
      dayCount: undefined,
      partTimeStart: '09:00',
      partTimeEnd: '16:00',
      partScope: 'weekdays',
    }));
    localStorage.setItem(LS_KEY_V2, JSON.stringify(migrated));
  } catch {
    /* ignore */
  }
}

export function loadPreferences() {
  migrateV1toV2();
  try {
    const raw = localStorage.getItem(LS_KEY_V2);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  localStorage.setItem(LS_KEY_V2, JSON.stringify(list));
}

/**
 * @param {ShiftPreference} pref
 */
export function upsertPreference(pref) {
  const list = loadPreferences();
  const i = list.findIndex((p) => p.id === pref.id);
  if (i >= 0) list[i] = pref;
  else list.push(pref);
  saveAll(list);
}

/**
 * @param {string} id
 */
export function deletePreference(id) {
  saveAll(loadPreferences().filter((p) => p.id !== id));
}

export function newPreferenceId() {
  return `sp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 同一職員・同一施設の希望は1件（スタッフ画面の更新用）
 * @param {string} staffId
 * @param {string} facilityLinkKey
 * @returns {ShiftPreference | null}
 */
export function findPreferenceByStaffAndFacility(staffId, facilityLinkKey) {
  const sid = String(staffId ?? '').trim();
  if (!sid || !facilityLinkKey) return null;
  return loadPreferences().find((p) => p.facilityLinkKey === facilityLinkKey && String(p.staffId ?? '') === sid) ?? null;
}

/**
 * @param {string|Date} date
 * @returns {Date} その週の月曜 0:00 ローカル
 */
export function mondayOfWeekContaining(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * @param {Date} d
 */
export function formatYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {string} ymd
 */
export function parseYmd(ymd) {
  const [y, m, day] = ymd.split('-').map(Number);
  return new Date(y, m - 1, day);
}

/** JS getDay 0=日 → 月=0 … 日=6 */
export function mon0FromDate(d) {
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

/**
 * @param {number[]} sortedIndices 昇順・重複なし
 * @param {number} k
 */
function pickEvenlySpacedIndices(sortedIndices, k) {
  if (k <= 0 || sortedIndices.length === 0) return [];
  if (k >= sortedIndices.length) return [...sortedIndices];
  const n = sortedIndices.length;
  const out = [];
  for (let i = 0; i < k; i++) {
    const start = Math.floor((i * n) / k);
    const end = Math.floor(((i + 1) * n) / k) - 1;
    const mid = Math.floor((start + end) / 2);
    out.push(sortedIndices[mid]);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} p
 * @returns {ShiftPreference & { mode: WorkMode }}
 */
export function normalizePreference(p) {
  const mode = /** @type {WorkMode} */ (p.mode || 'free_text');
  return {
    ...p,
    mode,
    department: typeof p.department === 'string' ? p.department.trim() : '',
    ngWeekdayMon0: Array.isArray(p.ngWeekdayMon0) ? p.ngWeekdayMon0 : [],
    nightCount: typeof p.nightCount === 'number' ? p.nightCount : 0,
    dayCount: typeof p.dayCount === 'number' ? p.dayCount : 0,
    offCount: typeof p.offCount === 'number' ? p.offCount : 0,
    paidLeaveCount: typeof p.paidLeaveCount === 'number' ? p.paidLeaveCount : 0,
    partTimeStart: typeof p.partTimeStart === 'string' ? p.partTimeStart : '09:00',
    partTimeEnd: typeof p.partTimeEnd === 'string' ? p.partTimeEnd : '16:00',
    partScope: p.partScope === 'all_except_ng' ? 'all_except_ng' : 'weekdays',
    canNightShift: p.canNightShift === false ? false : true,
    shortNightCount: typeof p.shortNightCount === 'number' ? p.shortNightCount : 0,
    offHopeYmdList: normalizeOffHopeYmdList(p.offHopeYmdList),
    requestedShiftByYmd: normalizeRequestedShiftByYmd(p.requestedShiftByYmd),
  };
}

/**
 * 希望内容の1行サマリー
 * @param {ShiftPreference} p
 */
function offHopeCalendarSuffix(offHopeYmdList) {
  const list = normalizeOffHopeYmdList(offHopeYmdList);
  if (!list.length) return '';
  const labels = list.map((ymd) => {
    const [, mm, dd] = ymd.split('-');
    return `${parseInt(mm, 10)}/${parseInt(dd, 10)}`;
  });
  return ` ／ 休希望日 ${labels.join('・')}`;
}

function requestedShiftCalendarSuffix(requestedShiftByYmd) {
  const map = normalizeRequestedShiftByYmd(requestedShiftByYmd);
  const labels = Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ymd, kind]) => {
      const [, mm, dd] = ymd.split('-');
      return `${parseInt(mm, 10)}/${parseInt(dd, 10)}:${kind}`;
    });
  return labels.length ? ` ／ 希望 ${labels.join('・')}` : '';
}

export function summarizePreference(p) {
  const n = normalizePreference(p);
  const dept = n.department ? `【${n.department}】` : '';
  const ng =
    n.ngWeekdayMon0.length > 0 ? `NG:${n.ngWeekdayMon0.map((i) => WEEK_JA[i]).join('・')}` : '';
  const offCal = offHopeCalendarSuffix(n.offHopeYmdList);
  const requestCal = requestedShiftCalendarSuffix(n.requestedShiftByYmd);
  if (n.mode === 'night_count') {
    const cap = n.canNightShift === false ? '夜勤割当なし' : '';
    const sn =
      isNursingShortNightDepartment(n.department) && (n.shortNightCount || 0) > 0
        ? n.department === CHIONJI_NURSE_DEPARTMENT
          ? `・S ${n.shortNightCount}回/月`
          : `・準 ${n.shortNightCount}回/月`
        : '';
    return (
      [dept, ng, cap || `夜勤 ${n.nightCount || 0}回/月${sn}`].filter(Boolean).join(' ／ ') + offCal + requestCal
    );
  }
  if (n.mode === 'day_count') {
    return [dept, ng, `日勤 ${n.dayCount || 0}回/月`].filter(Boolean).join(' ／ ') + offCal + requestCal;
  }
  if (n.mode === 'off_count') {
    return [dept, ng, `休み ${n.offCount || 0}日/月`].filter(Boolean).join(' ／ ') + offCal + requestCal;
  }
  if (n.mode === 'paid_leave_count') {
    return [dept, ng, `年休 ${n.paidLeaveCount || 0}日/月`].filter(Boolean).join(' ／ ') + offCal + requestCal;
  }
  if (n.mode === 'part_time') {
    const scope = n.partScope === 'all_except_ng' ? '平日土日（NG除く）' : '平日のみ';
    return (
      [dept, ng, `パート ${n.partTimeStart}～${n.partTimeEnd}（${scope}）`].filter(Boolean).join(' ／ ') +
      offCal +
      requestCal
    );
  }
  const base = [dept, ng, n.preferredShiftText || ''].filter(Boolean).join(' ／ ') || '自由記入';
  return base + offCal + requestCal;
}

/**
 * @param {string} yearMonth YYYY-MM
 * @param {string} facilityLinkKey
 */
export function buildMonthlyAutoTable(yearMonth, facilityLinkKey) {
  const [y, m] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  /** @type {{ ymd: string; md: string; weekdayJa: string; mon0: number }[]} */
  const dayLabels = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(y, m - 1, day);
    const mon0 = mon0FromDate(d);
    dayLabels.push({
      ymd: formatYmd(d),
      md: `${m}/${day}`,
      weekdayJa: WEEK_JA[mon0],
      mon0,
    });
  }

  const prefs = loadPreferences()
    .filter((p) => p.facilityLinkKey === facilityLinkKey)
    .map(normalizePreference);

  const rows = prefs.map((p) => {
    /** @type {string[]} */
    const cells = dayLabels.map((label) => (p.ngWeekdayMon0.includes(label.mon0) ? '休（希望）' : ''));

    if (p.mode === 'night_count') {
      const norm = normalizePreference(p);
      if (norm.canNightShift) {
        const eligibleIdx = dayLabels
          .map((_, i) => i)
          .filter((i) => cells[i] === '');
        const k = Math.min(Math.max(0, norm.nightCount | 0), eligibleIdx.length);
        const picked = pickEvenlySpacedIndices(eligibleIdx, k);
        for (const i of picked) cells[i] = '夜勤';

        const shortN = isNursingShortNightDepartment(norm.department) ? Math.max(0, norm.shortNightCount | 0) : 0;
        if (shortN > 0) {
          const eligibleShort = dayLabels
            .map((_, i) => i)
            .filter((i) => cells[i] === '');
          const ks = Math.min(shortN, eligibleShort.length);
          const pickedS = pickEvenlySpacedIndices(eligibleShort, ks);
          for (const i of pickedS) cells[i] = 'ショート夜勤';
        }
      }
    } else if (p.mode === 'day_count') {
      const eligibleIdx = dayLabels
        .map((_, i) => i)
        .filter((i) => cells[i] === '');
      const k = Math.min(Math.max(0, p.dayCount | 0), eligibleIdx.length);
      const picked = pickEvenlySpacedIndices(eligibleIdx, k);
      for (const i of picked) cells[i] = '日勤';
    } else if (p.mode === 'off_count') {
      const eligibleIdx = dayLabels
        .map((_, i) => i)
        .filter((i) => cells[i] === '');
      const k = Math.min(Math.max(0, p.offCount | 0), eligibleIdx.length);
      const picked = pickEvenlySpacedIndices(eligibleIdx, k);
      for (const i of picked) cells[i] = '休（希望）';
    } else if (p.mode === 'paid_leave_count') {
      const eligibleIdx = dayLabels
        .map((_, i) => i)
        .filter((i) => cells[i] === '');
      const k = Math.min(Math.max(0, p.paidLeaveCount | 0), eligibleIdx.length);
      const picked = pickEvenlySpacedIndices(eligibleIdx, k);
      for (const i of picked) cells[i] = '年休';
    } else if (p.mode === 'part_time') {
      const label = `パート ${p.partTimeStart}-${p.partTimeEnd}`;
      dayLabels.forEach((l, i) => {
        if (cells[i] !== '') return;
        const isWeekday = l.mon0 < 5;
        if (p.partScope === 'weekdays' && !isWeekday) return;
        cells[i] = label;
      });
    }

    const offHope = normalizeOffHopeYmdList(p.offHopeYmdList);
    for (const ymd of offHope) {
      const i = dayLabels.findIndex((l) => l.ymd === ymd);
      if (i >= 0) cells[i] = '休（希望）';
    }
    const requestedShiftByYmd = normalizeRequestedShiftByYmd(p.requestedShiftByYmd);
    for (const [ymd, kind] of Object.entries(requestedShiftByYmd)) {
      const i = dayLabels.findIndex((l) => l.ymd === ymd);
      if (i < 0) continue;
      if (kind === '休希望') cells[i] = '休（希望）';
      else if (kind === '夜勤入り希望') cells[i] = '夜勤入り希望';
      else if (kind === '明け希望') cells[i] = '明け希望';
      else if (kind === '年休希望') cells[i] = '年休希望';
      else if (kind === '日勤希望') cells[i] = '日勤希望';
      else if (kind === '早番希望') cells[i] = '早番希望';
    }

    return {
      id: p.id,
      staffName: p.staffName,
      department: (normalizePreference(p).department || '').trim(),
      staffId: p.staffId || '',
      submittedBy: p.submittedBy,
      cells,
      preferredShiftText: summarizePreference(p),
      note: p.note || '',
    };
  });

  return {
    kind: 'month',
    scope: 'month',
    monthYm: yearMonth,
    facilityLinkKey,
    dayLabels,
    rows,
  };
}

/**
 * 自動割当セルを、愛西勤務表風の記号に変換（×・有・日・夜＋翌日明）
 * @param {ReturnType<typeof buildMonthlyAutoTable>} baseTable
 */
export function buildMonthlyRosterFromTable(baseTable) {
  const dayLabels = baseTable.dayLabels;
  const rows = baseTable.rows.map((r) => {
    const raw = [...r.cells];
    const n = raw.length;
    /** @type {string[]} */
    const sym = raw.map((c) => {
      if (c === '休（希望）') return '×';
      if (c === '年休') return '有';
      if (c === '年休希望') return '有';
      if (c === '夜勤') return '夜';
      if (c === '夜勤入り希望') return '夜';
      if (c === '明け希望') return '明';
      if (c === 'ショート夜勤') {
        const d = String(r.department ?? '').trim();
        if (d === CHIONJI_NURSE_DEPARTMENT) return 'S';
        return '準';
      }
      if (c === '日勤') return '日';
      if (c === '日勤希望') return '日';
      if (c === '早番希望') return '早';
      if (String(c || '').startsWith('パート')) return '日';
      return '';
    });
    for (let i = 0; i < n - 1; i++) {
      if (sym[i] === '夜' && sym[i + 1] === '') sym[i + 1] = '明';
    }
    const weekOffTotal = sym.filter((x) => x === '×' || x === '有').length;
    return { ...r, rosterCells: sym, weekOffTotal };
  });
  const footerDayNurse = dayLabels.map((_, di) =>
    rows.reduce((acc, row) => acc + (row.rosterCells[di] === '日' ? 1 : 0), 0)
  );
  return {
    ...baseTable,
    rosterScope: 'month_roster',
    rows,
    footerDayNurse,
  };
}

/**
 * @param {string} yearMonth YYYY-MM
 * @param {string} facilityLinkKey
 */
export function buildMonthlyRosterTable(yearMonth, facilityLinkKey) {
  return buildMonthlyRosterFromTable(buildMonthlyAutoTable(yearMonth, facilityLinkKey));
}

/** 令和年（2019-05-01 以降の年は year - 2018 を簡易換算） */
export function reiwaYearFromCalendarYear(y) {
  const n = Number(y);
  if (n >= 2019) return n - 2018;
  return null;
}

/**
 * @param {ReturnType<typeof buildMonthlyRosterFromTable>} rosterTable
 * @param {string} facilityLabel
 * @param {{ subtitle?: string }} [opt]
 */
export function buildRosterFormHtml(rosterTable, facilityLabel, opt = {}) {
  const ym = rosterTable.monthYm;
  const [y, mo] = ym.split('-').map(Number);
  const rw = reiwaYearFromCalendarYear(y);
  const titleTop =
    rw != null ? `令和${rw}年${mo}月　勤務表` : `${y}年${mo}月　勤務表`;
  const subtitle = opt.subtitle ?? `${facilityLabel}（自動生成・要現場調整）`;
  const rosterShiftHint =
    rosterTable.facilityLinkKey === '千音寺'
      ? `<div class="hint">${escapeHtml(CHIONJI_NIGHT_SHIFT_FULL_JA)}／${escapeHtml(CHIONJI_NIGHT_SHIFT_SHORT_JA)}。S は千音寺看護師のみ。千音寺介護（訪問介護ケアサポート）は「★早」「日A～D」「★夜A/B」「明」「×」「有」や下段の日勤・食事数集計を自由記入・備考で補えます。</div>`
      : rosterTable.facilityLinkKey === '北名古屋'
        ? `<div class="hint">${escapeHtml(KITANAGOYA_NIGHT_SHIFT_FULL_JA)}／${escapeHtml(KITANAGOYA_NIGHT_SHIFT_SHORT_JA)}。北名古屋看護は Excel の訪問看護勤務表に合わせ「準」を使います。北名古屋介護（訪問介護ケアサポート）は「日」「早」「★日A/B」「夜A/B」「明」「BA～BG」「×」「有」や週休・昼夕食数・千音寺ヘルプを自由記入・備考で補えます。北名古屋有料は「日」「早」「×」「有」や 6-15・9.5-14 などの時間帯、行事・予定行、下段の早番・昼番・遅番の割当・有料食事数を同様に補えます。</div>`
        : rosterTable.facilityLinkKey === '愛西'
          ? `<div class="hint">愛西の勤務表: デイは「8・7・5」「×」「有」等を自由記入・備考で。訪問介護は「A～D」「早」「E」「明」等。有料は「夜」「8・6・5」「×」「有」と日程行のメモを同様に補完できます。看護（愛西看護）は「日」「夜」「明」「×」「有」、看護日勤の集計行・週休列も備考で寄せられます。夜・明・準の自動割当は千音寺看護師・北名古屋看護・愛西看護向けです。</div>`
          : rosterTable.facilityLinkKey === '中川本館'
            ? `<div class="hint">中川本館・グループハウスくまさん: 「×」「有休」「看日」「8」「早」「夜A」「夜B」「明」や数値パターン（7.5・6①②・5.5①②・4A/4P 等）、他拠点「千音寺」のメモ、右端の公休・夜・日・有休・休日出勤の集計は自由記入・備考で再現できます。夜勤モードの「夜→翌明」は簡易表示です（シートの夜A/B時間帯とは異なる場合は備考で補足）。</div>`
            : '';

  const thDays = rosterTable.dayLabels
    .map((d, i) => {
      const mon0 = d.mon0;
      let cls = 'dow';
      if (mon0 === 6) cls += ' sun';
      else if (mon0 === 5) cls += ' sat';
      const dayNum = i + 1;
      return `<th class="${cls}"><span class="dn">${dayNum}</span><span class="wj">${escapeHtml(d.weekdayJa)}</span></th>`;
    })
    .join('');

  const body = rosterTable.rows
    .map((r) => {
      const tds = r.rosterCells
        .map((c, i) => {
          const mon0 = rosterTable.dayLabels[i].mon0;
          const sat = mon0 === 5;
          const sun = mon0 === 6;
          let cellCls = 'cell';
          if (c === '夜' || c === '明') cellCls += ' nightpair';
          if (c === 'S' || c === '準') cellCls += ' short-night';
          if (c === '×') cellCls += ' off';
          if (c === '日' && (sat || sun)) cellCls += ' day-hol';
          if (sun) cellCls += ' col-sun';
          else if (sat) cellCls += ' col-sat';
          const show = c || '　';
          return `<td class="${cellCls}">${escapeHtml(show)}</td>`;
        })
        .join('');
      const jobLabel = (r.department && String(r.department).trim()) || '—';
      return `<tr><td class="job">${escapeHtml(jobLabel)}</td><td class="name">${escapeHtml(r.staffName)}</td>${tds}<td class="wsum">${r.weekOffTotal}</td></tr>`;
    })
    .join('');

  const footCells = rosterTable.footerDayNurse
    .map((n, i) => {
      const mon0 = rosterTable.dayLabels[i].mon0;
      const sun = mon0 === 6;
      const sat = mon0 === 5;
      let cls = 'foot';
      if (sun) cls += ' col-sun';
      else if (sat) cls += ' col-sat';
      return `<td class="${cls}">${n}</td>`;
    })
    .join('');

  const title = `${titleTop} — ${facilityLabel}`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width"/>
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  body { font-family: "Segoe UI", "Hiragino Sans", "Yu Gothic", "MS Gothic", sans-serif; padding: 8px; color: #0f172a; font-size: 9px; }
  h1 { font-size: 14px; margin: 0 0 4px 0; font-weight: 800; }
  .sub { font-size: 10px; color: #475569; margin-bottom: 8px; }
  .hint { font-size: 9px; color: #b91c1c; margin-bottom: 6px; line-height: 1.4; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 1px solid #94a3b8; padding: 2px 1px; text-align: center; vertical-align: middle; }
  th { background: #e2e8f0; font-weight: 700; }
  th.dow { font-size: 8px; line-height: 1.1; }
  th.dow .dn { display: block; font-size: 10px; }
  th.dow .wj { display: block; font-size: 8px; color: #334155; }
  th.dow.sat { background: #dbeafe; }
  th.dow.sun { background: #fee2e2; }
  td.job { width: 2.8em; font-size: 8px; background: #f8fafc; }
  td.name { width: 5.5em; text-align: left; padding-left: 4px; font-weight: 700; font-size: 9px; }
  td.cell { font-size: 9px; }
  td.nightpair { background: #fef9c3; }
  td.short-night { background: #e9d5ff; font-weight: 800; }
  td.off { color: #64748b; }
  td.day-hol { background: #e0f2fe; }
  td.col-sat { background: #f0f9ff; }
  td.col-sun { background: #fff1f2; }
  td.wsum { font-weight: 700; background: #f1f5f9; width: 2.2em; }
  tr.foot td { font-weight: 800; background: #e0e7ff; }
  tr.foot td.label { text-align: left; padding: 4px; background: #eef2ff; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<h1>${escapeHtml(titleTop)}</h1>
<div class="sub">${escapeHtml(subtitle)}</div>
<div class="hint">※ 記号は自動割当です（×=休希望、有=年休、日=日勤・パート、夜・明=夜勤明け、S／準=ショート夜勤）。実際のシフトは現場で調整してください。</div>
${rosterShiftHint}
<table>
<thead>
<tr>
<th class="job">職種</th>
<th class="name">氏名</th>
${thDays}
<th class="wsum">週休</th>
</tr>
</thead>
<tbody>
${body}
<tr class="foot">
<td class="label" colspan="2">看護日勤（日の人数）</td>
${footCells}
<td>—</td>
</tr>
</tbody>
</table>
</body>
</html>`;
}

/**
 * @param {string} weekMondayYmd
 * @param {string} facilityLinkKey
 */
export function buildDraftTable(weekMondayYmd, facilityLinkKey) {
  const monday = parseYmd(weekMondayYmd);
  /** @type {{ ja: string; md: string; ymd: string }[]} */
  const dayLabels = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(monday);
    x.setDate(x.getDate() + i);
    const mon0 = mon0FromDate(x);
    dayLabels.push({
      ja: WEEK_JA[mon0],
      md: `${x.getMonth() + 1}/${x.getDate()}`,
      ymd: formatYmd(x),
    });
  }

  const ymSet = new Set(dayLabels.map((dl) => dl.ymd.slice(0, 7)));
  /** @type {Map<string, ReturnType<typeof buildMonthlyAutoTable>>} */
  const monthCache = new Map();
  for (const ym of ymSet) {
    monthCache.set(ym, buildMonthlyAutoTable(ym, facilityLinkKey));
  }

  const rows = [];
  const firstMonth = monthCache.get(dayLabels[0].ymd.slice(0, 7));
  if (!firstMonth) {
    return { kind: 'week', scope: 'week', facilityLinkKey, weekMondayYmd, dayLabels, rows: [] };
  }
  for (const r of firstMonth.rows) {
    const cells = dayLabels.map((dl) => {
      const ym = dl.ymd.slice(0, 7);
      const mt = monthCache.get(ym);
      if (!mt) return '';
      const col = mt.dayLabels.findIndex((l) => l.ymd === dl.ymd);
      const row = mt.rows.find((rr) => rr.id === r.id);
      if (!row || col < 0) return '';
      return row.cells[col] ?? '';
    });
    rows.push({
      id: r.id,
      staffName: r.staffName,
      department: r.department || '',
      staffId: r.staffId || '',
      submittedBy: r.submittedBy,
      cells,
      preferredShiftText: r.preferredShiftText,
      note: r.note,
    });
  }

  return {
    kind: 'week',
    scope: 'week',
    facilityLinkKey,
    weekMondayYmd,
    dayLabels,
    rows,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {ReturnType<typeof buildDraftTable> | ReturnType<typeof buildMonthlyAutoTable>} table
 * @param {string} facilityLabel
 */
export function buildScheduleHtml(table, facilityLabel) {
  const isMonth = table.scope === 'month';
  const title = isMonth
    ? `勤務表（自動）${facilityLabel} ${table.monthYm}`
    : `勤務表（${facilityLabel}） ${table.weekMondayYmd} 週`;

  const th = table.dayLabels
    .map((d) => {
      if (isMonth) {
        return `<th>${escapeHtml(`${d.weekdayJa} ${d.md}`)}</th>`;
      }
      return `<th>${escapeHtml(d.ja)}<br><span class="sub">${escapeHtml(d.md)}</span></th>`;
    })
    .join('');

  const body = table.rows
    .map((r) => {
      const dept = escapeHtml((r.department && String(r.department)) || '');
      const tds = r.cells
        .map((c) => `<td>${c ? escapeHtml(c).replace(/\n/g, '<br/>') : '　'}</td>`)
        .join('');
      return `<tr><td class="name">${escapeHtml(r.staffName)}</td><td class="memo">${dept}</td>${tds}<td class="memo">${escapeHtml(
        r.preferredShiftText || ''
      )}</td><td class="memo">${escapeHtml(r.note || '')}</td></tr>`;
    })
    .join('');

  const noteBlock = isMonth
    ? `<p style="font-size:12px;color:#64748b;">夜勤・日勤・年休は、その月で勤務可能な日から均等に割り当てています。パートは時間帯どおりに平日または全日（NG除く）に入れています。実際のシフトは現場で調整してください。</p>`
    : `<p style="font-size:12px;color:#64748b;">週表示は同じ月の自動割当の一部です。月次で全体を確認してください。</p>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Segoe UI", "Hiragino Sans", "Yu Gothic", sans-serif; padding: 16px; color: #1e293b; }
  h1 { font-size: 18px; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: center; }
  th { background: #f1f5f9; }
  th .sub { font-weight: normal; font-size: 10px; color: #64748b; }
  td.name { text-align: left; font-weight: bold; min-width: 6em; }
  td.memo { text-align: left; font-size: 10px; max-width: 14em; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${noteBlock}
<table>
<thead>
<tr><th>スタッフ</th><th>部署</th>${th}<th>勤務形態（要約）</th><th>備考</th></tr>
</thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>`;
}

/**
 * @param {ReturnType<typeof buildDraftTable> | ReturnType<typeof buildMonthlyAutoTable>} table
 */
export function buildScheduleCsv(table) {
  const isMonth = table.scope === 'month';
  const header = [
    'スタッフ',
    '部署',
    ...table.dayLabels.map((d) => (isMonth ? `${d.weekdayJa}${d.md}` : `${d.ja}(${d.md})`)),
    '勤務形態（要約）',
    '備考',
  ];
  const lines = [header.join(',')];
  for (const r of table.rows) {
    const cells = [
      r.staffName,
      (r.department && String(r.department)) || '',
      ...r.cells.map((c) => (c || '').replace(/"/g, '""')),
      r.preferredShiftText,
      r.note,
    ].map(
      (x) => {
        const s = String(x);
        if (/[",\n]/.test(s)) return `"${s}"`;
        return s;
      }
    );
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function hoursBetween(start, end) {
  const [sh, sm] = String(start ?? '09:00').split(':').map(Number);
  const [eh, em] = String(end ?? '16:00').split(':').map(Number);
  if (![sh, sm, eh, em].every((x) => Number.isFinite(x))) return 0;
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

/**
 * @param {string} cell
 * @returns {number}
 */
export function workHoursForCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s === '休（希望）' || s === '年休' || s === '年休希望' || s === '明け希望') return 0;
  if (s === '日勤') return 8;
  if (s === '日勤希望') return 8;
  if (s === '早番希望') return 8;
  if (s === '夜勤') return 15;
  if (s === '夜勤入り希望') return 15;
  if (s === 'ショート夜勤') return 8;
  if (s.startsWith('パート ')) {
    const m = s.match(/^パート\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!m) return 0;
    return hoursBetween(m[1], m[2]);
  }
  return 0;
}

/**
 * @param {ReturnType<typeof buildMonthlyAutoTable>} table
 */
export function summarizeMonthlyWorkStats(table) {
  const totalDays = table.dayLabels.length;
  const weeksInMonth = totalDays / 7;
  const rows = table.rows.map((r) => {
    const workDays = r.cells.filter((c) => workHoursForCell(c) > 0).length;
    const paidLeaveDays = r.cells.filter((c) => c === '年休').length;
    const holidayDays = totalDays - workDays;
    const workHours = r.cells.reduce((acc, c) => acc + workHoursForCell(c), 0);
    const weeklyAverageHours = weeksInMonth > 0 ? workHours / weeksInMonth : 0;
    return {
      id: r.id,
      staffName: r.staffName,
      department: r.department || '',
      staffId: r.staffId || '',
      totalDays,
      holidayDays,
      workDays,
      paidLeaveDays,
      workHours,
      weeklyAverageHours,
    };
  });
  return { monthYm: table.monthYm, facilityLinkKey: table.facilityLinkKey, rows };
}

/**
 * @param {string} year YYYY
 * @param {string} facilityLinkKey
 */
export function summarizeYearlyWorkStats(year, facilityLinkKey) {
  const y = Number(year);
  const monthlyTables = Array.from({ length: 12 }, (_, i) =>
    buildMonthlyAutoTable(`${y}-${String(i + 1).padStart(2, '0')}`, facilityLinkKey)
  );
  /** @type {Map<string, { id: string; staffName: string; department: string; monthly: { month: number; calendarDays: number; holidayDays: number; workDays: number; paidLeaveDays: number; workHours: number; weeklyAverageHours: number; }[]; annualHolidayDays: number; annualWorkDays: number; annualPaidLeaveDays: number; annualWorkHours: number; annualCalendarDays: number; }>} */
  const byId = new Map();
  for (let mi = 0; mi < monthlyTables.length; mi++) {
    const month = mi + 1;
    const stats = summarizeMonthlyWorkStats(monthlyTables[mi]);
    for (const row of stats.rows) {
      const cur =
        byId.get(row.id) ??
        {
          id: row.id,
          staffName: row.staffName,
          department: row.department || '',
          staffId: row.staffId || '',
          monthly: [],
          annualHolidayDays: 0,
          annualWorkDays: 0,
          annualPaidLeaveDays: 0,
          annualWorkHours: 0,
          annualCalendarDays: 0,
        };
      cur.monthly.push({
        month,
        calendarDays: row.totalDays,
        holidayDays: row.holidayDays,
        workDays: row.workDays,
        paidLeaveDays: row.paidLeaveDays,
        workHours: row.workHours,
        weeklyAverageHours: row.weeklyAverageHours,
      });
      cur.annualHolidayDays += row.holidayDays;
      cur.annualWorkDays += row.workDays;
      cur.annualPaidLeaveDays += row.paidLeaveDays;
      cur.annualWorkHours += row.workHours;
      cur.annualCalendarDays += row.totalDays;
      byId.set(row.id, cur);
    }
  }
  const totalWeeks = Array.from({ length: 12 }, (_, i) => new Date(y, i + 1, 0).getDate()).reduce((a, b) => a + b, 0) / 7;
  const rows = [...byId.values()].map((r) => ({
    ...r,
    annualWeeklyAverageHours: totalWeeks > 0 ? r.annualWorkHours / totalWeeks : 0,
  }));
  return { year: String(y), facilityLinkKey, rows };
}

/**
 * 求人シート由来の (施設, 氏名, 部署) を勤務希望にマージする。既存の同名・同施設・同部署は上書き。
 * @param {{ linkKey: string; staffName: string; department: string }[]} items
 * @returns {{ imported: number; skipped: number; warnings: string[] }}
 */
export function applyShiftPreferenceSeedFromHrItems(items) {
  /** @type {string[]} */
  const warnings = [];
  let imported = 0;
  let skipped = 0;
  const list = Array.isArray(items) ? items : [];
  for (const it of list) {
    const linkKey = String(it.linkKey ?? '').trim();
    const staffName = String(it.staffName ?? '').trim();
    const department = String(it.department ?? '').trim();
    if (!linkKey || !staffName || !department) {
      skipped += 1;
      continue;
    }
    const opts = getShiftDepartmentsForLinkKey(linkKey);
    if (!opts.includes(department)) {
      if (warnings.length < 40) {
        warnings.push(`「${staffName}」: 部署「${department}」は ${linkKey} の候補にありません。`);
      }
      skipped += 1;
      continue;
    }
    const cachedPrefs = loadPreferences();
    const existing = cachedPrefs.find(
      (p) =>
        p.facilityLinkKey === linkKey &&
        String(p.staffName ?? '').trim() === staffName &&
        String(p.department ?? '').trim() === department
    );
    const base = normalizePreference(existing || {});
    const row = {
      ...base,
      id: existing?.id ?? newPreferenceId(),
      facilityLinkKey: linkKey,
      staffName,
      department,
      mode: 'free_text',
      nightCount: 0,
      dayCount: 0,
      offCount: 0,
      paidLeaveCount: 0,
      note: String(base.note ?? '').trim() || '求人シート取込（タグ）',
      submittedBy: 'manager',
      updatedAt: new Date().toISOString(),
    };
    upsertPreference({
      ...row,
      preferredShiftText: summarizePreference(row),
    });
    imported += 1;
  }
  return { imported, skipped, warnings };
}

/**
 * VITE_HR_SPREADSHEET_ID の求人シートから勤務希望を一括更新（ヒヤリ周知名簿は更新しない）。
 * @param {string} sheetsApiKey
 * @param {{ preferredSheetTitle?: string }} [opts]
 */
export async function importShiftPreferencesFromHrSpreadsheet(sheetsApiKey, opts = {}) {
  const bundle = await fetchHrStaffSheetBundle(String(sheetsApiKey ?? '').trim(), opts);
  const seed = bundle.shiftSeed ?? { items: [], warnings: [] };
  const applied = applyShiftPreferenceSeedFromHrItems(seed.items ?? []);
  return {
    imported: applied.imported,
    skipped: applied.skipped,
    sheetTitle: bundle.sheetTitle,
    spreadsheetId: bundle.spreadsheetId,
    warnings: [...(seed.warnings ?? []), ...applied.warnings].slice(0, 60),
  };
}

export { WEEK_JA };
