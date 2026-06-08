import {
  fetchSpreadsheetValuesByGid,
  fetchSpreadsheetValuesViaCsvExport,
} from '../services/GoogleSheetService.js';
import { residentScheduleSheetForFacility } from '../config/residentScheduleSheets.js';
import {
  buildPersonNameMatchCandidates,
  findResidentByPersonNameCandidates,
  personNameMatchKey,
} from './residentNameMatch.js';
import { queueResidentScheduleCloudSync } from './facilityPortalStoreSync.js';

const LS_KEY = 'carelink_os_resident_daily_plans_v1';
const LS_META_KEY = 'carelink_os_resident_daily_plans_meta_v1';
const LS_RECURRING_KEY = 'carelink_os_resident_recurring_plans_v1';

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

function touchFacilityScheduleSavedAt(linkKey) {
  const fk = String(linkKey ?? '').trim();
  if (!fk) return;
  const all = readMetaStore();
  const prev = all[fk] && typeof all[fk] === 'object' ? all[fk] : {};
  all[fk] = { ...prev, scheduleSavedAt: new Date().toISOString() };
  writeMetaStore(all);
}

function persistFacilityBucket(all, k, bucket) {
  all[k] = bucket;
  writeStore(all);
  touchFacilityScheduleSavedAt(k);
  queueResidentScheduleCloudSync(k);
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

  const slashMd = h.match(/^(\d{1,2})[\/／](\d{1,2})$/u);
  if (slashMd && Number(slashMd[1]) === mo && Number(slashMd[2]) === d) return true;

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
  const raw = normCell(s);
  if (!raw || SKIP_NAME.test(raw)) return false;
  if ((raw.match(/様/g) || []).length > 1) return false;
  if (/[\/／\n]/.test(raw)) return false;
  if (/\d{1,2}[:：]\d{2}/.test(raw)) return false;
  if (/\([^)]{2,}\)/.test(raw) && raw.length > 12) return false;
  const t = raw.replace(/様\s*$/u, '').trim();
  if (!t || t.length < 2 || t.length > 14 || SKIP_NAME.test(t)) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^[0-9]{1,2}[:：]/.test(t)) return false;
  if (/^(月|火|水|木|金|土|日|曜)$/u.test(t)) return false;
  return /^[\u3040-\u30FF\u4E00-\u9FFF]{2,12}$/u.test(t);
}

function readMetaStore() {
  try {
    const raw = localStorage.getItem(LS_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMetaStore(all) {
  try {
    localStorage.setItem(LS_META_KEY, JSON.stringify(all && typeof all === 'object' ? all : {}));
  } catch {
    /* ignore */
  }
}

/** @param {string} linkKey @param {string} ymd */
export function setFacilityScheduleImportYmd(linkKey, ymd) {
  const fk = String(linkKey ?? '').trim();
  const y = String(ymd ?? '').trim();
  if (!fk || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return;
  const all = readMetaStore();
  all[fk] = { lastYmd: y, updatedAt: new Date().toISOString() };
  writeMetaStore(all);
}

/**
 * カード表示用の日付（取込日を優先。無ければ今日）
 * @param {string} linkKey
 * @param {string} [fallbackYmd]
 */
export function getFacilityScheduleDisplayYmd(linkKey, fallbackYmd = currentYmd()) {
  const fk = String(linkKey ?? '').trim();
  const meta = readMetaStore()[fk];
  const last = String(meta?.lastYmd ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(last)) return last;
  const fb = String(fallbackYmd ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(fb) ? fb : currentYmd();
}

/**
 * 名簿照合（予定表取込専用・姓のみ一致や部分一致を使わない）
 * @param {Record<string, unknown>[]} residents
 * @param {string} nameKey
 */
export function findResidentForScheduleImport(residents, nameKey) {
  const list = Array.isArray(residents) ? residents : [];
  const keys = new Set(
    buildPersonNameMatchCandidates(nameKey)
      .map((c) => personNameMatchKey(c))
      .filter((k) => k.length >= 2)
  );
  if (!keys.size) return null;
  /** @type {Record<string, unknown>[]} */
  const hits = [];
  for (const res of list) {
    const nk = personNameMatchKey(String(res.name ?? ''));
    if (nk && keys.has(nk)) hits.push(res);
  }
  if (hits.length === 1) return hits[0];
  return null;
}

/** @param {string} title @param {string} residentName */
function cleanPlanTitleForDisplay(title, residentName) {
  const parsed = parsePersonScheduleSegment(title);
  if (parsed?.nameKey) {
    return [parsed.time, parsed.title].filter(Boolean).join(' ').trim() || parsed.title;
  }
  let t = normCell(title);
  t = t.replace(/^[\u3040-\u30FF\u4E00-\u9FFF]{2,14}様\s*/u, '');
  return t.trim();
}

/** @param {string} a @param {string} b */
function personKeysMatch(a, b) {
  const ca = buildPersonNameMatchCandidates(a);
  const cb = buildPersonNameMatchCandidates(b);
  const setB = new Set(cb.map((x) => personNameMatchKey(x)));
  return ca.some((x) => setB.has(personNameMatchKey(x)));
}

/**
 * 1セルに「○○様 16:20 … / △△様 …」と複数人が入っているときに分割
 * @param {string} text
 */
function splitScheduleCellSegments(text) {
  const t = normCell(text);
  if (!t) return [];
  const samaCount = (t.match(/様/g) || []).length;
  if (samaCount >= 2 || /[\/／]/.test(t)) {
    return t
      .split(/\s*[\/／\n]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [t];
}

/**
 * @param {string} seg
 * @returns {{ nameKey: string; time: string; title: string } | null}
 */
function parsePersonScheduleSegment(seg) {
  const s = normCell(seg);
  if (!s) return null;
  const m = s.match(/^([\u3040-\u30FF\u4E00-\u9FFF]{2,12}様)\s*(\d{1,2}[:：]\d{2})?\s*(.*)$/u);
  if (!m) return null;
  const nameKey = m[1].replace(/様\s*$/u, '').trim();
  const time = m[2] ? m[2].replace(/：/g, ':') : '';
  const detail = normCell(m[3]);
  const title = detail || normCell(s.replace(m[1], '').replace(m[2] ?? '', '')) || s;
  return { nameKey, time, title };
}

/**
 * @param {Map<string, { time: string; title: string }[]>} plansByName
 * @param {string} nameKey
 * @param {{ time: string; title: string }} item
 */
function addPlanToMap(plansByName, nameKey, item) {
  const key = String(nameKey ?? '')
    .replace(/様\s*$/u, '')
    .trim();
  if (!key || !item?.title) return;
  const list = plansByName.get(key) ?? [];
  list.push(item);
  plansByName.set(key, list);
}

/**
 * 表の1セル → 氏名ごとの予定（複数人混在セルは分解して該当者へ）
 * @param {Map<string, { time: string; title: string }[]>} plansByName
 * @param {string} rowNameKey
 * @param {string} cellText
 * @param {string} colTime
 */
function appendPlansFromCell(plansByName, rowNameKey, cellText, colTime) {
  const cell = normCell(cellText);
  if (!cell || cell === '—' || cell === '-') return;
  const rowKey = rowNameKey.replace(/様\s*$/u, '').trim();
  const segments = splitScheduleCellSegments(cell);

  let assignedToRow = false;
  for (const seg of segments) {
    const parsed = parsePersonScheduleSegment(seg);
    if (parsed?.nameKey) {
      const targetKey = parsed.nameKey;
      const time = parsed.time || colTime;
      const title = parsed.title;
      if (personKeysMatch(rowKey, targetKey)) {
        addPlanToMap(plansByName, rowKey, { time, title });
        assignedToRow = true;
      } else {
        addPlanToMap(plansByName, targetKey, { time, title });
      }
      continue;
    }
    if (segments.length === 1) {
      addPlanToMap(plansByName, rowKey, { time: colTime, title: seg });
      assignedToRow = true;
    }
  }

  if (!assignedToRow && segments.length === 1 && !parsePersonScheduleSegment(segments[0])) {
    addPlanToMap(plansByName, rowKey, { time: colTime, title: cell });
  }
}

/**
 * 保存済み予定から、その利用者以外の氏名が混ざった行を除去
 * @param {{ time: string; title: string; id: string; type: string; source: string; note?: string }[]} plans
 * @param {string} residentName
 */
function sanitizePlansForResident(plans, residentName) {
  const nm = String(residentName ?? '').trim();
  if (!nm) return plans;
  const selfKeys = new Set(
    buildPersonNameMatchCandidates(nm)
      .map((c) => personNameMatchKey(c))
      .filter((k) => k.length >= 2)
  );
  const belongsToSelf = (nameKey) => {
    const pk = personNameMatchKey(nameKey);
    return Boolean(pk && selfKeys.has(pk));
  };

  return plans.flatMap((p) => {
    const segments = splitScheduleCellSegments(p.title);
    if (segments.length <= 1) {
      const parsed = parsePersonScheduleSegment(segments[0] ?? p.title);
      if (parsed?.nameKey) {
        if (!belongsToSelf(parsed.nameKey)) return [];
        return [{ ...p, time: parsed.time || p.time, title: parsed.title }];
      }
      if ((String(p.title).match(/様/g) || []).length >= 2) return [];
      return [p];
    }
    return segments
      .map((seg) => {
        const parsed = parsePersonScheduleSegment(seg);
        if (!parsed?.nameKey || !belongsToSelf(parsed.nameKey)) return null;
        return {
          ...p,
          id: `${p.id}_${parsed.nameKey}`,
          time: parsed.time || p.time,
          title: parsed.title,
        };
      })
      .filter(Boolean);
  });
}

/**
 * カレンダー形式: 上段の「2026/6/4」や下段の「4」などから対象日の列を特定
 * @param {string[][]} grid
 * @param {string} targetYmd
 * @param {number} nameCol
 */
function findTodayColumnInGrid(grid, targetYmd, nameCol) {
  for (let r = 0; r < Math.min(20, grid.length); r++) {
    for (let c = 0; c < (grid[r] || []).length; c++) {
      if (c === nameCol) continue;
      if (headerMatchesYmd(normCell(grid[r][c]), targetYmd)) return c;
    }
  }
  const { y, mo, d } = ymdParts(targetYmd);
  if (!d) return -1;
  for (let r = 0; r < Math.min(20, grid.length); r++) {
    const row = grid[r] || [];
    let dayHits = 0;
    for (const cell of row) {
      const v = normCell(cell);
      if (/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 31) dayHits++;
    }
    if (dayHits < 4) continue;
    for (let c = 0; c < row.length; c++) {
      if (c === nameCol) continue;
      const v = normCell(row[c]);
      if (v === String(d)) return c;
      if (mo && v === `${mo}/${d}`) return c;
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
  let bestCol = fromHeader >= 0 ? fromHeader : 1;
  let bestHits = 0;
  for (let c = 0; c <= 6; c++) {
    let hits = 0;
    for (let r = 0; r < Math.min(45, grid.length); r++) {
      if (looksLikePersonName(grid[r]?.[c])) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestCol = c;
    }
  }
  if (bestHits >= 2) return bestCol;
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

  let activeCols = todayCols.length ? todayCols : timeCols;
  const plansByName = new Map();
  const unmatchedSamples = [];
  const dataStartRow = Math.max(headerRowIdx + 1, dataStartRowAfterCalendarHeader(grid));

  let calendarDayHeaders = 0;
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    let dayHits = 0;
    for (const cell of grid[r] || []) {
      const v = normCell(cell);
      if (/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 31) dayHits++;
    }
    calendarDayHeaders = Math.max(calendarDayHeaders, dayHits);
  }
  let personRows = 0;
  for (let r = dataStartRow; r < grid.length; r++) {
    if (looksLikePersonName(grid[r]?.[nameCol])) personRows++;
  }
  const calendarLayout =
    activeCols.length > 0 && (calendarDayHeaders >= 4 || personRows < 4);

  if (calendarLayout && activeCols.length) {
    for (const { col, time } of activeCols) {
      for (let r = dataStartRow; r < grid.length; r++) {
        const row = grid[r] || [];
        const nameRaw = normCell(row[nameCol]);
        const rowKey = looksLikePersonName(nameRaw) ? nameRaw.replace(/様\s*$/u, '').trim() : '';
        appendPlansFromCell(plansByName, rowKey, row[col], time);
      }
      if (plansByName.size === 0) {
        for (let r = 0; r < grid.length; r++) {
          appendPlansFromCell(plansByName, '', grid[r]?.[col], time);
        }
      }
    }
    for (const key of plansByName.keys()) {
      if (unmatchedSamples.length < 3) unmatchedSamples.push(key);
    }
    return { ymd, plansByName, unmatchedSamples, layout: 'calendar' };
  }

  for (let r = dataStartRow; r < grid.length; r++) {
    const row = grid[r] || [];
    const nameRaw = normCell(row[nameCol]);
    if (!looksLikePersonName(nameRaw)) continue;

    const rowKey = nameRaw.replace(/様\s*$/u, '').trim();
    const mapSizeBefore = plansByName.size;
    const rowPlansBefore = (plansByName.get(rowKey) ?? []).length;

    if (activeCols.length) {
      for (const { col, time } of activeCols) {
        appendPlansFromCell(plansByName, rowKey, row[col], time);
      }
    } else {
      for (let c = nameCol + 1; c < row.length; c++) {
        appendPlansFromCell(plansByName, rowKey, row[c], '');
      }
    }

    const rowPlansAfter = (plansByName.get(rowKey) ?? []).length;
    if (plansByName.size > mapSizeBefore || rowPlansAfter > rowPlansBefore) {
      if (unmatchedSamples.length < 3 && !unmatchedSamples.includes(rowKey)) unmatchedSamples.push(rowKey);
    }
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
    const res = findResidentForScheduleImport(list, nameKey);
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
function readRecurringStore() {
  try {
    const raw = localStorage.getItem(LS_RECURRING_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRecurringStore(all, touchLinkKey = '') {
  try {
    localStorage.setItem(LS_RECURRING_KEY, JSON.stringify(all && typeof all === 'object' ? all : {}));
  } catch {
    /* ignore */
  }
  const fk = String(touchLinkKey ?? '').trim();
  if (fk) {
    touchFacilityScheduleSavedAt(fk);
    queueResidentScheduleCloudSync(fk);
  }
}

function weekdayMon0FromYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return -1;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (d.getDay() + 6) % 7;
}

/**
 * @param {string} linkKey
 * @param {string} residentId
 */
export function getResidentRecurringPlans(linkKey, residentId) {
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  if (!fk || !rid) return [];
  const all = readRecurringStore();
  const list = all[fk]?.[rid];
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => normalizeRecurringItem(p))
    .filter(Boolean)
    .sort((a, b) => String(a.time).localeCompare(String(b.time), 'ja'));
}

function normalizeRecurringItem(p) {
  if (!p || typeof p !== 'object') return null;
  const title = String(p.title ?? '').trim();
  if (!title) return null;
  const weekdaysMon0 = Array.isArray(p.weekdaysMon0)
    ? [...new Set(p.weekdaysMon0.map((n) => Number(n)).filter((n) => n >= 0 && n <= 6))]
    : [];
  if (!weekdaysMon0.length) return null;
  return {
    id: String(p.id ?? '').trim() || `rec_${Date.now()}`,
    weekdaysMon0,
    time: String(p.time ?? '').trim(),
    title,
    type: String(p.type ?? 'その他').trim() || 'その他',
    source: 'app_recurring',
  };
}

/**
 * @param {string} linkKey
 * @param {string} residentId
 * @param {{ weekdaysMon0: number[]; time?: string; title: string; type?: string }} plan
 */
export function addResidentRecurringPlan(linkKey, residentId, plan) {
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  const title = String(plan?.title ?? '').trim();
  if (!fk || !rid || !title) return false;
  const weekdaysMon0 = Array.isArray(plan.weekdaysMon0)
    ? [...new Set(plan.weekdaysMon0.map((n) => Number(n)).filter((n) => n >= 0 && n <= 6))]
    : [];
  if (!weekdaysMon0.length) return false;

  const all = readRecurringStore();
  if (!all[fk] || typeof all[fk] !== 'object') all[fk] = {};
  const list = Array.isArray(all[fk][rid]) ? [...all[fk][rid]] : [];
  list.push({
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    weekdaysMon0,
    time: String(plan?.time ?? '').trim(),
    title,
    type: String(plan?.type ?? inferPlanType(title)).trim() || 'その他',
    source: 'app_recurring',
  });
  all[fk][rid] = list;
  writeRecurringStore(all, fk);
  return true;
}

export function removeResidentRecurringPlan(linkKey, residentId, planId) {
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  const pid = String(planId ?? '').trim();
  if (!fk || !rid || !pid) return false;
  const all = readRecurringStore();
  const list = Array.isArray(all[fk]?.[rid]) ? all[fk][rid] : [];
  const next = list.filter((p) => String(p?.id ?? '') !== pid);
  if (next.length === list.length) return false;
  all[fk][rid] = next;
  writeRecurringStore(all, fk);
  return true;
}

function expandRecurringForDay(recurring, ymd) {
  const w = weekdayMon0FromYmd(ymd);
  if (w < 0) return [];
  return recurring
    .filter((r) => r.weekdaysMon0.includes(w))
    .map((r) => ({
      id: `recurring:${r.id}:${ymd}`,
      time: r.time,
      title: r.title,
      type: r.type,
      source: 'app_recurring',
      note: '毎週',
    }));
}

/** @param {string} monthYm YYYY-MM */
export function daysInCalendarMonth(monthYm) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthYm ?? '').trim());
  if (!m) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(y, mo, 0).getDate();
  /** @type {string[]} */
  const out = [];
  for (let d = 1; d <= last; d++) {
    out.push(`${y}-${pad2(mo)}-${pad2(d)}`);
  }
  return out;
}

export function getResidentDailyPlans(linkKey, residentId, ymd, residentName = '') {
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  const y = String(ymd ?? '').trim();
  if (!fk || !rid || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return [];
  const { bucket } = facilityBucket(fk);
  const row = bucket[rid];
  if (!row || typeof row !== 'object') return [];
  const arr = row[y];
  const explicit = Array.isArray(arr)
    ? arr.map((p) => normalizePlanItem(p)).filter(Boolean)
    : [];
  const recurring = expandRecurringForDay(getResidentRecurringPlans(fk, rid), y);
  const merged = [...explicit, ...recurring].sort((a, b) =>
    String(a.time).localeCompare(String(b.time), 'ja')
  );
  return sanitizePlansForResident(merged, residentName);
}

/**
 * 施設カレンダー用: 利用者お予定表から取り込んだ予定を日付単位で集約
 * @param {string} linkKey
 * @param {Record<string, unknown>[]} residents
 * @param {string} ymd
 */
export function getResidentDailyPlansForFacilityCalendar(linkKey, residents, ymd) {
  const fk = String(linkKey ?? '').trim();
  const y = String(ymd ?? '').trim();
  if (!fk || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return [];
  const list = Array.isArray(residents) ? residents : [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const res of list) {
    const rid = String(res?.id ?? '').trim();
    if (!rid) continue;
    const nm = String(res?.name ?? '').trim();
    const plans = getResidentDailyPlans(fk, rid, y, nm);
    for (const p of plans) {
      const shortName = nm.replace(/様\s*$/u, '').trim();
      const titleClean = cleanPlanTitleForDisplay(p.title, nm);
      out.push({
        id: `rdaily_${rid}_${p.id}`,
        date: y,
        time: p.time || '—',
        title: titleClean ? `${shortName}様 ${titleClean}` : `${shortName}様`,
        type: p.type,
        source: 'resident_schedule',
        residentId: rid,
        residentName: shortName,
        room: String(res?.room ?? '').trim(),
      });
    }
  }
  return out.sort((a, b) => String(a.time).localeCompare(String(b.time), 'ja'));
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
      : opts.merge === 'merge_r8'
        ? [...prevDay.filter((p) => String(p?.source ?? '') !== 'r8_calendar'), ...incoming]
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
  const fk = String(linkKey ?? '').trim();
  const rid = String(residentId ?? '').trim();
  const y = String(ymd ?? '').trim();
  const { bucket } = facilityBucket(fk);
  const row = bucket[rid] && typeof bucket[rid] === 'object' ? bucket[rid] : {};
  const existing = Array.isArray(row[y]) ? row[y].map((p) => normalizePlanItem(p)).filter(Boolean) : [];
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
  if (pid.startsWith('recurring:')) {
    const baseId = pid.split(':')[1];
    if (baseId) return removeResidentRecurringPlan(fk, rid, baseId);
    return false;
  }
  const { bucket } = facilityBucket(fk);
  const row = bucket[rid];
  const arr = row && Array.isArray(row[y]) ? row[y] : [];
  const next = arr.filter((p) => String(p?.id ?? '') !== pid);
  if (next.length === arr.length) return false;
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

  let rows;
  try {
    rows = key
      ? await fetchSpreadsheetValuesByGid(
          cfg.spreadsheetId,
          key,
          cfg.sheetGid,
          cfg.rangeA1 ?? 'A1:ZZ150',
          { label: 'お予定表' }
        )
      : await fetchSpreadsheetValuesViaCsvExport(cfg.spreadsheetId, cfg.sheetGid, 'お予定表');
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
  setFacilityScheduleImportYmd(linkKey, parsed.ymd);
  void import('./facilityPortalStoreSync.js').then((m) => m.flushFacilityPortalStoresCloud());
  return { applied: matched.length, unmatched, ymd: parsed.ymd };
}

/** @param {string} linkKey @param {string} residentId @param {string} ymd */
export function formatResidentPlansShort(linkKey, residentId, ymd, residentName = '') {
  const displayYmd = getFacilityScheduleDisplayYmd(linkKey, ymd);
  const plans = getResidentDailyPlans(linkKey, residentId, displayYmd, residentName);
  if (!plans.length) return '';
  return plans
    .map((p) => {
      const t = p.time ? `${p.time} ` : '';
      const title = cleanPlanTitleForDisplay(p.title, residentName);
      return `${t}${title}`.trim();
    })
    .filter(Boolean)
    .join(' / ');
}
