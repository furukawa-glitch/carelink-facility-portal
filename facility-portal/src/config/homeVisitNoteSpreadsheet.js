/**
 * 施設ごとの往診ノート Google スプレッドシート（現場で運用中のブック）
 * @typedef {{ spreadsheetId: string; sheetGid: number; url: string; layout?: 'aisai' | 'standard' }} HomeVisitNoteSheetConfig
 */

const AISAI_HOME_VISIT_NOTE = Object.freeze({
  spreadsheetId:
    import.meta.env.VITE_HOME_VISIT_NOTE_AISAI_SPREADSHEET_ID?.trim() ||
    '1vr4dmFMCVciy_aO5slG5AlofXAFC3xZ7BvePY-qoh_8',
  sheetGid: Number(import.meta.env.VITE_HOME_VISIT_NOTE_AISAI_SHEET_GID ?? 761102755) || 761102755,
  url:
    'https://docs.google.com/spreadsheets/d/1vr4dmFMCVciy_aO5slG5AlofXAFC3xZ7BvePY-qoh_8/edit#gid=761102755',
  layout: /** @type {const} */ ('aisai'),
});

/** @type {Readonly<Record<string, HomeVisitNoteSheetConfig>>} */
export const HOME_VISIT_NOTE_SPREADSHEETS = Object.freeze({
  愛西: AISAI_HOME_VISIT_NOTE,
});

/**
 * @param {string} linkKey
 * @returns {HomeVisitNoteSheetConfig | null}
 */
export function homeVisitNoteSheetConfigForLinkKey(linkKey) {
  return HOME_VISIT_NOTE_SPREADSHEETS[String(linkKey ?? '').trim()] ?? null;
}

/**
 * @param {import('./homeVisitNoteSpreadsheet.js').HomeVisitNoteSheetConfig | null | undefined} cfg
 */
export function homeVisitNoteUsesAisaiLayout(cfg) {
  return cfg?.layout === 'aisai';
}
