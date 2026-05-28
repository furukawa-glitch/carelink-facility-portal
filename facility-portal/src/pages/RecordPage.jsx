import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Ambulance,
  Baby,
  BarChart3,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ClipboardList,
  Clock,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FileWarning,
  Home,
  LayoutGrid,
  Loader2,
  Megaphone,
  MessageSquarePlus,
  Mic,
  Monitor,
  PenLine,
  RefreshCw,
  Smartphone,
  Sparkles,
  Stethoscope,
  Table2,
  Upload,
  Wind,
  X,
} from 'lucide-react';
import {
  CARELINK_RESIDENT_SPREADSHEET_ID,
  careLevelScoreForAverageCareLevel,
  fetchResidentsFromSheet,
  formatCareLevelForDisplay,
  getAverageCareLevelFromSheetSummary,
  getMedicalTargetCountFromSheetSummary,
  getResidentCountFromSheetSummary,
  normalizeCareLevelLabel,
  parseCsv,
} from '../services/GoogleSheetService.js';
import {
  CARELINK_FACILITIES,
  compactFacilityToken,
  dayServiceModeForFacilityLinkKey,
  facilityDefBySheetTitle,
  linkKeyForSheetTitle,
  residentBelongsToFacilityTab,
} from '../config/carelinkFacilities.js';
import {
  getExternalLinksForFacility,
  getGoogleCalendarIdForFacility,
  hasGoogleCalendarForFacility,
} from '../config/facilityIntegrations.js';
import {
  composeEnsureLine,
  composeMealAmountForLog,
  getQuickCareMealEventKind,
  parseHourlyStoolCellValue,
} from '../lib/careQuickCareFields.js';
import { buildHourlyCareFromEvents, tokyoDateHourToIso, tokyoHourFromTs } from '../lib/hourlyCareGrid.js';
import { parsePharmacyMedicationPdf } from '../lib/pharmacyMedicationPdf.js';
import { normalizePatrolDateTimeLocal } from '../lib/patrolSlots.js';
import { AccidentMonthlyAnalysisModal } from '../components/AccidentMonthlyAnalysisModal.jsx';
import { AccidentReportModal } from '../components/AccidentReportModal.jsx';
import { NearMissAwarenessAdminModal } from '../components/NearMissAwarenessAdminModal.jsx';
import { NearMissAwarenessPanel } from '../components/NearMissAwarenessPanel.jsx';
import { NearMissMonthlyAnalysisModal } from '../components/NearMissMonthlyAnalysisModal.jsx';
import { NearMissReportModal } from '../components/NearMissReportModal.jsx';
import { ResidentBulkInputTable } from '../components/ResidentBulkInputTable.jsx';
import { ResidentInfoProvisionModal } from '../components/ResidentInfoProvisionModal.jsx';
import { VitalHandwritingModal } from '../components/VitalHandwritingModal.jsx';
import { isNursingOfficeUiEnabled } from '../services/NearMissLedgerService.js';
import { fetchFacilityCalendarEvents } from '../services/GoogleCalendarService.js';
import * as Report from '../services/ReportService.js';

/** 名簿に「様」付きで入っているときの重複を避ける */
function residentNameWithoutSama(nameRaw) {
  return String(nameRaw ?? '')
    .replace(/様\s*$/u, '')
    .trim();
}

/** 一覧入力・保存後にクリアするケア項目（バイタル列は残す） */
const BULK_CARE_RESET = Object.freeze({
  patrol: false,
  patrolAt: '',
  meal: false,
  excretion: false,
  urineVolume: '',
  stoolVolume: '',
  stoolCharacter: '',
  mealSlot: '',
  mealStaple: '',
  mealSide: '',
  waterMl: '',
  medicationTaken: '',
  toiletGuidance: false,
  ensurePortion: '',
  /** 経管栄養の内容（製剤・量・本剤/水分など）— 保存で enteral ログ */
  enteralMenu: '',
  /** 間食・補助食など自由記述（パン、バナナ等）— 食事メモに連結 */
  mealExtras: '',
});
const BULK_DRAFT_LS_KEY = 'carelink_os_bulk_table_draft_v1';

function readBulkDraftStore() {
  try {
    const raw = localStorage.getItem(BULK_DRAFT_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeBulkDraftStore(store) {
  try {
    localStorage.setItem(BULK_DRAFT_LS_KEY, JSON.stringify(store && typeof store === 'object' ? store : {}));
  } catch {
    // localStorage が使えない環境は黙って無視
  }
}

function makeBulkDraftScopeKey(facilityLinkKey, selectedSheetTitle, ymd) {
  const f = String(facilityLinkKey ?? '').trim();
  const s = String(selectedSheetTitle ?? '').trim();
  const d = String(ymd ?? '').trim();
  return `${f || s || 'unknown'}::${d || 'unknown'}`;
}

function freshHourly24() {
  return Array(24).fill(false);
}
function freshHourlyText24() {
  return Array(24).fill('');
}
function normalizeHourlyText24(v) {
  if (!Array.isArray(v) || v.length !== 24) return freshHourlyText24();
  return v.map((x) => {
    if (x === true) return 'plain';
    if (x === false || x == null) return '';
    return String(x).trim();
  });
}

/** カイポケ等 CSV のセル先頭の BOM 除去 */
function stripCsvBom(s) {
  return String(s ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
}

/** バイタルCSVの氏名セルを名簿照合向けに正規化（全角スペース・連続空白・様 等） */
function normalizeVitalsImportPersonName(cellRaw) {
  let s = stripCsvBom(String(cellRaw ?? ''))
    .replace(/\u3000/g, ' ')
    .replace(/[\s\u3000\t]+/g, ' ')
    .trim();
  s = residentNameWithoutSama(s);
  try {
    s = String(s).normalize('NFKC');
  } catch {
    /* noop */
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {string} csvNameCell
 */
function normalizeNameKeyForMatch(s) {
  const t = normalizeVitalsImportPersonName(String(s ?? ''));
  return t.replace(/\s/g, '').replace(/・/g, '').replace(/･/g, '');
}

function findResidentForVitalsCsvName(residents, csvNameCell) {
  const target = normalizeVitalsImportPersonName(csvNameCell);
  if (!target) return null;
  const targetCompact = target.replace(/\s/g, '');
  const targetKey = normalizeNameKeyForMatch(csvNameCell);
  for (const res of residents) {
    const n = normalizeVitalsImportPersonName(String(res.name ?? ''));
    if (n && (n === target || n.replace(/\s/g, '') === targetCompact)) return res;
    const nk = normalizeNameKeyForMatch(n);
    if (nk && targetKey.length >= 2 && nk === targetKey) return res;
    const k = String(res.kana ?? res.nameKana ?? res.namePhonetic ?? '').trim();
    if (k) {
      const kn = normalizeVitalsImportPersonName(k);
      if (kn && (kn === target || kn.replace(/\s/g, '') === targetCompact)) return res;
      const kk = normalizeNameKeyForMatch(k);
      if (kk && targetKey.length >= 2 && kk === targetKey) return res;
    }
  }
  return null;
}

function findResidentForVitalsCsvKana(residents, csvKanaCell) {
  const target = normalizeVitalsImportPersonName(csvKanaCell);
  if (!target) return null;
  const targetCompact = target.replace(/\s/g, '');
  const targetKey = normalizeNameKeyForMatch(csvKanaCell);
  for (const res of residents) {
    const k = String(res.kana ?? res.nameKana ?? res.namePhonetic ?? '').trim();
    if (!k) continue;
    const kn = normalizeVitalsImportPersonName(k);
    if (kn && (kn === target || kn.replace(/\s/g, '') === targetCompact)) return res;
    const kk = normalizeNameKeyForMatch(k);
    if (kk && targetKey.length >= 2 && kk === targetKey) return res;
  }
  return null;
}

/**
 * カイポケ・帳票出力の列名揺れに合わせて「氏名」列の 0 始まり index（無いとき -1）
 * @param {string[]} headerCells
 */
function findNameColumnIndexInHeaders(headerCells) {
  const h = headerCells.map((c) => stripCsvBom(String(c ?? '')).trim());
  if (!h.length) return -1;
  const isFuriganaHeader = (c) =>
    /(フリガナ|ふりがな|名\(カタカナ|カナ\)|^カタカナ|^かな$)/u.test(c) && !/氏名/iu.test(c);
  /** カイポケ訪問記録等：列見出しが「利用者」単独のとき */
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (!c || isFuriganaHeader(c)) continue;
    if (/フリガナ|ふりがな$/u.test(c) || /カナ$/u.test(c)) continue;
    if (/^(利用者|対象者|被介護者)$/u.test(c)) return i;
  }
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (!c || isFuriganaHeader(c)) continue;
    if (/(利用者|入居|入所|顧客|患者|被保険者|本人)(の|・|)?(氏名|名)/u.test(c)) return i;
  }
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (!c || isFuriganaHeader(c)) continue;
    if (/^氏名$/u.test(c) || /^(表示名|おなまえ|お名前|名前)$/u.test(c) || c === '利用者名' || c === '入居者名') {
      return i;
    }
  }
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (!c || isFuriganaHeader(c)) continue;
    if (/(^|[^ァ-ヶぁ-んＡ-ＺＡ-Ｚａ-ｚ])氏名/u.test(c) && !/氏名(フリガナ|ふりがな)/u.test(c)) {
      return i;
    }
  }
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (!c || isFuriganaHeader(c)) continue;
    if (/(^name$|^Name$|resident( name|name)?|client name|full name|利用者$|入居者$|本人$)/iu.test(c)) {
      return i;
    }
  }
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (!c || isFuriganaHeader(c)) continue;
    if (/(利用者|入居者)氏名/iu.test(c)) return i;
  }
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (!c || isFuriganaHeader(c)) continue;
    if (/(ご)?利用者[\s　]*(氏名|お名前|名前)/u.test(c)) return i;
    if (/^(本名|漢字氏名|氏名（漢字）)$/u.test(c)) return i;
  }
  return -1;
}

/**
 * カイポケ等が Shift_JIS / CP932 で出力する CSV を UTF-8 誤読しないようバイトから解読
 * @param {ArrayBuffer} buffer
 */
function decodeKaipokeImportTextFromBytes(buffer) {
  const u8 = new Uint8Array(buffer);
  const labels = ['utf-8', 'shift_jis', 'shift-jis', 'windows-31j', 'euc-jp', 'iso-2022-jp'];
  /** @type {{ text: string; score: number }[]} */
  const scored = [];
  for (const label of labels) {
    let text = '';
    try {
      text = new TextDecoder(label, { fatal: false }).decode(u8);
    } catch {
      continue;
    }
    const rows = parseVitalsImportDelimitedText(text);
    const layout = findCsvDataLayout(rows, { requireVitalsColumns: false });
    const headSlice = text.slice(0, 16000);
    const ffd = (headSlice.match(/\uFFFD/g) || []).length;
    let jp = (headSlice.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/g) || []).length;
    if (layout) {
      const hdr = (rows[layout.headerRow] || []).join('\t');
      jp += (hdr.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/g) || []).length * 3;
    }
    let score = jp - ffd * 40;
    if (layout) score += 8000;
    scored.push({ text, score });
  }
  if (!scored.length) return new TextDecoder('utf-8', { fatal: false }).decode(u8);
  scored.sort((a, b) => b.score - a.score);
  return scored[0].text;
}

/**
 * ヘッダ行に、取り込み対象のバイタル系列がいくつあるか（体温・血圧上下・脈拍・SpO2・体重・排便・排尿）
 * @param {string[]} cells
 */
function countVitalHeaderColumns(cells) {
  let n = 0;
  for (const h of cells) {
    const hn = String(h ?? '').trim();
    if (!hn) continue;
    if (/血圧|目標/i.test(hn)) continue;
    if (/体温/u.test(hn)) n++;
    else if (/血圧.*(上|高)|収縮|1回目：収縮|最高/u.test(hn)) n++;
    else if (/血圧.*(下|低)|拡張|1回目：拡張|最低/u.test(hn)) n++;
    else if (/脈拍|1回目：脈拍|pulse|心拍/iu.test(hn)) n++;
    else if (/spo2|酸素|ｓｐｏ|ＳｐＯ2|SpO2|ＳＰＯ2/i.test(hn)) n++;
    else if (/体重|weight/i.test(hn) && !/血圧|目標/i.test(hn)) n++;
    else if (/排便.*(日時|時刻|時間)|最終排便|排便日時|排便（日時）|排便記録/u.test(hn)) n++;
    else if (/排尿.*(記録|内容|コメント)|^排尿$/u.test(hn)) n++;
  }
  return n;
}

/**
 * 月次用CSV：カイポケ訪問記録などの列見出しから index マップ
 * @param {string[]} headers
 */
function buildMonthlyCsvFieldIndexes(headers) {
  const h = (headers || []).map((x) => stripCsvBom(String(x ?? '')).trim());
  const ix = (pred) => h.findIndex(pred);
  return {
    day: ix((c) => /^日付$/u.test(c)),
    dow: ix((c) => /^曜日$/u.test(c)),
    office: ix((c) => /事業所名/u.test(c)),
    staff1: ix((c) => /^職員名1$/u.test(c)),
    staff2: ix((c) => /^職員名2$/u.test(c)),
    svcType: ix((c) => /業務種別/u.test(c)),
    svcBody: ix((c) => /サービス内容/u.test(c)),
    start: ix((c) => /^開始時間$/u.test(c)),
    end: ix((c) => /^終了時間$/u.test(c)),
  };
}

/** デイ予定CSV：日付列の揺れに合わせた index（訪問記録形式と共用） */
function buildDayServiceCsvFieldIndexes(headers) {
  const monthly = buildMonthlyCsvFieldIndexes(headers);
  const h = (headers || []).map((x) => stripCsvBom(String(x ?? '')).trim());
  const ix = (pred) => h.findIndex(pred);
  const serviceDate = ix((c) => /実施日|サービス提供日|利用日|提供日|サービス日/u.test(c));
  const dayCol = serviceDate >= 0 ? serviceDate : monthly.day;
  const svcName = ix((c) => /サービス名|サービス名称|メニュー/u.test(c));
  return { ...monthly, dayCol: dayCol >= 0 ? dayCol : monthly.day, svcName };
}

/** @param {string} raw @param {string} defaultYm YYYY-MM */
function parseCsvDateCellToYmd(raw, defaultYm) {
  const s = stripCsvBom(String(raw ?? '')).trim();
  if (!s) return '';
  const mFull = /^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})/.exec(s.replace(/年|月|日/g, '/'));
  if (mFull) {
    return `${mFull[1]}-${String(mFull[2]).padStart(2, '0')}-${String(mFull[3]).padStart(2, '0')}`;
  }
  if (defaultYm && /^\d{1,2}$/.test(s)) {
    return `${defaultYm}-${String(s).padStart(2, '0')}`;
  }
  const mShort = /^(\d{1,2})[\/.\-](\d{1,2})$/.exec(s);
  if (mShort && defaultYm) {
    return `${defaultYm}-${String(mShort[1]).padStart(2, '0')}-${String(mShort[2]).padStart(2, '0')}`;
  }
  return '';
}

/**
 * @param {string[]} row
 * @param {ReturnType<typeof buildDayServiceCsvFieldIndexes>} idx
 * @param {(row: string[], i: number) => string} getCell
 */
function csvRowLooksLikeDayService(row, idx, getCell) {
  const cols = [idx.svcBody, idx.svcType, idx.svcName].filter((c) => typeof c === 'number' && c >= 0);
  if (!cols.length) return false;
  const joined = cols.map((c) => getCell(row, c)).join('\n');
  if (!joined.trim()) return false;
  return /デイ|通所|短期|ﾃﾞｲ|リハ|DAY|day\s*service/iu.test(joined);
}

/** @param {string} ymd @param {number} add */
function addCalendarDaysYmd(ymd, add) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return '';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(add || 0));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** @param {Date} d */
function todayYmdFromDate(d) {
  const x = d instanceof Date ? d : new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/**
 * @param {string[]} row
 * @param {Record<string, number>} idxMap
 * @param {string} auditYm YYYY-MM
 */
function monthlyImportRowBelongsToYm(row, idxMap, auditYm) {
  const di = idxMap.day;
  if (di == null || di < 0) return true;
  const raw = stripCsvBom(String(row[di] ?? '')).trim();
  if (!raw) return true;
  const mFull = /^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})/.exec(raw.replace(/年|月|日/g, '/'));
  if (mFull) {
    const y = mFull[1];
    const mo = String(mFull[2]).padStart(2, '0');
    return `${y}-${mo}` === auditYm;
  }
  if (/^\d{1,2}$/.test(raw)) return true;
  return true;
}

/**
 * 「月次用CSV」はカイポケ訪問記録形式向け。訪問看護の勤務スケジュール等は別帳票のため誤選択が多い。
 * @param {string} fileName
 */
function looksLikeVisitNursingScheduleCsvFileName(fileName) {
  const s = String(fileName ?? '');
  if (!s.trim()) return false;
  const hasSched = /スケジュール|シフト|当番|勤務表/u.test(s);
  const hasVn = /訪問看護|訪看|VN|vn/u.test(s);
  return hasSched && hasVn;
}

/**
 * @param {string[]} row
 * @param {Record<string, number>} idxMap
 * @param {string} auditYm
 */
function formatMonthlyImportSummaryLine(row, idxMap, auditYm) {
  const g = (k) => {
    const i = idxMap[k];
    if (i == null || i < 0) return '';
    return stripCsvBom(String(row[i] ?? '')).trim();
  };
  const day = g('day');
  const datePart =
    day && /^\d{1,2}$/.test(day)
      ? `${auditYm}-${String(day).padStart(2, '0')}`.replace(/-/g, '/')
      : day || '';
  const staff = [g('staff1'), g('staff2')].filter(Boolean).join('・');
  const segs = [
    datePart,
    g('dow'),
    g('office'),
    g('svcType'),
    g('svcBody'),
    [g('start'), g('end')].filter(Boolean).join('〜'),
    staff ? `担当:${staff}` : '',
  ].filter(Boolean);
  return segs.join(' ／ ');
}

/**
 * データ行の先頭（ヘッダ行 index と氏名列）
 * @param {string[][]} rows
 * @param {{ requireVitalsColumns?: boolean }} [options] 既定 true＝バイタル取込。false＝月次用（訪問記録のみ可）
 * @returns {{ headerRow: number; nameCol: number } | null}
 */
function findCsvDataLayout(rows, options = {}) {
  const requireVitals = options.requireVitalsColumns !== false;
  /** @type {{ headerRow: number; nameCol: number; score: number }[]} */
  const candidates = [];
  for (let r = 0; r < Math.min(30, rows.length); r++) {
    const line = rows[r];
    if (!line || line.length < 2) continue;
    const nameCol = findNameColumnIndexInHeaders(line);
    if (nameCol < 0) continue;
    const cells = line.map((c) => stripCsvBom(String(c ?? '')).trim());
    const nonEmpty = cells.filter((c) => c !== '').length;
    if (nonEmpty < 2) continue;
    const vitalN = countVitalHeaderColumns(cells);
    if (requireVitals && vitalN < 1) continue;
    const joined = cells.join('\t');
    let score = nonEmpty;
    if (requireVitals) {
      score += vitalN * 120;
      if (/職員名/.test(joined) && cells.some((c) => /^利用者$/u.test(c))) score += 25;
      if (/開始時間|終了時間|提供時間/u.test(joined)) score += 15;
      if (/事業所名|業務種別|サービス内容/u.test(joined)) score += 10;
    } else {
      score += vitalN * 50;
      if (/職員名/.test(joined) && cells.some((c) => /^利用者$/u.test(c))) score += 220;
      if (/開始時間|終了時間|提供時間/u.test(joined)) score += 100;
      if (/事業所名|業務種別|サービス内容/u.test(joined)) score += 55;
      if (/体温|血圧|脈拍/u.test(joined)) score += 35;
    }
    candidates.push({ headerRow: r, nameCol, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return { headerRow: candidates[0].headerRow, nameCol: candidates[0].nameCol };
}

/**
 * カイポケは TSV やタイトル行1行＋本ヘッダのことがある
 * @param {string} text
 */
function parseVitalsImportDelimitedText(text) {
  const t = String(text ?? '').replace(/^\uFEFF/, '');
  if (!t.trim()) return [];
  const firstLines = t
    .split(/\r\n|\n|\r/u)
    .filter((l) => String(l).length > 0);
  if (!firstLines.length) return [];
  const tCount = firstLines.slice(0, 8).reduce((sum, l) => sum + (l.match(/\t/g) || []).length, 0);
  const cCount = firstLines.slice(0, 8).reduce((sum, l) => sum + (l.match(/,/g) || []).length, 0);
  if (tCount > 0 && tCount >= cCount) {
    return firstLines.map((line) => {
      if (String(line).includes('\t')) return String(line).split('\t');
      // 1列だけ（タブ無し行）: 1セル
      return [String(line)];
    });
  }
  return parseCsv(t);
}

/** @param {string} k */
function insuranceCategoryChipClass(k) {
  if (k === '医療保険特指示')
    return 'border-amber-500 bg-amber-100 text-amber-950 ring-2 ring-amber-400/70';
  if (k === '医療') return 'border-emerald-600 bg-emerald-50 text-emerald-950 ring-1 ring-emerald-300';
  if (k === '未設定') return 'border-slate-300 bg-slate-100 text-slate-800';
  return 'border-sky-500 bg-white text-sky-950 shadow-sm ring-1 ring-sky-200';
}

const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY ?? '';
const SHEETS_KEY = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '';

const MONITOR_BOARD_BY_FACILITY = {};

const MONITOR_BOARD_FALLBACK = {
  notice:
    '【周知】インフルエンザ流行に伴い、面会はマスク着用でお願いします。異常時はナースステーションへ連絡ください。',
  handover: '【申し送り】夜勤より：特記事項なし（サンプル）。',
  schedule: [
    { time: '10:00', title: '面会（サンプル）' },
    { time: '14:30', title: '往診（サンプル）' },
  ],
};

function boardForFacilityLinkKey(linkKey) {
  const k = String(linkKey ?? '').trim();
  const base = k && MONITOR_BOARD_BY_FACILITY[k] ? MONITOR_BOARD_BY_FACILITY[k] : MONITOR_BOARD_FALLBACK;
  const storedNotice = k ? Report.getFacilityNotice(k) : '';
  const storedHandover = k ? Report.getFacilityHandoverNote(k) : '';
  return {
    ...base,
    notice: storedNotice.trim() ? storedNotice : base.notice,
    handover: storedHandover.trim() ? storedHandover : base.handover,
  };
}

function ExternalToolButton({ href, icon: Icon, children, disabled, layout = 'stack' }) {
  const isHash = !href || href === '#';
  const inline = layout === 'inline';
  return (
    <a
      href={isHash ? undefined : href}
      target={isHash ? undefined : '_blank'}
      rel={isHash ? undefined : 'noopener noreferrer'}
      onClick={(e) => isHash && e.preventDefault()}
      className={`flex min-h-[3.25rem] items-center justify-center gap-2 rounded-2xl border-2 px-2 py-2 text-center font-bold transition-all xl:min-h-0 xl:py-4 ${
        inline ? 'flex-1 flex-row' : 'flex-1 flex-col gap-1 xl:flex-none'
      } ${
        isHash
          ? 'cursor-not-allowed border-slate-600 bg-slate-800/50 text-slate-500'
          : 'border-cyan-500/40 bg-slate-800 text-cyan-100 hover:border-cyan-400 hover:bg-slate-700'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <Icon className={`shrink-0 stroke-[2] ${inline ? 'h-5 w-5' : 'h-6 w-6 xl:h-7 xl:w-7'}`} />
      <span className={`leading-tight ${inline ? 'text-sm' : 'text-sm xl:text-base'}`}>{children}</span>
      {!isHash && !inline && <ExternalLink className="h-3.5 w-3.5 opacity-60" aria-hidden />}
    </a>
  );
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @param {unknown} value */
function toEventIsoOrNow(value) {
  const s = String(value ?? '').trim();
  if (!s) return new Date().toISOString();
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return new Date().toISOString();
  return new Date(t).toISOString();
}

/** 一覧表の対象日（空なら今日） */
function bulkTableYmd(bulkSheetDate) {
  const s = String(bulkSheetDate ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return currentYmd();
}

/** vital_snapshot の meta を一覧表のバイタル列用に変換 */
function vitalFieldsFromSnapshotMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    temp: m.temp != null ? String(m.temp) : '',
    bpU: m.bpUpper != null ? String(m.bpUpper) : '',
    bpL: m.bpLower != null ? String(m.bpLower) : '',
    pulse: m.pulse != null ? String(m.pulse) : '',
    spo2: m.spo2 != null ? String(m.spo2) : '',
    weight: m.weight != null ? String(m.weight) : '',
  };
}

/** 対象日の最終 vital_snapshot から一覧表1行分のバイタル初期値（当日でログが無いときは LS の直近スナップ） */
function vitalSeedForBulkTableRow(residentId, bulkSheetDate) {
  const ymd = bulkTableYmd(bulkSheetDate);
  const rid = String(residentId ?? '');
  const fromEvents = vitalFieldsFromSnapshotMeta(Report.getLatestVitalSnapshotMetaForResidentDay(rid, ymd));
  const hasAny = Object.values(fromEvents).some((v) => String(v ?? '').trim() !== '');
  if (!hasAny && ymd === currentYmd()) {
    const snap = Report.getResidentVitalSnapshot(rid);
    return vitalFieldsFromSnapshotMeta(snap);
  }
  return fromEvents;
}

function localDateTimeForInput(ts) {
  const t = new Date(ts);
  if (!Number.isFinite(t.getTime())) return '';
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  const h = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${mm}`;
}

/** 保存済みログから一覧入力行の初期値を復元（対象日） */
function bulkCareSeedForResidentDay(residentId, bulkSheetDate) {
  const ymd = bulkTableYmd(bulkSheetDate);
  const rid = String(residentId ?? '').trim();
  if (!rid) return { ...BULK_CARE_RESET };
  const events = Report.getCareEventsForResidentDay(rid, ymd);
  const seed = { ...BULK_CARE_RESET };
  for (const ev of events) {
    const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
    if (ev?.type === 'patrol') {
      seed.patrol = true;
      const dt = normalizePatrolDateTimeLocal(localDateTimeForInput(ev?.ts));
      if (dt) seed.patrolAt = dt;
    } else if (ev?.type === 'excretion') {
      seed.excretion = true;
      if (meta.urineVolume != null && String(meta.urineVolume).trim() !== '') seed.urineVolume = String(meta.urineVolume);
      if (meta.stoolVolume != null && String(meta.stoolVolume).trim() !== '') seed.stoolVolume = String(meta.stoolVolume);
      if (meta.stoolCharacter != null && String(meta.stoolCharacter).trim() !== '') seed.stoolCharacter = String(meta.stoolCharacter);
      if (meta.toiletGuidance === true) seed.toiletGuidance = true;
    } else if (ev?.type === 'meal') {
      seed.meal = true;
      if (meta.mealSlot != null && String(meta.mealSlot).trim() !== '') seed.mealSlot = String(meta.mealSlot);
      if (meta.mealAmount != null && String(meta.mealAmount).trim() !== '') seed.mealAmount = String(meta.mealAmount);
      if (meta.waterMl != null && String(meta.waterMl).trim() !== '') seed.waterMl = String(meta.waterMl);
      if (meta.medicationTaken === 'yes' || meta.medicationTaken === 'no') seed.medicationTaken = meta.medicationTaken;
    } else if (ev?.type === 'fluid_intake') {
      if (meta.waterMl != null && String(meta.waterMl).trim() !== '') seed.waterMl = String(meta.waterMl);
    } else if (ev?.type === 'enteral') {
      if (meta.note != null && String(meta.note).trim() !== '') seed.enteralMenu = String(meta.note);
    }
  }
  return seed;
}

/** 24時間表（巡視・尿・便）の保存済み値を対象日から復元 */
function hourlyDraftSeedForResidentDay(residentId, bulkSheetDate) {
  const ymd = bulkTableYmd(bulkSheetDate);
  const rid = String(residentId ?? '').trim();
  const out = {
    hourPatrol: freshHourly24(),
    hourUrine: freshHourlyText24(),
    hourStool: freshHourlyText24(),
  };
  if (!rid) return out;
  const events = Report.getCareEventsForResidentDay(rid, ymd);
  for (const ev of events) {
    const h = tokyoHourFromTs(ev?.ts);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    const typ = String(ev?.type ?? '');
    const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
    const note = String(meta.note ?? '').trim();
    if (typ === 'patrol') {
      out.hourPatrol[h] = true;
      continue;
    }
    if (typ !== 'hourly_excretion' && typ !== 'excretion') continue;
    const hourlyKind = String(meta.hourlyKind ?? '').trim();
    const u = String(meta.urineVolume ?? '').trim();
    const sv = String(meta.stoolVolume ?? '').trim();
    const sc = String(meta.stoolCharacter ?? '').trim();
    if (hourlyKind === 'urine' || /排尿（\d{2}時）/u.test(note)) out.hourUrine[h] = u || 'plain';
    if (hourlyKind === 'stool' || /排便（\d{2}時）/u.test(note)) {
      out.hourStool[h] = sv || sc ? `${sv || ''}\t${sc || ''}` : 'plain';
    }
  }
  return out;
}

function emptyEmergencyDraft() {
  return {
    senderOffice: '',
    senderAddress: '',
    senderTel: '',
    senderNurse: '',
    primaryDoctor: '',
    medicalAgency: '',
    medicalAddress: '',
    dailyLife: '',
    nurseProblems: '',
    acuteChange: '',
    nurseContent: '',
    careNotes: '',
    other: '',
  };
}

/**
 * @param {{
 *   onSelectResident: (res: Record<string, unknown>) => void;
 *   onBack: () => void;
 *   onOpenMonthlyReport: () => void;
 *   onOpenNotionNewResidents?: () => void;
 *   onResidentsSync?: (list: Record<string, unknown>[]) => void;
 *   initialSheetTitle?: string;
 * }} props
 */
export function RecordPage({
  onSelectResident,
  onBack,
  onOpenMonthlyReport,
  onOpenNotionNewResidents,
  onResidentsSync,
  initialSheetTitle,
}) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(/** @type {Date | null} */ (null));
  const [fetchSourceMeta, setFetchSourceMeta] = useState(
    /** @type {{ source: string; mode: string } | null} */ (null)
  );
  const [allResidents, setAllResidents] = useState(/** @type {Record<string, unknown>[]} */ ([]));
  const [selectedSheetTitle, setSelectedSheetTitle] = useState(() => {
    const t = String(initialSheetTitle ?? '').trim();
    if (t && CARELINK_FACILITIES.some((f) => f.sheetTitle === t)) return t;
    return CARELINK_FACILITIES[0].sheetTitle;
  });
  const [tick, setTick] = useState(0);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener('carelink-staff-profile', bump);
    return () => window.removeEventListener('carelink-staff-profile', bump);
  }, []);

  const [nursingDraft, setNursingDraft] = useState('');
  const [nursingStartDate, setNursingStartDate] = useState(currentYmd);
  const [nursingEndDate, setNursingEndDate] = useState('');
  const [nursingRev, setNursingRev] = useState(0);
  const [planDraftDate, setPlanDraftDate] = useState(currentYmd);
  const [planDraftTime, setPlanDraftTime] = useState('10:00');
  const [planDraftType, setPlanDraftType] = useState('外出');
  const [planDraftTitle, setPlanDraftTitle] = useState('');
  const [planRev, setPlanRev] = useState(0);
  const [monitorMuteRev, setMonitorMuteRev] = useState(0);
  const [googleCalendarPlanRev, setGoogleCalendarPlanRev] = useState(0);
  const [googleCalendarReloadRev, setGoogleCalendarReloadRev] = useState(0);
  const [googleCalendarStatus, setGoogleCalendarStatus] = useState(
    /** @type {'idle' | 'loading' | 'ok' | 'disabled' | 'error'} */ ('idle')
  );
  const [googleCalendarPlansByDate, setGoogleCalendarPlansByDate] = useState(
    /** @type {Map<string, { id: string; time: string; type: string; title: string; source?: string }[]>} */ (new Map())
  );
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [infoProvisionOpen, setInfoProvisionOpen] = useState(false);
  const [infoProvisionInitialResidentId, setInfoProvisionInitialResidentId] = useState(/** @type {string | null} */ (null));
  const [infoProvisionInitialActiveTab, setInfoProvisionInitialActiveTab] = useState(
    /** @type {'import' | 'view' | null} */ (null)
  );
  const [emergencyPickId, setEmergencyPickId] = useState('');
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [accidentReportOpen, setAccidentReportOpen] = useState(false);
  const [accidentMonthlyOpen, setAccidentMonthlyOpen] = useState(false);
  const [nearMissOpen, setNearMissOpen] = useState(false);
  const [nearMissMonthlyOpen, setNearMissMonthlyOpen] = useState(false);
  const [nearMissAwarenessAdminOpen, setNearMissAwarenessAdminOpen] = useState(false);
  const [emergencyDraft, setEmergencyDraft] = useState(emptyEmergencyDraft);
  const [dictatingField, setDictatingField] = useState('');
  const dictationRef = useRef(/** @type {SpeechRecognition | null} */ (null));

  const [calOpenId, setCalOpenId] = useState('');
  const [auditMonth, setAuditMonth] = useState(currentYearMonth);

  /** 'cards' | 'table' — 一覧表でバイタル・巡視等をまとめて入力 */
  const [residentInputView, setResidentInputView] = useState(/** @type {'cards' | 'table'} */ ('cards'));
  /** 入居者一覧の並び順 */
  const [residentSortMode, setResidentSortMode] = useState(/** @type {'room' | 'kana'} */ ('room'));
  /** 入居者一覧の名前検索（確定文字列のみで絞り込み。IME 変換中は絞り込まない） */
  const [residentNameQuery, setResidentNameQuery] = useState('');
  /** 検索欄の表示値（変換中の仮入力を含む） */
  const [residentNameInput, setResidentNameInput] = useState('');
  const residentNameCompositionRef = useRef(false);
  /** 一覧表：今回の食事区分（朝・昼・夜）を全員に共通適用 */
  const [bulkGlobalMealSlot, setBulkGlobalMealSlot] = useState('昼');
  /** 一覧表の24時間グリッド・時間別ログの対象日（ローカル暦） */
  const [bulkSheetDate, setBulkSheetDate] = useState(() => currentYmd());
  const [bulkDraft, setBulkDraft] = useState(
    /** @type {Record<string, { temp: string; bpU: string; bpL: string; pulse: string; spo2: string; patrol: boolean; meal: boolean; excretion: boolean }>} */ ({})
  );
  const [kaipokeImportStatus, setKaipokeImportStatus] = useState(
    /** @type {{ kind: 'vitals' | 'monthly' | 'dayservice' | 'medpdf'; ok: boolean; message: string; at: number; fileName: string } | null} */ (
      null
    )
  );
  const kaipokeCsvInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const kaipokeMonthlyCsvInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const kaipokeDayServiceCsvInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const medicationPdfInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const [daySvcExternalFor, setDaySvcExternalFor] = useState(/** @type {Record<string, unknown> | null} */ (null));
  const [daySvcExternalDraft, setDaySvcExternalDraft] = useState(/** @type {Record<string, boolean>} */ ({}));
  /** カード「周囲事項」手入力の再描画用（localStorage 更新後にインクリメント） */
  const [surroundMemoRev, setSurroundMemoRev] = useState(0);
  const [surroundTextEditId, setSurroundTextEditId] = useState('');
  const [surroundDraftText, setSurroundDraftText] = useState('');
  const [surroundHandwritingId, setSurroundHandwritingId] = useState('');

  const selectedDef = useMemo(
    () => facilityDefBySheetTitle(selectedSheetTitle),
    [selectedSheetTitle]
  );
  const selectedFacilityLinkKey = String(selectedDef?.linkKey ?? '').trim();
  const bulkDraftScopeKey = useMemo(
    () => makeBulkDraftScopeKey(selectedFacilityLinkKey, selectedSheetTitle, bulkTableYmd(bulkSheetDate)),
    [selectedFacilityLinkKey, selectedSheetTitle, bulkSheetDate]
  );
  const visitCalendarConfigured = useMemo(
    () => hasGoogleCalendarForFacility(selectedFacilityLinkKey),
    [selectedFacilityLinkKey]
  );
  const facilityDayServiceMode = useMemo(
    () => dayServiceModeForFacilityLinkKey(selectedFacilityLinkKey),
    [selectedFacilityLinkKey]
  );

  useEffect(() => {
    let canceled = false;
    const run = async () => {
      const apiKey = String(import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '').trim();
      const calendarId = getGoogleCalendarIdForFacility(selectedFacilityLinkKey);
      if (!selectedFacilityLinkKey || !apiKey || !calendarId) {
        setGoogleCalendarPlansByDate(new Map());
        setGoogleCalendarPlanRev((n) => n + 1);
        setGoogleCalendarStatus(!selectedFacilityLinkKey || !apiKey ? 'disabled' : 'disabled');
        return;
      }
      setGoogleCalendarStatus('loading');
      try {
        const rows = await fetchFacilityCalendarEvents({ apiKey, calendarId, days: 7 });
        if (canceled) return;
        const map = new Map();
        for (const e of rows) {
          const ymd = String(e?.ymd ?? '').trim();
          if (!ymd) continue;
          const arr = map.get(ymd) ?? [];
          arr.push({
            id: `gcal:${String(e?.id ?? '')}`,
            time: String(e?.time ?? '').trim(),
            type: String(e?.type ?? '予定').trim() || '予定',
            title: String(e?.title ?? '').trim() || '予定',
            source: 'google_calendar',
          });
          map.set(ymd, arr);
        }
        for (const [d, arr] of map.entries()) {
          arr.sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? ''), 'ja'));
          map.set(d, arr);
        }
        setGoogleCalendarPlansByDate(map);
        setGoogleCalendarPlanRev((n) => n + 1);
        setGoogleCalendarStatus('ok');
      } catch {
        if (canceled) return;
        setGoogleCalendarPlansByDate(new Map());
        setGoogleCalendarPlanRev((n) => n + 1);
        setGoogleCalendarStatus('error');
      }
    };
    run();
    return () => {
      canceled = true;
    };
  }, [selectedFacilityLinkKey, tick, googleCalendarReloadRev]);

  const { filteredResidents, residentFilterBanner } = useMemo(() => {
    const matched = allResidents.filter((r) => residentBelongsToFacilityTab(r, selectedSheetTitle));
    if (matched.length > 0) {
      return { filteredResidents: matched, residentFilterBanner: null };
    }
    if (allResidents.length === 0) {
      return { filteredResidents: matched, residentFilterBanner: null };
    }

    /** CSV 等: タブ名・施設列が付かない名簿はタブ照合で0件になるため全件表示 */
    const lacksTabBinding = (r) => {
      const f = String(r.facility ?? '').trim();
      return !String(r.sourceSheetTitle ?? '').trim() && (!f || f === '施設未設定');
    };
    if (allResidents.every(lacksTabBinding)) {
      return { filteredResidents: allResidents, residentFilterBanner: null };
    }

    /**
     * 名簿の読み込み元タブが1種類だけ（単一CSV／単一gid／VITE_CSV_DEFAULT_SHEET_TITLE）のとき、
     * 施設列の表記が UI の施設タブと一致しないと0件になるため全件表示する。
     */
    const sources = new Set(
      allResidents.map((r) => String(r.sourceSheetTitle ?? '').trim()).filter(Boolean)
    );
    if (sources.size <= 1) {
      return { filteredResidents: allResidents, residentFilterBanner: null };
    }

    /**
     * 複数タブ読込: タブ名の「核」で突き合わせ（表記ゆれ）
     */
    const core = compactFacilityToken(selectedSheetTitle);
    if (core) {
      const loose = allResidents.filter((r) => {
        const src = String(r.sourceSheetTitle ?? '').trim();
        const fac = String(r.facility ?? '').trim();
        return (
          (src && compactFacilityToken(src) === core) ||
          (fac && compactFacilityToken(fac) === core)
        );
      });
      if (loose.length > 0) {
        return { filteredResidents: loose, residentFilterBanner: null };
      }
    }

    /**
     * それでも0件なら全件表示（施設タブとスプレッドシートのタブ名がずれている場合の救済）
     */
    return {
      filteredResidents: allResidents,
      residentFilterBanner:
        '施設タブと名簿の照合ができなかったため、読み込んだ全利用者を表示しています。ポータルで施設を切り替えるか、carelinkFacilities.js の sheetTitle を実際のタブ名に合わせてください。',
    };
  }, [allResidents, selectedSheetTitle]);

  const displayResidents = useMemo(() => {
    const q = String(residentNameQuery ?? '').trim();
    const base =
      q.length === 0
        ? filteredResidents
        : filteredResidents.filter((r) => {
            const name = String(r.name ?? '').trim();
            const nameNoSama = residentNameWithoutSama(r.name);
            const kana = String(r.kana ?? r.nameKana ?? r.namePhonetic ?? '').trim();
            return name.includes(q) || nameNoSama.includes(q) || kana.includes(q);
          });
    const list = [...base];
    const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
    const roomSortKey = (v) => {
      const s = String(v ?? '').trim();
      const m = s.match(/\d+/);
      if (!m) return Number.MAX_SAFE_INTEGER;
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    };
    if (residentSortMode === 'kana') {
      list.sort((a, b) => {
        const ak = String(a.kana ?? a.nameKana ?? a.namePhonetic ?? a.name ?? '').trim();
        const bk = String(b.kana ?? b.nameKana ?? b.namePhonetic ?? b.name ?? '').trim();
        const byKana = collator.compare(ak, bk);
        if (byKana !== 0) return byKana;
        return collator.compare(String(a.name ?? ''), String(b.name ?? ''));
      });
      return list;
    }
    list.sort((a, b) => {
      const ra = roomSortKey(a.room);
      const rb = roomSortKey(b.room);
      if (ra !== rb) return ra - rb;
      return collator.compare(String(a.room ?? ''), String(b.room ?? ''));
    });
    return list;
  }, [filteredResidents, residentSortMode, residentNameQuery]);

  /** 一覧表・24時間グリッド用（保存済みログからマスを埋める） */
  const bulkHourlySavedByResident = useMemo(() => {
    const m = {};
    const ymd = bulkTableYmd(bulkSheetDate);
    for (const r of displayResidents) {
      const id = String(r.id);
      m[id] = buildHourlyCareFromEvents(Report.getCareEventsForResidentDay(id, ymd), ymd);
    }
    return m;
  }, [displayResidents, bulkSheetDate, tick]);

  /** 一覧表先頭表示用: 当日の食事（朝・昼・夜）の最新保存値 */
  const bulkMealSummaryByResident = useMemo(() => {
    const ymd = bulkTableYmd(bulkSheetDate);
    const out = {};
    for (const r of displayResidents) {
      const id = String(r.id);
      const slots = { 朝: '', 昼: '', 夜: '' };
      const events = Report.getCareEventsForResidentDay(id, ymd);
      for (const ev of events) {
        if (String(ev?.type ?? '') !== 'meal') continue;
        const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
        const slot = String(meta.mealSlot ?? '').trim();
        if (slot !== '朝' && slot !== '昼' && slot !== '夜') continue;
        const amount = String(meta.mealAmount ?? '').trim();
        slots[slot] = amount || '食事記録';
      }
      out[id] = slots;
    }
    return out;
  }, [displayResidents, bulkSheetDate, tick]);

  const displayResidentsForBulkHydrateRef = useRef(displayResidents);
  displayResidentsForBulkHydrateRef.current = displayResidents;
  const bulkGlobalMealSlotHydrateRef = useRef(bulkGlobalMealSlot);
  bulkGlobalMealSlotHydrateRef.current = bulkGlobalMealSlot;

  /** 対象日または一覧表示への切替時に、バイタル・24h下書きをその日のログに合わせる */
  useEffect(() => {
    if (residentInputView !== 'table') return;
    const ymd = bulkTableYmd(bulkSheetDate);
    const list = displayResidentsForBulkHydrateRef.current;
    const mealSlot = bulkGlobalMealSlotHydrateRef.current;
    const storedAll = readBulkDraftStore();
    const storedRows = storedAll[bulkDraftScopeKey] && typeof storedAll[bulkDraftScopeKey] === 'object' ? storedAll[bulkDraftScopeKey] : {};
    setBulkDraft((prev) => {
      const next = { ...prev };
      for (const r of list) {
        const id = String(r.id);
        const stored = storedRows[id] && typeof storedRows[id] === 'object' ? storedRows[id] : {};
        next[id] = {
          ...(prev[id] || {}),
          ...vitalSeedForBulkTableRow(id, ymd),
          ...bulkCareSeedForResidentDay(id, ymd),
          mealSlot,
          ...hourlyDraftSeedForResidentDay(id, ymd),
          vitalHandwritingDataUrl: '',
          ...stored,
        };
      }
      const keep = new Set(list.map((x) => String(x.id)));
      for (const k of Object.keys(next)) {
        if (!keep.has(k)) delete next[k];
      }
      return next;
    });
  }, [bulkSheetDate, residentInputView, bulkDraftScopeKey]);

  /** 一覧入力の下書きを施設×日付ごとに保存（保存押し忘れの復元用） */
  useEffect(() => {
    if (residentInputView !== 'table') return;
    const keep = new Set(displayResidents.map((r) => String(r.id)));
    const scoped = {};
    for (const [id, row] of Object.entries(bulkDraft ?? {})) {
      if (!keep.has(String(id))) continue;
      scoped[id] = row;
    }
    const store = readBulkDraftStore();
    store[bulkDraftScopeKey] = scoped;
    // ストレージ肥大化防止: 直近 21 スコープだけ保持
    const keys = Object.keys(store);
    if (keys.length > 21) {
      keys.sort();
      for (const k of keys.slice(0, keys.length - 21)) delete store[k];
    }
    writeBulkDraftStore(store);
  }, [residentInputView, bulkDraft, bulkDraftScopeKey, displayResidents]);

  const insuranceBreakdown = useMemo(() => {
    const m = {};
    for (const r of filteredResidents) {
      const c = String(r.insuranceCategory ?? '未設定').trim() || '未設定';
      m[c] = (m[c] ?? 0) + 1;
    }
    return m;
  }, [filteredResidents]);

  const insuranceBreakdownLabel = useMemo(() => {
    const order = [
      '後期高齢',
      '国保',
      '協会けんぽ',
      '組合健保',
      '公費・その他',
      '医療保険特指示',
      '医療',
      'その他',
      '未設定',
    ];
    const parts = [];
    for (const k of order) {
      const n = insuranceBreakdown[k];
      if (n) parts.push(`${k} ${n}名`);
    }
    for (const k of Object.keys(insuranceBreakdown)) {
      if (!order.includes(k) && insuranceBreakdown[k]) parts.push(`${k} ${insuranceBreakdown[k]}名`);
    }
    return parts.length ? parts.join(' ・ ') : '—';
  }, [insuranceBreakdown]);

  const insuranceMedicalSummary = useMemo(() => {
    const total = filteredResidents.length;
    const unset = insuranceBreakdown['未設定'] ?? 0;
    const recorded = total - unset;
    const kohi = insuranceBreakdown['後期高齢'] ?? 0;
    const medicalNonKohi = Math.max(0, recorded - kohi);
    return { total, unset, recorded, kohi, medicalNonKohi };
  }, [filteredResidents, insuranceBreakdown]);

  /** 名簿の要介護1〜5の平均（要支援・自立は含めない）／医療保険対象列の入居済み医療対象人数 */
  const facilityCareStats = useMemo(() => {
    let scoreSum = 0;
    let scoreN = 0;
    const sheetMedicalTarget = getMedicalTargetCountFromSheetSummary(selectedSheetTitle);
    const sheetAvgCareLevel = getAverageCareLevelFromSheetSummary(selectedSheetTitle);
    let medicalTargetCount = 0;
    for (const r of filteredResidents) {
      const sc = careLevelScoreForAverageCareLevel(String(r.careLevelLabel ?? ''));
      if (sc != null) {
        scoreSum += sc;
        scoreN += 1;
      }
      if (sheetMedicalTarget == null && r.isMedicalInsuranceTarget) medicalTargetCount += 1;
    }
    if (sheetMedicalTarget != null) medicalTargetCount = sheetMedicalTarget;
    const averageCareLevelFromResidents =
      scoreN > 0 ? Math.round((scoreSum / scoreN) * 100) / 100 : null;
    const averageCareLevel =
      sheetAvgCareLevel != null
        ? Math.round(sheetAvgCareLevel * 100) / 100
        : averageCareLevelFromResidents;
    return { averageCareLevel, medicalTargetCount, careLevelScoreCount: scoreN };
  }, [filteredResidents, selectedSheetTitle, lastUpdated]);

  const headerResidentCountSubtitle = useMemo(() => {
    if (!selectedDef) return '施設を選択してください';
    const sheetN = getResidentCountFromSheetSummary(selectedSheetTitle);
    const n =
      sheetN != null && Number.isFinite(sheetN) ? Math.round(sheetN) : filteredResidents.length;
    return `${selectedDef.tabLabel}：${n} 名`;
  }, [selectedDef, selectedSheetTitle, filteredResidents.length, lastUpdated]);

  const visitNursingStats = useMemo(() => {
    const count = Report.countVisitNursingSpecialAmong(filteredResidents);
    const thr = Report.VISIT_NURSING_SPECIAL_WARN_THRESHOLD;
    return {
      count,
      warn: count >= thr,
      threshold: thr,
    };
  }, [filteredResidents, tick]);

  const nursingOfficeUi = useMemo(() => isNursingOfficeUiEnabled(), [tick]);

  const insuranceBreakdownChips = useMemo(() => {
    const order = [
      '後期高齢',
      '国保',
      '協会けんぽ',
      '組合健保',
      '公費・その他',
      '医療保険特指示',
      '医療',
      'その他',
      '未設定',
    ];
    const b = insuranceBreakdown;
    const rows = [];
    for (const k of order) {
      const n = b[k];
      if (n) rows.push({ k, n });
    }
    for (const k of Object.keys(b)) {
      if (!order.includes(k) && b[k]) rows.push({ k, n: b[k] });
    }
    return rows;
  }, [insuranceBreakdown]);

  const billingYearMonth = useMemo(() => {
    void tick;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [tick]);

  const residentBillingById = useMemo(() => {
    void tick;
    const ym = billingYearMonth;
    const m = new Map();
    for (const r of filteredResidents) {
      m.set(String(r.id), Report.summarizeResidentMonthBilling(String(r.id), ym));
    }
    return m;
  }, [filteredResidents, billingYearMonth, tick]);

  const board = useMemo(
    () => boardForFacilityLinkKey(linkKeyForSheetTitle(selectedSheetTitle)),
    [selectedSheetTitle]
  );
  const extLinks = useMemo(
    () => getExternalLinksForFacility(selectedDef?.linkKey ?? ''),
    [selectedDef]
  );

  const nursingList = useMemo(() => {
    const k = selectedDef?.linkKey ?? '';
    return k ? Report.getNursingDirectives(k) : [];
  }, [selectedDef, nursingRev]);
  const weeklyPlanDays = useMemo(() => {
    void tick;
    const k = selectedDef?.linkKey ?? '';
    if (!k) return [];
    const base = Report.getWeeklyPlanDays(k, new Date());
    const out = base.map((day) => {
      const gcal = googleCalendarPlansByDate.get(String(day.date)) ?? [];
      const merged = [...day.plans, ...gcal].sort((a, b) =>
        String(a.time ?? '').localeCompare(String(b.time ?? ''), 'ja')
      );
      return { ...day, plans: merged };
    });
    return out;
  }, [selectedDef, planRev, tick, googleCalendarPlansByDate, googleCalendarPlanRev]);
  const todayPlans = useMemo(() => {
    const d = weeklyPlanDays.find((x) => x.isToday);
    if (!d || !Array.isArray(d.plans)) return [];
    return d.plans;
  }, [weeklyPlanDays]);
  const selectedEmergencyResident = useMemo(
    () => filteredResidents.find((r) => String(r.id) === String(emergencyPickId)) ?? null,
    [filteredResidents, emergencyPickId]
  );
  const buildEmergencyDraftFromResident = useCallback(
    (resident, prevDraft = null) => {
      if (!resident) return emptyEmergencyDraft();
      const narrative = Report.buildEmergencySummaryNarrativeFromRecords(
        resident,
        selectedSheetTitle,
        selectedDef?.linkKey ?? ''
      );
      const prev = prevDraft && typeof prevDraft === 'object' ? prevDraft : {};
      const lk = String(selectedDef?.linkKey ?? '').trim();
      const pullHomeDoctor = lk === '北名古屋' || lk === '起' || lk === '一宮';
      const homeDoctor = String(resident?.homeDoctor ?? '').trim();
      return {
        senderOffice: String(selectedDef?.emergencyFacilityName ?? selectedDef?.tabLabel ?? '').trim(),
        senderAddress: String(selectedDef?.emergencySenderAddress ?? '').trim(),
        senderTel: String(prev.senderTel ?? '').trim(),
        senderNurse: String(prev.senderNurse ?? '').trim(),
        primaryDoctor: String(prev.primaryDoctor ?? '').trim() || (pullHomeDoctor ? homeDoctor : ''),
        medicalAgency: String(prev.medicalAgency ?? '').trim(),
        medicalAddress: String(prev.medicalAddress ?? '').trim(),
        dailyLife: narrative.dailyLife,
        nurseProblems: narrative.nurseProblems,
        acuteChange: String(prev.acuteChange ?? '').trim(),
        nurseContent: narrative.nurseContent,
        careNotes: narrative.careNotes,
        other: String(prev.other ?? '').trim(),
      };
    },
    [selectedDef, selectedSheetTitle]
  );

  const load = useCallback(async (isManualRefresh) => {
    const seq = ++loadSeqRef.current;
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const { residents, source, mode } = await fetchResidentsFromSheet({
        forceRefresh: Boolean(isManualRefresh),
      });
      if (seq !== loadSeqRef.current) return;
      setAllResidents(residents);
      setFetchSourceMeta({
        source: String(source ?? ''),
        mode: String(mode ?? ''),
      });
      Report.seedDemoIfEmpty(residents);
      setLastUpdated(new Date());
      setGoogleCalendarReloadRev((n) => n + 1);
      setSelectedSheetTitle((prev) => {
        const prevOk =
          prev &&
          CARELINK_FACILITIES.some((def) => def.sheetTitle === prev) &&
          residents.some((r) => residentBelongsToFacilityTab(r, prev));
        if (prevOk) return prev;
        const firstWithData = CARELINK_FACILITIES.find((def) =>
          residents.some((r) => residentBelongsToFacilityTab(r, def.sheetTitle))
        );
        return firstWithData?.sheetTitle ?? CARELINK_FACILITIES[0].sheetTitle;
      });
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      const raw = e instanceof Error ? e.message : 'データの取得に失敗しました';
      const quotaLike = /quota exceeded|クォータ|429/i.test(raw);
      const hint = quotaLike ?
        ' Google 側の「1分あたりの読み取り」上限です。1〜2分待ってから「更新」を押すか、Cloud Console で Sheets API のクォータを確認してください。'
      : '';
      setError(raw + hint);
      setFetchSourceMeta(null);
      setAllResidents((prev) => (quotaLike && prev.length > 0 ? prev : []));
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  /** 開いた直後・ポータルから施設が変わったときはキャッシュを使わず必ず再取得する */
  useEffect(() => {
    const t = String(initialSheetTitle ?? '').trim();
    if (t && CARELINK_FACILITIES.some((f) => f.sheetTitle === t)) {
      setSelectedSheetTitle(t);
    }
    void load(true);
  }, [initialSheetTitle, load]);

  useEffect(() => {
    if (!selectedEmergencyResident) {
      setEmergencyDraft(emptyEmergencyDraft());
      return;
    }
    setEmergencyDraft((prev) => buildEmergencyDraftFromResident(selectedEmergencyResident, prev));
  }, [selectedEmergencyResident, buildEmergencyDraftFromResident]);

  useEffect(
    () => () => {
      try {
        dictationRef.current?.stop();
      } catch {
        // noop
      }
    },
    []
  );

  useEffect(() => {
    onResidentsSync?.(filteredResidents);
  }, [filteredResidents, onResidentsSync]);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  const nowLabel = clock.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
  const todayStrip = useMemo(() => todayYmdFromDate(clock), [clock]);

  const openDaySvcExternalEditor = useCallback((res) => {
    const rid = String(res?.id ?? '').trim();
    if (!rid) return;
    const base = todayYmdFromDate(clock);
    const draft = {};
    for (let i = 0; i < 28; i++) {
      const ymd = addCalendarDaysYmd(base, i);
      if (!ymd) break;
      const cell = Report.getDayServiceCell(rid, ymd);
      draft[ymd] = cell?.kind === 'external';
    }
    setDaySvcExternalDraft(draft);
    setDaySvcExternalFor(res);
  }, [clock]);

  const applyCareQuickRecord = useCallback((res, row) => {
    const {
      temp = '',
      bpU = '',
      bpL = '',
      pulse = '',
      spo2 = '',
      weight = '',
      patrol = false,
      patrolAt = '',
      meal = false,
      excretion = false,
      urineVolume = '',
      stoolVolume = '',
      stoolCharacter = '',
      mealSlot = '',
      mealStaple = '',
      mealSide = '',
      mealAmount = '',
      waterMl = '',
      medicationTaken = '',
      toiletGuidance = false,
      ensurePortion = '',
      enteralMenu = '',
      mealExtras = '',
      vitalHandwritingDataUrl = '',
      hourPatrol,
      hourUrine,
      hourStool,
    } = row;
    const id = String(res.id);
    const fac = String(res.facility ?? selectedSheetTitle);
    const name = String(res.name ?? '');
    const weightTrim = String(weight ?? '').trim();
    const spo2Trim = String(spo2 ?? '').trim();
    const vitalPatch = {
      temp,
      bpUpper: bpU,
      bpLower: bpL,
      pulse,
    };
    if (spo2Trim) vitalPatch.spo2 = spo2Trim;
    if (weightTrim) vitalPatch.weight = weightTrim;
    Report.setResidentVitalSnapshot(id, vitalPatch);
    const snap = Report.getResidentVitalSnapshot(id);
    Report.logVitalSnapshot(id, name, fac, {
      temp: snap?.temp,
      bpUpper: snap?.bpUpper,
      bpLower: snap?.bpLower,
      pulse: snap?.pulse,
      spo2: snap?.spo2,
      weight: snap?.weight,
      ...(String(vitalHandwritingDataUrl ?? '').trim() ? { handwrittenMemo: 'あり', handwrittenImage: String(vitalHandwritingDataUrl).trim() } : {}),
    });
    if (patrol) {
      const defaultHour = Math.floor(new Date().getHours() / 3) * 3;
      const atBase =
        String(patrolAt ?? '').trim() ||
        `${bulkTableYmd(bulkSheetDate)}T${String(Math.max(0, Math.min(21, defaultHour))).padStart(2, '0')}:00`;
      const at = normalizePatrolDateTimeLocal(atBase);
      Report.logCareEvent({
        type: 'patrol',
        ts: toEventIsoOrNow(at),
        residentId: id,
        residentName: name,
        facilitySheetTitle: fac,
        meta: { note: '3時間おき巡回（クイック）' },
      });
    }
    const u = String(urineVolume ?? '').trim();
    const sv = String(stoolVolume ?? '').trim();
    const sc = String(stoolCharacter ?? '').trim();
    const tg = Boolean(toiletGuidance);
    const hasDetailedEx = u || sv || sc;
    if (hasDetailedEx) {
      Report.logCareEvent({
        type: 'excretion',
        residentId: id,
        residentName: name,
        facilitySheetTitle: fac,
        meta: {
          urineVolume: u,
          stoolVolume: sv,
          stoolCharacter: sc,
          ...(tg ? { toiletGuidance: true } : {}),
        },
      });
      if (sv || sc) Report.recordStoolForIntervalAlert(id, { stoolVolume: sv, stoolCharacter: sc });
      if (u || tg) Report.setLastUrineNow(id);
    } else if (excretion) {
      Report.logCareEvent({
        type: 'excretion',
        residentId: id,
        residentName: name,
        facilitySheetTitle: fac,
        meta: { note: '排泄確認（クイック）' },
      });
      Report.setLastStoolNow(id);
      Report.setLastUrineNow(id);
    } else if (tg) {
      Report.logCareEvent({
        type: 'excretion',
        residentId: id,
        residentName: name,
        facilitySheetTitle: fac,
        meta: { toiletGuidance: true, note: 'トイレ誘導' },
      });
      Report.setLastUrineNow(id);
    }
    const kind = getQuickCareMealEventKind(
      {
        meal,
        mealSlot,
        mealStaple,
        mealSide,
        mealAmount,
        waterMl,
        medicationTaken,
        ensurePortion,
        mealExtras,
      },
      bulkGlobalMealSlot
    );
    if (kind === 'fluid_intake') {
      const wm = String(waterMl ?? '').trim();
      Report.logCareEvent({
        type: 'fluid_intake',
        residentId: id,
        residentName: name,
        facilitySheetTitle: fac,
        meta: { waterMl: wm },
      });
    } else if (kind === 'meal') {
      const slot = String(mealSlot ?? '').trim();
      const composedMeal = [composeMealAmountForLog(mealStaple, mealSide), composeEnsureLine(ensurePortion)]
        .filter(Boolean)
        .join(' ')
        .trim();
      const ma = composedMeal || String(mealAmount ?? '').trim();
      const extrasTrim = String(mealExtras ?? '').trim();
      const maForLog = [ma, extrasTrim].filter(Boolean).join(' ／ ').trim();
      const wm = String(waterMl ?? '').trim();
      const med = medicationTaken === 'yes' || medicationTaken === 'no' ? medicationTaken : '';
      if (slot || maForLog || wm || med) {
        Report.logCareEvent({
          type: 'meal',
          residentId: id,
          residentName: name,
          facilitySheetTitle: fac,
          meta: { mealSlot: slot, mealAmount: maForLog, waterMl: wm, medicationTaken: med },
        });
      } else {
        Report.logCareEvent({
          type: 'meal',
          residentId: id,
          residentName: name,
          facilitySheetTitle: fac,
          meta: { note: '食事確認（クイック）' },
        });
      }
    }

    const entMenu = String(enteralMenu ?? '').trim();
    if (entMenu) {
      Report.logCareEvent({
        type: 'enteral',
        residentId: id,
        residentName: name,
        facilitySheetTitle: fac,
        meta: { note: entMenu, bulkEnteralMenu: true },
      });
    }

    const ymdLog = bulkTableYmd(bulkSheetDate);
    const hp = Array.isArray(hourPatrol) && hourPatrol.length === 24 ? hourPatrol : freshHourly24();
    const hu = normalizeHourlyText24(hourUrine);
    const hs = normalizeHourlyText24(hourStool);
    const dayEv = Report.getCareEventsForResidentDay(id, ymdLog);
    let occ = buildHourlyCareFromEvents(dayEv, ymdLog);
    for (let h = 0; h < 24; h++) {
      if (hp[h] && !occ.patrol[h]) {
        Report.logCareEvent({
          type: 'patrol',
          ts: tokyoDateHourToIso(ymdLog, h),
          residentId: id,
          residentName: name,
          facilitySheetTitle: fac,
          meta: { note: '巡視（24時間表）' },
        });
        occ = { ...occ, patrol: occ.patrol.map((v, i) => (i === h ? true : v)) };
      }
      if (hu[h] && !occ.urine[h]) {
        const uCode = String(hu[h] ?? '').trim();
        Report.logCareEvent({
          type: 'hourly_excretion',
          ts: tokyoDateHourToIso(ymdLog, h),
          residentId: id,
          residentName: name,
          facilitySheetTitle: fac,
          meta: {
            note: `排尿（${String(h).padStart(2, '0')}時）`,
            ...(uCode && uCode !== 'plain' ? { urineVolume: uCode } : {}),
            hourlyKind: 'urine',
            hourlySheet: true,
          },
        });
        Report.setLastUrineNow(id);
        occ = { ...occ, urine: occ.urine.map((v, i) => (i === h ? true : v)) };
      }
      if (hs[h] && !occ.stool[h]) {
        const sCode = String(hs[h] ?? '').trim();
        const parsedStool = parseHourlyStoolCellValue(sCode);
        Report.logCareEvent({
          type: 'hourly_excretion',
          ts: tokyoDateHourToIso(ymdLog, h),
          residentId: id,
          residentName: name,
          facilitySheetTitle: fac,
          meta: {
            note: `排便（${String(h).padStart(2, '0')}時）`,
            ...(parsedStool?.stoolVolume ? { stoolVolume: parsedStool.stoolVolume } : {}),
            ...(parsedStool?.stoolCharacter ? { stoolCharacter: parsedStool.stoolCharacter } : {}),
            hourlyKind: 'stool',
            hourlySheet: true,
          },
        });
        if (parsedStool?.stoolVolume || parsedStool?.stoolCharacter) {
          Report.recordStoolForIntervalAlert(id, {
            stoolVolume: parsedStool?.stoolVolume ?? '',
            stoolCharacter: parsedStool?.stoolCharacter ?? '',
          });
        }
        Report.setLastStoolNow(id);
        occ = { ...occ, stool: occ.stool.map((v, i) => (i === h ? true : v)) };
      }
    }
  }, [selectedSheetTitle, bulkSheetDate, bulkGlobalMealSlot]);

  const switchToTableInput = useCallback(() => {
    const init = {};
    const ymd = bulkTableYmd(bulkSheetDate);
    for (const r of displayResidents) {
      const id = String(r.id);
      init[id] = {
        ...vitalSeedForBulkTableRow(id, ymd),
        ...bulkCareSeedForResidentDay(id, ymd),
        mealSlot: bulkGlobalMealSlot,
        ...hourlyDraftSeedForResidentDay(id, ymd),
      };
    }
    setBulkDraft(init);
    setResidentInputView('table');
  }, [displayResidents, bulkGlobalMealSlot, bulkSheetDate]);

  const onBulkGlobalMealSlotChange = useCallback(
    (slot) => {
      setBulkGlobalMealSlot(slot);
      setBulkDraft((prev) => {
        const next = { ...prev };
        for (const r of displayResidents) {
          const id = String(r.id);
          const cur = next[id];
          if (cur) next[id] = { ...cur, mealSlot: slot };
        }
        return next;
      });
    },
    [displayResidents]
  );

  const patchBulkRow = useCallback((id, patch) => {
    setBulkDraft((prev) => {
      const base =
        prev[id] ??
        (() => {
          const ymd = bulkTableYmd(bulkSheetDate);
          return {
            ...vitalSeedForBulkTableRow(id, ymd),
            ...bulkCareSeedForResidentDay(id, ymd),
            mealSlot: bulkGlobalMealSlot,
            ...hourlyDraftSeedForResidentDay(id, ymd),
          };
        })();
      return { ...prev, [id]: { ...base, ...patch } };
    });
  }, [bulkGlobalMealSlot, bulkSheetDate]);

  const bulkRowHasInput = useCallback((row) => {
    if (!row) return false;
    return (
      String(row.temp ?? '').trim() !== '' ||
      String(row.bpU ?? '').trim() !== '' ||
      String(row.bpL ?? '').trim() !== '' ||
      String(row.pulse ?? '').trim() !== '' ||
      String(row.spo2 ?? '').trim() !== '' ||
      String(row.weight ?? '').trim() !== '' ||
      row.patrol ||
      String(row.urineVolume ?? '').trim() !== '' ||
      String(row.stoolVolume ?? '').trim() !== '' ||
      String(row.stoolCharacter ?? '').trim() !== '' ||
      String(row.mealStaple ?? '').trim() !== '' ||
      String(row.mealSide ?? '').trim() !== '' ||
      String(row.mealAmount ?? '').trim() !== '' ||
      String(row.waterMl ?? '').trim() !== '' ||
      row.medicationTaken === 'yes' ||
      row.medicationTaken === 'no' ||
      row.toiletGuidance ||
      String(row.ensurePortion ?? '').trim() !== '' ||
      (Array.isArray(row.hourPatrol) && row.hourPatrol.some(Boolean)) ||
      (Array.isArray(row.hourUrine) && row.hourUrine.some((v) => String(v ?? '').trim() !== '')) ||
      (Array.isArray(row.hourStool) && row.hourStool.some((v) => String(v ?? '').trim() !== '')) ||
      String(row.vitalHandwritingDataUrl ?? '').trim() !== '' ||
      String(row.enteralMenu ?? '').trim() !== '' ||
      String(row.mealExtras ?? '').trim() !== ''
    );
  }, []);

  const bulkRowHasVitalInput = useCallback((row) => {
    if (!row) return false;
    return (
      String(row.temp ?? '').trim() !== '' ||
      String(row.bpU ?? '').trim() !== '' ||
      String(row.bpL ?? '').trim() !== '' ||
      String(row.pulse ?? '').trim() !== '' ||
      String(row.spo2 ?? '').trim() !== '' ||
      String(row.weight ?? '').trim() !== '' ||
      String(row.vitalHandwritingDataUrl ?? '').trim() !== ''
    );
  }, []);

  const saveBulkRow = useCallback(
    (res) => {
      const id = String(res.id);
      const row = bulkDraft[id];
      if (!row || !bulkRowHasInput(row)) return;
      applyCareQuickRecord(res, row);
      const ymd = bulkTableYmd(bulkSheetDate);
      setBulkDraft((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          ...vitalSeedForBulkTableRow(id, ymd),
          ...bulkCareSeedForResidentDay(id, ymd),
          mealSlot: bulkGlobalMealSlot,
          ...hourlyDraftSeedForResidentDay(id, ymd),
        },
      }));
      setTick((n) => n + 1);
    },
    [bulkDraft, applyCareQuickRecord, bulkRowHasInput, bulkGlobalMealSlot, bulkSheetDate]
  );

  const saveBulkAllWithInput = useCallback(() => {
    const toSave = displayResidents.filter((res) => {
      const row = bulkDraft[String(res.id)];
      return bulkRowHasInput(row);
    });
    if (toSave.length === 0) return;
    for (const res of toSave) {
      applyCareQuickRecord(res, bulkDraft[String(res.id)]);
    }
    const ymd = bulkTableYmd(bulkSheetDate);
    setBulkDraft((prev) => {
      const next = { ...prev };
      for (const res of toSave) {
        const id = String(res.id);
        if (next[id])
          next[id] = {
            ...next[id],
            ...vitalSeedForBulkTableRow(id, ymd),
            ...bulkCareSeedForResidentDay(id, ymd),
            mealSlot: bulkGlobalMealSlot,
            ...hourlyDraftSeedForResidentDay(id, ymd),
          };
      }
      return next;
    });
    setTick((t) => t + 1);
  }, [displayResidents, bulkDraft, applyCareQuickRecord, bulkRowHasInput, bulkGlobalMealSlot, bulkSheetDate]);

  /** バイタル列のみを全員一括保存（巡視・食事などは触らない） */
  const saveBulkVitalsOnly = useCallback(() => {
    const toSave = displayResidents.filter((res) => {
      const row = bulkDraft[String(res.id)];
      return bulkRowHasVitalInput(row);
    });
    if (toSave.length === 0) return;
    for (const res of toSave) {
      const row = bulkDraft[String(res.id)] ?? {};
      applyCareQuickRecord(res, {
        temp: row.temp,
        bpU: row.bpU,
        bpL: row.bpL,
        pulse: row.pulse,
        spo2: row.spo2,
        weight: row.weight,
        vitalHandwritingDataUrl: row.vitalHandwritingDataUrl,
      });
    }
    const ymd = bulkTableYmd(bulkSheetDate);
    setBulkDraft((prev) => {
      const next = { ...prev };
      for (const res of toSave) {
        const id = String(res.id);
        if (!next[id]) continue;
        next[id] = {
          ...next[id],
          ...vitalSeedForBulkTableRow(id, ymd),
        };
      }
      return next;
    });
    setTick((t) => t + 1);
  }, [displayResidents, bulkDraft, bulkRowHasVitalInput, applyCareQuickRecord, bulkSheetDate]);

  const setBulkPatrolForAllVisible = useCallback(
    (checked) => {
      setBulkDraft((prev) => {
        const next = { ...prev };
        for (const r of displayResidents) {
          const id = String(r.id);
          const base =
            next[id] ??
            (() => {
              const ymd = bulkTableYmd(bulkSheetDate);
              return {
                ...vitalSeedForBulkTableRow(id, ymd),
                ...bulkCareSeedForResidentDay(id, ymd),
                mealSlot: bulkGlobalMealSlot,
                ...hourlyDraftSeedForResidentDay(id, ymd),
              };
            })();
          next[id] = {
            ...base,
            patrol: Boolean(checked),
            ...(checked ? { patrolAt: normalizePatrolDateTimeLocal(base.patrolAt) } : {}),
          };
        }
        return next;
      });
    },
    [displayResidents, bulkGlobalMealSlot, bulkSheetDate]
  );

  /** し忘れ対策: 対象日の過去時間（現在時刻まで）を全員の巡視マスで一括ON */
  const fillPastHourlyPatrolForAllVisible = useCallback(() => {
    const ymd = bulkTableYmd(bulkSheetDate);
    const now = new Date();
    const today = bulkTableYmd(currentYmd());
    const nowHour = now.getHours();
    const maxHour = ymd < today ? 23 : ymd > today ? -1 : nowHour;
    if (maxHour < 0) return;
    setBulkDraft((prev) => {
      const next = { ...prev };
      for (const r of displayResidents) {
        const id = String(r.id);
        const base =
          next[id] ??
          (() => {
            return {
              ...vitalSeedForBulkTableRow(id, ymd),
              ...bulkCareSeedForResidentDay(id, ymd),
              mealSlot: bulkGlobalMealSlot,
              ...hourlyDraftSeedForResidentDay(id, ymd),
            };
          })();
        const hp = Array.isArray(base.hourPatrol) && base.hourPatrol.length === 24 ? [...base.hourPatrol] : freshHourly24();
        for (let h = 0; h <= maxHour; h++) hp[h] = true;
        next[id] = { ...base, hourPatrol: hp };
      }
      return next;
    });
  }, [bulkSheetDate, displayResidents, bulkGlobalMealSlot]);

  useEffect(() => {
    if (residentInputView !== 'table') return;
    const ymd = bulkTableYmd(bulkSheetDate);
    setBulkDraft((prev) => {
      const next = { ...prev };
      for (const r of displayResidents) {
        const id = String(r.id);
        if (!next[id]) {
          next[id] = {
            ...vitalSeedForBulkTableRow(id, ymd),
            ...bulkCareSeedForResidentDay(id, ymd),
            mealSlot: bulkGlobalMealSlot,
            ...hourlyDraftSeedForResidentDay(id, ymd),
          };
        } else {
          let cur = next[id];
          for (const k of Object.keys(BULK_CARE_RESET)) {
            if (cur[k] === undefined) cur = { ...cur, [k]: BULK_CARE_RESET[k] };
          }
          if (!Array.isArray(cur.hourPatrol) || cur.hourPatrol.length !== 24) {
            cur = { ...cur, hourPatrol: freshHourly24() };
          }
          if (!Array.isArray(cur.hourUrine) || cur.hourUrine.length !== 24) {
            cur = { ...cur, hourUrine: freshHourlyText24() };
          } else {
            cur = { ...cur, hourUrine: normalizeHourlyText24(cur.hourUrine) };
          }
          if (!Array.isArray(cur.hourStool) || cur.hourStool.length !== 24) {
            cur = { ...cur, hourStool: freshHourlyText24() };
          } else {
            cur = { ...cur, hourStool: normalizeHourlyText24(cur.hourStool) };
          }
          if (cur.ensurePortion === undefined) cur = { ...cur, ensurePortion: '' };
          if (cur.enteralMenu === undefined) cur = { ...cur, enteralMenu: '' };
          if (cur.mealExtras === undefined) cur = { ...cur, mealExtras: '' };
          if (cur.mealSlot === undefined || cur.mealSlot === '') {
            cur = { ...cur, mealSlot: bulkGlobalMealSlot };
          }
          next[id] = cur;
        }
      }
      const keep = new Set(displayResidents.map((r) => String(r.id)));
      for (const k of Object.keys(next)) {
        if (!keep.has(k)) delete next[k];
      }
      return next;
    });
  }, [displayResidents, residentInputView, bulkGlobalMealSlot, bulkSheetDate]);

  const registerNursing = useCallback(() => {
    const k = selectedDef?.linkKey;
    if (!k) return;
    if (
      Report.addNursingDirective(k, nursingDraft, '看護', {
        startDate: nursingStartDate,
        endDate: nursingEndDate,
      })
    ) {
      setNursingDraft('');
      setNursingStartDate(currentYmd());
      setNursingEndDate('');
      setNursingRev((n) => n + 1);
    }
  }, [nursingDraft, nursingStartDate, nursingEndDate, selectedDef]);

  const removeNursing = useCallback(
    (d) => {
      const k = selectedDef?.linkKey;
      if (!k) return;
      if (Report.removeNursingDirective(k, String(d?.id ?? ''), String(d?.ts ?? ''))) {
        setNursingRev((n) => n + 1);
      }
    },
    [selectedDef]
  );

  const registerWeeklyPlan = useCallback(() => {
    const k = selectedDef?.linkKey;
    if (!k) return;
    const ok = Report.addWeeklyPlan(k, {
      date: planDraftDate,
      time: planDraftTime,
      type: planDraftType,
      title: planDraftTitle,
    });
    if (!ok) return;
    setPlanDraftTitle('');
    setPlanRev((n) => n + 1);
  }, [selectedDef, planDraftDate, planDraftTime, planDraftType, planDraftTitle]);

  const removeWeeklyPlan = useCallback(
    (planId) => {
      const k = selectedDef?.linkKey;
      if (!k) return;
      if (Report.removeWeeklyPlan(k, String(planId ?? ''))) {
        setPlanRev((n) => n + 1);
      }
    },
    [selectedDef]
  );

  const startDictation = useCallback((fieldKey) => {
    if (typeof window === 'undefined') return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert('このブラウザは音声入力に対応していません');
      return;
    }
    try {
      dictationRef.current?.stop();
    } catch {
      // noop
    }
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (event) => {
      const text = String(event.results?.[0]?.[0]?.transcript ?? '').trim();
      if (!text) return;
      setEmergencyDraft((prev) => ({
        ...prev,
        [fieldKey]: prev[fieldKey] ? `${prev[fieldKey]}\n${text}` : text,
      }));
    };
    rec.onend = () => setDictatingField('');
    rec.onerror = () => setDictatingField('');
    dictationRef.current = rec;
    setDictatingField(fieldKey);
    rec.start();
  }, []);

  const stopDictation = useCallback(() => {
    try {
      dictationRef.current?.stop();
    } catch {
      // noop
    } finally {
      setDictatingField('');
    }
  }, []);

  const bumpMonitorMute = useCallback(() => {
    setMonitorMuteRev((n) => n + 1);
    setTick((n) => n + 1);
  }, []);

  const muteResidentCardMonitor = useCallback(
    (res, hours = 6) => {
      const id = String(res?.id ?? '').trim();
      if (!id) return;
      if (Report.muteResidentMonitorAlert(id, hours)) bumpMonitorMute();
    },
    [bumpMonitorMute]
  );

  const unmuteResidentCardMonitor = useCallback(
    (res) => {
      const id = String(res?.id ?? '').trim();
      if (!id) return;
      if (Report.unmuteResidentMonitorAlert(id)) bumpMonitorMute();
    },
    [bumpMonitorMute]
  );

  const runEmergencySummary = useCallback(async () => {
    const res = filteredResidents.find((r) => String(r.id) === String(emergencyPickId));
    if (!res) return;
    setEmergencyBusy(true);
    const ev = Report.evaluateResidentMonitor(res, { ignoreMute: true });
    let advice = Report.fallbackRegulatoryAdvice(ev);
    if (GEMINI_KEY) {
      try {
        advice = await Report.fetchAiRegulatoryAdvice(GEMINI_KEY, ev, res);
      } catch {
        advice = Report.fallbackRegulatoryAdvice(ev);
      }
    }
    const contact = Report.getEmergencyContact(String(res.id));
    const html = Report.buildEmergencySummaryHtml(res, ev, advice, contact, emergencyDraft);
    Report.openPrintableSummary(html);
    setEmergencyBusy(false);
  }, [emergencyPickId, filteredResidents, emergencyDraft]);

  const downloadEmergencyHtml = useCallback(async () => {
    const res = filteredResidents.find((r) => String(r.id) === String(emergencyPickId));
    if (!res) return;
    setEmergencyBusy(true);
    const ev = Report.evaluateResidentMonitor(res, { ignoreMute: true });
    let advice = Report.fallbackRegulatoryAdvice(ev);
    if (GEMINI_KEY) {
      try {
        advice = await Report.fetchAiRegulatoryAdvice(GEMINI_KEY, ev, res);
      } catch {
        advice = Report.fallbackRegulatoryAdvice(ev);
      }
    }
    const contact = Report.getEmergencyContact(String(res.id));
    const html = Report.buildEmergencySummaryHtml(res, ev, advice, contact, emergencyDraft);
    Report.downloadSummaryHtml(`救急搬送サマリー_${String(res.name)}.html`, html);
    setEmergencyBusy(false);
  }, [emergencyPickId, filteredResidents, emergencyDraft]);

  const exportAudit = useCallback(() => {
    Report.downloadMonthlyAuditSheet(selectedSheetTitle, auditMonth, filteredResidents);
  }, [selectedSheetTitle, auditMonth, filteredResidents]);

  const exportAuditNarrative = useCallback(() => {
    Report.downloadPaidAuditNarrativeHtml(selectedSheetTitle, auditMonth, filteredResidents);
  }, [selectedSheetTitle, auditMonth, filteredResidents]);

  const monthlyImportedSummary = useMemo(() => {
    let residentCount = 0;
    let lineCount = 0;
    for (const res of filteredResidents) {
      const lines = Report.getResidentMonthlyReportImportLines(String(res.id ?? ''), auditMonth);
      if (Array.isArray(lines) && lines.length > 0) {
        residentCount += 1;
        lineCount += lines.length;
      }
    }
    return { residentCount, lineCount };
  }, [filteredResidents, auditMonth, tick]);

  const surroundMemoByResident = useMemo(() => {
    const m = new Map();
    for (const res of displayResidents) {
      const id = String(res?.id ?? '').trim();
      if (!id) continue;
      m.set(id, Report.getResidentSurroundMemo(id));
    }
    return m;
  }, [displayResidents, surroundMemoRev]);

  const importKaipokeVitalsCsv = useCallback(
    (file) => {
      if (!file) return;
      /** @param {string} [cell] */
      const parseCellToStoolIso = (cell) => {
        const t = String(cell ?? '').trim();
        if (!t) return null;
        const d = new Date(t.replace(/\//g, '-'));
        if (!Number.isNaN(d.getTime())) return d.toISOString();
        const m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(t);
        if (m)
          return new Date(
            Number(m[1]),
            Number(m[2]) - 1,
            Number(m[3]),
            Number(m[4]),
            Number(m[5])
          ).toISOString();
        const m2 = /^(\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(t);
        if (m2) {
          const y = new Date().getFullYear();
          return new Date(
            y,
            Number(m2[1]) - 1,
            Number(m2[2]),
            Number(m2[3]),
            Number(m2[4])
          ).toISOString();
        }
        const m3 = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(t);
        if (m3)
          return new Date(Number(m3[1]), Number(m3[2]) - 1, Number(m3[3]), 12, 0, 0).toISOString();
        const m4 = /^(\d{1,2})[\/\-](\d{1,2})$/.exec(t);
        if (m4) {
          const y = new Date().getFullYear();
          return new Date(y, Number(m4[1]) - 1, Number(m4[2]), 12, 0, 0).toISOString();
        }
        return null;
      };
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result;
        if (!(buf instanceof ArrayBuffer)) {
          setKaipokeImportStatus({
            kind: 'vitals',
            ok: false,
            message: 'ファイルの読み込み形式が不正です。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert('ファイルの読み込み形式が不正です。');
          return;
        }
        const text = decodeKaipokeImportTextFromBytes(buf);
        const rows = parseVitalsImportDelimitedText(text);
        if (rows.length < 1) {
          setKaipokeImportStatus({
            kind: 'vitals',
            ok: false,
            message: '内容が空で取り込めませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            '内容が空のため取り込めませんでした。CSV またはタブ区切り（UTF-8 / Shift_JIS いずれも自動判定）をご利用ください。'
          );
          return;
        }
        const layout = findCsvDataLayout(rows, { requireVitalsColumns: true });
        if (!layout) {
          const preview = rows
            .slice(0, 4)
            .map((r) =>
              (r || [])
                .map((c) => stripCsvBom(String(c ?? '')))
                .filter(Boolean)
                .join(' ／ ')
            )
            .filter(Boolean)
            .join('\n');
          setKaipokeImportStatus({
            kind: 'vitals',
            ok: false,
            message: '氏名列＋バイタル列のヘッダ行を検出できませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            `「氏名・利用者名」列と、体温・血圧・脈拍などのバイタル列が**同じ行のヘッダ**として見つかりませんでした。\nこの取り込みは**バイタルのみ**名簿の利用者情報（バイタルスナップショット）に反映します。カイポケの**バイタル・検査値が並ぶ帳票**を CSV（UTF-8 または Shift_JIS）で出力してください。\n訪問記録だけのファイル（職員名・開始終了時間のみ等）は対象外です。\n\nカイポケはタブ区切りや、表題行のあとに本ヘッダが出ることがあります（先頭30行まで自動検出）。\n\n先頭4行（抜粋）:\n${preview.slice(0, 550)}${preview.length > 550 ? '…' : ''}`
          );
          return;
        }
        const { headerRow, nameCol: nameColIdx } = layout;
        const headers = (rows[headerRow] || []).map((x) => stripCsvBom(String(x ?? '')).trim());
        const idx = {
          name: nameColIdx,
          kana: headers.findIndex((h) => /利用者カナ|フリガナ|ふりがな|カナ/u.test(String(h ?? ''))),
          temp: headers.findIndex((h) => {
            const hn = String(h);
            if (/血圧|目標/i.test(hn)) return false;
            return /体温/u.test(hn);
          }),
          bpU: headers.findIndex((h) => /血圧.*(上|高)|収縮|1回目：収縮|最高/u.test(h)),
          bpL: headers.findIndex((h) => /血圧.*(下|低)|拡張|1回目：拡張|最低/u.test(h)),
          pulse: headers.findIndex((h) => /脈拍|1回目：脈拍|pulse|心拍/iu.test(h)),
          spo2: headers.findIndex((h) => /spo2|酸素|ｓｐｏ|ＳｐＯ2|SpO2|ＳＰＯ2/i.test(h)),
          weight: headers.findIndex((h) => /体重|weight/i.test(h) && !/血圧|目標/i.test(h)),
          stool: headers.findIndex((h) =>
            /排便.*(日時|時刻|時間)|最終排便|排便日時|排便（日時）|排便記録/u.test(h)
          ),
          urine: headers.findIndex((h) => /排尿.*(記録|内容|コメント)|^排尿$/u.test(h)),
        };
        const getCell = (row, i) => {
          if (i < 0) return '';
          const a = row?.[i];
          return a != null ? stripCsvBom(String(a)) : '';
        };
        let applied = 0;
        const resolveResidentForCsvRow = (nameCell, kanaCell) => {
          const inCurrent = findResidentForVitalsCsvName(filteredResidents, nameCell);
          if (inCurrent) return inCurrent;
          const byKanaCurrent = findResidentForVitalsCsvKana(filteredResidents, kanaCell);
          if (byKanaCurrent) return byKanaCurrent;
          // 他施設タブの利用者名もCSVに含まれるため、全名簿にもフォールバック
          const inAll = findResidentForVitalsCsvName(allResidents, nameCell);
          if (inAll) return inAll;
          return findResidentForVitalsCsvKana(allResidents, kanaCell);
        };
        for (let r = headerRow + 1; r < rows.length; r++) {
          const row = rows[r] ?? [];
          if (!row.length) continue;
          const hit = resolveResidentForCsvRow(getCell(row, idx.name), getCell(row, idx.kana));
          if (!hit) continue;
          /** ヘッダに無い列は送らない（空で既存値を消さない） */
          const patch = {};
          if (idx.temp >= 0) patch.temp = getCell(row, idx.temp);
          if (idx.bpU >= 0) patch.bpUpper = getCell(row, idx.bpU);
          if (idx.bpL >= 0) patch.bpLower = getCell(row, idx.bpL);
          if (idx.pulse >= 0) patch.pulse = getCell(row, idx.pulse);
          if (idx.spo2 >= 0) patch.spo2 = getCell(row, idx.spo2);
          if (idx.weight >= 0) patch.weight = getCell(row, idx.weight);
          if (idx.urine >= 0) patch.urineNote = getCell(row, idx.urine);
          if (Object.keys(patch).length === 0) continue;
          Report.setResidentVitalSnapshot(String(hit.id), patch);
          Report.logVitalSnapshot(
            String(hit.id),
            String(hit.name ?? ''),
            String(hit.sourceSheetTitle ?? hit.facility ?? selectedSheetTitle),
            patch
          );
          if (idx.stool >= 0) {
            const iso = parseCellToStoolIso(getCell(row, idx.stool));
            if (iso) Report.setLastStoolIso(String(hit.id), iso);
          }
          applied += 1;
        }
        if (applied > 0) {
          setTick((n) => n + 1);
          setKaipokeImportStatus({
            kind: 'vitals',
            ok: true,
            message: `${applied}名のバイタルを利用者情報に反映しました。`,
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(`${applied}名のバイタルを利用者情報に反映しました`);
        } else {
          setKaipokeImportStatus({
            kind: 'vitals',
            ok: false,
            message: '名簿の利用者名と一致するデータ行がありませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            'バイタル列は認識できましたが、名簿の利用者名と一致するデータ行がありませんでした。氏名の表記（スペース・「様」・全角半角）を名簿に近づけるか、名簿のフリガナ列とCSVの氏名が一致するか確認してください。'
          );
        }
      };
      reader.onerror = () => {
        setKaipokeImportStatus({
          kind: 'vitals',
          ok: false,
          message: 'CSV読み込みに失敗しました。',
          at: Date.now(),
          fileName: String(file.name ?? ''),
        });
        alert('CSV読み込みに失敗しました');
      };
      reader.readAsArrayBuffer(file);
    },
    [filteredResidents, allResidents, selectedSheetTitle]
  );

  const importKaipokeMonthlySupplementCsv = useCallback(
    (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result;
        if (!(buf instanceof ArrayBuffer)) {
          setKaipokeImportStatus({
            kind: 'monthly',
            ok: false,
            message: 'ファイルの読み込み形式が不正です。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert('ファイルの読み込み形式が不正です。');
          return;
        }
        const text = decodeKaipokeImportTextFromBytes(buf);
        const rows = parseVitalsImportDelimitedText(text);
        if (rows.length < 1) {
          setKaipokeImportStatus({
            kind: 'monthly',
            ok: false,
            message: '内容が空で取り込めませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert('内容が空のため取り込めませんでした。CSV またはタブ区切りをご利用ください。');
          return;
        }
        const layout = findCsvDataLayout(rows, { requireVitalsColumns: false });
        if (!layout) {
          const preview = rows
            .slice(0, 4)
            .map((r) =>
              (r || [])
                .map((c) => stripCsvBom(String(c ?? '')))
                .filter(Boolean)
                .join(' ／ ')
            )
            .filter(Boolean)
            .join('\n');
          setKaipokeImportStatus({
            kind: 'monthly',
            ok: false,
            message: '氏名・利用者列のあるヘッダ行を検出できませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            `氏名・利用者列のあるヘッダ行が見つかりませんでした。\nカイポケの訪問記録など、先頭30行以内に列名の行がある CSV（UTF-8 / Shift_JIS）を選んでください。\n\n先頭4行（抜粋）:\n${preview.slice(0, 550)}${preview.length > 550 ? '…' : ''}`
          );
          return;
        }
        const { headerRow, nameCol } = layout;
        const headers = (rows[headerRow] || []).map((x) => stripCsvBom(String(x ?? '')).trim());
        const fieldIdx = buildMonthlyCsvFieldIndexes(headers);
        const getCell = (row, i) => {
          if (i < 0) return '';
          const a = row?.[i];
          return a != null ? stripCsvBom(String(a)) : '';
        };
        /** @type {Map<string, string[]>} */
        const byResident = new Map();
        for (let r = headerRow + 1; r < rows.length; r++) {
          const row = rows[r] ?? [];
          if (!row.length) continue;
          if (!monthlyImportRowBelongsToYm(row, fieldIdx, auditMonth)) continue;
          const hit = findResidentForVitalsCsvName(filteredResidents, getCell(row, nameCol));
          if (!hit) continue;
          const line = formatMonthlyImportSummaryLine(row, fieldIdx, auditMonth);
          if (!line) continue;
          const id = String(hit.id);
          if (!byResident.has(id)) byResident.set(id, []);
          byResident.get(id).push(line);
        }
        if (byResident.size === 0) {
          const fn = String(file.name ?? '');
          const maybeSchedule = looksLikeVisitNursingScheduleCsvFileName(fn);
          setKaipokeImportStatus({
            kind: 'monthly',
            ok: false,
            message: maybeSchedule
              ? `ファイル名から「訪問看護スケジュール」帳票の可能性があります（このボタンはカイポケ訪問記録形式専用）。対象月 ${auditMonth} で名簿と一致する行もありませんでした。`
              : `対象月 ${auditMonth} で一致する行がありませんでした。`,
            at: Date.now(),
            fileName: fn,
          });
          alert(
            maybeSchedule
              ? `「月次用CSV」は、カイポケの訪問記録など（氏名・日付・サービス内容・職員名などの列がある帳票）向けです。\n\nファイル名から、訪問看護のスケジュール・勤務表 CSV を選んだ可能性があります。その形式はここでは取り込めません。\n\n月次ご報告に載せたい場合は、カイポケ側の訪問記録エクスポート等を選び直すか、画面上の「対象月（${auditMonth}）」と CSV 内の日付・利用者名が名簿と一致するか確認してください。`
              : `対象月「${auditMonth}」（画面上の監査用の月）で、名簿と一致する行がなかったか、日付・サービス内容が空でした。月を合わせてから再度お試しください。`
          );
          return;
        }
        let lineTotal = 0;
        for (const [id, lines] of byResident) {
          Report.setResidentMonthlyReportImportLines(id, auditMonth, lines);
          lineTotal += lines.length;
        }
        setKaipokeImportStatus({
          kind: 'monthly',
          ok: true,
          message: `${byResident.size}名・計${lineTotal}行を保存しました（${auditMonth}）。`,
          at: Date.now(),
          fileName: String(file.name ?? ''),
        });
        alert(
          `月次ご報告用に ${byResident.size} 名・計 ${lineTotal} 行を保存しました（対象月 ${auditMonth}）。ホームの「月次」から AI 生成・HTML 保存すると本文・印刷に反映されます。`
        );
      };
      reader.onerror = () => {
        setKaipokeImportStatus({
          kind: 'monthly',
          ok: false,
          message: 'CSV読み込みに失敗しました。',
          at: Date.now(),
          fileName: String(file.name ?? ''),
        });
        alert('CSV読み込みに失敗しました');
      };
      reader.readAsArrayBuffer(file);
    },
    [filteredResidents, auditMonth]
  );

  const importKaipokeDayServiceCsv = useCallback(
    (file) => {
      if (!file) return;
      if (dayServiceModeForFacilityLinkKey(selectedFacilityLinkKey) !== 'on_site_csv') {
        alert('この施設タブではデイ予定CSVの取り込みは利用できません（併設デイのある施設のみ）。');
        return;
      }
      const defaultYm = auditMonth;
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result;
        if (!(buf instanceof ArrayBuffer)) {
          setKaipokeImportStatus({
            kind: 'dayservice',
            ok: false,
            message: 'ファイルの読み込み形式が不正です。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert('ファイルの読み込み形式が不正です。');
          return;
        }
        const text = decodeKaipokeImportTextFromBytes(buf);
        const rows = parseVitalsImportDelimitedText(text);
        if (rows.length < 1) {
          setKaipokeImportStatus({
            kind: 'dayservice',
            ok: false,
            message: '内容が空で取り込めませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert('内容が空のため取り込めませんでした。');
          return;
        }
        const layout = findCsvDataLayout(rows, { requireVitalsColumns: false });
        if (!layout) {
          setKaipokeImportStatus({
            kind: 'dayservice',
            ok: false,
            message: '氏名・利用者列のあるヘッダ行を検出できませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            '氏名列と日付列のあるヘッダ行が見つかりませんでした。カイポケの訪問記録・サービス実績など、先頭30行以内に列名の行があるCSVを選んでください。'
          );
          return;
        }
        const { headerRow, nameCol } = layout;
        const headers = (rows[headerRow] || []).map((x) => stripCsvBom(String(x ?? '')).trim());
        const fieldIdx = buildDayServiceCsvFieldIndexes(headers);
        const getCell = (row, i) => {
          if (i < 0) return '';
          const a = row?.[i];
          return a != null ? stripCsvBom(String(a)) : '';
        };
        if (fieldIdx.dayCol < 0) {
          setKaipokeImportStatus({
            kind: 'dayservice',
            ok: false,
            message: '日付列が見つかりませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert('日付列（日付・実施日・サービス提供日など）が見つかりませんでした。');
          return;
        }
        const hasSvc =
          (typeof fieldIdx.svcBody === 'number' && fieldIdx.svcBody >= 0) ||
          (typeof fieldIdx.svcType === 'number' && fieldIdx.svcType >= 0) ||
          (typeof fieldIdx.svcName === 'number' && fieldIdx.svcName >= 0);
        if (!hasSvc) {
          setKaipokeImportStatus({
            kind: 'dayservice',
            ok: false,
            message: 'サービス内容等の列が見つかりませんでした。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            '「サービス内容」「業務種別」「サービス名」などの列が見つかりません。デイ・通所・短期などが書かれた行だけを利用者の「併設デイ」予定に反映します。'
          );
          return;
        }
        let appliedCells = 0;
        for (let r = headerRow + 1; r < rows.length; r++) {
          const row = rows[r] ?? [];
          if (!row.length) continue;
          if (!csvRowLooksLikeDayService(row, fieldIdx, getCell)) continue;
          const ymd = parseCsvDateCellToYmd(getCell(row, fieldIdx.dayCol), defaultYm);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
          const hit = findResidentForVitalsCsvName(filteredResidents, getCell(row, nameCol));
          if (!hit) continue;
          Report.setDayServiceCell(String(hit.id), ymd, { kind: 'on_site', source: 'kaipoke_csv' });
          appliedCells += 1;
        }
        if (appliedCells > 0) {
          setTick((n) => n + 1);
          setKaipokeImportStatus({
            kind: 'dayservice',
            ok: true,
            message: `併設デイ予定を ${appliedCells} 件、利用者×日に保存しました（日付の「日」のみの列は画面上の対象月 ${defaultYm} で解釈）。`,
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            `併設デイの予定を ${appliedCells} 件保存しました。各カードに「本日デイ」と表示され、過去1週間表の「併設デイ」行にも反映されます。`
          );
        } else {
          setKaipokeImportStatus({
            kind: 'dayservice',
            ok: false,
            message:
              'デイ・通所・短期と判定できる行がないか、氏名・日付が一致しませんでした（サービス内容列にキーワードが必要です）。',
            at: Date.now(),
            fileName: String(file.name ?? ''),
          });
          alert(
            '取り込める行がありませんでした。CSVに「デイ」「通所」「短期」等がサービス内容・業務種別に含まれる行か、利用者名・日付が名簿と一致するか確認してください。'
          );
        }
      };
      reader.onerror = () => {
        setKaipokeImportStatus({
          kind: 'dayservice',
          ok: false,
          message: 'CSV読み込みに失敗しました。',
          at: Date.now(),
          fileName: String(file.name ?? ''),
        });
        alert('CSV読み込みに失敗しました');
      };
      reader.readAsArrayBuffer(file);
    },
    [filteredResidents, selectedFacilityLinkKey, auditMonth]
  );

  const importMedicationPdfBatch = useCallback(
    async (fileList) => {
      const files = Array.from(fileList ?? []).filter((f) => /\.pdf$/i.test(String(f?.name ?? '')));
      if (!files.length) return;
      const residentPool = allResidents.length > 0 ? allResidents : filteredResidents;
      let appliedFiles = 0;
      let matchedResidents = 0;
      let totalMeds = 0;
      /** @type {string[]} */
      const unmatched = [];
      /** @type {Map<string, number>} */
      const matchedFacilityCounts = new Map();
      for (const file of files) {
        let parsed;
        try {
          parsed = await parsePharmacyMedicationPdf(file);
        } catch {
          continue;
        }
        appliedFiles += 1;
        const hit = findResidentForVitalsCsvName(residentPool, parsed.patientName || parsed.patientNameRaw);
        if (!hit) {
          const label = String(parsed.patientNameRaw || parsed.patientName || file.name || '氏名不明').trim();
          if (label) unmatched.push(label);
          continue;
        }
        const rid = String(hit.id);
        const prev = Report.getResidentMedicationProfile(rid);
        const mergedMeds = Array.from(
          new Set([...(prev?.medicines ?? []), ...(parsed.medicines ?? [])].map((s) => String(s ?? '').trim()).filter(Boolean))
        );
        const mergedFiles = Array.from(
          new Set([...(prev?.sourceFiles ?? []), String(file.name ?? '').trim()].map((s) => String(s ?? '').trim()).filter(Boolean))
        );
        Report.setResidentMedicationProfile(rid, {
          patientName: parsed.patientName || parsed.patientNameRaw || String(hit.name ?? ''),
          dispensedOn: parsed.dispensedOn || String(prev?.dispensedOn ?? ''),
          medicines: mergedMeds,
          sourceFiles: mergedFiles,
          importedAt: new Date().toISOString(),
        });
        matchedResidents += 1;
        totalMeds += parsed.medicines.length;
        const facLabel = String(
          hit.sourceSheetTitle ?? hit.facility ?? facilityDefBySheetTitle(selectedSheetTitle)?.tabLabel ?? '施設不明'
        ).trim();
        matchedFacilityCounts.set(facLabel || '施設不明', (matchedFacilityCounts.get(facLabel || '施設不明') ?? 0) + 1);
      }
      setTick((n) => n + 1);
      const unmatchedPreview = unmatched.slice(0, 6).join('、');
      const facilitySummary = Array.from(matchedFacilityCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, n]) => `${k} ${n}名`)
        .join(' / ');
      const msg = `PDF ${appliedFiles}件解析 / 利用者一致 ${matchedResidents}名 / 薬剤抽出 ${totalMeds}件${
        unmatched.length ? ` / 未一致 ${unmatched.length}件（${unmatchedPreview}${unmatched.length > 6 ? '…' : ''}）` : ''
      }${facilitySummary ? ` / 施設内訳 ${facilitySummary}` : ''}`;
      setKaipokeImportStatus({
        kind: 'medpdf',
        ok: matchedResidents > 0,
        message: msg,
        at: Date.now(),
        fileName: files.length === 1 ? String(files[0]?.name ?? '') : `${files.length} files`,
      });
      if (matchedResidents > 0) {
        alert(`薬局PDFの取り込みが完了しました。\n${msg}`);
      } else {
        alert(`薬局PDFを解析しましたが、名簿氏名と一致しませんでした。\n${msg}`);
      }
    },
    [allResidents, filteredResidents, selectedSheetTitle]
  );

  const hdrBtn =
    'flex items-center gap-1 rounded-lg border-2 px-2 py-1.5 text-[11px] font-bold shadow-sm sm:gap-1.5 sm:px-2.5 sm:text-xs 2xl:px-3 2xl:text-sm';

  return (
    <div className="flex min-h-[100dvh] min-w-0 flex-col gap-2 bg-slate-300 p-2 pb-4 font-sans text-slate-900 sm:gap-2 sm:p-2 sm:pb-4">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-2xl border border-slate-700 bg-slate-900 px-2 py-1.5 text-white shadow-lg sm:px-3 sm:py-2">
        {/* min-w あり: flex-1+min-w-0 だけだと右のボタン列に幅を取られ施設名が1文字幅まで潰れる */}
        <div className="flex min-w-[min(100%,12rem)] flex-1 flex-nowrap items-center gap-2 overflow-hidden sm:min-w-[14rem]">
          <button type="button" onClick={onBack} className="shrink-0 rounded-xl p-1.5 hover:bg-white/10" aria-label="戻る">
            <ChevronLeft className="h-6 w-6 text-slate-300 sm:h-7 sm:w-7" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-slate-300">
            <Monitor className="h-5 w-5 shrink-0 text-cyan-400 sm:h-6 sm:w-6" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-black tracking-tight text-white sm:text-lg 2xl:text-2xl">
                {selectedDef?.tabLabel ?? '施設'}
              </h1>
              <p className="truncate text-[10px] text-slate-400 sm:text-xs">
                名簿・異常検知・周知
                <span className="text-slate-500">
                  {lastUpdated ? ` ・ 同期 ${lastUpdated.toLocaleTimeString('ja-JP')}` : ' ・ 未同期'}
                </span>
                {fetchSourceMeta ? (
                  <span className="text-cyan-400">
                    {` ・ ${fetchSourceMeta.source}${fetchSourceMeta.mode ? `(${fetchSourceMeta.mode})` : ''}`}
                  </span>
                ) : null}
              </p>
            </div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto 2xl:flex-nowrap 2xl:gap-1.5">
          <button
            type="button"
            onClick={() => {
              setEmergencyPickId(String(filteredResidents[0]?.id ?? ''));
              setEmergencyOpen(true);
            }}
            className={`${hdrBtn} border-rose-500 bg-rose-600 text-white hover:bg-rose-500`}
          >
            <Ambulance className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            救急
          </button>
          <button
            type="button"
            onClick={() => {
              setInfoProvisionInitialResidentId(null);
              setInfoProvisionInitialActiveTab('import');
              setInfoProvisionOpen(true);
            }}
            className={`${hdrBtn} border-violet-500 bg-violet-700 text-white hover:bg-violet-600`}
          >
            <FileText className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            情報提供書
          </button>
          <button
            type="button"
            onClick={() => setAccidentReportOpen(true)}
            className={`${hdrBtn} border-slate-500 bg-slate-700 text-white hover:bg-slate-600`}
          >
            <ClipboardList className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            事故
          </button>
          <button
            type="button"
            onClick={() => setAccidentMonthlyOpen(true)}
            className={`${hdrBtn} border-indigo-500 bg-indigo-700 text-white hover:bg-indigo-600`}
          >
            <BarChart3 className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            月次
          </button>
          <button
            type="button"
            onClick={() => setNearMissOpen(true)}
            className={`${hdrBtn} border-teal-500 bg-teal-700 text-white hover:bg-teal-600`}
          >
            <FileWarning className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            ヒヤリ
          </button>
          <button
            type="button"
            onClick={() => setNearMissMonthlyOpen(true)}
            className={`${hdrBtn} border-teal-600 bg-teal-900 text-white hover:bg-teal-800`}
          >
            <BarChart3 className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            ヒヤリ月次
          </button>
          <button
            type="button"
            onClick={() => setNearMissAwarenessAdminOpen(true)}
            className={`${hdrBtn} border-amber-600 bg-amber-600 text-white hover:bg-amber-500`}
          >
            <Megaphone className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            全体周知
          </button>
          <div className="rounded-lg bg-slate-800 px-2 py-1 text-center">
            <p className="text-[9px] text-slate-400 leading-none">時刻</p>
            <p className="text-xs font-bold tabular-nums text-cyan-300 sm:text-sm 2xl:text-base">{nowLabel}</p>
          </div>
          <button
            type="button"
            disabled={loading || refreshing}
            onClick={() => load(true)}
            className={`${hdrBtn} border-slate-600 bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50`}
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 shrink-0" />}
            更新
          </button>
          <input
            ref={kaipokeCsvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => importKaipokeVitalsCsv(e.target.files?.[0] ?? null)}
          />
          <input
            ref={kaipokeMonthlyCsvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => importKaipokeMonthlySupplementCsv(e.target.files?.[0] ?? null)}
          />
          {facilityDayServiceMode === 'on_site_csv' ? (
            <input
              ref={kaipokeDayServiceCsvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                importKaipokeDayServiceCsv(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          ) : null}
          <input
            ref={medicationPdfInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              void importMedicationPdfBatch(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => kaipokeCsvInputRef.current?.click()}
            className={`${hdrBtn} border-cyan-700 bg-cyan-700 text-white hover:bg-cyan-600`}
            title="カイポケ：バイタル帳票の CSV／タブ区切りのみ。氏名列＋体温・血圧等のヘッダが並ぶ行を検出し、名簿の利用者のバイタルに反映します（UTF-8／Shift_JIS 自動判定・先頭30行）"
          >
            <Upload className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            バイタルCSV
          </button>
          <button
            type="button"
            onClick={() => kaipokeMonthlyCsvInputRef.current?.click()}
            className={`${hdrBtn} border-fuchsia-700 bg-fuchsia-800 text-white hover:bg-fuchsia-700`}
            title={`カイポケ「訪問記録」等（日付・氏名・サービス内容・職員名などの列）のみ。対象月「${auditMonth}」の月次ご報告（AI・HTML）に反映。訪問看護の勤務スケジュール・別システムの CSV は対象外です。`}
          >
            <Upload className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            月次用CSV
          </button>
          {facilityDayServiceMode === 'on_site_csv' ? (
            <button
              type="button"
              onClick={() => kaipokeDayServiceCsvInputRef.current?.click()}
              className={`${hdrBtn} border-teal-800 bg-teal-800 text-white hover:bg-teal-700`}
              title="カイポケの予定表・訪問記録CSV。氏名・日付・サービス内容に「デイ」「通所」「短期」等がある行を、利用者の併設デイ予定（本日バッジ・過去1週表）に保存します。日付が「日」だけの列は、下の対象月と同じ年月で解釈します。"
            >
              <Upload className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
              デイ予定CSV
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => medicationPdfInputRef.current?.click()}
            className={`${hdrBtn} border-indigo-800 bg-indigo-800 text-white hover:bg-indigo-700`}
            title="薬局のお薬説明書PDF（同一書式）を複数まとめて取り込み。氏名で名簿に照合し、各利用者カードの薬情報に振り分けます。"
          >
            <Upload className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            薬局PDF
          </button>
          <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-slate-600 bg-slate-800 px-1.5 py-0.5">
            <input
              type="month"
              value={auditMonth}
              onChange={(e) => setAuditMonth(e.target.value)}
              className="max-w-[7.5rem] rounded bg-slate-700 px-1 py-0.5 text-[10px] text-white sm:max-w-[9rem] sm:text-xs"
            />
            <button
              type="button"
              onClick={exportAudit}
              title="件数・最終日時の集計（Excel向け）"
              className="flex items-center gap-0.5 rounded-md bg-amber-600 px-1.5 py-1 text-[10px] font-bold text-white hover:bg-amber-500 sm:text-xs"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              CSV
            </button>
            <button
              type="button"
              onClick={exportAuditNarrative}
              title="有料監査用: 巡視の間隔・食事の割合・排泄の間隔・一言要約＋請求用食事・経管（HTML・印刷可）"
              className="flex items-center gap-0.5 rounded-md bg-teal-700 px-1.5 py-1 text-[10px] font-bold text-white hover:bg-teal-600 sm:text-xs"
            >
              <FileText className="h-3.5 w-3.5" />
              監査HTML
            </button>
          </div>
          {typeof onOpenNotionNewResidents === 'function' ? (
            <button
              type="button"
              onClick={onOpenNotionNewResidents}
              className={`${hdrBtn} border-violet-700 bg-violet-600 text-white hover:bg-violet-500`}
              title="営業が Notion に登録した新規入居一覧"
            >
              <Baby className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
              新規入居
            </button>
          ) : null}
          <button
            type="button"
            onClick={onOpenMonthlyReport}
            className={`${hdrBtn} border-emerald-700 bg-emerald-600 text-white hover:bg-emerald-500`}
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
            報告
          </button>
        </div>
      </header>

      <div className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-[11px] font-bold text-slate-700 sm:text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-cyan-700">バイタルCSV: 利用者カードの「直近バイタル」に反映</span>
          <span className="text-fuchsia-700">
            月次用CSV: カイポケ訪問記録形式のみ → 月次ご報告（AI・印刷HTML）／対象月 {auditMonth}／保存済み{' '}
            {monthlyImportedSummary.residentCount}名・{monthlyImportedSummary.lineCount}行（訪看スケジュール用ではありません）
          </span>
          {facilityDayServiceMode === 'on_site_csv' ? (
            <span className="text-teal-800">
              デイ予定CSV: サービス内容にデイ・通所・短期等がある行のみ → 各利用者の「併設デイ」予定（本日表示・週表）。日付が1〜31のみのときは対象月 {auditMonth}{' '}
              を使用します。
            </span>
          ) : facilityDayServiceMode === 'external_manual' ? (
            <span className="text-indigo-800">
              外部通所デイ: 各カードの「外部デイの予定」から、今後4週間を手入力できます（本日 外部デイ・週表に反映）。
            </span>
          ) : null}
          <span className="text-indigo-700">
            薬局PDF: 同一書式の「お薬説明書」を複数選択。氏名が名簿と一致すると、その利用者カードの「薬情報」と救急印刷に反映されます。
          </span>
        </div>
        {kaipokeImportStatus ? (
          <p className={`mt-1 ${kaipokeImportStatus.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
            最終取り込み[
            {kaipokeImportStatus.kind === 'vitals'
              ? 'バイタルCSV'
              : kaipokeImportStatus.kind === 'monthly'
                ? '月次用CSV'
                : kaipokeImportStatus.kind === 'dayservice'
                  ? 'デイ予定CSV'
                  : kaipokeImportStatus.kind === 'medpdf'
                    ? '薬局PDF'
                    : '取込'}
            ]:
            {' '}
            {kaipokeImportStatus.message}
            {kaipokeImportStatus.fileName ? ` / ${kaipokeImportStatus.fileName}` : ''}
            {' '}
            ({new Date(kaipokeImportStatus.at).toLocaleTimeString('ja-JP')})
          </p>
        ) : null}
      </div>

      {error && (
        <div className="shrink-0 rounded-2xl border-2 border-rose-400 bg-rose-50 px-4 py-3 text-base text-rose-900">
          <p className="font-bold">{error}</p>
          <p className="mt-2 text-sm font-normal text-rose-800">
            {fetchSourceMeta?.source === 'supabase'
              ? '名簿は Supabase（VITE_RESIDENTS_SOURCE=supabase）。URL・anon キー・RLS・residents の行数を確認してください。'
              : 'API キーあり: Sheets API。キーなし: 公開CSV（npm run dev 必須）。シートは閲覧可能な共有にしてください。'}
          </p>
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2 lg:gap-3">
          <section className="order-1 flex flex-col gap-2">
            <div className="flex flex-col gap-2">
              <NearMissAwarenessPanel
                compact={false}
                sheetsApiKey={SHEETS_KEY}
                facilityLinkKey={linkKeyForSheetTitle(selectedSheetTitle)}
                facilityTabLabel={selectedDef?.tabLabel ?? ''}
                onOpenAdmin={() => setNearMissAwarenessAdminOpen(true)}
              />
              <div className="flex min-h-0 min-w-0 flex-col rounded-2xl border-2 border-amber-400 bg-gradient-to-br from-amber-50 via-orange-50/80 to-amber-100/60 p-2.5 shadow-md sm:p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-amber-950">
                  <Megaphone className="h-6 w-6 shrink-0 sm:h-7 sm:w-7" />
                  <h2 className="text-base font-black sm:text-lg 2xl:text-xl">本日の周知事項</h2>
                </div>
                <p className="min-h-0 flex-1 text-sm font-bold leading-relaxed text-amber-950 sm:text-base 2xl:text-lg">
                  {board.notice}
                </p>
              </div>
              <div className="flex min-w-0 flex-col rounded-2xl border-2 border-teal-300/90 bg-teal-50/95 p-3 shadow-md">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-teal-900">
                  <CalendarDays className="h-5 w-5 shrink-0" />
                  <h3 className="text-base font-black">今週の予定（7日分・一覧）</h3>
                </div>
                <p className="mb-2 text-[11px] font-bold leading-snug text-teal-900/85">
                  公式LINEの面会予約が入った Google カレンダーの予定も、ここに自動で載ります（緑の Google 表示）。手入力の外出・受診なども下のフォームから追記できます。
                </p>
                {!visitCalendarConfigured ? (
                  <p className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-2 text-[11px] font-bold leading-snug text-amber-950">
                    この施設（{selectedDef?.tabLabel ?? '—'}）の<strong className="font-black">面会予約用・施設専用</strong>
                    Google カレンダーが未設定です（個人の「私のカレンダー」は使いません）。{' '}
                    <code className="rounded bg-amber-100 px-0.5">facilityIntegrations.js</code> の googleCalendarId、または .env の{' '}
                    <code className="rounded bg-amber-100 px-0.5">VITE_GOOGLE_CALENDAR_BY_FACILITY</code>
                    に「{selectedDef?.linkKey ?? 'linkKey'}」→ 施設カレンダーID を入れてください。
                  </p>
                ) : googleCalendarStatus === 'error' ? (
                  <p className="mb-2 rounded-lg border border-rose-300 bg-rose-50 px-2 py-2 text-[11px] font-bold text-rose-900">
                    Google カレンダーの取得に失敗しました。カレンダー共有（リンクを知っている全員が閲覧可）と API キーを確認し、右上の「更新」を押してください。
                  </p>
                ) : null}
                {weeklyPlanDays.length === 0 ? (
                  <p className="mb-2 rounded-lg border border-dashed border-teal-300 bg-white/70 px-2 py-3 text-center text-sm font-bold text-slate-600">
                    施設を選ぶと、ここに7日分の枠が表示されます。
                  </p>
                ) : (
                  <div className="carelink-resident-grid-scroll mb-2 flex gap-2 overflow-x-auto overflow-y-visible pb-2 pl-0.5 pr-1 pt-0.5">
                    {weeklyPlanDays.map((day) => (
                      <div
                        key={day.date}
                        className={`flex w-[min(100%,10.5rem)] shrink-0 flex-col rounded-xl border-2 shadow-sm ${
                          day.isToday
                            ? 'border-teal-600 bg-white ring-2 ring-teal-400/50'
                            : 'border-teal-200/90 bg-white/95'
                        }`}
                      >
                        <div className="shrink-0 border-b border-teal-100 bg-teal-600/10 px-2 py-1.5 text-center">
                          <div className="font-mono text-[11px] font-bold text-teal-800">{day.date}</div>
                          <div className="text-xs font-black text-teal-950 sm:text-sm">
                            {day.weekdayShort}曜
                            {day.isToday ? (
                              <span className="ml-1 inline-block rounded bg-teal-600 px-1 py-0.5 align-middle text-[9px] text-white">
                                今日
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <ul className="min-h-[6.5rem] space-y-1.5 p-2 text-[11px] sm:min-h-[7.5rem] sm:text-xs">
                          {day.plans.length === 0 ? (
                            <li className="rounded-lg border border-dashed border-slate-200 bg-slate-50/90 px-2 py-3 text-center font-bold leading-snug text-slate-500">
                              予定なし
                            </li>
                          ) : (
                            day.plans.map((p) => (
                              <li
                                key={String(p.id)}
                                className="rounded-lg border border-teal-200 bg-teal-50/90 px-2 py-1.5 shadow-sm"
                              >
                                <div className="font-mono text-[11px] font-black text-teal-900">{p.time}</div>
                                <span className="mt-0.5 inline-block rounded bg-teal-600/90 px-1 py-0.5 text-[9px] font-black text-white">
                                  {p.type}
                                </span>
                                {String(p.source ?? '') === 'google_calendar' ? (
                                  <span className="ml-1 mt-0.5 inline-block rounded bg-emerald-600 px-1 py-0.5 text-[9px] font-black text-white">
                                    {p.type === '面会' ? 'LINE/Google' : 'Google'}
                                  </span>
                                ) : null}
                                <div className="mt-1 font-bold leading-snug text-slate-900">{p.title}</div>
                                {String(p.source ?? '') === 'google_calendar' ? null : (
                                  <button
                                    type="button"
                                    onClick={() => removeWeeklyPlan(p.id)}
                                    className="mt-1 rounded border border-teal-300 bg-white px-1.5 py-0.5 text-[10px] font-black text-teal-800"
                                  >
                                    削除
                                  </button>
                                )}
                              </li>
                            ))
                          )}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mb-2 text-[10px] font-bold text-slate-500">予定を追加・更新する（任意）</p>
                <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    type="date"
                    value={planDraftDate}
                    onChange={(e) => setPlanDraftDate(e.target.value)}
                    className="rounded-lg border border-teal-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
                  />
                  <input
                    type="time"
                    value={planDraftTime}
                    onChange={(e) => setPlanDraftTime(e.target.value)}
                    className="rounded-lg border border-teal-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
                  />
                  <select
                    value={planDraftType}
                    onChange={(e) => setPlanDraftType(e.target.value)}
                    className="rounded-lg border border-teal-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
                  >
                    <option value="外出">外出</option>
                    <option value="外泊">外泊</option>
                    <option value="受診">受診</option>
                    <option value="往診">往診</option>
                    <option value="面会">面会</option>
                    <option value="その他">その他</option>
                  </select>
                  <input
                    type="text"
                    value={planDraftTitle}
                    onChange={(e) => setPlanDraftTitle(e.target.value)}
                    placeholder="例: 〇〇様 14:00 内科（薬手帳・頓服）"
                    className="rounded-lg border border-teal-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
                  />
                </div>
                <button
                  type="button"
                  onClick={registerWeeklyPlan}
                  className="mb-2 w-full rounded-lg bg-teal-600 px-3 py-2 text-sm font-black text-white hover:bg-teal-500"
                >
                  上記の日付に予定を1件追加
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 xl:gap-3 xl:items-stretch">
              <div className="flex min-h-0 min-w-0 flex-col rounded-2xl border-2 border-rose-300 bg-gradient-to-br from-rose-50 to-rose-100/40 p-2.5 shadow-md sm:p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-rose-900">
                  <Stethoscope className="h-6 w-6 shrink-0" />
                  <h2 className="text-base font-black sm:text-lg 2xl:text-xl">看護からの重要指示</h2>
                </div>
                <div className="space-y-2 pr-1">
                  {nursingList.length === 0 ? (
                    <p className="text-base font-bold text-rose-700">看護からの処置・指示は未登録です。下欄に入力して掲示してください。</p>
                  ) : (
                    nursingList.map((d, i) => (
                      <div
                        key={`${d.ts}-${i}`}
                        className="rounded-xl border-2 border-rose-400 bg-white px-4 py-3 text-lg font-bold leading-snug text-rose-950 shadow-sm sm:text-xl"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <span className="mr-2 text-sm font-bold text-rose-500">{d.by}</span>
                            {d.text}
                            {(d.startDate || d.endDate) ? (
                              <div className="mt-1 text-[11px] font-bold text-rose-700">
                                表示期間: {d.startDate || '今日'} 〜 {d.endDate || '未設定'}
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => removeNursing(d)}
                            className="shrink-0 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-black text-rose-700"
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-2 flex shrink-0 flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={nursingDraft}
                    onChange={(e) => setNursingDraft(e.target.value)}
                    placeholder="例: 下剤投与につき排便確認／褥瘡あり：右側臥位注意"
                    className="min-w-0 flex-1 rounded-xl border-2 border-rose-300 px-3 py-2.5 text-base font-bold text-slate-900 outline-none focus:ring-2 focus:ring-rose-400"
                  />
                  <button
                    type="button"
                    onClick={registerNursing}
                    className="shrink-0 rounded-xl bg-rose-600 px-5 py-2.5 text-base font-black text-white shadow-md hover:bg-rose-500"
                  >
                    看護指示を掲示
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    type="date"
                    value={nursingStartDate}
                    onChange={(e) => setNursingStartDate(e.target.value)}
                    className="rounded-lg border border-rose-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
                  />
                  <input
                    type="date"
                    value={nursingEndDate}
                    onChange={(e) => setNursingEndDate(e.target.value)}
                    className="rounded-lg border border-rose-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
                    placeholder="終了日（任意）"
                  />
                </div>
              </div>
              <div className="flex min-h-0 min-w-0 flex-col rounded-2xl border-2 border-indigo-200/90 bg-indigo-50/95 p-2.5 shadow-md sm:p-3">
                <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-indigo-900">
                  <ClipboardList className="h-5 w-5 shrink-0 sm:h-6 sm:w-6" />
                  <h2 className="text-base font-bold sm:text-lg">申し送り</h2>
                  <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-black tracking-wide text-white">
                    施設共通
                  </span>
                </div>
                <p className="mb-2 text-[11px] font-bold leading-snug text-indigo-900/90">
                  <span className="text-indigo-950">{selectedDef?.tabLabel ?? '施設'}</span>
                  で共有中。個別の出来事は本文の先頭に <strong>利用者名・居室</strong> を入れてください（例：「〇〇様（101）　19時転倒…」）。
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-indigo-950 sm:text-base 2xl:text-lg">
                  {board.handover}
                </p>
              </div>
              <div className="flex min-h-0 min-w-0 flex-col rounded-2xl border-2 border-teal-300/90 bg-teal-50/95 p-2.5 shadow-md sm:p-3">
                <div className="mb-2 flex items-center gap-2 text-teal-900">
                  <CalendarClock className="h-5 w-5 shrink-0 sm:h-6 sm:w-6" />
                  <h2 className="text-base font-bold sm:text-lg">本日の予定</h2>
                </div>
                <ul className="space-y-1.5 pr-1 text-sm sm:text-base">
                  {(todayPlans.length > 0 ? todayPlans : board.schedule).map((item, i) => (
                    <li
                      key={String(item.id ?? i)}
                      className="flex gap-3 rounded-xl border border-teal-200/80 bg-white/90 px-3 py-2.5 shadow-sm"
                    >
                      <span className="w-16 shrink-0 font-mono font-bold text-teal-700">{item.time || '—'}</span>
                      <div className="min-w-0">
                        <span className="font-bold leading-snug text-slate-800">{item.title || '予定'}</span>
                        {String(item.source ?? '') === 'google_calendar' ? (
                          <span className="ml-1.5 inline-block rounded bg-emerald-600 px-1.5 py-0.5 text-[9px] font-black text-white">
                            Google
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              </div>
            </div>
          </section>

          <section className="order-2 flex min-w-0 flex-col rounded-2xl border-2 border-slate-400 bg-white shadow-inner">
            <div className="shrink-0 border-b border-slate-200 bg-slate-100/90 px-2 py-1.5 sm:px-3 sm:py-2">
              <h2 className="text-base font-bold text-slate-900 sm:text-lg 2xl:text-xl">入居者一覧・異常監視</h2>
              {residentFilterBanner ? (
                <p className="mt-2 rounded-xl border-2 border-amber-500 bg-amber-50 px-3 py-2 text-xs font-bold leading-snug text-amber-950 sm:text-sm">
                  {residentFilterBanner}
                </p>
              ) : null}
              <p className="mt-0.5 text-sm font-bold text-blue-700 sm:text-base">{headerResidentCountSubtitle}</p>
            </div>
            <div className="shrink-0 border-b border-slate-200 bg-slate-100/90 px-2 py-1.5 sm:px-3 sm:py-2">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <details className="mt-1 max-w-full rounded-xl border border-sky-200 bg-sky-50/80 px-2 py-1.5 shadow-sm sm:px-3 sm:py-2">
                    <summary className="flex cursor-pointer list-none flex-col gap-1 text-xs font-black text-sky-950 sm:text-sm [&::-webkit-details-marker]:hidden">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Stethoscope className="h-4 w-4 shrink-0 text-sky-700" aria-hidden />
                        名簿サマリー（詳細はタップで展開）
                        <span className="rounded bg-white/80 px-1.5 py-0.5 text-[10px] font-bold text-sky-800">
                          展開
                        </span>
                      </span>
                      <span className="pl-5 text-[10px] font-bold text-sky-800 sm:text-[11px]">
                        平均介護度{' '}
                        {facilityCareStats.averageCareLevel != null
                          ? facilityCareStats.averageCareLevel.toFixed(2)
                          : '—'}{' '}
                        ／ 医療保険対象 {facilityCareStats.medicalTargetCount} 名
                        {nursingOfficeUi ? ` ／ 訪看・特 ${visitNursingStats.count} 名` : ''}
                      </span>
                    </summary>
                    <div className="mt-2 border-t border-sky-200 pt-2">
                      <div
                        className={`grid grid-cols-1 gap-2 ${nursingOfficeUi ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}
                      >
                        <div className="rounded-lg border border-rose-200 bg-rose-50/90 px-2 py-2 text-center">
                          <p className="text-[10px] font-black text-rose-800 sm:text-xs">平均介護度</p>
                          <p className="mt-0.5 font-mono text-xl font-black text-rose-950 sm:text-2xl">
                            {facilityCareStats.averageCareLevel != null
                              ? facilityCareStats.averageCareLevel.toFixed(2)
                              : '—'}
                          </p>
                        </div>
                        <div className="rounded-lg border border-cyan-300 bg-cyan-50/90 px-2 py-2 text-center">
                          <p className="text-[10px] font-black text-cyan-900 sm:text-xs">医療保険対象者</p>
                          <p className="mt-0.5 font-mono text-xl font-black text-slate-950 sm:text-2xl">
                            {facilityCareStats.medicalTargetCount}
                          </p>
                          <p className="text-[10px] font-bold text-cyan-900">名</p>
                        </div>
                        {nursingOfficeUi ? (
                          <div
                            className={`rounded-lg border px-2 py-2 text-center ${
                              visitNursingStats.warn
                                ? 'border-amber-500 bg-amber-50'
                                : 'border-teal-300 bg-teal-50/90'
                            }`}
                          >
                            <p className="flex items-center justify-center gap-1 text-[10px] font-black text-teal-950 sm:text-xs">
                              <Home className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              訪問看護・特別指示
                            </p>
                            <p className="mt-0.5 font-mono text-xl font-black text-slate-950 sm:text-2xl">
                              {visitNursingStats.count}
                            </p>
                            <p className="text-[10px] font-bold text-teal-900">名（名簿＋手動）</p>
                            {visitNursingStats.warn ? (
                              <p className="mt-1 rounded border border-amber-400 bg-amber-100 px-1.5 py-1 text-[9px] font-black leading-snug text-amber-950">
                                {visitNursingStats.threshold}名以上：減算・体制の管理が必要です（算定要件は最新告示で確認）
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </details>
                  <p className="mt-2 text-[10px] font-bold text-slate-500 sm:text-xs">
                    赤: バイタル・排便 / 黄: 巡視遅延 / 紫枠: 減算・監査の確認候補
                  </p>
                  <p className="mt-1 text-[10px] font-bold text-slate-600 sm:text-xs">
                    請求用: 当月食事は名簿の食事列＋この端末の記録を合算（{billingYearMonth}）。経管は名簿の「経管栄養」列と、生活記録保存時の経管実施ログを集計。
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 text-[11px] font-bold sm:gap-3 sm:text-sm">
                  <span className="flex items-center gap-1 text-red-600">
                    <AlertTriangle className="h-5 w-5" /> バイタル・排便
                  </span>
                  <span className="flex items-center gap-1 text-amber-600">
                    <Wind className="h-5 w-5" /> 巡視
                  </span>
                </div>
              </div>
            </div>

            <div className="flex min-w-0 flex-col p-2 sm:p-3">
              {loading ? (
                <div className="flex h-40 flex-col items-center justify-center gap-4 text-slate-500">
                  <Loader2 className="h-12 w-12 animate-spin text-blue-600" />
                  <span className="text-xl font-bold">読み込み中…</span>
                </div>
              ) : filteredResidents.length === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center text-lg text-slate-600">
                  <p className="font-bold">表示できる入居者がいません。</p>
                  {allResidents.length > 0 ? (
                    <p className="mt-3 max-w-lg text-base font-normal leading-relaxed text-slate-600">
                      名簿は {allResidents.length} 名読み込めていますが、いま選んでいる施設タブ（
                      {selectedDef?.tabLabel ?? '—'}）と一致する行がありません。ポータルから別の施設を選び直す・
                      <strong className="font-bold text-slate-800">更新</strong>
                      を押す・スプレッドシートのタブ名をアプリ設定（
                      <code className="rounded bg-slate-200 px-1 text-sm">carelinkFacilities.js</code> の sheetTitle）と揃える・「施設」列の表記を確認してください。
                    </p>
                  ) : fetchSourceMeta?.source === 'supabase' ? (
                    <p className="mt-3 max-w-lg text-base font-normal leading-relaxed text-slate-600">
                      Supabase の名簿が0件です。ダッシュボードの <code className="rounded bg-slate-200 px-1 text-sm">residents</code>{' '}
                      にデータがあるか、RLS の dev 用ポリシー（
                      <code className="rounded bg-slate-200 px-1 text-sm">dev_anon_read_residents</code>）を適用しているか確認してください。
                      スプレッドシート名簿に戻す場合は <code className="rounded bg-slate-200 px-1 text-sm">.env.local</code> の{' '}
                      <code className="rounded bg-slate-200 px-1 text-sm">VITE_RESIDENTS_SOURCE=supabase</code> を外し、開発サーバーを再起動してください。
                    </p>
                  ) : (
                    <p className="mt-3 max-w-lg text-base font-normal leading-relaxed text-slate-600">
                      名簿が0件です。1行目に「氏名」列があるか、APIキー・スプレッドシートIDを確認してください。
                      画面上部の取得元表示（sheets_api / csv）と、<strong className="font-bold text-slate-800">更新</strong>ボタンも確認してください。
                    </p>
                  )}
                </div>
              ) : displayResidents.length === 0 ? (
                <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-600">
                  <p className="text-base font-bold">名前検索に一致する入居者がいません。</p>
                  <p className="mt-2 text-sm">検索語: 「{residentNameQuery}」</p>
                </div>
              ) : (
                <>
                  <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-2 py-2 sm:px-3">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <label className="text-[11px] font-black text-slate-600 sm:text-xs">利用者検索</label>
                      <input
                        type="text"
                        lang="ja"
                        autoComplete="off"
                        value={residentNameInput}
                        onCompositionStart={() => {
                          residentNameCompositionRef.current = true;
                        }}
                        onCompositionEnd={(e) => {
                          residentNameCompositionRef.current = false;
                          const v = e.currentTarget.value;
                          setResidentNameInput(v);
                          setResidentNameQuery(v);
                        }}
                        onChange={(e) => {
                          const v = e.target.value;
                          setResidentNameInput(v);
                          if (residentNameCompositionRef.current || e.nativeEvent?.isComposing) return;
                          setResidentNameQuery(v);
                        }}
                        placeholder="利用者検索（例: いとう）"
                        className="w-[11rem] rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-800 placeholder:text-slate-400 sm:w-[13rem] sm:text-sm"
                        aria-label="入居者の名前検索"
                      />
                      <div className="mr-1 inline-flex overflow-hidden rounded-xl border-2 border-slate-200 bg-white">
                        <button
                          type="button"
                          onClick={() => setResidentSortMode('room')}
                          className={`px-3 py-2 text-xs font-black sm:text-sm ${
                            residentSortMode === 'room'
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          部屋順
                        </button>
                        <button
                          type="button"
                          onClick={() => setResidentSortMode('kana')}
                          className={`border-l-2 border-slate-200 px-3 py-2 text-xs font-black sm:text-sm ${
                            residentSortMode === 'kana'
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          あいうえお順
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setResidentInputView('cards')}
                        className={`rounded-xl border-2 px-3 py-2 text-xs font-black sm:text-sm ${
                          residentInputView === 'cards'
                            ? 'border-blue-600 bg-blue-600 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        カード表示
                      </button>
                      <button
                        type="button"
                        onClick={switchToTableInput}
                        className={`inline-flex items-center gap-1.5 rounded-xl border-2 px-3 py-2 text-xs font-black sm:text-sm ${
                          residentInputView === 'table'
                            ? 'border-emerald-600 bg-emerald-600 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <Table2 className="h-4 w-4 shrink-0" aria-hidden />
                        一覧表で入力
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] font-bold leading-snug text-slate-600 sm:text-xs">
                      名前をタップで行動メニュー（巡視・生活記録・障害福祉進捗・入退院・薬情報・情報提供書など）。画面上部の「情報提供書」から全体の取込もできます。一覧表は横スクロールで連続入力し、Tabキーで移動できます。
                    </p>
                  </div>
                  {residentInputView === 'table' ? (
                    <ResidentBulkInputTable
                      key={`bulk-input-${bulkTableYmd(bulkSheetDate)}`}
                      filteredResidents={displayResidents}
                      bulkDraft={bulkDraft}
                      bulkGlobalMealSlot={bulkGlobalMealSlot}
                      onBulkGlobalMealSlotChange={onBulkGlobalMealSlotChange}
                      bulkSheetDate={bulkSheetDate}
                      onBulkSheetDateChange={setBulkSheetDate}
                      hourlySavedByResident={bulkHourlySavedByResident}
                      bulkMealSummaryByResident={bulkMealSummaryByResident}
                      residentNameWithoutSama={residentNameWithoutSama}
                      patchBulkRow={patchBulkRow}
                      setBulkPatrolForAllVisible={setBulkPatrolForAllVisible}
                      fillPastHourlyPatrolForAllVisible={fillPastHourlyPatrolForAllVisible}
                      bulkRowHasInput={bulkRowHasInput}
                      saveBulkRow={saveBulkRow}
                      saveBulkAllWithInput={saveBulkAllWithInput}
                      saveBulkVitalsOnly={saveBulkVitalsOnly}
                      geminiApiKey={GEMINI_KEY}
                    />
                  ) : (
                    <div
                      className="grid min-w-0 max-w-full gap-2 pb-4 pl-0.5 pr-1 sm:gap-3 sm:pr-2 sm:pb-6"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))' }}
                    >
                  {displayResidents.map((res) => {
                    void tick;
                    void monitorMuteRev;
                    const rawEv = Report.evaluateResidentMonitor(res, { ignoreMute: true });
                    const muted = Report.isResidentMonitorAlertMuted(String(res.id));
                    const ev = muted ? Report.evaluateResidentMonitor(res) : rawEv;
                    const ded = Report.evaluateReimbursementDeductionAlerts(res, ev);
                    const critical = ev.level === 'critical';
                    const warn = ev.level === 'warn';
                    const adviceShort = critical ? Report.fallbackRegulatoryAdvice(ev) : '';
                    const showMuteRow =
                      !muted &&
                      (rawEv.level === 'critical' || rawEv.level === 'warn' || ded.hasAlert);
                    const cal = calOpenId === String(res.id) ? Report.getWeekCalendarBuckets(String(res.id)) : [];
                    const careCanonical = normalizeCareLevelLabel(String(res.careLevelLabel ?? '').trim());
                    const careDisplay = formatCareLevelForDisplay(res.careLevelLabel);
                    const careBadgeClass = (() => {
                      if (!careCanonical) return '';
                      const c = careCanonical.replace(/\s/g, '');
                      if (/^要介護[45]$/.test(c)) return 'bg-rose-700 text-white border-rose-900';
                      if (/^要介護[123]$/.test(c)) return 'bg-amber-600 text-white border-amber-800';
                      if (/^要支援/.test(c)) return 'bg-sky-600 text-white border-sky-800';
                      if (/自立/.test(careCanonical)) return 'bg-emerald-600 text-white border-emerald-800';
                      return 'bg-slate-700 text-white border-slate-900';
                    })();
                    const bill = residentBillingById.get(String(res.id)) ?? { mealLogged: 0, enteralLogged: 0 };
                    const surroundMemo = surroundMemoByResident.get(String(res.id)) ?? {
                      text: '',
                      handwritingDataUrl: '',
                    };
                    const surroundLocalText = String(surroundMemo.text ?? '').trim();
                    const surroundLocalHw = String(surroundMemo.handwritingDataUrl ?? '').trim();
                    const surroundHasStaff = Boolean(surroundLocalText || surroundLocalHw);
                    const sheetCondition = String(res.condition ?? '').trim();
                    const sheetMeal = Number(res.mealCountThisMonth) || 0;
                    const mealTotal = sheetMeal + bill.mealLogged;
                    const mealBySlot = bill.mealLoggedBySlot ?? { 朝: 0, 昼: 0, 夜: 0 };
                    const showHomeDoctor =
                      (selectedDef?.linkKey === '北名古屋' ||
                        selectedDef?.linkKey === '起' ||
                        selectedDef?.linkKey === '一宮') &&
                      String(res.homeDoctor ?? '').trim();
                    return (
                      <div
                        key={String(res.id)}
                        className={`flex min-w-0 flex-col rounded-2xl border-2 p-4 text-left shadow-sm ${
                          critical
                            ? 'animate-carelink-blink border-red-800 bg-red-600 text-white'
                            : warn
                              ? 'border-amber-500 bg-amber-100 text-slate-900'
                              : 'border-slate-200 bg-white text-slate-900'
                        }`}
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => onSelectResident(res)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onSelectResident(res);
                            }
                          }}
                          className="w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2"
                        >
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="line-clamp-2 text-2xl font-black leading-tight">
                                {residentNameWithoutSama(res.name)}
                                <span className="text-xl"> 様</span>
                              </div>
                              <div
                                className={`mt-2 rounded-xl border-2 px-3 py-2 ${
                                  critical ? 'border-white/50 bg-black/25' : 'border-slate-300 bg-slate-50'
                                }`}
                              >
                                <div
                                  className={`text-[10px] font-black uppercase tracking-wide ${
                                    critical ? 'text-red-100' : 'text-slate-500'
                                  }`}
                                >
                                  介護度
                                </div>
                                <div className="mt-1">
                                  {careDisplay ? (
                                    <span
                                      className={`inline-block rounded-lg border-2 px-2.5 py-1 text-sm font-black sm:text-base ${careBadgeClass}`}
                                    >
                                      {careDisplay}
                                    </span>
                                  ) : (
                                    <span
                                      className={`text-sm font-black ${critical ? 'text-red-100' : 'text-slate-400'}`}
                                    >
                                      名簿未登録
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              {(() => {
                                const cell = Report.getDayServiceCell(String(res.id), todayStrip);
                                if (!cell) return null;
                                if (cell.kind === 'on_site')
                                  return (
                                    <span className="rounded-full bg-teal-600 px-2 py-0.5 text-[10px] font-black text-white">
                                      本日デイ
                                    </span>
                                  );
                                if (cell.kind === 'external')
                                  return (
                                    <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-black text-white">
                                      本日 外部デイ
                                    </span>
                                  );
                                return null;
                              })()}
                              <span
                                className={`rounded-md px-2 py-0.5 text-sm font-bold uppercase tracking-wide ${
                                  critical ? 'text-red-100' : 'text-slate-500'
                                }`}
                              >
                                {String(res.room)}
                              </span>
                              <div className="flex shrink-0 gap-1">
                                {critical && <AlertCircle className="h-6 w-6 text-white" />}
                                {warn && !critical && <Clock className="h-5 w-5 animate-pulse text-amber-700" />}
                              </div>
                            </div>
                          </div>
                          <div
                            role="group"
                            aria-label="周囲事項"
                            onClick={(e) => e.stopPropagation()}
                            className={`rounded-lg border-2 px-2 py-1.5 ${
                              critical ? 'border-white/40 bg-black/20' : 'border-slate-200 bg-slate-50/90'
                            }`}
                          >
                            <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                              <span
                                className={`text-[9px] font-black tracking-wide ${
                                  critical ? 'text-red-100' : 'text-slate-500'
                                }`}
                              >
                                周囲事項
                              </span>
                              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSurroundDraftText(String(surroundMemo.text ?? ''));
                                    setSurroundTextEditId(String(res.id));
                                  }}
                                  className={`rounded-md border px-1.5 py-0.5 text-[9px] font-black ${
                                    critical
                                      ? 'border-red-100/50 bg-white/10 text-white hover:bg-white/20'
                                      : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
                                  }`}
                                >
                                  文字
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSurroundHandwritingId(String(res.id))}
                                  className={`inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[9px] font-black ${
                                    critical
                                      ? 'border-red-100/50 bg-white/10 text-white hover:bg-white/20'
                                      : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
                                  }`}
                                >
                                  <PenLine className="h-3 w-3 shrink-0" aria-hidden />
                                  手書き
                                </button>
                                {surroundHasStaff ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      Report.updateResidentSurroundMemo(String(res.id), {
                                        text: '',
                                        handwritingDataUrl: '',
                                      });
                                      setSurroundMemoRev((n) => n + 1);
                                    }}
                                    className={`rounded-md border px-1.5 py-0.5 text-[9px] font-black ${
                                      critical
                                        ? 'border-red-200/60 text-red-100 hover:bg-white/10'
                                        : 'border-rose-300 bg-rose-50 text-rose-900 hover:bg-rose-100'
                                    }`}
                                  >
                                    リセット
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            {surroundHasStaff ? (
                              <div className={`space-y-1 text-sm font-bold sm:text-base ${critical ? 'text-red-50' : 'text-slate-800'}`}>
                                {surroundLocalText ? (
                                  <p className="line-clamp-4 whitespace-pre-wrap break-words leading-snug">{surroundMemo.text}</p>
                                ) : null}
                                {surroundLocalHw ? (
                                  <img
                                    src={surroundLocalHw}
                                    alt=""
                                    className="max-h-24 w-full rounded-md border border-slate-200 bg-white object-contain object-left"
                                  />
                                ) : null}
                                {sheetCondition ? (
                                  <p
                                    className={`border-t pt-1 text-[10px] font-bold leading-snug ${
                                      critical ? 'border-white/20 text-red-100/90' : 'border-slate-200 text-slate-500'
                                    }`}
                                  >
                                    名簿: {sheetCondition}
                                  </p>
                                ) : null}
                              </div>
                            ) : (
                              <p
                                className={`line-clamp-3 text-sm font-bold leading-snug sm:text-base ${
                                  critical ? 'text-red-100' : 'text-slate-600'
                                }`}
                              >
                                {sheetCondition || '—'}
                              </p>
                            )}
                          </div>
                          {String(res.insuranceLabel ?? '').trim() ? (
                            <div
                              className={`mt-1 line-clamp-2 text-[11px] font-bold sm:text-xs ${
                                critical ? 'text-red-100/90' : 'text-sky-800'
                              }`}
                            >
                              保険: {String(res.insuranceLabel)}
                            </div>
                          ) : null}
                          {showHomeDoctor ? (
                            <div
                              className={`mt-1 line-clamp-1 text-[11px] font-black sm:text-xs ${
                                critical ? 'text-red-100/90' : 'text-emerald-800'
                              }`}
                            >
                              在宅医: {String(res.homeDoctor)}
                            </div>
                          ) : null}
                          {nursingOfficeUi &&
                            (String(res.insuranceCategory ?? '') === '医療保険特指示' ||
                              /特指示|特別指示/u.test(String(res.insuranceLabel ?? ''))) && (
                            <div
                              className={`mt-1.5 rounded-lg border-2 px-2 py-1.5 text-[10px] font-black leading-snug sm:text-[11px] ${
                                critical
                                  ? 'border-amber-200 bg-black/25 text-amber-100'
                                  : 'border-amber-500 bg-amber-50 text-amber-950'
                              }`}
                            >
                              医療保険 特指示 → 名簿の医療保険列で内容を確認・更新してください（ポータルからは編集しません）
                            </div>
                          )}
                          {nursingOfficeUi && Report.residentHasVisitNursingSpecial(res) && (
                            <div
                              className={`mt-1.5 rounded-lg border-2 px-2 py-1.5 text-[10px] font-black leading-snug sm:text-[11px] ${
                                critical
                                  ? 'border-teal-200 bg-black/25 text-teal-100'
                                  : 'border-teal-600 bg-teal-50 text-teal-950'
                              }`}
                            >
                              <span className="flex flex-wrap items-center gap-1">
                                <Home className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                訪問看護・特別指示（管理対象）
                                {Report.sheetSuggestsVisitNursingSpecial(res.insuranceLabel) &&
                                !Report.visitNursingManualRegistrationActive(String(res.id)) ? (
                                  <span className="font-bold opacity-90">・名簿検出</span>
                                ) : null}
                              </span>
                              {(() => {
                                const vn = Report.getVisitNursingSpecial(String(res.id));
                                return vn.periodStart || vn.periodEnd ? (
                                  <span className="mt-1 block font-mono tabular-nums text-[10px] font-bold opacity-90">
                                    手動登録の期間: {vn.periodStart || '—'} 〜 {vn.periodEnd || '—'}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                          )}
                          {ded.hasAlert && (
                            <div
                              className={`mt-2 rounded-xl border-2 px-2 py-1.5 text-[10px] font-bold leading-snug ${
                                critical
                                  ? 'border-white/80 bg-black/25 text-white'
                                  : 'border-violet-600 bg-violet-100 text-violet-950'
                              }`}
                            >
                              <span
                                className={`flex items-center gap-1 font-black ${
                                  critical ? 'text-white' : 'text-violet-900'
                                }`}
                              >
                                <FileWarning className="h-3.5 w-3.5 shrink-0" />
                                減算・監査 要確認
                              </span>
                              <ul
                                className={`mt-1 list-inside list-disc ${
                                  critical ? 'text-red-50' : 'text-violet-900'
                                }`}
                              >
                                {ded.lines.map((line, i) => (
                                  <li key={i}>{line}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {(ev.vitalBad || ev.stoolBad || ev.urineBad) && (
                            <ul className={`mt-2 list-inside list-disc text-xs font-bold ${critical ? 'text-white' : ''}`}>
                              {ev.vitalFlags.map((f) => (
                                <li key={f.code}>{f.label}</li>
                              ))}
                              {ev.stoolBad && (
                                <li>
                                  排便 {ev.stoolHours != null ? `${Math.round(ev.stoolHours)}h` : '—'} 未記録相当（72h超）
                                </li>
                              )}
                              {ev.urineBad && (
                                <li>
                                  排尿記録・トイレ誘導{' '}
                                  {ev.urineHours != null ? `${Math.round(ev.urineHours)}h` : '—'} 間隔（{Report.VITAL_THRESHOLDS.urineHoursMax}h超）
                                </li>
                              )}
                            </ul>
                          )}
                          {critical && adviceShort && (
                            <div className="mt-2 flex items-start gap-1 rounded-lg bg-black/20 px-2 py-1.5 text-[10px] font-bold leading-snug text-white">
                              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span className="line-clamp-4">{adviceShort}</span>
                            </div>
                          )}
                          <div
                            className={`mt-2 space-y-1 border-t pt-2 text-[11px] font-bold sm:text-xs ${
                              critical ? 'border-red-400 text-red-100' : 'border-slate-100 text-slate-600'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                              <span className={critical ? '' : 'text-slate-900'}>
                                当月食事{' '}
                                <span className="font-mono text-base tabular-nums sm:text-lg">{mealTotal}</span> 回
                                {(sheetMeal > 0 || bill.mealLogged > 0) && (
                                  <span className="ml-1 block text-[10px] font-bold opacity-85 sm:ml-2 sm:inline">
                                    （名簿{sheetMeal}＋記録{bill.mealLogged}）
                                  </span>
                                )}
                                <span className="ml-1 block text-[10px] font-bold opacity-85 sm:ml-2 sm:inline">
                                  （朝{mealBySlot['朝'] ?? 0}・昼{mealBySlot['昼'] ?? 0}・夜{mealBySlot['夜'] ?? 0}）
                                </span>
                              </span>
                              <span
                                className={
                                  warn || critical ? 'rounded-full bg-black/30 px-2 py-0.5' : 'text-blue-600'
                                }
                              >
                                巡視 {String(res.lastPatrol ?? '—')}
                              </span>
                            </div>
                            <div
                              className={`flex flex-wrap gap-x-3 gap-y-0.5 ${critical ? 'text-red-50' : 'text-slate-800'}`}
                            >
                              <span>
                                経管（名簿）{' '}
                                {res.isEnteral ? (
                                  <span className="rounded-md bg-amber-500 px-1.5 py-0.5 text-[10px] text-white sm:text-[11px]">
                                    管理対象
                                  </span>
                                ) : (
                                  <span className="opacity-75">—</span>
                                )}
                              </span>
                              <span>
                                当月経管実施{' '}
                                <span className="font-mono tabular-nums">{bill.enteralLogged}</span> 回
                              </span>
                            </div>
                          </div>
                        </div>
                        {ev.muted ? (
                          <div className="mt-2 rounded-xl border-2 border-slate-300 bg-slate-900/5 px-2 py-2 text-[10px] font-black leading-snug text-slate-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span>カード上のアラートを一時的に消しています（数時間で自動復帰）</span>
                              <button
                                type="button"
                                onClick={() => unmuteResidentCardMonitor(res)}
                                className="shrink-0 rounded-lg border border-slate-400 bg-white px-2 py-1 text-[10px] font-black text-slate-900 hover:bg-slate-50"
                              >
                                アラートを再表示
                              </button>
                            </div>
                          </div>
                        ) : showMuteRow ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => muteResidentCardMonitor(res, 6)}
                              className={`min-w-0 flex-1 rounded-xl border-2 px-2 py-2 text-[10px] font-black sm:text-xs ${
                                critical
                                  ? 'border-white/60 bg-white/15 text-white hover:bg-white/25'
                                  : warn
                                    ? 'border-amber-600 bg-amber-50 text-amber-950 hover:bg-amber-100'
                                    : 'border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
                              }`}
                            >
                              アラートを6時間消す
                            </button>
                            <button
                              type="button"
                              onClick={() => muteResidentCardMonitor(res, 24)}
                              className={`min-w-0 flex-1 rounded-xl border-2 px-2 py-2 text-[10px] font-black sm:text-xs ${
                                critical
                                  ? 'border-white/60 bg-white/15 text-white hover:bg-white/25'
                                  : warn
                                    ? 'border-amber-600 bg-amber-50 text-amber-950 hover:bg-amber-100'
                                    : 'border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
                              }`}
                            >
                              24時間消す
                            </button>
                          </div>
                        ) : null}
                        {facilityDayServiceMode === 'external_manual' ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openDaySvcExternalEditor(res);
                            }}
                            className={`mt-2 flex w-full items-center justify-center gap-1 rounded-xl border-2 py-2 text-xs font-black ${
                              critical
                                ? 'border-indigo-200/60 bg-indigo-950/40 text-indigo-100 hover:bg-indigo-900/50'
                                : 'border-indigo-400 bg-indigo-50 text-indigo-950 hover:bg-indigo-100'
                            }`}
                          >
                            <CalendarClock className="h-4 w-4 shrink-0" />
                            外部デイの予定
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCalOpenId((id) => (id === String(res.id) ? '' : String(res.id)));
                          }}
                          className={`mt-2 flex w-full items-center justify-center gap-1 rounded-xl border-2 py-2 text-xs font-black ${
                            critical
                              ? 'border-white/50 bg-white/10 text-white hover:bg-white/20'
                              : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          <CalendarDays className="h-4 w-4" />
                          過去1週間
                        </button>
                        {calOpenId === String(res.id) && (
                          <div className="mt-2 max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-2 [-webkit-overflow-scrolling:touch]">
                            <table className="w-max border-collapse text-[9px] font-bold text-slate-700">
                              <thead>
                                <tr>
                                  <th className="sticky left-0 border border-slate-200 bg-slate-100 px-2 py-1 text-left">区分</th>
                                  {cal.map((day) => (
                                    <th
                                      key={`h-${day.date}`}
                                      className="border border-slate-200 bg-slate-100 px-2 py-1 text-center text-slate-500"
                                      title={day.date}
                                    >
                                      {day.date.slice(5)}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {[
                                  { key: 'patrol', label: '巡視', cls: 'accent-cyan-600' },
                                  { key: 'meal', label: '食事', cls: 'accent-orange-500' },
                                  { key: 'enteral', label: '経管', cls: 'accent-violet-600' },
                                  { key: 'excretion', label: '排泄', cls: 'accent-amber-600' },
                                  ...(facilityDayServiceMode === 'on_site_csv'
                                    ? [{ key: 'dayOnSite', label: '併設デイ', cls: 'accent-teal-600', dayBool: 'dayOnSite' }]
                                    : facilityDayServiceMode === 'external_manual'
                                      ? [
                                          {
                                            key: 'dayExternal',
                                            label: '外部デイ',
                                            cls: 'accent-indigo-600',
                                            dayBool: 'dayExternal',
                                          },
                                        ]
                                      : []),
                                ].map((rowDef) => (
                                  <tr key={rowDef.key}>
                                    <th className="sticky left-0 border border-slate-200 bg-white px-2 py-1 text-left">
                                      {rowDef.label}
                                    </th>
                                    {cal.map((day) => {
                                      const flag =
                                        'dayBool' in rowDef && rowDef.dayBool
                                          ? Boolean(day[rowDef.dayBool])
                                          : Number(day[rowDef.key] ?? 0) > 0;
                                      const n = Number(day[rowDef.key] ?? 0);
                                      const title =
                                        'dayBool' in rowDef && rowDef.dayBool
                                          ? flag
                                            ? `${rowDef.label} あり`
                                            : `${rowDef.label} なし`
                                          : n > 0
                                            ? `${rowDef.label} ${n}件`
                                            : `${rowDef.label} 0件`;
                                      return (
                                        <td key={`${rowDef.key}-${day.date}`} className="border border-slate-200 px-2 py-1 text-center">
                                          <input
                                            type="checkbox"
                                            checked={flag}
                                            readOnly
                                            disabled
                                            className={`h-3.5 w-3.5 ${rowDef.cls}`}
                                            title={title}
                                          />
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

        </div>

        {nursingOfficeUi ? (
        <aside className="hidden w-44 shrink-0 flex-col gap-2 xl:w-52 lg:flex">
          <div className="mb-0 w-full rounded-xl bg-slate-900/80 px-2 py-2 text-center text-xs font-bold text-cyan-400">
            外部連携
          </div>
          <ExternalToolButton href={extLinks.kaipoke} icon={Stethoscope}>
            カイポケ
          </ExternalToolButton>
          <ExternalToolButton href={extLinks.mcs} icon={LayoutGrid}>
            MCS
          </ExternalToolButton>
          <ExternalToolButton href={extLinks.line} icon={Smartphone}>
            公式LINE
          </ExternalToolButton>
        </aside>
        ) : null}
      </div>

      {nursingOfficeUi ? (
      <footer className="flex shrink-0 gap-2 rounded-2xl border border-slate-500 bg-slate-900 p-2 lg:hidden">
        <ExternalToolButton href={extLinks.kaipoke} icon={Stethoscope} layout="inline">
          カイポケ
        </ExternalToolButton>
        <ExternalToolButton href={extLinks.mcs} icon={LayoutGrid} layout="inline">
          MCS
        </ExternalToolButton>
        <ExternalToolButton href={extLinks.line} icon={Smartphone} layout="inline">
          LINE
        </ExternalToolButton>
      </footer>
      ) : null}

      <ResidentInfoProvisionModal
        open={infoProvisionOpen}
        onClose={() => {
          setInfoProvisionOpen(false);
          setInfoProvisionInitialResidentId(null);
          setInfoProvisionInitialActiveTab(null);
        }}
        initialResidentId={infoProvisionInitialResidentId}
        initialActiveTab={infoProvisionInitialActiveTab}
        geminiKey={GEMINI_KEY}
        facilityLabel={selectedDef?.tabLabel ?? ''}
        residents={filteredResidents}
        residentNameWithoutSama={residentNameWithoutSama}
        onApplied={({ residentId, emergencyPatch, contact }) => {
          setEmergencyPickId(String(residentId));
          setEmergencyDraft((prev) => ({ ...prev, ...emergencyPatch }));
          if (contact?.name) Report.setEmergencyContact(String(residentId), contact);
          setInfoProvisionOpen(false);
          setInfoProvisionInitialResidentId(null);
          setInfoProvisionInitialActiveTab(null);
          setEmergencyOpen(true);
        }}
      />

      {(() => {
        const rid = String(surroundTextEditId ?? '').trim();
        if (!rid) return null;
        const res =
          displayResidents.find((r) => String(r.id) === rid) ?? allResidents.find((r) => String(r.id) === rid);
        const sheetHint = String(res?.condition ?? '').trim();
        return (
          <div
            className="fixed inset-0 z-[207] flex items-center justify-center bg-black/60 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="surround-text-edit-title"
            onClick={() => setSurroundTextEditId('')}
          >
            <div
              className="w-full max-w-lg rounded-2xl border-4 border-slate-700 bg-white p-5 shadow-2xl sm:p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 id="surround-text-edit-title" className="text-lg font-black text-slate-900 sm:text-xl">
                  周囲事項（文字入力）
                  <span className="mt-1 block text-xs font-bold text-slate-600">
                    {residentNameWithoutSama(res?.name ?? '') || '利用者'} 様
                  </span>
                </h3>
                <button
                  type="button"
                  onClick={() => setSurroundTextEditId('')}
                  className="rounded-full p-2 hover:bg-slate-100"
                  aria-label="閉じる"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="mb-2 text-[11px] font-bold leading-snug text-slate-600 sm:text-xs">
                ここで保存した内容はカードの表示と、救急サマリー印刷の「周囲事項（カード手入力）」に出ます。スプレッドシートの名簿は自動では書き換わりません。
              </p>
              {sheetHint ? (
                <p className="mb-2 max-h-24 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] font-bold leading-snug text-slate-700">
                  <span className="font-black text-slate-500">名簿（参照）</span> {sheetHint}
                </p>
              ) : null}
              <textarea
                rows={6}
                value={surroundDraftText}
                onChange={(e) => setSurroundDraftText(e.target.value)}
                className="mb-3 w-full rounded-xl border-2 border-slate-300 p-3 text-sm font-bold text-slate-900"
                placeholder="例: KP郵便物送付禁止、電話での連絡で対応して下さい。"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSurroundTextEditId('')}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-800 hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => {
                    Report.updateResidentSurroundMemo(rid, { text: surroundDraftText });
                    setSurroundMemoRev((n) => n + 1);
                    setSurroundTextEditId('');
                  }}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-black text-white hover:bg-emerald-700"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <VitalHandwritingModal
        open={Boolean(String(surroundHandwritingId ?? '').trim())}
        residentName={(() => {
          const rid = String(surroundHandwritingId ?? '').trim();
          const r =
            displayResidents.find((x) => String(x.id) === rid) ?? allResidents.find((x) => String(x.id) === rid);
          return `${residentNameWithoutSama(r?.name ?? '') || '利用者'} 様`;
        })()}
        heading={(() => {
          const rid = String(surroundHandwritingId ?? '').trim();
          const r =
            displayResidents.find((x) => String(x.id) === rid) ?? allResidents.find((x) => String(x.id) === rid);
          const nm = residentNameWithoutSama(r?.name ?? '') || '利用者';
          return `${nm} 様・周囲事項（手書き）`;
        })()}
        initialDataUrl={Report.getResidentSurroundMemo(String(surroundHandwritingId ?? '').trim()).handwritingDataUrl}
        onClose={() => setSurroundHandwritingId('')}
        onConfirm={(dataUrl) => {
          const id = String(surroundHandwritingId ?? '').trim();
          if (id) {
            Report.updateResidentSurroundMemo(id, { handwritingDataUrl: dataUrl });
            setSurroundMemoRev((n) => n + 1);
          }
        }}
      />

      {daySvcExternalFor && (
        <div className="fixed inset-0 z-[205] flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-3xl border-4 border-indigo-500 bg-white p-5 shadow-2xl sm:p-6">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-lg font-black text-indigo-900 sm:text-xl">
                外部デイの予定
                <span className="mt-1 block text-xs font-bold text-slate-600">
                  {residentNameWithoutSama(daySvcExternalFor.name)} 様・今日から28日間
                </span>
              </h3>
              <button
                type="button"
                onClick={() => setDaySvcExternalFor(null)}
                className="rounded-full p-2 hover:bg-slate-100"
                aria-label="閉じる"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-3 text-[11px] font-bold leading-snug text-slate-600 sm:text-xs">
              チェックした日を「外部デイ（通所）」として保存します。外すとその日の外部デイだけ削除します（併設デイのCSV取込とは別データです）。
            </p>
            <ul className="mb-4 max-h-[50vh] space-y-1.5 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
              {Object.keys(daySvcExternalDraft)
                .sort()
                .map((ymd) => {
                  const dow = (() => {
                    try {
                      const [y, mo, da] = ymd.split('-').map(Number);
                      const d = new Date(y, mo - 1, da);
                      return d.toLocaleDateString('ja-JP', { weekday: 'short' });
                    } catch {
                      return '';
                    }
                  })();
                  const isToday = ymd === todayStrip;
                  return (
                    <li key={ymd} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-xs font-bold text-slate-800">
                      <input
                        id={`dayext-${ymd}`}
                        type="checkbox"
                        checked={Boolean(daySvcExternalDraft[ymd])}
                        onChange={(e) =>
                          setDaySvcExternalDraft((prev) => ({ ...prev, [ymd]: e.target.checked }))
                        }
                        className="h-4 w-4 accent-indigo-600"
                      />
                      <label htmlFor={`dayext-${ymd}`} className="flex min-w-0 flex-1 cursor-pointer tabular-nums">
                        <span className={isToday ? 'text-indigo-700' : ''}>
                          {ymd} {dow}
                          {isToday ? '（本日）' : ''}
                        </span>
                      </label>
                    </li>
                  );
                })}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setDaySvcExternalFor(null)}
                className="flex-1 rounded-xl border-2 border-slate-300 bg-white px-3 py-2 text-sm font-black text-slate-800 hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => {
                  const rid = String(daySvcExternalFor?.id ?? '').trim();
                  if (!rid) return;
                  for (const ymd of Object.keys(daySvcExternalDraft)) {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
                    const on = Boolean(daySvcExternalDraft[ymd]);
                    const prev = Report.getDayServiceCell(rid, ymd);
                    if (on) {
                      Report.setDayServiceCell(rid, ymd, { kind: 'external', source: 'manual' });
                    } else if (prev?.kind === 'external') {
                      Report.setDayServiceCell(rid, ymd, null);
                    }
                  }
                  setDaySvcExternalFor(null);
                  setTick((n) => n + 1);
                }}
                className="flex-1 rounded-xl border-2 border-indigo-600 bg-indigo-600 px-3 py-2 text-sm font-black text-white hover:bg-indigo-500"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {emergencyOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-3xl border-4 border-rose-500 bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-xl font-black text-rose-700">
                <Ambulance className="h-7 w-7" />
                救急搬送サマリー
              </h3>
              <button type="button" onClick={() => setEmergencyOpen(false)} className="rounded-full p-2 hover:bg-slate-100">
                <X className="h-6 w-6" />
              </button>
            </div>
            <p className="mb-3 text-sm font-bold text-slate-600">
              現在の書式に合わせて追記できるようにしています。音声入力は各欄のマイクを押してください。
            </p>
            <div className="mb-4 grid gap-3 md:grid-cols-2">
              <select
                value={emergencyPickId}
                onChange={(e) => setEmergencyPickId(e.target.value)}
                className="w-full rounded-xl border-2 border-slate-300 px-3 py-3 text-base font-bold"
              >
                <option value="">— 利用者を選択 —</option>
                {filteredResidents.map((r) => (
                  <option key={String(r.id)} value={String(r.id)}>
                    {residentNameWithoutSama(r.name)} 様 {String(r.room)}
                  </option>
                ))}
              </select>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <p className="font-bold text-slate-700">
                  {residentNameWithoutSama(selectedEmergencyResident?.name ?? '—')} 様
                </p>
                <p className="text-slate-500">居室: {String(selectedEmergencyResident?.room ?? '—')}</p>
              </div>
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-2">
              {[
                ['senderOffice', '施設名'],
                ['senderAddress', '住所'],
                ['senderTel', 'ステーション電話番号'],
                ['senderNurse', '担当看護師'],
                ['primaryDoctor', '主治医氏名'],
                ['medicalAgency', '医療機関名'],
                ['medicalAddress', '医療機関住所'],
              ].map(([k, label]) => (
                <label key={k} className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-slate-600">{label}</span>
                  <input
                    value={emergencyDraft[k] ?? ''}
                    onChange={(e) => setEmergencyDraft((prev) => ({ ...prev, [k]: e.target.value }))}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
                  />
                  {k === 'primaryDoctor' && selectedDef?.linkKey === '北名古屋' ? (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {[
                        { value: '田中在宅', label: '田中在宅', cls: 'border-blue-400 bg-blue-100 text-blue-900' },
                        { value: '北名古屋', label: '北名古屋', cls: 'border-amber-400 bg-amber-100 text-amber-900' },
                        { value: 'ひのとり', label: 'ひのとり', cls: 'border-rose-400 bg-rose-100 text-rose-900' },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setEmergencyDraft((prev) => ({ ...prev, primaryDoctor: opt.value }))}
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-black ${opt.cls}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
              ))}
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-2">
              {[
                ['dailyLife', '日常生活等の状況'],
                ['nurseProblems', '看護上の問題等'],
                ['acuteChange', '急変の内容（看護師記入）'],
                ['nurseContent', '看護の内容'],
                ['careNotes', 'ケア時の注意点'],
                ['other', 'その他'],
              ].map(([k, label]) => (
                <label key={k} className="flex flex-col gap-1 md:col-span-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-600">{label}</span>
                    <button
                      type="button"
                      onClick={() => (dictatingField === k ? stopDictation() : startDictation(k))}
                      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${
                        dictatingField === k ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      <Mic className="h-3.5 w-3.5" />
                      {dictatingField === k ? '停止' : '音声入力'}
                    </button>
                  </div>
                  <textarea
                    value={emergencyDraft[k] ?? ''}
                    onChange={(e) => setEmergencyDraft((prev) => ({ ...prev, [k]: e.target.value }))}
                    rows={4}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={!emergencyPickId || emergencyBusy}
                onClick={() =>
                  setEmergencyDraft((prev) =>
                    buildEmergencyDraftFromResident(selectedEmergencyResident, prev)
                  )
                }
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-slate-300 py-4 text-base font-black text-slate-700 disabled:opacity-50"
              >
                自動作成（まとめて）
              </button>
              <button
                type="button"
                disabled={!emergencyPickId || emergencyBusy}
                onClick={() => void runEmergencySummary()}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-rose-600 py-4 text-base font-black text-white disabled:opacity-50"
              >
                {emergencyBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                印刷で開く
              </button>
              <button
                type="button"
                disabled={!emergencyPickId || emergencyBusy}
                onClick={() => void downloadEmergencyHtml()}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-rose-400 py-4 text-base font-black text-rose-700 disabled:opacity-50"
              >
                HTML保存
              </button>
            </div>
            {!GEMINI_KEY && (
              <p className="mt-3 text-xs text-amber-700">
                VITE_GEMINI_API_KEY 未設定時は定型の法令・実務アドバイスのみ添付されます。
              </p>
            )}
          </div>
        </div>
      )}

      <AccidentReportModal
        open={accidentReportOpen}
        onClose={() => setAccidentReportOpen(false)}
        geminiKey={GEMINI_KEY}
        facilityLabel={selectedDef?.tabLabel ?? ''}
        residents={filteredResidents}
      />
      <AccidentMonthlyAnalysisModal
        open={accidentMonthlyOpen}
        onClose={() => setAccidentMonthlyOpen(false)}
        geminiKey={GEMINI_KEY}
        defaultTabLabel={selectedDef?.tabLabel ?? ''}
        facilityDefs={CARELINK_FACILITIES}
      />
      <NearMissMonthlyAnalysisModal
        open={nearMissMonthlyOpen}
        onClose={() => setNearMissMonthlyOpen(false)}
        geminiKey={GEMINI_KEY}
        defaultTabLabel={selectedDef?.tabLabel ?? ''}
        facilityDefs={CARELINK_FACILITIES}
      />
      <NearMissReportModal
        open={nearMissOpen}
        onClose={() => setNearMissOpen(false)}
        geminiKey={GEMINI_KEY}
        facilityLabel={selectedDef?.tabLabel ?? ''}
        residents={filteredResidents}
      />
      <NearMissAwarenessAdminModal
        open={nearMissAwarenessAdminOpen}
        onClose={() => setNearMissAwarenessAdminOpen(false)}
        facilityLinkKey={linkKeyForSheetTitle(selectedSheetTitle)}
        facilityTabLabel={selectedDef?.tabLabel ?? ''}
        sheetsApiKey={SHEETS_KEY}
        geminiKey={GEMINI_KEY}
      />
    </div>
  );
}
