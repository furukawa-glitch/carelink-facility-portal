import { fetchSpreadsheetValuesByGid } from './GoogleSheetService.js';

/** @param {string} cell */
function cleanTempCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s === '℃' || /^[℃°\s]+$/u.test(s)) return '';
  return s.replace(/[℃°]/g, '').trim();
}

/** @param {string} cell */
function cleanSpo2Cell(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s === '%' || /^[%％\s]+$/u.test(s)) return '';
  return s.replace(/[%％]/g, '').trim();
}

/** @param {string} cell */
function parseBpFromSheetCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s === '/') return { bpUpper: '', bpLower: '' };
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(s);
  if (m) return { bpUpper: m[1], bpLower: m[2] };
  return { bpUpper: s.replace(/[^\d.]/g, ''), bpLower: '' };
}

/** @param {string} cell */
function isPlaceholderOnly(cell) {
  const s = String(cell ?? '').trim();
  return !s || s === '/' || s === '℃' || s === '%';
}

/**
 * 往診ノートシートの生データからヘッダ・データ行を解析（愛西様式: 氏名/Kt/P/BP/SPO2/備考/往診時記入欄）
 * @param {string[][]} values
 */
export function parseHomeVisitNoteSheetValues(values) {
  const rows = Array.isArray(values) ? values : [];
  let headerRow = -1;
  let nameCol = -1;
  let roomCol = -1;
  let remarkCol = -1;
  let visitEntryCol = -1;
  const vitalCols = {
    temp: -1,
    bp: -1,
    bpUpper: -1,
    bpLower: -1,
    pulse: -1,
    spo2: -1,
    weight: -1,
  };

  /** @type {string} */
  let headerTitle = '';
  for (let r = 0; r < Math.min(6, rows.length); r++) {
    const joined = (rows[r] || [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .join(' ');
    if (/往診ノート/u.test(joined)) {
      headerTitle = joined;
      break;
    }
  }

  for (let r = 0; r < Math.min(25, rows.length); r++) {
    const line = rows[r] || [];
    for (let c = 0; c < line.length; c++) {
      const cell = String(line[c] ?? '').trim();
      if (!cell) continue;
      if (nameCol < 0 && /^氏名$/u.test(cell)) {
        headerRow = r;
        nameCol = c;
      } else if (nameCol < 0 && /^(利用者名|利用者|名前)$/u.test(cell)) {
        headerRow = r;
        nameCol = c;
      }
      if (/^(部屋|居室|室番|室)$/u.test(cell)) roomCol = c;
      if (/^KT$/i.test(cell) || (cell === 'KT')) vitalCols.temp = c;
      if (/^P$/i.test(cell) && cell.length <= 2) vitalCols.pulse = c;
      if (/^BP$/i.test(cell)) vitalCols.bp = c;
      if (/^SPO2$/i.test(cell) || cell === 'SPO2') vitalCols.spo2 = c;
      if (/備考/u.test(cell) && remarkCol < 0) remarkCol = c;
      if (/往診時記入/u.test(cell)) visitEntryCol = c;
      if (/体温/u.test(cell) && !/血圧|目標/i.test(cell) && vitalCols.temp < 0) vitalCols.temp = c;
      if (/血圧.*(上|高)|収縮|最高/u.test(cell)) vitalCols.bpUpper = c;
      if (/血圧.*(下|低)|拡張|最低/u.test(cell)) vitalCols.bpLower = c;
      if (/脈拍|pulse|心拍/iu.test(cell) && vitalCols.pulse < 0) vitalCols.pulse = c;
      if (/spo2|酸素|ＳｐＯ2/i.test(cell) && vitalCols.spo2 < 0) vitalCols.spo2 = c;
      if (/体重|weight/i.test(cell) && !/血圧|目標/i.test(cell)) vitalCols.weight = c;
      if (/^(メモ|所見|往診メモ)$/u.test(cell) && visitEntryCol < 0) visitEntryCol = c;
    }
    if (headerRow >= 0 && nameCol >= 0) break;
  }

  /** @type {string[]} */
  const memoLines = [];
  const memoEnd = headerRow > 0 ? headerRow : Math.min(4, rows.length);
  for (let r = 0; r < memoEnd; r++) {
    const line = (rows[r] || [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .join(' ');
    if (line && !/^No\.?$/i.test(line) && line !== headerTitle) memoLines.push(line);
  }

  const getCell = (line, col) => (col >= 0 ? String(line[col] ?? '').trim() : '');

  /** @type {{ name: string; room: string; remark: string; visitEntry: string; note: string; temp: string; bpUpper: string; bpLower: string; pulse: string; spo2: string; weight: string }[]} */
  const parsed = [];
  if (headerRow >= 0 && nameCol >= 0) {
    for (let r = headerRow + 1; r < rows.length; r++) {
      const line = rows[r] || [];
      const name = getCell(line, nameCol).replace(/\s*様\s*$/u, '').trim();
      if (!name) continue;
      if (/^(合計|計|氏名|小計|往診)/u.test(name)) continue;
      const tempRaw = getCell(line, vitalCols.temp);
      const pulseRaw = getCell(line, vitalCols.pulse);
      const spo2Raw = getCell(line, vitalCols.spo2);
      const bpFromCol =
        vitalCols.bp >= 0
          ? parseBpFromSheetCell(getCell(line, vitalCols.bp))
          : {
              bpUpper: getCell(line, vitalCols.bpUpper),
              bpLower: getCell(line, vitalCols.bpLower),
            };
      const remark = getCell(line, remarkCol);
      const visitEntry = getCell(line, visitEntryCol);
      const hasVital =
        !isPlaceholderOnly(tempRaw) ||
        !isPlaceholderOnly(pulseRaw) ||
        !isPlaceholderOnly(spo2Raw) ||
        Boolean(bpFromCol.bpUpper || bpFromCol.bpLower);
      if (!hasVital && !remark && !visitEntry && /^\d+$/.test(name)) continue;

      parsed.push({
        name,
        room: getCell(line, roomCol),
        remark,
        visitEntry,
        note: visitEntry || remark,
        temp: cleanTempCell(tempRaw),
        bpUpper: bpFromCol.bpUpper,
        bpLower: bpFromCol.bpLower,
        pulse: isPlaceholderOnly(pulseRaw) ? '' : pulseRaw.replace(/[^\d.]/g, '') || pulseRaw,
        spo2: cleanSpo2Cell(spo2Raw),
        weight: getCell(line, vitalCols.weight),
      });
    }
  }

  return {
    headerTitle,
    facilityMemo: [headerTitle, ...memoLines].filter(Boolean).join(' / '),
    rows: parsed,
    headerRow,
    nameCol,
  };
}

/**
 * @param {import('../config/homeVisitNoteSpreadsheet.js').HomeVisitNoteSheetConfig} cfg
 * @param {string} apiKey
 */
export async function fetchHomeVisitNoteSheet(cfg, apiKey) {
  const values = await fetchSpreadsheetValuesByGid(
    cfg.spreadsheetId,
    apiKey,
    cfg.sheetGid,
    'A1:AZ300'
  );
  return parseHomeVisitNoteSheetValues(values);
}
