/** 0–23 時（ローカル） */
export const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);

/** @param {string | number | Date} ts */
export function localYmdFromTs(ts) {
  const t = new Date(ts);
  if (!Number.isFinite(t.getTime())) return '';
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** @param {string | number | Date} ts */
export function localHourFromTs(ts) {
  const t = new Date(ts);
  if (!Number.isFinite(t.getTime())) return -1;
  return t.getHours();
}

/**
 * イベント時刻の暦日（YYYY-MM-DD）を日本（Asia/Tokyo）で解釈
 * @param {string | number | Date} ts
 */
export function tokyoYmdFromTs(ts) {
  const t = new Date(ts);
  if (!Number.isFinite(t.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(t);
  const y = parts.find((p) => p.type === 'year')?.value;
  const mo = parts.find((p) => p.type === 'month')?.value;
  const da = parts.find((p) => p.type === 'day')?.value;
  if (!y || !mo || !da) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

/**
 * イベント時刻の時（0–23）を日本（Asia/Tokyo）で解釈
 * @param {string | number | Date} ts
 */
export function tokyoHourFromTs(ts) {
  const t = new Date(ts);
  if (!Number.isFinite(t.getTime())) return -1;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(t);
  const h = parts.find((p) => p.type === 'hour')?.value;
  const n = parseInt(String(h ?? ''), 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * ローカル日付の各時刻を ISO（UTC）に変換（careEvents の ts 用）
 * @param {string} ymd YYYY-MM-DD
 * @param {number} hour 0–23
 */
export function localDateHourToIso(ymd, hour) {
  const [y, mo, d] = String(ymd)
    .trim()
    .split('-')
    .map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return new Date().toISOString();
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0;
  const dt = new Date(y, mo - 1, d, h, 0, 0, 0);
  if (!Number.isFinite(dt.getTime())) return new Date().toISOString();
  return dt.toISOString();
}

/**
 * 一覧表の「日付」と時を、日本の壁時計として careEvents の ts に保存（+09:00）
 * @param {string} ymd YYYY-MM-DD
 * @param {number} hour 0–23
 */
export function tokyoDateHourToIso(ymd, hour) {
  const [y, mo, d] = String(ymd)
    .trim()
    .split('-')
    .map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return new Date().toISOString();
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0;
  const moP = String(mo).padStart(2, '0');
  const dP = String(d).padStart(2, '0');
  const hP = String(h).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${moP}-${dP}T${hP}:00:00+09:00`;
}

/**
 * その日のケアイベントから 24 マス表示用フラグを生成
 * @param {Array<{ ts?: string; type?: string; meta?: Record<string, unknown> }>} events
 * @param {string} ymd
 */
export function buildHourlyCareFromEvents(events, ymd) {
  const patrol = Array(24).fill(false);
  const urine = Array(24).fill(false);
  const stool = Array(24).fill(false);
  const day = String(ymd ?? '').trim();
  if (!day) return { patrol, urine, stool };

  for (const e of events || []) {
    if (tokyoYmdFromTs(e.ts) !== day) continue;
    const h = tokyoHourFromTs(e.ts);
    if (h < 0 || h > 23) continue;
    const typ = String(e.type ?? '');
    if (typ === 'patrol') {
      patrol[h] = true;
      continue;
    }
    if (typ !== 'excretion') continue;
    const meta = e.meta && typeof e.meta === 'object' ? e.meta : {};
    const u = String(meta.urineVolume ?? '').trim();
    const sv = String(meta.stoolVolume ?? '').trim();
    const sc = String(meta.stoolCharacter ?? '').trim();
    const note = String(meta.note ?? '').trim();
    if (u || /排尿/u.test(note) || meta.toiletGuidance) urine[h] = true;
    if (sv || sc || /排便/u.test(note)) stool[h] = true;
    if (note === '排泄確認（クイック）') {
      urine[h] = true;
      stool[h] = true;
    }
    if (/排尿（\d{2}時）/u.test(note)) urine[h] = true;
    if (/排便（\d{2}時）/u.test(note)) stool[h] = true;
  }
  return { patrol, urine, stool };
}
