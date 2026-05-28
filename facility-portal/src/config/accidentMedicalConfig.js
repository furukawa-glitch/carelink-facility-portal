/**
 * 事故報告書の医療機関（カイポケ等の登録情報に準拠）
 * - 北名古屋タブ: 一覧から選択可
 * - 上記以外の施設: たなか在宅クリニックに固定
 */

/** @typedef {{ key: string; medicalInstitutionName: string; medicalInstitutionCode: string; medicalInstitutionAddress: string; medicalInstitutionTel: string }} AccidentMedicalOption */

/** 北名古屋以外で固定 */
export const ACCIDENT_DEFAULT_MEDICAL_TANAKA_ZAITAKU = Object.freeze({
  medicalInstitutionName: 'たなか在宅クリニック',
  medicalInstitutionCode: '2310403403',
  medicalInstitutionAddress:
    '愛知県名古屋市西区庄内通三丁目27番地1 ダイワシティ庄内通1階001号室',
  medicalInstitutionTel: '',
});

/**
 * 北名古屋施設向けの候補（カイポケ「医療機関情報」より）
 * @type {readonly AccidentMedicalOption[]}
 */
export const ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS = Object.freeze([
  Object.freeze({
    key: 'kitanagoya_clinic',
    medicalInstitutionName: '北名古屋クリニック',
    medicalInstitutionCode: '7400709',
    medicalInstitutionAddress: '愛知県北名古屋市西之保青野東53-1 1F',
    medicalInstitutionTel: '0568-54-6180',
  }),
  Object.freeze({
    key: 'tanaka_zaitaku',
    medicalInstitutionName: 'たなか在宅クリニック',
    medicalInstitutionCode: '2310403403',
    medicalInstitutionAddress:
      '愛知県名古屋市西区庄内通三丁目27番地1 ダイワシティ庄内通1階001号室',
    medicalInstitutionTel: '',
  }),
  Object.freeze({
    key: 'meinan_hospital',
    medicalInstitutionName: '医療法人名南会　名南病院',
    medicalInstitutionCode: '',
    medicalInstitutionAddress: '愛知県名古屋市南区（詳細はカイポケ要確認）',
    medicalInstitutionTel: '',
  }),
  Object.freeze({
    key: 'hinotori',
    medicalInstitutionName: 'ひのとり整形在宅クリニック',
    medicalInstitutionCode: '',
    medicalInstitutionAddress: '愛知県名古屋市北区（詳細はカイポケ要確認）',
    medicalInstitutionTel: '',
  }),
  Object.freeze({
    key: 'kainan',
    medicalInstitutionName: '愛知県厚生農業協同組合連合会 海南病院',
    medicalInstitutionCode: '',
    medicalInstitutionAddress: '愛知県弥富市（詳細はカイポケ要確認）',
    medicalInstitutionTel: '',
  }),
  Object.freeze({
    key: 'tanaka_clinic',
    medicalInstitutionName: '田中クリニック',
    medicalInstitutionCode: '',
    medicalInstitutionAddress: '（カイポケで要確認）',
    medicalInstitutionTel: '',
  }),
]);

/** @param {string} facilityTabLabel RecordPage の selectedDef.tabLabel */
export function isAccidentKitanagoyaFacility(facilityTabLabel) {
  const t = String(facilityTabLabel ?? '').trim();
  return t === '北名古屋' || t === 'CSナーシング北名古屋';
}

/**
 * @param {string} facilityTabLabel
 * @param {string} [kitanagoyaOptionKey] 北名古屋のとき ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS[].key
 * @returns {{ medicalInstitutionName: string; medicalInstitutionCode: string; medicalInstitutionAddress: string; medicalInstitutionTel: string }}
 */
export function getAccidentMedicalDraftPatch(facilityTabLabel, kitanagoyaOptionKey) {
  if (isAccidentKitanagoyaFacility(facilityTabLabel)) {
    const k = String(kitanagoyaOptionKey ?? '').trim();
    const opt =
      ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS.find((o) => o.key === k) ??
      ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS[0];
    return {
      medicalInstitutionName: opt.medicalInstitutionName,
      medicalInstitutionCode: opt.medicalInstitutionCode,
      medicalInstitutionAddress: opt.medicalInstitutionAddress,
      medicalInstitutionTel: opt.medicalInstitutionTel,
    };
  }
  return { ...ACCIDENT_DEFAULT_MEDICAL_TANAKA_ZAITAKU };
}
