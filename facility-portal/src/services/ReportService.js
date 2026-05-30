/**
 * CareLink OS — 監査ログ・異常検知・救急サマリー・月次出力・AIアドバイス補助
 * 永続化: localStorage + IndexedDB（生活記録は法定5年保存。5年超のみ自動削除）
 */

import { nowJapanIsoString } from '../utils/japanIsoTime.js';
import { buildNearMissReportHtml, NEAR_MISS_CATEGORY_LABELS } from './nearMissReportHtml.js';
import { CARELINK_FACILITIES, facilityDefBySheetTitle } from '../config/carelinkFacilities.js';
import { deleteAllResidentPdfs } from '../lib/residentInfoProvisionIdb.js';
import { tokyoYmdFromTs } from '../lib/hourlyCareGrid.js';
import {
  CARE_RECORD_RETENTION_YEARS,
  careEventsRetentionSummary,
  pruneCareEventsBeyondRetention,
} from '../lib/careRecordRetention.js';
import {
  idbAppendCareEvent,
  idbLoadAllCareEvents,
  idbMigrateFromLocalStorage,
  idbSaveAllCareEvents,
  mergeCareEventsById,
} from '../lib/careEventsIdb.js';

export { CARE_RECORD_RETENTION_YEARS, careEventsRetentionSummary };

export { buildNearMissReportHtml, NEAR_MISS_CATEGORY_LABELS };

/** @param {Record<string, unknown>} resident */
function nursingLinkKeyForResident(resident) {
  const st = String(resident?.sourceSheetTitle ?? '').trim();
  const fromTitle = facilityDefBySheetTitle(st);
  if (fromTitle) return fromTitle.linkKey;
  const fac = String(resident?.facility ?? '').trim();
  if (!fac) return '';
  const hit = CARELINK_FACILITIES.find(
    (f) =>
      fac === f.sheetTitle ||
      fac === f.tabLabel ||
      fac === f.linkKey ||
      fac.includes(f.tabLabel) ||
      f.tabLabel.includes(fac)
  );
  return hit?.linkKey ?? '';
}

/**
 * 看護指示・申し送りなど施設単位ストレージ用の linkKey。
 * @param {Record<string, unknown>} resident
 * @param {string} [portalSheetTitle] 名簿の sheetTitle（利用者から取れないときの補助）
 */
export function nursingFacilityLinkKeyFromContext(resident, portalSheetTitle = '') {
  const fromRes = nursingLinkKeyForResident(resident && typeof resident === 'object' ? resident : {});
  if (fromRes) return fromRes;
  const st = String(portalSheetTitle ?? '').trim();
  return facilityDefBySheetTitle(st)?.linkKey ?? '';
}

const LS = {
  careEvents: 'carelink_os_care_events_v1',
  nursing: 'carelink_os_nursing_directives_v1',
  weeklyPlans: 'carelink_os_weekly_plans_v1',
  lastStool: 'carelink_os_last_stool_v1',
  /** 最終の排尿記録・トイレ誘導実施時刻（6時間アラート用） */
  lastUrine: 'carelink_os_last_urine_v1',
  /** 排便量「小」「少量」の連続回数（2回で排便1回相当として lastStool を更新） */
  smallStoolTally: 'carelink_os_small_stool_tally_v1',
  vitals: 'carelink_os_resident_vitals_v1',
  residentAlertThresholds: 'carelink_os_resident_alert_thresholds_v1',
  residentMonitorAlertMuteUntil: 'carelink_os_resident_monitor_alert_mute_until_v1',
  emergencyContact: 'carelink_os_emergency_contact_v1',
  disabilityServiceProgress: 'carelink_os_disability_service_progress_v1',
  seeded: 'carelink_os_demo_seeded_v1',
  accidentReports: 'carelink_os_accident_reports_v1',
  nearMissReports: 'carelink_os_near_miss_reports_v1',
  visitNursingSpecial: 'carelink_os_visit_nursing_special_v1',
  /** 施設ごとの本日の周知事項掲示（一覧の「本日の周知事項」と同期） */
  facilityNotice: 'carelink_os_facility_notice_v1',
  /** 施設ごとの申し送り掲示（パノラマ・一覧の掲示板と同期） */
  facilityHandover: 'carelink_os_facility_handover_v1',
  /** 利用者ごとに保存した情報提供書PDFのAI抽出結果（メタ＋JSON） */
  infoProvisionExtract: 'carelink_os_info_provision_extract_v1',
  /** カイポケ等CSVから取り込んだ月次用の短文行 { [ym]: { [residentId]: string[] } } */
  monthlyReportImportLines: 'carelink_os_monthly_report_import_v1',
  /** 利用者ごとの薬局PDF取り込み結果（薬剤名一覧・調剤日など） */
  residentMedicationProfile: 'carelink_os_resident_medication_profile_v1',
  /** Record カード「周囲事項」— 名簿とは別に職員が保存（文字・手書き画像） */
  residentSurroundMemo: 'carelink_os_resident_surround_memo_v1',
  /** 利用者×日のデイ予定（併設デイ＝CSV、外部通所＝手入力） */
  dayServiceSchedule: 'carelink_os_day_service_v1',
};

const MAX_ACCIDENT_REPORTS = 2000;
const MAX_NEAR_MISS_REPORTS = 2000;

/** 月次分析で並べる事故種別の表示順 */
export const ACCIDENT_TYPE_ORDER = Object.freeze([
  '転倒',
  '転落',
  '落薬',
  '誤薬',
  '窒息・誤嚥',
  '徘徊',
  'やけど・火傷',
  '自傷行為',
  'その他',
]);

/** 時間帯スロットの表示順 */
export const ACCIDENT_SLOT_ORDER = Object.freeze([
  '深夜（0–5時）',
  '早朝（6–8時）',
  '午前（9–11時）',
  '昼（12–13時）',
  '午後（14–17時）',
  '夕方（18–20時）',
  '夜（21–23時）',
  '時間不明',
]);

/** ヒヤリ月次のカテゴリ表示順（複数選択は件数に重複加算） */
export const NEAR_MISS_MONTH_CATEGORY_ORDER = Object.freeze([
  ...NEAR_MISS_CATEGORY_LABELS,
  'その他',
  '分類なし',
]);

/** Google AI Studio（generativelanguage v1beta）で利用可能なモデル名に合わせる */
const MODEL = 'gemini-2.5-flash';

/**
 * Gemini generateContent の失敗を、画面上で「文字化け／英語だらけ」と誤解されないよう日本語中心にまとめる。
 * @param {any} data - JSON レスポンス
 * @param {number} httpStatus
 */
function formatGeminiGenerateContentErrorMessage(data, httpStatus) {
  const err = data?.error;
  const raw = String(err?.message ?? '').trim();
  const code = err?.code ?? err?.status;
  const lower = raw.toLowerCase();
  const st = Number(httpStatus) || 0;

  const retryMatch = raw.match(/retry\s+in\s+([\d.]+)\s*s/i);
  const retrySec = retryMatch ? Math.ceil(Number.parseFloat(retryMatch[1])) : null;

  const quotaLike =
    st === 429 ||
    st === 503 ||
    code === 429 ||
    code === 503 ||
    lower.includes('quota') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('exceeded') ||
    lower.includes('high demand') ||
    lower.includes('try again later') ||
    lower.includes('model is currently experiencing');

  if (quotaLike) {
    const waitLine =
      retrySec != null && retrySec > 0
        ? `目安として約 ${retrySec} 秒待ってから、再度「アセスメント生成」をお試しください。`
        : 'しばらく時間をおいてから、再度「アセスメント生成」をお試しください。';
    return [
      '【APIの利用上限に達しています】',
      '表示されていた英語は文字化けではなく、Google Gemini の「回数・トークン枠の超過」です。',
      '',
      waitLine,
      '',
      '確認のヒント:',
      '・ Google AI Studio でキー・プラン・利用枠（https://aistudio.google.com）',
      '・ このアプリの VITE_GEMINI_API_KEY が正しいか（無料枠の limit が 0 の場合は別キーや課金設定が必要なことがあります）',
      '',
      '────────',
      '（APIメッセージ）',
      raw || `HTTP ${st || '?'}`,
    ].join('\n');
  }

  if (
    st === 401 ||
    st === 403 ||
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('permission denied')
  ) {
    return [
      '【APIキーまたは権限の問題です】',
      'キーが無効、またはこのモデル（' + MODEL + '）を呼び出す権限がありません。',
      '.env の VITE_GEMINI_API_KEY と Google 側の有効化を確認してください。',
      '',
      '────────',
      '（APIメッセージ）',
      raw || `HTTP ${st || '?'}`,
    ].join('\n');
  }

  return [
    '【AIの応答を取得できませんでした】',
    '通信やサーバー側の都合の可能性があります。時間をおいて再度お試しください。',
    '',
    '────────',
    '（APIメッセージ）',
    raw || `HTTP ${st || '?'} / code: ${code ?? '—'}`,
  ].join('\n');
}

/**
 * バイタル・排便・巡視の閾値（一覧カードのアラートに使用）
 *
 * - 体温 ${tempCMinFever}℃ 以上 → vital 異常
 * - 収縮期血圧 ${bpSystolicHigh} 以上、または拡張期 ${bpDiastolicLow} 以下 → vital 異常
 * - 最終排便（実効）から ${stoolHoursMax} 時間超 → 排便アラート（「小」「少量」は2回で1回として時刻更新）
 * - 最終排尿（尿量記録・トイレ誘導・排泄確認など）から ${urineHoursMax} 時間超 → 排尿アラート
 * - 名簿の巡視間隔（分）が ${patrolIntervalWarnMin} 超 → warn（赤 critical にはしない）
 */
export const VITAL_THRESHOLDS = Object.freeze({
  tempCMinFever: 37.5,
  bpSystolicHigh: 150,
  bpDiastolicLow: 80,
  stoolHoursMax: 72,
  urineHoursMax: 6,
  patrolIntervalWarnMin: 180,
});

/**
 * @typedef {{
 *   tempCMinFever?: number;
 *   bpSystolicHigh?: number;
 *   bpDiastolicLow?: number;
 *   stoolHoursMax?: number;
 *   urineHoursMax?: number;
 *   patrolIntervalWarnMin?: number;
 * }} ResidentAlertThresholds
 */

function normalizeThresholdNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** @param {string} residentId */
export function getResidentAlertThresholds(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return null;
  const all = readJson(LS.residentAlertThresholds, {});
  const row = all[id];
  if (!row || typeof row !== 'object') return null;
  return {
    tempCMinFever: normalizeThresholdNumber(row.tempCMinFever, VITAL_THRESHOLDS.tempCMinFever),
    bpSystolicHigh: normalizeThresholdNumber(row.bpSystolicHigh, VITAL_THRESHOLDS.bpSystolicHigh),
    bpDiastolicLow: normalizeThresholdNumber(row.bpDiastolicLow, VITAL_THRESHOLDS.bpDiastolicLow),
    stoolHoursMax: normalizeThresholdNumber(row.stoolHoursMax, VITAL_THRESHOLDS.stoolHoursMax),
    urineHoursMax: normalizeThresholdNumber(row.urineHoursMax, VITAL_THRESHOLDS.urineHoursMax),
    patrolIntervalWarnMin: normalizeThresholdNumber(
      row.patrolIntervalWarnMin,
      VITAL_THRESHOLDS.patrolIntervalWarnMin
    ),
  };
}

/**
 * @param {string} residentId
 * @param {ResidentAlertThresholds} patch
 */
export function setResidentAlertThresholds(residentId, patch) {
  const id = String(residentId ?? '').trim();
  if (!id) return;
  const all = readJson(LS.residentAlertThresholds, {});
  const prev = getResidentAlertThresholds(id) ?? VITAL_THRESHOLDS;
  all[id] = {
    tempCMinFever: normalizeThresholdNumber(patch?.tempCMinFever, prev.tempCMinFever),
    bpSystolicHigh: normalizeThresholdNumber(patch?.bpSystolicHigh, prev.bpSystolicHigh),
    bpDiastolicLow: normalizeThresholdNumber(patch?.bpDiastolicLow, prev.bpDiastolicLow),
    stoolHoursMax: normalizeThresholdNumber(patch?.stoolHoursMax, prev.stoolHoursMax),
    urineHoursMax: normalizeThresholdNumber(patch?.urineHoursMax, prev.urineHoursMax),
    patrolIntervalWarnMin: normalizeThresholdNumber(
      patch?.patrolIntervalWarnMin,
      prev.patrolIntervalWarnMin
    ),
    updatedAt: new Date().toISOString(),
  };
  writeJson(LS.residentAlertThresholds, all);
}

/** @param {string} residentId */
export function resolveAlertThresholdsForResident(residentId) {
  return { ...VITAL_THRESHOLDS, ...(getResidentAlertThresholds(residentId) ?? {}) };
}

/**
 * 利用者カードの異常監視アラートを一時的に非表示にする（記録完了までの運用補助）
 * @param {string} residentId
 * @param {number} [hours]
 */
export function muteResidentMonitorAlert(residentId, hours = 6) {
  const id = String(residentId ?? '').trim();
  if (!id) return false;
  const h = Number(hours);
  const safeHours = Number.isFinite(h) && h > 0 ? Math.min(48, h) : 6;
  const all = readJson(LS.residentMonitorAlertMuteUntil, {});
  all[id] = new Date(Date.now() + safeHours * 3600000).toISOString();
  writeJson(LS.residentMonitorAlertMuteUntil, all);
  return true;
}

/**
 * 利用者カードのアラート非表示を解除
 * @param {string} residentId
 */
export function unmuteResidentMonitorAlert(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return false;
  const all = readJson(LS.residentMonitorAlertMuteUntil, {});
  if (!(id in all)) return false;
  delete all[id];
  writeJson(LS.residentMonitorAlertMuteUntil, all);
  return true;
}

/**
 * @param {string} residentId
 */
export function isResidentMonitorAlertMuted(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return false;
  const all = readJson(LS.residentMonitorAlertMuteUntil, {});
  const iso = String(all[id] ?? '').trim();
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) {
    delete all[id];
    writeJson(LS.residentMonitorAlertMuteUntil, all);
    return false;
  }
  const active = t > Date.now();
  if (!active) {
    delete all[id];
    writeJson(LS.residentMonitorAlertMuteUntil, all);
  }
  return active;
}

/** @returns {Record<string, number>} */
function readSmallStoolTallyMap() {
  const raw = readJson(LS.smallStoolTally, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function writeSmallStoolTallyMap(map) {
  writeJson(LS.smallStoolTally, map);
}

function getSmallStoolTally(residentId) {
  const m = readSmallStoolTallyMap();
  const n = m[String(residentId)];
  return typeof n === 'number' && n >= 0 ? n : 0;
}

function setSmallStoolTally(residentId, n) {
  const m = readSmallStoolTallyMap();
  if (n <= 0) delete m[String(residentId)];
  else m[String(residentId)] = n;
  writeSmallStoolTallyMap(m);
}

/**
 * 排便が記録されたとき、72時間アラート用の「最終排便時刻」をどう進めるか。
 * クイックの「多・中・小」／詳細画面の「多量・中等量・少量」に対応。
 * 「小」「少量」は2回に1回だけ時刻を更新（2回分で排便1回とみなす）。
 *
 * @param {string} residentId
 * @param {{ stoolVolume?: string; stoolAmount?: string; stoolCharacter?: string }} [opts]
 */
export function recordStoolForIntervalAlert(residentId, opts = {}) {
  const id = String(residentId ?? '').trim();
  if (!id) return;

  const sv = String(opts.stoolVolume ?? '').trim();
  const sa = String(opts.stoolAmount ?? '').trim();
  const sc = String(opts.stoolCharacter ?? '').trim();
  const vol = sv || sa;

  const isSmall = vol === '小' || vol === '少量';
  const isFull =
    vol === '多' ||
    vol === '中' ||
    vol === '多量' ||
    vol === '中等量';

  if (isFull) {
    setLastStoolNow(id);
    setSmallStoolTally(id, 0);
    return;
  }
  if (isSmall) {
    const next = getSmallStoolTally(id) + 1;
    if (next >= 2) {
      setLastStoolNow(id);
      setSmallStoolTally(id, 0);
    } else {
      setSmallStoolTally(id, next);
    }
    return;
  }
  if (!vol && sc) {
    setLastStoolNow(id);
    setSmallStoolTally(id, 0);
    return;
  }
}

/** 訪問看護・特別指示の人数がこの値以上のとき、減算管理上の注意喚起（算定要件は事業所・最新告示で確認） */
export const VISIT_NURSING_SPECIAL_WARN_THRESHOLD = 19;

/** 令和8年度報酬改定資料・実務相談Q&A の要約（本番は PDF 全文読込に差し替え可） */
export const REGULATORY_KNOWLEDGE_BASE = `
【令和8年度 介護報酬改定の考え方（委託資料・要約）】
- サービス提供記録（巡視・バイタル・食事・排泄等）は、提供実態の証跡として監査・検証で重視される。
- 身体拘束適正化・安全配慮義務に基づき、バイタル急変・排便異常時は観察記録と医療・看護への報告連携が求められる。
- 排便ケア: 長期無排便は腸閉塞・褥瘡悪化等のリスク。下剤・浣腸は医師・看護指示に基づき実施し結果を記録する。
- 感染症: 発熱時は隔離・消毒記録、必要に応じた受診・往診とその記録。

【実務相談Q&A（抜粋・要約）】
Q: 排便がないが食事はある。 A: 腹部症状・腸蠕動の観察、触診は指示のもとで。医師・看護へ相談。下剤の自己増量は避ける。
Q: 血圧が高い。 A: 安静・再測定、平常値との比較、指示薬の確認。基準超過は主治医報告を検討。
Q: 下剤が必要か。 A: 無排便日数・腹部所見を踏まえ医師・看護判断。実施したら種類・量・結果を記録。
`.trim();

function readJson(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    if (!s) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function writeJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

/** 直近表示用キャッシュの目安（削除はしない） */
export const VITAL_SNAPSHOT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * @param {Record<string, unknown> | null | undefined} s
 */
function vitalSnapshotRowHasData(s) {
  if (!s || typeof s !== 'object') return false;
  return ['temp', 'bpUpper', 'bpLower', 'pulse', 'spo2', 'weight'].some(
    (k) => String(s[k] ?? '').trim() !== '',
  );
}

/**
 * バイタル表示用スナップショット（名簿カードの直近値）。過去分は careEvents の vital_snapshot を参照。
 * @returns {{ temp?: string; bpUpper?: string; bpLower?: string; pulse?: string; spo2?: string; weight?: string; updatedAt?: string } | null}
 */
export function getResidentVitalSnapshot(residentId) {
  const all = readJson(LS.vitals, {});
  const id = String(residentId);
  const row = all[id];
  if (!row || typeof row !== 'object') return null;
  if (!vitalSnapshotRowHasData(row)) {
    delete all[id];
    writeJson(LS.vitals, all);
    return null;
  }
  if (!String(row.updatedAt ?? '').trim()) {
    all[id] = { ...row, updatedAt: new Date().toISOString() };
    writeJson(LS.vitals, all);
  }
  return all[id] ?? null;
}

export function setResidentVitalSnapshot(residentId, patch) {
  const all = readJson(LS.vitals, {});
  const prev = all[String(residentId)] ?? {};
  all[String(residentId)] = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  writeJson(LS.vitals, all);
}

const VISIT_NURSING_YMD = /^\d{4}-\d{2}-\d{2}$/;

function visitNursingSpecialLocalYmd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 手動登録データが「今日の日付」でカウントに効くか（チェック ON かつ期間内）
 * @param {{ active?: boolean; periodStart?: string; periodEnd?: string }} vn
 */
function visitNursingManualActive(vn, now = new Date()) {
  if (!vn || !vn.active) return false;
  const today = visitNursingSpecialLocalYmd(now);
  const ps = String(vn.periodStart ?? '').trim();
  const pe = String(vn.periodEnd ?? '').trim();
  if (ps && VISIT_NURSING_YMD.test(ps) && today < ps) return false;
  if (pe && VISIT_NURSING_YMD.test(pe) && today > pe) return false;
  return true;
}

/**
 * 訪問看護で特別指示が付いた利用者のフラグ（同一ブラウザ・localStorage）
 * 終了日を過ぎた手動登録は読み取り時に active を false に戻す
 * @returns {{ active: boolean; note: string; periodStart: string; periodEnd: string; updatedAt?: string }}
 */
export function getVisitNursingSpecial(residentId) {
  const all = readJson(LS.visitNursingSpecial, {});
  const id = String(residentId ?? '').trim();
  const row = all[id];
  if (!row || typeof row !== 'object') {
    return { active: false, note: '', periodStart: '', periodEnd: '', updatedAt: '' };
  }
  const periodStart = String(row.periodStart ?? '').trim();
  const periodEnd = String(row.periodEnd ?? '').trim();
  let active = Boolean(row.active);
  const today = visitNursingSpecialLocalYmd();
  if (active && periodEnd && VISIT_NURSING_YMD.test(periodEnd) && today > periodEnd) {
    active = false;
    all[id] = { ...row, active: false, updatedAt: new Date().toISOString() };
    writeJson(LS.visitNursingSpecial, all);
  }
  return {
    active,
    note: String(row.note ?? ''),
    periodStart,
    periodEnd,
    updatedAt: row.updatedAt != null ? String(row.updatedAt) : '',
  };
}

/**
 * @param {string} residentId
 * @param {{ active?: boolean; note?: string; periodStart?: string; periodEnd?: string }} patch
 */
export function setVisitNursingSpecial(residentId, patch) {
  const id = String(residentId ?? '').trim();
  if (!id) return;
  const all = readJson(LS.visitNursingSpecial, {});
  const prev = all[id] && typeof all[id] === 'object' ? all[id] : {};
  const active = patch?.active !== undefined ? Boolean(patch.active) : Boolean(prev.active);
  const note =
    patch?.note !== undefined ? String(patch.note ?? '').trim() : String(prev.note ?? '').trim();
  const periodStart =
    patch?.periodStart !== undefined
      ? String(patch.periodStart ?? '').trim()
      : String(prev.periodStart ?? '').trim();
  const periodEnd =
    patch?.periodEnd !== undefined
      ? String(patch.periodEnd ?? '').trim()
      : String(prev.periodEnd ?? '').trim();
  all[id] = {
    ...prev,
    active,
    note,
    periodStart,
    periodEnd,
    updatedAt: new Date().toISOString(),
  };
  writeJson(LS.visitNursingSpecial, all);
}

/** 手動の「該当」が今の日付で集計に効いているか（名簿検出バッジの判定など） */
export function visitNursingManualRegistrationActive(residentId) {
  return visitNursingManualActive(getVisitNursingSpecial(String(residentId ?? '')));
}

/** 名簿の「医療保険」列から、訪問看護＋特別指示と読み取れるか（読み取りのみ） */
export function sheetSuggestsVisitNursingSpecial(insuranceLabelRaw) {
  const s = String(insuranceLabelRaw ?? '');
  if (!s.trim()) return false;
  return /訪問看護/u.test(s) && /特別指示|特指示/u.test(s);
}

/**
 * 訪問看護・特別指示としてカウント（アプリで「該当」登録した利用者、または名簿文言の自動検出）
 * @param {Record<string, unknown>} resident
 */
export function residentHasVisitNursingSpecial(resident) {
  const id = String(resident?.id ?? '');
  if (visitNursingManualActive(getVisitNursingSpecial(id))) return true;
  return sheetSuggestsVisitNursingSpecial(resident?.insuranceLabel);
}

/** @param {Record<string, unknown>[]} residents */
export function countVisitNursingSpecialAmong(residents) {
  let n = 0;
  for (const r of residents) {
    if (residentHasVisitNursingSpecial(r)) n += 1;
  }
  return n;
}

/** @param {{ temp?: string; bpUpper?: string; bpLower?: string }} v */
export function detectVitalAbnormal(v, thresholds = VITAL_THRESHOLDS) {
  const flags = [];
  const t = parseFloat(String(v.temp ?? '').replace(',', '.'));
  const sys = parseFloat(String(v.bpUpper ?? '').replace(',', '.'));
  const dia = parseFloat(String(v.bpLower ?? '').replace(',', '.'));
  if (!Number.isNaN(t) && t >= thresholds.tempCMinFever) {
    flags.push({ code: 'fever', label: `体温 ${t}℃（${thresholds.tempCMinFever}℃以上）` });
  }
  if (!Number.isNaN(sys) && sys >= thresholds.bpSystolicHigh) {
    flags.push({ code: 'bp_sys_high', label: `収縮期血圧 ${sys}（${thresholds.bpSystolicHigh}以上）` });
  }
  if (!Number.isNaN(dia) && dia <= thresholds.bpDiastolicLow) {
    flags.push({ code: 'bp_dia_low', label: `拡張期血圧 ${dia}（${thresholds.bpDiastolicLow}以下）` });
  }
  return flags;
}

export function getLastStoolIso(residentId) {
  const all = readJson(LS.lastStool, {});
  return all[String(residentId)] ?? null;
}

export function setLastStoolNow(residentId) {
  setLastStoolIso(residentId, new Date().toISOString());
}

export function setLastStoolIso(residentId, iso) {
  const all = readJson(LS.lastStool, {});
  all[String(residentId)] = iso;
  writeJson(LS.lastStool, all);
}

/** @param {string} residentId */
export function getLastUrineIso(residentId) {
  const all = readJson(LS.lastUrine, {});
  return all[String(residentId)] ?? null;
}

/** 排尿記録・トイレ誘導・簡易排泄確認のいずれかがあったときに呼ぶ（6時間アラートの基準時刻を更新） */
export function setLastUrineNow(residentId) {
  const all = readJson(LS.lastUrine, {});
  all[String(residentId)] = new Date().toISOString();
  writeJson(LS.lastUrine, all);
}

/**
 * 最終排尿（本端末ログ）からの経過時間（時間）。一度も記録がないときは null（アラートなし）。
 * @param {Record<string, unknown>} resident
 * @param {Date} [now]
 */
export function getHoursSinceLastUrine(resident, now = new Date()) {
  const iso = getLastUrineIso(String(resident.id ?? ''));
  if (!iso) return null;
  return (now.getTime() - new Date(iso).getTime()) / 3600000;
}

/**
 * 最終排便からの経過時間（時間）。記録なしは null。
 * @param {Record<string, unknown>} resident
 * @param {Date} [now]
 */
export function getHoursSinceLastStool(resident, now = new Date()) {
  const id = String(resident.id ?? '');
  const iso = getLastStoolIso(id);
  if (iso) return (now.getTime() - new Date(iso).getTime()) / 3600000;
  const raw = resident.lastStoolDate;
  if (raw == null || raw === '' || raw === '—') return null;
  const parsed = parseSheetStoolDate(raw, now);
  if (!parsed) return null;
  return (now.getTime() - parsed.getTime()) / 3600000;
}

/** @param {unknown} raw 例 4/2, 2026/4/2 */
function parseSheetStoolDate(raw, now) {
  const s = String(raw).trim();
  const y = now.getFullYear();
  const m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  const m2 = /^(\d{1,2})[\/\-](\d{1,2})$/.exec(s);
  if (m2) return new Date(y, Number(m2[1]) - 1, Number(m2[2]), 12, 0, 0);
  return null;
}

/**
 * @param {Record<string, unknown>} resident
 * @param {Date | { ignoreMute?: boolean; now?: Date }} [nowOrOpts]
 * @param {{ ignoreMute?: boolean }} [maybeOpts]
 */
export function evaluateResidentMonitor(resident, nowOrOpts, maybeOpts) {
  /** @type {Date} */
  let now = new Date();
  /** @type {{ ignoreMute?: boolean }} */
  let opts = {};
  if (nowOrOpts instanceof Date) {
    now = nowOrOpts;
    opts = maybeOpts && typeof maybeOpts === 'object' ? maybeOpts : {};
  } else if (nowOrOpts && typeof nowOrOpts === 'object') {
    opts = nowOrOpts;
    const n = nowOrOpts.now;
    if (n instanceof Date) now = n;
  }
  const id = String(resident?.id ?? '').trim();
  const thresholds = resolveAlertThresholdsForResident(id);
  if (!opts.ignoreMute && isResidentMonitorAlertMuted(id)) {
    const snap = getResidentVitalSnapshot(id);
    return {
      vitalFlags: [],
      vitalBad: false,
      stoolBad: false,
      stoolHours: null,
      urineBad: false,
      urineHours: null,
      patrolBad: false,
      level: 'ok',
      snapshot: snap,
      thresholds,
      muted: true,
    };
  }
  const snap = getResidentVitalSnapshot(String(resident.id));
  const vitalFlags = snap ? detectVitalAbnormal(snap, thresholds) : [];
  const stoolH = getHoursSinceLastStool(resident, now);
  const stoolBad = stoolH != null && stoolH >= thresholds.stoolHoursMax;
  const urineH = getHoursSinceLastUrine(resident, now);
  const urineBad = urineH != null && urineH >= thresholds.urineHoursMax;
  const patrolBad = Number(resident.patrolIntervalMinutes) > thresholds.patrolIntervalWarnMin;
  const vitalBad = vitalFlags.length > 0;
  const critical = vitalBad || stoolBad || urineBad;
  const level = critical ? 'critical' : patrolBad ? 'warn' : 'ok';
  return {
    vitalFlags,
    vitalBad,
    stoolBad,
    stoolHours: stoolH,
    urineBad,
    urineHours: urineH,
    patrolBad,
    level,
    snapshot: snap,
    thresholds,
    muted: false,
  };
}

/**
 * 介護報酬の減算・監査観点の「要確認」候補（断定しない）
 * @param {Record<string, unknown>} resident
 * @param {ReturnType<typeof evaluateResidentMonitor>} monitorEv
 */
export function evaluateReimbursementDeductionAlerts(resident, monitorEv) {
  if (!monitorEv || monitorEv.muted) return { hasAlert: false, lines: [] };
  const lines = [];
  if (monitorEv.patrolBad) {
    lines.push('巡視間隔が長く空いています。サービス提供体制・減算の有無を事業所ルールで確認してください。');
  }
  if (monitorEv.vitalBad || monitorEv.stoolBad || monitorEv.urineBad) {
    lines.push(
      'バイタル異常、または排便・排尿の観察・記録の空白が長時間続いています。安全管理・記録の十分性（減算・監査）を確認してください。'
    );
  }
  return { hasAlert: lines.length > 0, lines };
}

/** @param {string} linkKey carelinkFacilities の linkKey */
export function getNursingDirectives(linkKey) {
  const all = readJson(LS.nursing, {});
  const list = Array.isArray(all[linkKey]) ? all[linkKey] : [];
  const today = localYmd(new Date());
  return list.filter((d) => {
    const from = String(d.startDate ?? '').trim();
    const to = String(d.endDate ?? '').trim();
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from) && today < from) return false;
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to) && today > to) return false;
    return true;
  });
}

export function addNursingDirective(linkKey, text, by = '看護', opts = {}) {
  const t = String(text ?? '').trim();
  if (!t || !linkKey) return false;
  const all = readJson(LS.nursing, {});
  const list = Array.isArray(all[linkKey]) ? all[linkKey] : [];
  const startDate = String(opts?.startDate ?? '').trim();
  const endDate = String(opts?.endDate ?? '').trim();
  list.unshift({
    id: `dir_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text: t,
    ts: new Date().toISOString(),
    by,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : '',
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : '',
  });
  all[linkKey] = list.slice(0, 30);
  writeJson(LS.nursing, all);
  return true;
}

export function removeNursingDirective(linkKey, directiveId, tsFallback = '') {
  const k = String(linkKey ?? '').trim();
  if (!k) return false;
  const all = readJson(LS.nursing, {});
  const list = Array.isArray(all[k]) ? all[k] : [];
  const next = list.filter(
    (d) =>
      String(d.id ?? '').trim() !== String(directiveId ?? '').trim() &&
      String(d.ts ?? '').trim() !== String(tsFallback ?? '').trim()
  );
  if (next.length === list.length) return false;
  all[k] = next;
  writeJson(LS.nursing, all);
  return true;
}

/** @param {string} linkKey */
export function getFacilityHandoverNote(linkKey) {
  const k = String(linkKey ?? '').trim();
  if (!k) return '';
  const all = readJson(LS.facilityHandover, {});
  const row = all[k];
  return String(row?.text ?? '').trim();
}

/**
 * 施設単位の申し送り掲示文（一覧・パノラマで共有）
 * @param {string} linkKey
 * @param {string} text
 */
export function setFacilityHandoverNote(linkKey, text) {
  const k = String(linkKey ?? '').trim();
  if (!k) return false;
  const all = readJson(LS.facilityHandover, {});
  all[k] = { text: String(text ?? '').trim(), updatedAt: new Date().toISOString() };
  writeJson(LS.facilityHandover, all);
  return true;
}

/** @param {string} linkKey */
export function getFacilityNotice(linkKey) {
  const k = String(linkKey ?? '').trim();
  if (!k) return '';
  const all = readJson(LS.facilityNotice, {});
  const row = all[k];
  return String(row?.text ?? '').trim();
}

/**
 * 施設単位の本日の周知事項（一覧の「本日の周知事項」と同期）
 * @param {string} linkKey
 * @param {string} text
 */
export function setFacilityNotice(linkKey, text) {
  const k = String(linkKey ?? '').trim();
  if (!k) return false;
  const all = readJson(LS.facilityNotice, {});
  all[k] = { text: String(text ?? '').trim(), updatedAt: new Date().toISOString() };
  writeJson(LS.facilityNotice, all);
  return true;
}

function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 施設ごとの週間予定（当日〜7日先）を返す
 * @param {string} linkKey
 * @param {Date} [anchor]
 */
export function getWeeklyPlans(linkKey, anchor = new Date()) {
  const k = String(linkKey ?? '').trim();
  if (!k) return [];
  const all = readJson(LS.weeklyPlans, {});
  const list = Array.isArray(all[k]) ? all[k] : [];
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return list
    .filter((v) => {
      const d = new Date(String(v.date ?? ''));
      return Number.isFinite(d.getTime()) && d >= start && d < end;
    })
    .sort((a, b) => {
      const ad = `${a.date} ${a.time}`;
      const bd = `${b.date} ${b.time}`;
      return ad.localeCompare(bd);
    });
}

const WEEKDAY_JA_SHORT = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);

/**
 * 当日0時基準の7日間それぞれに予定を割り当て（未登録日は空配列）。外出・受診の持ち物・服薬準備の俯瞰用。
 * @param {string} linkKey
 * @param {Date} [anchor]
 * @returns {{ date: string; weekdayShort: string; isToday: boolean; plans: unknown[] }[]}
 */
export function getWeeklyPlanDays(linkKey, anchor = new Date()) {
  const k = String(linkKey ?? '').trim();
  if (!k) return [];
  const all = readJson(LS.weeklyPlans, {});
  const list = Array.isArray(all[k]) ? all[k] : [];
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  const endExclusive = new Date(start);
  endExclusive.setDate(endExclusive.getDate() + 7);

  const inWindow = list.filter((v) => {
    const ds = String(v.date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return false;
    const d = new Date(`${ds}T12:00:00`);
    return Number.isFinite(d.getTime()) && d >= start && d < endExclusive;
  });

  const byDate = new Map();
  for (const p of inWindow) {
    const dkey = String(p.date ?? '').slice(0, 10);
    if (!byDate.has(dkey)) byDate.set(dkey, []);
    byDate.get(dkey).push(p);
  }
  for (const arr of byDate.values()) {
    arr.sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')));
  }

  const todayKey = localYmd(new Date());
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = localYmd(d);
    out.push({
      date: key,
      weekdayShort: WEEKDAY_JA_SHORT[d.getDay()],
      isToday: key === todayKey,
      plans: byDate.get(key) ?? [],
    });
  }
  return out;
}

/**
 * 施設ごとの週間予定を追加
 * @param {string} linkKey
 * @param {{ date: string; time: string; title: string; type?: string }} plan
 */
export function addWeeklyPlan(linkKey, plan) {
  const k = String(linkKey ?? '').trim();
  const title = String(plan?.title ?? '').trim();
  if (!k || !title) return false;
  const dateRaw = String(plan?.date ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : localYmd(new Date());
  const timeRaw = String(plan?.time ?? '').trim();
  const time = /^\d{1,2}:\d{2}$/.test(timeRaw) ? timeRaw : '09:00';
  const type = String(plan?.type ?? 'その他').trim() || 'その他';

  const all = readJson(LS.weeklyPlans, {});
  const list = Array.isArray(all[k]) ? all[k] : [];
  list.push({
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date,
    time,
    title,
    type,
    ts: new Date().toISOString(),
  });
  // 古いものは肥大化防止で削る（直近90件）
  all[k] = list.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).slice(-90);
  writeJson(LS.weeklyPlans, all);
  return true;
}

export function removeWeeklyPlan(linkKey, planId) {
  const k = String(linkKey ?? '').trim();
  if (!k) return false;
  const all = readJson(LS.weeklyPlans, {});
  const list = Array.isArray(all[k]) ? all[k] : [];
  const next = list.filter((p) => String(p.id ?? '') !== String(planId ?? ''));
  if (next.length === list.length) return false;
  all[k] = next;
  writeJson(LS.weeklyPlans, all);
  return true;
}

/** @type {unknown[] | null} */
let careEventsCache = null;
let careEventsIdbHydrateStarted = false;

function readCareEventsRawFromLs() {
  const raw = readJson(LS.careEvents, []);
  return Array.isArray(raw) ? raw : [];
}

function startCareEventsIdbHydrate() {
  if (careEventsIdbHydrateStarted) return;
  careEventsIdbHydrateStarted = true;
  const local = careEventsCache ?? readCareEventsRawFromLs();
  void idbMigrateFromLocalStorage(local).then(() =>
    idbLoadAllCareEvents().then((fromIdb) => {
      const merged = mergeCareEventsById(local, fromIdb);
      persistCareEventsList(merged, { skipIdbFullSave: fromIdb.length > 0 });
    })
  );
}

/**
 * @param {unknown[]} list
 * @param {{ skipIdbFullSave?: boolean }} [opts]
 */
function persistCareEventsList(list, opts = {}) {
  const pruned = pruneCareEventsBeyondRetention(Array.isArray(list) ? list : []);
  careEventsCache = pruned;
  try {
    writeJson(LS.careEvents, pruned);
  } catch {
    // localStorage 容量不足時は IndexedDB を正とする
  }
  if (!opts.skipIdbFullSave) void idbSaveAllCareEvents(pruned);
}

export function getAllCareEvents() {
  if (!careEventsCache) {
    careEventsCache = pruneCareEventsBeyondRetention(readCareEventsRawFromLs());
  }
  startCareEventsIdbHydrate();
  return careEventsCache;
}

export function logCareEvent(payload) {
  const list = getAllCareEvents();
  const rawTs = String(payload?.ts ?? '').trim();
  const parsedTs = rawTs ? new Date(rawTs) : null;
  const ts = parsedTs && Number.isFinite(parsedTs.getTime()) ? parsedTs.toISOString() : new Date().toISOString();
  const row = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...payload,
    ts,
  };
  list.push(row);
  persistCareEventsList(list);
  void idbAppendCareEvent(row);
  return row;
}

export function reloadCareEventsFromStorage() {
  careEventsCache = pruneCareEventsBeyondRetention(readCareEventsRawFromLs());
  void idbSaveAllCareEvents(careEventsCache);
  return careEventsCache.length;
}

export function getCareRecordRetentionSummary() {
  return careEventsRetentionSummary(getAllCareEvents());
}

function minuteKey(isoLike) {
  const t = new Date(String(isoLike ?? ''));
  if (!Number.isFinite(t.getTime())) return '';
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(
    t.getHours()
  ).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/**
 * 同一利用者・同一分（YYYY-MM-DD HH:mm）に保存済みのイベントを削除。
 * @param {string} residentId
 * @param {string} isoTs
 * @param {string[]} [types]
 * @returns {number} 削除件数
 */
export function removeCareEventsByResidentAtMinute(residentId, isoTs, types = []) {
  const rid = String(residentId ?? '').trim();
  const mk = minuteKey(isoTs);
  if (!rid || !mk) return 0;
  const allow = Array.isArray(types) && types.length ? new Set(types.map((x) => String(x ?? '').trim())) : null;
  const list = getAllCareEvents();
  const next = list.filter((e) => {
    if (String(e.residentId ?? '').trim() !== rid) return true;
    if (minuteKey(e.ts) !== mk) return true;
    if (allow && !allow.has(String(e.type ?? '').trim())) return true;
    return false;
  });
  const removed = list.length - next.length;
  if (removed > 0) persistCareEventsList(next);
  return removed;
}

/** 月次イベント件数（監査集計用） */
export function aggregateMonthlyCareEvents(facilitySheetTitle, yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const start = new Date(y, m - 1, 1).getTime();
  const end = new Date(y, m, 1).getTime();
  const events = getAllCareEvents().filter((e) => {
    const t = new Date(e.ts).getTime();
    return t >= start && t < end && String(e.facilitySheetTitle ?? '') === String(facilitySheetTitle);
  });
  const c = { patrol: 0, meal: 0, excretion: 0, vital_snapshot: 0, enteral: 0, other: 0 };
  for (const e of events) {
    const t = e.type;
    if (t === 'patrol') c.patrol++;
    else if (t === 'meal') c.meal++;
    else if (t === 'excretion') c.excretion++;
    else if (t === 'vital_snapshot') c.vital_snapshot++;
    else if (t === 'enteral') c.enteral++;
    else c.other++;
  }
  return { ...c, total: events.length, events };
}

/**
 * 利用者・対象月のケアイベント（時系列）
 * @param {string} residentId
 * @param {string} yearMonth YYYY-MM
 */
export function getCareEventsForResidentMonth(residentId, yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return [];
  const start = new Date(y, m - 1, 1).getTime();
  const end = new Date(y, m, 1).getTime();
  const rid = String(residentId);
  return getAllCareEvents()
    .filter((e) => {
      const t = new Date(e.ts).getTime();
      return String(e.residentId) === rid && t >= start && t < end;
    })
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

/**
 * 利用者×暦日（ローカル日付）のケアイベント
 * @param {string} residentId
 * @param {string} ymd YYYY-MM-DD
 */
export function getCareEventsForResidentDay(residentId, ymd) {
  const rid = String(residentId ?? '').trim();
  const day = String(ymd ?? '').trim();
  if (!rid || !day) return [];
  return getAllCareEvents()
    .filter((e) => {
      if (String(e.residentId) !== rid) return false;
      const t = new Date(e.ts);
      if (!Number.isFinite(t.getTime())) return false;
      return tokyoYmdFromTs(e.ts) === day;
    })
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

/**
 * その暦日の vital_snapshot のうち時刻が最も遅い 1 件の meta（一覧表の対象日切替用）
 * @param {string} residentId
 * @param {string} ymd YYYY-MM-DD
 * @returns {Record<string, unknown> | null}
 */
export function getLatestVitalSnapshotMetaForResidentDay(residentId, ymd) {
  const events = getCareEventsForResidentDay(residentId, ymd);
  /** @type {Record<string, unknown> | null} */
  let last = null;
  for (const e of events) {
    if (e?.type !== 'vital_snapshot') continue;
    if (e.meta && typeof e.meta === 'object') last = /** @type {Record<string, unknown>} */ (e.meta);
  }
  return last;
}

/**
 * 請求・月次集計: 利用者×暦月の食事ログ件数・経管実施ログ件数（このブラウザに保存された記録）
 * @param {string} residentId
 * @param {string} yearMonth YYYY-MM
 */
export function summarizeResidentMonthBilling(residentId, yearMonth) {
  const events = getCareEventsForResidentMonth(residentId, yearMonth);
  let mealLogged = 0;
  let enteralLogged = 0;
  const mealLoggedBySlot = { 朝: 0, 昼: 0, 夜: 0 };
  for (const e of events) {
    if (e.type === 'meal') {
      mealLogged++;
      const mt = String(e?.meta?.mealTime ?? '').trim();
      if (mt === '朝') mealLoggedBySlot['朝'] += 1;
      else if (mt === '昼') mealLoggedBySlot['昼'] += 1;
      else if (mt === '夕' || mt === '夜') mealLoggedBySlot['夜'] += 1;
    }
    if (e.type === 'enteral') enteralLogged++;
  }
  return { mealLogged, mealLoggedBySlot, enteralLogged };
}

/**
 * 有料・監査向け: 利用者1人×1か月を1行にまとめた CSV（名簿は任意。未指定時は記録のある利用者のみ）
 * @param {string} facilitySheetTitle
 * @param {string} yearMonth YYYY-MM
 * @param {Array<{ id?: unknown; name?: unknown; room?: unknown }>} [roster]
 */
export function buildMonthlyAuditCsv(facilitySheetTitle, yearMonth, roster = []) {
  const q = (v) => {
    const t = String(v ?? '');
    if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const fmtTs = (ms) => {
    if (ms == null || !Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  const agg = aggregateMonthlyCareEvents(facilitySheetTitle, yearMonth);
  const { events } = agg;

  /** @type {Map<string, { residentId: string; residentName: string; room: string; patrol: number; meal: number; excretion: number; vital_snapshot: number; enteral: number; other: number; firstTs: number | null; lastTs: number | null; lastPatrolTs: number | null; lastMealTs: number | null; lastExcretionTs: number | null; lastVitalTs: number | null; lastEnteralTs: number | null }>} */
  const byResident = new Map();

  for (const e of events) {
    const rid = String(e.residentId ?? '').trim();
    if (!rid) continue;
    if (!byResident.has(rid)) {
      byResident.set(rid, {
        residentId: rid,
        residentName: String(e.residentName ?? '').trim(),
        room: '',
        patrol: 0,
        meal: 0,
        excretion: 0,
        vital_snapshot: 0,
        enteral: 0,
        other: 0,
        firstTs: null,
        lastTs: null,
        lastPatrolTs: null,
        lastMealTs: null,
        lastExcretionTs: null,
        lastVitalTs: null,
        lastEnteralTs: null,
      });
    }
    const row = byResident.get(rid);
    const rname = String(e.residentName ?? '').trim();
    if (rname) row.residentName = rname;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (row.firstTs == null || t < row.firstTs) row.firstTs = t;
    if (row.lastTs == null || t > row.lastTs) row.lastTs = t;
    const typ = e.type;
    if (typ === 'patrol') {
      row.patrol++;
      if (row.lastPatrolTs == null || t > row.lastPatrolTs) row.lastPatrolTs = t;
    } else if (typ === 'meal') {
      row.meal++;
      if (row.lastMealTs == null || t > row.lastMealTs) row.lastMealTs = t;
    } else if (typ === 'excretion') {
      row.excretion++;
      if (row.lastExcretionTs == null || t > row.lastExcretionTs) row.lastExcretionTs = t;
    } else if (typ === 'vital_snapshot') {
      row.vital_snapshot++;
      if (row.lastVitalTs == null || t > row.lastVitalTs) row.lastVitalTs = t;
    } else if (typ === 'enteral') {
      row.enteral++;
      if (row.lastEnteralTs == null || t > row.lastEnteralTs) row.lastEnteralTs = t;
    } else {
      row.other++;
    }
  }

  const rosterArr = Array.isArray(roster) ? roster : [];
  for (const r of rosterArr) {
    const id = String(r?.id ?? '').trim();
    if (!id) continue;
    const room = String(r?.room ?? '').trim();
    const nm = String(r?.name ?? '').trim();
    if (!byResident.has(id)) {
      byResident.set(id, {
        residentId: id,
        residentName: nm,
        room,
        patrol: 0,
        meal: 0,
        excretion: 0,
        vital_snapshot: 0,
        enteral: 0,
        other: 0,
        firstTs: null,
        lastTs: null,
        lastPatrolTs: null,
        lastMealTs: null,
        lastExcretionTs: null,
        lastVitalTs: null,
        lastEnteralTs: null,
      });
    } else {
      const row = byResident.get(id);
      if (room) row.room = room;
      if (nm && (!row.residentName || row.residentName === '—')) row.residentName = nm;
    }
  }

  const rows = [...byResident.values()].sort((a, b) => {
    const an = a.residentName || a.residentId;
    const bn = b.residentName || b.residentId;
    return an.localeCompare(bn, 'ja');
  });

  const header = [
    '行種別',
    '施設名',
    '対象月',
    '利用者ID',
    '利用者名',
    '居室',
    '巡視回数',
    '食事回数',
    '経管回数',
    '排泄回数',
    'バイタル回数',
    'その他回数',
    '合計回数',
    '初回記録日時',
    '最終記録日時',
    '最終巡視日時',
    '最終食事日時',
    '最終排泄日時',
    '最終バイタル日時',
    '最終経管日時',
    '当月サマリー',
  ];

  const lines = [header.join(',')];

  const facSummary =
    `施設計（当月・本ブラウザ保存分）: 巡視${agg.patrol}・食事${agg.meal}・経管${agg.enteral}・排泄${agg.excretion}・バイタル${agg.vital_snapshot}・その他${agg.other}（総ログ${agg.total}件）／利用者行${rows.length}名`;
  lines.push(
    [
      '施設月次集計',
      q(facilitySheetTitle),
      q(yearMonth),
      '',
      '',
      '',
      agg.patrol,
      agg.meal,
      agg.enteral,
      agg.excretion,
      agg.vital_snapshot,
      agg.other,
      agg.total,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      q(facSummary),
    ].join(',')
  );

  for (const r of rows) {
    const total = r.patrol + r.meal + r.excretion + r.vital_snapshot + r.enteral + r.other;
    const monthStatus =
      total === 0
        ? '当月このブラウザに保存された提供記録なし（未入力・別端末の可能性あり）'
        : `巡視${r.patrol}回・食事${r.meal}回・経管${r.enteral}回・排泄${r.excretion}回・バイタル${r.vital_snapshot}回・その他${r.other}回（合計${total}件）`;
    lines.push(
      [
        '利用者月次',
        q(facilitySheetTitle),
        q(yearMonth),
        q(r.residentId),
        q(r.residentName),
        q(r.room),
        r.patrol,
        r.meal,
        r.enteral,
        r.excretion,
        r.vital_snapshot,
        r.other,
        total,
        q(fmtTs(r.firstTs)),
        q(fmtTs(r.lastTs)),
        q(fmtTs(r.lastPatrolTs)),
        q(fmtTs(r.lastMealTs)),
        q(fmtTs(r.lastExcretionTs)),
        q(fmtTs(r.lastVitalTs)),
        q(fmtTs(r.lastEnteralTs)),
        q(monthStatus),
      ].join(',')
    );
  }

  return lines.join('\n');
}

/**
 * @param {string} facilitySheetTitle
 * @param {string} yearMonth
 * @param {Array<{ id?: unknown; name?: unknown; room?: unknown }>} [roster] 画面上の入居者一覧（記録ゼロも行として出す）
 */
export function downloadMonthlyAuditSheet(facilitySheetTitle, yearMonth, roster = []) {
  const csv = buildMonthlyAuditCsv(facilitySheetTitle, yearMonth, roster);
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = String(facilitySheetTitle).replace(/[\\/:*?"<>|]/g, '_');
  a.download = `有料月次_利用者別_${safe}_${yearMonth}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 有料監査で想定する巡視間隔（分） */
export const PAID_AUDIT_PATROL_TARGET_MIN = 180;

/**
 * @param {unknown[]} events getCareEventsForResidentMonth の戻り（時系列）
 */
export function analyzePatrolIntervalsForMonth(events) {
  const patrols = (Array.isArray(events) ? events : [])
    .filter((e) => e.type === 'patrol')
    .map((e) => new Date(e.ts).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (patrols.length === 0) {
    return {
      count: 0,
      maxGapMin: null,
      avgGapMin: null,
      gapsOverTarget: 0,
      narrative:
        '当月の巡視ログなし（紙・別システムの可能性あり）。3時間おきの実施状況は記録と照合してください。',
    };
  }
  const gaps = [];
  for (let i = 1; i < patrols.length; i++) gaps.push((patrols[i] - patrols[i - 1]) / 60000);
  const maxGapMin = gaps.length ? Math.max(...gaps) : null;
  const avgGapMin = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const gapsOverTarget = gaps.filter((g) => g > PAID_AUDIT_PATROL_TARGET_MIN).length;
  let narrative = `巡視ログ${patrols.length}件。`;
  if (maxGapMin != null) narrative += `記録間の最大空き約${Math.round(maxGapMin)}分`;
  if (avgGapMin != null) narrative += `、平均約${Math.round(avgGapMin)}分。`;
  narrative += `${PAID_AUDIT_PATROL_TARGET_MIN}分超の空きが${gapsOverTarget}回（記録ベース。実巡視と一致するかは現場確認）。`;
  return { count: patrols.length, maxGapMin, avgGapMin, gapsOverTarget, narrative };
}

/** @param {unknown} meta */
function mealValueFromMeta(meta) {
  const v = meta && typeof meta === 'object' ? meta.mealValue : null;
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown[]} events
 */
export function analyzeMealIntakeForMonth(events) {
  const meals = (Array.isArray(events) ? events : []).filter((e) => e.type === 'meal');
  const withVal = [];
  for (const e of meals) {
    const n = mealValueFromMeta(e.meta);
    if (n != null) withVal.push(n);
  }
  const tens = withVal.filter((n) => n >= 10).length;
  const avg = withVal.length ? withVal.reduce((a, b) => a + b, 0) / withVal.length : null;
  let narrative = `食事ログ${meals.length}件。`;
  if (withVal.length === 0) {
    narrative +=
      '摂取割合（◯割）の記録はありません（クイックの「食事確認」等のみの可能性）。10割摂取の評価は別記録と併せて確認してください。';
  } else {
    narrative += `割合記録${withVal.length}件のうち10割相当${tens}件、記録がある分の平均約${avg != null ? avg.toFixed(1) : '—'}割。`;
    if (meals.length > withVal.length) narrative += `（ログ${meals.length - withVal.length}件は割合未記入）`;
  }
  return { mealCount: meals.length, withValueCount: withVal.length, tenCount: tens, avgMealValue: avg, narrative };
}

/**
 * @param {unknown[]} events
 */
export function analyzeExcretionIntervalsForMonth(events) {
  const ex = (Array.isArray(events) ? events : [])
    .filter((e) => e.type === 'excretion')
    .map((e) => ({ t: new Date(e.ts).getTime(), note: String(e.meta?.note ?? '') }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (ex.length === 0) {
    return {
      count: 0,
      avgGapHours: null,
      maxGapHours: null,
      avgDayGap: null,
      narrative:
        '排泄ログなし。排尿・排便の間隔は別記録（バイタル・排泄表等）と照合してください。※本システムのクイック記録は排尿・排便を区別しない場合があります。',
    };
  }
  const hourGaps = [];
  for (let i = 1; i < ex.length; i++) hourGaps.push((ex[i].t - ex[i - 1].t) / 3600000);
  const avgGapHours = hourGaps.length ? hourGaps.reduce((a, b) => a + b, 0) / hourGaps.length : null;
  const maxGapHours = hourGaps.length ? Math.max(...hourGaps) : null;

  const byDay = [...new Set(ex.map((x) => localYmd(new Date(x.t))))].sort();
  const dayGaps = [];
  for (let i = 1; i < byDay.length; i++) {
    const a = new Date(`${byDay[i - 1]}T12:00:00`);
    const b = new Date(`${byDay[i]}T12:00:00`);
    dayGaps.push((b - a) / 86400000);
  }
  const avgDayGap = dayGaps.length ? dayGaps.reduce((x, y) => x + y, 0) / dayGaps.length : null;

  let narrative = `排泄ログ${ex.length}件。記録間の平均約${avgGapHours != null ? avgGapHours.toFixed(1) : '—'}時間、最大約${maxGapHours != null ? maxGapHours.toFixed(1) : '—'}時間。`;
  narrative += `記録のあった日の間隔（目安）平均約${avgDayGap != null ? avgDayGap.toFixed(1) : '—'}日。`;
  narrative += '（排尿・排便の別・実際の排泄間隔は記録様式により異なります。）';
  return { count: ex.length, avgGapHours, maxGapHours, avgDayGap, narrative };
}

function escPaidHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 監査HTML用: 同一利用者が複数施設で記録している場合、名簿の施設に合わせて絞り込む
 * @param {unknown[]} events
 * @param {string} facilitySheetTitle
 */
function filterEventsByFacilitySheet(events, facilitySheetTitle) {
  const fac = String(facilitySheetTitle ?? '').trim();
  if (!fac) return Array.isArray(events) ? events : [];
  return (Array.isArray(events) ? events : []).filter((e) => {
    const ef = e.facilitySheetTitle != null ? String(e.facilitySheetTitle).trim() : '';
    return !ef || ef === fac;
  });
}

/** @param {unknown} e */
function excretionContributesToUrine(e) {
  if (e.type !== 'excretion') return false;
  const m = e.meta && typeof e.meta === 'object' ? e.meta : {};
  const u = String(m.urineVolume ?? '').trim();
  const sv = String(m.stoolVolume ?? '').trim();
  const sc = String(m.stoolCharacter ?? '').trim();
  const hasDetail = Boolean(u || sv || sc);
  if (!hasDetail) return true;
  return Boolean(u);
}

/** @param {unknown} e */
function excretionContributesToStool(e) {
  if (e.type !== 'excretion') return false;
  const m = e.meta && typeof e.meta === 'object' ? e.meta : {};
  const u = String(m.urineVolume ?? '').trim();
  const sv = String(m.stoolVolume ?? '').trim();
  const sc = String(m.stoolCharacter ?? '').trim();
  const hasDetail = Boolean(u || sv || sc);
  if (!hasDetail) return true;
  return Boolean(sv || sc);
}

/**
 * 当月・ローカル時刻の「時」（0–23）ごとに件数を数える
 * @param {unknown[]} events
 * @param {string} type patrol | meal | excretion | enteral
 * @param {(e: unknown) => boolean} [predicate]
 */
function hourBucketsForMonthEvents(events, type, predicate) {
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const e of Array.isArray(events) ? events : []) {
    if (e.type !== type) continue;
    if (predicate && !predicate(e)) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    const h = new Date(e.ts).getHours();
    if (h >= 0 && h < 24) buckets[h]++;
  }
  return buckets;
}

/**
 * バイタルチェック表風: 時刻帯（00–23）× 区分のグリッドHTML（印刷向け）
 * @param {string} facilitySheetTitle
 * @param {string} yearMonth
 * @param {Array<Record<string, unknown>>} roster
 */
function buildPaidAuditHourlySheetHtmlSection(facilitySheetTitle, yearMonth, roster = []) {
  const fac = String(facilitySheetTitle ?? '');
  const ym = String(yearMonth ?? '');
  const def = facilityDefBySheetTitle(fac);
  const displayName = def?.tabLabel ? String(def.tabLabel) : fac;
  const rosterArr = Array.isArray(roster) ? roster : [];
  const byId = new Map();
  for (const r of rosterArr) {
    const id = String(r?.id ?? '').trim();
    if (!id) continue;
    byId.set(id, r);
  }
  const rows = [...byId.values()].sort((a, b) =>
    String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'ja')
  );

  const hourLabels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

  const parts = [];
  parts.push(
    `<section class="hourly-sheet" style="page-break-before:always;margin-top:24px;">`
  );
  parts.push(`<h2 style="font-size:1.1rem;margin:0 0 8px;color:#0e7490;">バイタルチェック表形式（ログ発生時刻の時別・当月）</h2>`);
  parts.push(
    `<p style="font-size:0.86rem;color:#475569;margin:0 0 12px;">紙の様式に近い<strong>00〜23時のマス</strong>です。当月に記録されたイベントを<strong>発生時刻の時</strong>（この端末のタイムゾーン）に振り分けています。尿・便は記録内容（尿量・便量・性状）で振り分け、詳細のない「排泄確認」は尿・便の両方に反映します。</p>`
  );
  parts.push(`<div class="sheet-caption" style="font-size:0.95rem;font-weight:700;margin-bottom:10px;">${escPaidHtml(displayName)}　バイタルチェック表（${escPaidHtml(ym)}）</div>`);

  if (rows.length === 0) {
    parts.push(`<p style="font-size:0.88rem;">利用者がありません。</p></section>`);
    return parts.join('');
  }

  for (const r of rows) {
    const id = String(r?.id ?? '');
    const name = String(r?.name ?? '—');
    const room = String(r?.room ?? '—');
    const raw = getCareEventsForResidentMonth(id, ym);
    const events = filterEventsByFacilitySheet(raw, fac);

    const bPatrol = hourBucketsForMonthEvents(events, 'patrol');
    const bMeal = hourBucketsForMonthEvents(events, 'meal');
    const bEnteral = hourBucketsForMonthEvents(events, 'enteral');
    const bUrine = hourBucketsForMonthEvents(events, 'excretion', excretionContributesToUrine);
    const bStool = hourBucketsForMonthEvents(events, 'excretion', excretionContributesToStool);

    const rowSpecs = [
      { label: '巡視', buckets: bPatrol },
      { label: '食事', buckets: bMeal },
      { label: '経管', buckets: bEnteral },
      { label: '尿', buckets: bUrine },
      { label: '便', buckets: bStool },
    ];

    parts.push(`<div class="resident-hourly-block" style="break-inside:avoid;margin-bottom:20px;">`);
    parts.push(
      `<div style="font-size:0.9rem;font-weight:600;margin-bottom:6px;">${escPaidHtml(name)}　<span style="font-weight:400;color:#64748b;">居室 ${escPaidHtml(room)}</span></div>`
    );
    parts.push(`<div class="sheet-scroll" style="overflow-x:auto;-webkit-overflow-scrolling:touch;">`);
    parts.push(`<table class="hourly-grid" style="border-collapse:collapse;font-size:9px;width:100%;min-width:720px;">`);
    parts.push(`<thead><tr><th style="border:1px solid #334155;background:#f1f5f9;padding:4px 6px;min-width:3em;">区分</th>`);
    for (const h of hourLabels) {
      parts.push(
        `<th style="border:1px solid #334155;background:#f1f5f9;padding:2px 3px;width:2.2em;">${h}</th>`
      );
    }
    parts.push(`</tr></thead><tbody>`);
    for (const spec of rowSpecs) {
      parts.push(`<tr><th scope="row" style="border:1px solid #334155;background:#f8fafc;padding:4px 6px;text-align:left;white-space:nowrap;">${escPaidHtml(spec.label)}</th>`);
      for (let hi = 0; hi < 24; hi++) {
        const n = spec.buckets[hi];
        const cell = n > 0 ? (n > 1 ? String(n) : '●') : '';
        parts.push(
          `<td style="border:1px solid #94a3b8;padding:2px;text-align:center;min-height:1.4em;">${escPaidHtml(cell)}</td>`
        );
      }
      parts.push(`</tr>`);
    }
    parts.push(`</tbody></table></div></div>`);
  }

  parts.push(`</section>`);
  return parts.join('');
}

/**
 * 有料監査・請求説明用: 間隔・摂取状況の文章と請求用件数を利用者ごとにHTML化（印刷・提出のたたき台）
 * @param {string} facilitySheetTitle
 * @param {string} yearMonth YYYY-MM
 * @param {Array<Record<string, unknown>>} [roster] id, name, room, mealCountThisMonth, isEnteral
 */
export function buildPaidAuditMonthlyNarrativeHtml(facilitySheetTitle, yearMonth, roster = []) {
  const fac = String(facilitySheetTitle ?? '');
  const ym = String(yearMonth ?? '');
  const rosterArr = Array.isArray(roster) ? roster : [];
  const byId = new Map();
  for (const r of rosterArr) {
    const id = String(r?.id ?? '').trim();
    if (!id) continue;
    byId.set(id, r);
  }
  const rows = [...byId.values()].sort((a, b) =>
    String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'ja')
  );

  const parts = [];
  parts.push(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"/>`);
  parts.push(`<title>${escPaidHtml(fac)} ${escPaidHtml(ym)} 有料監査・請求用サマリー</title>`);
  parts.push(`<style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:16px;line-height:1.55;color:#0f172a;max-width:1100px;}
    h1{font-size:1.2rem;margin:0 0 12px;}
    .warn{background:#fff7ed;border:1px solid #fdba74;padding:10px 12px;border-radius:8px;font-size:0.88rem;margin-bottom:16px;}
    .card{border:1px solid #cbd5e1;border-radius:10px;padding:12px 14px;margin-bottom:14px;break-inside:avoid;}
    h2{font-size:1.05rem;margin:0 0 8px;color:#0e7490;}
    .bill{font-size:0.88rem;color:#334155;margin-bottom:8px;}
    .one{font-weight:700;background:#f0fdfa;border-left:4px solid #0d9488;padding:8px 10px;margin:8px 0;font-size:0.95rem;}
    .detail{font-size:0.86rem;color:#475569;margin-top:6px;}
    @media print{.warn{break-inside:avoid;}.hourly-sheet .sheet-scroll{overflow:visible;}}
  </style></head><body>`);
  parts.push(`<h1>${escPaidHtml(fac)}／${escPaidHtml(ym)}　有料サービス監査・請求用サマリー（たたき台）</h1>`);
  parts.push(
    `<div class="warn"><strong>※重要</strong>　本書は<strong>この端末に保存されたログ</strong>から自動生成した草案です。<strong>CSV（件数・最終日時）</strong>と併用できます。巡視・排泄は「記録があった間隔」であり、実サービス実態・排尿排便の区別は原本記録と照合して追記・修正してください。提出用の<strong>一言</strong>は事業所の文面に合わせて調整してください。</div>`
  );

  for (const r of rows) {
    const id = String(r?.id ?? '');
    const name = String(r?.name ?? '—');
    const room = String(r?.room ?? '—');
    const events = filterEventsByFacilitySheet(getCareEventsForResidentMonth(id, ym), fac);
    const patrol = analyzePatrolIntervalsForMonth(events);
    const mealA = analyzeMealIntakeForMonth(events);
    const exc = analyzeExcretionIntervalsForMonth(events);
    const bill = summarizeResidentMonthBilling(id, ym);
    const sheetMeal = Number(r?.mealCountThisMonth) || 0;
    const mealTotal = sheetMeal + bill.mealLogged;
    const enteralFlag = Boolean(r?.isEnteral);

    const oneLine = [
      `【${name.replace(/様\s*$/u, '').trim()}様】`,
      `巡視は記録上${patrol.count}件（${PAID_AUDIT_PATROL_TARGET_MIN}分超の空き${patrol.gapsOverTarget}回）。`,
      `食事は名簿${sheetMeal}回＋ログ${bill.mealLogged}回＝合計${mealTotal}回、経管実施ログ${bill.enteralLogged}回。`,
      mealA.withValueCount
        ? `摂取割合のある食事記録は${mealA.withValueCount}件（10割相当${mealA.tenCount}件）。`
        : '食事は割合未記録のログ中心のため、10割摂取は別記録で確認。',
      exc.count
        ? `排泄ログは${exc.count}件（記録間隔の目安は本文参照）。`
        : '排泄ログなし（別記録要確認）。',
    ].join('');

    parts.push(`<div class="card">`);
    parts.push(`<h2>${escPaidHtml(name)}（居室 ${escPaidHtml(room)}）</h2>`);
    parts.push(
      `<div class="bill">【請求・集計】当月食事回数 名簿<strong>${sheetMeal}</strong>＋端末記録<strong>${bill.mealLogged}</strong>＝合計<strong>${mealTotal}</strong>回／経管栄養実施ログ <strong>${bill.enteralLogged}</strong>回／名簿の経管対象 <strong>${enteralFlag ? 'あり' : 'なし'}</strong></div>`
    );
    parts.push(`<div class="one">提出用・一言要約（調整可）<br/>${escPaidHtml(oneLine)}</div>`);
    parts.push(`<div class="detail"><strong>巡視（3時間おきの観点・記録ベース）</strong><br/>${escPaidHtml(patrol.narrative)}</div>`);
    parts.push(`<div class="detail"><strong>食事（全量・割合の記録ベース）</strong><br/>${escPaidHtml(mealA.narrative)}</div>`);
    parts.push(`<div class="detail"><strong>排泄（排尿・排便を分けないログの場合の間隔目安）</strong><br/>${escPaidHtml(exc.narrative)}</div>`);
    parts.push(`</div>`);
  }

  if (rows.length === 0) {
    parts.push(`<p>名簿が渡されていないか、利用者0件です。記録画面で施設を開いたうえで出力してください。</p>`);
  }

  parts.push(buildPaidAuditHourlySheetHtmlSection(facilitySheetTitle, yearMonth, roster));
  parts.push(`</body></html>`);
  return parts.join('');
}

/**
 * @param {string} facilitySheetTitle
 * @param {string} yearMonth
 * @param {Array<Record<string, unknown>>} [roster]
 */
export function downloadPaidAuditNarrativeHtml(facilitySheetTitle, yearMonth, roster = []) {
  const html = buildPaidAuditMonthlyNarrativeHtml(facilitySheetTitle, yearMonth, roster);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = String(facilitySheetTitle).replace(/[\\/:*?"<>|]/g, '_');
  a.download = `有料監査_月次要約_${safe}_${yearMonth}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** @param {string} residentId */
export function getEmergencyContact(residentId) {
  const all = readJson(LS.emergencyContact, {});
  return all[String(residentId)] ?? { name: '（未登録）', tel: '—', relation: '—' };
}

export function setEmergencyContact(residentId, data) {
  const all = readJson(LS.emergencyContact, {});
  all[String(residentId)] = { ...data };
  writeJson(LS.emergencyContact, all);
}

/** @param {string} residentId */
export function getResidentDisabilityServiceProgress(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return null;
  const all = readJson(LS.disabilityServiceProgress, {});
  const row = all[id];
  if (!row || typeof row !== 'object') return null;
  return {
    residentName: String(row.residentName ?? '').trim(),
    careManagerName: String(row.careManagerName ?? '').trim(),
    diagnosisRequestDate: String(row.diagnosisRequestDate ?? '').trim(),
    municipalApplicationDate: String(row.municipalApplicationDate ?? '').trim(),
    handbookExpectedDate: String(row.handbookExpectedDate ?? '').trim(),
    categoryApplicationDate: String(row.categoryApplicationDate ?? '').trim(),
    categoryAssignee: String(row.categoryAssignee ?? '').trim(),
    hoursFinalizationDate: String(row.hoursFinalizationDate ?? '').trim(),
    hoursAssignee: String(row.hoursAssignee ?? '').trim(),
    updatedAt: String(row.updatedAt ?? '').trim(),
  };
}

/**
 * @param {string} residentId
 * @param {{
 *   residentName?: string;
 *   careManagerName?: string;
 *   diagnosisRequestDate?: string;
 *   municipalApplicationDate?: string;
 *   handbookExpectedDate?: string;
 *   categoryApplicationDate?: string;
 *   categoryAssignee?: string;
 *   hoursFinalizationDate?: string;
 *   hoursAssignee?: string;
 * }} progress
 */
export function setResidentDisabilityServiceProgress(residentId, progress) {
  const id = String(residentId ?? '').trim();
  if (!id) return;
  const all = readJson(LS.disabilityServiceProgress, {});
  all[id] = {
    residentName: String(progress?.residentName ?? '').trim(),
    careManagerName: String(progress?.careManagerName ?? '').trim(),
    diagnosisRequestDate: String(progress?.diagnosisRequestDate ?? '').trim(),
    municipalApplicationDate: String(progress?.municipalApplicationDate ?? '').trim(),
    handbookExpectedDate: String(progress?.handbookExpectedDate ?? '').trim(),
    categoryApplicationDate: String(progress?.categoryApplicationDate ?? '').trim(),
    categoryAssignee: String(progress?.categoryAssignee ?? '').trim(),
    hoursFinalizationDate: String(progress?.hoursFinalizationDate ?? '').trim(),
    hoursAssignee: String(progress?.hoursAssignee ?? '').trim(),
    updatedAt: new Date().toISOString(),
  };
  writeJson(LS.disabilityServiceProgress, all);
}

/** 情報提供書AIが救急サマリーにマージするキー（RecordPage の emergencyDraft と一致） */
export const INFO_PROVISION_EMERGENCY_KEYS = Object.freeze([
  'senderOffice',
  'senderAddress',
  'senderTel',
  'senderNurse',
  'primaryDoctor',
  'medicalAgency',
  'medicalAddress',
  'dailyLife',
  'nurseProblems',
  'acuteChange',
  'nurseContent',
  'careNotes',
  'other',
]);

/** @param {string} residentId */
export function getResidentInfoProvisionExtract(residentId) {
  const all = readJson(LS.infoProvisionExtract, {});
  const row = all[String(residentId)];
  return row && typeof row === 'object' ? row : null;
}

/**
 * @param {string} residentId
 * @param {{ sourceFileName?: string; extractedAt?: string; fields: Record<string, string>; hasPdf?: boolean }} record
 */
export function setResidentInfoProvisionExtract(residentId, record) {
  const id = String(residentId ?? '').trim();
  if (!id) return;
  const all = readJson(LS.infoProvisionExtract, {});
  all[id] = {
    sourceFileName: String(record?.sourceFileName ?? '').trim(),
    extractedAt: String(record?.extractedAt ?? new Date().toISOString()),
    fields: record?.fields && typeof record.fields === 'object' ? record.fields : {},
    hasPdf: Boolean(record?.hasPdf),
  };
  writeJson(LS.infoProvisionExtract, all);
}

/**
 * 情報提供のメタ（localStorage）のみ削除。PDF は residentInfoProvisionIdb を別途消す。
 * @param {string} residentId
 */
export function clearResidentInfoProvisionMeta(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return;
  const all = readJson(LS.infoProvisionExtract, {});
  if (!Object.prototype.hasOwnProperty.call(all, id)) return;
  delete all[id];
  writeJson(LS.infoProvisionExtract, all);
}

/* * メタ（localStorage）と PDF（IndexedDB）の両方を削除（情報提供・看護PDFなど全種） */
export async function deleteResidentInfoProvisionCompletely(residentId) {
  clearResidentInfoProvisionMeta(residentId);
  try {
    await deleteAllResidentPdfs(residentId);
  } catch {
    // no-op
  }
}

/**
 * 情報提供書等の PDF を Gemini に読ませ、救急搬送サマリー用の項目をJSONで返す
 * @param {string} apiKey
 * @param {string} pdfBase64 Data URL または生の base64（application/pdf）
 * @param {{ residentName?: string; room?: string; facilityLabel?: string }} [context]
 */
export async function fetchJohoteikyoFromPdf(apiKey, pdfBase64, context = {}) {
  if (!apiKey?.trim()) throw new Error('VITE_GEMINI_API_KEY が必要です');
  let b64 = String(pdfBase64 ?? '').trim();
  if (b64.includes(',')) b64 = String(b64.split(',').pop() ?? '').trim();
  b64 = b64.replace(/\s/g, '');
  if (!b64) throw new Error('PDFのデータが空です');

  const resName = String(context.residentName ?? '').trim();
  const room = String(context.room ?? '').trim();
  const fac = String(context.facilityLabel ?? '').trim();

  const allExtractKeys = [
    ...INFO_PROVISION_EMERGENCY_KEYS,
    'emergencyContactName',
    'emergencyContactRelation',
    'emergencyContactTel',
    'allergiesAndContraindications',
    'diseaseNameSummary',
    'medicationSummary',
    'heightWeightOptional',
    'adlIadlSummary',
    'tubeTracheostomyOptional',
    'infectionPrecautionsOptional',
    'familyWishesOptional',
    'nurseAndCareAttentionSummary',
  ];
  const keyList = allExtractKeys.join(', ');

  const prompt = `添付PDFは、在宅・施設の「情報提供書」「退院サマリー」「訪問看護・訪問診療の指示」などの写しであることが多いです。
利用者本人の文書である前提で読み取り、次のキーをすべて持つJSONオブジェクトを1つだけ返してください（説明文・Markdownのフェンス禁止）。各値は日本語の文字列。読み取れない項目は空文字。推測は「可能性がある」と明示し、断定は避けてください。

【コンテキスト（名簿の利用者。PDF内の氏名と照合）】
- 利用者: ${resName || '（不明）'}
- 居室: ${room || '—'}
- 施設タブ: ${fac || '—'}

【JSONのキー（すべて文字列）】
${keyList}

【各キーの意味】
- senderOffice, senderAddress, senderTel, senderNurse: 文書にあれば「提出元／連絡先事業所」等。無ければ空。
- primaryDoctor, medicalAgency, medicalAddress: 主治医・かかりつけ医療機関
- dailyLife〜other: 救急搬送時に必要な要約（日常生活ADL、看護問題、急変内容、看護内容、ケア注意、その他）
- emergencyContactName / Relation / Tel: 家族等の緊急連絡（文書にあれば）
- allergiesAndContraindications: アレルギー・禁忌
- diseaseNameSummary: 病名・診断の要約
- medicationSummary: 服薬の要約
- heightWeightOptional, adlIadlSummary, tubeTracheostomyOptional, infectionPrecautionsOptional, familyWishesOptional: 文書にあれば簡潔に。無ければ空。
- nurseAndCareAttentionSummary: 看護師と介護士が日々のケアで**特に注意すべき点**を要約する（日本語。箇条書き5〜12行目安。転倒・誤薬・感染対策・呼吸・摂食嚥下・行動面・皮膚・二便・意思コミュニケーション等、文書に根拠のある事項を優先）。上記の dailyLife 等の繰り返しは避け、現場行動に直結する打ち出しに限定。文書に記載が乏しい場合は空に近い短い文で足りる範囲にとどめ、医療判断の代替と誤解される断定は避ける。

dailyLife / nurseProblems / careNotes / other に、上記の補足情報（病名・服薬・アレルギー等）のうち救急時に有用なものを短く追記してよいですが、同一内容のコピペの羅列は避けてください。nurseAndCareAttentionSummary とは内容を重複させすぎない（救急要約は other 系、日々ケア注意は nurseAndCareAttentionSummary に寄せる）`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: b64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { temperature: 0.12, maxOutputTokens: 8192 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!res.ok || !text) {
    throw new Error(formatGeminiGenerateContentErrorMessage(data, res.status));
  }
  const raw = stripJsonFence(text);
  try {
    const parsed = JSON.parse(raw);
    /** @type {Record<string, string>} */
    const out = {};
    for (const k of allExtractKeys) {
      out[k] = String(parsed[k] ?? '').trim();
    }
    return out;
  } catch {
    throw new Error('AIのJSONを解釈できませんでした。PDFが画像のみの場合は読み取れないことがあります。');
  }
}

/**
 * 直近7日のバイタルログ（スナップショット履歴は簡易: careEvents type vital から）
 * @param {string} residentId
 */
export function getWeeklyVitalTimeline(residentId) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600000;
  return getAllCareEvents()
    .filter(
      (e) =>
        String(e.residentId) === String(residentId) &&
        e.type === 'vital_snapshot' &&
        new Date(e.ts).getTime() >= weekAgo
    )
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

export function logVitalSnapshot(residentId, residentName, facilitySheetTitle, vitals, ts = '') {
  return logCareEvent({
    type: 'vital_snapshot',
    residentId,
    residentName,
    facilitySheetTitle,
    meta: vitals,
    ts,
  });
}

/**
 * カレンダー用: 過去7日のイベントを日付キーで集約
 * @param {string} residentId
 */
export function getWeekCalendarBuckets(residentId, anchor = new Date()) {
  const buckets = {};
  for (let d = 0; d < 7; d++) {
    const dt = new Date(anchor);
    dt.setHours(0, 0, 0, 0);
    dt.setDate(dt.getDate() - d);
    const key = localYmd(dt);
    buckets[key] = {
      date: key,
      patrol: 0,
      meal: 0,
      excretion: 0,
      enteral: 0,
      notes: [],
      dayOnSite: false,
      dayExternal: false,
    };
  }
  const start = new Date(anchor);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  for (const e of getAllCareEvents()) {
    if (String(e.residentId) !== String(residentId)) continue;
    const ed = new Date(e.ts);
    if (ed.getTime() < start.getTime()) continue;
    const key = localYmd(ed);
    if (!buckets[key]) continue;
    if (e.type === 'patrol') buckets[key].patrol++;
    if (e.type === 'meal') buckets[key].meal++;
    if (e.type === 'excretion') buckets[key].excretion++;
    if (e.type === 'enteral') buckets[key].enteral++;
    if (e.meta?.note) buckets[key].notes.push(String(e.meta.note));
  }
  const rid = String(residentId ?? '').trim();
  for (const key of Object.keys(buckets)) {
    const cell = getDayServiceCell(rid, key);
    if (cell?.kind === 'on_site') buckets[key].dayOnSite = true;
    if (cell?.kind === 'external') buckets[key].dayExternal = true;
  }
  return Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
}

/** @typedef {{ kind: 'on_site' | 'external'; source?: 'kaipoke_csv' | 'manual'; note?: string }} DayServiceCell */

function readDayServiceStore() {
  const raw = readJson(LS.dayServiceSchedule, { v: 1, entries: {} });
  const entries =
    raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
      ? raw.entries
      : {};
  return { v: 1, entries };
}

function writeDayServiceStore(entries) {
  writeJson(LS.dayServiceSchedule, { v: 1, entries });
}

/**
 * @param {string} residentId
 * @param {string} ymd YYYY-MM-DD
 * @returns {DayServiceCell | null}
 */
export function getDayServiceCell(residentId, ymd) {
  const id = String(residentId ?? '').trim();
  const y = String(ymd ?? '').trim();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return null;
  const { entries } = readDayServiceStore();
  const row = entries[id];
  if (!row || typeof row !== 'object') return null;
  const c = row[y];
  if (!c || typeof c !== 'object') return null;
  const kind = c.kind === 'external' ? 'external' : c.kind === 'on_site' ? 'on_site' : null;
  if (!kind) return null;
  /** @type {DayServiceCell} */
  const out = { kind };
  if (c.source === 'kaipoke_csv' || c.source === 'manual') out.source = c.source;
  const n = String(c.note ?? '').trim();
  if (n) out.note = n;
  return out;
}

/**
 * @param {string} residentId
 * @param {string} ymd YYYY-MM-DD
 * @param {DayServiceCell | null | undefined} cell null で削除
 */
export function setDayServiceCell(residentId, ymd, cell) {
  const id = String(residentId ?? '').trim();
  const y = String(ymd ?? '').trim();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return;
  const store = readDayServiceStore();
  const entries = { ...store.entries };
  const prevRow = entries[id] && typeof entries[id] === 'object' ? { ...entries[id] } : {};
  if (cell == null) {
    delete prevRow[y];
    if (Object.keys(prevRow).length === 0) delete entries[id];
    else entries[id] = prevRow;
  } else {
    const kind = cell.kind === 'external' ? 'external' : 'on_site';
    /** @type {Record<string, unknown>} */
    const out = { kind };
    if (cell.source === 'kaipoke_csv' || cell.source === 'manual') out.source = cell.source;
    const n = String(cell.note ?? '').trim();
    if (n) out.note = n;
    entries[id] = { ...prevRow, [y]: out };
  }
  writeDayServiceStore(entries);
}

const CARE_EVENT_TYPE_JA = Object.freeze({
  patrol: '巡視',
  meal: '食事',
  excretion: '排泄',
  vital_snapshot: 'バイタル',
  enteral: '経管栄養',
  fluid_intake: '水分',
});

/** @param {string} iso */
function careEventShortTs(iso) {
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso ?? '');
  }
}

/** @param {Record<string, unknown>} m */
function formatVitalMetaLine(m) {
  const parts = [];
  if (m.temp != null && String(m.temp).trim() !== '') parts.push(`体温 ${String(m.temp).trim()}℃`);
  if (m.bpUpper != null && String(m.bpUpper).trim() !== '')
    parts.push(
      `血圧 ${String(m.bpUpper).trim()}/${String(m.bpLower ?? '').trim() || '—'}`
    );
  if (m.pulse != null && String(m.pulse).trim() !== '') parts.push(`脈拍 ${String(m.pulse).trim()}`);
  if (m.spo2 != null && String(m.spo2).trim() !== '') parts.push(`SpO2 ${String(m.spo2).trim()}%`);
  if (m.weight != null && String(m.weight).trim() !== '') parts.push(`体重 ${String(m.weight).trim()}kg`);
  if (String(m.handwrittenMemo ?? '').trim()) parts.push('手書きメモあり');
  return parts.length ? parts.join('、') : '（数値なし）';
}

/** @param {{ type?: string; ts?: string; meta?: Record<string, unknown> }} e */
function formatCareEventOneLine(e) {
  const tj = CARE_EVENT_TYPE_JA[e.type] ?? String(e.type ?? '記録');
  const m = e.meta ?? {};
  if (e.type === 'vital_snapshot') return `${careEventShortTs(e.ts)} ${tj}: ${formatVitalMetaLine(m)}`;
  if (e.type === 'excretion') {
    const u = String(m.urineVolume ?? '').trim();
    const sv = String(m.stoolVolume ?? '').trim();
    const sc = String(m.stoolCharacter ?? '').trim();
    const tg = Boolean(m.toiletGuidance);
    if (u || sv || sc || tg) {
      const parts = [];
      if (u) parts.push(`尿量 ${u}`);
      if (sv) parts.push(`便量 ${sv}`);
      if (sc) parts.push(`性状 ${sc}`);
      if (tg) parts.push('トイレ誘導');
      return `${careEventShortTs(e.ts)} ${tj}: ${parts.join(' ')}`;
    }
  }
  if (e.type === 'fluid_intake') {
    const wm = String(m.waterMl ?? '').trim();
    if (wm) return `${careEventShortTs(e.ts)} ${tj}: ${wm}ml`;
  }
  if (e.type === 'meal') {
    const slot = String(m.mealSlot ?? '').trim();
    const amt = String(m.mealAmount ?? '').trim();
    const wm = String(m.waterMl ?? '').trim();
    const med = m.medicationTaken;
    if (slot || amt || wm || med === 'yes' || med === 'no') {
      const parts = [];
      if (slot) parts.push(slot);
      if (amt) parts.push(`量 ${amt}`);
      if (wm) parts.push(`水分 ${wm}ml`);
      if (med === 'yes') parts.push('内服 飲了');
      else if (med === 'no') parts.push('内服 未服');
      return `${careEventShortTs(e.ts)} ${tj}: ${parts.join(' ')}`;
    }
  }
  if (m.note) return `${careEventShortTs(e.ts)} ${tj}: ${String(m.note)}`;
  if (m.mealValue != null && String(m.mealValue).trim() !== '') {
    const mt = String(m.mealTime ?? '').trim();
    return `${careEventShortTs(e.ts)} ${tj}: ${[mt, `${String(m.mealValue).trim()}割`].filter(Boolean).join(' ')}`;
  }
  if (m.stool != null && String(m.stool).trim() !== '')
    return `${careEventShortTs(e.ts)} ${tj}: ${String(m.stool)}`;
  return `${careEventShortTs(e.ts)} ${tj}`;
}

/**
 * 救急搬送サマリー下段4欄を、localStorage のケアイベント・バイタル・名簿から組み立てる
 * @param {Record<string, unknown>} resident
 * @param {string} [facilitySheetTitle] 突合参考（現状は利用者ID中心で抽出）
 * @param {string} [linkKey] 施設の看護指示取得用（carelinkFacilities.linkKey）
 * @returns {{ dailyLife: string; nurseProblems: string; nurseContent: string; careNotes: string }}
 */
export function buildEmergencySummaryNarrativeFromRecords(resident, facilitySheetTitle = '', linkKey = '') {
  const id = String(resident?.id ?? '');
  const cond = String(resident?.condition ?? '').trim() || '—';
  const lastStoolCell = String(resident?.lastStoolDate ?? '').trim() || '—';
  const contact = id ? getEmergencyContact(id) : { name: '（未登録）', tel: '—', relation: '—' };
  const facHint = String(facilitySheetTitle ?? '').trim();

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600000;

  const evalResult = id ? evaluateResidentMonitor(resident) : null;
  const buckets = id ? getWeekCalendarBuckets(id) : [];

  const lifeEvents = id
    ? getAllCareEvents().filter(
        (e) =>
          String(e.residentId) === id &&
          ['patrol', 'meal', 'excretion', 'enteral', 'fluid_intake'].includes(String(e.type)) &&
          new Date(e.ts).getTime() >= weekAgo
      )
    : [];
  lifeEvents.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const dailyLines = [];
  dailyLines.push(`【主疾患・状態（名簿）】${cond}`);
  dailyLines.push(`【名簿の排便欄】${lastStoolCell}`);
  if (facHint) dailyLines.push(`【参照タブ】${facHint}`);

  const bucketLines = [];
  for (const b of buckets) {
    const sum = b.patrol + b.meal + b.excretion;
    const noteStr = Array.isArray(b.notes) && b.notes.length ? ` メモ: ${[...new Set(b.notes)].join(' / ')}` : '';
    if (sum > 0 || noteStr)
      bucketLines.push(`${b.date} 巡視${b.patrol}・食事${b.meal}・排泄${b.excretion}${noteStr}`);
  }
  if (bucketLines.length) {
    dailyLines.push('【直近7日・提供記録件数（この端末に保存されたログ）】');
    dailyLines.push(...bucketLines);
  } else {
    dailyLines.push(
      '【直近7日・提供記録】この端末に保存された巡視・食事・排泄の件数ログはまだありません。'
    );
  }

  if (lifeEvents.length) {
    dailyLines.push('【直近の巡視・食事・排泄ログ（最大12件・新しい順）】');
    for (const e of lifeEvents.slice(0, 12)) dailyLines.push(`・${formatCareEventOneLine(e)}`);
  }

  const problemLines = [];
  if (evalResult) {
    if (evalResult.vitalBad && evalResult.vitalFlags.length) {
      problemLines.push('【バイタル自動検知】');
      for (const f of evalResult.vitalFlags) problemLines.push(`・${f.label}`);
    }
    if (evalResult.stoolBad) {
      const h = evalResult.stoolHours;
      problemLines.push(
        `【排便】最終排便から約 ${h != null ? Math.round(h) : '?'} 時間（${VITAL_THRESHOLDS.stoolHoursMax}時間超でフラグ）`
      );
    }
    if (evalResult.urineBad) {
      const uh = evalResult.urineHours;
      problemLines.push(
        `【排尿】最終排尿記録・トイレ誘導から約 ${uh != null ? Math.round(uh) : '?'} 時間（${VITAL_THRESHOLDS.urineHoursMax}時間超でフラグ）`
      );
    }
    if (evalResult.patrolBad) {
      const pm = Number(resident?.patrolIntervalMinutes);
      problemLines.push(`【巡視間隔】名簿ベース約 ${Number.isFinite(pm) ? pm : '—'} 分（要確認の目安）`);
    }
  }
  if (!problemLines.length)
    problemLines.push(
      '（直近のバイタル入力・排便・排尿の記録間隔から、システム上の明確な異常フラグはありません。臨床判断は担当者が行ってください。）'
    );

  const snap = id ? getResidentVitalSnapshot(id) : null;
  const vitalLog = id ? getWeeklyVitalTimeline(id).slice(-5) : [];
  const contentLines = [];
  contentLines.push('【緊急連絡先】');
  contentLines.push(
    `${String(contact.name ?? '')}（${String(contact.relation ?? '')}）${String(contact.tel ?? '')}`
  );
  contentLines.push('');
  contentLines.push('【現在のバイタル（最新入力値）】');
  if (snap && (snap.temp || snap.bpUpper || snap.pulse || snap.spo2 || snap.weight)) {
    contentLines.push(formatVitalMetaLine(/** @type {Record<string, unknown>} */ (snap)));
    if (snap.updatedAt) contentLines.push(`（更新: ${careEventShortTs(snap.updatedAt)}）`);
  } else {
    contentLines.push('（未入力）');
  }
  if (vitalLog.length) {
    contentLines.push('');
    contentLines.push('【直近のバイタル記録ログ（最大5件）】');
    for (const e of vitalLog) contentLines.push(`・${formatCareEventOneLine(e)}`);
  }

  const careLines = [];
  if (evalResult) {
    const adv = fallbackRegulatoryAdvice(evalResult);
    if (adv && !/^【システム】/.test(adv)) {
      careLines.push('【記録・連携上の配慮（自動検知に基づく参考）】');
      careLines.push(adv);
    }
  }
  const nDir = String(linkKey ?? '').trim() ? getNursingDirectives(String(linkKey)) : [];
  const recentN = Array.isArray(nDir) ? nDir.slice(0, 5) : [];
  if (recentN.length) {
    if (careLines.length) careLines.push('');
    careLines.push('【施設の看護指示メモ（直近・参考）】');
    for (const row of recentN) {
      const tx = String(row?.text ?? '').trim();
      if (tx) careLines.push(`・${tx}`);
    }
  }
  if (!careLines.length)
    careLines.push(
      '（看護指示メモの登録がなく、自動検知に基づく特記もありません。個別の注意事項があれば追記してください。）'
    );

  return {
    dailyLife: dailyLines.join('\n').trim(),
    nurseProblems: problemLines.join('\n').trim(),
    nurseContent: contentLines.join('\n').trim(),
    careNotes: careLines.join('\n').trim(),
  };
}

/**
 * 月次家族向け報告用AIプロンプトに埋め込むテキスト（同一ブラウザの記録）
 * @param {Record<string, unknown>} resident
 * @param {string} yearMonth YYYY-MM
 */
export function buildMonthlyResidentReportContextForAi(resident, yearMonth) {
  const id = String(resident?.id ?? '');
  const ym = String(yearMonth ?? '').trim();
  const events = id && ym ? getCareEventsForResidentMonth(id, ym) : [];
  const c = { patrol: 0, meal: 0, excretion: 0, vital_snapshot: 0, other: 0 };
  for (const e of events) {
    const t = e.type;
    if (t === 'patrol') c.patrol++;
    else if (t === 'meal') c.meal++;
    else if (t === 'excretion') c.excretion++;
    else if (t === 'vital_snapshot') c.vital_snapshot++;
    else c.other++;
  }
  const snap = id ? getResidentVitalSnapshot(id) : null;
  const evalR = id ? evaluateResidentMonitor(resident) : null;
  const contact = id ? getEmergencyContact(id) : null;
  const lk = nursingLinkKeyForResident(resident);
  const nDir = lk ? getNursingDirectives(lk).slice(0, 10) : [];
  const nursingLines = nDir.map((row) => String(row?.text ?? '').trim()).filter(Boolean);

  const excerpt = events
    .slice(-45)
    .map((e) => formatCareEventOneLine(/** @type {{ type?: string; ts?: string; meta?: Record<string, unknown> }} */ (e)))
    .join('\n');

  const lines = [];
  lines.push(`【対象月】${ym}`);
  lines.push(
    `【利用者】氏名: ${String(resident?.name ?? '')} / 居室: ${String(resident?.room ?? '')} / 主疾患・状態(名簿): ${String(resident?.condition ?? '—')}`
  );
  lines.push(
    `【施設・出所】facility列: ${String(resident?.facility ?? '—')} / 読込タブ: ${String(resident?.sourceSheetTitle ?? '—')}`
  );
  lines.push(
    `【当月記録件数（この端末）】巡視 ${c.patrol} / 食事 ${c.meal} / 排泄 ${c.excretion} / バイタル ${c.vital_snapshot} / その他 ${c.other} / 合計 ${events.length}`
  );
  if (snap && (snap.temp || snap.bpUpper || snap.pulse)) {
    lines.push(`【最新バイタル（入力済み）】${formatVitalMetaLine(/** @type {Record<string, unknown>} */ (snap))}`);
  }
  if (evalR) {
    lines.push(
      `【自動検知参考】バイタル注意: ${evalR.vitalBad ? evalR.vitalFlags.map((f) => f.label).join('、') : 'なし'} / 排便遅延: ${evalR.stoolBad ? `約${evalR.stoolHours != null ? Math.round(evalR.stoolHours) : '?'}h` : 'なし'} / 排尿間隔: ${evalR.urineBad ? `約${evalR.urineHours != null ? Math.round(evalR.urineHours) : '?'}h` : 'なし'}`
    );
  }
  lines.push(`【名簿の排便欄】${String(resident?.lastStoolDate ?? '—')}`);
  if (contact) {
    lines.push(
      `【緊急連絡先（登録値）】${String(contact.name ?? '')}（${String(contact.relation ?? '')}）${String(contact.tel ?? '')}`
    );
  }
  if (nursingLines.length) {
    lines.push('【施設の看護指示メモ（抜粋）】');
    nursingLines.forEach((t) => lines.push(`・${t}`));
  }
  lines.push('【当月のケアログ抜粋（時系列・最大45件）】');
  lines.push(excerpt || '（ログなし。クイック記録等が未登録の月です。）');
  const imp = id && ym ? getResidentMonthlyReportImportLines(id, ym) : [];
  if (imp.length) {
    lines.push('【カイポケ等から取り込んだ当月のサービス記録（帳票CSV・この端末）】');
    for (const t of imp.slice(0, 60)) lines.push(`・${t}`);
  }
  return lines.join('\n');
}

const MAX_MONTHLY_IMPORT_LINES_PER_RESIDENT = 80;
const MAX_MEDICATION_LINES_PER_RESIDENT = 120;

/**
 * 月次報告用：取り込んだカイポケ等の行（短文）を取得
 * @param {string} residentId
 * @param {string} yearMonth YYYY-MM
 * @returns {string[]}
 */
export function getResidentMonthlyReportImportLines(residentId, yearMonth) {
  const ym = String(yearMonth ?? '').trim();
  const id = String(residentId ?? '').trim();
  if (!ym || !id) return [];
  const all = readJson(LS.monthlyReportImportLines, {});
  const bucket = all[ym];
  if (!bucket || typeof bucket !== 'object') return [];
  const arr = bucket[id];
  return Array.isArray(arr) ? arr.map((s) => String(s ?? '').trim()).filter(Boolean) : [];
}

/**
 * 月次報告用：取り込み行を保存（同一利用者・月は上書き）
 * @param {string} residentId
 * @param {string} yearMonth YYYY-MM
 * @param {string[]} lines
 */
export function setResidentMonthlyReportImportLines(residentId, yearMonth, lines) {
  const ym = String(yearMonth ?? '').trim();
  const id = String(residentId ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym) || !id) return;
  const all = readJson(LS.monthlyReportImportLines, {});
  if (!all[ym] || typeof all[ym] !== 'object') all[ym] = {};
  const trimmed = (Array.isArray(lines) ? lines : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(-MAX_MONTHLY_IMPORT_LINES_PER_RESIDENT);
  all[ym][id] = trimmed;
  writeJson(LS.monthlyReportImportLines, all);
}

/**
 * 利用者の薬情報（薬局PDFから抽出）を取得
 * @param {string} residentId
 * @returns {{ patientName?: string; dispensedOn?: string; medicines?: string[]; sourceFiles?: string[]; importedAt?: string } | null}
 */
export function getResidentMedicationProfile(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return null;
  const all = readJson(LS.residentMedicationProfile, {});
  const row = all?.[id];
  if (!row || typeof row !== 'object') return null;
  const meds = Array.isArray(row.medicines)
    ? row.medicines.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, MAX_MEDICATION_LINES_PER_RESIDENT)
    : [];
  const files = Array.isArray(row.sourceFiles)
    ? row.sourceFiles.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    patientName: String(row.patientName ?? '').trim(),
    dispensedOn: String(row.dispensedOn ?? '').trim(),
    medicines: meds,
    sourceFiles: files,
    importedAt: String(row.importedAt ?? '').trim(),
  };
}

/**
 * 利用者の薬情報（薬局PDFから抽出）を保存
 * @param {string} residentId
 * @param {{ patientName?: string; dispensedOn?: string; medicines?: string[]; sourceFiles?: string[]; importedAt?: string } | null | undefined} profile
 */
export function setResidentMedicationProfile(residentId, profile) {
  const id = String(residentId ?? '').trim();
  if (!id) return;
  const all = readJson(LS.residentMedicationProfile, {});
  if (profile == null) {
    if (all && typeof all === 'object' && all[id] !== undefined) {
      delete all[id];
      writeJson(LS.residentMedicationProfile, all);
    }
    return;
  }
  const meds = (Array.isArray(profile.medicines) ? profile.medicines : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_MEDICATION_LINES_PER_RESIDENT);
  const files = (Array.isArray(profile.sourceFiles) ? profile.sourceFiles : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, 20);
  all[id] = {
    patientName: String(profile.patientName ?? '').trim(),
    dispensedOn: String(profile.dispensedOn ?? '').trim(),
    medicines: meds,
    sourceFiles: files,
    importedAt: String(profile.importedAt ?? nowJapanIsoString()).trim() || nowJapanIsoString(),
  };
  writeJson(LS.residentMedicationProfile, all);
}

/**
 * Record カード用の周囲事項（職員手入力・手書き）。名簿の condition とは独立。
 * @param {string} residentId
 * @returns {{ text: string; handwritingDataUrl: string }}
 */
export function getResidentSurroundMemo(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return { text: '', handwritingDataUrl: '' };
  const all = readJson(LS.residentSurroundMemo, {});
  const row = all?.[id];
  if (!row || typeof row !== 'object') return { text: '', handwritingDataUrl: '' };
  return {
    text: String(row.text ?? ''),
    handwritingDataUrl: String(row.handwritingDataUrl ?? '').trim(),
  };
}

/**
 * @param {string} residentId
 * @param {{ text?: string; handwritingDataUrl?: string }} partial
 */
export function updateResidentSurroundMemo(residentId, partial) {
  const id = String(residentId ?? '').trim();
  if (!id || !partial || typeof partial !== 'object') return;
  const cur = getResidentSurroundMemo(id);
  const next = {
    text: partial.text !== undefined ? String(partial.text) : cur.text,
    handwritingDataUrl:
      partial.handwritingDataUrl !== undefined ? String(partial.handwritingDataUrl) : cur.handwritingDataUrl,
  };
  const t = next.text.trim();
  const h = String(next.handwritingDataUrl ?? '').trim();
  const all = readJson(LS.residentSurroundMemo, {});
  if (!t && !h) {
    if (all && typeof all === 'object' && all[id] !== undefined) {
      delete all[id];
      writeJson(LS.residentSurroundMemo, all);
    }
    return;
  }
  all[id] = {
    text: next.text,
    handwritingDataUrl: h,
  };
  writeJson(LS.residentSurroundMemo, all);
}

function stripJsonFence(text) {
  const t = text.trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/im.exec(t);
  return m ? m[1].trim() : t;
}

/**
 * 1か月の記録を参照し、家族向け月次報告の3文案を Gemini で生成
 * @param {string} apiKey
 * @param {Record<string, unknown>} resident
 * @param {string} yearMonth YYYY-MM
 * @returns {Promise<{ monthlyCondition: string; futureCarePoints: string; directorMessage: string }>}
 */
export async function fetchMonthlyResidentFamilyReportAi(apiKey, resident, yearMonth) {
  if (!apiKey?.trim()) throw new Error('VITE_GEMINI_API_KEY が未設定です。');
  const ym = String(yearMonth ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('対象月が不正です。');
  const ctx = buildMonthlyResidentReportContextForAi(resident, ym);
  const [yy, mm] = ym.split('-');
  const mNum = parseInt(mm, 10) || 1;
  const monthSeasonHint =
    mNum >= 3 && mNum <= 5
      ? '春（新緑の季節）'
      : mNum >= 6 && mNum <= 8
        ? '夏（暑さ・水分補給）'
        : mNum >= 9 && mNum <= 11
          ? '秋（季節の変化・感染症に注意）'
          : '冬（寒暖差・体調管理）';

  const prompt = `あなたは有料老人ホームの施設長です。次の「根拠データ」は同一ブラウザに保存された提供記録ログと名簿情報です。主な読者は「ご家族」と「担当ケアマネジャー」です。専門用語は使いすぎず、お手紙のように分かりやすく。データに書かれていないことは推測で補わず、不足時は「記録上は詳しく分かりません」などと明記してください。断定のない推測は「～の可能性」と書いてください。

【対象月の季節感】${yy}年${mNum}月（${monthSeasonHint}）— 冒頭で季節の一言（生活・体調への目配り）を1文程度入れてもよいです。無理に入れないでください。

【根拠データ】
${ctx}

根拠データに「カイポケ等から取り込んだ当月のサービス記録」が含まれる場合は、月次の様子の説明に織り込んでもよいですが、他の記録と矛盾する断定は避け、出典が取り込みCSVであることが分かる程度に留めてください。

【出力】
次のキーを持つJSONオブジェクト1つだけを返してください（説明文・Markdownのフェンス禁止）。各値は日本語の敬体（です・ます調）の文章です。
- monthlyCondition: 「1か月のようす」（家族向け。220～650字。バイタル・食事・排泄・巡視の記録の傾向が想像できる具体さ。前向きな言い回しを心がける。ケアマネがケアプランの参考にしやすい事実を混ぜてもよい）
- futureCarePoints: 「今後一緒に大切にしたいこと」（100～420字。安全・栄養・医療連携。ご家族と施設の協力のイメージが持てる温度感）
- directorMessage: 「施設からのひとこと」（50～200字。感謝や応援、季節の挨拶をひとふさでも可）

記録件数が0に近い月は、冒頭で「この月は端末への記録が少なく」旨を述べ、一般論にとどまると明記してください。`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.35, maxOutputTokens: 4096 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!res.ok || !text) {
    const msg = String(data?.error?.message ?? '');
    if (isGeminiQuotaMessage(msg)) {
      return {
        monthlyCondition:
          '（API 利用上限のため自動文面を作成できませんでした。下記の「施設内の声かけのイメージ」を参考に、手元の記録とあわせて手入力でご記入ください。）',
        futureCarePoints: '',
        directorMessage: '',
      };
    }
    throw new Error(msg || 'AI応答なし');
  }
  const raw = stripJsonFence(text);
  try {
    const parsed = JSON.parse(raw);
    return {
      monthlyCondition: String(parsed.monthlyCondition ?? '').trim(),
      futureCarePoints: String(parsed.futureCarePoints ?? '').trim(),
      directorMessage: String(parsed.directorMessage ?? '').trim(),
    };
  } catch {
    throw new Error('AIのJSONを解釈できませんでした。もう一度お試しください。');
  }
}

/** ルールベース即時アドバイス */
export function fallbackRegulatoryAdvice(evalResult) {
  const lines = [];
  if (evalResult.vitalBad) {
    for (const f of evalResult.vitalFlags) {
      if (f.code === 'fever')
        lines.push('【実務】発熱傾向: 再測定・水分・主治医／看護報告を検討（感染・脱水の観察記録を残す）。');
      if (f.code === 'bp_sys_high')
        lines.push('【実務】収縮期血圧高値: 安静後再測、服薬確認、閾値超過時は医療報告（報酬上も安全配慮の記録が重要）。');
      if (f.code === 'bp_dia_low')
        lines.push('【実務】拡張期血圧低値: めまい・失神の有無、脱水・服薬の確認、必要に応じ受診連絡。');
    }
  }
  if (evalResult.stoolBad) {
    lines.push(
      '【実務】排便遅延（72h超）: 腹部症状の観察、医師・看護へ報告。下剤は指示に基づき実施し結果を記録（褥瘡・腸閉塞リスク）。'
    );
  }
  if (evalResult.urineBad) {
    lines.push(
      `【実務】排尿の記録・トイレ誘導の間隔が空きすぎています（目安${VITAL_THRESHOLDS.urineHoursMax}時間超）。尿閉・尿路感染・転倒リスクの観察、必要に応じて医療・看護へ相談してください。`
    );
  }
  if (!lines.length) return '【システム】該当する自動アラートに紐づく定型アドバイスはありません。';
  return lines.join('\n');
}

/**
 * @param {string} apiKey
 * @param {ReturnType<typeof evaluateResidentMonitor>} evalResult
 * @param {Record<string, unknown>} resident
 */
export async function fetchAiRegulatoryAdvice(apiKey, evalResult, resident) {
  if (!apiKey?.trim()) return fallbackRegulatoryAdvice(evalResult);
  const prompt = `あなたは介護・看護の監査アドバイザーです。次の知識のみを根拠に、簡潔に日本語で答えてください（3〜6行）。

【参照知識】
${REGULATORY_KNOWLEDGE_BASE}

【ケース】
利用者: ${resident.name} / 居室 ${resident.room}
異常: ${JSON.stringify({
    vitalFlags: evalResult.vitalFlags,
    stoolBad: evalResult.stoolBad,
    stoolHours: evalResult.stoolHours,
    urineBad: evalResult.urineBad,
    urineHours: evalResult.urineHours,
  })}
最新バイタル保存値: ${JSON.stringify(evalResult.snapshot ?? {})}

上記に対し、下剤検討・主治医報告の要否など具体的な行動を根拠付きで。`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data?.error?.message ?? 'AI応答なし');
  return stripJsonFence(text);
}

/** デモ用: 初回のみサンプルイベント・バイタル・緊急連絡先 */
export function seedDemoIfEmpty(residents) {
  if (localStorage.getItem(LS.seeded)) return;
  if (!residents?.length) return;
  const r0 = residents[0];
  const id = String(r0.id);
  setResidentVitalSnapshot(id, { temp: '37.8', bpUpper: '158', bpLower: '72' });
  setLastStoolIso(id, new Date(Date.now() - 80 * 3600000).toISOString());
  setLastUrineNow(id);
  setEmergencyContact(id, { name: '山田太郎（長男）', tel: '090-0000-0000', relation: '長男' });
  const fac = String(r0.facility ?? '');
  logCareEvent({
    type: 'patrol',
    residentId: id,
    residentName: r0.name,
    facilitySheetTitle: fac,
    meta: { note: '3時間巡視: 異常なし' },
  });
  logCareEvent({
    type: 'meal',
    residentId: id,
    residentName: r0.name,
    facilitySheetTitle: fac,
    meta: { mealValue: '8', mealTime: '昼' },
  });
  logCareEvent({
    type: 'excretion',
    residentId: id,
    residentName: r0.name,
    facilitySheetTitle: fac,
    meta: { stool: '普通量' },
  });
  logVitalSnapshot(id, String(r0.name), fac, { temp: '37.8', bpUpper: '158', bpLower: '72' });
  localStorage.setItem(LS.seeded, '1');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(s) {
  return escapeHtml(s).replace(/\n/g, '<br/>');
}

function safeEmergencyDataImageSrc(url) {
  const u = String(url ?? '').trim();
  if (!/^data:image\/jpeg;base64,/i.test(u)) return '';
  if (u.length > 2_400_000) return '';
  return u;
}

export function buildEmergencySummaryHtml(resident, evalResult, aiAdvice, contact, draft = {}) {
  const name = String(resident.name ?? '');
  const room = String(resident.room ?? '');
  const cond = String(resident.condition ?? '—');
  const surround = getResidentSurroundMemo(String(resident?.id ?? ''));
  const surroundText = String(surround.text ?? '').trim();
  const surroundImg = safeEmergencyDataImageSrc(surround.handwritingDataUrl);
  const today = new Date().toLocaleDateString('ja-JP');
  const med = getResidentMedicationProfile(String(resident?.id ?? ''));
  const week = getWeeklyVitalTimeline(String(resident.id));
  const rows = week
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(JSON.stringify(e.meta ?? {}))}</td></tr>`
    )
    .join('');
  const senderOffice = String(draft.senderOffice ?? '').trim();
  const senderAddress = String(draft.senderAddress ?? '').trim();
  const senderTel = String(draft.senderTel ?? '').trim();
  const senderNurse = String(draft.senderNurse ?? '').trim();
  const primaryDoctor = String(draft.primaryDoctor ?? '').trim();
  const medicalAgency = String(draft.medicalAgency ?? '').trim();
  const medicalAddress = String(draft.medicalAddress ?? '').trim();
  const dailyLife = String(draft.dailyLife ?? '').trim();
  const nurseProblems = String(draft.nurseProblems ?? '').trim();
  const acuteChange = String(draft.acuteChange ?? '').trim();
  const nurseContent = String(draft.nurseContent ?? '').trim();
  const careNotes = String(draft.careNotes ?? '').trim();
  const other = String(draft.other ?? '').trim();
  const medDispensedOn = String(med?.dispensedOn ?? '').trim();
  const medList = Array.isArray(med?.medicines) ? med.medicines.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  const medFiles = Array.isArray(med?.sourceFiles) ? med.sourceFiles.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  const medRows = medList.length
    ? medList.map((m, i) => `<tr><td style="width:50px">${i + 1}</td><td>${escapeHtml(m)}</td></tr>`).join('')
    : '<tr><td colspan="2">薬局PDF取り込みデータなし</td></tr>';

  return `
<!DOCTYPE html><html><head><meta charset="utf-8"/><title>救急搬送サマリー ${name}</title>
<style>
  body{font-family:system-ui,sans-serif;padding:16px;color:#111}
  h1{font-size:22px;border-bottom:2px solid #c00;padding-bottom:8px}
  h2{margin:16px 0 8px 0}
  table{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px}
  th,td{border:1px solid #ccc;padding:6px;text-align:left}
  .box{border:1px solid #333;padding:12px;margin:12px 0;background:#fafafa}
  .muted{color:#666;font-size:12px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .vtop{vertical-align:top}
  @media print { .no-print{display:none} }
</style></head><body>
  <h1>訪問看護の情報（療養に係る情報）提供書 / 救急搬送サマリー</h1>
  <div class="muted">作成日: ${escapeHtml(today)}</div>
  <div class="box">
    <div><strong>施設名</strong> ${escapeHtml(senderOffice || '（未入力）')}</div>
    <div><strong>住所</strong> ${escapeHtml(senderAddress || '（未入力）')}</div>
    <div><strong>電話</strong> ${escapeHtml(senderTel || '（未入力）')} &nbsp; <strong>担当看護師</strong> ${escapeHtml(senderNurse || '（未入力）')}</div>
  </div>
  <div class="box">
    <strong>氏名</strong> ${escapeHtml(name)} 様 &nbsp; <strong>居室</strong> ${escapeHtml(room)}<br/>
    <strong>主疾患/状態（名簿）</strong> ${escapeHtml(cond)}<br/>
    ${
      surroundText || surroundImg
        ? `<strong>周囲事項（カード手入力）</strong><br/>${
            surroundText ? nl2br(surroundText) : ''
          }${
            surroundImg
              ? `${surroundText ? '<br/>' : ''}<img src="${surroundImg}" alt="手書き周囲事項" style="max-width:100%;max-height:240px;border:1px solid #ccc;margin-top:6px"/>`
              : ''
          }<br/>`
        : ''
    }
    <strong>緊急連絡先</strong> ${escapeHtml(contact.name)}（${escapeHtml(contact.relation)}） ${escapeHtml(contact.tel)}
  </div>
  <table>
    <tr><th style="width:160px">主治医氏名</th><td>${escapeHtml(primaryDoctor || '（未入力）')}</td></tr>
    <tr><th>医療機関名</th><td>${escapeHtml(medicalAgency || '（未入力）')}</td></tr>
    <tr><th>所在地</th><td>${escapeHtml(medicalAddress || '（未入力）')}</td></tr>
  </table>
  <table>
    <tr><th style="width:220px">日常生活等の状況</th><td class="vtop">${nl2br(dailyLife || '（未入力）')}</td></tr>
    <tr><th>看護上の問題等</th><td class="vtop">${nl2br(nurseProblems || '（未入力）')}</td></tr>
    <tr><th>急変の内容（看護師記入）</th><td class="vtop">${nl2br(acuteChange || '（未入力）')}</td></tr>
    <tr><th>看護の内容</th><td class="vtop">${nl2br(nurseContent || '（未入力）')}</td></tr>
    <tr><th>ケア時の注意点</th><td class="vtop">${nl2br(careNotes || '（未入力）')}</td></tr>
    <tr><th>その他</th><td class="vtop">${nl2br(other || '（未入力）')}</td></tr>
  </table>
  <h2>薬情報（薬局PDF取り込み）</h2>
  <table>
    <tr><th style="width:160px">調剤日</th><td>${escapeHtml(medDispensedOn || '（未入力）')}</td></tr>
    <tr><th>取り込み元PDF</th><td>${escapeHtml(medFiles.join(' / ') || '（未入力）')}</td></tr>
  </table>
  <table><thead><tr><th style="width:50px">No.</th><th>薬剤名</th></tr></thead><tbody>${medRows}</tbody></table>
  <h2>直近1週間 バイタル記録ログ</h2>
  <table><thead><tr><th>日時</th><th>内容</th></tr></thead><tbody>${rows || '<tr><td colspan="2">記録なし（記録蓄積後に表示）</td></tr>'}</tbody></table>
  <h2>現在の自動検知</h2>
  <div class="box"><pre style="white-space:pre-wrap;margin:0">${JSON.stringify(
    {
      vitalFlags: evalResult.vitalFlags,
      stoolHours: evalResult.stoolHours,
      stoolBad: evalResult.stoolBad,
      urineHours: evalResult.urineHours,
      urineBad: evalResult.urineBad,
    },
    null,
    2
  )}</pre></div>
  <h2>AIアドバイス（参考）</h2>
  <div class="box"><pre style="white-space:pre-wrap;margin:0">${escapeHtml(String(aiAdvice ?? ''))}</pre></div>
  <p class="no-print" style="margin-top:24px;font-size:12px;color:#666">ブラウザの印刷から PDF 保存可能です。</p>
</body></html>`;
}

/** 月次報告HTMLに埋め込む data URL 画像（最大4枚・不正URLは捨てる） */
function sanitizeMonthlyReportPhotoDataUrls(urls) {
  if (!Array.isArray(urls)) return [];
  return urls
    .map((u) => String(u ?? '').trim())
    .filter(
      (u) =>
        u.startsWith('data:image/jpeg') ||
        u.startsWith('data:image/jpg') ||
        u.startsWith('data:image/png') ||
        u.startsWith('data:image/webp') ||
        u.startsWith('data:image/gif')
    )
    .slice(0, 4);
}

/**
 * @param {string} yearMonth
 * @returns {{ season: string; nameJa: string; tagline: string; cardBg: string; accent: string; soft: string; art: string }}
 */
function getMonthlyReportSeasonalTheme(yearMonth) {
  const m = (() => {
    const p = String(yearMonth ?? '').match(/^\d{4}-(\d{2})/);
    return p ? parseInt(p[1], 10) : new Date().getMonth() + 1;
  })();
  if (m >= 3 && m <= 5) {
    return {
      season: 'spring',
      nameJa: '春',
      tagline: '新緑の季節。変わりやすい気候に、温かい眼差しで見守りました。',
      cardBg: 'linear-gradient(160deg, #fff7fb 0%, #fff1f5 40%, #fdf4ff 100%)',
      accent: '#be185d',
      soft: '#fce7f3',
      art: 'spring',
    };
  }
  if (m >= 6 && m <= 8) {
    return {
      season: 'summer',
      nameJa: '夏',
      tagline: '日差しの季節。暑さに負けず、水まわりと栄養に気を配りました。',
      cardBg: 'linear-gradient(160deg, #f0fdfa 0%, #e0f2fe 50%, #f0f9ff 100%)',
      accent: '#0d9488',
      soft: '#ccfbf1',
      art: 'summer',
    };
  }
  if (m >= 9 && m <= 11) {
    return {
      season: 'autumn',
      nameJa: '秋',
      tagline: '穏やかに季節が深まる頃。体調の揺らぎにも寄り添いながら過ごされました。',
      cardBg: 'linear-gradient(160deg, #fffbeb 0%, #ffedd5 45%, #fff7ed 100%)',
      accent: '#c2410c',
      soft: '#ffedd5',
      art: 'autumn',
    };
  }
  return {
    season: 'winter',
    nameJa: '冬',
    tagline: '寒さが身にしみる季節。心とからだの温もりに気を配りながらお過ごしです。',
    cardBg: 'linear-gradient(160deg, #f8fafc 0%, #e0f2fe 50%, #f1f5f9 100%)',
    accent: '#1d4ed8',
    soft: '#dbeafe',
    art: 'winter',
  };
}

/** 季節の小さな装飾（印刷・オフラインでも破綻しない簡易SVG） */
function monthlyReportSeasonArt(kind) {
  if (kind === 'spring') {
    return `<svg class="se-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 64" width="180" height="64" role="img" aria-label="春の装飾" focusable="false">
      <rect width="180" height="64" fill="none"/>
      <circle cx="32" cy="32" r="4" fill="#f472b6"/><circle cx="32" cy="20" r="3.2" fill="#f9a8d4"/><circle cx="44" cy="26" r="3" fill="#fda4af"/><circle cx="20" cy="28" r="2.8" fill="#fbbf24"/>
      <text x="58" y="30" font-family="system-ui,sans-serif" font-size="11" fill="#9d174d" font-weight="800">桜咲く季節</text>
      <text x="58" y="46" font-family="system-ui,sans-serif" font-size="8.5" fill="#be185d" opacity="0.85">家族・ケアマネ様と共有する1か月の記録</text>
    </svg>`;
  }
  if (kind === 'summer') {
    return `<svg class="se-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 64" width="180" height="64" role="img" aria-label="夏の装飾" focusable="false">
      <rect width="180" height="64" fill="none"/>
      <circle cx="32" cy="32" r="12" fill="#fbbf24" stroke="#f59e0b" stroke-width="1.5"/>
      <text x="58" y="30" font-family="system-ui,sans-serif" font-size="11" fill="#0f766e" font-weight="800">陽ざしの季節</text>
      <text x="58" y="46" font-family="system-ui,sans-serif" font-size="8.5" fill="#0d9488" opacity="0.9">水分補給を意識した1か月の記録</text>
    </svg>`;
  }
  if (kind === 'autumn') {
    return `<svg class="se-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 64" width="180" height="64" role="img" aria-label="秋の装飾" focusable="false">
      <rect width="180" height="64" fill="none"/>
      <path d="M20 40 L32 20 L40 40 Z" fill="#f97316"/><path d="M12 40 L30 12 L50 40 Z" fill="#ea580c" opacity="0.85"/>
      <text x="60" y="30" font-family="system-ui,sans-serif" font-size="11" fill="#9a3412" font-weight="800">実りの季節</text>
      <text x="60" y="46" font-family="system-ui,sans-serif" font-size="8.5" fill="#c2410c" opacity="0.9">季節の移ろいに寄り添う1か月</text>
    </svg>`;
  }
  return `<svg class="se-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 64" width="180" height="64" role="img" aria-label="冬の装飾" focusable="false">
    <rect width="180" height="64" fill="none"/>
    <path d="M20 20 L20 40 M10 30 L30 30 M20 20 L10 10 M20 20 L30 10 M20 40 L10 50 M20 40 L30 50" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
    <text x="42" y="30" font-family="system-ui,sans-serif" font-size="11" fill="#1d4ed8" font-weight="800">凍空の季節</text>
    <text x="42" y="46" font-family="system-ui,sans-serif" font-size="8.5" fill="#1e40af" opacity="0.9">体調管理に心を合わせた1か月</text>
  </svg>`;
}

/**
 * 月次家族向け報告（印刷用HTML：家族・ケアマネ向け・季節感・装飾・施設写真）
 * @param {Record<string, unknown>} resident
 * @param {string} yearMonth YYYY-MM
 * @param {{ monthlyCondition?: string; futureCarePoints?: string; directorMessage?: string }} draft
 * @param {{ photoDataUrls?: string[]; facilityLabel?: string; photoCaption?: string; seasonArtMode?: 'auto'|'none'|'spring'|'summer'|'autumn'|'winter'; kaipokeSupplementLines?: string[] }} [opts] photoDataUrls は data:image/* の配列。kaipokeSupplementLines 省略時は monthlyReportImportLines を参照
 */
export function buildMonthlyFamilyReportHtml(resident, yearMonth, draft = {}, opts = {}) {
  const name = String(resident?.name ?? '');
  const room = String(resident?.room ?? '');
  const ym = String(yearMonth ?? '');
  const today = new Date().toLocaleDateString('ja-JP');
  const monthlyCondition = String(draft.monthlyCondition ?? '').trim();
  const futureCarePoints = String(draft.futureCarePoints ?? '').trim();
  const directorMessage = String(draft.directorMessage ?? '').trim();
  const facility = String(
    opts.facilityLabel ?? resident?.facility ?? resident?.sourceSheetTitle ?? ''
  ).trim();
  const photoCaption = String(opts?.photoCaption ?? '施設での様子（選べる写真）').trim();
  const photos = sanitizeMonthlyReportPhotoDataUrls(opts?.photoDataUrls);
  const theme = getMonthlyReportSeasonalTheme(ym);
  const artModeRaw = String(opts?.seasonArtMode ?? 'auto').trim().toLowerCase();
  const resolvedArtKind =
    artModeRaw === 'none'
      ? ''
      : artModeRaw === 'spring' || artModeRaw === 'summer' || artModeRaw === 'autumn' || artModeRaw === 'winter'
        ? artModeRaw
        : theme.art;
  const facilityHeadline = facility ? `${facility} からのおたより` : '施設からのおたより';
  const yLabel = (() => {
    const p = ym.match(/^(\d{4})-(\d{1,2})/);
    if (!p) return ym;
    return `${p[1]}年${String(parseInt(p[2], 10))}月`;
  })();
  const supplementLines = Array.isArray(opts.kaipokeSupplementLines)
    ? opts.kaipokeSupplementLines.filter((s) => String(s ?? '').trim())
    : getResidentMonthlyReportImportLines(String(resident?.id ?? ''), ym);
  const supplementBlock =
    supplementLines.length === 0
      ? ''
      : `<h2><span class="n">＋</span> 取り込んだ記録（当月・カイポケ等CSV）</h2>
  <ul class="imp-ul">${supplementLines
    .map((t) => `<li>${escapeHtml(String(t))}</li>`)
    .join('')}
  </ul>`;

  const photoBlock =
    photos.length === 0
      ? ''
      : `<div class="photo-sec" style="--photo-accent:${theme.accent};">
  <h2 class="photo-h2">📷 ${escapeHtml(photoCaption)}</h2>
  <div class="photo-grid">
    ${photos
      .map(
        (u, i) =>
          `<figure class="ph">
      <img src=${JSON.stringify(u)} alt="施設の写真${i + 1}" class="ph-img" loading="lazy" />
     </figure>`
      )
      .join('')}
  </div>
  <p class="photo-hint">※ 印刷・PDF 保存のとき、写真もこのページに一緒に出ます。ブラウザ上で選んだ画像は、保存した HTML ファイル内に埋め込まれます。</p>
</div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>月次のごあいさつ ${escapeHtml(name)} 様</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@400;700&display=swap" rel="stylesheet"/>
  <style>
    :root { --accent: ${theme.accent}; --soft: ${theme.soft}; }
    body { font-family: "Zen Maru Gothic", "Hiragino Sans", "Yu Gothic UI", "Meiryo", system-ui, sans-serif; padding: 0; color: #1e293b; max-width: 800px; margin: 0 auto; line-height: 1.85; background: ${theme.cardBg}; }
    .sheet { margin: 16px; border-radius: 20px; background: rgba(255,255,255,0.92); box-shadow: 0 8px 32px rgba(15, 23, 42, 0.08), 0 0 0 1px rgba(15, 23, 42, 0.04); overflow: hidden; }
    .band { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 22px; background: linear-gradient(90deg, var(--soft) 0%, #fff 55%); border-bottom: 3px solid var(--accent); }
    .band-ttl { min-width: 0; }
    h1 { font-size: 1.5rem; margin: 0 0 4px; color: #0f172a; font-weight: 800; letter-spacing: 0.04em; }
    .deco-line { color: #64748b; font-size: 0.8rem; font-weight: 700; margin: 0; }
    .se-art { max-width: 100%; height: auto; }
    .badge { display: inline-block; background: var(--accent); color: #fff; font-size: 0.72rem; font-weight: 800; padding: 4px 10px; border-radius: 9999px; letter-spacing: 0.06em; }
    .meta { color: #64748b; font-size: 0.8rem; margin: 0; font-weight: 600; }
    .lede { padding: 0 24px; margin: 0; font-size: 0.85rem; color: #475569; font-weight: 700; border-left: 4px solid var(--accent); background: #fff9; }
    .lede p { margin: 12px 0; }
    h2 { font-size: 1.05rem; margin: 22px 0 0; color: #0f172a; display: flex; align-items: center; gap: 8px; font-weight: 800; }
    h2 .n { display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border-radius: 9999px; background: var(--accent); color: #fff; font-size: 0.7rem; }
    .box { border: 1.5px solid #e2e8f0; border-radius: 16px; padding: 16px 18px; margin: 10px 0 0; background: #fcfcff; }
    .to-whom { margin: 18px 20px 0; padding: 12px 16px; border-radius: 14px; background: #fff7ed; border: 1px dashed #fbbf24; font-size: 0.82rem; color: #78350f; font-weight: 700; }
    .director { border-color: #cbd5e1; background: linear-gradient(180deg, #f8fafc, #f1f5f9); }
    .footer { margin: 20px; padding: 12px; font-size: 0.7rem; color: #94a3b8; line-height: 1.5; }
    .photo-sec { margin: 0 20px; padding-bottom: 8px; }
    h2.photo-h2 { color: var(--photo-accent, var(--accent)); margin-top: 24px; }
    .photo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .ph { margin: 0; border-radius: 12px; overflow: hidden; background: #f1f5f9; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .ph-img { display: block; width: 100%; height: auto; max-height: 220px; object-fit: cover; }
    .photo-hint { font-size: 0.7rem; color: #94a3b8; margin: 8px 0 0; }
    .imp-ul { margin: 8px 20px 0; padding: 12px 14px 12px 1.75rem; list-style: disc; font-size: 0.86rem; font-weight: 700; color: #334155; background: #f8fafc; border-radius: 14px; border: 1px solid #e2e8f0; }
    .imp-ul li { margin: 4px 0; }
    .facility-hero { margin: 10px 20px 0; border: 1px solid #dbeafe; border-left: 5px solid var(--accent); border-radius: 14px; background: #f8fbff; padding: 10px 12px; }
    .facility-hero .fac-name { font-size: 1.02rem; color: #0f172a; font-weight: 800; letter-spacing: 0.01em; }
    .facility-hero .fac-sub { margin-top: 2px; font-size: 0.76rem; color: #64748b; font-weight: 700; }
    @media print {
      .no-print { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .sheet { box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="band">
      <div class="band-ttl">
        <span class="badge">${escapeHtml(theme.nameJa)}</span>
        <h1>月次のごあいさつ</h1>
        <p class="deco-line">ご家族の皆さま、担当のケアマネジャー様</p>
      </div>
      ${resolvedArtKind ? `<div class="se-art-wrap">${monthlyReportSeasonArt(resolvedArtKind)}</div>` : ''}
    </div>
    <div class="facility-hero">
      <div class="fac-name">${escapeHtml(facilityHeadline)}</div>
      <div class="fac-sub">対象者 ${escapeHtml(name || '（氏名未入力）')} 様 / 対象月 ${escapeHtml(yLabel)}</div>
    </div>
    <div class="lede" style="margin: 0 20px 6px"><p>${escapeHtml(theme.tagline)}</p></div>
    <div class="to-whom">この文書は、<strong>記録端末</strong>に残された日々のケア記録に基づき作成した下書きです。お渡し前に、施設内で内容のご確認をお願いします。医療的な最終判断の代替ではありません。</div>
    <p class="meta" style="padding: 14px 20px 0; margin:0">作成日 ${escapeHtml(today)} ／ 対象 ${escapeHtml(yLabel)} ／ 居室 ${escapeHtml(
      room || '—'
    )}${facility ? ` ／ ${escapeHtml(facility)}` : ''}</p>
    <p class="meta" style="padding:0 20px; margin:6px 0 0"><strong>対象者</strong> ${escapeHtml(name || '（氏名未入力）')} 様</p>

    <div style="padding: 4px 20px 0">
    <h2><span class="n">1</span> この1か月のようす</h2>
    <div class="box">${nl2br(monthlyCondition || '（未入力。AIで作成するか、お手元の記録を元に追記ください。）')}</div>
    <h2><span class="n">2</span> 今後一緒に大切にしたいこと</h2>
    <div class="box">${nl2br(
      futureCarePoints || '（未入力。ご家族・多職種で共有したい方針を追記ください。）'
    )}</div>
    <h2><span class="n">3</span> 施設からのひとこと</h2>
    <div class="box director">${nl2br(
      directorMessage || '（未入力。感謝や今後の励ましの言葉を。）'
    )}</div>
    ${supplementBlock}
    ${photoBlock}
    <p class="no-print" style="margin:18px 0 0;font-size:0.8rem;font-weight:700;color:#0ea5e9">🖨 ブラウザの「印刷」で PDF 保存したり、紙でお渡ししたりできます。</p>
    </div>
    <p class="footer no-print">月次報告テンプレート ／ イラストは文書内の装飾です。掲載写真の個人情報・配慮は施設方針に従ってください。</p>
  </div>
</body>
</html>`;
}

/**
 * 事故報告書（印刷用HTML）。略図は canvas の data URL を渡す。
 * @param {Record<string, string>} draft
 * @param {string | null | undefined} sketchDataUrl PNG data URL または空
 * @param {{ preview?: boolean }} [opts] preview 時は画面内 iframe 向けの縮小表示
 */
export function buildAccidentReportHtml(draft, sketchDataUrl, opts = {}) {
  const preview = Boolean(opts?.preview);
  const d = draft ?? {};
  const v = (k) => String(d[k] ?? '').trim();
  const cell = (k) => escapeHtml(v(k));
  const block = (k) => nl2br(v(k) || '（未入力）');
  const sketchUrl = String(sketchDataUrl ?? '');
  const sketch =
    sketchUrl.startsWith('data:image') && !/["<>]/.test(sketchUrl)
      ? `<img src="${sketchUrl}" alt="略図" style="max-width:100%;max-height:68px;object-fit:contain;display:block;margin:0 auto;"/>`
      : '<span style="color:#bbb;font-size:6.5pt;">（図）</span>';

  const previewCss = preview
    ? `
body.accident-report-preview{background:#e5e7eb;padding:8px;}
body.accident-report-preview .page{width:100%;max-width:210mm;min-height:auto;margin:0 auto;padding:10px;box-shadow:0 1px 4px rgba(0,0,0,.12);}
body.accident-report-preview .page th,body.accident-report-preview .page td{font-size:7.5pt;padding:2px 4px;}
body.accident-report-preview .page th{width:68px;}
body.accident-report-preview .title-area h1{font-size:14pt;}
`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>事故報告書</title>
<style>
:root{--primary-color:#000000;--text-dark:#222;--border-color:#333;--bg-light:#ececec;}
body.accident-onepage{font-family:"Helvetica Neue",Arial,"Hiragino Kaku Gothic ProN","Hiragino Sans",Meiryo,sans-serif;color:var(--text-dark);background:#fff;margin:0;padding:0;line-height:1.22;font-size:7.5pt;}
.page{width:210mm;margin:0 auto;background:#fff;padding:5mm 6mm;box-sizing:border-box;position:relative;max-height:297mm;overflow:hidden;}
${previewCss}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2px;}
.title-area h1{font-size:14pt;margin:0;color:var(--primary-color);letter-spacing:0.12em;border-bottom:1.5px solid var(--primary-color);padding-bottom:2px;}
.version{font-size:6.5pt;color:#666;margin-top:1px;}
.date-report{text-align:right;font-size:7pt;margin-bottom:2px;}
.approval-table{border-collapse:collapse;margin-left:auto;}
.approval-table td{border:1px solid var(--border-color);width:52px;text-align:center;font-size:6.5pt;padding:0;}
.stamp-box{height:28px;}
table{width:100%;border-collapse:collapse;margin-bottom:2px;table-layout:fixed;}
th,td{border:1px solid var(--border-color);padding:2px 4px;font-size:7.5pt;vertical-align:top;}
th{background-color:var(--bg-light);font-weight:bold;text-align:center;width:76px;}
.section-title{background-color:var(--primary-color);color:#fff;padding:1px 6px;font-size:7.5pt;font-weight:bold;margin-top:2px;}
.sketch-area{border:1px dashed var(--border-color);height:72px;display:flex;justify-content:center;align-items:center;background-color:#fafafa;}
.print-val{font-size:7.5pt;color:#000;white-space:pre-wrap;word-break:break-word;line-height:1.25;}
.situation-box,.text-block{border:1px solid var(--border-color);border-top:none;padding:3px 4px;}
.situation-box{min-height:52px;}
.text-block{min-height:26px;}
.text-block-tall{min-height:30px;}
.text-block-med{min-height:28px;}
.inline-num{display:inline-block;min-width:1.1em;text-align:center;border-bottom:1px solid #ccc;font-size:7.5pt;}
.row-sit-sk{display:flex;gap:4px;}
.row-sit-sk > div:first-child{flex:2.1;}
.row-sit-sk > div:last-child{flex:0.85;}
@media print{
  @page{size:A4 portrait;margin:0;}
  html,body.accident-onepage{height:100%;overflow:hidden!important;}
  body.accident-onepage{background:#fff!important;margin:0!important;padding:0!important;}
  .page{margin:0 auto!important;width:210mm!important;max-height:287mm!important;padding:4mm 5mm!important;overflow:hidden!important;}
  *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
  body.accident-onepage #report-content{zoom:0.9;}
}
@supports not (zoom:1){
  @media print{
    body.accident-onepage #report-content{transform:scale(0.9);transform-origin:top center;}
  }
}
</style>
</head>
<body class="accident-onepage${preview ? ' accident-report-preview' : ''}">
<div class="page" id="report-content">
  <div class="date-report">
    報告日：20<span class="inline-num">${cell('reportYear2')}</span>年
    <span class="inline-num">${cell('reportMonth')}</span>月
    <span class="inline-num">${cell('reportDay')}</span>日
  </div>
  <div class="header">
    <div class="title-area">
      <h1>事故報告書</h1>
      <div class="version">ver.3（A4・1枚想定／上肢欄なし）</div>
    </div>
    <table class="approval-table">
      <tr><td>部長(又は代理)</td><td>管理者</td></tr>
      <tr><td class="stamp-box"></td><td class="stamp-box"></td></tr>
      <tr><td>（　 / 　）</td><td>（　 / 　）</td></tr>
    </table>
  </div>
  <table style="margin-top:2px;">
    <tr>
      <th>報告者</th><td><div class="print-val">${cell('reporterName')}</div></td>
      <th style="width:60px;">職種</th><td><div class="print-val">${cell('reporterJob')}</div></td>
      <th style="width:60px;">所属</th><td><div class="print-val">${cell('reporterDept')}</div></td>
    </tr>
    <tr>
      <th>発生日時</th>
      <td colspan="3">
        20<span class="inline-num">${cell('occurYear2')}</span>年
        <span class="inline-num">${cell('occurMonth')}</span>月
        <span class="inline-num">${cell('occurDay')}</span>日
        （<span class="inline-num">${cell('occurDayNote')}</span>）
        <span style="border:1px solid #ccc;padding:0 5px;margin:0 5px;">${cell('occurAmPm') || 'AM ・ PM'}</span>
        <span class="inline-num">${cell('occurHour')}</span>時
        <span class="inline-num">${cell('occurMinute')}</span>分 頃
      </td>
      <th>発生場所</th><td><div class="print-val">${cell('occurPlace')}</div></td>
    </tr>
    <tr>
      <th>利用者名</th><td colspan="2"><span class="print-val" style="font-size:9pt">${cell('residentName')}</span> 様</td>
      <th>性別・年齢</th><td colspan="2"><div class="print-val">${cell('genderAge')}</div></td>
    </tr>
    <tr>
      <th>事故の種類</th>
      <td colspan="5">
        <div>転倒 ・ 転落 ・ 落薬 ・ 誤薬 ・ その他（<span class="print-val">${cell('accidentTypeDetail')}</span>）</div>
      </td>
    </tr>
  </table>
  <div class="section-title">医療機関情報</div>
  <table>
    <tr>
      <th>医療機関名</th>
      <td colspan="5"><div class="print-val">${cell('medicalInstitutionName')}</div></td>
    </tr>
    <tr>
      <th>機関コード</th>
      <td colspan="5"><div class="print-val">${cell('medicalInstitutionCode')}</div></td>
    </tr>
    <tr>
      <th>所在地</th>
      <td colspan="5"><div class="print-val">${cell('medicalInstitutionAddress')}</div></td>
    </tr>
    <tr>
      <th>電話</th>
      <td colspan="5"><div class="print-val">${cell('medicalInstitutionTel')}</div></td>
    </tr>
  </table>
  <div class="row-sit-sk">
    <div>
      <div class="section-title">事故の発生状況を具体的に記入</div>
      <div class="situation-box"><div class="print-val">${block('situation')}</div></div>
    </div>
    <div>
      <div class="section-title">略図</div>
      <div class="sketch-area">${sketch}</div>
    </div>
  </div>
  <div class="section-title">発生直後の対応・処置</div>
  <div class="text-block text-block-tall">
    <div class="print-val">${block('response')}</div>
    <div style="text-align:right;font-size:6.5pt;margin-top:2px;">
      家族への報告：（ <span class="inline-num">${cell('familyReportMonth')}</span> 月 <span class="inline-num">${cell('familyReportDay')}</span> 日 ）
    </div>
  </div>
  <div class="section-title">アセスメント（観察所見・傷害部位 等）</div>
  <div class="text-block text-block-med"><div class="print-val">${block('injuryAssessment')}</div></div>
  <div class="section-title">原因として考えられる事</div>
  <div class="text-block text-block-med"><div class="print-val">${block('causes')}</div></div>
  <div class="section-title">今後の対応・改善策</div>
  <div class="text-block text-block-med"><div class="print-val">${block('improvements')}</div></div>
  <table style="margin-top:2px;">
    <tr>
      <th style="height:auto;padding:2px;">上司の所見</th>
      <td colspan="2" style="vertical-align:top;"><div class="print-val text-block" style="border:none;min-height:28px;padding:0;">${block('supervisorOpinion')}</div></td>
      <td style="width:108px;text-align:center;vertical-align:top;padding-top:2px;">
        <div style="font-size:6.5pt;font-weight:bold;margin-bottom:2px;">再検討の必要性</div>
        <div><span style="border:1px solid #ccc;padding:1px 6px;font-size:7pt;">${cell('reviewNeeded') || 'あり ・ なし'}</span></div>
      </td>
    </tr>
    <tr><th>その他</th><td colspan="3"><div class="print-val">${block('otherNotes')}</div></td></tr>
  </table>
</div>
</body>
</html>`;
}

/**
 * メモから事故報告の主要欄を下書き（JSON）
 * @param {string} apiKey
 * @param {string} memo
 * @param {string} residentHint
 */
export async function fetchAccidentReportAssist(apiKey, memo, residentHint = '') {
  if (!apiKey?.trim()) {
    return { situation: '', response: '', causes: '', improvements: '' };
  }
  const prompt = `あなたは介護施設の事故報告書作成支援です。次のメモのみを根拠に、JSONオブジェクト1つだけを返してください（説明文不要）。
キー: situation, response, causes, improvements（各値は日本語の文字列）

- situation: メモの事実を整理し「事故の発生状況」として具体的に。
- response: メモにあれば「発生直後の対応・処置」を。無ければ「※要確認」と短く。
- causes: **必須**。メモの内容を踏まえ「原因として考えられる事」を2〜5文で分析（断定は避け「〜の可能性」「要確認」可）。メモが短い場合も、誤薬・転倒等に応じた一般的チェック観点から仮説を列挙する。空文字にしない。
- improvements: **必須**。causes に対応する「今後の対応・改善策」を2〜5文で具体的に（二重確認・表示・見守り・手順・教育等）。空文字にしない。

利用者・状況ヒント: ${String(residentHint || '').trim() || '（なし）'}
メモ:
${String(memo || '').trim() || '（なし）'}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data?.error?.message ?? 'AI応答なし');
  const raw = stripJsonFence(text);
  const fallbackCauses =
    '【要追記】メモから原因分析を自動生成できませんでした。人的・物的・環境・管理的要因を整理してください。';
  const fallbackImprovements =
    '【要追記】再発防止策を具体的に記入してください（手順・ダブルチェック・表示・見守り・教育・記録など）。';
  try {
    const parsed = JSON.parse(raw);
    let causes = String(parsed.causes ?? '').trim();
    let improvements = String(parsed.improvements ?? '').trim();
    if (!causes) causes = fallbackCauses;
    if (!improvements) improvements = fallbackImprovements;
    return {
      situation: String(parsed.situation ?? ''),
      response: String(parsed.response ?? ''),
      causes,
      improvements,
    };
  } catch {
    return {
      situation: raw,
      response: '',
      causes: fallbackCauses,
      improvements: fallbackImprovements,
    };
  }
}

/** 事故報告下書きのキー（音声→AI 一括生成用） */
const ACCIDENT_VOICE_DRAFT_KEYS = [
  'reportYear2',
  'reportMonth',
  'reportDay',
  'reporterName',
  'reporterJob',
  'reporterDept',
  'occurYear2',
  'occurMonth',
  'occurDay',
  'occurDayNote',
  'occurAmPm',
  'occurHour',
  'occurMinute',
  'occurPlace',
  'residentName',
  'genderAge',
  'accidentTypeDetail',
  'situation',
  'response',
  'familyReportMonth',
  'familyReportDay',
  'causes',
  'improvements',
  'supervisorOpinion',
  'reviewNeeded',
  'otherNotes',
  'injuryAssessment',
];

function padAccident2(v) {
  const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
  if (!Number.isFinite(n)) return String(v ?? '').trim().padStart(2, '0').slice(-2);
  return String(n).padStart(2, '0').slice(-2);
}

function normalizeYear2Field(v) {
  const s = String(v ?? '').trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^\d{4}$/.test(s)) return String(parseInt(s, 10) % 100).padStart(2, '0');
  if (/^\d{2}$/.test(s)) return s;
  const d = s.replace(/\D/g, '');
  if (d.length >= 2) return d.slice(-2).padStart(2, '0');
  return s.slice(0, 2).padStart(2, '0');
}

/**
 * 音声メモから事故報告書の全欄を JSON で生成（1回の API）
 * @param {string} apiKey
 * @param {string} voiceMemo
 * @param {{ facilityLabel?: string; residentName?: string; room?: string; reporterDeptPreset?: string }} [context]
 */
export async function fetchAccidentReportFromVoiceMemo(apiKey, voiceMemo, context = {}) {
  if (!apiKey?.trim()) throw new Error('APIキーが設定されていません');
  const memo = String(voiceMemo ?? '').trim();
  if (!memo) throw new Error('話した内容がありません。音声入力してください。');

  const fac = String(context.facilityLabel ?? '').trim();
  const resName = String(context.residentName ?? '').trim();
  const room = String(context.room ?? '').trim();
  const deptPreset = String(context.reporterDeptPreset ?? '').trim();
  const today = new Date();
  const ty = today.getFullYear() % 100;
  const tm = String(today.getMonth() + 1).padStart(2, '0');
  const td = String(today.getDate()).padStart(2, '0');

  const keyList = ACCIDENT_VOICE_DRAFT_KEYS.join(', ');

  const prompt = `あなたは介護施設の事故報告書作成担当です。職員の「音声で話した内容」のみを根拠に、公式事故報告書に転記するJSONオブジェクトを1つだけ返してください（説明文・Markdownフェンス禁止）。

【今日の日付（報告日のデフォルト）】20${String(ty).padStart(2, '0')}年 ${tm}月 ${td}日

【コンテキスト（音声に明示が無いときは優先して埋める）】
- 施設: ${fac || '（不明）'}
- 利用者氏名: ${resName || '（未選択）'}
- 居室: ${room || '—'}
- 所属部署（音声で部署名が無ければ reporterDept にこの値を使う）: ${deptPreset || '（不明）'}

【JSONのキー（すべて文字列。必ずすべて含める）】
${keyList}

【各フィールドの意味】
- reportYear2 / occurYear2: 西暦の下2桁（例 26）
- reportMonth, reportDay, occurMonth, occurDay, familyReportMonth, familyReportDay: 2桁または1桁の月日（先頭0可）
- occurAmPm: 「午前」または「午後」または空
- occurHour, occurMinute: 数字のみの文字列が望ましい
- genderAge: 例「（ 男 ）　85 歳」や「（ 女 ・ 男 ）　 歳」のように書式に近づける
- accidentTypeDetail: 転倒・転落・誤薬等の補足（テンプレの「その他」括弧内）
- situation: 事故の発生状況（具体的に。いつ・どこで・誰が・何が起きたか）
- response: 発生直後の対応・処置（実施内容、医師・家族連絡の有無など。音声に無いときは「※要確認」可）
- causes: **必須（空禁止）**。音声の状況・response を踏まえ「原因として考えられる事」を日本語で2〜6文。断定できないときは「〜の可能性」「〜が疑われる」「要確認」。音声が短い場合も、誤薬なら同種剤・ラベル・手順逸脱、転倒なら環境・身体状態・介助等の**観点から仮説**を書く。利用者名や事実と矛盾させない。
- improvements: **必須（空禁止）**。causes に対応する「今後の対応・改善策」を日本語で2〜6文（二重確認・表示改善・見守り・手順書・記録・職員教育・家族共有等）。空にしない。
- supervisorOpinion, otherNotes: 音声に無ければ空でよい
- injuryAssessment: 事故直後のアセスメント（意識・バイタル・傷害部位・皮膚・疼痛・神経所見など）。音声に無ければ空
- reviewNeeded: 「あり」「なし」または空

音声に無い欄は空でもよいが、**causes と improvements は必ず本文を生成**する。推測は可能性として明示する。利用者名はコンテキストと矛盾させない。

音声の内容:
${memo}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data?.error?.message ?? 'AI応答なし');
  const raw = stripJsonFence(text);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AIのJSONを解釈できませんでした');
  }

  /** @type {Record<string, string>} */
  const out = {};
  for (const k of ACCIDENT_VOICE_DRAFT_KEYS) {
    out[k] = String(parsed[k] ?? '').trim();
  }

  for (const yk of ['reportYear2', 'occurYear2']) {
    if (out[yk]) out[yk] = normalizeYear2Field(out[yk]);
  }
  for (const mk of ['reportMonth', 'reportDay', 'occurMonth', 'occurDay', 'familyReportMonth', 'familyReportDay']) {
    if (out[mk]) out[mk] = padAccident2(out[mk]);
  }

  if (!out.reporterDept && deptPreset) out.reporterDept = deptPreset;
  if (!out.residentName && resName) out.residentName = resName;

  if (!out.causes.trim()) {
    out.causes =
      '【要追記】音声から原因分析を自動生成できませんでした。職員会議等で、人的・物的・環境・管理的要因を整理してください。';
  }
  if (!out.improvements.trim()) {
    out.improvements =
      '【要追記】再発防止策を具体的に記入してください（手順・ダブルチェック・表示・見守り・教育・記録・家族連携など）。';
  }

  return out;
}

function newNearMissReportId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeNearMissCategories(arr) {
  const allowed = new Set([...NEAR_MISS_CATEGORY_LABELS, 'その他']);
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => String(x).trim()).filter((x) => allowed.has(x)))];
}

/** @param {string} msg */
function isGeminiQuotaMessage(msg) {
  const s = String(msg ?? '').toLowerCase();
  return (
    /quota|429|503|resource_exhausted|rate\s*limit|free_tier|please\s*retry|high\s+demand|unavailable|overload|capacity/i.test(s) ||
    s.includes('try again later') ||
    s.includes('model is currently experiencing')
  );
}

/**
 * AI不可時でも最低限のヒヤリ下書きを返す
 * @param {string} memo
 * @param {number} ty
 * @param {number} tm
 * @param {number} td
 */
function buildNearMissFallbackDraft(memo, ty, tm, td) {
  const lines = String(memo ?? '')
    .split(/\r?\n/)
    .map((s) => s.replace(/^[・●\-\*\s]+/u, '').trim())
    .filter(Boolean);
  const firstLine = lines[0] || '状況確認中';
  const situation = lines.length
    ? `${lines.join('。')}。`
    : `${firstLine}です。`;
  const residentHit = lines.join(' ').match(/([一-龯々ぁ-んァ-ヶーA-Za-z]+)\s*様/u);
  const placeHit = lines.join(' ').match(/(居室|デイホール|食堂|廊下|トイレ|浴室|玄関|ベッドサイド|共有部|フロア)/u);
  return {
    reporterName: '',
    reporterDept: '',
    residentName: residentHit ? String(residentHit[1]) : '',
    occurPlace: placeHit ? String(placeHit[1]) : '',
    occurAmPm: '',
    occurHour: '',
    occurMinute: '',
    occurYear: null,
    occurMonth: null,
    occurDay: null,
    submitYear: ty,
    submitMonth: tm,
    submitDay: td,
    situationContent: situation,
    afterReportContent: '関係者へ共有し、再発防止のため見守りを強化しました。',
    causeAndMeasures: '要因を整理し、環境調整と声掛け手順の見直しを行います。',
    categories: [],
    categoryOther: '',
  };
}

/**
 * 箇条書きメモからヒヤリハット報告の下書き（JSON）。文体はです・ます調で統一。
 * @param {string} apiKey
 * @param {string} memo
 * @param {string} [facilityLabel]
 */
export async function fetchNearMissReportFromBullets(apiKey, memo, facilityLabel = '') {
  const today = new Date();
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  const labelList = [...NEAR_MISS_CATEGORY_LABELS, 'その他'].join('、');

  if (!apiKey?.trim()) return buildNearMissFallbackDraft(memo, ty, tm, td);

  const prompt = `あなたは介護施設の専属文書アシスタントです。次の箇条書き業務メモのみを根拠に、ヒヤリハット(気づき)報告書用のJSONオブジェクト1つだけを返してください（説明文やMarkdownのフェンス禁止）。

【文体】situationContent, afterReportContent, causeAndMeasures の本文は、必ず敬体の「です・ます」調で統一してください。

【キーと型】
- reporterName: string
- reporterDept: string（所属事業所・部署）
- residentName: string
- occurPlace: string
- occurAmPm: "午前" | "午後" | "" のいずれか
- occurHour: string（時、数字のみ推奨）
- occurMinute: string（分）
- occurYear, occurMonth, occurDay: number | null（発生日・西暦。メモにない場合はnull）
- submitYear, submitMonth, submitDay: number（提出日。メモにない場合は本日: ${ty}年${tm}月${td}日）
- situationContent: string（セクション1【状況】＝「内容」）
- afterReportContent: string（セクション1【対応】＝報告後のフォロー・共有内容）
- causeAndMeasures: string（セクション2【原因と今後の対策】）
- categories: string[]（次のラベルから該当のみ厳密一致: ${labelList}）
- categoryOther: string（「その他」欄の補足。不要なら空文字）

施設タブ表示名（参考）: ${String(facilityLabel || '').trim() || '（不明）'}

メモ:
${String(memo || '').trim() || '（なし）'}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!res.ok || !text) {
    const msg = String(data?.error?.message ?? '');
    if (isGeminiQuotaMessage(msg)) return buildNearMissFallbackDraft(memo, ty, tm, td);
    throw new Error(msg || 'AI応答なし');
  }
  const raw = stripJsonFence(text);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AIのJSONを解釈できませんでした');
  }

  let cats = normalizeNearMissCategories(parsed.categories);
  const coOther = String(parsed.categoryOther ?? '').trim();
  if (coOther && !cats.includes('その他')) cats = [...cats, 'その他'];

  const num = (v, fallback) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : parseInt(String(v ?? '').trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    reporterName: String(parsed.reporterName ?? ''),
    reporterDept: String(parsed.reporterDept ?? ''),
    residentName: String(parsed.residentName ?? ''),
    occurPlace: String(parsed.occurPlace ?? ''),
    occurAmPm: String(parsed.occurAmPm ?? ''),
    occurHour: String(parsed.occurHour ?? ''),
    occurMinute: String(parsed.occurMinute ?? ''),
    occurYear: parsed.occurYear != null ? num(parsed.occurYear, null) : null,
    occurMonth: parsed.occurMonth != null ? num(parsed.occurMonth, null) : null,
    occurDay: parsed.occurDay != null ? num(parsed.occurDay, null) : null,
    submitYear: num(parsed.submitYear, ty),
    submitMonth: num(parsed.submitMonth, tm),
    submitDay: num(parsed.submitDay, td),
    situationContent: String(parsed.situationContent ?? ''),
    afterReportContent: String(parsed.afterReportContent ?? ''),
    causeAndMeasures: String(parsed.causeAndMeasures ?? ''),
    categories: cats,
    categoryOther: String(parsed.categoryOther ?? ''),
  };
}

/**
 * @param {{ facilityLabel: string; department: string; residentId?: string; draft: Record<string, unknown> }} p
 * @returns {{ id: string; savedAt: string; facilityLabel: string; department: string; residentId: string; draft: Record<string, unknown> } | null}
 */
export function saveNearMissReport(p) {
  const facilityLabel = String(p?.facilityLabel ?? '').trim();
  const department = String(p?.department ?? '').trim();
  if (!facilityLabel || !department) return null;
  const list = getNearMissReports();
  const entry = {
    id: newNearMissReportId(),
    savedAt: nowJapanIsoString(),
    facilityLabel,
    department,
    residentId: String(p?.residentId ?? '').trim(),
    draft: { ...(p?.draft && typeof p.draft === 'object' ? p.draft : {}) },
  };
  list.unshift(entry);
  writeJson(LS.nearMissReports, list.slice(0, MAX_NEAR_MISS_REPORTS));
  return entry;
}

/** @returns {unknown[]} */
export function getNearMissReports() {
  const raw = readJson(LS.nearMissReports, []);
  return Array.isArray(raw) ? raw : [];
}

function newAccidentReportId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 発生日（下書き）を YYYY-MM-DD に。無効なら null */
export function occurrenceYmdFromDraft(draft) {
  const d = draft ?? {};
  const y2 = String(d.occurYear2 ?? '')
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .padStart(2, '0');
  const m = String(d.occurMonth ?? '')
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .padStart(2, '0');
  const day = String(d.occurDay ?? '')
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .padStart(2, '0');
  if (!/^\d{2}$/.test(y2) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(day)) return null;
  const year = 2000 + parseInt(y2, 10);
  const mo = parseInt(m, 10);
  const da = parseInt(day, 10);
  const dt = new Date(year, mo - 1, da);
  if (dt.getFullYear() !== year || dt.getMonth() !== mo - 1 || dt.getDate() !== da) return null;
  return `${year}-${m}-${day}`;
}

/**
 * ヒヤリ報告下書きの発生日（4桁年・月・日）。無効・未入力なら null
 * @param {Record<string, unknown>} draft
 */
export function nearMissOccurrenceYmdFromDraft(draft) {
  const d = draft ?? {};
  const norm = (v) =>
    String(v ?? '')
      .trim()
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const y = parseInt(norm(d.occurYear), 10);
  const mo = parseInt(norm(d.occurMonth), 10);
  const day = parseInt(norm(d.occurDay), 10);
  if (!Number.isFinite(y) || y < 1990 || y > 2100) return null;
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const ms = String(mo).padStart(2, '0');
  const ds = String(day).padStart(2, '0');
  const dt = new Date(y, mo - 1, day);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== day) return null;
  return `${y}-${ms}-${ds}`;
}

/**
 * @param {Record<string, unknown>} draft
 * @returns {string[]}
 */
function classifyNearMissRecordCategories(draft) {
  const cats = Array.isArray(draft?.categories)
    ? draft.categories.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const other = String(draft?.categoryOther ?? '').trim();
  const uniq = [...new Set(cats)];
  if (other && !uniq.includes('その他')) uniq.push('その他');
  if (!uniq.length) return ['分類なし'];
  return uniq;
}

/** 発生時刻を 0–23 時。判定できなければ null */
export function parseOccurHour24(draft) {
  const d = draft ?? {};
  const hStr = String(d.occurHour ?? '')
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const hourNum = parseInt(hStr, 10);
  if (!Number.isFinite(hourNum)) return null;
  const ap = String(d.occurAmPm ?? '').trim();
  const isPM = /午後|ＰＭ|PM|pm/.test(ap);
  const isAM = /午前|ＡＭ|AM|am/.test(ap);
  const hasAp = isPM || isAM;
  if (hourNum >= 0 && hourNum <= 23 && !hasAp) return hourNum;
  if (hourNum >= 1 && hourNum <= 12 && hasAp) {
    if (isPM) return hourNum === 12 ? 12 : hourNum + 12;
    return hourNum === 12 ? 0 : hourNum;
  }
  if (hourNum >= 0 && hourNum <= 23) return hourNum;
  return null;
}

export function hourToTimeSlot(hour24) {
  if (hour24 == null || !Number.isFinite(hour24)) return '時間不明';
  const h = Math.floor(Number(hour24));
  if (h >= 0 && h <= 5) return '深夜（0–5時）';
  if (h >= 6 && h <= 8) return '早朝（6–8時）';
  if (h >= 9 && h <= 11) return '午前（9–11時）';
  if (h >= 12 && h <= 13) return '昼（12–13時）';
  if (h >= 14 && h <= 17) return '午後（14–17時）';
  if (h >= 18 && h <= 20) return '夕方（18–20時）';
  if (h >= 21 && h <= 23) return '夜（21–23時）';
  return '時間不明';
}

export function classifyAccidentType(draft) {
  const text = `${String(draft?.accidentTypeDetail ?? '')}\n${String(draft?.situation ?? '')}`.replace(/\s/g, '');
  if (/転落/.test(text)) return '転落';
  if (/転倒/.test(text)) return '転倒';
  if (/誤薬/.test(text)) return '誤薬';
  if (/落薬/.test(text)) return '落薬';
  if (/誤嚥|窒息|むせ|嚥下異常/.test(text)) return '窒息・誤嚥';
  if (/徘徊/.test(text)) return '徘徊';
  if (/火傷|やけど/.test(text)) return 'やけど・火傷';
  if (/自傷/.test(text)) return '自傷行為';
  return 'その他';
}

/**
 * 事故報告を部署・施設単位でローカル保存（月次集計用）
 * @param {{ facilityLabel: string; department: string; residentId?: string; draft: Record<string, unknown> }} p
 * @returns {{ id: string; savedAt: string; facilityLabel: string; department: string; residentId: string; draft: Record<string, unknown> } | null}
 */
export function saveAccidentReport(p) {
  const facilityLabel = String(p?.facilityLabel ?? '').trim();
  const department = String(p?.department ?? '').trim();
  if (!facilityLabel || !department) return null;
  const list = getAccidentReports();
  const entry = {
    id: newAccidentReportId(),
    savedAt: new Date().toISOString(),
    facilityLabel,
    department,
    residentId: String(p?.residentId ?? '').trim(),
    draft: { ...(p?.draft && typeof p.draft === 'object' ? p.draft : {}) },
  };
  list.unshift(entry);
  writeJson(LS.accidentReports, list.slice(0, MAX_ACCIDENT_REPORTS));
  return entry;
}

/** @returns {Array<{ id: string; savedAt: string; facilityLabel: string; department: string; residentId: string; draft: Record<string, unknown> }>} */
export function getAccidentReports() {
  const raw = readJson(LS.accidentReports, []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * 既存の事故報告を上書き更新
 * @param {string} id
 * @param {{ facilityLabel?: string; department?: string; residentId?: string; draft?: Record<string, unknown> }} patch
 * @returns {{ id: string; savedAt: string; facilityLabel: string; department: string; residentId: string; draft: Record<string, unknown> } | null}
 */
export function updateAccidentReport(id, patch = {}) {
  const targetId = String(id ?? '').trim();
  if (!targetId) return null;
  const list = getAccidentReports();
  const idx = list.findIndex((x) => String(x?.id ?? '') === targetId);
  if (idx < 0) return null;
  const cur = list[idx] ?? {};
  const facilityLabel = String(patch?.facilityLabel ?? cur.facilityLabel ?? '').trim();
  const department = String(patch?.department ?? cur.department ?? '').trim();
  if (!facilityLabel || !department) return null;
  const mergedDraft =
    patch?.draft && typeof patch.draft === 'object'
      ? { ...(cur.draft && typeof cur.draft === 'object' ? cur.draft : {}), ...patch.draft }
      : { ...(cur.draft && typeof cur.draft === 'object' ? cur.draft : {}) };
  const updated = {
    ...cur,
    id: targetId,
    savedAt: nowJapanIsoString(),
    facilityLabel,
    department,
    residentId: String(patch?.residentId ?? cur.residentId ?? '').trim(),
    draft: mergedDraft,
  };
  list[idx] = updated;
  writeJson(LS.accidentReports, list.slice(0, MAX_ACCIDENT_REPORTS));
  return updated;
}

/**
 * 指定月の事故を種類・時間帯で集計
 * @param {string} yearMonth YYYY-MM
 * @param {{ facilityLabel?: string; department?: string }} [filters]
 */
export function aggregateAccidentMonthlySummary(yearMonth, filters = {}) {
  const ym = String(yearMonth ?? '').trim();
  const fac = String(filters.facilityLabel ?? '').trim();
  const dep = String(filters.department ?? '').trim();
  const prefix = ym.length === 7 ? `${ym}-` : '';
  const all = getAccidentReports();
  /** @type {Record<string, number>} */
  const byType = {};
  /** @type {Record<string, number>} */
  const bySlot = {};
  const records = [];
  let total = 0;

  for (const row of all) {
    if (fac && String(row.facilityLabel ?? '').trim() !== fac) continue;
    if (dep && String(row.department ?? '').trim() !== dep) continue;
    const ymd = occurrenceYmdFromDraft(row.draft);
    if (!ymd || (prefix && !ymd.startsWith(prefix))) continue;
    const hour = parseOccurHour24(row.draft);
    const slot = hourToTimeSlot(hour);
    const typ = classifyAccidentType(row.draft);
    total += 1;
    byType[typ] = (byType[typ] ?? 0) + 1;
    bySlot[slot] = (bySlot[slot] ?? 0) + 1;
    records.push({
      ...row,
      _occurrenceYmd: ymd,
      _hour24: hour,
      _slot: slot,
      _type: typ,
    });
  }
  records.sort((a, b) => {
    const c = String(b._occurrenceYmd).localeCompare(String(a._occurrenceYmd));
    if (c !== 0) return c;
    return String(b.savedAt).localeCompare(String(a.savedAt));
  });
  return {
    total,
    byType,
    bySlot,
    records,
    yearMonth: ym,
    filters: { facilityLabel: fac, department: dep },
  };
}

function sortedCountRows(map, order) {
  const seen = new Set();
  const rows = [];
  for (const k of order) {
    const n = map[k];
    if (n > 0) {
      rows.push({ key: k, count: n });
      seen.add(k);
    }
  }
  for (const [k, n] of Object.entries(map)) {
    if (!seen.has(k) && n > 0) rows.push({ key: k, count: n });
  }
  return rows;
}

/**
 * @param {ReturnType<typeof aggregateAccidentMonthlySummary>} agg
 * @param {string} [assessmentText]
 */
export function buildAccidentMonthlyAnalysisHtml(agg, assessmentText = '') {
  const typeRows = sortedCountRows(agg.byType, ACCIDENT_TYPE_ORDER);
  const slotRows = sortedCountRows(agg.bySlot, ACCIDENT_SLOT_ORDER);
  const fac = agg.filters?.facilityLabel ? escapeHtml(agg.filters.facilityLabel) : '全施設';
  const dep = agg.filters?.department ? escapeHtml(agg.filters.department) : '全部署';
  const ym = escapeHtml(agg.yearMonth);
  const typeTable =
    typeRows.length === 0
      ? '<tr><td colspan="2">該当なし</td></tr>'
      : typeRows.map((r) => `<tr><td>${escapeHtml(r.key)}</td><td style="text-align:right">${r.count}</td></tr>`).join('');
  const slotTable =
    slotRows.length === 0
      ? '<tr><td colspan="2">該当なし</td></tr>'
      : slotRows.map((r) => `<tr><td>${escapeHtml(r.key)}</td><td style="text-align:right">${r.count}</td></tr>`).join('');
  const listRows = agg.records
    .slice(0, 80)
    .map((r) => {
      const name = escapeHtml(String(r.draft?.residentName ?? '').trim() || '—');
      const typ = escapeHtml(String(r._type));
      const sl = escapeHtml(String(r._slot));
      const dept = escapeHtml(String(r.department ?? ''));
      return `<tr><td>${escapeHtml(r._occurrenceYmd)}</td><td>${dept}</td><td>${name}</td><td>${typ}</td><td>${sl}</td></tr>`;
    })
    .join('');
  const assess = nl2br(String(assessmentText ?? '').trim() || '（未生成。ブラウザ上で「アセスメント生成」を実行してください。）');

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/><title>事故月次分析 ${agg.yearMonth}</title>
<style>
body{font-family:system-ui,sans-serif;padding:16px;color:#111}
h1{font-size:20px;border-bottom:2px solid #333;padding-bottom:8px}
h2{font-size:16px;margin:20px 0 8px}
.meta{color:#555;font-size:13px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;max-width:720px;font-size:13px;margin-top:8px}
th,td{border:1px solid #ccc;padding:8px;text-align:left}
th{background:#f0f0f0}
.box{border:1px solid #333;padding:12px;margin:16px 0;background:#fafafa;white-space:pre-wrap}
@media print{.no-print{display:none}}
</style></head><body>
<h1>事故報告 月次集計・アセスメント</h1>
<div class="meta">対象月: <strong>${ym}</strong> ／ 施設: <strong>${fac}</strong> ／ 部署: <strong>${dep}</strong> ／ 件数: <strong>${agg.total}</strong></div>
<h2>事故の種類別 件数</h2>
<table><thead><tr><th>種類</th><th>件数</th></tr></thead><tbody>${typeTable}</tbody></table>
<h2>発生時間帯別 件数</h2>
<table><thead><tr><th>時間帯</th><th>件数</th></tr></thead><tbody>${slotTable}</tbody></table>
<h2>アセスメント（参考）</h2>
<div class="box">${assess}</div>
<h2>明細（最大80件）</h2>
<table><thead><tr><th>発生日</th><th>部署</th><th>利用者</th><th>分類</th><th>時間帯</th></tr></thead><tbody>${
    listRows || '<tr><td colspan="5">該当なし</td></tr>'
  }</tbody></table>
<p class="no-print" style="margin-top:24px;font-size:12px;color:#666">施設ポータル — ブラウザの印刷から PDF 保存できます。</p>
</body></html>`;
}

function csvEscape(s) {
  const t = String(s ?? '');
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

/** @param {ReturnType<typeof aggregateAccidentMonthlySummary>} agg */
export function buildAccidentMonthlyCsv(agg) {
  const header = [
    '発生日',
    '保存日時',
    '施設',
    '部署',
    '利用者名',
    '事故分類',
    '時間帯',
    '発生状況要約',
    'アセスメント',
  ];
  const lines = [header.join(',')];
  for (const r of agg.records) {
    const sit = String(r.draft?.situation ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const assess = String(r.draft?.injuryAssessment ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    lines.push(
      [
        r._occurrenceYmd,
        r.savedAt,
        r.facilityLabel,
        r.department,
        r.draft?.residentName ?? '',
        r._type,
        r._slot,
        sit,
        assess,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

/**
 * 月次集計結果に基づくアセスメント文案（Gemini）
 * @param {string} apiKey
 * @param {ReturnType<typeof aggregateAccidentMonthlySummary>} agg
 */
export async function fetchAccidentMonthlyAssessmentAi(apiKey, agg) {
  if (!apiKey?.trim()) {
    return 'API キー未設定のため、集計表のみご利用ください。傾向は「種類別」「時間帯別」の件数からご判断ください。';
  }
  const typeRows = sortedCountRows(agg.byType, ACCIDENT_TYPE_ORDER);
  const slotRows = sortedCountRows(agg.bySlot, ACCIDENT_SLOT_ORDER);
  const samples = agg.records.slice(0, 12).map((r) => ({
    type: r._type,
    slot: r._slot,
    dept: r.department,
    situation: String(r.draft?.situation ?? '').slice(0, 400),
    injuryAssessment: String(r.draft?.injuryAssessment ?? '').slice(0, 280),
    causes: String(r.draft?.causes ?? '').slice(0, 200),
    improvements: String(r.draft?.improvements ?? '').slice(0, 200),
  }));
  const prompt = `あなたは介護・看護の安全管理者です。次の「1か月分の事故報告集計（同一ブラウザに保存された記録）」を踏まえ、施設内アセスメントとして日本語で簡潔にまとめてください。

【集計条件】対象月: ${agg.yearMonth} / 施設フィルタ: ${agg.filters?.facilityLabel || '全施設'} / 部署フィルタ: ${agg.filters?.department || '全部署'} / 合計件数: ${agg.total}

【種類別件数】
${typeRows.map((r) => `- ${r.key}: ${r.count}件`).join('\n') || '（なし）'}

【時間帯別件数】
${slotRows.map((r) => `- ${r.key}: ${r.count}件`).join('\n') || '（なし）'}

【参考メモ（抜粋・最大12件。個人名は出力に含めない）】
${JSON.stringify(samples, null, 2)}

出力は次の構成で、見出し付き箇条書きを中心に（総括・種類の傾向・時間帯の傾向・リスク要因の推測・今月の重点対策案・記録上の留意）。推測は「〜の可能性」として書き、断定しすぎないこと。`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.25, maxOutputTokens: 2048 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(data?.error?.message ?? 'AI応答なし');
  return stripJsonFence(text);
}

/**
 * 指定月のヒヤリハット（気づき）をカテゴリ・時間帯で集計。発生日未入力は保存月で判定。
 * @param {string} yearMonth YYYY-MM
 * @param {{ facilityLabel?: string; department?: string }} [filters]
 */
export function aggregateNearMissMonthlySummary(yearMonth, filters = {}) {
  const ym = String(yearMonth ?? '').trim();
  const fac = String(filters.facilityLabel ?? '').trim();
  const dep = String(filters.department ?? '').trim();
  const all = getNearMissReports();
  /** @type {Record<string, number>} */
  const byCategory = {};
  /** @type {Record<string, number>} */
  const bySlot = {};
  const records = [];
  let total = 0;

  for (const row of all) {
    if (fac && String(row.facilityLabel ?? '').trim() !== fac) continue;
    if (dep && String(row.department ?? '').trim() !== dep) continue;

    const ymd = nearMissOccurrenceYmdFromDraft(row.draft);
    let rowYm;
    if (ymd) rowYm = ymd.slice(0, 7);
    else {
      const d = new Date(String(row.savedAt ?? ''));
      if (!Number.isFinite(d.getTime())) continue;
      rowYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    if (rowYm !== ym) continue;

    const hour = parseOccurHour24(row.draft);
    const slot = hourToTimeSlot(hour);
    const cats = classifyNearMissRecordCategories(row.draft);
    total += 1;
    for (const c of cats) {
      byCategory[c] = (byCategory[c] ?? 0) + 1;
    }
    bySlot[slot] = (bySlot[slot] ?? 0) + 1;
    records.push({
      ...row,
      _occurrenceYmd: ymd || String(row.savedAt ?? '').slice(0, 10),
      _hour24: hour,
      _slot: slot,
      _categories: cats,
    });
  }
  records.sort((a, b) => {
    const c = String(b._occurrenceYmd).localeCompare(String(a._occurrenceYmd));
    if (c !== 0) return c;
    return String(b.savedAt).localeCompare(String(a.savedAt));
  });
  return {
    total,
    byCategory,
    bySlot,
    records,
    yearMonth: ym,
    filters: { facilityLabel: fac, department: dep },
  };
}

/**
 * @param {ReturnType<typeof aggregateNearMissMonthlySummary>} agg
 * @param {string} [assessmentText]
 */
export function buildNearMissMonthlyAnalysisHtml(agg, assessmentText = '') {
  const catRows = sortedCountRows(agg.byCategory, NEAR_MISS_MONTH_CATEGORY_ORDER);
  const slotRows = sortedCountRows(agg.bySlot, ACCIDENT_SLOT_ORDER);
  const fac = agg.filters?.facilityLabel ? escapeHtml(agg.filters.facilityLabel) : '全施設';
  const dep = agg.filters?.department ? escapeHtml(agg.filters.department) : '全部署';
  const ym = escapeHtml(agg.yearMonth);
  const catTable =
    catRows.length === 0
      ? '<tr><td colspan="2">該当なし</td></tr>'
      : catRows.map((r) => `<tr><td>${escapeHtml(r.key)}</td><td style="text-align:right">${r.count}</td></tr>`).join('');
  const slotTable =
    slotRows.length === 0
      ? '<tr><td colspan="2">該当なし</td></tr>'
      : slotRows.map((r) => `<tr><td>${escapeHtml(r.key)}</td><td style="text-align:right">${r.count}</td></tr>`).join('');
  const listRows = agg.records
    .slice(0, 80)
    .map((r) => {
      const name = escapeHtml(String(r.draft?.residentName ?? '').trim() || '—');
      const cats = escapeHtml((r._categories ?? []).join('・'));
      const sl = escapeHtml(String(r._slot));
      const dept = escapeHtml(String(r.department ?? ''));
      return `<tr><td>${escapeHtml(String(r._occurrenceYmd))}</td><td>${dept}</td><td>${name}</td><td>${cats}</td><td>${sl}</td></tr>`;
    })
    .join('');
  const assess = nl2br(String(assessmentText ?? '').trim() || '（未生成。ブラウザ上で「アセスメント生成」を実行してください。）');

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/><title>ヒヤリ月次分析 ${agg.yearMonth}</title>
<style>
body{font-family:system-ui,sans-serif;padding:16px;color:#111}
h1{font-size:20px;border-bottom:2px solid #0f766e;padding-bottom:8px}
h2{font-size:16px;margin:20px 0 8px}
.meta{color:#555;font-size:13px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;max-width:720px;font-size:13px;margin-top:8px}
th,td{border:1px solid #ccc;padding:8px;text-align:left}
th{background:#ecfdf5}
.box{border:1px solid #333;padding:12px;margin:16px 0;background:#fafafa;white-space:pre-wrap}
@media print{.no-print{display:none}}
</style></head><body>
<h1>ヒヤリハット（気づき）月次集計・アセスメント</h1>
<div class="meta">対象月: <strong>${ym}</strong> ／ 施設: <strong>${fac}</strong> ／ 部署: <strong>${dep}</strong> ／ 件数: <strong>${agg.total}</strong>（カテゴリ別件数は複数選択で重複加算の場合あり）</div>
<h2>カテゴリ別 件数</h2>
<table><thead><tr><th>カテゴリ</th><th>件数</th></tr></thead><tbody>${catTable}</tbody></table>
<h2>発生時間帯別 件数</h2>
<table><thead><tr><th>時間帯</th><th>件数</th></tr></thead><tbody>${slotTable}</tbody></table>
<h2>アセスメント（参考）</h2>
<div class="box">${assess}</div>
<h2>明細（最大80件）</h2>
<table><thead><tr><th>発生日または保存日</th><th>部署</th><th>利用者</th><th>カテゴリ</th><th>時間帯</th></tr></thead><tbody>${
    listRows || '<tr><td colspan="5">該当なし</td></tr>'
  }</tbody></table>
<p class="no-print" style="margin-top:24px;font-size:12px;color:#666">施設ポータル — ブラウザの印刷から PDF 保存できます。</p>
</body></html>`;
}

/** @param {ReturnType<typeof aggregateNearMissMonthlySummary>} agg */
export function buildNearMissMonthlyCsv(agg) {
  const header = ['発生日または保存日', '保存日時', '施設', '部署', '利用者名', 'カテゴリ', '時間帯', '状況要約'];
  const lines = [header.join(',')];
  for (const r of agg.records) {
    const sit = String(r.draft?.situationContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    lines.push(
      [
        r._occurrenceYmd,
        r.savedAt,
        r.facilityLabel,
        r.department,
        r.draft?.residentName ?? '',
        (r._categories ?? []).join('・'),
        r._slot,
        sit,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

/**
 * @param {string} apiKey
 * @param {ReturnType<typeof aggregateNearMissMonthlySummary>} agg
 */
export async function fetchNearMissMonthlyAssessmentAi(apiKey, agg) {
  if (!apiKey?.trim()) {
    return 'API キー未設定のため、集計表のみご利用ください。傾向は「カテゴリ別」「時間帯別」の件数からご判断ください。';
  }
  const catRows = sortedCountRows(agg.byCategory, NEAR_MISS_MONTH_CATEGORY_ORDER);
  const slotRows = sortedCountRows(agg.bySlot, ACCIDENT_SLOT_ORDER);
  const samples = agg.records.slice(0, 12).map((r) => ({
    categories: r._categories,
    slot: r._slot,
    dept: r.department,
    situation: String(r.draft?.situationContent ?? '').slice(0, 400),
    causeAndMeasures: String(r.draft?.causeAndMeasures ?? '').slice(0, 200),
  }));
  const prompt = `あなたは介護・看護の安全管理者です。次の「1か月分のヒヤリハット（気づき）報告の集計（同一ブラウザに保存された記録）」を踏まえ、施設内アセスメントとして日本語で簡潔にまとめてください。

【集計条件】対象月: ${agg.yearMonth} / 施設フィルタ: ${agg.filters?.facilityLabel || '全施設'} / 部署フィルタ: ${agg.filters?.department || '全部署'} / 報告件数（1報告＝1件）: ${agg.total}

【カテゴリ別件数】※1件で複数カテゴリのときは複数カウントされる場合があります
${catRows.map((r) => `- ${r.key}: ${r.count}`).join('\n') || '（なし）'}

【時間帯別件数】
${slotRows.map((r) => `- ${r.key}: ${r.count}件`).join('\n') || '（なし）'}

【参考メモ（抜粋・最大12件。個人名は出力に含めない）】
${JSON.stringify(samples, null, 2)}

出力は次の構成で、見出し付き箇条書きを中心に（総括・カテゴリの傾向・時間帯の傾向・再発防止の観点・今月の重点教育・記録上の留意）。推測は「〜の可能性」として書き、断定しすぎないこと。`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.25, maxOutputTokens: 2048 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  let res;
  /** @type {any} */
  let data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e);
    throw new Error(
      [
        '【通信に失敗しました】',
        'インターネット接続やブラウザの制限（広告ブロック等）を確認してください。',
        '',
        '────────',
        '（技術）',
        hint,
      ].join('\n')
    );
  }

  if (data?.error) {
    throw new Error(formatGeminiGenerateContentErrorMessage(data, res.status));
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!String(text ?? '').trim()) {
    throw new Error(formatGeminiGenerateContentErrorMessage(data, res.status));
  }
  return stripJsonFence(String(text));
}

/**
 * 最終勤務尿（シフト終了時の排尿記録）印刷用HTML
 * @param {{
 *   facilityLabel?: string;
 *   recordDate?: string;
 *   recordTime?: string;
 *   shiftKind?: string;
 *   residentName?: string;
 *   room?: string;
 *   urineMl?: string;
 *   appearance?: string;
 *   catheterNote?: string;
 *   note?: string;
 *   recorderName?: string;
 * }} [draft]
 */
export function buildLastShiftUrineFormHtml(draft = {}) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const v = (k) => String(d[k] ?? '').trim();
  const facilityLabel = v('facilityLabel');
  const recordDate = v('recordDate');
  const recordTime = v('recordTime');
  const shiftKind = v('shiftKind');
  const residentName = v('residentName');
  const room = v('room');
  const urineMl = v('urineMl');
  const appearance = v('appearance');
  const catheterNote = v('catheterNote');
  const note = v('note');
  const recorderName = v('recorderName');
  const title = '最終勤務尿（排尿記録）';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;padding:18px;color:#111;max-width:720px;margin:0 auto;line-height:1.55;font-size:13px}
  h1{font-size:1.25rem;border-bottom:2px solid #0f766e;padding-bottom:8px;margin:0 0 12px 0}
  .meta{color:#64748b;font-size:0.82rem;margin-bottom:14px}
  table{border-collapse:collapse;width:100%;margin-top:8px}
  th,td{border:1px solid #94a3b8;padding:8px 10px;text-align:left;vertical-align:top}
  th{width:9.5rem;background:#f1f5f9;font-weight:700}
  .free{min-height:4.5rem}
  @media print{.no-print{display:none}body{padding:12px}}
</style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">紙の様式に合わせて運用・文言は現場で調整してください。ブラウザの印刷で PDF 保存できます。</div>
  <table>
    <tr><th>事業所</th><td>${escapeHtml(facilityLabel || '（未入力）')}</td></tr>
    <tr><th>記録日</th><td>${escapeHtml(recordDate || '（未入力）')}</td></tr>
    <tr><th>記録時刻</th><td>${escapeHtml(recordTime || '（未入力）')}</td></tr>
    <tr><th>勤務帯</th><td>${escapeHtml(shiftKind || '（未入力）')}</td></tr>
    <tr><th>利用者氏名</th><td>${escapeHtml(residentName || '（未入力）')}</td></tr>
    <tr><th>居室</th><td>${escapeHtml(room || '（未入力）')}</td></tr>
    <tr><th>排尿量</th><td>${escapeHtml(urineMl || '（未入力）')}</td></tr>
    <tr><th>性状・色など</th><td class="free">${nl2br(appearance || '（未入力）')}</td></tr>
    <tr><th>カテーテル・バルーン等</th><td class="free">${nl2br(catheterNote || '（未入力）')}</td></tr>
    <tr><th>特記事項</th><td class="free">${nl2br(note || '（未入力）')}</td></tr>
    <tr><th>記録者</th><td>${escapeHtml(recorderName || '（未入力）')}</td></tr>
  </table>
  <p class="no-print" style="margin-top:18px;font-size:11px;color:#94a3b8">施設ポータル — ${escapeHtml(title)}</p>
</body></html>`;
}

export function openPrintableSummary(html) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
}

export function downloadSummaryHtml(filename, html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
