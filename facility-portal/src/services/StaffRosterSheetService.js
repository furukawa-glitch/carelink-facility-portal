/**
 * 求人・入退社シートからスタッフ名簿を読み、周知チェック対象者を同期する
 */

import { CARELINK_FACILITIES, compactFacilityToken, getShiftDepartmentsForLinkKey } from '../config/carelinkFacilities.js';
import { DEFAULT_HR_SPREADSHEET_ID, DEFAULT_HR_STAFF_SHEET_GID } from '../config/hrSpreadsheetConstants.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

function formatHrSheetsErrorMessage(rawMsg, fallback) {
  const msg = String(rawMsg ?? '').trim();
  const lower = msg.toLowerCase();
  if (
    lower.includes('operation is not supported for this document') ||
    lower.includes('not supported for this document')
  ) {
    return 'この職員名簿ファイルは Sheets API で直接読めません（Excel互換のままの可能性）。Googleスプレッドシートとして保存し直したIDを VITE_HR_SPREADSHEET_ID に設定してください。';
  }
  if (lower.includes('permission') || lower.includes('forbidden')) {
    return '職員名簿シートの閲覧権限がありません。シート共有設定または API キー制限を確認してください。';
  }
  if (lower.includes('not found')) {
    return '職員名簿シートが見つかりません。VITE_HR_SPREADSHEET_ID / VITE_HR_STAFF_SHEET_GID を確認してください。';
  }
  return msg || fallback;
}

/** VITE_HR_SPREADSHEET_ID が無ければデフォルト（ユーザー共有URL） */
export function getHrSpreadsheetId() {
  const a = import.meta.env.VITE_HR_SPREADSHEET_ID?.trim();
  return a || DEFAULT_HR_SPREADSHEET_ID;
}

function normCell(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s/g, '');
}

/**
 * 按分名簿の「本館/…」をアプリの linkKey「中川本館」と一致させる
 * @param {string} raw
 */
function normalizeBranchFacilityCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return s;
  if (s === '本館' || /^本館[\/／｜|]/u.test(s)) return s.replace(/^本館/, '中川本館');
  return s;
}

/** 役員・本部行は周知名簿・勤務シードから除外（ユーザー運用） */
function shouldExcludeHrFacilityBranch(facilityRaw) {
  const s = String(facilityRaw ?? '').trim();
  if (!s) return false;
  const first = s.split(/[\/／]/u)[0].trim();
  return /^(役員|本部)$/u.test(first);
}

/**
 * @param {string} statusRaw
 */
export function isActiveEmploymentStatus(statusRaw) {
  const t = String(statusRaw ?? '').trim();
  if (!t) return true;
  const n = normCell(t);
  if (/退職|離職|解雇|終了|不要|辞退|入社前のみ|内定のみ|不採用|見送|×|✕/u.test(t)) return false;
  if (/長期休職|休職中(?![のを])|育休(?!.*復帰)/u.test(t)) return false;
  if (/在籍|勤務中|現職|稼働中|入社済|契約中|本採用|ｏｋ|OK|○|正社員|パート|非常勤|嘱託|アルバイト|派遣/u.test(t)) return true;
  return true;
}

/**
 * 求人シートの「タグ」「#施設A」などをトークン化
 * @param {string} raw
 * @returns {string[]}
 */
export function splitHrTagTokens(raw) {
  return String(raw ?? '')
    .split(/[#、，,｜|\s\n\r\t／/]+/u)
    .map((x) => x.trim())
    .filter((x) => x && !/^例[：:]?$/u.test(x));
}

/**
 * 単一トークンまたは短文から linkKey を推定
 * @param {string} token
 */
function linkKeyFromSingleToken(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return '';
  const hit = CARELINK_FACILITIES.find(
    (f) =>
      raw === f.tabLabel ||
      raw === f.linkKey ||
      raw === f.sheetTitle ||
      compactFacilityToken(raw) === compactFacilityToken(f.tabLabel) ||
      compactFacilityToken(raw) === compactFacilityToken(f.linkKey) ||
      raw.includes(f.tabLabel) ||
      f.tabLabel.includes(raw)
  );
  return hit?.linkKey ?? '';
}

/**
 * 施設セル・タグ列の全文から linkKey を推定（タグ複数可）
 * @param {string} facilityCell
 * @param {string} [tagCell]
 * @returns {string[]}
 */
/**
 * 施設・タグの文字列から、勤務表画面の「部署」候補（shiftDepartments）のいずれかを推定する。
 * タグに「千音寺介護」「#愛西デイ」のように**アプリの部署名が含まれる**と確実です。
 * @param {string} facilityLinkKey
 * @param {string} facilityCell
 * @param {string} tagCell
 * @returns {string}
 */
export function resolveShiftDepartmentForHrRow(facilityLinkKey, facilityCell, tagCell) {
  const lk = String(facilityLinkKey ?? '').trim();
  const options = getShiftDepartmentsForLinkKey(lk).filter(Boolean);
  if (!options.length) return '';

  const blobRaw = `${normalizeBranchFacilityCell(String(facilityCell ?? ''))} ${String(tagCell ?? '')}`.trim();
  const blobNorm = normCell(blobRaw.replace(/\s+/g, ''));

  // 施設共通の表記ゆれ（訪看/ヘルくま）を先に吸収
  if (/(訪看|訪問看護)/u.test(blobRaw)) {
    const hit = options.find((d) => /(訪問看護|看護)/u.test(d));
    if (hit) return hit;
  }
  if (/(ヘルくま|訪介|訪問介護)/u.test(blobRaw)) {
    const hit = options.find((d) => /(訪問介護|介護)/u.test(d));
    if (hit) return hit;
  }

  // 運用上の固定マッピング（職員名簿の表記ゆれ対応）
  if (lk === '愛西') {
    if (/(訪看|訪問看護)/u.test(blobRaw)) {
      const hit = options.find((d) => /(訪問看護|愛西看護|看護)/u.test(d));
      if (hit) return hit;
    }
    if (/(ヘルくま|訪介|訪問介護)/u.test(blobRaw)) {
      const hit = options.find((d) => /(訪問介護|愛西訪問介護|介護)/u.test(d));
      if (hit) return hit;
    }
  }

  const sorted = [...options].sort((a, b) => b.length - a.length);

  for (const dep of sorted) {
    const d = normCell(dep);
    if (!d) continue;
    if (blobNorm.includes(d) || blobRaw.includes(dep)) return dep;
  }

  const tokens = [...splitHrTagTokens(facilityCell), ...splitHrTagTokens(tagCell)];
  for (const dep of sorted) {
    const dn = normCell(dep);
    if (!dn) continue;
    for (const tok of tokens) {
      const t = normCell(tok);
      if (!t) continue;
      if (t === dn || t.includes(dn) || dn.includes(t)) return dep;
    }
  }
  return '';
}

export function linkKeysFromFacilityAndTags(facilityCell, tagCell = '') {
  const combined = [normalizeBranchFacilityCell(String(facilityCell ?? '').trim()), String(tagCell ?? '').trim()]
    .filter(Boolean)
    .join(' ');
  const whole = linkKeyFromFacilityCell(combined);
  if (whole) return [whole];

  const tokens = [
    ...splitHrTagTokens(facilityCell),
    ...splitHrTagTokens(tagCell),
  ];
  const keys = new Set();
  for (const t of tokens) {
    const lk = linkKeyFromSingleToken(t);
    if (lk) keys.add(lk);
  }
  if (!keys.size && combined) {
    for (const piece of splitHrTagTokens(combined)) {
      const lk2 = linkKeyFromSingleToken(piece);
      if (lk2) keys.add(lk2);
    }
  }
  return [...keys];
}

function linkKeyFromFacilityCell(facilityCell) {
  const raw = String(facilityCell ?? '').trim();
  if (!raw) return '';
  return linkKeyFromSingleToken(raw);
}

/**
 * @param {string[]} headers
 */
function findStaffHeaderIndices(headers) {
  const h = headers.map((x) => normCell(String(x ?? '')));
  const nameIdx = h.findIndex((cell) =>
    /^(スタッフ名|氏名|名前|職員名|担当者名|スタッフ)$/u.test(cell) || /スタッフ名|氏名/u.test(cell)
  );
  let statusIdx = h.findIndex((cell) =>
    /^(在籍状況|状況|ステータス|入退社|雇用状況|勤務状況)$/u.test(cell) || /在籍|入退社|雇用/u.test(cell)
  );
  if (statusIdx < 0) {
    statusIdx = h.findIndex((cell) => cell.includes('在籍') || cell.includes('状況'));
  }
  const facilityIdx = h.findIndex((cell) =>
    /^(施設|事業所|拠点|所属|勤務先|ホーム|ブロック)$/u.test(cell) || /施設|事業所|所属/u.test(cell)
  );
  const tagIdx = h.findIndex((cell) =>
    /^(タグ|部署|部門|区分|カテゴリ|エリア|案件)$/u.test(cell) || /タグ|部署|ハッシュ|#/.test(cell)
  );
  let nameIdxOut = nameIdx;
  if (nameIdxOut < 0 && facilityIdx >= 0) {
    const idCol = facilityIdx + 1;
    const nameCol = facilityIdx + 2;
    const idHeader = normCell(headers[idCol] ?? '');
    const nameHeader = normCell(headers[nameCol] ?? '');
    if (
      (/^(社員|従業員|職員)$/u.test(idHeader) ||
        /(社員|従業員|職員).*(番号|no|id)/iu.test(idHeader) ||
        /(社員番号|従業員番号|職員番号|社員id|社員no)/iu.test(idHeader)) &&
      nameCol < headers.length
    ) {
      nameIdxOut = nameCol;
    } else if (nameCol < headers.length && /(就労時間|勤務時間|稼働時間)/u.test(nameHeader)) {
      // 按分シートでは「就労時間」列に氏名が入っているブックがあるため救済
      nameIdxOut = nameCol;
    }
  }
  return { nameIdx: nameIdxOut, statusIdx, facilityIdx, tagIdx };
}

/**
 * ヘッダ行を探す（1行目でなくても可）
 * @param {string[][]} rows
 */
function findHeaderRowIndex(rows) {
  const max = Math.min(45, rows?.length ?? 0);
  for (let r = 0; r < max; r++) {
    const headers = (rows[r] ?? []).map((c) => String(c ?? '').trim());
    const idx = findStaffHeaderIndices(headers);
    if (idx.nameIdx >= 0) return { headerRow: r, headers, idx };
  }

  // 按分シート等でヘッダ文字が崩れていても、列並び（所属, 社員番号, 氏名）から推定して救済
  const maxData = Math.min(120, rows?.length ?? 0);
  for (let r = 0; r < maxData; r++) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const c0 = String(row[0] ?? '').trim();
    const c1 = String(row[1] ?? '').trim();
    const c2 = String(row[2] ?? '').trim();
    if (!c0 || !c1 || !c2) continue;
    if (!/^\d{3,}$/.test(c1)) continue;
    if (/合計|小計|例[：:]|スタッフ名|氏名/u.test(c2)) continue;
    if (!/[一-龯々ぁ-んァ-ヶA-Za-z]/u.test(c2)) continue;
    const headerRow = Math.max(0, r - 1);
    const headers = (rows[headerRow] ?? []).map((c) => String(c ?? '').trim());
    return {
      headerRow,
      headers,
      idx: {
        nameIdx: 2,
        statusIdx: -1,
        facilityIdx: 0,
        tagIdx: headers.length > 5 ? 5 : -1,
      },
    };
  }

  throw new Error('スタッフ名（氏名）のヘッダ行が見つかりません。');
}

/**
 * @param {string[][]} rows
 * @returns {{ byFacility: Record<string, { id: string; name: string; department?: string }[]>; global: { id: string; name: string; department?: string }[] | null; meta: { rowCount: number; hasFacilityCol: boolean; hasTagCol: boolean } }}
 */
export function parseStaffRowsFromHrSheet(rows) {
  if (!rows?.length) {
    return {
      byFacility: {},
      global: [],
      meta: { rowCount: 0, hasFacilityCol: false, hasTagCol: false },
    };
  }
  const { headerRow, idx } = findHeaderRowIndex(rows);
  const hasFacilityCol = idx.facilityIdx >= 0;
  const hasTagCol = idx.tagIdx >= 0;
  /** 施設列またはタグ列のどちらかがあれば、施設別に振り分ける */
  const usePerFacility = hasFacilityCol || hasTagCol;
  const byFacility = {};
  const global = [];
  let rowCount = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const name = String(row[idx.nameIdx] ?? '').trim();
    if (!name) continue;
    if (/合計|小計|^氏名$|^スタッフ名$|例[：:]/u.test(name)) continue;

    const status = idx.statusIdx >= 0 ? String(row[idx.statusIdx] ?? '').trim() : '';
    if (idx.statusIdx >= 0 && !isActiveEmploymentStatus(status)) continue;

    const fac = hasFacilityCol ? String(row[idx.facilityIdx] ?? '').trim() : '';
    if (shouldExcludeHrFacilityBranch(fac)) continue;

    rowCount += 1;
    const baseId = `hr-${headerRow}-${r}-${normCell(name).slice(0, 20)}`;

    if (!usePerFacility) {
      global.push({ id: baseId, name, department: '' });
      continue;
    }

    const tag = hasTagCol ? String(row[idx.tagIdx] ?? '').trim() : '';
    if (!fac && !tag) {
      for (const f of CARELINK_FACILITIES) {
        if (!byFacility[f.linkKey]) byFacility[f.linkKey] = [];
        const department = resolveShiftDepartmentForHrRow(f.linkKey, fac, tag);
        byFacility[f.linkKey].push({ id: `${baseId}-${f.linkKey}`, name, department });
      }
      continue;
    }

    const lkList = linkKeysFromFacilityAndTags(fac, tag);
    if (lkList.length) {
      for (const lk of lkList) {
        if (!byFacility[lk]) byFacility[lk] = [];
        const department = resolveShiftDepartmentForHrRow(lk, fac, tag);
        byFacility[lk].push({ id: `${baseId}-${lk}`, name, department });
      }
    } else {
      if (!byFacility.__unmapped__) byFacility.__unmapped__ = [];
      byFacility.__unmapped__.push({ id: baseId, name, _facilityRaw: fac, _tagRaw: tag, department: '' });
    }
  }

  return {
    byFacility,
    global: usePerFacility ? null : global,
    meta: { rowCount, hasFacilityCol: hasFacilityCol || hasTagCol, hasTagCol },
  };
}

/**
 * 求人シートの行から「勤務希望・勤務表」用の (施設linkKey, 氏名, 部署) を組み立てる。
 * 部署は resolveShiftDepartmentForHrRow（タグ／施設セルにアプリの部署名が含まれること）で推定。
 * @param {string[][]} rows
 * @returns {{ items: { linkKey: string; staffName: string; department: string }[]; warnings: string[] }}
 */
export function parseHrRowsForShiftPreferenceSeed(rows) {
  /** @type {{ items: { linkKey: string; staffName: string; department: string }[]; warnings: string[] }} */
  const out = { items: [], warnings: [] };
  const pushWarn = (msg) => {
    if (out.warnings.length < 35) out.warnings.push(msg);
  };
  if (!rows?.length) {
    pushWarn('シートが空です。');
    return out;
  }

  let headerRow;
  let idx;
  try {
    const found = findHeaderRowIndex(rows);
    headerRow = found.headerRow;
    idx = found.idx;
  } catch (e) {
    pushWarn(e instanceof Error ? e.message : 'ヘッダ行を読めませんでした。');
    return out;
  }

  const hasFacilityCol = idx.facilityIdx >= 0;
  const hasTagCol = idx.tagIdx >= 0;
  if (!hasFacilityCol && !hasTagCol) {
    pushWarn('「施設」または「タグ／部署」列がないため、施設・部署別の取り込みができません。');
    return out;
  }

  const seen = new Set();
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const name = String(row[idx.nameIdx] ?? '').trim();
    if (!name) continue;
    if (/合計|小計|^氏名$|^スタッフ名$|例[：:]/u.test(name)) continue;

    const status = idx.statusIdx >= 0 ? String(row[idx.statusIdx] ?? '').trim() : '';
    if (idx.statusIdx >= 0 && !isActiveEmploymentStatus(status)) continue;

    const fac = hasFacilityCol ? String(row[idx.facilityIdx] ?? '').trim() : '';
    if (shouldExcludeHrFacilityBranch(fac)) continue;
    const tag = hasTagCol ? String(row[idx.tagIdx] ?? '').trim() : '';
    if (!fac && !tag) continue;

    const lkList = linkKeysFromFacilityAndTags(fac, tag);
    if (!lkList.length) {
      pushWarn(`「${name}」: 施設・タグからアプリの施設にマップできませんでした（${fac || '—'} / ${tag || '—'}）。`);
      continue;
    }

    for (const lk of lkList) {
      let department = resolveShiftDepartmentForHrRow(lk, fac, tag);
      const deptOpts = getShiftDepartmentsForLinkKey(lk).filter(Boolean);
      if (!department) {
        if (deptOpts.length === 1) {
          department = deptOpts[0];
        } else {
          pushWarn(
            `「${name}」（${lk}）: タグに勤務表の部署名（例: ${deptOpts.slice(0, 3).join('、')}）を含めてください。`
          );
          continue;
        }
      }
      if (!deptOpts.includes(department)) {
        pushWarn(`「${name}」: 部署「${department}」は ${lk} の候補外です。`);
        continue;
      }

      const dedupe = `${lk}\t${name}\t${department}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.items.push({ linkKey: lk, staffName: name, department });
    }
  }

  if (!out.items.length && !out.warnings.length) {
    pushWarn('在籍として有効な行が見つかりませんでした。');
  }
  return out;
}

function sheetRangeA1(sheetTitle, range) {
  const safe = `'${String(sheetTitle).replace(/'/g, "''")}'`;
  return `${safe}!${range}`;
}

/**
 * @param {string} apiKey
 * @param {string} spreadsheetId
 * @returns {Promise<{ sheetId: number; title: string; hidden: boolean }[]>}
 */
async function fetchSpreadsheetSheetsProperties(apiKey, spreadsheetId) {
  const sid = encodeURIComponent(spreadsheetId);
  const url = `${SHEETS_API}/${sid}?fields=sheets(properties(sheetId,title,hidden))&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      formatHrSheetsErrorMessage(data?.error?.message, 'スプレッドシートのタブ一覧が取得できません')
    );
  }
  return (data.sheets ?? [])
    .map((s) => ({
      sheetId: Number(s.properties?.sheetId),
      title: String(s.properties?.title ?? '').trim(),
      hidden: Boolean(s.properties?.hidden),
    }))
    .filter((x) => x.title);
}

/**
 * @param {string} apiKey
 * @param {string} spreadsheetId
 */
export async function fetchSpreadsheetSheetTitles(apiKey, spreadsheetId) {
  const props = await fetchSpreadsheetSheetsProperties(apiKey, spreadsheetId);
  return props.filter((p) => !p.hidden).map((p) => p.title);
}

/**
 * @param {{ sheetId: number; title: string; hidden: boolean }[]} props
 * @param {string} preferredSheetName
 * @param {string} preferredGid URL の #gid=
 */
function pickStaffSheetTitleWithGid(props, preferredSheetName = '', preferredGid = '') {
  const gid = String(preferredGid ?? '').trim();
  if (gid && /^\d+$/.test(gid)) {
    const n = parseInt(gid, 10);
    const hit = props.find((p) => p.sheetId === n);
    if (hit) return hit.title;
  }
  const visibleTitles = props.filter((p) => !p.hidden).map((p) => p.title);
  return pickStaffSheetTitle(visibleTitles, preferredSheetName);
}

/**
 * @param {string[]} titles
 * @param {string} [preferredSheetName] env や UI の上書き
 */
export function pickStaffSheetTitle(titles, preferredSheetName = '') {
  const pref = String(preferredSheetName ?? '').trim();
  if (pref && titles.includes(pref)) return pref;

  // 「求人」よりも、在籍者の按分/名簿タブを優先する
  const priority = [
    /按分|職員名簿|スタッフ名簿|社員名簿|名簿|在籍/u,
    /入退社|スタッフ|社員|人事/u,
    /求人|採用/u,
  ];
  for (const re of priority) {
    const hit = titles.find((t) => re.test(t));
    if (hit) return hit;
  }
  return titles[0] ?? '';
}

/**
 * @param {string} apiKey
 * @param {string} spreadsheetId
 * @param {string} sheetTitle
 */
async function fetchSheetValues(apiKey, spreadsheetId, sheetTitle, rangeA1 = 'A:ZZ') {
  const sid = encodeURIComponent(spreadsheetId);
  const a1 = encodeURIComponent(sheetRangeA1(sheetTitle, rangeA1));
  const url = `${SHEETS_API}/${sid}/values/${a1}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      formatHrSheetsErrorMessage(data?.error?.message, `シート「${sheetTitle}」の取得に失敗しました`)
    );
  }
  return data.values ?? [];
}

/**
 * 求人スプレッドシートを1回取得し、名簿用パースと勤務表シード用パースの両方に使う。
 * @param {string} apiKey
 * @param {{ preferredSheetTitle?: string }} [opts]
 */
export async function fetchHrStaffSheetBundle(apiKey, opts = {}) {
  const key = String(apiKey ?? '').trim();
  const id = getHrSpreadsheetId();
  if (!key) throw new Error('VITE_GOOGLE_SHEETS_API_KEY が必要です');

  const props = await fetchSpreadsheetSheetsProperties(key, id);
  if (!props.length) throw new Error('スプレッドシートにタブがありません');

  const gidEnv = import.meta.env.VITE_HR_STAFF_SHEET_GID?.trim() || DEFAULT_HR_STAFF_SHEET_GID;
  const envName = import.meta.env.VITE_HR_STAFF_SHEET_NAME?.trim() ?? '';
  const sheetTitle = pickStaffSheetTitleWithGid(props, opts.preferredSheetTitle || envName || '', gidEnv);
  if (!sheetTitle) {
    throw new Error(
      'スタッフ名簿のシート名を特定できません（VITE_HR_STAFF_SHEET_GID または VITE_HR_STAFF_SHEET_NAME を確認してください）'
    );
  }

  const rows = await fetchSheetValues(key, id, sheetTitle, 'A:ZZ');
  const roster = parseStaffRowsFromHrSheet(rows);
  const shiftSeed = parseHrRowsForShiftPreferenceSeed(rows);

  return {
    sheetTitle,
    spreadsheetId: id,
    roster,
    shiftSeed,
  };
}

/**
 * 求人シートからスタッフを読み、localStorage の同期名簿を更新
 * @param {string} apiKey
 * @param {{ preferredSheetTitle?: string }} [opts]
 */
export async function syncStaffRosterFromHrSheet(apiKey, opts = {}) {
  const bundle = await fetchHrStaffSheetBundle(apiKey, opts);
  return {
    sheetTitle: bundle.sheetTitle,
    spreadsheetId: bundle.spreadsheetId,
    ...bundle.roster,
    shiftSeed: bundle.shiftSeed,
    syncedAt: new Date().toISOString(),
  };
}
