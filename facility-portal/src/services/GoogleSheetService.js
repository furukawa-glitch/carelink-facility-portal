/**
 * 利用者名簿: VITE_GOOGLE_SHEETS_API_KEY があるとき Sheets API、ないとき公開CSV（Viteプロキシ）
 */

import {
  CARELINK_FACILITIES,
  compactFacilityToken,
  facilityDefBySheetTitle,
  resolveFacilityDefForSheetTab,
} from '../config/carelinkFacilities.js';

export const CARELINK_RESIDENT_SPREADSHEET_ID =
  import.meta.env.VITE_GOOGLE_SHEET_ID ?? '1uIWPeOkr47OA1kB9iFzjBB0y9JIlt9d2Ud_p1dKliXI';

/** 部署別売上表など（名簿とは別ブック）。例: 令和8年4月請求 */
export const CARELINK_DEPARTMENT_SALES_SPREADSHEET_ID =
  import.meta.env.VITE_DEPARTMENT_SALES_SHEET_ID ?? '1upBbTUbLvaFZy8At-ZMgMI2qB8guvjMS';

export const CARELINK_DEFAULT_CSV_GID = import.meta.env.VITE_GOOGLE_SHEET_GID || '311004987';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** 名簿の短時間キャッシュ（同一画面の再マウント・連打で Sheets 読み取りを抑える） */
const RESIDENTS_CACHE_TTL_MS = 90_000;
/** キャッシュに含めるシート上段サマリーの版（フィールド追加時に上げる） */
const RESIDENT_SUMMARY_CACHE_VERSION = 3;
/** @type {{ residents: Record<string, unknown>[]; source: string; mode: string; cacheVersion?: number; medicalTargetSummaryBySheet?: Record<string, number>; averageCareLevelSummaryBySheet?: Record<string, number>; residentCountSummaryBySheet?: Record<string, number> } | null} */
let residentsFetchCache = null;
let residentsFetchCacheAt = 0;
/** @type {Promise<{ residents: Record<string, unknown>[]; source: string; mode: string }> | null} */
let residentsFetchInFlight = null;

/** タブ名（sheetTitle）→ シート上部セル由来の医療対象者人数（施設サマリー表示用） */
const MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY = new Map();
/** タブ名 → シート上部の平均介護度（小数可、施設サマリー表示用） */
const AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY = new Map();
/** タブ名 → シート上部の入居者数（ヘッダ人数表示用） */
const RESIDENT_COUNT_FROM_SHEET_SUMMARY = new Map();

/**
 * @param {Map<string, number>} map
 * @param {string} sheetTitle
 */
function getNumericSummaryFromMapBySheetTitle(map, sheetTitle) {
  const t = String(sheetTitle ?? '').trim();
  if (!t) return null;
  const direct = map.get(t);
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const want = compactFacilityToken(t);
  if (want) {
    for (const [k, v] of map) {
      if (compactFacilityToken(k) === want && typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

/** @param {unknown} raw */
function parseSheetSummaryIntegerCell(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .trim();
  if (!s || /^[-ー−―－\s　]+$/u.test(s)) return null;
  const compact = s.replace(/[,，\s]/g, '');
  const m = /^-?\d+/.exec(compact);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} raw */
function parseSheetSummaryFloatCell(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/．/g, '.')
    .trim();
  if (!s || /^[-ー−―－\s　]+$/u.test(s)) return null;
  const compact = s.replace(/[,，\s]/g, '');
  const m = /^-?\d+(?:\.\d+)?/.exec(compact);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 取得した rows の座標系（先頭行・左端列＝0）でシート集計セルを読み、Map を更新する
 * @param {string[][] | null | undefined} rows
 * @param {string} tabTitle
 * @param {{ medicalTargetCountFromSheetCell?: { row0Based: number; col0Based: number } }} [options]
 */
function applyMedicalTargetSheetSummaryFromOptions(rows, tabTitle, options) {
  const t = String(tabTitle ?? '').trim();
  if (!t) return;
  const sm = options?.medicalTargetCountFromSheetCell;
  let n = null;
  if (
    sm &&
    Number.isInteger(sm.row0Based) &&
    sm.row0Based >= 0 &&
    Number.isInteger(sm.col0Based) &&
    sm.col0Based >= 0
  ) {
    n = parseSheetSummaryIntegerCell(rows?.[sm.row0Based]?.[sm.col0Based]);
  }
  if (n == null) n = tryScanMedicalTargetSummaryUnderHeader(rows);
  if (n != null) MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY.set(t, n);
  else MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY.delete(t);
}

/** @param {string} sheetTitle 正式タブ名 */
export function getMedicalTargetCountFromSheetSummary(sheetTitle) {
  return getNumericSummaryFromMapBySheetTitle(MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY, sheetTitle);
}

export function clearMedicalTargetCountFromSheetSummary() {
  MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY.clear();
  AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY.clear();
  RESIDENT_COUNT_FROM_SHEET_SUMMARY.clear();
}

function snapshotFacilitySheetSummaryMaps() {
  return {
    medicalTargetSummaryBySheet: Object.fromEntries(MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY),
    averageCareLevelSummaryBySheet: Object.fromEntries(AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY),
    residentCountSummaryBySheet: Object.fromEntries(RESIDENT_COUNT_FROM_SHEET_SUMMARY),
  };
}

/**
 * @param {{ medicalTargetSummaryBySheet?: Record<string, number>; averageCareLevelSummaryBySheet?: Record<string, number>; residentCountSummaryBySheet?: Record<string, number> } | null | undefined} snap
 */
function applyObjectToNumberMap(/** @type {Map<string, number>} */ map, /** @type {Record<string, number> | null | undefined} */ obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k ?? '').trim();
    if (!key || typeof v !== 'number' || !Number.isFinite(v)) continue;
    map.set(key, v);
  }
}

/** キャッシュヒット時など、名簿取得と同じスナップショットで Map を復元する */
function restoreFacilitySheetSummaryMapsFromSnapshot(
  /** @type {{ medicalTargetSummaryBySheet?: Record<string, number>; averageCareLevelSummaryBySheet?: Record<string, number>; residentCountSummaryBySheet?: Record<string, number> } | null | undefined} */ snap
) {
  MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY.clear();
  AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY.clear();
  RESIDENT_COUNT_FROM_SHEET_SUMMARY.clear();
  if (!snap || typeof snap !== 'object') return;
  applyObjectToNumberMap(MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY, snap.medicalTargetSummaryBySheet);
  applyObjectToNumberMap(AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY, snap.averageCareLevelSummaryBySheet);
  applyObjectToNumberMap(RESIDENT_COUNT_FROM_SHEET_SUMMARY, snap.residentCountSummaryBySheet);
}

/**
 * シート先頭ブロックのみ: 「医療対象者」見出しの直下セルを人数として拾う（固定座標がずれたときの補助）
 * @param {string[][]} rows
 */
function tryScanMedicalTargetSummaryUnderHeader(rows) {
  if (!rows?.length) return null;
  const maxValueRow = Math.min(4, rows.length - 1);
  for (let vRow = 1; vRow <= maxValueRow; vRow++) {
    const headerRow = rows[vRow - 1] ?? [];
    const valueRow = rows[vRow] ?? [];
    for (let c = 0; c < headerRow.length; c++) {
      const h = String(headerRow[c] ?? '');
      if (!/医療対象者/u.test(h)) continue;
      if (/入居済み/u.test(h)) continue;
      const p = parseSheetSummaryIntegerCell(valueRow[c]);
      if (p != null) return p;
    }
  }
  return null;
}

/**
 * シート先頭のみ:「平均介護度」見出しの直下セルを数値として拾う
 * @param {string[][]} rows
 */
function tryScanAverageCareLevelUnderHeader(rows) {
  if (!rows?.length) return null;
  const maxValueRow = Math.min(4, rows.length - 1);
  for (let vRow = 1; vRow <= maxValueRow; vRow++) {
    const headerRow = rows[vRow - 1] ?? [];
    const valueRow = rows[vRow] ?? [];
    for (let c = 0; c < headerRow.length; c++) {
      const h = String(headerRow[c] ?? '');
      if (!/平均介護度/u.test(h)) continue;
      const p = parseSheetSummaryFloatCell(valueRow[c]);
      if (p != null) return p;
    }
  }
  return null;
}

/**
 * シート先頭行:「入居者数」ラベルの右隣などから人数を拾う
 * @param {string[][]} rows
 */
function tryScanResidentCountFromTop(rows) {
  const maxR = Math.min(2, rows.length - 1);
  for (let r = 0; r <= maxR; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (!/入居者数/u.test(String(row[c] ?? ''))) continue;
      for (let cc = c + 1; cc < Math.min(c + 8, row.length); cc++) {
        const p = parseSheetSummaryIntegerCell(row[cc]);
        if (p != null) return p;
      }
    }
  }
  return null;
}

/**
 * @param {string[][] | null | undefined} rows
 * @param {string} tabTitle
 * @param {{ residentCountFromSheetCell?: { row0Based: number; col0Based: number } }} [options]
 */
function applyResidentCountSheetSummaryFromOptions(rows, tabTitle, options) {
  const t = String(tabTitle ?? '').trim();
  if (!t) return;
  const sm = options?.residentCountFromSheetCell;
  let n = null;
  if (
    sm &&
    Number.isInteger(sm.row0Based) &&
    sm.row0Based >= 0 &&
    Number.isInteger(sm.col0Based) &&
    sm.col0Based >= 0
  ) {
    n = parseSheetSummaryIntegerCell(rows?.[sm.row0Based]?.[sm.col0Based]);
  }
  if (n == null) n = tryScanResidentCountFromTop(rows);
  if (n != null) RESIDENT_COUNT_FROM_SHEET_SUMMARY.set(t, n);
  else RESIDENT_COUNT_FROM_SHEET_SUMMARY.delete(t);
}

/**
 * @param {string[][] | null | undefined} rows
 * @param {string} tabTitle
 * @param {{ averageCareLevelFromSheetCell?: { row0Based: number; col0Based: number } }} [options]
 */
function applyAverageCareLevelSheetSummaryFromOptions(rows, tabTitle, options) {
  const t = String(tabTitle ?? '').trim();
  if (!t) return;
  const sm = options?.averageCareLevelFromSheetCell;
  let n = null;
  if (
    sm &&
    Number.isInteger(sm.row0Based) &&
    sm.row0Based >= 0 &&
    Number.isInteger(sm.col0Based) &&
    sm.col0Based >= 0
  ) {
    n = parseSheetSummaryFloatCell(rows?.[sm.row0Based]?.[sm.col0Based]);
  }
  if (n == null) n = tryScanAverageCareLevelUnderHeader(rows);
  if (n != null) AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY.set(t, n);
  else AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY.delete(t);
}

/** @param {string} sheetTitle 正式タブ名 */
export function getAverageCareLevelFromSheetSummary(sheetTitle) {
  return getNumericSummaryFromMapBySheetTitle(AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY, sheetTitle);
}

/** @param {string} sheetTitle 正式タブ名 */
export function getResidentCountFromSheetSummary(sheetTitle) {
  return getNumericSummaryFromMapBySheetTitle(RESIDENT_COUNT_FROM_SHEET_SUMMARY, sheetTitle);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {number} status @param {string} msg */
function isSheetsQuotaError(status, msg) {
  const m = String(msg ?? '');
  return (
    status === 429 ||
    /quota exceeded|rate limit|resource_exhausted|userRateLimitExceeded/i.test(m)
  );
}

/**
 * Sheets API の GET JSON（429・クォータ時は指数バックオフで再試行）
 * @param {string} url
 * @param {number} [attempt]
 */
async function sheetsGetJsonWithRetry(url, attempt = 0) {
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  const msg = data.error?.message ?? res.statusText ?? '';
  if (!res.ok && isSheetsQuotaError(res.status, msg) && attempt < 6) {
    const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
    const base = ra > 0 ? ra * 1000 : Math.min(45_000, 800 * 2 ** attempt);
    await sleep(base + Math.random() * 400);
    return sheetsGetJsonWithRetry(url, attempt + 1);
  }
  return { res, data };
}

/**
 * タブ名とシート内範囲から A1 記法（API 用）
 * @param {string} sheetTitle
 * @param {string | null | undefined} rangeA1WithinSheet
 */
function sheetRangeA1(sheetTitle, rangeA1WithinSheet) {
  const safe = `'${String(sheetTitle).replace(/'/g, "''")}'`;
  const inner = (rangeA1WithinSheet && String(rangeA1WithinSheet).trim()) || 'A:ZZ';
  return `${safe}!${inner}`;
}

/**
 * values:batchGet で複数範囲をまとめて取得（読み取り回数を 1 回／チャンクに圧縮）
 * @param {string} spreadsheetId
 * @param {string} apiKey
 * @param {string[]} rangesA1
 * @returns {Promise<(string[][] | undefined)[]>} リクエストと同じ順序
 */
async function fetchSpreadsheetValuesBatch(spreadsheetId, apiKey, rangesA1) {
  if (!rangesA1.length) return [];
  const sid = encodeURIComponent(spreadsheetId);
  const maxPerReq = 8;
  const out = [];
  for (let i = 0; i < rangesA1.length; i += maxPerReq) {
    const chunk = rangesA1.slice(i, i + maxPerReq);
    const params = new URLSearchParams();
    params.set('key', apiKey);
    for (const r of chunk) {
      params.append('ranges', r);
    }
    const url = `${SHEETS_API}/${sid}/values:batchGet?${params.toString()}`;
    const { res, data } = await sheetsGetJsonWithRetry(url);
    if (!res.ok || data.error) {
      throw new Error(
        data.error?.message ?? `名簿の一括取得に失敗しました（HTTP ${res.status}）`
      );
    }
    const vrs = data.valueRanges ?? [];
    for (let j = 0; j < chunk.length; j++) {
      out.push(vrs[j]?.values);
    }
  }
  return out;
}

/** @param {string} s */
function normHeader(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s/g, '')
    .toLowerCase();
}

/** @param {string[]} headers @param {string[]} candidates */
function colIndex(headers, candidates) {
  const n = headers.map(normHeader);
  for (const c of candidates) {
    const key = normHeader(c);
    const i = n.findIndex((h) => h === key || h.includes(key) || key.includes(h));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 氏名列。フリガナ列（氏名カナ・フリガナ）を誤採用しないため専用判定
 * @param {string[]} headers
 */
function colIndexResidentName(headers) {
  const n = headers.map(normHeader);
  const candidates = ['氏名', '名前', '利用者名', '入居者名', 'name', 'フルネーム'];
  for (const c of candidates) {
    const key = normHeader(c);
    const i = n.findIndex((h) => {
      if (!h) return false;
      if (/フリガナ|ふりがな|氏名カナ|名前カナ|ｶﾅ|kana/.test(h)) return false;
      return h === key || h.includes(key) || key.includes(h);
    });
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 「医療保険の種類」列。ヘッダ「医療保険対象」が「医療保険」に部分一致して誤採用されないよう除外する
 * @param {string[]} headers
 */
function colIndexInsuranceKind(headers) {
  const n = headers.map(normHeader);
  const candidates = [
    '医療保険の種類',
    '保険種別',
    '保険の種類',
    '被保険者区分',
    '国保社保',
    '保険区分',
    '健康保険',
    '医療保険',
  ];
  for (const c of candidates) {
    const key = normHeader(c);
    const i = n.findIndex((h) => {
      if (!h) return false;
      if (/医療保険対象|医療対象者|入居済み医療対象|入居済医療対象/.test(h)) return false;
      return h === key || h.includes(key) || key.includes(h);
    });
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 「医療対象」列ではなく保険の種類・区分だけの列（ここに「医療」とあっても入居済み医療対象ではない）
 */
function headerLooksLikeInsuranceCategoryOnly(norm) {
  const h = String(norm ?? '').trim();
  if (!h) return false;
  if (/医療対象|別表[７7]|入居済.*医療|気切|気管/u.test(h)) return false;
  return /保険の種類|保険種別|保険種類|被保険者区分|国保社保|健康保険の種類|協会けんぽ|後期高齢/u.test(h);
}

/**
 * 医療対象（別表7・気切等）のフラグ列。名簿によって「医療保険対象」「医療対象者」など表記ゆれ
 * colIndex の key.includes(h) だとヘッダ「医療」だけが「医療対象」に誤一致するため、長い候補のみ部分一致
 * @param {string[]} headers
 */
function colIndexMedicalInsuranceTarget(headers) {
  const n = headers.map(normHeader);
  const candidates = [
    '入居済み医療対象',
    '入居済医療対象',
    '入居済み医療',
    '入居済医療',
    '医療保険対象者',
    '医療保険対象',
    '医療対象者',
    '医療対象（別表）',
    '医療対象（別表７）',
    '医療対象（別表7）',
    '医療対象',
    '医療（別表７）',
    '医療（別表7）',
    '別表7対象',
    '別表７対象',
  ];
  for (const c of candidates) {
    const key = normHeader(c);
    const i = n.findIndex((h) => {
      if (!h) return false;
      if (headerLooksLikeInsuranceCategoryOnly(h)) return false;
      if (h === key) return true;
      return h.length >= key.length && h.includes(key);
    });
    if (i >= 0) return i;
  }
  // 表記ゆれ（「医療対象者（別表７、気切）」等）は上で拾える。拾えない列を最後に推定
  for (let j = 0; j < n.length; j++) {
    const h = n[j];
    if (!h || h.length < 4) continue;
    if (headerLooksLikeInsuranceCategoryOnly(h)) continue;
    if (/医療保険の種類|保険種別|保険の種類|国保社保|健康保険|協会けんぽ|後期高齢/u.test(h)) continue;
    if (/医療対象|医療保険対象|別表[７7]|気切|気管|入居済.*医療|医療.*別表/u.test(h)) return j;
  }
  return -1;
}

/**
 * 正規化済みセルが「要介護３」などの認定値そのものか（列見出しではない）
 * findHeaderRow・2行ヘッダ判定で誤検出しないようにする
 */
function looksLikeCareLevelValueOnly(norm) {
  const s = String(norm ?? '').trim();
  if (!s) return false;
  if (/^要介護(?:度|認定)?[1-5１-５]$/.test(s)) return true;
  if (/^要支援(?:度)?[12１２]$/.test(s)) return true;
  if (/^介護度[：:.．]?[1-5１-５]$/.test(s)) return true;
  if (/^ケアレベル[：:.．]?[1-5１-５]$/.test(s)) return true;
  return false;
}

/** 正規化済みヘッダが介護度列っぽいか（列名が施設・シートでバラバラなときのフォールバック） */
function looksLikeCareLevelHeader(norm) {
  const s = String(norm ?? '').trim();
  if (!s || s.length > 56) return false;
  if (looksLikeCareLevelValueOnly(s)) return false;
  if (/^(氏名|名前|利用者名|入居者名|フリガナ|カナ|生年月日|年齢|性別|誕生日)$/.test(s)) return false;
  if (/^(部屋|居室|号室|room|部屋番号|居室番号)$/.test(s)) return false;
  if (/^(備考|メモ|コメント|特記|コンディション)$/.test(s)) return false;
  if (/^(ステータス|入居状況|状況|入所状況|status)$/.test(s)) return false;
  if (/(医療保険|保険種別|保険の種類|国保|社保|協会|組合)/.test(s) && !/(介護|介保|要介護|ケア)/.test(s)) return false;
  if (/(食事|経管|体重|身長|血圧|排便|排泄|バイタル)/.test(s) && !/(介護|要介護|ケア|認定)/.test(s)) return false;
  if (/(施設|事業所|ホーム|拠点)/.test(s) && !/介護/.test(s)) return false;
  if (/^(主疾患|主たる疾患|疾病|診断名)$/.test(s)) return false;
  // 「介護保険」単独列（医療保険の種類など）を介護度と取り違えない
  if (/介護保険/.test(s) && !/(要介護|度|区分|状態|認定|ケアレベル|等級|介護度)/.test(s)) return false;

  if (/要介護|要支援|介護度|介護区分|介護認定|介護状態|認定介護|認定.*度|ケアレベル|ｹｱ|carelevel|介護等級/.test(s)) return true;
  if (/^介護$/.test(s)) return true;
  if (/介護/.test(s) && /(度|区分|状態|レベル|認定|等級|等)/.test(s)) return true;
  if (/^認定区分$|^介護度等$|^介護認定$/.test(s)) return true;
  // 北名古屋ほか帳票でよいある表記
  if (/サービス種別|サービス区分|介護サービス|介護保険サービス|認定情報|利用者区分|介護保険被保険者|被保険者区分/.test(s)) return true;
  return false;
}

/**
 * 介護度列: まず既知の列名候補、ダメならヘッダ文字列のパターンマッチ
 * @param {string[]} headers
 */
function colIndexCareLevel(headers) {
  const primary = colIndex(headers, [
    '要介護度',
    '認定介護度',
    '介護保険の要介護度',
    '介護保険要介護度',
    '要介護状態',
    '認定状況',
    '介護認定状況',
    '保険の要介護度',
    '介護度',
    '介護区分',
    '介護認定',
    '認定区分',
    '介護度区分',
    '要介護度区分',
    '要介護度等',
    'サービス種別',
    'サービス区分',
    '介護サービス',
    '介護保険サービス',
    '認定情報',
    '利用者区分',
    'ケアレベル',
    'ｹｱﾚﾍﾞﾙ',
    'ｹｱﾚﾍﾞ',
    '要介護',
    'carelevel',
    'care level',
  ]);
  if (primary >= 0) return primary;
  const n = headers.map((h) => normHeader(String(h ?? '')));
  for (let i = 0; i < n.length; i++) {
    if (looksLikeCareLevelHeader(n[i])) return i;
  }
  return -1;
}

/** 2行目が利用者データと誤結合しないよう、データっぽいセルはサブヘッダ補完に使わない */
function cellLooksLikeCareLevelDataValue(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  const s = t.replace(/\s+/g, '');
  if (/様$/.test(t)) return true;
  if (/^要介護[1-5１-５](?:度)?$/u.test(s)) return true;
  if (/^要支援[12１２](?:度)?$/u.test(s)) return true;
  if (/^介護度[：:.．]?[1-5１-５]$/u.test(s)) return true;
  if (/^\d{2,4}(?:号|室)?$/.test(s)) return true;
  return false;
}

/**
 * 1行目の空セルを、すぐ下の行から列見出しとして補完（介護度だけ次行にある帳票向け）
 */
function isPlausibleSubheaderFill(rawB) {
  const b = String(rawB ?? '').trim();
  if (!b || b.length > 48) return false;
  if (cellLooksLikeCareLevelDataValue(b)) return false;
  const nb = normHeader(b);
  if (looksLikeCareLevelHeader(nb)) return true;
  // 2行目だけに「対象者（別表７、気切）」等がある医療対象列（上段が「医療」など）
  if (/医療対象|医療保険対象|別表|気切|気管|入居済/u.test(nb)) return true;
  return /^(氏名|名前|利用者名|入居者名|フリガナ|カナ|部屋|居室|号室|状況|備考|メモ|性別|年齢|生年月日|対象|有無|フラグ)$/u.test(
    nb
  );
}

/** 1段目が大分類セルのときは2段目ヘッダを優先できるようにする */
function looksLikeHeaderGroupLabel(rawA) {
  const a = String(rawA ?? '').trim();
  if (!a) return false;
  const n = normHeader(a);
  if (!n) return false;
  if (looksLikeCareLevelHeader(n)) return false;
  return /^(情報|項目|分類|区分|データ|一覧|名簿|利用者情報|基本情報|介護保険|保険情報|状態|医療|入居)$/u.test(n);
}

/**
 * @param {string[]} row1
 * @param {string[]} row2
 */
function mergeSubheaderRow(row1, row2) {
  const maxLen = Math.max(row1.length, row2.length);
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    const a = String(row1[i] ?? '').trim();
    const b = String(row2[i] ?? '').trim();
    const bPlausible = b && isPlausibleSubheaderFill(b);
    if (!a && bPlausible) out[i] = b;
    else if (a && bPlausible && looksLikeHeaderGroupLabel(a)) out[i] = `${a}${b}`;
    else if (a) out[i] = a;
    else out[i] = '';
  }
  return out;
}

/**
 * 1段目のヘッダだけだと介護度列が欠けるとき、2行目と縦結合して列定義を完成させる（北名古屋・愛西の名簿で多い）
 * @param {string[][]} rows
 * @param {number} headerIdx findHeaderRowIndex の結果
 */
function resolveMergedHeaders(rows, headerIdx) {
  const row1 = (rows[headerIdx] ?? []).map((c) => String(c ?? '').trim());
  if (!rows?.length || headerIdx < 0) return { mergedHeaders: row1, dataStartOffset: 1 };
  if (headerIdx + 1 >= rows.length) return { mergedHeaders: row1, dataStartOffset: 1 };
  const row2 = (rows[headerIdx + 1] ?? []).map((c) => String(c ?? '').trim());
  if (row2.every((c) => !c)) return { mergedHeaders: row1, dataStartOffset: 1 };

  const merged = mergeSubheaderRow(row1, row2);
  const care1 = colIndexCareLevel(row1) >= 0;
  const careM = colIndexCareLevel(merged) >= 0;
  const med1 = colIndexMedicalInsuranceTarget(row1) >= 0;
  const medM = colIndexMedicalInsuranceTarget(merged) >= 0;

  if (care1 && !careM) {
    return { mergedHeaders: row1, dataStartOffset: 1 };
  }
  if (!care1 && careM) {
    return { mergedHeaders: merged, dataStartOffset: 2 };
  }
  if (care1 && careM && medM && !med1) {
    return { mergedHeaders: merged, dataStartOffset: 2 };
  }
  // 医療対象列だけが2行結合で初めて認識できる帳票（上段「医療」＋下段「対象者（別表７）」等）
  if (!med1 && medM) {
    return { mergedHeaders: merged, dataStartOffset: 2 };
  }
  return { mergedHeaders: row1, dataStartOffset: 1 };
}

/**
 * 1行目が表題のみ・実ヘッダが2行目以降のシートがある（愛西は1行目がヘッダで問題なし）
 * 北名古屋等: タイトル行だけに「氏名」が紛れ込む誤検出を減らすため、介護度・部屋・状況のいずれかと同じ行を優先
 * @param {string[][]} rows
 * @returns {number} ヘッダ行の 0 始まりインデックス
 */
function findHeaderRowIndex(rows) {
  if (!rows?.length) return 0;
  const maxScan = Math.min(40, rows.length);
  const headerAnchor = (cells) => {
    const n = cells.map((c) => normHeader(String(c ?? '')));
    const hasCare = n.some((cell) => cell && looksLikeCareLevelHeader(cell));
    const hasRoom = n.some((cell) =>
      /^(部屋|居室|号室|room|部屋番号|居室番号|状況|ステータス|入居状況|status)$/.test(cell)
    );
    const hasIns = n.some((cell) =>
      /^(医療保険|保険種別|保険の種類|国保社保|健康保険)$/.test(cell) ||
      /医療保険対象|医療対象者|入居済み医療対象/.test(cell)
    );
    return hasCare || hasRoom || hasIns;
  };
  for (let h = 0; h < maxScan; h++) {
    const cells = (rows[h] ?? []).map((c) => String(c ?? '').trim());
    if (cells.every((c) => !c)) continue;
    if (colIndexResidentName(cells) >= 0 && headerAnchor(cells)) return h;
  }
  for (let h = 0; h < maxScan; h++) {
    const cells = (rows[h] ?? []).map((c) => String(c ?? '').trim());
    if (cells.every((c) => !c)) continue;
    if (colIndexResidentName(cells) >= 0) return h;
  }
  return 0;
}

/** 請求・集計用: 食事回数セル（数値または「28回」） */
function parseMealCountCell(v) {
  if (v == null) return 0;
  let s = String(v).replace(/,/g, '').trim();
  if (!s) return 0;
  s = s.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10));
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** 名簿の経管栄養列（管理料算定の対象フラグ） */
function parseEnteralFlagCell(v) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (/^[-ー−―－\s　]+$/u.test(s)) return false;
  if (/無し?|なし|いいえ|不要|非該当|×|✕/u.test(s)) return false;
  if (/経管|管栄|ＮＧＴ|\bNGT\b|胃ろう|胃瘻|実施|あり|要|○|〇|◯|✓|✔|はい(?![ぁ-ん])/u.test(s)) return true;
  if (/^1$/.test(s)) return true;
  return false;
}

/**
 * 生年月日セル（YYYY/MM/DD, YYYY-MM-DD, 和暦はそのまま）を整形
 * @param {unknown} v
 */
function normalizeBirthDateCell(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  const t = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
  if (/^\d{4}[\/\-\.年]\d{1,2}[\/\-\.月]\d{1,2}/u.test(t)) {
    const m = t.match(/(\d{4})[\/\-\.年](\d{1,2})[\/\-\.月](\d{1,2})/u);
    if (m) return `${m[1]}/${String(parseInt(m[2], 10)).padStart(2, '0')}/${String(parseInt(m[3], 10)).padStart(2, '0')}`;
  }
  return raw;
}

/**
 * 生年月日から満年齢（推定）を計算
 * @param {string} birthDateLabel
 * @returns {number | null}
 */
function ageFromBirthDateLabel(birthDateLabel) {
  const s = String(birthDateLabel ?? '').trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const now = new Date();
  let age = now.getFullYear() - y;
  const mdNow = (now.getMonth() + 1) * 100 + now.getDate();
  const mdBirth = mo * 100 + d;
  if (mdNow < mdBirth) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

/**
 * 1セルに混在する介護度表記を抽出（名簿の「主疾患＋要介護」混在列向け）
 * @param {string} text
 * @returns {{ careLevel: string; remainder: string }}
 */
export function parseCareLevelFromText(text) {
  const s = String(text ?? '').trim();
  if (!s) return { careLevel: '', remainder: '' };
  const re =
    /(要介護(?:度|認定)?[：:\s]*[０-９0-9]{1,2}|要介護[０-９0-9]{1,2}|要支援(?:度)?[：:\s]*[０-９0-9]{1,2}|要支援[０-９0-9]{1,2}|介護(?:度|認定)?[：:\s]*[０-９0-9]{1,2}|ケアレベル[：:\s]*[０-９0-9]{1,2}|認知症(?:医療)?[：:\s]*[０-９0-9]{1,2}|自立|未定|非該当|事業対象者)/u;
  const m = s.match(re);
  if (!m || m.index === undefined) return { careLevel: '', remainder: s };
  const careLevel = String(m[1]).replace(/\s+/g, '');
  let remainder = (s.slice(0, m.index) + s.slice(m.index + m[0].length))
    .replace(/^[、，,\s／\/]+|[、，,\s／\/]+$/gu, '')
    .trim();
  if (!remainder) remainder = '—';
  return { careLevel, remainder };
}

const ZEN2HAN_NUM = (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0);

/**
 * 名簿の介護度を「要介護1」～「要介護5」「要支援1」「要支援2」に揃える。
 * セルが 1～5 のみ（半角・全角）のときは要介護とみなす。2桁以上の数字のみは誤列の可能性があるため空にする。
 * @param {string} raw
 */
/** 要介護Ⅳ 等のローマ数字表記 */
const CARE_ROMAN_TO_DIGIT = {
  Ⅰ: '1',
  Ⅱ: '2',
  Ⅲ: '3',
  Ⅳ: '4',
  Ⅴ: '5',
  ⅰ: '1',
  ⅱ: '2',
  ⅲ: '3',
  ⅳ: '4',
  ⅴ: '5',
};

export function normalizeCareLevelLabel(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';

  const toHalf = (str) => str.replace(/[０-９]/g, (c) => ZEN2HAN_NUM(c));
  let compact = toHalf(t).replace(/\s+/g, '');
  compact = compact.replace(/[ⅠⅡⅢⅣⅤⅰⅱⅲⅳⅴ]/g, (ch) => CARE_ROMAN_TO_DIGIT[ch] ?? ch);

  let m = compact.match(/^要支援(?:度|認定)?[：:]?([12])$/);
  if (m) return `要支援${m[1]}`;
  m = compact.match(/^要介護(?:度|認定)?[：:]?([1-5])$/);
  if (m) return `要介護${m[1]}`;
  m = compact.match(/^介護度[：:]?([1-5])$/);
  if (m) return `要介護${m[1]}`;
  m = compact.match(/^介護[：:]?([1-5])$/);
  if (m) return `要介護${m[1]}`;
  m = compact.match(/^ケアレベル[：:]?([1-5])$/);
  if (m) return `要介護${m[1]}`;

  if (/^[1-5]$/.test(compact)) return `要介護${compact}`;
  if (/^\d+$/.test(compact)) return '';

  if (/自立|未定|非該当|事業対象者|医療対象者|経過的|区分支給限界/u.test(t)) {
    return t.replace(/\s+/g, ' ').trim();
  }

  const th = toHalf(t).replace(/[ⅠⅡⅢⅣⅤⅰⅱⅲⅳⅴ]/g, (ch) => CARE_ROMAN_TO_DIGIT[ch] ?? ch);
  m = th.match(/要介護(?:度|認定)?[：:\s]*([1-5])/);
  if (m) return `要介護${m[1]}`;
  m = th.match(/要支援(?:度)?[：:\s]*([12])/);
  if (m) return `要支援${m[1]}`;
  m = th.match(/介護度[：:\s]*([1-5])/);
  if (m) return `要介護${m[1]}`;
  m = th.match(/ケアレベル[：:\s]*([1-5])/);
  if (m) return `要介護${m[1]}`;

  return t.replace(/\s+/g, ' ').trim();
}

/**
 * 一覧バッジ用。要介護1～5 は数字を主表示にする。
 * @param {string} label normalizeCareLevelLabel 済み想定
 */
export function formatCareLevelForDisplay(label) {
  const n = normalizeCareLevelLabel(String(label ?? ''));
  if (!n) return '';
  const c = n.replace(/\s/g, '');
  const mj = /^要介護([1-5])$/.exec(c);
  if (mj) return mj[1];
  const ys = /^要支援([12])$/.exec(c);
  if (ys) return `要支援 ${ys[1]}`;
  return n;
}

/**
 * 平均介護度（要介護1〜5 の数値平均）。要支援・自立などは含めない
 * @param {string} normalizedCareLevelLabel normalizeCareLevelLabel 済み想定
 * @returns {number | null}
 */
export function careLevelScoreForAverageCareLevel(normalizedCareLevelLabel) {
  const c = String(normalizedCareLevelLabel ?? '')
    .replace(/\s/g, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
  const mj = /^要介護([1-5])$/.exec(c);
  if (mj) return Number(mj[1]);
  return null;
}

/**
 * 名簿の「医療保険対象」「医療対象者」列（入居済み医療対象の集計用）
 * @param {unknown} raw
 */
export function parseMedicalTargetCell(raw) {
  if (raw === 1 || raw === true) return true;
  if (raw === 0 || raw === false) return false;
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (/^[-ー−―－\s　]+$/u.test(s)) return false;
  const sl = s.toLowerCase();
  if (sl === 'true' || sl === 'yes') return true;
  if (sl === 'false' || sl === 'no') return false;
  if (/非対象|対象外|非医療|不要|無し?|なし|×|✕|いいえ$/u.test(s)) return false;
  if (/非該当|不該当/u.test(s)) return false;
  const compact = s.replace(/\s+/g, '');
  // 「対象」「要」「有」「済」単独は他用途と誤爆。文字「1」だけも介護度等で紛れうるため、数値 1 は冒頭の raw===1 のみ true
  if (/^(○|〇|◯|ⓞ|⊚|●|レ|あり|はい|yes)$/u.test(s)) return true;
  if (/^(✓|✔|☑)$/u.test(s)) return true;
  if (/^(ok|OK|ＯＫ)$/u.test(compact)) return true;
  if (/^入居済(み)?$/u.test(compact)) return true;
  // 「医療」のみは保険区分列の「医療」と同一表記になり得るため単独では true にしない（別表7・気切等は下で判定）
  // 別表7・気切等は単独でも可。「該当」「対象者」単独は他列（リスク評価等）と誤爆しやすいので含めない
  if (/^(別表|別表7|別表７|気切|気管)$/u.test(compact)) return true;
  // 文中の「該当」だけでは拾わない（医療対象・別表・処置キーワードを優先）
  if (/医療対象|別表\s*[７7]|気切|気管|人工呼吸|痰吸引/u.test(s)) return true;
  return false;
}

/**
 * 医療保険カウント用に名簿の保険列を粗く正規化
 * @param {string} raw
 */
export function normalizeInsuranceCategory(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^[ー−―－\-–—\s　]+$/u.test(s)) return '未設定';
  // 帳票・名簿で「特指示」が立つ場合はカウントを分離（他区分と併記されていても拾う）
  if (/医療保険特指示|医療特指示|(?:医療)?特別指示|特指示/u.test(s)) return '医療保険特指示';
  // 名簿に「医療」「医療保険」だけとある場合（その他に落とさない）
  if (/^(医療|医療保険|医療保険のみ|医療のみ)$/u.test(s.replace(/\s+/g, ''))) return '医療';
  if (/後期|高齢者医療|７５|75(?!\d)/u.test(s)) return '後期高齢';
  if (/国民健康保険|^国保|市区町村国保/u.test(s)) return '国保';
  if (/協会けんぽ|協会健保|日雇|被用者保険/u.test(s)) return '協会けんぽ';
  if (/組合健保|健康保険組合/u.test(s)) return '組合健保';
  if (/労災|福祉医療|生活保護|自立支援医療|精神通院|公費/u.test(s)) return '公費・その他';
  // 上記に当たらないが「医療」が含まれる名簿表記（医療保険（一般）等）を「医療」に寄せる
  if (/医療/u.test(s) && !/後期|高齢者医療|特指示|特別指示|介護保険|要介護|要支援/u.test(s)) return '医療';
  return 'その他';
}

/**
 * @param {unknown} statusRaw
 */
/**
 * 名簿の1列目／氏名列に紛れ込む見出し・別表タイトル（千音寺・中村シート等）
 * @param {string} nameRaw
 * @param {string} [sheetTitleHint] 読込元タブ名（★北名古屋：入居者 等）。北名古屋シート専用の除外に使用
 */
export function shouldSkipResidentRowName(nameRaw, sheetTitleHint = '') {
  const raw = String(nameRaw ?? '').trim();
  if (!raw) return true;
  const noSama = raw.replace(/様\s*$/u, '').trim();
  const n = normHeader(noSama);
  const tab = String(sheetTitleHint ?? '').trim();
  const kitanagoyaSheet = tab.includes('北名古屋');

  const exact = new Set([
    '氏名',
    '名前',
    '利用者名',
    '入居者名',
    'フルネーム',
    'name',
    '食事チェック',
    '食事チェック表',
    '食事清算',
    '体重表',
    '体重表中村',
    'アメニティ',
    'アメニティー',
  ]);
  if (exact.has(noSama) || exact.has(n)) return true;

  if (/^(氏名|名前|利用者名|入居者名)(様)?$/i.test(noSama)) return true;

  if (/食事チェック表|チェック表|食事表|食事清算|清算表/i.test(noSama)) return true;
  if (/体重表/i.test(noSama)) return true;
  if (/^アメニティ/i.test(noSama)) return true;

  // 北名古屋シート: 別表タイトルが「〇〇様」で名簿列に混入する例
  if (kitanagoyaSheet) {
    const compact = noSama.replace(/[\s\u3000]+/g, '');
    if (/^(食事チェック|体重表|氏名)$/.test(compact)) return true;
  }

  // 愛西ほか: 氏名欄に入ったサービス区分・帳票用の擬似行（利用者名ではない）
  if (/プラン変更/u.test(noSama)) return true;
  if (/訪問入浴/u.test(noSama) && /外部/u.test(noSama)) return true;

  return false;
}

/**
 * 事故報告・ヒヤリハット等の氏名プルダウン用（名簿に残った見出し・別表タイトルを再除外）
 * @param {Record<string, unknown>[]} residents
 */
export function filterResidentsForNamePicker(residents) {
  if (!Array.isArray(residents)) return [];
  return residents.filter((r) => {
    const name = String(r?.name ?? '').trim();
    if (!name) return false;
    const sheetHint = String(r?.sourceSheetTitle ?? r?.facility ?? '').trim();
    if (shouldSkipResidentRowName(name, sheetHint)) return false;
    const base = name.replace(/様\s*$/u, '').trim();
    if (!base) return false;
    if (/^\d{4}[\/\.\-年]\d{1,2}/u.test(base)) return false;
    if (/^[\d０-９\s\-ー−／\.]+$/u.test(base)) return false;
    if (
      /(表|一覧|台帳|スケジュール|カレンダー|シフト|担当表|連絡表|記録表|管理表|集計|清算|チェック|プラン|プラン表)$/u.test(
        base
      )
    ) {
      return false;
    }
    if (/^(合計|小計|備考|注意|参照|なし|同上|フロア|棟|区画)$/u.test(base)) return false;
    return true;
  });
}

export function isActiveResident(statusRaw) {
  const s = String(statusRaw ?? '').trim();
  // 空欄・ダッシュのみは「除外理由なし」として表示（名簿に列があるだけで全員落ちるのを防ぐ）
  if (!s || /^[ー−―－\-–—\s]+$/u.test(s)) return true;
  if (/退(居|去|所)|死亡|転居|見学|未入居|入居予定|申込|キャンセル|退院|外泊のみ/i.test(s)) return false;
  if (/入居中|入所中|利用中|在籍|現入居|入居\(中\)/i.test(s)) return true;
  if (/^入居$/i.test(s)) return true;
  // 上記「明確な非入居」以外は表示（表記ゆれで0件にならないようにする）
  return true;
}

/**
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  row.push(cur);
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
  return rows;
}

/**
 * @param {string[][]} rows
 * @param {string} defaultFacilityName タブ名（複数シート時）／単一シート時は ''
 * @param {{
 *   singleColumnNames?: boolean;
 *   nameColumn0Based?: number;
 *   medicalInsuranceTargetColumn0Based?: number;
 *   medicalInsuranceTargetNonEmptyMeansTrue?: boolean;
 *   medicalTargetCountFromSheetCell?: { row0Based: number; col0Based: number };
 *   averageCareLevelFromSheetCell?: { row0Based: number; col0Based: number };
 *   residentCountFromSheetCell?: { row0Based: number; col0Based: number };
 * }} [options]
 */
function rowsToResidents(rows, defaultFacilityName, options) {
  const tabTitle = String(defaultFacilityName ?? '').trim();
  const tabToken = compactFacilityToken(tabTitle);
  const isAozoraOkiSheet = /青空起/u.test(tabToken) || tabToken === '起';
  if (!rows?.length) {
    applyMedicalTargetSheetSummaryFromOptions([], tabTitle, options);
    applyAverageCareLevelSheetSummaryFromOptions([], tabTitle, options);
    applyResidentCountSheetSummaryFromOptions([], tabTitle, options);
    return [];
  }

  const singleCol = Boolean(options?.singleColumnNames);
  if (singleCol) {
    const out = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const name = String(row?.[0] ?? '').trim();
      if (!name) continue;
      if (shouldSkipResidentRowName(name, tabTitle)) continue;
      out.push({
        id: `${tabTitle}::${name}::sc${r}`,
        name,
        nameKana: '',
        room: '—',
        condition: '—',
        careLevelLabel: '',
        insuranceLabel: '',
        insuranceCategory: '未設定',
        medicalInsuranceTargetLabel: '',
        isMedicalInsuranceTarget: false,
        facility: tabTitle || '施設未設定',
        sourceSheetTitle: tabTitle || undefined,
        sheetStatus: undefined,
        lastStoolDate: '—',
        weight: null,
        lastMonthWeight: null,
        mealCountThisMonth: 0,
        lastPatrol: '—',
        patrolIntervalMinutes: 0,
        hasVitalAlert: false,
        isBalloon: false,
        isEnteral: false,
        homeDoctor: '',
        history: { patrols: [], week: [] },
        managerWords: '',
      });
    }
    if (tabTitle) {
      MEDICAL_TARGET_COUNT_FROM_SHEET_SUMMARY.delete(tabTitle);
      AVERAGE_CARE_LEVEL_FROM_SHEET_SUMMARY.delete(tabTitle);
      RESIDENT_COUNT_FROM_SHEET_SUMMARY.delete(tabTitle);
    }
    return out;
  }

  applyMedicalTargetSheetSummaryFromOptions(rows, tabTitle, options);
  applyAverageCareLevelSheetSummaryFromOptions(rows, tabTitle, options);
  applyResidentCountSheetSummaryFromOptions(rows, tabTitle, options);

  const headerIdx = findHeaderRowIndex(rows);
  const { mergedHeaders, dataStartOffset } = resolveMergedHeaders(rows, headerIdx);
  const dataRows = rows.slice(headerIdx + dataStartOffset);
  const table = [mergedHeaders, ...dataRows];
  if (table.length < 2) return [];

  const headers = table[0].map((h) => String(h ?? '').trim());
  const ix = {
    name: colIndexResidentName(headers),
    nameKana: colIndex(headers, [
      'フリガナ',
      'ふりがな',
      '氏名（カナ）',
      '氏名(カナ)',
      '名前（カナ）',
      '名前(カナ)',
      '利用者カナ',
      '入居者カナ',
      'カナ',
      'かな',
    ]),
    room: colIndex(headers, ['部屋', '居室', '号室', 'room', '部屋番号', '居室番号']),
    status: colIndex(headers, ['入居状況', '状況', 'ステータス', '入所状況', 'status']),
    careLevel: colIndexCareLevel(headers),
    disease: colIndex(headers, ['主たる疾患', '主疾患', '疾病', '診断名']),
    fallbackNote: colIndex(headers, ['コンディション', 'condition', 'メモ', '特記', '備考', 'コメント']),
    insurance: colIndexInsuranceKind(headers),
    medicalInsuranceTarget: colIndexMedicalInsuranceTarget(headers),
    mealMonth: colIndex(headers, [
      '当月食事',
      '食事回数',
      '今月食事',
      '食事件数',
      '請求食事',
      '月間食事',
      '１ヶ月食事',
      '一ヶ月食事',
    ]),
    enteral: colIndex(headers, ['経管栄養', '管栄', 'ＮＧＴ', 'NGT', '胃ろう', '胃瘻', '経管']),
    enteralMenu: colIndex(headers, ['経管栄養メニュー', '管栄メニュー', '経管内容', '管栄内容', '経管メニュー', '管栄']),
    facility: colIndex(headers, [
      '施設名',
      '施設',
      'ホーム',
      'ホーム名',
      '事業所',
      '事業所名',
      '拠点',
      'facility',
    ]),
    birthDate: colIndex(headers, ['生年月日', '誕生日', '生年月日（西暦）', 'birth', 'dob']),
    age: colIndex(headers, ['年齢', '満年齢', '歳']),
    gender: colIndex(headers, ['性別', '男女', 'gender']),
    homeDoctor: colIndex(headers, ['在宅医', '在宅医師', '主治医', '担当医', 'かかりつけ医', '主治医氏名']),
  };

  const medColForced =
    Number.isInteger(options?.medicalInsuranceTargetColumn0Based) &&
    options.medicalInsuranceTargetColumn0Based >= 0
      ? options.medicalInsuranceTargetColumn0Based
      : null;
  if (medColForced != null) {
    ix.medicalInsuranceTarget = medColForced;
  }

  const nameColForced =
    Number.isInteger(options?.nameColumn0Based) && options.nameColumn0Based >= 0
      ? options.nameColumn0Based
      : null;

  if (ix.name < 0 && nameColForced == null) {
    console.warn('[GoogleSheetService] 「氏名」列が見つかりません。1行目のヘッダを確認してください。');
    return [];
  }

  const nameColIx = nameColForced != null ? nameColForced : ix.name;
  const forceIncludeByNameCell =
    isAozoraOkiSheet && Number.isInteger(nameColForced) && nameColForced >= 0;

  const hasStatusCol = ix.status >= 0;

  const out = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;

    const status = hasStatusCol ? row[ix.status] : '';
    if (!forceIncludeByNameCell && hasStatusCol && !isActiveResident(status)) continue;

    const name = nameColIx >= 0 ? String(row[nameColIx] ?? '').trim() : '';
    if (!name) continue;
    const nameKana = ix.nameKana >= 0 ? String(row[ix.nameKana] ?? '').trim() : '';
    if (!forceIncludeByNameCell && shouldSkipResidentRowName(name, tabTitle)) continue;

    const facilityCol = ix.facility >= 0 ? String(row[ix.facility] ?? '').trim() : '';
    const facility = facilityCol || defaultFacilityName || '施設未設定';

    const room = ix.room >= 0 ? String(row[ix.room] ?? '').trim() : '';
    const birthDateLabel = ix.birthDate >= 0 ? normalizeBirthDateCell(row[ix.birthDate]) : '';
    const ageLabelRaw = ix.age >= 0 ? String(row[ix.age] ?? '').trim() : '';
    const genderLabel = ix.gender >= 0 ? String(row[ix.gender] ?? '').trim() : '';
    const ageVal =
      ageLabelRaw && /(\d{1,3})/.test(ageLabelRaw)
        ? parseInt(ageLabelRaw.match(/(\d{1,3})/)?.[1] ?? '', 10)
        : ageFromBirthDateLabel(birthDateLabel);

    let careLevelLabel = ix.careLevel >= 0 ? String(row[ix.careLevel] ?? '').trim().replace(/\s+/g, ' ') : '';
    const diseaseRaw = ix.disease >= 0 ? String(row[ix.disease] ?? '').trim() : '';
    const fbRaw = ix.fallbackNote >= 0 ? String(row[ix.fallbackNote] ?? '').trim() : '';
    let conditionDisplay = diseaseRaw;

    if (!careLevelLabel && diseaseRaw) {
      const p = parseCareLevelFromText(diseaseRaw);
      if (p.careLevel) {
        careLevelLabel = p.careLevel.replace(/\s+/g, ' ');
        conditionDisplay = p.remainder && p.remainder !== '—' ? p.remainder : '';
      }
    }

    if (!careLevelLabel && fbRaw) {
      const p = parseCareLevelFromText(fbRaw);
      if (p.careLevel) {
        careLevelLabel = p.careLevel.replace(/\s+/g, ' ');
        if (!conditionDisplay) conditionDisplay = p.remainder && p.remainder !== '—' ? p.remainder : '';
      }
    }

    if (!conditionDisplay && fbRaw) {
      const pf = parseCareLevelFromText(fbRaw);
      if (pf.remainder && pf.remainder !== '—') conditionDisplay = pf.remainder;
      else conditionDisplay = careLevelLabel ? '—' : fbRaw;
    }
    if (!conditionDisplay) conditionDisplay = '—';

    const insuranceLabel = ix.insurance >= 0 ? String(row[ix.insurance] ?? '').trim() : '';
    const insuranceCategory = normalizeInsuranceCategory(insuranceLabel);
    const homeDoctor = ix.homeDoctor >= 0 ? String(row[ix.homeDoctor] ?? '').trim() : '';

    let careLevelNormalized = normalizeCareLevelLabel(careLevelLabel);
    if (!careLevelNormalized) {
      const skipCareScan = new Set(
        [
          nameColIx,
          ix.room,
          ix.status,
          ix.insurance,
          ix.medicalInsuranceTarget,
          ix.facility,
          ix.mealMonth,
          ix.enteral,
          ix.disease,
          ix.fallbackNote,
          ix.careLevel,
        ].filter((i) => Number(i) >= 0)
      );
      const careCellHint =
        /要介護|要支援|介護\s*度|介護[1-5１-５]|ケアレベル|認知症|自立|未定|経過的|区分支給|事業対象|非該当|医療対象/u;
      for (let ci = 0; ci < row.length; ci++) {
        if (skipCareScan.has(ci)) continue;
        const cell = String(row[ci] ?? '').trim();
        if (!cell || cell.length > 120) continue;
        let n = '';
        if (cell.length <= 3 && /^[1-5１-５]$/u.test(cell.replace(/\s/g, ''))) {
          n = normalizeCareLevelLabel(cell);
        }
        if (!n && careCellHint.test(cell)) {
          n = normalizeCareLevelLabel(cell);
          if (!n) {
            const p = parseCareLevelFromText(cell);
            if (p.careLevel) n = normalizeCareLevelLabel(p.careLevel);
          }
        }
        if (n) {
          careLevelNormalized = n;
          break;
        }
      }
    }

    const medicalInsuranceTargetLabel =
      ix.medicalInsuranceTarget >= 0 ? String(row[ix.medicalInsuranceTarget] ?? '').trim() : '';
    let isMedicalInsuranceTarget = parseMedicalTargetCell(medicalInsuranceTargetLabel);
    const useNonEmptyMedicalRule =
      Boolean(options?.medicalInsuranceTargetNonEmptyMeansTrue) || isAozoraOkiSheet;
    if (!isMedicalInsuranceTarget && useNonEmptyMedicalRule && ix.medicalInsuranceTarget >= 0) {
      // 青空起: I列に病名が入っていれば医療保険対象として扱う運用
      const compact = medicalInsuranceTargetLabel.replace(/\s/g, '');
      if (compact && !/^[-ー−―－]+$/u.test(compact)) {
        isMedicalInsuranceTarget = true;
      }
    }
    // 医療対象の専用列が見つかっているときは、その列のみを信頼する（他列の「該当」等で過大カウントしない）
    if (!isMedicalInsuranceTarget && ix.medicalInsuranceTarget < 0) {
      const skipMedicalScan = new Set(
        [
          nameColIx,
          ix.room,
          ix.status,
          ix.insurance,
          ix.facility,
          ix.mealMonth,
          ix.enteral,
          ix.birthDate,
          ix.age,
          ix.gender,
        ].filter((i) => Number(i) >= 0)
      );
      for (let ci = 0; ci < row.length; ci++) {
        if (skipMedicalScan.has(ci)) continue;
        const cell = String(row[ci] ?? '').trim();
        if (!cell || cell.length > 120) continue;
        if (/^\d+(?:\.\d+)?$/.test(cell)) continue;
        if (parseMedicalTargetCell(cell)) {
          isMedicalInsuranceTarget = true;
          break;
        }
      }
    }
    // 疾患・介護メモのヒントだけで true にすると「介護保険の別表」等で全行が一致しうるため、ここでは件数に使わない

    const mealFromSheet = ix.mealMonth >= 0 ? parseMealCountCell(row[ix.mealMonth]) : 0;
    const enteralFromSheet = ix.enteral >= 0 ? parseEnteralFlagCell(row[ix.enteral]) : false;
    const enteralMenuDefault =
      ix.enteralMenu >= 0 ? String(row[ix.enteralMenu] ?? '').trim() : '';

    out.push({
      id: `${facility}::${room}::${name}::${r}`,
      name,
      nameKana,
      room: room || '—',
      condition: conditionDisplay,
      careLevelLabel: careLevelNormalized,
      insuranceLabel,
      insuranceCategory,
      /** 名簿の「医療保険対象」等の列の生テキスト */
      medicalInsuranceTargetLabel,
      /** 入居済み医療対象（別表7・気切等）の集計用 */
      isMedicalInsuranceTarget,
      facility,
      /** Sheets API でタブごとに読んだとき、そのタブ名（施設列とタブが一致しない場合の照合用） */
      sourceSheetTitle: tabTitle || undefined,
      sheetStatus: String(status ?? '').trim() || undefined,
      birthDateLabel,
      ageLabel: ageVal != null ? String(ageVal) : '',
      genderLabel,
      lastStoolDate: '—',
      weight: null,
      lastMonthWeight: null,
      /** 名簿に記載の当月食事回数（請求用）。無い列は 0 */
      mealCountThisMonth: mealFromSheet,
      lastPatrol: '—',
      patrolIntervalMinutes: 0,
      hasVitalAlert: false,
      isBalloon: false,
      /** 名簿の経管栄養列から。管理料算定の対象者フラグ */
      isEnteral: enteralFromSheet,
      /** 名簿の経管メニュー列（製剤・量など） */
      enteralMenuDefault: enteralMenuDefault || undefined,
      homeDoctor,
      history: { patrols: [], week: [] },
      managerWords: '',
    });
  }
  return out;
}

/**
 * 性別セルを 男／女／不明 に分類
 * @param {string} raw
 */
function genderBucketFromCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'unknown';
  if (/女|女性|メス|F|female|♀/iu.test(s)) return 'female';
  if (/男|男性|オス|M|male|♂/iu.test(s)) return 'male';
  return 'unknown';
}

/**
 * 状況列のざっくり分類（非アクティブ行の内訳用）
 * @param {string} statusRaw
 */
function classifyStatusBucket(statusRaw) {
  const s = String(statusRaw ?? '').trim();
  if (!s) return 'other_inactive';
  if (/入院|入外|療養/u.test(s)) return 'hospital';
  if (/退院/u.test(s)) return 'discharge_hospital';
  if (/退居|退去|死亡|転居/u.test(s)) return 'move_out';
  if (/入居予定|見学|申込|未入居/u.test(s)) return 'move_in_pipeline';
  return 'other_inactive';
}

/**
 * 施設タブ1枚分の名簿から、入居・介護度・性別・状況別人数を集計する。
 * rowsToResidents と同じヘッダ解釈（在籍行のみ介護度・性別をカウント、非在籍は状況バケットのみ）。
 *
 * @param {string[][]} rows
 * @param {string} defaultFacilityName
 * @param {{
 *   singleColumnNames?: boolean;
 *   nameColumn0Based?: number;
 *   medicalInsuranceTargetColumn0Based?: number;
 *   medicalInsuranceTargetNonEmptyMeansTrue?: boolean;
 * }} [options]
 * @returns {{
 *   sheetTitle: string;
 *   linkKey: string;
 *   tabLabel: string;
 *   dataRows: number;
 *   active: number;
 *   careNeed1: number;
 *   careNeed2: number;
 *   careNeed3: number;
 *   careNeed4: number;
 *   careNeed5: number;
 *   careSupport1: number;
 *   careSupport2: number;
 *   careOther: number;
 *   male: number;
 *   female: number;
 *   genderUnknown: number;
 *   inactiveTotal: number;
 *   statusHospital: number;
 *   statusDischargeHospital: number;
 *   statusMoveOut: number;
 *   statusMoveInPipeline: number;
 *   statusOtherInactive: number;
 * }}
 */
export function aggregateFacilityStatsFromSheetRows(rows, defaultFacilityName, options = {}) {
  const tabTitle = String(defaultFacilityName ?? '').trim();
  const tabToken = compactFacilityToken(tabTitle);
  const isAozoraOkiSheet = /青空起/u.test(tabToken) || tabToken === '起';
  const def = CARELINK_FACILITIES.find((f) => f.sheetTitle === tabTitle);
  const linkKey = def?.linkKey ?? tabTitle;
  const tabLabel = def?.tabLabel ?? tabTitle;

  const emptyStats = () => ({
    sheetTitle: tabTitle,
    linkKey,
    tabLabel,
    dataRows: 0,
    active: 0,
    careNeed1: 0,
    careNeed2: 0,
    careNeed3: 0,
    careNeed4: 0,
    careNeed5: 0,
    careSupport1: 0,
    careSupport2: 0,
    careOther: 0,
    male: 0,
    female: 0,
    genderUnknown: 0,
    inactiveTotal: 0,
    statusHospital: 0,
    statusDischargeHospital: 0,
    statusMoveOut: 0,
    statusMoveInPipeline: 0,
    statusOtherInactive: 0,
  });

  if (!rows?.length) return emptyStats();

  if (options?.singleColumnNames) {
    let n = 0;
    for (let r = 0; r < rows.length; r++) {
      const name = String(rows[r]?.[0] ?? '').trim();
      if (!name || shouldSkipResidentRowName(name, tabTitle)) continue;
      n++;
    }
    const out = emptyStats();
    out.dataRows = n;
    out.active = n;
    return out;
  }

  const headerIdx = findHeaderRowIndex(rows);
  const { mergedHeaders, dataStartOffset } = resolveMergedHeaders(rows, headerIdx);
  const dataRows = rows.slice(headerIdx + dataStartOffset);
  const table = [mergedHeaders, ...dataRows];
  if (table.length < 2) return emptyStats();

  const headers = table[0].map((h) => String(h ?? '').trim());
  const ix = {
    name: colIndexResidentName(headers),
    room: colIndex(headers, ['部屋', '居室', '号室', 'room', '部屋番号', '居室番号']),
    status: colIndex(headers, ['入居状況', '状況', 'ステータス', '入所状況', 'status']),
    careLevel: colIndexCareLevel(headers),
    disease: colIndex(headers, ['主たる疾患', '主疾患', '疾病', '診断名']),
    fallbackNote: colIndex(headers, ['コンディション', 'condition', 'メモ', '特記', '備考', 'コメント']),
    insurance: colIndexInsuranceKind(headers),
    medicalInsuranceTarget: colIndexMedicalInsuranceTarget(headers),
    facility: colIndex(headers, [
      '施設名',
      '施設',
      'ホーム',
      'ホーム名',
      '事業所',
      '事業所名',
      '拠点',
      'facility',
    ]),
    gender: colIndex(headers, ['性別', '男女', 'gender']),
  };
  const medColForced =
    Number.isInteger(options?.medicalInsuranceTargetColumn0Based) &&
    options.medicalInsuranceTargetColumn0Based >= 0
      ? options.medicalInsuranceTargetColumn0Based
      : null;
  if (medColForced != null) ix.medicalInsuranceTarget = medColForced;

  const nameColForced =
    Number.isInteger(options?.nameColumn0Based) && options.nameColumn0Based >= 0
      ? options.nameColumn0Based
      : null;

  if (ix.name < 0 && nameColForced == null) return emptyStats();

  const nameColIx = nameColForced != null ? nameColForced : ix.name;
  const forceIncludeByNameCell =
    isAozoraOkiSheet && Number.isInteger(nameColForced) && nameColForced >= 0;
  const hasStatusCol = ix.status >= 0;

  const out = emptyStats();

  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;

    const status = hasStatusCol ? row[ix.status] : '';
    const statusStr = String(status ?? '').trim();
    const name = nameColIx >= 0 ? String(row[nameColIx] ?? '').trim() : '';
    if (!name) continue;
    if (!forceIncludeByNameCell && shouldSkipResidentRowName(name, tabTitle)) continue;

    out.dataRows += 1;

    const active = !hasStatusCol || isActiveResident(statusStr);
    if (!forceIncludeByNameCell && hasStatusCol && !active) {
      out.inactiveTotal += 1;
      const bucket = classifyStatusBucket(statusStr);
      if (bucket === 'hospital') out.statusHospital += 1;
      else if (bucket === 'discharge_hospital') out.statusDischargeHospital += 1;
      else if (bucket === 'move_out') out.statusMoveOut += 1;
      else if (bucket === 'move_in_pipeline') out.statusMoveInPipeline += 1;
      else out.statusOtherInactive += 1;
      continue;
    }

    out.active += 1;

    let careLevelLabel =
      ix.careLevel >= 0 ? String(row[ix.careLevel] ?? '').trim().replace(/\s+/g, ' ') : '';
    const diseaseRaw = ix.disease >= 0 ? String(row[ix.disease] ?? '').trim() : '';
    const fbRaw = ix.fallbackNote >= 0 ? String(row[ix.fallbackNote] ?? '').trim() : '';
    if (!careLevelLabel && diseaseRaw) {
      const p = parseCareLevelFromText(diseaseRaw);
      if (p.careLevel) careLevelLabel = p.careLevel.replace(/\s+/g, ' ');
    }
    if (!careLevelLabel && fbRaw) {
      const p = parseCareLevelFromText(fbRaw);
      if (p.careLevel) careLevelLabel = p.careLevel.replace(/\s+/g, ' ');
    }
    let careLevelNormalized = normalizeCareLevelLabel(careLevelLabel);
    if (!careLevelNormalized) {
      const skipCareScan = new Set(
        [
          nameColIx,
          ix.room,
          ix.status,
          ix.insurance,
          ix.medicalInsuranceTarget,
          ix.facility,
          ix.disease,
          ix.fallbackNote,
          ix.careLevel,
        ].filter((i) => Number(i) >= 0)
      );
      const careCellHint =
        /要介護|要支援|介護\s*度|介護[1-5１-５]|ケアレベル|認知症|自立|未定|経過的|区分支給|事業対象|非該当|医療対象/u;
      for (let ci = 0; ci < row.length; ci++) {
        if (skipCareScan.has(ci)) continue;
        const cell = String(row[ci] ?? '').trim();
        if (!cell || cell.length > 120) continue;
        let n = '';
        if (cell.length <= 3 && /^[1-5１-５]$/u.test(cell.replace(/\s/g, ''))) {
          n = normalizeCareLevelLabel(cell);
        }
        if (!n && careCellHint.test(cell)) {
          n = normalizeCareLevelLabel(cell);
          if (!n) {
            const p = parseCareLevelFromText(cell);
            if (p.careLevel) n = normalizeCareLevelLabel(p.careLevel);
          }
        }
        if (n) {
          careLevelNormalized = n;
          break;
        }
      }
    }

    if (careLevelNormalized) {
      const mj = /^要介護([1-5])$/.exec(careLevelNormalized);
      if (mj) {
        const k = mj[1];
        if (k === '1') out.careNeed1 += 1;
        else if (k === '2') out.careNeed2 += 1;
        else if (k === '3') out.careNeed3 += 1;
        else if (k === '4') out.careNeed4 += 1;
        else if (k === '5') out.careNeed5 += 1;
      } else if (/^要支援1$/.test(careLevelNormalized)) out.careSupport1 += 1;
      else if (/^要支援2$/.test(careLevelNormalized)) out.careSupport2 += 1;
      else out.careOther += 1;
    } else {
      out.careOther += 1;
    }

    const g = ix.gender >= 0 ? genderBucketFromCell(row[ix.gender]) : 'unknown';
    if (g === 'male') out.male += 1;
    else if (g === 'female') out.female += 1;
    else out.genderUnknown += 1;
  }

  return out;
}

/**
 * 全施設タブを一括取得し、施設別に集計する（経営ダッシュボード用）
 * @param {string} apiKey
 * @returns {Promise<{ facilities: ReturnType<typeof aggregateFacilityStatsFromSheetRows>[]; fetchedAt: string }>}
 */
export async function fetchResidentsStatsByFacility(apiKey) {
  if (!apiKey?.trim()) throw new Error('API キーがありません');
  const tabs = await fetchSheetTabs(apiKey);
  const configPairs = [];
  for (const def of CARELINK_FACILITIES) {
    const apiTitle = resolveSheetTabTitle(tabs, def);
    if (!apiTitle) continue;
    configPairs.push({ def, apiTitle });
  }

  const facilities = [];
  if (configPairs.length > 0) {
    const ranges = configPairs.map((p) =>
      sheetRangeA1(p.apiTitle, p.def.valueRange?.trim() || null)
    );
    const valueChunks = await fetchSpreadsheetValuesBatch(
      CARELINK_RESIDENT_SPREADSHEET_ID,
      apiKey,
      ranges
    );
    for (let i = 0; i < configPairs.length; i++) {
      const { def } = configPairs[i];
      const values = valueChunks[i] ?? [];
      facilities.push(
        aggregateFacilityStatsFromSheetRows(values, def.sheetTitle, {
          singleColumnNames: Boolean(def.singleColumnNames),
          nameColumn0Based: def.nameColumn0Based,
          medicalInsuranceTargetColumn0Based: def.medicalInsuranceTargetColumn0Based,
          medicalInsuranceTargetNonEmptyMeansTrue: def.medicalInsuranceTargetNonEmptyMeansTrue,
        })
      );
    }
    return { facilities, fetchedAt: new Date().toISOString() };
  }

  const fallbackPairs = tabs.map((t) => {
    const def = resolveFacilityDefForSheetTab(t.title);
    return { title: t.title, def };
  });
  const rangesFb = fallbackPairs.map((p) =>
    sheetRangeA1(p.title, p.def?.valueRange?.trim() || null)
  );
  const valuesFb = await fetchSpreadsheetValuesBatch(
    CARELINK_RESIDENT_SPREADSHEET_ID,
    apiKey,
    rangesFb
  );
  for (let i = 0; i < fallbackPairs.length; i++) {
    const { title, def } = fallbackPairs[i];
    const values = valuesFb[i] ?? [];
    facilities.push(
      aggregateFacilityStatsFromSheetRows(values, def?.sheetTitle ?? title, {
        singleColumnNames: Boolean(def?.singleColumnNames),
        nameColumn0Based: def?.nameColumn0Based,
        medicalInsuranceTargetColumn0Based: def?.medicalInsuranceTargetColumn0Based,
        medicalInsuranceTargetNonEmptyMeansTrue: def?.medicalInsuranceTargetNonEmptyMeansTrue,
      })
    );
  }
  return { facilities, fetchedAt: new Date().toISOString() };
}

/**
 * @param {string} apiKey
 * @returns {Promise<{ title: string; sheetId: number }[]>}
 */
async function fetchSheetTabs(apiKey) {
  const id = encodeURIComponent(CARELINK_RESIDENT_SPREADSHEET_ID);
  const url = `${SHEETS_API}/${id}?fields=sheets(properties(sheetId,title,hidden))&key=${encodeURIComponent(apiKey)}`;
  const { res, data } = await sheetsGetJsonWithRetry(url);
  if (!res.ok || data.error) {
    const msg = data.error?.message ?? 'スプレッドシートのメタデータ取得に失敗しました';
    throw new Error(
      `${msg}（Sheets API が有効か、スプレッドシート ID が正しいか確認してください）`
    );
  }
  const sheets = data.sheets ?? [];
  return sheets
    .map((s) => s.properties)
    .filter((p) => p && !p.hidden)
    .map((p) => ({ title: p.title, sheetId: p.sheetId }));
}

/**
 * @param {string} apiKey
 * @param {string} sheetTitle
 */
/**
 * @param {string} apiKey
 * @param {string} sheetTitle
 * @param {string | null | undefined} rangeA1WithinSheet 例 B6:ZZ29（省略時 A:ZZ）
 */
/**
 * @param {string} spreadsheetId
 * @param {string} apiKey
 * @param {string} sheetTitle
 * @param {string | null | undefined} rangeA1WithinSheet
 */
async function fetchAnySheetValues(spreadsheetId, apiKey, sheetTitle, rangeA1WithinSheet) {
  const sid = encodeURIComponent(spreadsheetId);
  const a1 = sheetRangeA1(sheetTitle, rangeA1WithinSheet);
  const range = encodeURIComponent(a1);
  const url = `${SHEETS_API}/${sid}/values/${range}?key=${encodeURIComponent(apiKey)}`;
  const { res, data } = await sheetsGetJsonWithRetry(url);
  if (!res.ok || data.error) {
    throw new Error(data.error?.message ?? `シート「${sheetTitle}」の取得に失敗しました`);
  }
  return data.values ?? [];
}

async function fetchSheetValues(apiKey, sheetTitle, rangeA1WithinSheet) {
  return fetchAnySheetValues(CARELINK_RESIDENT_SPREADSHEET_ID, apiKey, sheetTitle, rangeA1WithinSheet);
}

/**
 * スプレッドシート上の実タブ名を解決（完全一致 → compact 一致）
 * @param {{ title: string }[]} tabs
 * @param {{ sheetTitle: string }} def
 */
function resolveSheetTabTitle(tabs, def) {
  const want = String(def.sheetTitle ?? '').trim();
  if (!want) return null;
  const hitExact = tabs.find((t) => t.title === want);
  if (hitExact) return hitExact.title;
  const w = compactFacilityToken(want);
  if (!w) return null;
  const hitLoose = tabs.find((t) => compactFacilityToken(t.title) === w);
  if (hitLoose) return hitLoose.title;
  // 記号・接頭語の違いだけで一致しない場合（3文字以上の拠点名で部分一致）
  if (w.length >= 3) {
    const hitPartial = tabs.find((t) => {
      const c = compactFacilityToken(t.title);
      if (!c) return false;
      if (c === w) return true;
      return c.includes(w) || w.includes(c);
    });
    if (hitPartial) return hitPartial.title;
  }
  return null;
}

/**
 * 設定済み施設タブのみ読み、sourceSheetTitle は常に carelinkFacilities の正式 sheetTitle に揃える（UI 照合ずれ防止）
 * 1件も解決できないブックは従来どおり「全タブ」を読むフォールバック
 * @param {string} apiKey
 */
export async function fetchResidentsAllTabs(apiKey) {
  if (!apiKey?.trim()) throw new Error('API キーがありません');
  const tabs = await fetchSheetTabs(apiKey);
  const all = [];
  const configPairs = [];
  for (const def of CARELINK_FACILITIES) {
    const apiTitle = resolveSheetTabTitle(tabs, def);
    if (!apiTitle) continue;
    configPairs.push({ def, apiTitle });
  }

  if (configPairs.length > 0) {
    const ranges = configPairs.map((p) =>
      sheetRangeA1(p.apiTitle, p.def.valueRange?.trim() || null)
    );
    const valueChunks = await fetchSpreadsheetValuesBatch(
      CARELINK_RESIDENT_SPREADSHEET_ID,
      apiKey,
      ranges
    );
    for (let i = 0; i < configPairs.length; i++) {
      const { def } = configPairs[i];
      const values = valueChunks[i] ?? [];
      all.push(
        ...rowsToResidents(values, def.sheetTitle, {
          singleColumnNames: Boolean(def.singleColumnNames),
          nameColumn0Based: def.nameColumn0Based,
          medicalInsuranceTargetColumn0Based: def.medicalInsuranceTargetColumn0Based,
          medicalInsuranceTargetNonEmptyMeansTrue: def.medicalInsuranceTargetNonEmptyMeansTrue,
          medicalTargetCountFromSheetCell: def.medicalTargetCountFromSheetCell,
          averageCareLevelFromSheetCell: def.averageCareLevelFromSheetCell,
          residentCountFromSheetCell: def.residentCountFromSheetCell,
        })
      );
    }
    return all;
  }

  const fallbackPairs = tabs.map((t) => {
    const def = resolveFacilityDefForSheetTab(t.title);
    return { title: t.title, def };
  });
  const rangesFb = fallbackPairs.map((p) =>
    sheetRangeA1(p.title, p.def?.valueRange?.trim() || null)
  );
  const valuesFb = await fetchSpreadsheetValuesBatch(
    CARELINK_RESIDENT_SPREADSHEET_ID,
    apiKey,
    rangesFb
  );
  for (let i = 0; i < fallbackPairs.length; i++) {
    const { title, def } = fallbackPairs[i];
    const values = valuesFb[i] ?? [];
    all.push(
      ...rowsToResidents(values, def?.sheetTitle ?? title, {
        singleColumnNames: Boolean(def?.singleColumnNames),
        nameColumn0Based: def?.nameColumn0Based,
        medicalInsuranceTargetColumn0Based: def?.medicalInsuranceTargetColumn0Based,
        medicalInsuranceTargetNonEmptyMeansTrue: def?.medicalInsuranceTargetNonEmptyMeansTrue,
        medicalTargetCountFromSheetCell: def?.medicalTargetCountFromSheetCell,
        averageCareLevelFromSheetCell: def?.averageCareLevelFromSheetCell,
        residentCountFromSheetCell: def?.residentCountFromSheetCell,
      })
    );
  }
  return all;
}

/**
 * URL の gid に相当する sheetId のタブだけ取得（1枚に全施設列がある場合）
 * @param {string} apiKey
 * @param {number} sheetIdNum
 */
export async function fetchResidentsSingleTabBySheetId(apiKey, sheetIdNum) {
  if (!apiKey?.trim()) throw new Error('API キーがありません');
  const tabs = await fetchSheetTabs(apiKey);
  const tab = tabs.find((t) => t.sheetId === sheetIdNum);
  if (!tab) {
    throw new Error(`sheetId ${sheetIdNum} のタブが見つかりません（スプレッドシートの gid を確認）`);
  }
  const def = resolveFacilityDefForSheetTab(tab.title);
  const canonicalTitle = def?.sheetTitle ?? tab.title;
  const rangeSuffix = def?.valueRange?.trim() || null;
  const values = await fetchSheetValues(apiKey, tab.title, rangeSuffix);
  return rowsToResidents(values, canonicalTitle, {
    singleColumnNames: Boolean(def?.singleColumnNames),
    nameColumn0Based: def?.nameColumn0Based,
    medicalInsuranceTargetColumn0Based: def?.medicalInsuranceTargetColumn0Based,
    medicalInsuranceTargetNonEmptyMeansTrue: def?.medicalInsuranceTargetNonEmptyMeansTrue,
    medicalTargetCountFromSheetCell: def?.medicalTargetCountFromSheetCell,
    averageCareLevelFromSheetCell: def?.averageCareLevelFromSheetCell,
    residentCountFromSheetCell: def?.residentCountFromSheetCell,
  });
}

function csvProxyUrl(sheetId, gid) {
  return `/spreadsheet-export/spreadsheets/d/${sheetId}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

/** API キー未設定時: 公開シートの CSV エクスポート（dev/preview のプロキシ経由） */
export async function fetchResidentsViaCsv(gid) {
  const url = csvProxyUrl(CARELINK_RESIDENT_SPREADSHEET_ID, gid);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(
      `名簿CSV取得失敗（HTTP ${res.status}）。シートを「リンクを知っている全員が閲覧可」にし、npm run dev で起動してください。`
    );
  }
  const text = await res.text();
  const csvDefaultTab = String(import.meta.env.VITE_CSV_DEFAULT_SHEET_TITLE ?? '').trim();
  const csvDef = resolveFacilityDefForSheetTab(csvDefaultTab) ?? facilityDefBySheetTitle(csvDefaultTab);
  const csvCanonical = csvDef?.sheetTitle ?? csvDefaultTab;
  return rowsToResidents(parseCsv(text), csvCanonical, {
    singleColumnNames: Boolean(csvDef?.singleColumnNames),
    nameColumn0Based: csvDef?.nameColumn0Based,
    medicalInsuranceTargetColumn0Based: csvDef?.medicalInsuranceTargetColumn0Based,
    medicalInsuranceTargetNonEmptyMeansTrue: csvDef?.medicalInsuranceTargetNonEmptyMeansTrue,
    medicalTargetCountFromSheetCell: csvDef?.medicalTargetCountFromSheetCell,
    averageCareLevelFromSheetCell: csvDef?.averageCareLevelFromSheetCell,
    residentCountFromSheetCell: csvDef?.residentCountFromSheetCell,
  });
}

/**
 * @returns {Promise<{ residents: Record<string, unknown>[]; source: 'sheets_api'|'csv'; mode: string }>}
 */
/**
 * 部署別売上表ブックの指定タブを取得（VITE_GOOGLE_SHEETS_API_KEY 必須）
 * @param {string} apiKey
 * @param {{ sheetTitle?: string; range?: string }} [opts]
 * @returns {Promise<string[][]>}
 */
export async function fetchDepartmentSalesTable(apiKey, opts = {}) {
  if (!apiKey?.trim()) throw new Error('API キーがありません');
  const envName = (import.meta.env.VITE_DEPARTMENT_SALES_SHEET_NAME ?? '').trim();
  const sheetTitle = opts.sheetTitle ?? (envName || '部署別売上表');
  const range = opts.range ?? 'A1:I25';
  return fetchAnySheetValues(CARELINK_DEPARTMENT_SALES_SPREADSHEET_ID, apiKey, sheetTitle, range);
}

async function loadResidentsFromSource() {
  clearMedicalTargetCountFromSheetSummary();

  const residentsSource = String(import.meta.env.VITE_RESIDENTS_SOURCE ?? '').trim().toLowerCase();
  if (residentsSource === 'supabase') {
    const { fetchResidentsFromSupabase } = await import('./supabaseResidents.js');
    const residents = await fetchResidentsFromSupabase();
    return {
      residents,
      source: 'supabase',
      mode: 'postgres',
      cacheVersion: RESIDENT_SUMMARY_CACHE_VERSION,
      ...snapshotFacilitySheetSummaryMaps(),
    };
  }

  const apiKey = (import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '').trim();
  if (apiKey) {
    const gidRaw = import.meta.env.VITE_GOOGLE_SHEET_GID;
    const gidTrim = gidRaw != null ? String(gidRaw).trim() : '';
    if (gidTrim !== '') {
      const sheetIdNum = parseInt(gidTrim, 10);
      if (Number.isNaN(sheetIdNum)) {
        throw new Error('VITE_GOOGLE_SHEET_GID は数値（URL の gid=）を指定してください');
      }
      const residents = await fetchResidentsSingleTabBySheetId(apiKey, sheetIdNum);
      return {
        residents,
        source: 'sheets_api',
        mode: 'single_gid',
        cacheVersion: RESIDENT_SUMMARY_CACHE_VERSION,
        ...snapshotFacilitySheetSummaryMaps(),
      };
    }
    const residents = await fetchResidentsAllTabs(apiKey);
    return {
      residents,
      source: 'sheets_api',
      mode: 'all_tabs',
      cacheVersion: RESIDENT_SUMMARY_CACHE_VERSION,
      ...snapshotFacilitySheetSummaryMaps(),
    };
  }
  const residents = await fetchResidentsViaCsv(String(CARELINK_DEFAULT_CSV_GID));
  return {
    residents,
    source: 'csv',
    mode: 'public_export',
    cacheVersion: RESIDENT_SUMMARY_CACHE_VERSION,
    ...snapshotFacilitySheetSummaryMaps(),
  };
}

/**
 * @param {{ forceRefresh?: boolean }} [opts]
 * forceRefresh が false のとき、直近の成功結果を最大 RESIDENTS_CACHE_TTL_MS 再利用する
 */
export async function fetchResidentsFromSheet(opts = {}) {
  const force = Boolean(opts.forceRefresh);
  if (force) {
    residentsFetchCache = null;
    residentsFetchCacheAt = 0;
  }
  const now = Date.now();
  if (
    !force &&
    residentsFetchCache &&
    now - residentsFetchCacheAt < RESIDENTS_CACHE_TTL_MS
  ) {
    if (
      !('medicalTargetSummaryBySheet' in residentsFetchCache) ||
      residentsFetchCache.cacheVersion !== RESIDENT_SUMMARY_CACHE_VERSION
    ) {
      residentsFetchCache = null;
    } else {
      restoreFacilitySheetSummaryMapsFromSnapshot({
        medicalTargetSummaryBySheet: residentsFetchCache.medicalTargetSummaryBySheet,
        averageCareLevelSummaryBySheet: residentsFetchCache.averageCareLevelSummaryBySheet,
        residentCountSummaryBySheet: residentsFetchCache.residentCountSummaryBySheet,
      });
      return residentsFetchCache;
    }
  }
  if (!force && residentsFetchInFlight) {
    return residentsFetchInFlight;
  }

  const p = loadResidentsFromSource().then((result) => {
    residentsFetchCache = result;
    residentsFetchCacheAt = Date.now();
    restoreFacilitySheetSummaryMapsFromSnapshot({
      medicalTargetSummaryBySheet: result.medicalTargetSummaryBySheet,
      averageCareLevelSummaryBySheet: result.averageCareLevelSummaryBySheet,
      residentCountSummaryBySheet: result.residentCountSummaryBySheet,
    });
    return result;
  });

  if (!force) {
    residentsFetchInFlight = p;
  }
  try {
    return await p;
  } finally {
    residentsFetchInFlight = null;
  }
}

/**
 * @param {Array<{ facility: string }>} residents
 */
export function uniqueFacilities(residents) {
  const seen = new Set();
  const list = [];
  for (const r of residents) {
    const f = String(r.facility ?? '').trim() || '施設未設定';
    if (seen.has(f)) continue;
    seen.add(f);
    list.push(f);
  }
  return list;
}
