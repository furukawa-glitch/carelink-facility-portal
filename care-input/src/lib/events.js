/**
 * ケアイベント生成。facility-portal（閲覧側）が解釈できる形に合わせる。
 * - 利用者の紐づけは「residentName + facilitySheetTitle」で照合されるため必須。
 * - 24時間表の巡視/尿/便は ts の時刻（東京）と type/meta から復元される。
 */

function newId() {
  return `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(ts) {
  const raw = String(ts ?? '').trim();
  const d = raw ? new Date(raw) : new Date();
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

/**
 * @param {object} p
 * @param {{ id?: string; name: string; facility: string }} p.resident
 * @param {string} p.type
 * @param {Record<string, unknown>} p.meta
 * @param {string} [p.ts]
 * @param {string} [p.recordedBy]
 */
function baseEvent({ resident, type, meta, ts, recordedBy }) {
  return {
    id: newId(),
    type,
    residentId: String(resident?.id ?? '').trim(),
    residentName: String(resident?.name ?? '').trim(),
    facilitySheetTitle: String(resident?.facility ?? '').trim(),
    ts: nowIso(ts),
    meta: { ...meta, recordedBy: String(recordedBy ?? '').trim() },
  };
}

/** バイタル */
export function buildVitalEvent(resident, vitals, recordedBy, ts) {
  const meta = {};
  for (const k of ['temp', 'bpUpper', 'bpLower', 'pulse', 'spo2', 'weight']) {
    const v = String(vitals?.[k] ?? '').trim();
    if (v) meta[k] = v;
  }
  meta.measuredAt = nowIso(ts);
  return baseEvent({ resident, type: 'vital_snapshot', meta, ts, recordedBy });
}

/** 巡視（その時刻に1件） */
export function buildPatrolEvent(resident, recordedBy, ts) {
  return baseEvent({ resident, type: 'patrol', meta: { note: '巡視' }, ts, recordedBy });
}

/** 排尿（hourlyKind:urine、コードと任意のml） */
export function buildUrineEvent(resident, { urineCode, measuredUrineMl }, recordedBy, ts) {
  const meta = {
    hourlyKind: 'urine',
    urineCode: String(urineCode ?? '').trim(),
    note: '排尿',
  };
  const ml = String(measuredUrineMl ?? '').trim();
  if (ml) meta.measuredUrineMl = ml;
  return baseEvent({ resident, type: 'excretion', meta, ts, recordedBy });
}

/** 排便（hourlyKind:stool、量と性状） */
export function buildStoolEvent(resident, { stoolVolume, stoolCharacter }, recordedBy, ts) {
  const meta = {
    hourlyKind: 'stool',
    stoolVolume: String(stoolVolume ?? '').trim(),
    stoolCharacter: String(stoolCharacter ?? '').trim(),
    note: '排便',
  };
  return baseEvent({ resident, type: 'excretion', meta, ts, recordedBy });
}

/** 食事（主食/副食の割） */
export function buildMealEvent(resident, { mealTime, mealStaple, mealSide }, recordedBy, ts) {
  // 閲覧側（facility-portal）の一覧表が読む形式に合わせる:
  //  - meta.mealSlot: '朝' | '昼' | '夜'（間食は区分外なので note で残す）
  //  - meta.mealAmount: 例 "主食8割 副食7割"（composeMealAmountForLog 互換）
  const t = String(mealTime ?? '').trim();
  const slot = t === '朝' || t === '昼' || t === '夜' ? t : '';
  const sw = String(mealStaple ?? '').trim();
  const dw = String(mealSide ?? '').trim();
  const parts = [];
  if (sw) parts.push(`主食${sw}割`);
  if (dw) parts.push(`副食${dw}割`);
  const mealAmount = parts.join(' ');
  const meta = {
    mealSlot: slot,
    mealAmount,
    mealStaple: sw ? `${sw}割` : '',
    mealSide: dw ? `${dw}割` : '',
  };
  if (t === '間食') meta.note = '間食';
  return baseEvent({ resident, type: 'meal', meta, ts, recordedBy });
}

/** 水分（ml） */
export function buildFluidEvent(resident, { waterMl }, recordedBy, ts) {
  const meta = { waterMl: String(waterMl ?? '').trim(), note: '水分' };
  return baseEvent({ resident, type: 'fluid_intake', meta, ts, recordedBy });
}

/** 当日（東京時間）の 00:00 を ISO で返す（pull_events の sinceTs 用） */
export function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** 取り消し（無効化）イベント: 同じ id を無効フラグ付きで再送信し上書きする */
export function voidEvent(ev) {
  const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
  return { ...ev, voided: true, meta: { ...meta, voided: true } };
}

/**
 * 編集: 新しく作ったイベントに、元イベントの id を引き継いで上書きさせる。
 * ts は新しい値（画面の「時刻」）を使うので、時刻の修正も反映できる。
 */
export function withIdentity(newEvent, sourceEvent) {
  if (!sourceEvent) return newEvent;
  return { ...newEvent, id: String(sourceEvent.id ?? newEvent.id) };
}

/** 一覧表示用の {time, kind, summary} */
export function describeEvent(ev) {
  const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
  const type = String(ev?.type ?? '');
  const d = new Date(String(ev?.ts ?? ''));
  const time = Number.isFinite(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '--:--';
  if (type === 'vital_snapshot') {
    const parts = [];
    if (meta.temp) parts.push(`体温${meta.temp}`);
    if (meta.bpUpper || meta.bpLower) parts.push(`血圧${meta.bpUpper ?? ''}/${meta.bpLower ?? ''}`);
    if (meta.pulse) parts.push(`脈${meta.pulse}`);
    if (meta.spo2) parts.push(`SpO2 ${meta.spo2}`);
    return { time, kind: 'バイタル', summary: parts.join(' ') || '記録' };
  }
  if (type === 'meal') {
    const slot = String(meta.mealSlot ?? '').trim() || (meta.note === '間食' ? '間食' : '食事');
    const amount = String(meta.mealAmount ?? '').trim();
    return { time, kind: `食事(${slot})`, summary: amount || '記録' };
  }
  if (type === 'fluid_intake') {
    return { time, kind: '水分', summary: meta.waterMl ? `${meta.waterMl}ml` : '記録' };
  }
  if (type === 'patrol') {
    return { time, kind: '巡視', summary: '巡視' };
  }
  if (type === 'excretion') {
    const hk = String(meta.hourlyKind ?? '').trim();
    if (hk === 'stool') {
      const s = [meta.stoolVolume, meta.stoolCharacter].filter(Boolean).join(' ');
      return { time, kind: '排便', summary: s || '記録' };
    }
    const u = [meta.urineCode, meta.measuredUrineMl ? `${meta.measuredUrineMl}ml` : ''].filter(Boolean).join(' ');
    return { time, kind: '排尿', summary: u || '記録' };
  }
  return { time, kind: type || '記録', summary: '' };
}
