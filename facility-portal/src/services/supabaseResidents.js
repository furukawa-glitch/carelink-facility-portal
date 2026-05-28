import { getSupabaseBrowserClient } from '../lib/supabaseClient.js';
import {
  isActiveResident,
  normalizeCareLevelLabel,
  normalizeInsuranceCategory,
} from './GoogleSheetService.js';

/**
 * Supabase public.residents を、名簿画面が期待する形に近づけて返す。
 * facilities は facility_id の FK 参照（PostgREST の埋め込み）。
 *
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchResidentsFromSupabase() {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    throw new Error(
      'Supabase が未設定です。.env.local に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください。'
    );
  }

  const { data, error } = await supabase
    .from('residents')
    .select(
      `
      id,
      name,
      name_kana,
      room,
      sheet_status,
      care_level_label,
      condition_note,
      insurance_label,
      insurance_category,
      medical_insurance_target_label,
      is_medical_insurance_target,
      birth_date_label,
      age_label,
      gender_label,
      home_doctor,
      meal_count_this_month,
      is_enteral,
      source_sheet_title,
      facilities ( sheet_title, tab_label )
    `
    )
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`Supabase 名簿取得エラー: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  /** @type {Record<string, unknown>[]} */
  const out = [];

  for (const row of rows) {
    const status = String(row.sheet_status ?? '').trim();
    if (status && !isActiveResident(status)) continue;

    const name = String(row.name ?? '').trim();
    if (!name) continue;

    const fac = row.facilities;
    const sheetTitleFromJoin =
      fac && typeof fac === 'object' && !Array.isArray(fac)
        ? String(fac.sheet_title ?? '').trim()
        : '';
    const facility = sheetTitleFromJoin || String(row.source_sheet_title ?? '').trim() || '施設未設定';

    const room = String(row.room ?? '').trim();
    const careRaw = String(row.care_level_label ?? '').trim();
    const careLevelNormalized = normalizeCareLevelLabel(careRaw) || careRaw.replace(/\s+/g, ' ');

    const insuranceLabel = String(row.insurance_label ?? '').trim();
    const insuranceCategoryRaw = String(row.insurance_category ?? '').trim();
    const insuranceCategory = insuranceCategoryRaw
      ? normalizeInsuranceCategory(insuranceCategoryRaw)
      : normalizeInsuranceCategory(insuranceLabel);

    out.push({
      id: String(row.id),
      name,
      nameKana: String(row.name_kana ?? '').trim(),
      room: room || '—',
      condition: String(row.condition_note ?? '').trim() || '—',
      careLevelLabel: careLevelNormalized,
      insuranceLabel,
      insuranceCategory,
      medicalInsuranceTargetLabel: String(row.medical_insurance_target_label ?? '').trim(),
      isMedicalInsuranceTarget: Boolean(row.is_medical_insurance_target),
      facility,
      sourceSheetTitle: sheetTitleFromJoin || String(row.source_sheet_title ?? '').trim() || undefined,
      sheetStatus: status || undefined,
      birthDateLabel: String(row.birth_date_label ?? '').trim(),
      ageLabel: String(row.age_label ?? '').trim(),
      genderLabel: String(row.gender_label ?? '').trim(),
      lastStoolDate: '—',
      weight: null,
      lastMonthWeight: null,
      mealCountThisMonth: Number(row.meal_count_this_month) || 0,
      lastPatrol: '—',
      patrolIntervalMinutes: 0,
      hasVitalAlert: false,
      isBalloon: false,
      isEnteral: Boolean(row.is_enteral),
      homeDoctor: String(row.home_doctor ?? '').trim(),
      history: { patrols: [], week: [] },
      managerWords: '',
    });
  }

  return out;
}
