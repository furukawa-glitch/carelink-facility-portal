/** 0時起点の3時間おきスロット（24h） */
export const PATROL_SLOT_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

/**
 * 現在日時を、直前の3時間境界（0,3,6…21）に揃えた datetime-local 値
 * @param {Date} [d]
 */
export function defaultPatrolSlotDateTimeLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = Math.floor(d.getHours() / 3) * 3;
  return `${y}-${m}-${day}T${String(hh).padStart(2, '0')}:00`;
}

/**
 * 任意の日時文字列を 0/3/6…21 時に丸めた datetime-local 値
 * @param {unknown} v
 */
export function normalizePatrolDateTimeLocal(v) {
  const dflt = defaultPatrolSlotDateTimeLocal();
  const s = String(v ?? '').trim();
  if (!s) return dflt;
  const t = new Date(s);
  if (!Number.isFinite(t.getTime())) return dflt;
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  const hh = Math.floor(t.getHours() / 3) * 3;
  return `${y}-${m}-${day}T${String(hh).padStart(2, '0')}:00`;
}

/**
 * @param {unknown} v
 * @returns {{ date: string; hour: number }}
 */
export function splitPatrolDateTimeLocal(v) {
  const n = normalizePatrolDateTimeLocal(v);
  const [date, rest] = n.split('T');
  const hour = parseInt(String(rest ?? '').slice(0, 2), 10);
  const h = Number.isFinite(hour) ? Math.floor(hour / 3) * 3 : 0;
  return { date: date || n.slice(0, 10), hour: h };
}

/**
 * @param {string} date YYYY-MM-DD
 * @param {number} hour 0–21（3の倍数に補正）
 */
export function joinPatrolDateTimeLocal(date, hour) {
  const raw = Number(hour);
  const h = Number.isFinite(raw) ? Math.min(21, Math.max(0, Math.floor(raw / 3) * 3)) : 0;
  return `${date}T${String(h).padStart(2, '0')}:00`;
}
