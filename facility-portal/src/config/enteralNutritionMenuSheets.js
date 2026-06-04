/**
 * 施設別「経管栄養メニュー」Google スプレッドシート（Excel を Drive に置いた形式も可）
 * linkKey は carelinkFacilities.js と一致
 */

const DEFAULT_SPREADSHEET_ID =
  String(import.meta.env.VITE_ENTERAL_MENU_SPREADSHEET_ID ?? '').trim() ||
  '1lBjlbxALGX5dTwtRuIE1WELMWenIqYrT';

const DEFAULT_SHEET_GID = Number(import.meta.env.VITE_ENTERAL_MENU_SHEET_GID ?? 0) || 0;

/** @typedef {{
 *   facilityLinkKey: string;
 *   label: string;
 *   spreadsheetId: string;
 *   sheetGid: number;
 *   rangeA1?: string;
 * }} EnteralMenuSheetConfig */

/** @type {Readonly<Record<string, EnteralMenuSheetConfig>>} */
const BY_FACILITY = Object.freeze({
  千音寺: Object.freeze({
    facilityLinkKey: '千音寺',
    label: '経管栄養メニュー表',
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    sheetGid: DEFAULT_SHEET_GID,
    rangeA1: 'A1:ZZ200',
  }),
  愛西: Object.freeze({
    facilityLinkKey: '愛西',
    label: '経管栄養メニュー表',
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    sheetGid: DEFAULT_SHEET_GID,
    rangeA1: 'A1:ZZ200',
  }),
  北名古屋: Object.freeze({
    facilityLinkKey: '北名古屋',
    label: '経管栄養メニュー表',
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    sheetGid: DEFAULT_SHEET_GID,
    rangeA1: 'A1:ZZ200',
  }),
  起: Object.freeze({
    facilityLinkKey: '起',
    label: '経管栄養メニュー表',
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    sheetGid: DEFAULT_SHEET_GID,
    rangeA1: 'A1:ZZ200',
  }),
  一宮: Object.freeze({
    facilityLinkKey: '一宮',
    label: '経管栄養メニュー表',
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    sheetGid: DEFAULT_SHEET_GID,
    rangeA1: 'A1:ZZ200',
  }),
  中川本館: Object.freeze({
    facilityLinkKey: '中川本館',
    label: '経管栄養メニュー表',
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    sheetGid: DEFAULT_SHEET_GID,
    rangeA1: 'A1:ZZ200',
  }),
});

/** @param {string} linkKey */
export function enteralMenuSheetForFacility(linkKey) {
  const k = String(linkKey ?? '').trim();
  if (BY_FACILITY[k]) return BY_FACILITY[k];
  if (!DEFAULT_SPREADSHEET_ID) return null;
  return {
    facilityLinkKey: k || '_default',
    label: '経管栄養メニュー表',
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    sheetGid: DEFAULT_SHEET_GID,
    rangeA1: 'A1:ZZ200',
  };
}
