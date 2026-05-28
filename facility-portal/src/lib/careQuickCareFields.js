/** 排便量（クイック／一覧入力のプルダウン） */
export const STOOL_VOLUME_OPTIONS = ['', '多', '中', '小'];

/** 排便性状 */
export const STOOL_CHARACTER_OPTIONS = ['', '普通便', '硬便', '軟便', '水様便'];

/** 主食・副食の摂取割合 */
export const MEAL_WARI_OPTIONS = ['', '10割', '9割', '8割', '7割', '6割', '5割', '4割', '3割', '2割', '1割', '0割'];

/** エンシュア等の経口栄養（缶・割合）一覧入力用 */
export const ENSURE_PORTION_OPTIONS = ['', '1/3', '1/2', '2/3', '1缶'];

/**
 * @param {unknown} portion ENSURE_PORTION_OPTIONS の値
 * @returns {string} ログ用（例: エンシュア1/2）
 */
export function composeEnsureLine(portion) {
  const p = String(portion ?? '').trim();
  return p ? `エンシュア${p}` : '';
}

function normVoiceChars(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s/g, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

/**
 * @param {string} staple
 * @param {string} side
 * @returns {string} ログ用 1 行（例: 主食8割 副食7割）
 */
export function composeMealAmountForLog(staple, side) {
  const s = String(staple ?? '').trim();
  const d = String(side ?? '').trim();
  const parts = [];
  if (s) parts.push(`主食${s}`);
  if (d) parts.push(`副食${d}`);
  return parts.join(' ');
}

/**
 * クイック記録・一覧表1行の入力から、保存時の「食事・水分系」ログの種別（applyCareQuickRecord と同じ条件）
 * @param {object} row
 * @param {string} [globalMealSlot] 一覧の共通「朝・昼・夜」が行に未反映のときの補正
 * @returns {'none' | 'fluid_intake' | 'meal'}
 */
export function getQuickCareMealEventKind(row, globalMealSlot = '') {
  const meal = Boolean(row?.meal);
  const mealSlot = String(row?.mealSlot ?? globalMealSlot ?? '').trim();
  const composed = composeMealAmountForLog(row?.mealStaple, row?.mealSide);
  const ensureLine = composeEnsureLine(row?.ensurePortion);
  const extras = String(row?.mealExtras ?? '').trim();
  const ma = composed || String(row?.mealAmount ?? '').trim() || ensureLine || extras;
  const wm = String(row?.waterMl ?? '').trim();
  const med = row?.medicationTaken === 'yes' || row?.medicationTaken === 'no' ? row.medicationTaken : '';
  const waterOnly = Boolean(wm && !ma && !med && !meal);
  if (waterOnly) return 'fluid_intake';
  if (mealSlot || ma || wm || med) return 'meal';
  if (meal) return 'meal';
  return 'none';
}

/** @param {string} text 音声認識結果 */
export function parseVoiceToStoolVolume(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (STOOL_VOLUME_OPTIONS.includes(raw)) return raw;
  const n = normVoiceChars(raw);
  if (/(多|大|おお|だい|ダイ)/u.test(n)) return '多';
  if (/(中|ちゅう|チュウ|なか)/u.test(n)) return '中';
  if (/(小|しょう|ショウ|すくない)/u.test(n)) return '小';
  return '';
}

/** @param {string} text */
export function parseVoiceToStoolCharacter(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (STOOL_CHARACTER_OPTIONS.includes(raw)) return raw;
  const n = normVoiceChars(raw);
  if (/水様|みずよう|スイヨ/u.test(n)) return '水様便';
  if (/硬便|こうべん|カタ|硬い/u.test(n)) return '硬便';
  if (/軟便|なんべん|ナン|やわらか|軟か/u.test(n)) return '軟便';
  if (/普通便|ふつうべん|ふつう|フツウ|普通/u.test(n)) return '普通便';
  for (const opt of STOOL_CHARACTER_OPTIONS) {
    if (opt && n.includes(opt)) return opt;
  }
  return '';
}

/** @param {string} text */
export function parseVoiceToMealWari(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (MEAL_WARI_OPTIONS.includes(raw)) return raw;
  const n = normVoiceChars(raw);
  const m = n.match(/(\d{1,2})\s*割/u);
  if (m) {
    const v = Math.min(10, Math.max(0, parseInt(m[1], 10)));
    return `${v}割`;
  }
  const spokenWari = [
    [/いちわり|イチワリ|一割/u, '1割'],
    [/にわり|ニワリ|二割/u, '2割'],
    [/さんわり|サンワリ|三割/u, '3割'],
    [/よんわり|ヨンワリ|四割/u, '4割'],
    [/ごわり|ゴワリ|五割/u, '5割'],
    [/ろくわり|ロクワリ|六割/u, '6割'],
    [/ななわり|ナナワリ|シチワリ|七割/u, '7割'],
    [/はちわり|ハチワリ|八割/u, '8割'],
    [/きゅうわり|キュウワリ|九割/u, '9割'],
    [/じゅうわり|ジュウワリ|十割/u, '10割'],
    [/れいわり|レイワリ|ゼロわり/u, '0割'],
  ];
  for (const [re, val] of spokenWari) {
    if (re.test(n)) return val;
  }
  const jpNum = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  for (const [ch, val] of Object.entries(jpNum)) {
    if (n.includes(`${ch}割`) || n.includes(`${ch}わり`)) return `${val}割`;
  }
  if (/全量|全部|ぜんぶ|ぜんりょう|満腹|マン|100パー|100%/u.test(n)) return '10割';
  if (/ゼロ|れい|未摂|無し|なし|0割|食べず|食べていない/u.test(n)) return '0割';
  return '';
}

/** 水分 ml 用（数字を拾う） */
export function parseVoiceToWaterMl(text) {
  const n = normVoiceChars(String(text ?? ''));
  const m = n.match(/(\d{2,4})/);
  if (m) return m[1];
  const m2 = n.match(/(\d+)/);
  return m2 ? m2[1] : '';
}

/** 24時間表・各時の排尿セル */
export const HOURLY_URINE_OPTIONS = Object.freeze([
  { value: '', label: '—' },
  { value: '少量', label: '少量' },
  { value: '中量', label: '中量' },
  { value: '多量', label: '多量' },
  { value: '失禁', label: '失禁' },
  { value: 'カテ', label: 'カテ' },
]);

const HOURLY_STOOL_DELIM = '\t';

/**
 * 24時間表・各時の排便セル（量+性状）
 * @returns {{ value: string; label: string }[]}
 */
export function getHourlyStoolSelectOptions() {
  /** @type {{ value: string; label: string }[]} */
  const out = [
    { value: '', label: '—' },
  ];
  for (const v of STOOL_VOLUME_OPTIONS) {
    if (!v) continue;
    for (const c of STOOL_CHARACTER_OPTIONS) {
      if (!c) continue;
      out.push({ value: `${v}${HOURLY_STOOL_DELIM}${c}`, label: `${v}・${c}` });
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {{ stoolVolume: string; stoolCharacter: string } | null}
 */
export function parseHourlyStoolCellValue(value) {
  const s = String(value ?? '').trim();
  if (!s || s === 'plain') return null;
  const [v = '', c = ''] = s.split(HOURLY_STOOL_DELIM);
  const vv = String(v).trim();
  const cc = String(c).trim();
  if (!vv && !cc) return null;
  return { stoolVolume: vv, stoolCharacter: cc };
}

/**
 * @param {{ vitals?: Record<string, unknown>; meal?: Record<string, unknown> }} extracted
 * @returns {Record<string, unknown>}
 */
export function mapVoiceCareExtractToBulkRowPatch(extracted) {
  const patch = {};
  const vIn = extracted?.vitals && typeof extracted.vitals === 'object' ? extracted.vitals : {};
  const vitalMap = [
    ['temp', 'temp'],
    ['bpUpper', 'bpU'],
    ['bpLower', 'bpL'],
    ['pulse', 'pulse'],
    ['spo2', 'spo2'],
    ['weight', 'weight'],
  ];
  for (const [src, dst] of vitalMap) {
    const val = vIn[src];
    if (val != null && String(val).trim() !== '') patch[dst] = String(val).trim();
  }

  const mIn = extracted?.meal && typeof extracted.meal === 'object' ? extracted.meal : {};
  if (typeof mIn.mealTime === 'string' && ['朝', '昼', '夜'].includes(mIn.mealTime)) {
    patch.mealSlot = mIn.mealTime;
    patch.meal = true;
  }
  if (mIn.mealValue != null) {
    const mv = String(mIn.mealValue).trim();
    if (/^(10|[0-9])$/.test(mv)) {
      patch.mealStaple = `${mv}割`;
      patch.meal = true;
    }
  }
  if (typeof mIn.isMissedMeal === 'boolean' && mIn.isMissedMeal) {
    patch.mealStaple = '0割';
    patch.mealSide = '0割';
    patch.meal = true;
  }
  if (mIn.hydration != null && String(mIn.hydration).trim() !== '') {
    const n = String(mIn.hydration).replace(/\D/g, '');
    if (n) patch.waterMl = n;
  }
  if (typeof mIn.medicationDone === 'boolean') patch.medicationTaken = mIn.medicationDone ? 'yes' : 'no';
  if (typeof mIn.enteralExecuted === 'boolean' && mIn.enteralExecuted) {
    patch.enteralMenu = String(mIn.enteralNote ?? '').trim() || '経管実施';
  }
  return patch;
}
