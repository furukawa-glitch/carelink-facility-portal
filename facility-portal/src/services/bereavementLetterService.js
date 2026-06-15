/**
 * ご逝去後、約半年経過時にご家族へお送りする手紙の管理（localStorage）
 */

import { listMoveInOutLogs } from './moveInOutLogService.js';

const LS_DRAFTS = 'carelink_bereavement_letter_drafts_v1';
const FOLLOW_UP_MONTHS = 6;

/**
 * @typedef {{
 *   familySalutation: string;
 *   body: string;
 *   directorClosing: string;
 *   mailedAt: string;
 *   acknowledgedAt: string;
 *   updatedAt: string;
 * }} BereavementLetterDraft
 */

/**
 * @typedef {{
 *   logId: string;
 *   residentName: string;
 *   facilityLinkKey: string;
 *   tabLabel: string;
 *   gender: 'male' | 'female' | '';
 *   deathDate: string;
 *   followUpDate: string;
 *   daysUntilFollowUp: number;
 *   isDue: boolean;
 *   isMailed: boolean;
 *   note: string;
 *   draft: BereavementLetterDraft;
 * }} BereavementLetterEntry
 */

/** @returns {Record<string, BereavementLetterDraft>} */
function readDrafts() {
  try {
    const raw = localStorage.getItem(LS_DRAFTS);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, BereavementLetterDraft>} all */
function writeDrafts(all) {
  localStorage.setItem(LS_DRAFTS, JSON.stringify(all));
}

/**
 * @param {string} ymd
 * @param {number} months
 * @returns {string}
 */
export function addMonthsToYmd(ymd, months) {
  const m = String(ymd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (!Number.isFinite(d.getTime())) return '';
  d.setMonth(d.getMonth() + months);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** @param {string} ymd */
function todayYmdLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {number}
 */
export function daysBetweenYmd(fromYmd, toYmd) {
  const a = String(fromYmd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const b = String(toYmd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!a || !b) return 0;
  const da = new Date(parseInt(a[1], 10), parseInt(a[2], 10) - 1, parseInt(a[3], 10));
  const db = new Date(parseInt(b[1], 10), parseInt(b[2], 10) - 1, parseInt(b[3], 10));
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

/** @param {string} logId @returns {BereavementLetterDraft} */
export function getBereavementLetterDraft(logId) {
  const id = String(logId ?? '').trim();
  const all = readDrafts();
  const cur = all[id];
  if (cur && typeof cur === 'object') {
    return {
      familySalutation: String(cur.familySalutation ?? '').trim(),
      body: String(cur.body ?? '').trim(),
      directorClosing: String(cur.directorClosing ?? '').trim() || '施設長 一同',
      mailedAt: String(cur.mailedAt ?? '').trim(),
      acknowledgedAt: String(cur.acknowledgedAt ?? '').trim(),
      updatedAt: String(cur.updatedAt ?? '').trim(),
    };
  }
  return {
    familySalutation: '',
    body: '',
    directorClosing: '施設長 一同',
    mailedAt: '',
    acknowledgedAt: '',
    updatedAt: '',
  };
}

/**
 * @param {string} logId
 * @param {Partial<BereavementLetterDraft>} patch
 */
export function setBereavementLetterDraft(logId, patch) {
  const id = String(logId ?? '').trim();
  if (!id) return;
  const all = readDrafts();
  const prev = getBereavementLetterDraft(id);
  all[id] = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeDrafts(all);
}

/** @param {string} logId */
export function markBereavementLetterMailed(logId) {
  setBereavementLetterDraft(logId, { mailedAt: todayYmdLocal() });
}

/** @param {string} logId */
export function acknowledgeBereavementLetter(logId) {
  setBereavementLetterDraft(logId, { acknowledgedAt: todayYmdLocal() });
}

/**
 * 死亡退去ログを手紙対象として列挙
 * @param {{ facilityLinkKey?: string }} [opts]
 * @returns {BereavementLetterEntry[]}
 */
export function listBereavementLetterEntries(opts = {}) {
  const facilityFilter = String(opts.facilityLinkKey ?? '').trim();
  const today = todayYmdLocal();
  const logs = listMoveInOutLogs().filter(
    (x) =>
      x.kind === 'move_out' &&
      x.moveOutReason === 'death' &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(x.eventDate ?? '').trim()) &&
      (!facilityFilter || String(x.facilityLinkKey ?? '').trim() === facilityFilter)
  );

  /** @type {BereavementLetterEntry[]} */
  const out = [];
  for (const x of logs) {
    const logId = String(x.id ?? '').trim();
    const deathDate = String(x.eventDate ?? '').trim();
    const followUpDate = addMonthsToYmd(deathDate, FOLLOW_UP_MONTHS);
    if (!logId || !followUpDate) continue;
    const draft = getBereavementLetterDraft(logId);
    const daysUntilFollowUp = daysBetweenYmd(today, followUpDate);
    const isMailed = Boolean(draft.mailedAt);
    const isDue = !isMailed && daysUntilFollowUp <= 0;
    out.push({
      logId,
      residentName: String(x.residentName ?? '').trim(),
      facilityLinkKey: String(x.facilityLinkKey ?? '').trim(),
      tabLabel: String(x.tabLabel ?? '').trim(),
      gender: x.gender === 'female' ? 'female' : x.gender === 'male' ? 'male' : '',
      deathDate,
      followUpDate,
      daysUntilFollowUp,
      isDue,
      isMailed,
      note: String(x.note ?? '').trim(),
      draft,
    });
  }

  return out.sort((a, b) => {
    if (a.isDue !== b.isDue) return a.isDue ? -1 : 1;
    if (a.isMailed !== b.isMailed) return a.isMailed ? 1 : -1;
    return String(a.followUpDate).localeCompare(String(b.followUpDate));
  });
}

/** @returns {number} */
export function countDueBereavementLetters() {
  return listBereavementLetterEntries().filter((x) => x.isDue).length;
}

/** @param {string} name @param {'male'|'female'|''} gender */
export function defaultFamilySalutation(name, gender = '') {
  const n = String(name ?? '').trim();
  if (!n) return 'ご家族各位';
  const honorific = gender === 'male' ? '様' : gender === 'female' ? '様' : '様';
  return `${n}${honorific} ご家族各位`;
}
