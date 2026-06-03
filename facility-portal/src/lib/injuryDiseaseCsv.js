/**
 * カイポケ等の「傷病一覧」CSV → 利用者ごとの病名ラベル
 */

import { parseCsv } from '../services/GoogleSheetService.js';

/** @param {string} text */
function parseDelimitedImportText(text) {
  const t = String(text ?? '').replace(/^\uFEFF/, '');
  if (!t.trim()) return [];
  const firstLines = t.split(/\r?\n/).filter((l) => String(l).length > 0);
  if (!firstLines.length) return [];
  const tCount = firstLines.slice(0, 8).reduce((sum, l) => sum + (l.match(/\t/g) || []).length, 0);
  const cCount = firstLines.slice(0, 8).reduce((sum, l) => sum + (l.match(/,/g) || []).length, 0);
  if (tCount > 0 && tCount >= cCount) {
    return firstLines.map((line) => {
      if (String(line).includes('\t')) return String(line).split('\t');
      return [String(line)];
    });
  }
  return parseCsv(t);
}

/**
 * Shift_JIS 誤読を避け、傷病一覧のヘッダが読めるエンコーディングを選ぶ
 * @param {ArrayBuffer} buffer
 */
export function decodeInjuryDiseaseCsvFromBytes(buffer) {
  const u8 = new Uint8Array(buffer);
  const labels = ['shift_jis', 'windows-31j', 'utf-8', 'shift-jis', 'euc-jp'];
  /** @type {{ text: string; score: number }[]} */
  const scored = [];
  for (const label of labels) {
    let text = '';
    try {
      text = new TextDecoder(label, { fatal: false }).decode(u8);
    } catch {
      continue;
    }
    const rows = parseDelimitedImportText(text);
    const injuryLayout = findInjuryDiseaseCsvLayout(rows);
    const headSlice = text.slice(0, 16000);
    const ffd = (headSlice.match(/\uFFFD/g) || []).length;
    let jp = (headSlice.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/g) || []).length;
    let score = jp - ffd * 50;
    if (injuryLayout) score += 50000;
    if (/利用者名/u.test(headSlice) && /傷病名/u.test(headSlice)) score += 30000;
    scored.push({ text, score });
  }
  if (!scored.length) return new TextDecoder('utf-8', { fatal: false }).decode(u8);
  scored.sort((a, b) => b.score - a.score);
  return scored[0].text;
}

/** ファイル名から対象月 YYYY-MM（令和8年6月 → 2026-06） */
export function inferYmFromInjuryCsvFileName(fileName) {
  const s = String(fileName ?? '');
  const reiwa = /令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月/u.exec(s);
  if (reiwa) {
    const y = 2018 + parseInt(reiwa[1], 10);
    const mo = parseInt(reiwa[2], 10);
    if (Number.isFinite(y) && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2, '0')}`;
    }
  }
  const western = /(20\d{2})[年.\-_](\d{1,2})/.exec(s);
  if (western) {
    const y = parseInt(western[1], 10);
    const mo = parseInt(western[2], 10);
    if (mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, '0')}`;
  }
  return '';
}

/** CSV 内の有効期間(開始)から最多の YYYY-MM */
export function inferYmFromInjuryCsvRows(rows) {
  const layout = findInjuryDiseaseCsvLayout(rows);
  if (!layout) return '';
  const get = (row, col) => (col >= 0 && row?.[col] != null ? String(row[col]).replace(/^\uFEFF/, '').trim() : '');
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row?.length) continue;
    const start = parseSlashYmdDate(get(row, layout.startCol));
    if (!start) continue;
    const ym = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    counts.set(ym, (counts.get(ym) ?? 0) + 1);
  }
  let best = '';
  let max = 0;
  for (const [ym, c] of counts) {
    if (c > max) {
      max = c;
      best = ym;
    }
  }
  return best;
}

/** @param {string} raw */
export function normalizeInjuryCsvPersonName(raw) {
  let s = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\u3000/g, ' ')
    .replace(/[\s\u3000\t]+/g, ' ')
    .trim()
    .replace(/様\s*$/u, '');
  try {
    s = String(s).normalize('NFKC');
  } catch {
    /* noop */
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** @param {string} raw */
export function personNameKeyForInjuryMatch(raw) {
  const t = normalizeInjuryCsvPersonName(raw);
  return t.replace(/\s/g, '').replace(/・/g, '').replace(/･/g, '');
}

/** @param {string} raw */
function loosePersonNameKey(raw) {
  return personNameKeyForInjuryMatch(raw)
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]/gu, '')
    .toLowerCase();
}

/** @param {string} s */
function surnameKey(s) {
  const n = normalizeInjuryCsvPersonName(s);
  if (!n) return '';
  const first = n.split(' ')[0] || n;
  return personNameKeyForInjuryMatch(first);
}

/** @param {string} s 2026/05/01 等 */
export function parseSlashYmdDate(s) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(s ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** @param {string} ym YYYY-MM */
export function monthBoundsFromYm(ym) {
  const [y, m] = String(ym ?? '')
    .trim()
    .split('-')
    .map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return {
    start: new Date(y, m - 1, 1, 0, 0, 0, 0),
    end: new Date(y, m, 0, 23, 59, 59, 999),
  };
}

/** @param {Date | null} start @param {Date | null} end @param {{ start: Date; end: Date }} bounds */
function periodOverlapsMonth(start, end, bounds) {
  if (!start || !end || !bounds) return false;
  return start.getTime() <= bounds.end.getTime() && end.getTime() >= bounds.start.getTime();
}

/**
 * @param {string[][]} rows
 * @returns {{ headerRow: number; nameCol: number; kindCol: number; startCol: number; endCol: number; diseaseCol: number } | null}
 */
export function findInjuryDiseaseCsvLayout(rows) {
  const limit = Math.min(rows.length, 12);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map((c) =>
      String(c ?? '')
        .replace(/^\uFEFF/, '')
        .trim()
    );
    const nameCol = cells.findIndex((h) => /利用者名/u.test(h));
    const diseaseCol = cells.findIndex((h) => /傷病名/u.test(h));
    if (nameCol < 0 || diseaseCol < 0) continue;
    const kindCol = cells.findIndex((h) => /指示区分/u.test(h));
    const startCol = cells.findIndex((h) => /有効期間.*開始|開始/u.test(h));
    const endCol = cells.findIndex((h) => /有効期間.*終了|終了/u.test(h));
    return {
      headerRow: i,
      nameCol,
      kindCol,
      startCol,
      endCol,
      diseaseCol,
    };
  }
  if (rows.length >= 2) {
    const sample = rows[1] || [];
    if (sample.length >= 5 && parseSlashYmdDate(String(sample[2] ?? '')) && parseSlashYmdDate(String(sample[3] ?? ''))) {
      return {
        headerRow: 0,
        nameCol: 0,
        kindCol: 1,
        startCol: 2,
        endCol: 3,
        diseaseCol: 4,
      };
    }
  }
  return null;
}

/**
 * 利用者名 → 病名ラベル（読点区切り）。対象月と重なる「通常指示」を優先。
 * @param {string[][]} rows
 * @param {string} targetYm YYYY-MM（Record の対象月）
 * @returns {Map<string, string>} personNameKey → 病名
 */
/** @param {string[][]} rows @param {{ headerRow: number }} layout */
export function countInjuryDiseaseDataRows(rows, layout) {
  const get = (row, col) => (col >= 0 && row?.[col] != null ? String(row[col]).replace(/^\uFEFF/, '').trim() : '');
  let n = 0;
  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !String(c ?? '').trim())) continue;
    if (!get(row, layout.nameCol) && !get(row, layout.diseaseCol)) continue;
    n++;
  }
  return n;
}

export function buildInjuryDiseaseLabelMapFromRows(rows, targetYm) {
  const layout = findInjuryDiseaseCsvLayout(rows);
  const out = new Map();
  if (!layout) return out;
  const bounds = monthBoundsFromYm(targetYm);
  const get = (row, col) => (col >= 0 && row?.[col] != null ? String(row[col]).replace(/^\uFEFF/, '').trim() : '');

  /** @type {Map<string, { normal: Set<string>; other: Set<string> }>} */
  const acc = new Map();

  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !String(c ?? '').trim())) continue;
    const nameRaw = get(row, layout.nameCol);
    if (!nameRaw) continue;
    const key = personNameKeyForInjuryMatch(nameRaw);
    if (!key) continue;
    const disease = get(row, layout.diseaseCol);
    if (!disease) continue;
    const start = parseSlashYmdDate(get(row, layout.startCol));
    const end = parseSlashYmdDate(get(row, layout.endCol));
    if (bounds) {
      if (start && end) {
        if (!periodOverlapsMonth(start, end, bounds)) continue;
      } else if (start && !periodOverlapsMonth(start, start, bounds)) continue;
    }
    const kind = get(row, layout.kindCol);
    const bucket = acc.get(key) ?? { normal: new Set(), other: new Set() };
    if (kind === '通常指示' || /^通常/u.test(kind)) bucket.normal.add(disease);
    else bucket.other.add(disease);
    acc.set(key, bucket);
  }

  for (const [key, { normal, other }] of acc) {
    const list = normal.size > 0 ? [...normal] : [...other];
    if (list.length) out.set(key, list.join('、'));
  }
  return out;
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {Map<string, string>} nameKeyToLabel
 */
export function matchInjuryDiseaseMapToResidents(residents, nameKeyToLabel) {
  /** @type {Record<string, { label: string; nameKey: string }>} */
  const byId = {};
  let matched = 0;
  const matchedCsvKeys = new Set();
  const csvEntries = [...nameKeyToLabel.entries()];
  const csvLoose = csvEntries.map(([k, v]) => ({ key: k, loose: loosePersonNameKey(k), label: String(v ?? '') }));
  const updated = (residents || []).map((res) => {
    const id = String(res?.id ?? '').trim();
    const keys = [
      personNameKeyForInjuryMatch(res?.name),
      personNameKeyForInjuryMatch(res?.nameKana ?? res?.kana),
    ].filter(Boolean);
    let label = '';
    let matchedKey = '';
    for (const k of keys) {
      if (nameKeyToLabel.has(k)) {
        label = String(nameKeyToLabel.get(k));
        matchedKey = k;
        break;
      }
    }
    if (!label) {
      const nName = String(res?.name ?? '').trim();
      const looseKeys = [loosePersonNameKey(res?.name), loosePersonNameKey(res?.nameKana ?? res?.kana)].filter(Boolean);
      const sur = surnameKey(nName);
      /** @type {{ key: string; label: string } | null} */
      let fallback = null;
      for (const lk of looseKeys) {
        if (!lk || lk.length < 4) continue;
        const candidates = csvLoose.filter((x) => x.loose === lk || x.loose.includes(lk) || lk.includes(x.loose));
        if (candidates.length === 1) {
          fallback = { key: candidates[0].key, label: candidates[0].label };
          break;
        }
        if (!fallback && sur) {
          const surOnly = candidates.filter((x) => x.key.startsWith(sur));
          if (surOnly.length === 1) {
            fallback = { key: surOnly[0].key, label: surOnly[0].label };
            break;
          }
        }
      }
      if (fallback) {
        label = fallback.label;
        matchedKey = fallback.key;
      }
    }
    if (!label || !id) return res;
    matched++;
    if (matchedKey) matchedCsvKeys.add(matchedKey);
    byId[id] = { label, nameKey: matchedKey || keys[0] || '' };
    return { ...res, diseaseName: label, condition: label };
  });
  const csvNames = nameKeyToLabel.size;
  const unmatched = Math.max(0, csvNames - matched);
  const unmatchedNameKeys = csvEntries
    .map(([key]) => String(key))
    .filter((key) => key && !matchedCsvKeys.has(key));
  return { updated, byId, matched, csvNames, unmatched, unmatchedNameKeys };
}
