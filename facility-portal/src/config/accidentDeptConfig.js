/** 事故報告書の「所属（部署）」候補（carelinkFacilities の tabLabel と一致） */
export const ACCIDENT_DEPT_OPTIONS_BY_FACILITY = Object.freeze({
  愛西: Object.freeze(['デイサービス', '訪問介護', '有料', '訪問看護']),
  北名古屋: Object.freeze(['訪問介護', '訪問看護', '有料']),
  千音寺: Object.freeze(['訪問介護', '訪問看護', '有料']),
  /** linkKey「起」／表示ラベル「青空起」 */
  青空起: Object.freeze(['訪問介護', '訪問看護', '有料']),
  /** linkKey「一宮」／表示ラベル「青空一宮」 */
  青空一宮: Object.freeze(['訪問介護', '訪問看護', '有料']),
  中川本館: Object.freeze(['訪問介護', '有料', 'デイサービス']),
  中村: Object.freeze(['訪問介護', '有料', 'デイサービス']),
});

const EMPTY = Object.freeze([]);

/** tabLabel 以外の略称でも引けるように */
const FACILITY_TAB_ALIASES = Object.freeze({
  起: '青空起',
  一宮: '青空一宮',
});

/** carelinkFacilities の tabLabel が正式名に変わっても部署候補を引ける */
const FACILITY_TAB_TO_DEPT_KEY = Object.freeze({
  シルバーマンション愛西: '愛西',
  'CSナーシング千音寺': '千音寺',
  'CSナーシング北名古屋': '北名古屋',
  ナーシングホーム青空起: '青空起',
  ナーシングホーム青空: '青空一宮',
});

/** @param {string} facilityTabLabel */
export function getAccidentDeptOptions(facilityTabLabel) {
  const k = String(facilityTabLabel ?? '').trim();
  const mapped = FACILITY_TAB_TO_DEPT_KEY[k];
  const key = mapped ?? FACILITY_TAB_ALIASES[k] ?? k;
  return ACCIDENT_DEPT_OPTIONS_BY_FACILITY[key] ?? EMPTY;
}
