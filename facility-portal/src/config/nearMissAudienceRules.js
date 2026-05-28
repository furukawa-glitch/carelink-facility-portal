/**
 * ヒヤリ・事故周知の「横断」対象（複数施設・部署フィルタ）
 * 監査では「誰が周知対象か」「各拠点で誰が未確認か」を名簿＋確認ログで示す。
 */

/** @typedef {{ label: string; linkKeys: readonly string[]; departmentSubstrings: readonly string[] }} AudiencePresetDef */

/** プリセット ID（空文字 = 発生施設のみ・従来どおり） */
export const AUDIENCE_PRESET_IDS = Object.freeze({
  /** 発生施設の名簿全員のみ */
  ORIGIN_ONLY: '',
  /** 訪問看護：指定拠点で、部署名に一致する職員のみ必須 */
  VISIT_NURSING: 'visit_nursing',
  /** 訪問介護：指定拠点で、部署名に一致する職員のみ必須 */
  VISIT_CARE: 'visit_care',
});

/** @type {Readonly<Record<string, AudiencePresetDef>>} */
export const AUDIENCE_PRESET_DEFS = Object.freeze({
  [AUDIENCE_PRESET_IDS.VISIT_NURSING]: {
    label: '訪問看護（愛西・千音寺・北名古屋・青空起・一宮）',
    linkKeys: Object.freeze(['愛西', '千音寺', '北名古屋', '起', '一宮']),
    /** 勤務表・求人シートの「部署」列に含まれる文字列のいずれかでヒット */
    departmentSubstrings: Object.freeze([
      '訪問看護',
      '愛西看護',
      '千音寺看護',
      '北名古屋看護',
      '千音寺看護師',
    ]),
  },
  [AUDIENCE_PRESET_IDS.VISIT_CARE]: {
    label: '訪問介護（愛西・北名古屋・千音寺・中川本館・青空起・一宮）',
    linkKeys: Object.freeze(['愛西', '北名古屋', '千音寺', '中川本館', '起', '一宮']),
    departmentSubstrings: Object.freeze(['訪問介護', '愛西訪問介護']),
  },
});

/** 管理画面・周知パネル用の選択肢 */
export const AUDIENCE_PRESET_SELECT_OPTIONS = Object.freeze([
  { id: AUDIENCE_PRESET_IDS.ORIGIN_ONLY, label: '発生施設のみ（従来）' },
  { id: AUDIENCE_PRESET_IDS.VISIT_NURSING, label: AUDIENCE_PRESET_DEFS[AUDIENCE_PRESET_IDS.VISIT_NURSING].label },
  { id: AUDIENCE_PRESET_IDS.VISIT_CARE, label: AUDIENCE_PRESET_DEFS[AUDIENCE_PRESET_IDS.VISIT_CARE].label },
]);

/**
 * @param {string} dept
 * @param {readonly string[]} substrings
 */
export function departmentMatchesSubstrings(dept, substrings) {
  const d = String(dept ?? '').trim();
  if (!substrings?.length) return true;
  if (!d) return false;
  return substrings.some((s) => s && d.includes(String(s)));
}

/**
 * @param {Record<string, unknown>} notice
 * @returns {readonly string[]} この周知を表示する施設 linkKey（重複なし）
 */
export function noticeAudienceLinkKeys(notice) {
  const explicit = Array.isArray(notice?.audienceLinkKeys)
    ? notice.audienceLinkKeys.map((x) => String(x ?? '').trim()).filter(Boolean)
    : [];
  if (explicit.length) return [...new Set(explicit)];
  const preset = String(notice?.audiencePreset ?? '').trim();
  const def = preset ? AUDIENCE_PRESET_DEFS[preset] : null;
  if (def?.linkKeys?.length) return [...def.linkKeys];
  const origin = String(notice?.facilityLinkKey ?? '').trim();
  return origin ? [origin] : [];
}

/**
 * @param {Record<string, unknown>} notice
 * @returns {readonly string[]} 空なら「対象施設の名簿は全職種」
 */
export function noticeAudienceDepartmentSubstrings(notice) {
  const own = Array.isArray(notice?.audienceDepartmentSubstrings)
    ? notice.audienceDepartmentSubstrings.map((x) => String(x ?? '').trim()).filter(Boolean)
    : [];
  if (own.length) return own;
  const preset = String(notice?.audiencePreset ?? '').trim();
  const def = preset ? AUDIENCE_PRESET_DEFS[preset] : null;
  if (def?.departmentSubstrings?.length) return [...def.departmentSubstrings];
  return [];
}

/**
 * @param {Record<string, unknown>} notice
 * @param {string} linkKey
 */
export function noticeAppliesToFacility(notice, linkKey) {
  const lk = String(linkKey ?? '').trim();
  if (!lk) return false;
  return noticeAudienceLinkKeys(notice).includes(lk);
}

/**
 * @param {Record<string, unknown>} notice
 */
export function getNoticeAudienceSummaryLabel(notice) {
  const preset = String(notice?.audiencePreset ?? '').trim();
  if (preset && AUDIENCE_PRESET_DEFS[preset]) return AUDIENCE_PRESET_DEFS[preset].label;
  const keys = noticeAudienceLinkKeys(notice);
  const origin = String(notice?.facilityLinkKey ?? '').trim();
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== origin)) {
    return `指定拠点: ${keys.join('・')}`;
  }
  return '';
}
