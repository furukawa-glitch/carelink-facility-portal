import {
  fetchSpreadsheetValuesByGid,
  fetchSpreadsheetValuesViaCsvExport,
} from '../services/GoogleSheetService.js';
import { enteralMenuSheetForFacility } from '../config/enteralNutritionMenuSheets.js';
import {
  buildPersonNameMatchCandidates,
  findResidentByPersonNameCandidates,
} from './residentNameMatch.js';
import {
  currentYmd,
  normalizeEnteralMedication,
  parseEnteralTimeFromText,
  loadEnteralMenuDraft,
  mergeEnteralMenuRows,
  saveEnteralMenuDraft,
} from './enteralNutritionMenu.js';
import { queueEnteralMenuCloudSync } from './facilityPortalStoreSync.js';

function normCell(s) {
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .trim();
}

function normalizeMed(v) {
  return normalizeEnteralMedication(normCell(v));
}

function slot(content, medication) {
  const raw = normCell(content);
  const { time, rest } = parseEnteralTimeFromText(raw);
  return { content: rest || raw, medication: normalizeMed(medication), time, shift: '' };
}

/**
 * @param {string[][]} rows
 */
export function parseEnteralNutritionMenuSheet(rows) {
  const grid = Array.isArray(rows) ? rows : [];
  let headerIdx = -1;
  let nameCol = 0;
  let morningCol = -1;
  let noonCol = -1;
  let eveningCol = -1;
  let medAfterMorning = -1;
  let medAfterNoon = -1;
  let medAfterEvening = -1;

  for (let r = 0; r < Math.min(25, grid.length); r++) {
    const row = (grid[r] || []).map(normCell);
    const joined = row.join(' ');
    if (!/氏名|名前/u.test(joined)) continue;
    if (!/朝|昼|夕|経管/u.test(joined)) continue;
    headerIdx = r;
    nameCol = row.findIndex((h) => /氏名|名前|利用者/u.test(h));
    if (nameCol < 0) nameCol = 0;
    for (let c = 0; c < row.length; c++) {
      const h = row[c];
      if (/^朝/u.test(h) || (h.includes('朝') && !h.includes('朝日'))) morningCol = c;
      if (/^昼/u.test(h) || h === '昼食') noonCol = c;
      if (/^夕/u.test(h) || h.includes('夕')) eveningCol = c;
    }
    const medCols = [];
    for (let c = 0; c < row.length; c++) {
      if (/^薬|服薬|内服/u.test(row[c])) medCols.push(c);
    }
    if (medCols.length >= 3) {
      medAfterMorning = medCols[0];
      medAfterNoon = medCols[1];
      medAfterEvening = medCols[2];
    } else if (morningCol >= 0) {
      medAfterMorning = morningCol + 1;
      if (noonCol < 0) noonCol = morningCol + 2;
      medAfterNoon = noonCol + 1;
      if (eveningCol < 0) eveningCol = noonCol + 2;
      medAfterEvening = eveningCol + 1;
    }
    if (morningCol < 0 && nameCol >= 0) {
      morningCol = nameCol + 1;
      medAfterMorning = nameCol + 2;
      noonCol = nameCol + 3;
      medAfterNoon = nameCol + 4;
      eveningCol = nameCol + 5;
      medAfterEvening = nameCol + 6;
    }
    break;
  }

  if (headerIdx < 0) {
    return { ok: false, error: '「氏名」「朝・昼・夕」の行が見つかりません。1行目付近の見出しを確認してください。' };
  }

  /** @type {Map<string, { morning: ReturnType<typeof slot>; noon: ReturnType<typeof slot>; evening: ReturnType<typeof slot>; note: string }>} */
  const byName = new Map();
  const footerLines = [];
  let legendNote = '';

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const nameRaw = normCell(row[nameCol]);
    if (!nameRaw) continue;
    if (/^(合計|計|凡例|※|ロング|ショート|更新|経管)/u.test(nameRaw) && nameRaw.length < 20) {
      const tail = row.map(normCell).filter(Boolean).join('　');
      if (tail) footerLines.push(tail);
      continue;
    }
    if (/^※/u.test(nameRaw)) {
      footerLines.push(nameRaw);
      continue;
    }
    if (nameRaw.length < 2) continue;
    if (/^\d+$/.test(nameRaw) && nameRaw.length <= 3) continue;

    const morning = slot(row[morningCol], row[medAfterMorning]);
    const noon = slot(row[noonCol], row[medAfterNoon]);
    const evening = slot(row[eveningCol], row[medAfterEvening]);
    const hasMenu = morning.content || noon.content || evening.content;
    if (!hasMenu) continue;

    const key = nameRaw.replace(/様\s*$/u, '').trim();
    byName.set(key, {
      morning,
      noon,
      evening,
      note: '',
    });
  }

  for (const line of footerLines) {
    if (/ロング|ショート|ピンク|オレンジ|日勤/u.test(line) && !legendNote) {
      legendNote = line;
    }
  }

  return {
    ok: true,
    byName,
    legendNote: legendNote || 'ロング　ショート　ピンク：朝日勤　オレンジ：夕日勤',
    footerNote: footerLines.filter((l) => /^※/u.test(l)).join('\n'),
    updatedYmd: currentYmd(),
  };
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {ReturnType<typeof parseEnteralNutritionMenuSheet>} parsed
 */
export function matchEnteralMenuImports(residents, parsed) {
  if (!parsed.ok) return { matched: [], unmatched: 0 };
  const list = Array.isArray(residents) ? residents : [];
  /** @type {import('./enteralNutritionMenu.js').EnteralMenuRow[]} */
  const matched = [];
  let unmatched = 0;

  for (const [nameKey, slots] of parsed.byName.entries()) {
    const res = findResidentByPersonNameCandidates(list, buildPersonNameMatchCandidates(nameKey));
    if (!res) {
      unmatched++;
      continue;
    }
    const nm = String(res.name ?? nameKey).trim();
    matched.push({
      residentId: String(res.id),
      name: nm.replace(/様\s*$/u, '') ? `${nm.replace(/様\s*$/u, '')} 様` : '—',
      room: String(res.room ?? '').trim(),
      included: true,
      morning: slots.morning,
      noon: slots.noon,
      evening: slots.evening,
      note: String(slots.note ?? '').trim(),
    });
  }
  return { matched, unmatched };
}

/**
 * @param {string} facilityLinkKey
 * @param {string} apiKey
 * @param {Record<string, unknown>[]} residents
 */
export async function importEnteralMenuFromSheet(facilityLinkKey, apiKey, residents) {
  const cfg = enteralMenuSheetForFacility(facilityLinkKey);
  if (!cfg) {
    return { ok: false, error: 'この施設の経管メニュー表の設定がありません' };
  }
  const key = String(apiKey ?? '').trim();

  let rows;
  try {
    rows = key
      ? await fetchSpreadsheetValuesByGid(
          cfg.spreadsheetId,
          key,
          cfg.sheetGid,
          cfg.rangeA1 ?? 'A1:ZZ200',
          { label: '経管メニュー表' }
        )
      : await fetchSpreadsheetValuesViaCsvExport(cfg.spreadsheetId, cfg.sheetGid, '経管メニュー表');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `${msg}（Excel の場合は共有を「閲覧可」にし、可能なら Googleスプレッドシートに変換してください）`,
    };
  }

  const parsed = parseEnteralNutritionMenuSheet(rows);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { matched, unmatched } = matchEnteralMenuImports(residents, parsed);
  if (!matched.length) {
    return {
      ok: false,
      error: `シートから ${parsed.byName.size} 名分は読めましたが、名簿と一致しませんでした。施設タブと氏名表記を確認してください。`,
      parsedCount: parsed.byName.size,
    };
  }

  const prev = loadEnteralMenuDraft(facilityLinkKey);
  /** @type {Map<string, import('./enteralNutritionMenu.js').EnteralMenuRow>} */
  const byId = new Map((prev.rows ?? []).map((r) => [String(r.residentId), r]));
  for (const m of matched) byId.set(String(m.residentId), m);
  const mergedRows = mergeEnteralMenuRows(residents, [...byId.values()], {
    enteralOnly: true,
    facilityLinkKey,
  });

  saveEnteralMenuDraft(facilityLinkKey, {
    updatedYmd: parsed.updatedYmd,
    footerNote: parsed.footerNote,
    legendNote: parsed.legendNote,
    rows: mergedRows,
  });

  queueEnteralMenuCloudSync(facilityLinkKey);
  void import('./facilityPortalStoreSync.js').then((m) => m.flushFacilityPortalStoresCloud());

  return {
    ok: true,
    matched: matched.length,
    unmatched,
    sheetNames: parsed.byName.size,
  };
}

export { enteralMenuBulkDefaultForResident } from './enteralNutritionMenu.js';
