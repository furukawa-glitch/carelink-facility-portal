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

/** 食事（主食/副食の割・任意メモ） */
export function buildMealEvent(resident, { mealTime, mealStaple, mealSide, mealAmount }, recordedBy, ts) {
  const meta = {
    mealTime: String(mealTime ?? '').trim(),
    mealStaple: String(mealStaple ?? '').trim(),
    mealSide: String(mealSide ?? '').trim(),
    mealAmount: String(mealAmount ?? '').trim(),
  };
  // 閲覧側の旧キー互換（mealValue/mealTime）
  if (meta.mealStaple) meta.mealValue = meta.mealStaple;
  return baseEvent({ resident, type: 'meal', meta, ts, recordedBy });
}

/** 水分（ml） */
export function buildFluidEvent(resident, { waterMl }, recordedBy, ts) {
  const meta = { waterMl: String(waterMl ?? '').trim(), note: '水分' };
  return baseEvent({ resident, type: 'fluid_intake', meta, ts, recordedBy });
}
