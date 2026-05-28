/**
 * 登録日時などを日本の壁時計で保存する（UTC の `Z` ではなく `+09:00`）
 * @param {Date | number | string} [input]
 * @returns {string} 例 `2026-04-25T21:05:12+09:00`
 */
export function formatInstantAsJapanIsoWithOffset(input) {
  const d = input == null ? new Date() : input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return formatInstantAsJapanIsoWithOffset(new Date());

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}+09:00`;
}

/** @returns {string} */
export function nowJapanIsoString() {
  return formatInstantAsJapanIsoWithOffset(new Date());
}
