/**
 * 施設別「利用者お予定表」Google スプレッドシート
 * linkKey は carelinkFacilities.js と一致
 */

/** @typedef {{
 *   facilityLinkKey: string;
 *   label: string;
 *   spreadsheetId: string;
 *   sheetGid: number;
 *   rangeA1?: string;
 * }} ResidentScheduleSheetConfig */

/** @type {Readonly<Record<string, ResidentScheduleSheetConfig>>} */
export const RESIDENT_SCHEDULE_SHEETS = Object.freeze({
  千音寺: Object.freeze({
    facilityLinkKey: '千音寺',
    label: '千音寺 利用者お予定表',
    spreadsheetId:
      String(import.meta.env.VITE_CHIONJI_SCHEDULE_SPREADSHEET_ID ?? '').trim() ||
      '13RITcPVJ6nllshCvbeVBZs4-HNkCYUi0',
    sheetGid: Number(import.meta.env.VITE_CHIONJI_SCHEDULE_SHEET_GID ?? 1590360619) || 1590360619,
    rangeA1: 'A1:ZZ150',
  }),
});

/** @param {string} linkKey */
export function residentScheduleSheetForFacility(linkKey) {
  const k = String(linkKey ?? '').trim();
  return RESIDENT_SCHEDULE_SHEETS[k] ?? null;
}
