import { getImportedInjuryDiseaseLabel } from '../services/ReportService.js';

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
  if (/写真掲載/i.test(s)) return false;
  return true;
}

/** @param {unknown} label */
function rosterLabelLooksLikeDiseaseName(label) {
  const s = String(label ?? '').trim();
  if (!s || s === '—') return false;
  return medicalInsuranceCellLooksLikeDiseaseName(s) || (s.length >= 3 && /病|症|炎|障害|梗塞|癌|がん|骨折|麻痺|糖尿病/u.test(s));
}

/**
 * 利用者オブジェクトから表示用の病名（傷病一覧CSV → 名簿・医療対象列）
 * @param {Record<string, unknown> | null | undefined} res
 */
export function residentDiseaseLabel(res) {
  if (!res || typeof res !== 'object') return '';
  const id = String(res.id ?? '').trim();
  const imported = id ? getImportedInjuryDiseaseLabel(id) : '';
  if (imported) return imported;

  const explicit = String(res.diseaseName ?? '').trim();
  if (rosterLabelLooksLikeDiseaseName(explicit)) return explicit;
  const cond = String(res.condition ?? '').trim();
  if (rosterLabelLooksLikeDiseaseName(cond)) return cond;
  const med = String(res.medicalInsuranceTargetLabel ?? '').trim();
  if (medicalInsuranceCellLooksLikeDiseaseName(med)) return med;
  return '';
}
