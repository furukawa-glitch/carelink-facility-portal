import { currentYmd, getResidentDailyPlans, setResidentDailyPlans } from './residentDailySchedule.js';
import { personNameMatchKey } from './residentNameMatch.js';

const LS_KEY = 'carelink_os_bath_schedule_v1';

export const BATH_KIND_OPTIONS = Object.freeze([
  '',
  '一般浴',
  '機械浴',
  'シャワー',
  '清拭',
  '×',
]);

const WEEKDAY_JA = ['月', '火', '水', '木', '金', '土', '日'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function readStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(all) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all && typeof all === 'object' ? all : {}));
  } catch {
    /* ignore */
  }
}

/** @param {string} ymd */
export function addDaysYmd(ymd, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return currentYmd();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** その週の月曜（YYYY-MM-DD） */
export function mondayOfWeek(ymd = currentYmd()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return currentYmd();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** @param {string} weekStartYmd 月曜 */
export function weekYmdsFromMonday(weekStartYmd) {
  const start = mondayOfWeek(weekStartYmd);
  return Array.from({ length: 7 }, (_, i) => addDaysYmd(start, i));
}

/** @param {string} ymd */
export function weekdayLabelJa(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return WEEKDAY_JA[(d.getDay() + 6) % 7] ?? '';
}

function normalizeDayEntry(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const kind = String(s.kind ?? '').trim();
  return {
    time: String(s.time ?? '').trim(),
    kind: BATH_KIND_OPTIONS.includes(kind) ? kind : '',
    note: String(s.note ?? '').trim(),
  };
}

function normalizeRow(raw, res) {
  const id = String(raw?.residentId ?? res?.id ?? '').trim();
  const nameRaw = String(raw?.name ?? res?.name ?? '').trim();
  const name = nameRaw.replace(/様\s*$/u, '') ? `${nameRaw.replace(/様\s*$/u, '')} 様` : '—';
  const daysRaw = raw?.days && typeof raw.days === 'object' ? raw.days : {};
  /** @type {Record<string, { time: string; kind: string; note: string }>} */
  const days = {};
  for (const [ymd, entry] of Object.entries(daysRaw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    days[ymd] = normalizeDayEntry(entry);
  }
  return {
    residentId: id,
    name,
    room: String(raw?.room ?? res?.room ?? '').trim(),
    days,
  };
}

function rowHasBath(row) {
  return Object.values(row?.days ?? {}).some((d) => {
    const kind = String(d?.kind ?? '').trim();
    return kind && kind !== '×';
  });
}

function dayEntryHasInput(entry) {
  const d = entry && typeof entry === 'object' ? entry : {};
  return Boolean(String(d.time ?? '').trim() || String(d.kind ?? '').trim() || String(d.note ?? '').trim());
}

function mergeDayMaps(...maps) {
  /** @type {Record<string, { time: string; kind: string; note: string }>} */
  const out = {};
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const [ymd, entry] of Object.entries(map)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
      const next = normalizeDayEntry(entry);
      const prev = out[ymd];
      if (!prev) out[ymd] = next;
      else if (dayEntryHasInput(next)) out[ymd] = next;
    }
  }
  return out;
}

function savedRowForResident(saved, res) {
  const list = Array.isArray(saved) ? saved : [];
  const id = String(res?.id ?? '').trim();
  const byId = list.find((r) => String(r?.residentId ?? '').trim() === id);
  if (byId) return byId;
  const wantKey = personNameMatchKey(String(res?.name ?? ''));
  if (!wantKey) return null;
  return (
    list.find((r) => personNameMatchKey(String(r?.name ?? '')) === wantKey) ??
    list.find((r) => personNameMatchKey(parseNameFromResidentId(r?.residentId)) === wantKey) ??
    null
  );
}

function parseNameFromResidentId(id) {
  const parts = String(id ?? '')
    .split('::')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 4) return parts[2];
  if (parts.length === 3) return parts[1];
  return '';
}

/**
 * @param {Record<string, unknown>[]} roster
 * @param {import('./bathingSchedule.js').BathScheduleRow[]} [savedRows]
 * @param {import('./bathingSchedule.js').BathScheduleRow[]} [currentRows] 画面上の未保存行
 */
export function mergeBathScheduleRows(roster, savedRows, currentRows = []) {
  const list = Array.isArray(roster) ? roster : [];
  const saved = Array.isArray(savedRows) ? savedRows : [];
  const current = Array.isArray(currentRows) ? currentRows : [];
  const rows = list.map((res) => {
    const id = String(res.id);
    const savedRow = savedRowForResident(saved, res);
    const liveRow = current.find(
      (r) =>
        String(r?.residentId ?? '').trim() === id ||
        personNameMatchKey(String(r?.name ?? '')) === personNameMatchKey(String(res?.name ?? ''))
    );
    const days = mergeDayMaps(savedRow?.days, liveRow?.days);
    return normalizeRow({ residentId: id, name: res.name, room: res.room, days }, res);
  });
  const usedKeys = new Set(rows.map((r) => personNameMatchKey(String(r.name ?? ''))));
  for (const s of saved) {
    const id = String(s.residentId ?? '').trim();
    const nameKey = personNameMatchKey(String(s.name ?? parseNameFromResidentId(id)));
    if (id && rows.some((r) => r.residentId === id)) continue;
    if (nameKey && usedKeys.has(nameKey)) continue;
    if (!rowHasBath(s)) continue;
    rows.push(normalizeRow(s, { id, name: s.name, room: s.room }));
    if (nameKey) usedKeys.add(nameKey);
  }
  return rows.sort((a, b) => {
    const ra = String(a.room ?? '').trim();
    const rb = String(b.room ?? '').trim();
    if (ra && rb && ra !== rb) return ra.localeCompare(rb, 'ja', { numeric: true });
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ja');
  });
}

/**
 * @typedef {{
 *   residentId: string;
 *   name: string;
 *   room: string;
 *   days: Record<string, { time: string; kind: string; note: string }>;
 * }} BathScheduleRow
 */

/**
 * @typedef {{
 *   weekStartYmd: string;
 *   rows: BathScheduleRow[];
 *   savedAt?: string;
 * }} BathScheduleDraft
 */

/** @param {string} facilityLinkKey */
export function loadBathScheduleDraft(facilityLinkKey) {
  const k = String(facilityLinkKey ?? '').trim() || '_default';
  const all = readStore();
  const rec = all[k];
  if (!rec || typeof rec !== 'object') {
    return { weekStartYmd: mondayOfWeek(currentYmd()), rows: [] };
  }
  return {
    weekStartYmd: mondayOfWeek(String(rec.weekStartYmd ?? currentYmd())),
    rows: Array.isArray(rec.rows) ? rec.rows.map((r) => normalizeRow(r, r)) : [],
    savedAt: String(rec.savedAt ?? ''),
  };
}

/** @param {string} facilityLinkKey @param {BathScheduleDraft} draft */
export function saveBathScheduleDraft(facilityLinkKey, draft) {
  const k = String(facilityLinkKey ?? '').trim() || '_default';
  const all = readStore();
  all[k] = {
    weekStartYmd: mondayOfWeek(String(draft.weekStartYmd ?? currentYmd())),
    rows: Array.isArray(draft.rows) ? draft.rows : [],
    savedAt: new Date().toISOString(),
  };
  writeStore(all);
  applyBathScheduleToDailyPlans(facilityLinkKey, all[k]);
  void import('./facilityPortalStoreSync.js').then((m) => m.queueBathScheduleCloudSync(k));
}

/** @param {{ time?: string; kind?: string; note?: string } | null | undefined} entry */
function bathPlanTitle(entry) {
  const kind = String(entry?.kind ?? '').trim();
  if (!kind || kind === '×') return '';
  const note = String(entry?.note ?? '').trim();
  return note ? `${kind} ${note}` : kind;
}

/**
 * 入浴予定を「本日の予定」・カード表示用の利用者予定へ反映
 * @param {string} facilityLinkKey
 * @param {BathScheduleDraft} draft
 */
export function applyBathScheduleToDailyPlans(facilityLinkKey, draft) {
  const fk = String(facilityLinkKey ?? '').trim();
  if (!fk || !draft) return;
  const rows = Array.isArray(draft.rows) ? draft.rows : [];
  const weekYmds = weekYmdsFromMonday(draft.weekStartYmd);
  for (const row of rows) {
    const rid = String(row.residentId ?? '').trim();
    if (!rid) continue;
    for (const ymd of weekYmds) {
      const entry = row.days?.[ymd] ?? { time: '', kind: '', note: '' };
      const existing = getResidentDailyPlans(fk, rid, ymd);
      const withoutBath = existing.filter((p) => String(p.source ?? '') !== 'bath_schedule');
      const title = bathPlanTitle(entry);
      if (title) {
        withoutBath.push({
          id: `bath_${ymd}`,
          time: String(entry?.time ?? '').trim(),
          title,
          type: '入浴',
          source: 'bath_schedule',
        });
      }
      setResidentDailyPlans(fk, rid, ymd, withoutBath);
    }
  }
}

/** @param {string} facilityLinkKey @param {string} residentId @param {string} ymd */
export function getBathEntry(facilityLinkKey, residentId, ymd) {
  const draft = loadBathScheduleDraft(facilityLinkKey);
  const row = draft.rows.find((r) => String(r.residentId) === String(residentId));
  if (!row) return null;
  return row.days?.[ymd] ?? null;
}

/** @param {string} facilityLinkKey @param {string} residentId @param {string} ymd */
export function formatBathPlanShort(facilityLinkKey, residentId, ymd) {
  const entry = getBathEntry(facilityLinkKey, residentId, ymd);
  if (!entry) return '';
  const title = bathPlanTitle(entry);
  if (!title) return '';
  const t = String(entry.time ?? '').trim();
  return t ? `${t} ${title}` : title;
}

/** @param {string} facilityLinkKey */
export function readBathScheduleStoreAll() {
  return readStore();
}
