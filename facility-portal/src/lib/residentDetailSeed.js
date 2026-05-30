import * as Report from '../services/ReportService.js';

function localYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hasVitalMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return ['temp', 'spo2', 'pulse', 'bpUpper', 'bpLower', 'weight'].some(
    (k) => String(meta[k] ?? '').trim() !== ''
  );
}

/** 一覧表・保存ログから個人カード用バイタル初期値（指定日のログ優先） */
export function vitalStateFromSaved(res, ymd = localYmd()) {
  const id = String(res?.id ?? '').trim();
  if (!id) return null;
  const fromDay = Report.getLatestVitalSnapshotMetaForResidentDay(id, ymd);
  if (fromDay && hasVitalMeta(fromDay)) {
    return {
      temp: fromDay.temp != null ? String(fromDay.temp) : '',
      spo2: fromDay.spo2 != null ? String(fromDay.spo2) : '',
      pulse: fromDay.pulse != null ? String(fromDay.pulse) : '',
      bpUpper: fromDay.bpUpper != null ? String(fromDay.bpUpper) : '',
      bpLower: fromDay.bpLower != null ? String(fromDay.bpLower) : '',
      weight:
        fromDay.weight != null && String(fromDay.weight).trim() !== ''
          ? String(fromDay.weight)
          : res?.weight != null && res.weight !== ''
            ? String(res.weight)
            : '',
    };
  }
  if (ymd === localYmd()) {
    const snap = Report.getResidentVitalSnapshot(id);
    if (snap) {
      return {
        temp: snap.temp != null ? String(snap.temp) : '',
        spo2: snap.spo2 != null ? String(snap.spo2) : '',
        pulse: snap.pulse != null ? String(snap.pulse) : '',
        bpUpper: snap.bpUpper != null ? String(snap.bpUpper) : '',
        bpLower: snap.bpLower != null ? String(snap.bpLower) : '',
        weight:
          snap.weight != null && String(snap.weight).trim() !== ''
            ? String(snap.weight)
            : res?.weight != null && res.weight !== ''
              ? String(res.weight)
              : '',
      };
    }
  }
  return null;
}

/** 当日の保存ログから食事・水分・内服・排泄の最新値 */
export function careStateFromTodayEvents(residentId, ymd = localYmd()) {
  const id = String(residentId ?? '').trim();
  const out = {
    mealValue: '10',
    isMissedMeal: false,
    hydration: '',
    medicationDone: true,
    enteralExecuted: false,
    enteralMenu: '',
    stoolAmount: '',
    stoolForm: '',
    urineMethod: 'おむつ',
    urineLevel: '中',
    balloonAmount: '',
    isBalloon: false,
    activeMealTime: '昼',
  };
  if (!id) return out;

  const events = Report.getCareEventsForResidentDay(id, ymd);
  /** @type {Record<string, unknown> | null} */
  let lastMeal = null;
  /** @type {Record<string, unknown> | null} */
  let lastFluid = null;
  /** @type {Record<string, unknown> | null} */
  let lastExcretion = null;
  /** @type {Record<string, unknown> | null} */
  let lastEnteral = null;

  for (const ev of events) {
    const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
    if (ev?.type === 'meal') lastMeal = meta;
    else if (ev?.type === 'fluid_intake') lastFluid = meta;
    else if (ev?.type === 'excretion') lastExcretion = meta;
    else if (ev?.type === 'enteral') lastEnteral = meta;
  }

  if (lastMeal) {
    const slot = String(lastMeal.mealSlot ?? '').trim();
    if (slot === '朝') out.activeMealTime = '朝';
    else if (slot === '昼') out.activeMealTime = '昼';
    else if (slot === '夜' || slot === '夕') out.activeMealTime = '夕';
    else if (slot === '間食' || slot === 'おやつ') out.activeMealTime = 'おやつ';

    const ma = String(lastMeal.mealAmount ?? '').trim();
    if (/欠食/u.test(ma)) {
      out.isMissedMeal = true;
    } else {
      const m = ma.match(/(\d{1,2})\s*割/u);
      if (m) out.mealValue = String(Math.min(10, parseInt(m[1], 10)));
      else if (/主食(\d)/u.test(ma)) {
        const m2 = ma.match(/主食(\d{1,2})/u);
        if (m2) out.mealValue = String(Math.min(10, parseInt(m2[1], 10)));
      }
    }
    if (lastMeal.medicationTaken === 'yes') out.medicationDone = true;
    else if (lastMeal.medicationTaken === 'no') out.medicationDone = false;
    if (lastMeal.waterMl != null && String(lastMeal.waterMl).trim() !== '') {
      out.hydration = String(lastMeal.waterMl);
    }
  }

  if (lastFluid?.waterMl != null && String(lastFluid.waterMl).trim() !== '') {
    out.hydration = String(lastFluid.waterMl);
  }

  if (lastEnteral) {
    out.enteralExecuted = true;
    if (lastEnteral.note != null && String(lastEnteral.note).trim() !== '') {
      out.enteralMenu = String(lastEnteral.note);
    }
  }

  if (lastExcretion) {
    const note = String(lastExcretion.note ?? '').trim();
    if (/バルーン/u.test(note)) {
      out.isBalloon = true;
      const bm = note.match(/(\d+)\s*ml/u);
      if (bm) out.balloonAmount = bm[1];
    } else {
      const uv = String(lastExcretion.urineVolume ?? '').trim();
      if (uv) {
        if (/^(多|中|小)/u.test(uv)) out.urineLevel = uv.charAt(0);
        else if (/トイレ/u.test(note) || /トイレ/u.test(uv)) out.urineMethod = 'トイレ';
      }
    }
    const sv = String(lastExcretion.stoolVolume ?? '').trim();
    if (sv) {
      const map = { 多: '多量', 中: '中等量', 小: '少量' };
      out.stoolAmount = map[sv] || sv;
    }
    const sc = String(lastExcretion.stoolCharacter ?? '').trim();
    if (sc) {
      const map = { 普通便: '普', 硬便: '硬', 軟便: '軟', 水様便: '水' };
      out.stoolForm = map[sc] || sc.charAt(0) || '普';
    }
  }

  return out;
}

/** 名簿・コンディションから経管メニュー候補 */
export function defaultEnteralMenuFromResident(res) {
  const fromSheet = String(res?.enteralMenuDefault ?? '').trim();
  if (fromSheet) return fromSheet;
  const cond = String(res?.condition ?? '').trim();
  if (!cond || cond === '—') return '';
  if (/経管|管栄|ＮＧＴ|NGT|胃ろう|Isocal|アイソカル|ラコール|メイバランス|エンシュア/u.test(cond)) {
    return cond;
  }
  return '';
}
