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
    const cols = 8;
    return { cols, rows: Math.ceil(n / cols), dense: true };
  }
  const cols = 6;
  return { cols, rows: Math.ceil(n / cols), dense: false };
}

/** 床マップ用の短い氏名（居室番号が主） */
export function bedMapShortName(nameRaw) {
  const n = String(nameRaw ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!n) return '—';
  if (n.length <= 4) return n;
  return n.slice(0, 4);
}
