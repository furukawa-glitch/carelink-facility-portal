import { fetchSpreadsheetValuesByGid } from '../services/GoogleSheetService.js';
import { residentScheduleSheetForFacility } from '../config/residentScheduleSheets.js';
import {
  buildPersonNameMatchCandidates,
  findResidentByPersonNameCandidates,
} from './residentNameMatch.js';

const LS_KEY = 'carelink_os_resident_daily_plans_v1';

const NAME_HEADER_HINTS = ['氏名', '名前', '利用者', '入居者', 'フリガナ', '部屋', '居室', '号室'];
const SKIP_NAME = /^(合計|計|備考|メモ|時間|予定表|利用者|入居者|氏名|フリガナ|部屋|居室|—|-)$/u;
const TIME_HEADER = /^(\d{1,2})[:：](\d{2})$/;

function normCell(s) {
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** @returns {string} YYYY-MM-DD */
export function currentYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function readStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(all) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all && typeof all === 'object' ? all : {}));
  } catch {
    /* ignore */
  }
}

function facilityBucket(linkKey) {
  const k = String(linkKey ?? '').trim();
  const all = readStore();
  if (!all[k] || typeof all[k] !== 'object') all[k] = {};
  return { all, k, bucket: all[k] };
}

function persistFacilityBucket(all, k, bucket) {
  all[k] = bucket;
  writeStore(all);
}

/**
 * @param {string} ymd
 * @returns {{ y: number; mo: number; d: number }}
 */
function ymdParts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return { y: 0, mo: 0, d: 0 };
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/**
 * @param {string} header
 * @param {string} targetYmd
 */
function headerMatchesYmd(header, targetYmd) {
  const h = normCell(header);
  if (!h) return false;
  if (/本日|今日/u.test(h)) return true;
  const { y, mo, d } = ymdParts(targetYmd);
  if (!y) return false;

  const full = h.match(/(\d{4})[年\/\-\.](\d{1,2})[月\/\-\.](\d{1,2})/u);
  if (full) {
    const yy = Number(full[1]);
    return yy === y && Number(full[2]) === mo && Number(full[3]) === d;
  }

  const short = h.match(/^(\d{1,2})[\/月\-\.](\d{1,2})(?:日|\(|（|火|月|水|木|金|土|日)?/u);
  if (short && Number(short[1]) === mo && Number(short[2]) === d) return true;

  const dayOnly = h.match(/^(\d{1,2})(?:日|\(|（|火|月|水|木|金|土|日)/u);
  if (dayOnly && Number(dayOnly[1]) === d) return true;

  return false;
}

/**
 * @param {string[][]} rows
 * @param {string} [fallbackYmd]
 */
export function parseSheetAnchorYmd(rows, fallbackYmd = currentYmd()) {
  for (let r = 0; r < Math.min(8, rows.length); r++) {
    for (const cell of rows[r] || []) {
      const t = normCell(cell);
      const m = t.match(/(\d{4})[年\/\-\.](\d{1,2})[月\/\-\.](\d{1,2})/u);
      if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    }
  }
  return fallbackYmd;
}

/**
 * @param {string[]} headerRow
 */
function findNameColumnIndex(headerRow) {
  for (let c = 0; c < headerRow.length; c++) {
    const h = normCell(headerRow[c]);
    if (!h) continue;
    if (NAME_HEADER_HINTS.some((hint) => h.includes(hint) && !/予定|時間|サービス/u.test(h))) {
      if (/氏名|名前|利用者|入居者|フリガナ/u.test(h)) return c;
    }
  }
  for (let c = 0; c < Math.min(6, headerRow.length); c++) {
    const sample = normCell(headerRow[c]);
    if (sample && !SKIP_NAME.test(sample) && sample.length >= 2) return c;
  }
  return 0;
}

function looksLikePersonName(s) {
  const t = normCell(s).replace(/様\s*$/u, '').trim();
  if (!t || t.length < 2 || SKIP_NAME.test(t)) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^[0-9]{1,2}[:：]/.test(t)) return false;
  if (/^(月|火|水|木|金|土|日|曜)$/u.test(t)) return false;
  return /[\u3040-\u30FF\u4E00-\u9FFF]/u.test(t);
}

/**
 * @param {string[][]} grid
 * @param {string} targetYmd
 * @param {number} nameCol
 */
function findTodayColumnInGrid(grid, targetYmd, nameCol) {
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    for (let c = 0; c < (grid[r] || []).length; c++) {
      if (c === nameCol) continue;
      if (headerMatchesYmd(normCell(grid[r][c]), targetYmd)) return c;
    }
  }
  const { d } = ymdParts(targetYmd);
  if (!d) return -1;
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const row = grid[r] || [];
    let dayHits = 0;
    for (const cell of row) {
      const v = normCell(cell);
      if (/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 31) dayHits++;
    }
    if (dayHits < 5) continue;
    for (let c = 0; c < row.length; c++) {
      if (c === nameCol) continue;
      if (normCell(row[c]) === String(d)) return c;
    }
  }
  return -1;
}

/**
 * @param {string[][]} grid
 * @param {number} headerRowIdx
 * @param {string[]} headerRow
 */
function findNameColumnInGrid(grid, headerRowIdx, headerRow) {
  const fromHeader = findNameColumnIndex(headerRow);
  if (fromHeader >= 0) {
    let hits = 0;
    for (let r = headerRowIdx + 1; r < Math.min(headerRowIdx + 30, grid.length); r++) {
      if (looksLikePersonName(grid[r]?.[fromHeader])) hits++;
    }
    if (hits >= 2) return fromHeader;
  }
  for (let c = 0; c <= 4; c++) {
    let hits = 0;
    for (let r = 0; r < Math.min(45, grid.length); r++) {
      if (looksLikePersonName(grid[r]?.[c])) hits++;
    }
    if (hits >= 3) return c;
  }
  return fromHeader >= 0 ? fromHeader : 1;
}

/**
 * @param {string[][]} grid
 */
function dataStartRowAfterCalendarHeader(grid) {
  let start = 1;
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const row = grid[r] || [];
    let dayHits = 0;
    for (const cell of row) {
      const v = normCell(cell);
      if (/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 31) dayHits++;
    }
    if (dayHits >= 5) start = Math.max(start, r + 1);
  }
  return start;
}

/**
 * @param {string[][]} rows
 * @param {string} targetYmd
 */
export function parseResidentScheduleSheetRows(rows, targetYmd) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(targetYmd ?? '')) ? String(targetYmd) : currentYmd();
  const grid = Array.isArray(rows) ? rows : [];
  if (!grid.length) return { ymd, plansByName: new Map(), unmatchedSamples: [] };

  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(20, grid.length); r++) {
    const row = grid[r] || [];
    const joined = row.map(normCell).join(' ');
    if (/氏名|名前|利用者|入居者|フリガナ|部屋|居室/u.test(joined)) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx < 0) headerRowIdx = 0;

  const headerRow = (grid[headerRowIdx] || []).map(normCell);
  const nameCol = findNameColumnInGrid(grid, headerRowIdx, headerRow);

  /** @type {{ col: number; time: string }[]} */
  const todayCols = [];
  /** @type {{ col: number; time: string }[]} */
  const timeCols = [];

  for (let c = 0; c < headerRow.length; c++) {
    if (c === nameCol) continue;
    const h = headerRow[c];
    if (!h) continue;
    const tm = TIME_HEADER.exec(h);
    if (tm) {
      timeCols.push({ col: c, time: `${pad2(tm[1])}:${tm[2]}` });
      continue;
    }
    if (headerMatchesYmd(h, ymd)) {
      todayCols.push({ col: c, time: '' });
    }
  }

  if (!todayCols.length) {
    const calCol = findTodayColumnInGrid(grid, ymd, nameCol);
    if (calCol >= 0) todayCols.push({ col: calCol, time: '' });
  }

  const activeCols = todayCols.length ? todayCols : timeCols;
  const plansByName = new Map();
  const unmatchedSamples = [];
  const dataStartRow = Math.max(headerRowIdx + 1, dataStartRowAfterCalendarHeader(grid));

  for (let r = dataStartRow; r < grid.length; r++) {
    const row = grid[r] || [];
    const nameRaw = normCell(row[nameCol]);
    if (!looksLikePersonName(nameRaw)) continue;

    /** @type {{ time: string; title: string }[]} */
    const items = [];

    if (activeCols.length) {
      for (const { col, time } of activeCols) {
        const title = normCell(row[col]);
        if (!title || title === '—' || title === '-') continue;
        items.push({ time, title });
      }
    } else {
      const parts = [];
      for (let c = nameCol + 1; c < row.length; c++) {
        const v = normCell(row[c]);
        if (!v || v === '—') continue;
        parts.push(v);
      }
      const joined = parts.join(' / ').trim();
      if (joined) items.push({ time: '', title: joined });
    }

    if (!items.length) continue;
    const key = nameRaw.replace(/様\s*$/u, '').trim();
    plansByName.set(key, items);
    if (plansByName.size <= 3) unmatchedSamples.push(key);
  }

  return { ymd, plansByName, unmatchedSamples };
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {Map<string, { time: string; title: string }[]>} plansByName
 */
export function matchResidentScheduleImports(residents, plansByName) {
  const list = Array.isArray(residents) ? residents : [];
  const byName = plansByName instanceof Map ? plansByName : new Map();
  /** @type {{ residentId: string; name: string; room: string; plans: { time: string; title: string; type: string; source: string }[] }[]} */
  const matched = [];
  let unmatched = 0;

  for (const [nameKey, items] of byName.entries()) {
    const res = findResidentByPersonNameCandidates(list, buildPersonNameMatchCandidates(nameKey));
    const plans = items.map((it) => ({
      time: String(it.time ?? '').trim(),
      title: String(it.title ?? '').trim(),
      type: inferPlanType(it.title),
      source: 'facility_sheet',
    }));
    if (res) {
      matched.push({
        residentId: String(res.id),
        name: String(res.name ?? nameKey),
        room: String(res.room ?? ''),
        plans,
      });
    } else {
      unmatched++;
    }
  }
  return { matched, unmatched };
}

/** @param {string} title */
function inferPlanType(title) {
  const t = String(title ?? '');
  if (/デイ|通所|DS/u.test(t)) return 'デイ';
  if (/入浴/u.test(t)) return '入浴';
  if (/受診|病院|診察|往診/u.test(t)) return '受診';
  if (/面会|外出|買い物/u.test(t)) return '外出';
  if (/リハ/u.test(t)) return 'リハ';
  return 'その他';
}

/**
 * @param {string} linkKey
 * @param {string} residentId
 * @param {string} ymd
 * @returns {{ id: string; time: string; title: string; type: string; source: string; note?: string }[]}
 */
export function getResidentDailyPlans(linkKey, residentId, ymd) {
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  const y = String(ymd ?? '').trim();
  if (!fk || !rid || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return [];
  const { bucket } = facilityBucket(fk);
  const row = bucket[rid];
  if (!row || typeof row !== 'object') return [];
  const arr = row[y];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => normalizePlanItem(p))
    .filter(Boolean)
    .sort((a, b) => String(a.time).localeCompare(String(b.time), 'ja'));
}

function normalizePlanItem(p) {
  if (!p || typeof p !== 'object') return null;
  const title = String(p.title ?? '').trim();
  if (!title) return null;
  return {
    id: String(p.id ?? '').trim() || `plan_${Date.now()}`,
    time: String(p.time ?? '').trim(),
    title,
    type: String(p.type ?? 'その他').trim() || 'その他',
    source: String(p.source ?? 'app').trim() || 'app',
    note: String(p.note ?? '').trim() || undefined,
  };
}

/**
 * @param {string} linkKey
 * @param {string} residentId
 * @param {string} ymd
 * @param {unknown[]} plans
 * @param {{ merge?: 'replace' | 'merge_sheet' }} [opts]
 */
export function setResidentDailyPlans(linkKey, residentId, ymd, plans, opts = {}) {
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  const y = String(ymd ?? '').trim();
  if (!fk || !rid || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return;
  const { all, k, bucket } = facilityBucket(fk);
  const prevRow = bucket[rid] && typeof bucket[rid] === 'object' ? { ...bucket[rid] } : {};
  const prevDay = Array.isArray(prevRow[y]) ? prevRow[y] : [];
  const incoming = (Array.isArray(plans) ? plans : [])
    .map((p) => normalizePlanItem({ ...p, id: p?.id || `plan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }))
    .filter(Boolean);
  const merged =
    opts.merge === 'merge_sheet'
      ? [
          ...prevDay.filter((p) => String(p?.source ?? '') !== 'facility_sheet'),
          ...incoming,
        ]
      : incoming;
  prevRow[y] = merged.sort((a, b) => String(a.time).localeCompare(String(b.time), 'ja'));
  bucket[rid] = prevRow;
  persistFacilityBucket(all, k, bucket);
}

/**
 * @param {string} linkKey
 * @param {string} residentId
 * @param {string} ymd
 * @param {{ time?: string; title: string; type?: string; note?: string }} plan
 */
export function addResidentDailyPlan(linkKey, residentId, ymd, plan) {
  const title = String(plan?.title ?? '').trim();
  if (!title) return false;
  const existing = getResidentDailyPlans(linkKey, residentId, ymd);
  existing.push({
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    time: String(plan?.time ?? '').trim(),
    title,
    type: String(plan?.type ?? inferPlanType(title)).trim() || 'その他',
    source: 'app',
    note: String(plan?.note ?? '').trim() || undefined,
  });
  setResidentDailyPlans(linkKey, residentId, ymd, existing);
  return true;
}

export function removeResidentDailyPlan(linkKey, residentId, ymd, planId) {
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  const y = String(ymd ?? '').trim();
  const pid = String(planId ?? '').trim();
  if (!fk || !rid || !y || !pid) return false;
  const existing = getResidentDailyPlans(linkKey, residentId, ymd);
  const next = existing.filter((p) => p.id !== pid);
  if (next.length === existing.length) return false;
  setResidentDailyPlans(linkKey, residentId, ymd, next);
  return true;
}

/** @param {string} linkKey @param {string} apiKey @param {string} [targetYmd] */
export async function importResidentScheduleFromSheet(linkKey, apiKey, targetYmd = currentYmd()) {
  const cfg = residentScheduleSheetForFacility(linkKey);
  if (!cfg) {
    return { ok: false, error: 'この施設は利用者お予定表の設定がありません' };
  }
  const key = String(apiKey ?? '').trim();
  if (!key) {
    return { ok: false, error: 'VITE_GOOGLE_SHEETS_API_KEY が未設定です' };
  }

  let rows;
  try {
    rows = await fetchSpreadsheetValuesByGid(
      cfg.spreadsheetId,
      key,
      cfg.sheetGid,
      cfg.rangeA1 ?? 'A1:ZZ150'
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error:
        msg.includes('お予定表') || msg.includes('スプレッドシート') || msg.includes('CSV')
          ? msg
          : `${msg}（Excel の場合は Google スプレッドシートに変換するか、共有を「閲覧可」にしてください）`,
    };
  }
  const anchorYmd = parseSheetAnchorYmd(rows, targetYmd);
  const useYmd = /^\d{4}-\d{2}-\d{2}$/.test(String(targetYmd ?? '')) ? String(targetYmd) : anchorYmd;
  const parsed = parseResidentScheduleSheetRows(rows, useYmd);
  if (!parsed?.plansByName) {
    return { ok: false, error: 'お予定表の形式を読み取れませんでした（氏名列・本日の日付列を確認してください）' };
  }
  return {
    ok: true,
    ymd: parsed.ymd,
    rows: rows.length,
    parsedCount: parsed.plansByName.size,
    parsed,
  };
}

/** @param {string} linkKey @param {Record<string, unknown>[]} residents @param {import('./residentDailySchedule.js').ReturnType<typeof parseResidentScheduleSheetRows>} parsed */
export function applyImportedResidentSchedules(linkKey, residents, parsed) {
  if (!parsed || !(parsed.plansByName instanceof Map)) {
    return { applied: 0, unmatched: 0, ymd: String(parsed?.ymd ?? currentYmd()) };
  }
  const { matched, unmatched } = matchResidentScheduleImports(residents, parsed.plansByName);
  for (const row of matched) {
    setResidentDailyPlans(linkKey, row.residentId, parsed.ymd, row.plans, { merge: 'merge_sheet' });
  }
  return { applied: matched.length, unmatched, ymd: parsed.ymd };
}

/** @param {string} linkKey @param {string} residentId @param {string} ymd */
export function formatResidentPlansShort(linkKey, residentId, ymd) {
  const plans = getResidentDailyPlans(linkKey, residentId, ymd);
  if (!plans.length) return '';
  return plans
    .map((p) => {
      const t = p.time ? `${p.time} ` : '';
      return `${t}${p.title}`;
    })
    .join(' / ');
}
