/** 排便量（クイック／一覧入力のプルダウン） */
export const STOOL_VOLUME_OPTIONS = ['', '多', '中', '小', 'A', 'B', '付'];

/** 排便性状 */
export const STOOL_CHARACTER_OPTIONS = ['', '普通便', '硬便', '軟便', '泥状便', '水様便'];

/** 主食・副食の摂取割合 */
export const MEAL_WARI_OPTIONS = ['', '10割', '9割', '8割', '7割', '6割', '5割', '4割', '3割', '2割', '1割', '0割'];

/** 主食の食事形態（発注・記録用） */
export const MEAL_STAPLE_FORM_OPTIONS = ['', '普通食', '軟飯', 'おかゆ', '経管栄養', '点滴'];

/** 副食の食事形態（発注・記録用） */
export const MEAL_SIDE_FORM_OPTIONS = ['', '普通食', '刻み', '極刻み', 'ムース', '経管栄養', '点滴'];

/** 水分のとろみ（個別指示・カード） */
export const MEAL_FLUID_THICKEN_OPTIONS = ['', 'とろみなし', '薄いとろみ', '中間のとろみ', '濃いとろみ'];

/** 汁物・味噌汁（個別指示・カード） */
export const MEAL_SOUP_OPTIONS = ['', '通常', '味噌汁なし', '汁物なし'];

/**
 * カードの食事個別指示を表示・記録用1行にまとめる
 * @param {{ mealFluidThicken?: string; mealSoup?: string; mealIndividualNote?: string }} notes
 */
export function composeMealIndividualInstructions(notes) {
  const parts = [];
  const thicken = String(notes?.mealFluidThicken ?? '').trim();
  const soup = String(notes?.mealSoup ?? '').trim();
  const extra = String(notes?.mealIndividualNote ?? '').trim();
  if (thicken && thicken !== 'とろみなし') parts.push(`水分${thicken}`);
  if (soup && soup !== '通常') parts.push(soup);
  if (extra) parts.push(extra);
  return parts.join('・');
}

/** エンシュア・ソリタ等の経口栄養（缶・割合）一覧入力用 */
export const ENSURE_PORTION_OPTIONS = ['', '1/3', '1/2', '2/3', '1缶'];

/** @deprecated 別名。ENSURE_PORTION_OPTIONS と同じ */
export const ORAL_SUPPLEMENT_PORTION_OPTIONS = ENSURE_PORTION_OPTIONS;

/**
 * @param {unknown} portion ENSURE_PORTION_OPTIONS の値
 * @returns {string} ログ用（例: エンシュア1/2）
 */
export function composeEnsureLine(portion) {
  const p = String(portion ?? '').trim();
  return p ? `エンシュア${p}` : '';
}

/**
 * @param {unknown} portion ORAL_SUPPLEMENT_PORTION_OPTIONS の値
 * @returns {string} ログ用（例: ソリタ1/2）
 */
export function composeSolitaLine(portion) {
  const p = String(portion ?? '').trim();
  return p ? `ソリタ${p}` : '';
}

/**
 * @param {unknown} ensurePortion
 * @param {unknown} solitaPortion
 * @returns {string}
 */
export function composeOralSupplementLines(ensurePortion, solitaPortion) {
  return [composeEnsureLine(ensurePortion), composeSolitaLine(solitaPortion)].filter(Boolean).join(' ').trim();
}

/**
 * 保存済み食事メモからエンシュア・ソリタの割合を復元
 * @param {unknown} mealAmount
 */
export function parseOralSupplementsFromMealLog(mealAmount) {
  const s = String(mealAmount ?? '').trim();
  const ensureM = s.match(/エンシュア(1\/3|1\/2|2\/3|1缶)/u);
  const solitaM = s.match(/ソリタ(1\/3|1\/2|2\/3|1缶)/u);
  return {
    ensurePortion: ensureM ? ensureM[1] : '',
    solitaPortion: solitaM ? solitaM[1] : '',
  };
}

function normVoiceChars(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s/g, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

/**
 * @param {string} stapleWari
 * @param {string} sideWari
 * @param {string} [stapleForm]
 * @param {string} [sideForm]
 * @returns {string} ログ用 1 行（例: 主食(普通食)8割 副食(ムース)7割）
 */
export function composeMealAmountForLog(stapleWari, sideWari, stapleForm, sideForm) {
  const sw = String(stapleWari ?? '').trim();
  const dw = String(sideWari ?? '').trim();
  const sf = String(stapleForm ?? '').trim();
  const df = String(sideForm ?? '').trim();
  const parts = [];
  if (sf || sw) {
    parts.push(sf ? `主食(${sf})${sw}` : `主食${sw}`);
  }
  if (df || dw) {
    parts.push(df ? `副食(${df})${dw}` : `副食${dw}`);
  }
  return parts.join(' ');
}

/**
 * @param {string} mealAmount
 * @returns {{ mealStaple: string; mealSide: string; mealStapleForm: string; mealSideForm: string }}
 */
export function parseMealLogFields(mealAmount) {
  const s = String(mealAmount ?? '').trim();
  if (!s) {
    return { mealStaple: '', mealSide: '', mealStapleForm: '', mealSideForm: '' };
  }
  const staple = s.match(/主食(?:\(([^)]+)\))?(\d{1,2}割)?/u);
  const side = s.match(/副食(?:\(([^)]+)\))?(\d{1,2}割)?/u);
  return {
    mealStapleForm: String(staple?.[1] ?? '').trim(),
    mealStaple: String(staple?.[2] ?? '').trim(),
    mealSideForm: String(side?.[1] ?? '').trim(),
    mealSide: String(side?.[2] ?? '').trim(),
  };
}

/**
 * 発注集計: 対象区分の食事形態を解決（入力中＞保存済み）
 * @param {object} row 一覧表の行
 * @param {string} slot 朝・昼・夜
 * @param {string} savedMealAmount 保存済み mealAmount
 */
export function resolveMealFormsForSlot(row, slot, savedMealAmount = '') {
  const rowSlot = String(row?.mealSlot ?? '').trim() || slot;
  const draftApplies = rowSlot === slot;
  const parsed = parseMealLogFields(savedMealAmount);
  return {
    mealStapleForm: draftApplies ? String(row?.mealStapleForm ?? '').trim() || parsed.mealStapleForm : parsed.mealStapleForm,
    mealStaple: draftApplies ? String(row?.mealStaple ?? '').trim() || parsed.mealStaple : parsed.mealStaple,
    mealSideForm: draftApplies ? String(row?.mealSideForm ?? '').trim() || parsed.mealSideForm : parsed.mealSideForm,
    mealSide: draftApplies ? String(row?.mealSide ?? '').trim() || parsed.mealSide : parsed.mealSide,
  };
}

/** 欠食（0割）なら発注カウントから除外 */
export function mealWariCountsForOrder(wari) {
  return String(wari ?? '').trim() !== '0割';
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {Record<string, object>} bulkDraft
 * @param {string} slot
 * @param {Record<string, Record<string, string>>} savedByResident
 * @param {(name: unknown) => string} nameFmt
 */
export function countMealOrdersForSlot(residents, bulkDraft, slot, savedByResident, nameFmt) {
  const regular = [];
  const mousse = [];
  for (const res of residents) {
    const id = String(res.id);
    const row = bulkDraft[id] ?? {};
    const saved = String(savedByResident?.[id]?.[slot] ?? '').trim();
    const forms = resolveMealFormsForSlot(row, slot, saved);
    const nm = nameFmt(res.name);
    if (forms.mealStapleForm === '普通食' && mealWariCountsForOrder(forms.mealStaple)) {
      regular.push({ id, name: nm, room: String(res.room ?? '') });
    }
    if (forms.mealSideForm === 'ムース' && mealWariCountsForOrder(forms.mealSide)) {
      mousse.push({ id, name: nm, room: String(res.room ?? '') });
    }
  }
  return { regular, mousse };
}

const MEAL_ORDER_SLOTS = Object.freeze(['朝', '昼', '夜']);

/**
 * 発注集計: 朝・昼・夜の保存済み＋入力中を合算（1日分）
 * @param {Record<string, unknown>[]} residents
 * @param {Record<string, object>} bulkDraft
 * @param {string} activeSlot 入力中の食事区分（draft 判定用）
 * @param {Record<string, Record<string, string>>} savedByResident
 * @param {(name: unknown) => string} nameFmt
 */
export function countMealOrdersForDay(residents, bulkDraft, activeSlot, savedByResident, nameFmt) {
  const regular = [];
  const mousse = [];
  const seenRegular = new Set();
  const seenMousse = new Set();
  for (const slot of MEAL_ORDER_SLOTS) {
    for (const res of residents) {
      const id = String(res.id);
      const row = bulkDraft[id] ?? {};
      const saved = String(savedByResident?.[id]?.[slot] ?? '').trim();
      const forms = resolveMealFormsForSlot(row, slot, saved);
      const nm = nameFmt(res.name);
      if (forms.mealStapleForm === '普通食' && mealWariCountsForOrder(forms.mealStaple)) {
        const key = `${id}:${slot}:r`;
        if (!seenRegular.has(key)) {
          seenRegular.add(key);
          regular.push({ id, name: nm, room: String(res.room ?? ''), slot });
        }
      }
      if (forms.mealSideForm === 'ムース' && mealWariCountsForOrder(forms.mealSide)) {
        const key = `${id}:${slot}:m`;
        if (!seenMousse.has(key)) {
          seenMousse.add(key);
          mousse.push({ id, name: nm, room: String(res.room ?? ''), slot });
        }
      }
    }
  }
  return { regular, mousse };
}

/**
 * クイック記録・一覧表1行の入力から、保存時の「食事・水分系」ログの種別（applyCareQuickRecord と同じ条件）
 * @param {object} row
 * @param {string} [globalMealSlot] 一覧の共通「朝・昼・夜」が行に未反映のときの補正
 * @returns {'none' | 'fluid_intake' | 'meal'}
 */
export function getQuickCareMealEventKind(row, _globalMealSlot = '') {
  const meal = Boolean(row?.meal);
  const supplementLine = composeOralSupplementLines(row?.ensurePortion, row?.solitaPortion);
  // 食事形態（主食/副食の「形態」）は居室メモから自動補完されるため、
  // 形態だけ・間食メモだけでは食事として計上しない。
  // 実際に「割（主食/副食の摂取量）」「食事量メモ」「補助食」「水分」「内服」「食事チェック」が必要。
  const stapleWari = String(row?.mealStaple ?? '').trim();
  const sideWari = String(row?.mealSide ?? '').trim();
  const mealAmountTrim = String(row?.mealAmount ?? '').trim();
  const ma = stapleWari || sideWari || mealAmountTrim || supplementLine;
  const wm = String(row?.waterMl ?? '').trim();
  const med = row?.medicationTaken === 'yes' ? row.medicationTaken : '';
  const hasMealBody = Boolean(ma || med || meal);
  const waterOnly = Boolean(wm && !hasMealBody);
  if (waterOnly) return 'fluid_intake';
  if (hasMealBody) return 'meal';
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
  if (/泥状|でいじょう|デイジョウ/u.test(n)) return '泥状便';
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

/** 一覧表・個人カードの水分量（50〜500ml、項目を絞り込み） */
export const WATER_ML_50_OPTIONS = Object.freeze([
  { value: '', label: '—' },
  ...[50, 100, 150, 200, 250, 300, 400, 500].map((ml) => ({
    value: String(ml),
    label: `${ml}ml`,
  })),
]);

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
  { value: 'トイレ', label: 'トイレ' },
  { value: '尿器', label: '尿器' },
  { value: '少量', label: '少量' },
  { value: '中量', label: '中量' },
  { value: '多量', label: '多量' },
  { value: 'Ba', label: 'Ba' },
  { value: '尿測', label: '尿測' },
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

const HOURLY_STOOL_MULTI_DELIM = ';';

/** 同一時間の複数排便を配列で取得 */
export function splitMultiHourlyStoolCell(value) {
  const s = String(value ?? '').trim();
  if (!s) return [];
  return s
    .split(HOURLY_STOOL_MULTI_DELIM)
    .map((part) => parseHourlyStoolCellValue(part))
    .filter(Boolean);
}

/** 複数排便を1セルに連結 */
export function joinMultiHourlyStoolCell(entries) {
  const parts = (Array.isArray(entries) ? entries : [])
    .map((e) => {
      const v = String(e?.stoolVolume ?? '').trim();
      const c = String(e?.stoolCharacter ?? '').trim();
      if (!v && !c) return '';
      return `${v}${HOURLY_STOOL_DELIM}${c}`;
    })
    .filter(Boolean);
  return parts.join(HOURLY_STOOL_MULTI_DELIM);
}

/** 便セル内の記録回数（×2 等を合計に反映） */
export function countHourlyStoolEntries(hs) {
  let count = 0;
  for (let h = 0; h < 24; h++) {
    const entries = splitMultiHourlyStoolCell(hs?.[h]);
    if (entries.length > 0) count += entries.length;
    else if (String(hs?.[h] ?? '').trim()) {
      const p = parseHourlyStoolCellValue(hs[h]);
      if (p && (p.stoolVolume || p.stoolCharacter)) count += 1;
    }
  }
  return count;
}

export function popMultiHourlyStool(cell) {
  const entries = splitMultiHourlyStoolCell(cell);
  if (entries.length <= 1) return '';
  entries.pop();
  return joinMultiHourlyStoolCell(entries);
}

export function appendEmptyMultiHourlyStool(cell) {
  const entries = splitMultiHourlyStoolCell(cell);
  entries.push({ stoolVolume: '', stoolCharacter: '' });
  return joinMultiHourlyStoolCell(entries);
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
    patch.enteralStatus = 'done';
    patch.enteralMenuPlan = String(mIn.enteralNote ?? '').trim() || '経管実施';
  } else if (typeof mIn.enteralExecuted === 'boolean' && !mIn.enteralExecuted) {
    patch.enteralStatus = 'not_done';
  }
  return patch;
}
