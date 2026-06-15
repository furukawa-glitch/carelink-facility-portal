import {
  isActiveResident,
  normalizeCareLevelLabel,
  normalizeInsuranceCategory,
} from '../services/GoogleSheetService.js';

/**
 * Supabase / care-sync の residents 行 → 名簿画面用オブジェクト
 * @param {Record<string, unknown>} row
 */
export function mapDbResidentRowToApp(row, opts = {}) {
  const includeInactive = Boolean(opts.includeInactive);
  const status = String(row.sheet_status ?? row.sheetStatus ?? '').trim();
  if (!includeInactive && status && !isActiveResident(status)) return null;

  const name = String(row.name ?? '').trim();
  if (!name) return null;

  const fac = row.facilities;
  const sheetTitleFromJoin =
    fac && typeof fac === 'object' && !Array.isArray(fac)
      ? String(fac.sheet_title ?? '').trim()
      : '';
  const facility =
    sheetTitleFromJoin || String(row.source_sheet_title ?? row.sourceSheetTitle ?? '').trim() || '施設未設定';

  const room = String(row.room ?? '').trim();
  const careRaw = String(row.care_level_label ?? row.careLevelLabel ?? '').trim();
  const careLevelNormalized = normalizeCareLevelLabel(careRaw) || careRaw.replace(/\s+/g, ' ');

  const insuranceLabel = String(row.insurance_label ?? row.insuranceLabel ?? '').trim();
  const insuranceCategoryRaw = String(row.insurance_category ?? row.insuranceCategory ?? '').trim();
  const insuranceCategory = insuranceCategoryRaw
    ? normalizeInsuranceCategory(insuranceCategoryRaw)
    : normalizeInsuranceCategory(insuranceLabel);

  const legacyKey = String(row.legacy_row_key ?? row.legacyRowKey ?? '').trim();
  const dbId = String(row.id ?? '').trim();

  return {
    id: dbId || legacyKey || `${facility}::${room}::${name}`,
    dbId: dbId || undefined,
    legacyRowKey: legacyKey || undefined,
    name,
    nameKana: String(row.name_kana ?? row.nameKana ?? '').trim(),
    room: room || '—',
    condition: String(row.condition_note ?? row.condition ?? '').trim() || '—',
    careLevelLabel: careLevelNormalized,
    insuranceLabel,
    insuranceCategory,
    medicalInsuranceTargetLabel: String(
      row.medical_insurance_target_label ?? row.medicalInsuranceTargetLabel ?? ''
    ).trim(),
    isMedicalInsuranceTarget: Boolean(row.is_medical_insurance_target ?? row.isMedicalInsuranceTarget),
    facility,
    sourceSheetTitle: sheetTitleFromJoin || String(row.source_sheet_title ?? '').trim() || undefined,
    sheetStatus: status || '在籍',
    birthDateLabel: String(row.birth_date_label ?? row.birthDateLabel ?? '').trim(),
    ageLabel: String(row.age_label ?? row.ageLabel ?? '').trim(),
    genderLabel: String(row.gender_label ?? row.genderLabel ?? '').trim(),
    lastStoolDate: '—',
    weight: null,
    lastMonthWeight: null,
    mealCountThisMonth: Number(row.meal_count_this_month ?? row.mealCountThisMonth) || 0,
    lastPatrol: '—',
    patrolIntervalMinutes: 0,
    hasVitalAlert: false,
    isBalloon: false,
    isEnteral: Boolean(row.is_enteral ?? row.isEnteral),
    homeDoctor: String(row.home_doctor ?? row.homeDoctor ?? '').trim(),
    history: { patrols: [], week: [] },
    managerWords: '',
  };
}

/**
 * 名簿画面オブジェクト → care-sync 送信用
 * @param {Record<string, unknown>} resident
 */
export function mapAppResidentToSyncPayload(resident) {
  const facility = String(resident.facility ?? resident.sourceSheetTitle ?? '').trim();
  const legacy =
    String(resident.legacyRowKey ?? '').trim() ||
    String(resident.id ?? '').trim() ||
    `${facility}::${String(resident.room ?? '').trim()}::${String(resident.name ?? '').trim()}`;

  return {
    dbId: String(resident.dbId ?? '').trim() || undefined,
    legacyRowKey: legacy,
    name: String(resident.name ?? '').trim(),
    nameKana: String(resident.nameKana ?? '').trim(),
    room: String(resident.room ?? '').trim(),
    sheetStatus: String(resident.sheetStatus ?? '在籍').trim() || '在籍',
    careLevelLabel: String(resident.careLevelLabel ?? '').trim(),
    condition: String(resident.condition ?? '').trim(),
    homeDoctor: String(resident.homeDoctor ?? '').trim(),
    insuranceLabel: String(resident.insuranceLabel ?? '').trim(),
    insuranceCategory: String(resident.insuranceCategory ?? '').trim(),
    birthDateLabel: String(resident.birthDateLabel ?? '').trim(),
    genderLabel: String(resident.genderLabel ?? '').trim(),
    facility,
    sourceSheetTitle: facility,
    isEnteral: Boolean(resident.isEnteral),
    isMedicalInsuranceTarget: Boolean(resident.isMedicalInsuranceTarget),
    medicalInsuranceTargetLabel: String(resident.medicalInsuranceTargetLabel ?? '').trim(),
  };
}
