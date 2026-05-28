import * as XLSX from 'xlsx';

/** 全角英数 → 半角 */
function toHalfWidthAscii(s) {
  return String(s ?? '')
    .replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[ａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function normalizeCell(v) {
  return toHalfWidthAscii(String(v ?? '').trim()).replace(/\s+/g, '');
}

/** 日付列ヘッダ（1, 2, 3日, 4/1 など） */
function parseDayToken(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  let t = toHalfWidthAscii(raw).replace(/[()（）［］【】]/g, '');
  let m = t.match(/^(\d{1,2})(?:日)?$/);
  if (m) {
    const d = Number(m[1]);
    return d >= 1 && d <= 31 ? d : null;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const d = Number(m[2]);
    return d >= 1 && d <= 31 ? d : null;
  }
  return null;
}

/** 見出し・タグ（氏名として採用しない） */
const TITLE_OR_TAG_RE =
  /^(令和|平成|\d{4}[-\/年]\d{1,2}月?|\d{1,2}月分?|第\d{1,2}週|週間|シフト表?|勤務表|タグ\s*[:：]?|#\S|＃\S|【|】|^★|^☆|合計|小計|^計$|^人数$|日付|曜日|氏名|名前|スタッフ|職員|出勤|退勤|備考|ヘルプ|GH$|ｇｈ$|グループハウス|有料老人|デイサービス|訪問介護|訪問看護)/u;

const NAME_SKIP_RE = /^(氏名|名前|スタッフ|職員|合計|小計|計|人数|日付|曜日|勤務表)$/u;

/** A列「職種」に入りがちな値（氏名にしない） */
const JOB_TYPE_RE =
  /^(管理者|施設長|主任|副主任|リーダー|介護職|介護員|看護師|准看護師|理学療法士|作業療法士|言語聴覚士|ケアマネ|相談員|相談支援専門員|事務|調理|栄養士|サービス提供責任者|支援員|非常勤|嘱託|パート|アルバイト|staff)$/iu;

/** シート上のラベル・凡例（氏名にしない） */
const NOT_A_PERSON_NAME_RE =
  /^(フリー|在宅|介護デイ|デイ|夜勤|日勤|有休|公休|予定|実績|食数|シフト|勤務|所属|備考|要望|未定|欠員|ヘルプ|千音寺|名古屋|チーム|区域|エリア|合計|小計|計|人数|凡例|色分け|Aエリア|Bエリア|Cエリア|Dエリア)$/iu;

const SHORT_NIGHT_RE = /^(S|準|準夜|ｓ)$/iu;
const OFF_RE = /^(×|✕|公休|休|ｘ|X)$/iu;

/** 曜日行（1〜31の直下の 月火水木金土日） */
function isWeekdaySubheaderRow(row, dayCols) {
  if (dayCols.length < 5) return false;
  let wd = 0;
  for (const ci of dayCols) {
    const c = normalizeCell(String(row[ci] ?? ''));
    if (/^(月|火|水|木|金|土|日)(曜)?$/u.test(c)) wd += 1;
  }
  return wd >= dayCols.length * 0.55;
}

/**
 * 「氏名」列インデックス（ヘッダブロックの数行上から探索）
 * @param {string[][]} rows
 * @param {number} headerRi 暦日「1…31」が並ぶ行
 */
function findNameColumnIndex(rows, headerRi) {
  for (let look = 0; look <= 5; look++) {
    const ri = headerRi - look;
    if (ri < 0) break;
    const r = rows[ri] ?? [];
    for (let ci = 0; ci < r.length; ci++) {
      const t = String(r[ci] ?? '')
        .trim()
        .replace(/\s+/g, '');
      if (t === '氏名' || /^氏名[\s　\(（]*/u.test(String(r[ci] ?? '').trim())) return ci;
    }
  }
  const hdr = rows[headerRi] ?? [];
  for (let ci = 0; ci < Math.min(hdr.length, 12); ci++) {
    const raw = String(hdr[ci] ?? '').trim();
    if (/氏名/u.test(raw)) return ci;
  }
  return -1;
}

/**
 * 「職種」列（氏名は通常その右隣）
 * @param {string[][]} rows
 * @param {number} headerRi
 */
function findJobTypeColumnIndex(rows, headerRi) {
  for (let look = 0; look <= 5; look++) {
    const ri = headerRi - look;
    if (ri < 0) break;
    const r = rows[ri] ?? [];
    for (let ci = 0; ci < r.length; ci++) {
      const t = String(r[ci] ?? '')
        .trim()
        .replace(/\s+/g, '');
      if (t === '職種' || /^職種/u.test(String(r[ci] ?? '').trim())) return ci;
    }
  }
  return -1;
}

/**
 * 氏名を読む列（氏名見出し → 職種の右隣 → 暦日の1列左）
 * @param {string[][]} rows
 * @param {number} headerRi
 * @param {number} dayStartCol
 */
function resolveNameColumnIndex(rows, headerRi, dayStartCol) {
  const nameFromHeader = findNameColumnIndex(rows, headerRi);
  if (nameFromHeader >= 0) return nameFromHeader;
  const jobCol = findJobTypeColumnIndex(rows, headerRi);
  if (jobCol >= 0 && jobCol + 1 < dayStartCol) return jobCol + 1;
  return -1;
}

/**
 * 人名らしい文字列か（厳しめ。職種・凡例・記号を除外）
 * @param {string} s
 */
function isLikelyPersonName(s) {
  const raw = String(s ?? '').trim();
  if (!raw || raw.length < 2 || raw.length > 22) return false;
  if (NAME_SKIP_RE.test(raw)) return false;
  if (JOB_TYPE_RE.test(raw)) return false;
  if (TITLE_OR_TAG_RE.test(raw)) return false;
  if (NOT_A_PERSON_NAME_RE.test(raw)) return false;
  if (/[\d０-９@＊#＃:：\/\\…HTTPhttp〜～]/.test(raw)) return false;
  if (/[月火水木金土日]/u.test(raw)) return false;
  if (/^[A-Da-dＡ-Ｄ]$/u.test(raw)) return false;
  if (/^[ABCDabcd]{1,3}$/u.test(raw) && raw.length <= 3) return false;

  const hasKanji = /[\u4E00-\u9FFF]/.test(raw);
  const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(raw);
  if (!hasKanji && !hasKana) return false;
  if (!hasKanji && hasKana && raw.length <= 6 && /^[\u30A0-\u30FFーヴ・]+$/u.test(raw)) return false;
  if (/^[\u4E00-\u9FFF]$/u.test(raw)) return false;
  return true;
}

/**
 * 1セル分の勤務を夜・日・休・有給に振り分け（中川シフト表の「夜A 明」「有4」等）
 * @param {unknown} rawCell
 */
function tallyShiftCell(rawCell) {
  /** @type {{ night: number; shortN: number; day: number; off: number; paid: number }} */
  const z = { night: 0, shortN: 0, day: 0, off: 0, paid: 0 };
  const s0 = String(rawCell ?? '').trim();
  if (!s0) return z;
  const compact = toHalfWidthAscii(s0).replace(/\s+/g, '');

  if (/夜[ABab]|夜勤|^夜\d?$/u.test(compact)) {
    z.night += 1;
    return z;
  }
  if (SHORT_NIGHT_RE.test(compact)) {
    z.shortN += 1;
    return z;
  }
  if (/^有\d{0,2}$|^有休|^有給|^年休/u.test(compact)) {
    z.paid += 1;
    return z;
  }
  if (OFF_RE.test(compact) || /^公$/u.test(compact)) {
    z.off += 1;
    return z;
  }
  if (/^明[A-Za-z]?|^明け/u.test(compact) && compact.length <= 6) {
    return z;
  }
  if (/^日$|^日勤$|^早$|^遅$|^看日$|^E$/u.test(compact)) {
    z.day += 1;
    return z;
  }
  if (/^日[ABCDabcd][\/／]?/u.test(compact)) {
    z.day += 1;
    return z;
  }
  if (/^★?日/u.test(compact)) {
    z.day += 1;
    return z;
  }
  if (/^B[A-G]$/iu.test(compact)) {
    z.day += 1;
    return z;
  }
  if (/^\d+(\.\d+)?$/u.test(compact) || /^\d+[①②③④⑤⑥]$/u.test(compact)) {
    z.day += 1;
    return z;
  }
  if (/^PM\d/i.test(compact) || /^P\d/i.test(compact)) {
    z.day += 1;
    return z;
  }
  if (/^育$/u.test(compact)) {
    z.off += 1;
    return z;
  }
  return z;
}

/**
 * @param {unknown[]} row
 */
function collectDayColumnIndices(row) {
  const dayCols = [];
  for (let ci = 0; ci < row.length; ci++) {
    if (parseDayToken(row[ci]) != null) dayCols.push(ci);
  }
  return dayCols;
}

function rowLooksLikeDayHeader(row) {
  return collectDayColumnIndices(row).length >= 5;
}

/**
 * @param {string[][]} rows
 */
function findAllDayHeaderRowIndices(rows) {
  const max = Math.min(rows.length, 500);
  const out = [];
  for (let ri = 0; ri < max; ri++) {
    if (rowLooksLikeDayHeader(rows[ri] ?? [])) out.push(ri);
  }
  return out;
}

/**
 * @param {string} sheetName
 * @param {string[]} departments
 * @param {string} [facilityLinkKey]
 */
function inferDepartmentFromSheetName(sheetName, departments, facilityLinkKey = '') {
  const n = normalizeCell(sheetName);
  for (const d of departments) {
    const dn = normalizeCell(d);
    if (dn && n.includes(dn)) return d;
  }
  const lk = String(facilityLinkKey ?? '').trim();
  if (lk === '中川本館' && departments.includes('グループハウスくまさん')) {
    if (/中川|くまさん|ｸﾏ|GH|ｇｈ|グループ|シフト|勤務|R\d+\.\d+月|\d+月\s*\(/iu.test(sheetName)) {
      return 'グループハウスくまさん';
    }
  }
  return '';
}

/**
 * @param {string[][]} rows
 * @param {number} headerRi
 * @param {string} department
 */
function parseRowsForOneHeader(rows, headerRi, department) {
  const headerRow = rows[headerRi] ?? [];
  const dayCols = collectDayColumnIndices(headerRow);
  const dayStartCol = dayCols.length ? Math.min(...dayCols) : -1;
  if (dayStartCol < 0) return [];

  let firstDataRi = headerRi + 1;
  const rowAfter = rows[firstDataRi] ?? [];
  if (isWeekdaySubheaderRow(rowAfter, dayCols)) {
    firstDataRi += 1;
  }

  const nameCol = resolveNameColumnIndex(rows, headerRi, dayStartCol);
  if (nameCol < 0) return [];
  let carryName = '';

  /** @type {Array<{ staffName: string; department: string; mode: string; nightCount?: number; shortNightCount?: number; dayCount?: number; offCount?: number; paidLeaveCount?: number; note: string }>} */
  const out = [];

  for (let ri = firstDataRi; ri < rows.length; ri++) {
    if (ri !== firstDataRi && rowLooksLikeDayHeader(rows[ri] ?? [])) break;

    const row = rows[ri] ?? [];
    const a0 = String(row[0] ?? '').trim();
    if (/合計|小計|日勤|夜勤|～\d{1,2}:\d{2}/u.test(a0)) continue;

    const rawName = nameCol < row.length ? String(row[nameCol] ?? '').trim() : '';

    let nightCount = 0;
    let shortNightCount = 0;
    let dayCount = 0;
    let offCount = 0;
    let paidLeaveCount = 0;

    for (const ci of dayCols) {
      const t = tallyShiftCell(row[ci]);
      nightCount += t.night;
      shortNightCount += t.shortN;
      dayCount += t.day;
      offCount += t.off;
      paidLeaveCount += t.paid;
    }

    const anyShift =
      nightCount + shortNightCount + dayCount + offCount + paidLeaveCount > 0;
    if (!rawName && !anyShift) {
      carryName = '';
      continue;
    }

    if (rawName && !isLikelyPersonName(rawName)) continue;

    const staffName = rawName || carryName;
    if (!staffName || !isLikelyPersonName(staffName)) continue;

    if (rawName) carryName = rawName;

    const note = `勤務表取込(${department})`;
    if (nightCount > 0 || shortNightCount > 0) {
      out.push({
        staffName,
        department,
        mode: 'night_count',
        nightCount,
        shortNightCount,
        note,
      });
      continue;
    }
    if (dayCount > 0) {
      out.push({ staffName, department, mode: 'day_count', dayCount, note });
      continue;
    }
    if (paidLeaveCount > 0 && offCount === 0) {
      out.push({ staffName, department, mode: 'paid_leave_count', paidLeaveCount, note });
      continue;
    }
    if (offCount > 0 || paidLeaveCount > 0) {
      out.push({
        staffName,
        department,
        mode: 'off_count',
        offCount: Math.max(offCount, paidLeaveCount),
        note,
      });
    }
  }
  return out;
}

/**
 * @param {string[][]} rows
 * @param {string} department
 */
function parseSheet(rows, department) {
  const headerIndices = findAllDayHeaderRowIndices(rows);
  if (headerIndices.length === 0) {
    const legacy = findLegacySingleHeader(rows);
    if (legacy.rowIndex < 0) return [];
    return parseRowsForOneHeader(rows, legacy.rowIndex, department);
  }
  const merged = [];
  for (const hi of headerIndices) {
    merged.push(...parseRowsForOneHeader(rows, hi, department));
  }
  return merged;
}

function findLegacySingleHeader(rows) {
  const max = Math.min(rows.length, 120);
  for (let ri = 0; ri < max; ri++) {
    const r = rows[ri] ?? [];
    if (collectDayColumnIndices(r).length >= 5) return { rowIndex: ri, dayCols: collectDayColumnIndices(r) };
  }
  return { rowIndex: -1, dayCols: [] };
}

/**
 * @param {File} file
 * @param {{ departments: string[]; facilityLinkKey?: string }} opts
 */
export async function importShiftRowsFromFile(file, opts) {
  const departments = Array.isArray(opts?.departments) ? opts.departments : [];
  const facilityLinkKey = String(opts?.facilityLinkKey ?? '').trim();
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type: 'array' });
  /** @type {ReturnType<typeof parseSheet>} */
  const rows = [];
  /** @type {string[]} */
  const warnings = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    let dep = inferDepartmentFromSheetName(sheetName, departments, facilityLinkKey);
    if (!dep && facilityLinkKey === '中川本館' && departments.includes('グループハウスくまさん')) {
      dep = 'グループハウスくまさん';
    }
    if (!dep) continue;
    const parsed = parseSheet(aoa, dep);
    rows.push(...parsed);
  }

  if (rows.length === 0 && wb.SheetNames.length > 0 && departments.length > 0) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const fallback =
      facilityLinkKey === '中川本館' && departments.includes('グループハウスくまさん')
        ? 'グループハウスくまさん'
        : departments[0];
    const parsed = parseSheet(aoa, fallback);
    rows.push(...parsed);
    warnings.push('シート名から部署判定できなかったため、先頭シートを中川想定または先頭部署で読み込みました。');
  }

  return { rows, warnings };
}
