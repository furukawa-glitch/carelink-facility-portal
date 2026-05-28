/**
 * 入居・退去の手入力ログ（このブラウザの localStorage のみ。名簿スプレッドシートとは別）
 */

import { CARELINK_FACILITIES } from '../config/carelinkFacilities.js';

const LS_KEY = 'carelink_move_in_out_log_v1';
const MAX_ROWS = 3000;

/**
 * @typedef {{
 *   id: string;
 *   facilityLinkKey: string;
 *   tabLabel: string;
 *   kind: 'move_in' | 'move_out' | 'hospital';
 *   eventDate: string;
 *   residentName: string;
 *   gender: 'male' | 'female' | '';
 *   moveOutReason: 'after_hospital' | 'death' | 'transfer_facility' | '';
 *   note: string;
 *   createdAt: string;
 * }} MoveInOutLogRow
 */

/** @returns {MoveInOutLogRow[]} */
export function listMoveInOutLogs() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** @param {MoveInOutLogRow[]} list */
function saveLogs(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_ROWS)));
}

/**
 * @param {{
 *   facilityLinkKey: string;
 *   tabLabel: string;
 *   kind: 'move_in' | 'move_out' | 'hospital';
 *   eventDate: string;
 *   residentName?: string;
 *   gender?: 'male' | 'female' | '';
 *   moveOutReason?: 'after_hospital' | 'death' | 'transfer_facility' | '';
 *   note?: string;
 * }} entry
 * @returns {MoveInOutLogRow}
 */
export function addMoveInOutLog(entry) {
  const list = listMoveInOutLogs();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const kind =
    entry.kind === 'move_out' ? 'move_out' : entry.kind === 'hospital' ? 'hospital' : 'move_in';
  const mor = String(entry.moveOutReason ?? '').trim();
  const moveOutReason =
    kind === 'move_out' && ['after_hospital', 'death', 'transfer_facility'].includes(mor)
      ? /** @type {'after_hospital' | 'death' | 'transfer_facility'} */ (mor)
      : '';
  const row = {
    id,
    facilityLinkKey: String(entry.facilityLinkKey ?? '').trim(),
    tabLabel: String(entry.tabLabel ?? '').trim(),
    kind,
    eventDate: String(entry.eventDate ?? '').trim(),
    residentName: String(entry.residentName ?? '').trim(),
    gender:
      entry.gender === 'female' ? 'female' : entry.gender === 'male' ? 'male' : '',
    moveOutReason,
    note: String(entry.note ?? '').trim(),
    createdAt: new Date().toISOString(),
  };
  list.unshift(row);
  saveLogs(list);
  return row;
}

/** @param {string} id */
export function removeMoveInOutLog(id) {
  const list = listMoveInOutLogs().filter((x) => String(x.id) !== String(id));
  saveLogs(list);
}

/**
 * 施設別に入居・退去・入院件数（指定月の eventDate のみ）
 * @param {string} yearMonth YYYY-MM 空なら全期間
 * @returns {{ linkKey: string; tabLabel: string; moveIn: number; moveOut: number; hospital: number }[]}
 */
export function aggregateMoveInOutByFacility(yearMonth) {
  const list = listMoveInOutLogs();
  const ym = String(yearMonth ?? '').trim();
  const filtered = ym ? list.filter((x) => String(x.eventDate ?? '').startsWith(ym)) : list;

  /** @type {Record<string, { linkKey: string; tabLabel: string; moveIn: number; moveOut: number; hospital: number }>} */
  const byKey = {};
  for (const f of CARELINK_FACILITIES) {
    byKey[f.linkKey] = {
      linkKey: f.linkKey,
      tabLabel: f.tabLabel,
      moveIn: 0,
      moveOut: 0,
      hospital: 0,
    };
  }
  for (const x of filtered) {
    const k = String(x.facilityLinkKey ?? '').trim();
    if (!k) continue;
    if (!byKey[k]) {
      byKey[k] = {
        linkKey: k,
        tabLabel: String(x.tabLabel ?? k).trim() || k,
        moveIn: 0,
        moveOut: 0,
        hospital: 0,
      };
    }
    if (x.kind === 'move_out') byKey[k].moveOut += 1;
    else if (x.kind === 'hospital') byKey[k].hospital += 1;
    else byKey[k].moveIn += 1;
  }
  return Object.values(byKey).sort((a, b) => a.tabLabel.localeCompare(b.tabLabel, 'ja'));
}

/**
 * @param {string} [yearMonth]
 * @param {number} [limit]
 * @returns {MoveInOutLogRow[]}
 */
export function listMoveInOutLogsFiltered(yearMonth, limit = 200) {
  let list = listMoveInOutLogs();
  const ym = String(yearMonth ?? '').trim();
  if (ym) list = list.filter((x) => String(x.eventDate ?? '').startsWith(ym));
  list = [...list].sort((a, b) => {
    const da = String(a.eventDate ?? '').localeCompare(String(b.eventDate ?? ''));
    if (da !== 0) return -da;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  });
  return list.slice(0, limit);
}

/** @returns {string} */
export function moveInOutLogsToCsv() {
  const list = listMoveInOutLogs();
  const head = [
    'id',
    'facilityLinkKey',
    'tabLabel',
    'kind',
    'eventDate',
    'residentName',
    'gender',
    'moveOutReason',
    'note',
    'createdAt',
  ];
  const lines = [head.join(',')];
  for (const x of list) {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const g = x.gender === 'female' ? 'female' : x.gender === 'male' ? 'male' : '';
    const r = String(x.moveOutReason ?? '').trim();
    const mor =
      x.kind === 'move_out' && ['after_hospital', 'death', 'transfer_facility'].includes(r) ? r : '';
    lines.push(
      [
        esc(x.id),
        esc(x.facilityLinkKey),
        esc(x.tabLabel),
        esc(x.kind),
        esc(x.eventDate),
        esc(x.residentName),
        esc(g),
        esc(mor),
        esc(x.note),
        esc(x.createdAt),
      ].join(',')
    );
  }
  return lines.join('\r\n');
}
