/**
 * 名簿セルが病名らしいテキストか（医療対象の○・該当のみ等は除外）
 * @param {unknown} label
 */
export function medicalInsuranceCellLooksLikeDiseaseName(label) {
  const s = String(label ?? '').trim();
  if (!s) return false;
  const compact = s.replace(/\s/g, '');
  if (!compact || /^[-ー−―－]+$/u.test(compact)) return false;
  if (/^(該当|○|◯|✓|有|あり|yes|対象|該|レ|×)$/iu.test(compact)) return false;
  return true;
}

/**
 * 利用者オブジェクトから表示用の病名（傷病一覧CSV → 名簿・医療対象列）
 * @param {Record<string, unknown> | null | undefined} res
 */
export function residentDiseaseLabel(res) {
  if (!res || typeof res !== 'object') return '';
  const explicit = String(res.diseaseName ?? '').trim();
  if (explicit && explicit !== '—') return explicit;
  const cond = String(res.condition ?? '').trim();
  if (cond && cond !== '—') return cond;
  const med = String(res.medicalInsuranceTargetLabel ?? '').trim();
  if (medicalInsuranceCellLooksLikeDiseaseName(med)) return med;
  return '';
}
