/** ヒヤリハット管理簿（スプレッドシート）のシート名・列定義 */

export const NEAR_MISS_REPORT_SHEET_NAME = '報告';
export const NEAR_MISS_ACK_SHEET_NAME = '確認ログ';

/**
 * 報告シートの1行目（日本語見出し）
 * Google Apps Script の ensureReportHeader_ と揃えること
 *
 * 「カテゴリ」列は先頭に運営会社（ケアサポート／ブレインエナジー）と報告種別（ヒヤリハット／事故報告）を自動付与し、続けてユーザー選択カテゴリを連結する。
 */
export const REPORT_SHEET_HEADERS = Object.freeze([
  'レコードID',
  '作成日時',
  '施設キー',
  '重要度',
  'カテゴリ',
  'タイトル',
  '概要',
  '下書きJSON',
  'アーカイブ',
]);

/**
 * 内部処理用キー（reportRowToNotice 等。列順は REPORT_SHEET_HEADERS と一致）
 */
export const REPORT_FIELD_KEYS = Object.freeze([
  'recordId',
  'createdAt',
  'facilityLinkKey',
  'importance',
  'categories',
  'title',
  'summary',
  'draftJson',
  'archived',
]);

/** 旧版スプレッドシートの英語見出し（読み取り互換） */
export const REPORT_SHEET_HEADERS_LEGACY_EN = Object.freeze([
  'recordId',
  'createdAt',
  'facilityLinkKey',
  'importance',
  'categories',
  'title',
  'summary',
  'draftJson',
  'archived',
]);

/**
 * @param {string[]} head 1行目のセル値
 * @param {number} colIdx 列インデックス（0〜）
 */
export function reportSheetColumnIndex(head, colIdx) {
  const h = head.map((c) => String(c ?? '').trim());
  const ja = REPORT_SHEET_HEADERS[colIdx];
  const legacy = REPORT_SHEET_HEADERS_LEGACY_EN[colIdx];
  let i = h.findIndex((x) => x === ja);
  if (i >= 0) return i;
  i = h.findIndex((x) => x === legacy);
  if (i >= 0) return i;
  return colIdx;
}

/** 確認ログシートの1行目（日本語） */
export const ACK_SHEET_HEADERS = Object.freeze([
  'ログID',
  '周知ID',
  '施設キー',
  '職員ID',
  '職員名',
  '確認日時',
]);

export const ACK_FIELD_KEYS = Object.freeze([
  'logId',
  'noticeId',
  'facilityLinkKey',
  'staffId',
  'staffName',
  'confirmedAt',
]);

export const ACK_SHEET_HEADERS_LEGACY_EN = Object.freeze([
  'logId',
  'noticeId',
  'facilityLinkKey',
  'staffId',
  'staffName',
  'confirmedAt',
]);

/**
 * @param {string[]} head
 * @param {number} colIdx
 */
export function ackSheetColumnIndex(head, colIdx) {
  const h = head.map((c) => String(c ?? '').trim());
  const ja = ACK_SHEET_HEADERS[colIdx];
  const legacy = ACK_SHEET_HEADERS_LEGACY_EN[colIdx];
  let i = h.findIndex((x) => x === ja);
  if (i >= 0) return i;
  i = h.findIndex((x) => x === legacy);
  if (i >= 0) return i;
  return colIdx;
}
