import * as XLSX from 'xlsx';
import {
  currentYmd,
  findResidentForScheduleImport,
  setResidentDailyPlans,
} from './residentDailySchedule.js';
import {
  FACILITY_STORE_RESIDENT_SCHEDULE,
  syncFacilityStoreNow,
} from './facilityPortalStoreSync.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** @param {string} ymd */
export function excelSerialFromYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((d - new Date(1899, 11, 30)) / 86400000);
}

/** @param {string} monthYm YYYY-MM */
export function daysInMonthYm(monthYm) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthYm ?? '').trim());
  if (!m) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(y, mo, 0).getDate();
  /** @type {string[]} */
  const out = [];
  for (let d = 1; d <= last; d++) out.push(`${y}-${pad2(mo)}-${pad2(d)}`);
  return out;
}

function normCell(s) {
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .trim();
}

function inferPlanType(title) {
  const t = String(title ?? '');
  if (/入浴/u.test(t)) return '入浴';
  if (/デイ|通所/u.test(t)) return 'デイ';
  if (/受診|病院|診察|往診/u.test(t)) return '受診';
  if (/マッサージ|リハ|訪問リハ/u.test(t)) return 'リハ';
  if (/面会|外出/u.test(t)) return '外出';
  return 'その他';
}

/**
 * @param {string} cell
 * @returns {{ nameKey: string; time: string; title: string }[]}
 */
export function parseR8ScheduleCell(cell) {
  const raw = normCell(cell);
  if (!raw || raw === '—' || raw === '-') return [];
  if (/お休み|キャンセル/u.test(raw)) return [];

  /** @type {{ nameKey: string; time: string; title: string }[]} */
  const out = [];
  const re =
    /([\u3040-\u30FF\u4E00-\u9FFF\u2F00-\u2FDF\u3400-\u4DBF\u4E00-\u9FFF]{2,14}様)\s*(\d{1,2}[:：]\d{2})?\s*([^]*?)(?=[\u3040-\u30FF\u4E00-\u9FFF]{2,14}様|$)/gu;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const nameKey = m[1].replace(/様\s*$/u, '').trim();
    const time = m[2] ? m[2].replace(/：/g, ':') : '';
    let detail = normCell(m[3]);
    detail = detail.replace(/^[()（）\s]+/u, '').replace(/[()）\s]+$/u, '');
    if (!nameKey) continue;
    out.push({
      nameKey,
      time,
      title: detail || raw,
    });
  }
  if (!out.length) {
    const one = raw.match(/^([\u3040-\u30FF\u4E00-\u9FFF]{2,14}様)\s*(\d{1,2}[:：]\d{2})?\s*(.*)$/u);
    if (one) {
      out.push({
        nameKey: one[1].replace(/様\s*$/u, '').trim(),
        time: one[2] ? one[2].replace(/：/g, ':') : '',
        title: normCell(one[3]) || raw,
      });
    }
  }
  return out;
}

/**
 * @param {string[][]} grid
 * @param {string} ymd
 */
export function findR8DateColumn(grid, ymd) {
  const serial = excelSerialFromYmd(ymd);
  if (!serial) return -1;
  let bestCol = -1;
  let bestRow = -1;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r] || []).length; c++) {
      const v = normCell(grid[r][c]);
      if (Number(v) === serial) {
        if (bestCol < 0 || r < bestRow) {
          bestCol = c;
          bestRow = r;
        }
      }
    }
  }
  return bestCol;
}

/**
 * @param {string[][]} grid
 * @param {string} ymd
 * @returns {{ nameKey: string; time: string; title: string; type: string }[]}
 */
export function extractR8DayPlansFromGrid(grid, ymd) {
  const col = findR8DateColumn(grid, ymd);
  if (col < 0) return [];
  const serial = excelSerialFromYmd(ymd);
  /** @type {{ nameKey: string; time: string; title: string; type: string }[]} */
  const plans = [];
  const seen = new Set();

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    if (Number(normCell(row[col])) === serial) continue;
    const cell = normCell(row[col]);
    if (!cell) continue;
    if (/^(日|月|火|水|木|金|土)$/u.test(cell)) continue;
    if (/^\d{1,2}$/.test(cell) && Number(cell) >= 1 && Number(cell) <= 31) continue;

    for (const item of parseR8ScheduleCell(cell)) {
      const key = `${item.nameKey}|${item.time}|${item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plans.push({
        ...item,
        type: inferPlanType(item.title),
      });
    }
  }
  return plans;
}

/**
 * @param {ArrayBuffer | Uint8Array} buffer
 * @param {string} monthYm YYYY-MM
 */
export function readR8WorkbookFromBuffer(buffer) {
  return XLSX.read(buffer, { type: 'array' });
}

/**
 * @param {import('xlsx').WorkBook} wb
 * @param {number} monthNum 1-12
 */
function sheetNamesForMonth(wb, monthNum) {
  const main = `${monthNum}月`;
  const bath = `${monthNum}月 入浴のみ`;
  const names = wb.SheetNames || [];
  return {
    main: names.includes(main) ? main : null,
    bath: names.includes(bath) ? bath : null,
  };
}

/**
 * @param {string} linkKey
 * @param {Record<string, unknown>[]} residents
 * @param {import('xlsx').WorkBook} wb
 * @param {string} monthYm
 */
export function importR8VisitCalendarMonth(linkKey, residents, wb, monthYm) {
  const ym = String(monthYm ?? '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return { ok: false, error: '月の指定が不正です' };

  const monthNum = Number(m[2]);
  const sheets = sheetNamesForMonth(wb, monthNum);
  if (!sheets.main && !sheets.bath) {
    return { ok: false, error: `${monthNum}月 のシートが見つかりません` };
  }

  const days = daysInMonthYm(ym);
  /** @type {Map<string, Map<string, { time: string; title: string; type: string }[]>>} */
  const byResidentDay = new Map();
  let rawCells = 0;
  let skipped = 0;

  const ingestGrid = (grid) => {
    for (const ymd of days) {
      const dayPlans = extractR8DayPlansFromGrid(grid, ymd);
      rawCells += dayPlans.length;
      for (const p of dayPlans) {
        const res = findResidentForScheduleImport(residents, p.nameKey);
        if (!res) {
          skipped++;
          continue;
        }
        const rid = String(res.id);
        if (!byResidentDay.has(rid)) byResidentDay.set(rid, new Map());
        const dayMap = byResidentDay.get(rid);
        const list = dayMap.get(ymd) ?? [];
        const dupKey = `${p.time}|${p.title}`;
        if (!list.some((x) => `${x.time}|${x.title}` === dupKey)) {
          list.push({
            time: p.time,
            title: p.title,
            type: p.type,
          });
        }
        dayMap.set(ymd, list);
      }
    }
  };

  if (sheets.main) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheets.main], { header: 1, defval: '' });
    ingestGrid(rows.map((r) => (r || []).map((c) => String(c ?? ''))));
  }
  if (sheets.bath) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheets.bath], { header: 1, defval: '' });
    ingestGrid(rows.map((r) => (r || []).map((c) => String(c ?? ''))));
  }

  let appliedDays = 0;
  let residentsTouched = 0;
  for (const [rid, dayMap] of byResidentDay.entries()) {
    residentsTouched++;
    for (const [ymd, items] of dayMap.entries()) {
      const plans = items.map((it, i) => ({
        id: `r8_${ymd}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        time: it.time,
        title: it.title,
        type: it.type,
        source: 'r8_calendar',
      }));
      setResidentDailyPlans(linkKey, rid, ymd, plans, { merge: 'merge_r8' });
      appliedDays++;
    }
  }

  void syncFacilityStoreNow(FACILITY_STORE_RESIDENT_SCHEDULE, linkKey);

  return {
    ok: true,
    monthYm: ym,
    daysInMonth: days.length,
    rawCells,
    skipped,
    residentsTouched,
    planDays: appliedDays,
  };
}

/** @param {ArrayBuffer | Uint8Array} buffer @param {string} linkKey @param {Record<string, unknown>[]} residents @param {string} [monthYm] */
export function importR8VisitCalendarFromBuffer(buffer, linkKey, residents, monthYm) {
  const ym =
    String(monthYm ?? '').trim().slice(0, 7) ||
    currentYmd().slice(0, 7);
  try {
    const wb = readR8WorkbookFromBuffer(buffer);
    return importR8VisitCalendarMonth(linkKey, residents, wb, ym);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
