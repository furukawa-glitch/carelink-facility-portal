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
  return tokyoDateHourMinuteToIso(ymd, hour, 0);
}

/**
 * 一覧表の「日付」と時・分を、日本の壁時計として careEvents の ts に保存（+09:00）
 * @param {string} ymd YYYY-MM-DD
 * @param {number} hour 0–23
 * @param {number} [minute] 0–59
 */
export function tokyoDateHourMinuteToIso(ymd, hour, minute = 0) {
  const [y, mo, d] = String(ymd)
    .trim()
    .split('-')
    .map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return new Date().toISOString();
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0;
  const mi = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  const moP = String(mo).padStart(2, '0');
  const dP = String(d).padStart(2, '0');
  const hP = String(h).padStart(2, '0');
  const miP = String(mi).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${moP}-${dP}T${hP}:${miP}:00+09:00`;
}

/** 同一時間に複数回入力した値（カンマ等区切り）を配列に */
export function splitMultiHourlyValues(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s === 'plain') return [];
  return s
    .split(/[,，/／+＋]/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 複数値を1セル表示用に連結 */
export function joinMultiHourlyValues(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .join(',');
}

/** 尿セル内の記録回数（×2 等を合計に反映） */
export function countHourlyUrineEntries(hu, savedCodes, savedFlags) {
  let count = 0;
  for (let h = 0; h < 24; h++) {
    const savedArr = splitMultiHourlyValues(String(savedCodes?.[h] ?? ''));
    const savedN = savedArr.filter((c) => String(c).trim()).length;
    if (savedN > 0) {
      count += savedN;
      continue;
    }
    if (savedFlags?.[h]) continue;
    const draftArr = splitMultiHourlyValues(String(hu?.[h] ?? ''));
    const draftN = draftArr.filter((c) => String(c).trim()).length;
    if (draftN > 0) count += draftN;
    else if (String(hu?.[h] ?? '').trim()) count += 1;
  }
  return count;
}

export function popMultiHourlyUrine(codesCell, mlCell) {
  const codes = splitMultiHourlyValues(codesCell);
  const mls = splitMultiHourlyValues(mlCell);
  if (codes.length <= 1 && mls.length <= 1) {
    return { codes: '', mls: '' };
  }
  codes.pop();
  if (mls.length) mls.pop();
  return { codes: joinMultiHourlyValues(codes), mls: joinMultiHourlyValues(mls) };
}

export function appendEmptyMultiHourlyUrine(codesCell, mlCell) {
  const codes = splitMultiHourlyValues(codesCell);
  const mls = splitMultiHourlyValues(mlCell);
  // join は空文字を除去するため、空を push しても消えて「＋が無反応」に見える。
  // 直前の値を複製して必ず1件増やし（×2 表示）、利用者が最後の1件を選び直す運用にする。
  const lastCode = codes.length ? codes[codes.length - 1] : '';
  codes.push(lastCode || 'トイレ');
  if (mls.length) mls.push(mls[mls.length - 1]);
  return { codes: joinMultiHourlyValues(codes), mls: joinMultiHourlyValues(mls) };
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
    if (typ !== 'excretion' && typ !== 'hourly_excretion') continue;
    const meta = e.meta && typeof e.meta === 'object' ? e.meta : {};
    const u = String(meta.urineVolume ?? '').trim();
    const sv = String(meta.stoolVolume ?? '').trim();
    const sc = String(meta.stoolCharacter ?? '').trim();
    const note = String(meta.note ?? '').trim();
    const hourlyKind = String(meta.hourlyKind ?? '').trim();
    if (u || /排尿/u.test(note) || meta.toiletGuidance) urine[h] = true;
    if (sv || sc || /排便/u.test(note)) stool[h] = true;
    if (hourlyKind === 'urine') urine[h] = true;
    if (hourlyKind === 'stool') stool[h] = true;
    if (note === '排泄確認（クイック）') {
      urine[h] = true;
      stool[h] = true;
    }
    if (/排尿（\d{2}時）/u.test(note)) urine[h] = true;
    if (/排便（\d{2}時）/u.test(note)) stool[h] = true;
  }
  return { patrol, urine, stool };
}

const HOURLY_URINE_CODES = new Set(['トイレ', '尿器', '失禁', '少量', '中量', '多量', 'Ba', '尿測', '導尿', 'カテ']);

/**
 * @param {Record<string, unknown>} meta
 * @returns {{ code: string; ml: string }}
 */
export function resolveHourlyUrineCodeAndMl(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  // 旧データの「カテ」は「導尿」に正規化して表示する。
  const normCode = (c) => (String(c ?? '').trim() === 'カテ' ? '導尿' : String(c ?? '').trim());
  const codeRaw = normCode(m.urineCode);
  const measured = String(m.measuredUrineMl ?? m.catheterMl ?? '').trim();
  const uv = normCode(m.urineVolume);
  if (codeRaw) {
    return { code: codeRaw, ml: measured || (/^\d+$/u.test(uv) ? uv : '') };
  }
  if (HOURLY_URINE_CODES.has(uv)) {
    return { code: uv, ml: measured };
  }
  if (/^\d+$/u.test(uv)) {
    return { code: measured ? '導尿' : '', ml: uv };
  }
  return { code: uv === 'plain' ? '' : uv, ml: measured };
}

/** @param {{ meta?: Record<string, unknown> }} ev */
export function measuredUrineMlFromEvent(ev) {
  const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
  if (meta.autoUrineDailyTotal) return 0;
  const measured = String(meta.measuredUrineMl ?? meta.catheterMl ?? '').trim();
  if (/^\d+$/u.test(measured)) return parseInt(measured, 10);
  const { ml } = resolveHourlyUrineCodeAndMl(meta);
  if (/^\d+$/u.test(ml)) return parseInt(ml, 10);
  const uv = String(meta.urineVolume ?? '').trim();
  if (/^\d+$/u.test(uv)) return parseInt(uv, 10);
  return 0;
}

/**
 * 24時間表の尿列（コード・ml）をイベントから復元
 * @param {Array<{ ts?: string; type?: string; meta?: Record<string, unknown> }>} events
 * @param {string} ymd
 */
export function buildHourlyUrineCellsFromEvents(events, ymd) {
  /** @type {{ codes: string[]; mls: string[] }[]} */
  const buckets = Array.from({ length: 24 }, () => ({ codes: [], mls: [] }));
  const day = String(ymd ?? '').trim();
  if (!day) {
    return { codes: Array(24).fill(''), mls: Array(24).fill('') };
  }

  for (const ev of events || []) {
    if (tokyoYmdFromTs(ev?.ts) !== day) continue;
    const h = tokyoHourFromTs(ev?.ts);
    if (h < 0 || h > 23) continue;
    const typ = String(ev?.type ?? '');
    if (typ !== 'excretion' && typ !== 'hourly_excretion') continue;
    const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
    const note = String(meta.note ?? '').trim();
    const hourlyKind = String(meta.hourlyKind ?? '').trim();
    if (hourlyKind !== 'urine' && !/排尿（\d{2}時）/u.test(note)) continue;
    const { code, ml } = resolveHourlyUrineCodeAndMl(meta);
    if (code) buckets[h].codes.push(code);
    else if (ml) buckets[h].codes.push('導尿');
    if (ml) buckets[h].mls.push(ml);
  }
  const codes = buckets.map((b) => joinMultiHourlyValues(b.codes));
  const mls = buckets.map((b) => joinMultiHourlyValues(b.mls));
  return { codes, mls };
}

/**
 * 対象日の尿量合計（ml）。23:59 自動日計イベントは二重計上しない。
 * @param {Array<{ ts?: string; type?: string; meta?: Record<string, unknown> }>} events
 * @param {string} ymd
 */
export function computeDailyUrineTotalMlFromEvents(events, ymd) {
  const day = String(ymd ?? '').trim();
  if (!day) return 0;
  let total = 0;
  for (const ev of events || []) {
    if (tokyoYmdFromTs(ev?.ts) !== day) continue;
    const typ = String(ev?.type ?? '');
    if (typ !== 'hourly_excretion' && typ !== 'excretion') continue;
    total += measuredUrineMlFromEvent(ev);
  }
  return total;
}
