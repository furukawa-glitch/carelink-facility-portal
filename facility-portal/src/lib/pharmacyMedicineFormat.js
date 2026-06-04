/**
 * 薬局PDFから取り込んだ薬剤行（名称 + 服用タイミング）
 * @typedef {{ name: string; timing?: string; doseNote?: string }} PharmacyMedicineRow
 */

/**
 * @param {unknown} raw
 * @returns {PharmacyMedicineRow | null}
 */
export function normalizeMedicineRow(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const name = String(raw).trim();
    return name ? { name, timing: '', doseNote: '' } : null;
  }
  if (typeof raw === 'object') {
    const o = /** @type {Record<string, unknown>} */ (raw);
    const name = String(o.name ?? o.medicineName ?? o.drug ?? '').trim();
    if (!name) return null;
    return {
      name,
      timing: String(o.timing ?? o.schedule ?? o.when ?? o.time ?? '').trim(),
      doseNote: String(o.doseNote ?? o.dose ?? o.amount ?? '').trim(),
    };
  }
  return null;
}

/**
 * @param {unknown[]} arr
 * @returns {PharmacyMedicineRow[]}
 */
export function normalizeMedicineList(arr) {
  const out = /** @type {PharmacyMedicineRow[]} */ ([]);
  for (const item of arr ?? []) {
    const row = normalizeMedicineRow(item);
    if (row?.name) out.push(row);
  }
  return out;
}

/**
 * @param {PharmacyMedicineRow} row
 */
export function medicineRowKey(row) {
  return `${String(row.name ?? '').trim()}::${String(row.timing ?? '').trim()}`;
}

/**
 * @param {PharmacyMedicineRow} row
 */
export function formatMedicineDisplayLine(row) {
  const name = String(row?.name ?? '').trim();
  const timing = String(row?.timing ?? '').trim();
  if (!timing) return name;
  return `${name}（${timing}）`;
}

/**
 * 朝・昼・夕・就寝 のバッジ用ラベル（PDFの「朝夕」等を分解）
 * @param {string} timing
 * @returns {string[]}
 */
export function timingBadgeLabels(timing) {
  const t = String(timing ?? '').trim();
  if (!t) return [];
  const badges = [];
  if (/朝|起床/u.test(t)) badges.push('朝');
  if (/昼|昼食/u.test(t)) badges.push('昼');
  if (/夕|夕食/u.test(t) && !/就寝|寝る|眠前/u.test(t)) badges.push('夕');
  if (/就寝|寝る|眠前|BS|夜/u.test(t)) badges.push('就寝');
  if (!badges.length) return [t];
  return Array.from(new Set(badges));
}

/**
 * @param {unknown} prev
 * @param {unknown} next
 * @returns {PharmacyMedicineRow[]}
 */
export function mergeMedicineLists(prev, next) {
  const map = new Map();
  for (const row of [...normalizeMedicineList(normalizeMedicineListArg(prev)), ...normalizeMedicineList(normalizeMedicineListArg(next))]) {
    const key = medicineRowKey(row);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }
    if (!existing.timing && row.timing) map.set(key, row);
    else if (existing.timing && row.timing && existing.timing !== row.timing) {
      map.set(key, { ...existing, timing: `${existing.timing}・${row.timing}` });
    }
  }
  return Array.from(map.values());
}

/** @param {unknown} v */
function normalizeMedicineListArg(v) {
  if (Array.isArray(v)) return v;
  return [];
}

/**
 * 保存データ（旧 string[] のみ）から medicineItems を復元
 * @param {{ medicines?: unknown[]; medicineItems?: unknown[] } | null | undefined} row
 * @returns {PharmacyMedicineRow[]}
 */
export function medicineItemsFromStoredProfile(row) {
  if (!row || typeof row !== 'object') return [];
  if (Array.isArray(row.medicineItems) && row.medicineItems.length) {
    return normalizeMedicineList(row.medicineItems);
  }
  if (Array.isArray(row.medicines) && row.medicines.length) {
    return normalizeMedicineList(row.medicines);
  }
  return [];
}
