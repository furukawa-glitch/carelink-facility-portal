/**
 * アラーム一覧（床マップ）用の列・行数。69名を1画面に収める想定。
 * @param {number} total
 */
export function computeMonitorBedGrid(total) {
  const n = Math.max(1, Math.floor(total));
  if (n >= 60) {
    const cols = 10;
    return { cols, rows: Math.ceil(n / cols), dense: true };
  }
  if (n >= 36) {
    const cols = 9;
    return { cols, rows: Math.ceil(n / cols), dense: true };
  }
  if (n >= 20) {
    const cols = 7;
    return { cols, rows: Math.ceil(n / cols), dense: true };
  }
  const cols = 6;
  return { cols, rows: Math.ceil(n / cols), dense: false };
}

/**
 * 床マップ用の短い氏名（居室番号が主）
 * @param {unknown} nameRaw
 * @param {number} [maxLen] 省略時 6 文字（読みやすさ優先）
 */
export function bedMapShortName(nameRaw, maxLen = 6) {
  const n = String(nameRaw ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!n) return '—';
  const cap = Math.max(4, Math.min(8, Math.floor(maxLen) || 6));
  if (n.length <= cap) return n;
  return n.slice(0, cap);
}
