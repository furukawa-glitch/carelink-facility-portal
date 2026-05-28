/**
 * Google スプレッドシートのシート名（タブ）とアプリ表示の対応。
 * Sheets API 利用時、利用者の `facility` はタブ名（sheetTitle）と一致します。
 *
 * @typedef {Object} CarelinkFacilityDef
 * @property {string} sheetTitle
 * @property {string} linkKey
 * @property {string} tabLabel
 * @property {string} [valueRange] シート内 A1 範囲（省略時は A:ZZ）。例 A6:ZZ29
 * @property {boolean} [singleColumnNames] true なら取得範囲の1列目だけを氏名として読む（ヘッダ行は自動スキップ）
 * @property {number} [nameColumn0Based] 氏名列の0始まりインデックス（取得範囲の左端列が0。B6:ZZ29 なら B=0）。ヘッダ自動判定より優先
 * @property {number} [medicalInsuranceTargetColumn0Based] 入居済み医療対象列（0始まり、A=0）。見出しが取得範囲外（例: D3のみ）のときに指定
 * @property {boolean} [medicalInsuranceTargetNonEmptyMeansTrue] true のとき、medicalInsuranceTargetColumn0Based のセルが空欄/ダッシュ以外なら医療対象として扱う（青空起の I列病名運用向け）
 * @property {{ row0Based: number; col0Based: number }} [medicalTargetCountFromSheetCell] シート上部の医療対象者「人数」集計（取得範囲先頭＝0）。Record の施設サマリー表示で名簿行の合算より優先
 * @property {{ row0Based: number; col0Based: number }} [averageCareLevelFromSheetCell] シート上部の「平均介護度」数値セル（取得範囲先頭＝0）。Record の平均介護度表示で名簿からの再計算より優先
 * @property {{ row0Based: number; col0Based: number }} [residentCountFromSheetCell] シート上部の「入居者数」等の人数セル（取得範囲先頭＝0）。Record のヘッダ人数表示で名簿行数より優先
 * @property {string} [emergencyFacilityName] 救急搬送サマリー「施設名」初期値（公式サイト掲載名。未設定時は tabLabel）
 * @property {string} [emergencySenderAddress] 救急搬送サマリー「住所」初期値
 * @property {readonly string[]} [shiftDepartments] 勤務表の部署（職種）候補。施設ごとに異なる
 * @property {number} [licensedBeds] 満床時の定員（床）。在籍率の分母に利用
 * @property {string} [ledgerCompanyTag] 事故・ヒヤリ台帳スプレッドシートのカテゴリ列に付与する運営会社名
 * @property {'none'|'on_site_csv'|'external_manual'} [dayServiceMode] デイ予定: 併設デイはカイポケCSV取込／外部通所は手入力
 */

/** @type {readonly CarelinkFacilityDef[]} 左から右のタブ順（スクリーンショット準拠） */
export const CARELINK_FACILITIES = Object.freeze([
  {
    sheetTitle: '中川本館：入居者',
    linkKey: '中川本館',
    tabLabel: '中川本館',
    licensedBeds: 24,
    // 名簿は B 列＝氏名（6行目＝ヘッダ）。A 列に介護度などがあるブックがあるため A から取得し、氏名は index 1
    // シート上段の「医療対象者」人数（D3）を読むため A 行から取得（行末を ZZ29 に固定すると 24 名などで下の行が欠ける）
    valueRange: 'A:ZZ',
    nameColumn0Based: 1,
    medicalInsuranceTargetColumn0Based: 3,
    medicalTargetCountFromSheetCell: Object.freeze({ row0Based: 2, col0Based: 3 }),
    emergencySenderAddress: '〒454-0963 名古屋市中川区水里 三丁目306-3',
    shiftDepartments: Object.freeze(['グループハウスくまさん', '訪問介護', '訪問看護', '有料', 'デイ']),
    ledgerCompanyTag: 'ケアサポート',
    dayServiceMode: 'on_site_csv',
  },
  {
    sheetTitle: '愛西：入居者',
    linkKey: '愛西',
    tabLabel: 'シルバーマンション愛西',
    licensedBeds: 69,
    // A 列に介護度・番号などがある場合があるため A:ZZ。氏名は B 列想定（取得配列 index 1）
    // 「医療対象者」見出しはシート上 F3（取得ブロックのヘッダ行より上のことがある）→ F 列＝index 5 で固定
    valueRange: 'A:ZZ',
    nameColumn0Based: 1,
    medicalInsuranceTargetColumn0Based: 5,
    emergencySenderAddress: '〒496-0924 愛西市善太新田町 十一下86-1',
    shiftDepartments: Object.freeze([
      '愛西デイサービス',
      '愛西訪問介護',
      '愛西有料',
      '愛西看護',
      'デイ',
      '訪問介護',
      '訪問看護',
      '有料',
    ]),
    ledgerCompanyTag: 'ケアサポート',
    dayServiceMode: 'on_site_csv',
  },
  {
    sheetTitle: '★北名古屋：入居者',
    linkKey: '北名古屋',
    tabLabel: 'CSナーシング北名古屋',
    licensedBeds: 32,
    valueRange: 'A:ZZ',
    // 「医療対象者」見出しはシート上 J3 → J 列＝index 9 で固定
    medicalInsuranceTargetColumn0Based: 9,
    // 氏名列が A〜C とシートで異なるため固定 index は付けず、1行目ヘッダから「氏名」列を自動検出する
    emergencySenderAddress: '〒481-0045 北名古屋市中之郷 北124-1',
    shiftDepartments: Object.freeze(['訪問介護', '訪問看護', '北名古屋有料', '有料', '北名古屋介護', '北名古屋看護']),
    ledgerCompanyTag: 'ケアサポート',
    dayServiceMode: 'external_manual',
  },
  {
    sheetTitle: '☆千音寺：入居者',
    linkKey: '千音寺',
    tabLabel: 'CSナーシング千音寺',
    licensedBeds: 30,
    valueRange: 'A:ZZ',
    // 「医療対象者」見出しはシート上 F4 → F 列＝index 5 で固定
    medicalInsuranceTargetColumn0Based: 5,
    // 北名古屋と同様、氏名列位置がブックで異なるためヘッダから「氏名」列を自動検出（介護度列と整合させる）
    emergencySenderAddress: '〒454-0977 名古屋市中川区千音寺 三丁目129番地',
    shiftDepartments: Object.freeze(['訪問介護', '訪問看護', '有料', '千音寺介護', '千音寺看護師']),
    ledgerCompanyTag: 'ケアサポート',
    dayServiceMode: 'external_manual',
  },
  {
    sheetTitle: '●青空起：入居者',
    linkKey: '起',
    tabLabel: 'ナーシングホーム青空起',
    licensedBeds: 26,
    // 氏名は E 列（A=0 のとき index 4）。A6 からだと 1〜5 行目が欠けヘッダ誤判定で人数がずれることがあるため A 行から全行取得
    valueRange: 'A:ZZ',
    nameColumn0Based: 4,
    // 「医療対象者」見出しはシート上 I2、人数は I3。平均介護度は H2 見出し・H3 に集計（上段を Record サマリーに同期）
    medicalInsuranceTargetColumn0Based: 8,
    // 青空起は I 列に病名が入っていれば医療保険対象とみなす運用
    medicalInsuranceTargetNonEmptyMeansTrue: true,
    medicalTargetCountFromSheetCell: Object.freeze({ row0Based: 2, col0Based: 8 }),
    averageCareLevelFromSheetCell: Object.freeze({ row0Based: 2, col0Based: 7 }),
    // 入居者数は J1 付近ラベル・L1（列 L＝index 11）の集計が多い。マージで列がずれる場合は先頭行のラベル走査にフォールバック
    residentCountFromSheetCell: Object.freeze({ row0Based: 0, col0Based: 11 }),
    // https://nursing-aozora.com/company/ 「住む」掲載（訪問看護の別名はサイトに無し）
    emergencyFacilityName: 'ナーシングホーム青空起',
    emergencySenderAddress: '〒494-0008 一宮市東五城字上出16-1',
    shiftDepartments: Object.freeze(['訪問介護', '訪問看護', '有料']),
    ledgerCompanyTag: 'ブレインエナジー',
    dayServiceMode: 'external_manual',
  },
  {
    sheetTitle: '●青空一宮：入居者',
    linkKey: '一宮',
    tabLabel: 'ナーシングホーム青空',
    licensedBeds: 17,
    // 氏名は C 列（A=0 のとき index 2）。青空起と同様、先頭行を欠かさないよう A から全行取得
    valueRange: 'A:ZZ',
    nameColumn0Based: 2,
    // 「医療対象者」見出しはシート上 G3 → G 列＝index 6 で固定
    medicalInsuranceTargetColumn0Based: 6,
    // https://nursing-aozora.com/company/ 「訪問する」訪問看護
    emergencyFacilityName: '訪問看護の青空一宮',
    emergencySenderAddress: '〒494-0008 一宮市東五城字北作野45-1',
    shiftDepartments: Object.freeze(['訪問介護', '訪問看護', '有料']),
    ledgerCompanyTag: 'ブレインエナジー',
    dayServiceMode: 'external_manual',
  },
]);

/**
 * デイ予定の取り込み・手入力 UI を出すか（carelinkFacilities の dayServiceMode）
 * @param {string} linkKey
 * @returns {'none'|'on_site_csv'|'external_manual'}
 */
export function dayServiceModeForFacilityLinkKey(linkKey) {
  const k = String(linkKey ?? '').trim();
  const def = CARELINK_FACILITIES.find((f) => f.linkKey === k);
  const m = def?.dayServiceMode;
  if (m === 'on_site_csv' || m === 'external_manual') return m;
  return 'none';
}

/** 台帳に書き出す運営会社タグ（未設定施設の既定） */
export const LEDGER_COMPANY_TAG_DEFAULT = 'ケアサポート';

/**
 * 事故・ヒヤリ台帳の運営会社タグ（施設 linkKey）
 * @param {string} linkKey
 */
export function ledgerCompanyTagForFacilityLinkKey(linkKey) {
  const k = String(linkKey ?? '').trim();
  const def = CARELINK_FACILITIES.find((f) => f.linkKey === k);
  const tag = String(def?.ledgerCompanyTag ?? '').trim();
  return tag || LEDGER_COMPANY_TAG_DEFAULT;
}

/** 名簿照合に使う正式タブ名一覧 */
export const CARELINK_SHEET_TITLES = Object.freeze(CARELINK_FACILITIES.map((f) => f.sheetTitle));

/** @param {string} title */
export function isOfficialSheetTitle(title) {
  return CARELINK_SHEET_TITLES.includes(String(title ?? '').trim());
}

/** @param {string} sheetTitle */
/**
 * 事故報告・ヒヤリ等の施設表示名（tabLabel や略称）から linkKey を解決
 * @param {string} raw tabLabel・linkKey・シート名のいずれか
 * @returns {string}
 */
export function linkKeyFromTabLabelOrAlias(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  const aliases = Object.freeze({
    起: '起',
    一宮: '一宮',
    青空起: '起',
    青空一宮: '一宮',
    ナーシングホーム青空起: '起',
    ナーシングホーム青空: '一宮',
    愛西: '愛西',
    千音寺: '千音寺',
    北名古屋: '北名古屋',
    シルバーマンション愛西: '愛西',
    'CSナーシング千音寺': '千音寺',
    'CSナーシング北名古屋': '北名古屋',
  });
  const resolved = /** @type {Record<string, string>} */ (aliases)[t] ?? t;
  const def = CARELINK_FACILITIES.find(
    (f) => f.tabLabel === resolved || f.linkKey === resolved || f.sheetTitle === resolved
  );
  return def?.linkKey ?? '';
}

export function linkKeyForSheetTitle(sheetTitle) {
  const t = String(sheetTitle ?? '').trim();
  const row = CARELINK_FACILITIES.find((f) => f.sheetTitle === t);
  return row?.linkKey ?? '';
}

/** @param {string} sheetTitle */
export function facilityDefBySheetTitle(sheetTitle) {
  const t = String(sheetTitle ?? '').trim();
  return CARELINK_FACILITIES.find((f) => f.sheetTitle === t) ?? null;
}

/**
 * Google スプレッドシートの実タブ名から施設定義を探す（完全一致 → compactFacilityToken 一致）
 * @param {string} apiTabTitle
 */
export function resolveFacilityDefForSheetTab(apiTabTitle) {
  const t = String(apiTabTitle ?? '').trim();
  const exact = CARELINK_FACILITIES.find((f) => f.sheetTitle === t);
  if (exact) return exact;
  const w = compactFacilityToken(t);
  if (!w) return null;
  const exactCompact = CARELINK_FACILITIES.find((f) => compactFacilityToken(f.sheetTitle) === w);
  if (exactCompact) return exactCompact;
  if (w.length >= 2) {
    return (
      CARELINK_FACILITIES.find((f) => {
        const c = compactFacilityToken(f.sheetTitle);
        return c.includes(w) || w.includes(c);
      }) ?? null
    );
  }
  return null;
}

/**
 * 勤務表の部署（職種）候補。未設定の施設は汎用一覧
 * @param {string} linkKey CARELINK_FACILITIES[].linkKey
 * @returns {readonly string[]}
 */
export function getShiftDepartmentsForLinkKey(linkKey) {
  const k = String(linkKey ?? '').trim();
  const def = CARELINK_FACILITIES.find((f) => f.linkKey === k);
  if (def?.shiftDepartments?.length) return def.shiftDepartments;
  return Object.freeze(['訪問介護', '訪問看護', '有料', 'デイ']);
}

/**
 * 満床時の定員（床）。未設定の施設は null
 * @param {string} linkKey CARELINK_FACILITIES[].linkKey
 * @returns {number | null}
 */
export function licensedBedsForLinkKey(linkKey) {
  const k = String(linkKey ?? '').trim();
  const def = CARELINK_FACILITIES.find((f) => f.linkKey === k);
  const n = def?.licensedBeds;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** タブ名・施設名のゆらぎ照合用（記号・「：入居者」等を除いた比較キー） */
export function compactFacilityToken(s) {
  let t = String(s ?? '')
    .trim()
    .replace(/[\u200b\uFEFF]/g, '')
    .replace(/[★☆●◇◆■▼▲♦✦✧□◯◎\u2B50\u2B51]/g, '')
    .replace(/[\s　]+/g, '');
  // 半角 : でも「:入居者」を剥がす（Sheets のタブ名でよくある）
  t = t.replace(/[:：]\s*(入居者|利用者)\s*$/u, '');
  return t;
}

/**
 * 1枚シートの「施設」列とタブ定義（中川本館・愛西…）を突き合わせる
 * @param {unknown} residentFacilityRaw シートの施設セル
 * @param {string} selectedSheetTitle CARELINK_FACILITIES[].sheetTitle
 */
export function residentMatchesFacilityTab(residentFacilityRaw, selectedSheetTitle) {
  const fac = String(residentFacilityRaw ?? '').trim();
  const sel = String(selectedSheetTitle ?? '').trim();
  if (!sel) return false;
  if (fac === sel) return true;
  const def = CARELINK_FACILITIES.find((f) => f.sheetTitle === sel);
  if (!def) return false;
  if (!fac) return false;
  if (fac === def.tabLabel || fac === def.linkKey) return true;
  const cf = compactFacilityToken(fac);
  const cTab = compactFacilityToken(def.tabLabel);
  const cLink = compactFacilityToken(def.linkKey);
  const cTitle = compactFacilityToken(sel);
  if (!cf) return false;
  if (cf === cTab || cf === cLink || cf === cTitle) return true;
  if (cTitle.includes(cf) || cf.includes(cTab)) return true;
  return false;
}

/**
 * 名簿1行が「選択中の施設タブ」に属するか（施設列の表記ゆれ＋読み込み元タブ名の両方で判定）
 * @param {Record<string, unknown>} resident
 * @param {string} selectedSheetTitle CARELINK_FACILITIES[].sheetTitle
 */
export function residentBelongsToFacilityTab(resident, selectedSheetTitle) {
  if (residentMatchesFacilityTab(resident.facility, selectedSheetTitle)) return true;
  const src = String(resident.sourceSheetTitle ?? '').trim();
  const sel = String(selectedSheetTitle ?? '').trim();
  if (!sel) return false;
  // 完全一致（Sheets API のタブ名＝設定の sheetTitle）
  if (src && src === sel) return true;
  // タブ名の表記ゆれ（「愛西」と「愛西：入居者」等）— 施設列と同じルールで突合
  if (src && residentMatchesFacilityTab(src, selectedSheetTitle)) return true;
  return false;
}
