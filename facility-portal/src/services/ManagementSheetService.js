/**
 * 売上・人件費管理シート（Google Sheets API）
 * .env: VITE_MANAGEMENT_SPREADSHEET_ID, VITE_GOOGLE_SHEETS_API_KEY,
 *       VITE_MANAGEMENT_SHEET_GID（任意）, VITE_TARGET_LABOR_RATIO_PCT（既定 50）
 */

import { CARELINK_FACILITIES, residentMatchesFacilityTab } from '../config/carelinkFacilities.js';
import { CARELINK_DEPARTMENT_SALES_SPREADSHEET_ID } from './GoogleSheetService.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const DEFAULT_TARGET_LABOR_RATIO_PCT = Number(import.meta.env.VITE_TARGET_LABOR_RATIO_PCT) || 50;

function normHeader(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s/g, '')
    .toLowerCase();
}

function colIndex(headers, candidates) {
  const n = headers.map(normHeader);
  for (const c of candidates) {
    const key = normHeader(c);
    const i = n.findIndex((h) => h === key || h.includes(key) || key.includes(h));
    if (i >= 0) return i;
  }
  return -1;
}

function parseNum(v) {
  if (v == null) return NaN;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return NaN;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchSheetTabs(apiKey, spreadsheetId) {
  const id = encodeURIComponent(spreadsheetId);
  const url = `${SHEETS_API}/${id}?fields=sheets(properties(sheetId,title,hidden))&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message ?? '経営シートのメタ取得に失敗');
  return (data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p) => p && !p.hidden)
    .map((p) => ({ title: p.title, sheetId: p.sheetId }));
}

async function fetchSheetValues(apiKey, spreadsheetId, sheetTitle) {
  const sid = encodeURIComponent(spreadsheetId);
  const safe = `'${String(sheetTitle).replace(/'/g, "''")}'`;
  const range = encodeURIComponent(`${safe}!A:ZZ`);
  const url = `${SHEETS_API}/${sid}/values/${range}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message ?? `経営シート「${sheetTitle}」取得失敗`);
  return data.values ?? [];
}

function rowMatchesLinkKey(facilityCell, linkKey) {
  const def = CARELINK_FACILITIES.find((f) => f.linkKey === linkKey);
  if (!def) return false;
  return residentMatchesFacilityTab(facilityCell, def.sheetTitle);
}

/**
 * 2行目以降を経営行として解析
 * @param {string[][]} rows
 * @returns {{ consolidated: { revenue: number; labor: number; ratioPct: number } | null; byLinkKey: Record<string, { revenue: number; labor: number; ratioPct: number }> }}
 */
export function parseManagementRows(rows) {
  const byLinkKey = {};
  if (!rows?.length) return { consolidated: null, byLinkKey };

  const headers = rows[0].map((h) => String(h ?? '').trim());
  const ixFac = colIndex(headers, ['施設', '施設名', '事業所', '拠点', 'ホーム']);
  const ixRev = colIndex(headers, ['売上', '売上高', '売上金額', 'revenue', '売上(千円)']);
  const ixLab = colIndex(headers, ['人件費', '人件費計', '給与', '労務費', 'labor']);

  if (ixRev < 0 || ixLab < 0) {
    throw new Error('経営シートに「売上」「人件費」に相当する列がありません');
  }

  let consolidated = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
    const rev = parseNum(row[ixRev]);
    const lab = parseNum(row[ixLab]);
    if (!Number.isFinite(rev) || rev <= 0) continue;
    const ratioPct = (lab / rev) * 100;

    const facCell = ixFac >= 0 ? String(row[ixFac] ?? '').trim() : '';

    if (!facCell || ixFac < 0) {
      consolidated = { revenue: rev, labor: lab, ratioPct };
      continue;
    }

    for (const def of CARELINK_FACILITIES) {
      if (rowMatchesLinkKey(facCell, def.linkKey)) {
        byLinkKey[def.linkKey] = { revenue: rev, labor: lab, ratioPct };
        break;
      }
    }
  }

  return { consolidated, byLinkKey };
}

/**
 * 人件費率が目標以下なら求人可
 * @param {number} ratioPct
 * @param {number} targetPct
 */
export function isJobPostingAllowedByLaborRatio(ratioPct, targetPct = DEFAULT_TARGET_LABOR_RATIO_PCT) {
  if (!Number.isFinite(ratioPct)) return { allowed: false, reason: '人件費率が算出できません' };
  if (ratioPct <= targetPct) return { allowed: true, reason: `人件費率 ${ratioPct.toFixed(1)}% ≤ 目標 ${targetPct}%` };
  return {
    allowed: false,
    reason: `人件費率 ${ratioPct.toFixed(1)}% が目標 ${targetPct}% を超過`,
  };
}

export function getMetricsForFacility(parsed, linkKey) {
  if (parsed.byLinkKey[linkKey]) return parsed.byLinkKey[linkKey];
  if (parsed.consolidated) return parsed.consolidated;
  return null;
}

export function evaluateFacilityRecruitment(parsed, linkKey, targetPct = DEFAULT_TARGET_LABOR_RATIO_PCT) {
  const m = getMetricsForFacility(parsed, linkKey);
  if (!m) {
    return {
      allowed: false,
      ratioPct: null,
      reason: '当該施設の経営行がシートに見つかりません（施設列または全体行を確認）',
    };
  }
  const { allowed, reason } = isJobPostingAllowedByLaborRatio(m.ratioPct, targetPct);
  return { allowed, ratioPct: m.ratioPct, revenue: m.revenue, labor: m.labor, reason };
}

/**
 * @returns {Promise<{ rows: string[][]; parsed: ReturnType<typeof parseManagementRows> }>}
 */
export async function fetchManagementSheetData() {
  const apiKey = (import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '').trim();
  const spreadsheetId = String(
    import.meta.env.VITE_MANAGEMENT_SPREADSHEET_ID ?? CARELINK_DEPARTMENT_SALES_SPREADSHEET_ID ?? ''
  ).trim();
  if (!apiKey) throw new Error('VITE_GOOGLE_SHEETS_API_KEY が必要です');
  if (!spreadsheetId) throw new Error('VITE_MANAGEMENT_SPREADSHEET_ID（または VITE_DEPARTMENT_SALES_SHEET_ID）を設定してください');

  const gidRaw = import.meta.env.VITE_MANAGEMENT_SHEET_GID;
  const gidTrim = gidRaw != null ? String(gidRaw).trim() : '';

  let sheetTitle;
  if (gidTrim) {
    const sheetIdNum = parseInt(gidTrim, 10);
    if (Number.isNaN(sheetIdNum)) throw new Error('VITE_MANAGEMENT_SHEET_GID は数値');
    const tabs = await fetchSheetTabs(apiKey, spreadsheetId);
    const tab = tabs.find((t) => t.sheetId === sheetIdNum);
    if (!tab) throw new Error(`経営シート sheetId ${gidTrim} が見つかりません`);
    sheetTitle = tab.title;
  } else {
    const tabs = await fetchSheetTabs(apiKey, spreadsheetId);
    if (!tabs.length) throw new Error('経営シートにタブがありません');
    sheetTitle = tabs[0].title;
  }

  const rows = await fetchSheetValues(apiKey, spreadsheetId, sheetTitle);
  const parsed = parseManagementRows(rows);
  return { rows, parsed, sheetTitle };
}

const MODEL = 'gemini-2.5-flash';

/**
 * @param {string} apiKey
 * @param {{ targetPct: number; parsed: ReturnType<typeof parseManagementRows>; shortfalls: Record<string, string> }} ctx
 */
export async function askAiRecruitmentJudgment(apiKey, ctx) {
  if (!apiKey?.trim()) {
    return 'VITE_GEMINI_API_KEY 未設定のため、ルール判定のみ参照してください。';
  }

  const summary = CARELINK_FACILITIES.map((f) => {
    const ev = evaluateFacilityRecruitment(ctx.parsed, f.linkKey, ctx.targetPct);
    const need = ctx.shortfalls[f.linkKey] ?? '0';
    return `${f.tabLabel}: 不足${need}名 / 人件費率${ev.ratioPct != null ? ev.ratioPct.toFixed(1) + '%' : '—'} / 求人可=${ev.allowed ? 'Yes' : 'No'} (${ev.reason})`;
  }).join('\n');

  const prompt = `あなたは介護事業の経営企画です。以下の数値とルールに基づき、「今すぐ AirWORK に求人を出してよいか」を施設ごとに1行ずつ、簡潔に経営判断で答えてください。

ルール: 人件費率が目標 ${ctx.targetPct}% 以下のときのみ求人掲載を推奨。超過時はコスト抑制を優先し代替策に言及。

データ:
${summary}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    }),
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data?.error?.message ?? 'AI応答なし');
  return text.trim();
}
