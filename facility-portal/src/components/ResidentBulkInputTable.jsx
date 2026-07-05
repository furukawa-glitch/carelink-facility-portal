import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Mic, PenLine, Table2 } from 'lucide-react';
import {
  HOURLY_URINE_OPTIONS,
  STOOL_VOLUME_OPTIONS,
  STOOL_CHARACTER_OPTIONS,
  MEAL_WARI_OPTIONS,
  ENSURE_PORTION_OPTIONS,
  WATER_ML_50_OPTIONS,
  countMealOrdersForDay,
  countHourlyStoolEntries,
  popMultiHourlyStool,
  appendEmptyMultiHourlyStool,
  joinMultiHourlyStoolCell,
  parseHourlyStoolCellValue,
  splitMultiHourlyStoolCell,
  getQuickCareMealEventKind,
  mapVoiceCareExtractToBulkRowPatch,
} from '../lib/careQuickCareFields.js';
import {
  HOURS_24,
  joinMultiHourlyValues,
  splitMultiHourlyValues,
  countHourlyUrineEntries,
  popMultiHourlyUrine,
  appendEmptyMultiHourlyUrine,
} from '../lib/hourlyCareGrid.js';
import { residentDiseaseLabel } from '../lib/residentDiseaseLabel.js';
import { PATROL_SLOT_HOURS, joinPatrolDateTimeLocal, splitPatrolDateTimeLocal } from '../lib/patrolSlots.js';
import { VoiceCareInput } from './VoiceCareInput.jsx';
import { VitalHandwritingModal } from './VitalHandwritingModal.jsx';
import * as Report from '../services/ReportService.js';

const DEFAULT_ROW = {
  temp: '',
  bpU: '',
  bpL: '',
  pulse: '',
  spo2: '',
  weight: '',
  patrol: false,
  patrolAt: '',
  meal: false,
  excretion: false,
  urineVolume: '',
  stoolVolume: '',
  stoolCharacter: '',
  mealSlot: '',
  mealStapleForm: '',
  mealStaple: '',
  mealSideForm: '',
  mealSide: '',
  mealAmount: '',
  waterMl: '',
  medicationTaken: '',
  toiletGuidance: false,
  ensurePortion: '',
  solitaPortion: '',
  enteralMenu: '',
  /** 経管メニュー表から（朝昼夜で切替・編集不可） */
  enteralMenuPlan: '',
  enteralMenuMed: '',
  /** '' | 'done' | 'not_done' */
  enteralStatus: '',
  mealExtras: '',
  hourPatrol: null,
  hourUrine: null,
  hourUrineMl: null,
  hourStool: null,
};

const HOURLY_STOOL_DELIM = '\t';

function fmtMeasuredAtJa(isoLike) {
  const t = new Date(String(isoLike ?? ''));
  if (!Number.isFinite(t.getTime())) return '';
  return t.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtVitalFrontLabelFromMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const parts = [
    String(m.temp ?? '').trim() ? `${String(m.temp).trim()}℃` : '',
    String(m.bpUpper ?? '').trim() || String(m.bpLower ?? '').trim()
      ? `${String(m.bpUpper ?? '').trim() || '-'} / ${String(m.bpLower ?? '').trim() || '-'}`
      : '',
    String(m.pulse ?? '').trim() ? `P${String(m.pulse).trim()}` : '',
    String(m.spo2 ?? '').trim() ? `SpO2 ${String(m.spo2).trim()}` : '',
    String(m.weight ?? '').trim() ? `${String(m.weight).trim()}kg` : '',
  ].filter(Boolean);
  return parts.join(' ・ ');
}

function splitHourStoolCell(value) {
  const parsed = parseHourlyStoolCellValue(value);
  return { vol: parsed?.stoolVolume ?? '', char: parsed?.stoolCharacter ?? '' };
}

function joinHourStoolCell(vol, char) {
  const v = String(vol ?? '').trim();
  const c = String(char ?? '').trim();
  if (!v && !c) return '';
  return `${v}${HOURLY_STOOL_DELIM}${c}`;
}

/** 食事列の短い表示（形態の繰り返しを省略） */
function shortMealSlotLabel(text) {
  const s = String(text ?? '').trim();
  if (!s || s === '—') return '—';
  return s
    .replace(/主食\(([^)]+)\)(\d{1,2}割)?/gu, (_, _f, w) => (w ? `主${w}` : '主'))
    .replace(/副食\(([^)]+)\)(\d{1,2}割)?/gu, (_, _f, w) => (w ? `副${w}` : '副'))
    .replace(/\s+/g, ' ')
    .trim();
}

function addDaysYmd(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localYmdNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ensureHour24(v) {
  if (!Array.isArray(v) || v.length !== 24) return Array(24).fill(false);
  return v.map((x) => x === true);
}
function ensureHour24Str(v) {
  return Array.isArray(v) && v.length === 24 ? v.map((x) => (x == null || x === false ? '' : String(x))) : Array(24).fill('');
}

function emptySavedHourly() {
  return {
    patrol: Array(24).fill(false),
    urine: Array(24).fill(false),
    stool: Array(24).fill(false),
  };
}

/**
 * 24時間グリッド（巡視・尿・便）。利用者1人ぶん。
 * 行ごとにメモ化し、触った行のグリッドだけ再描画する（重さ対策）。
 * props は変化しない参照（生の hourXxx 配列）を渡すこと。
 */
const HourGrid = React.memo(function HourGrid({
  id,
  nm,
  hourPatrol,
  hourUrine,
  hourUrineMl,
  hourStool,
  hourlySaved,
  patchBulkRow,
}) {
  const hp = ensureHour24(hourPatrol);
  const hu = ensureHour24Str(hourUrine);
  const hum = ensureHour24Str(hourUrineMl);
  const hs = ensureHour24Str(hourStool);
  const hourlySavedSafe = hourlySaved ?? emptySavedHourly();
  const hourRows = [
    {
      key: 'hourPatrol',
      arr: hp,
      savedKey: 'patrol',
      label: '巡',
      thBg: 'bg-cyan-50 text-cyan-800',
      tdBg: 'bg-cyan-50/60',
    },
    {
      key: 'hourUrine',
      arr: hu,
      mlArr: hum,
      savedKey: 'urine',
      label: '尿',
      thBg: 'bg-sky-50 text-sky-800',
      tdBg: 'bg-sky-50/60',
    },
    {
      key: 'hourStoolChar',
      arr: hs,
      savedKey: 'stool',
      label: '性状',
      thBg: 'bg-amber-100 text-amber-950',
      tdBg: 'bg-amber-50/80',
    },
    {
      key: 'hourStoolVol',
      arr: hs,
      savedKey: 'stool',
      label: '便量',
      thBg: 'bg-amber-50 text-amber-900',
      tdBg: 'bg-amber-50/60',
    },
  ];
  return (
    <table className="w-full min-w-[48rem] border-collapse text-[10px] font-black">
      <tbody>
        {hourRows.map((hr) => (
          <tr key={hr.key}>
            <th className={`w-7 border border-slate-300 px-0 py-0 text-center text-[11px] font-black ${hr.thBg}`}>
              {hr.label}
            </th>
            {HOURS_24.map((h) => {
              const saved = Boolean(hourlySavedSafe[hr.savedKey][h]);
              const isPatrol = hr.key === 'hourPatrol';
              const isStoolVol = hr.key === 'hourStoolVol';
              const isStoolChar = hr.key === 'hourStoolChar';
              const isUrine = hr.key === 'hourUrine';
              const urineCodes = isUrine ? splitMultiHourlyValues(hu[h]) : [];
              const urineMls = isUrine ? splitMultiHourlyValues(hum[h]) : [];
              const stoolEntries = isStoolVol || isStoolChar ? splitMultiHourlyStoolCell(hs[h]) : [];
              const lastStool = stoolEntries.length > 0 ? stoolEntries[stoolEntries.length - 1] : null;
              const legacyStool = splitHourStoolCell(hr.arr[h]);
              const stoolVol = lastStool?.stoolVolume ?? legacyStool.vol ?? '';
              const stoolChar = lastStool?.stoolCharacter ?? legacyStool.char ?? '';
              const cell = isPatrol
                ? ''
                : isStoolVol
                  ? stoolVol
                  : isStoolChar
                    ? stoolChar
                    : isUrine
                      ? urineCodes[urineCodes.length - 1] || String(hu[h] ?? '').trim()
                      : String(hr.arr[h] ?? '');
              const draftPatrolOn = isPatrol && hr.arr[h] === true;
              const filled = isPatrol
                ? hp[h] === true
                : Boolean(isUrine ? String(hu[h] ?? '').trim() : isStoolVol || isStoolChar ? String(hs[h] ?? '').trim() : cell);
              const urineNeedsMl = isUrine && (cell === '導尿' || cell === 'カテ' || cell === 'Ba' || cell === '尿測');
              const urineMlValue =
                urineMls.length > 0 ? urineMls[urineMls.length - 1] : String(hum[h] ?? '').trim();
              const multiCount = isUrine
                ? urineCodes.length
                : isStoolVol || isStoolChar
                  ? stoolEntries.length
                  : 0;
              return (
                <td key={`${hr.key}-${h}`} className={`relative border border-slate-300 p-0 text-center ${hr.tdBg}`}>
                  {isPatrol ? (
                    <label
                      className={`flex h-full min-h-[1.85rem] w-full min-w-[1.6rem] items-center justify-center rounded-sm border-2 px-0 py-0.5 transition ${
                        draftPatrolOn || saved
                          ? 'cursor-pointer border-teal-900 bg-teal-900'
                          : 'cursor-pointer border-dashed border-slate-300 bg-white hover:border-sky-500 hover:bg-sky-50/90'
                      }`}
                      title={
                        saved
                          ? 'チェックを外して保存すると取消できます'
                          : draftPatrolOn
                            ? 'チェックを外すと取消（まだ保存していません）'
                            : 'チェックでこの時間の巡視を記録 → 行の保存で確定'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={hp[h] === true}
                        onChange={() => {
                          const base = [...hp];
                          base[h] = !(base[h] === true);
                          patchBulkRow(id, { hourPatrol: base });
                        }}
                        className={`h-5 w-5 shrink-0 rounded ${
                          draftPatrolOn || saved
                            ? 'border-white/30 accent-teal-300'
                            : 'border-slate-300 accent-sky-600'
                        }`}
                        aria-label={`${nm} ${hr.label} ${h}時`}
                      />
                    </label>
                  ) : isUrine ? (
                    <div className="flex min-h-[1.7rem] flex-col gap-px">
                      {(urineCodes.length ? urineCodes : ['']).map((codeI, ui) => {
                        const codeVal = String(codeI ?? '');
                        const mlVal = String(urineMls[ui] ?? '');
                        const needsMlI =
                          codeVal === 'カテ' || codeVal === '導尿' || codeVal === 'Ba' || codeVal === '尿測';
                        return (
                          <div key={`u-${h}-${ui}`} className="flex flex-col">
                            <select
                              value={codeVal}
                              onChange={(e) => {
                                const codes = urineCodes.length ? [...urineCodes] : [''];
                                const mls = [...urineMls];
                                while (mls.length < codes.length) mls.push('');
                                const nextCode = e.target.value;
                                if (!nextCode && urineCodes.length > 1) {
                                  codes.splice(ui, 1);
                                  mls.splice(ui, 1);
                                } else {
                                  codes[ui] = nextCode;
                                  const keepMl =
                                    nextCode === 'カテ' || nextCode === '導尿' || nextCode === 'Ba' || nextCode === '尿測';
                                  if (!keepMl) mls[ui] = '';
                                }
                                patchBulkRow(id, {
                                  hourUrine: hu.map((v, k) => (k === h ? joinMultiHourlyValues(codes) : v)),
                                  hourUrineMl: hum.map((v, k) => (k === h ? joinMultiHourlyValues(mls) : v)),
                                });
                              }}
                              className={`h-full w-full min-w-[2rem] bg-white px-0 py-1 text-[11px] font-black ${
                                codeVal ? 'text-slate-900' : 'text-slate-500'
                              } ${saved ? 'ring-1 ring-teal-600/40' : ''}`}
                              title={saved ? '保存済み（変更後に再保存で上書き）' : undefined}
                              aria-label={`${nm} ${hr.label} ${h}時 ${ui + 1}件目`}
                            >
                              {(codeVal && !HOURLY_URINE_OPTIONS.some((o) => o.value === codeVal)
                                ? [{ value: codeVal, label: codeVal }, ...HOURLY_URINE_OPTIONS]
                                : HOURLY_URINE_OPTIONS
                              ).map((opt) => (
                                <option key={`${hr.key}-${ui}-${opt.value || 'empty'}`} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            {needsMlI ? (
                              <input
                                value={mlVal}
                                onChange={(e) => {
                                  const mls = [...urineMls];
                                  while (mls.length < (urineCodes.length || 1)) mls.push('');
                                  mls[ui] = e.target.value;
                                  patchBulkRow(id, {
                                    hourUrineMl: hum.map((v, k) => (k === h ? joinMultiHourlyValues(mls) : v)),
                                  });
                                }}
                                placeholder="ml"
                                inputMode="numeric"
                                className="w-full border-t border-sky-200 bg-sky-50/80 px-0 py-0.5 text-[11px] font-black"
                                aria-label={`${nm} 導尿量 ${h}時 ${ui + 1}件目`}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                      {cell || multiCount > 0 ? (
                        <div className="mt-px flex items-stretch gap-px">
                          <button
                            type="button"
                            onClick={() => {
                              const appended = appendEmptyMultiHourlyUrine(hu[h], hum[h]);
                              patchBulkRow(id, {
                                hourUrine: [...hu].map((v, i) => (i === h ? appended.codes : v)),
                                hourUrineMl: [...hum].map((v, i) => (i === h ? appended.mls : v)),
                              });
                            }}
                            className="flex-1 rounded-sm bg-sky-700 py-1 text-sm font-black leading-none text-white hover:bg-sky-600"
                            title="同じ時間にもう1件追加（各行で別の量・コードに変更できます）"
                            aria-label={`${nm} 尿 ${h}時 追加`}
                          >
                            ＋
                          </button>
                          {multiCount > 0 ? (
                            <button
                              type="button"
                              onClick={() => {
                                const popped = popMultiHourlyUrine(hu[h], hum[h]);
                                patchBulkRow(id, {
                                  hourUrine: [...hu].map((v, i) => (i === h ? popped.codes : v)),
                                  hourUrineMl: [...hum].map((v, i) => (i === h ? popped.mls : v)),
                                });
                              }}
                              className="flex-1 rounded-sm bg-rose-700 py-1 text-sm font-black leading-none text-white hover:bg-rose-600"
                              title="最後の1件を削除"
                              aria-label={`${nm} 尿 ${h}時 削除`}
                            >
                              －
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {multiCount > 1 ? (
                        <span className="text-[10px] font-black text-teal-800">×{multiCount}</span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="relative flex min-h-[1.7rem] flex-col gap-px">
                      {(stoolEntries.length ? stoolEntries : [{ stoolVolume: '', stoolCharacter: '' }]).map(
                        (entryI, si) => {
                          const entryVal = isStoolVol
                            ? String(entryI?.stoolVolume ?? '')
                            : String(entryI?.stoolCharacter ?? '');
                          return (
                            <select
                              key={`s-${hr.key}-${h}-${si}`}
                              value={entryVal}
                              onChange={(e) => {
                                const entries = (
                                  stoolEntries.length
                                    ? stoolEntries.map((x) => ({ ...x }))
                                    : [{ stoolVolume: '', stoolCharacter: '' }]
                                );
                                const nextVal = e.target.value;
                                const cur = entries[si] || { stoolVolume: '', stoolCharacter: '' };
                                entries[si] = isStoolVol
                                  ? { ...cur, stoolVolume: nextVal }
                                  : { ...cur, stoolCharacter: nextVal };
                                patchBulkRow(id, {
                                  hourStool: hs.map((v, k) => (k === h ? joinMultiHourlyStoolCell(entries) : v)),
                                });
                              }}
                              className={`h-full min-h-[1.7rem] w-full min-w-[2rem] bg-white px-0 py-1 text-[11px] font-black ${
                                entryVal ? 'text-slate-900' : 'text-slate-500'
                              } ${saved ? 'ring-1 ring-teal-600/40' : ''}`}
                              title={saved ? '保存済み（変更後に再保存で上書き）' : undefined}
                              aria-label={`${nm} ${hr.label} ${h}時 ${si + 1}件目`}
                            >
                              {(isStoolVol ? STOOL_VOLUME_OPTIONS : STOOL_CHARACTER_OPTIONS).map((opt) => (
                                <option key={`${hr.key}-${si}-${opt || 'empty'}`} value={opt}>
                                  {opt || '—'}
                                </option>
                              ))}
                            </select>
                          );
                        }
                      )}
                      {filled ? (
                        <div className="mt-px flex items-stretch gap-px">
                          <button
                            type="button"
                            onClick={() => {
                              const base = [...hs];
                              base[h] = appendEmptyMultiHourlyStool(base[h]);
                              patchBulkRow(id, { hourStool: base });
                            }}
                            className="flex-1 rounded-sm bg-amber-700 py-1 text-sm font-black leading-none text-white hover:bg-amber-600"
                            title="同じ時間に空欄を追加（性状・量を別々に入力）"
                            aria-label={`${nm} 便 ${h}時 追加`}
                          >
                            ＋
                          </button>
                          {multiCount > 0 ? (
                            <button
                              type="button"
                              onClick={() => {
                                const base = [...hs];
                                base[h] = popMultiHourlyStool(base[h]);
                                patchBulkRow(id, { hourStool: base });
                              }}
                              className="flex-1 rounded-sm bg-rose-700 py-1 text-sm font-black leading-none text-white hover:bg-rose-600"
                              title="最後の1件を削除"
                              aria-label={`${nm} 便 ${h}時 削除`}
                            >
                              －
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {multiCount > 1 ? (
                        <span className="text-[10px] font-black text-amber-900">×{multiCount}</span>
                      ) : null}
                    </div>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

/**
 * @param {{
 *   filteredResidents: Record<string, unknown>[];
 *   bulkDraft: Record<string, typeof DEFAULT_ROW>;
 *   bulkGlobalMealSlot: string;
 *   onBulkGlobalMealSlotChange: (slot: string) => void;
 *   bulkSheetDate: string;
 *   onBulkSheetDateChange: (ymd: string) => void;
 *   hourlySavedByResident: Record<string, { patrol: boolean[]; urine: boolean[]; stool: boolean[] }>;
 *   bulkMealSummaryByResident: Record<string, { 朝?: string; 昼?: string; 夜?: string }>;
 *   bulkUrineDetailByResident: Record<string, { hourly: { codes: string[]; mls: string[] }; totalMl: number }>;
 *   residentNameWithoutSama: (nameRaw: unknown) => string;
 *   patchBulkRow: (id: string, patch: Partial<typeof DEFAULT_ROW>) => void;
 *   setBulkPatrolForAllVisible: (checked: boolean) => void;
 *   fillPastHourlyPatrolForAllVisible: () => void;
 *   bulkRowHasInput: (row: Partial<typeof DEFAULT_ROW> | undefined) => boolean;
 *   saveBulkRow: (res: Record<string, unknown>) => void;
 *   saveBulkAllWithInput: () => void;
 *   saveBulkVitalsOnly: () => void;
 *   geminiApiKey?: string;
 *   facilityLinkKey?: string;
 * }} props
 */
export function ResidentBulkInputTable({
  filteredResidents,
  bulkDraft,
  bulkGlobalMealSlot,
  onBulkGlobalMealSlotChange,
  bulkSheetDate,
  onBulkSheetDateChange,
  hourlySavedByResident,
  bulkMealSummaryByResident,
  bulkUrineDetailByResident = {},
  bulkDayNightNoteByResident = {},
  residentNameWithoutSama,
  patchBulkRow,
  setBulkPatrolForAllVisible,
  fillPastHourlyPatrolForAllVisible,
  bulkRowHasInput,
  saveBulkRow,
  saveBulkAllWithInput,
  saveBulkVitalsOnly,
  geminiApiKey = '',
  facilityLinkKey = '',
  onTableEditingChange,
}) {
  const [voiceTarget, setVoiceTarget] = React.useState({ id: '', name: '' });
  const [handTarget, setHandTarget] = React.useState({ id: '', name: '' });
  const [savedFlashById, setSavedFlashById] = React.useState(/** @type {Record<string, boolean>} */ ({}));
  const [showHourlyGrid, setShowHourlyGrid] = React.useState(false);
  const [hourlyVisibleCount, setHourlyVisibleCount] = React.useState(0);
  const [, startHourlyTransition] = useTransition();
  const urineVolumeOptions = React.useMemo(
    () => [{ value: '', label: '—' }, ...WATER_ML_50_OPTIONS.filter((o) => o.value !== '')],
    []
  );
  const tableScrollRef = React.useRef(/** @type {HTMLDivElement | null} */ (null));
  const mealInputHeaderRef = React.useRef(/** @type {HTMLTableCellElement | null} */ (null));

  React.useEffect(() => {
    const onOpen = () => {
      startHourlyTransition(() => setShowHourlyGrid(true));
    };
    window.addEventListener('carelink-open-hourly-grid', onOpen);
    return () => window.removeEventListener('carelink-open-hourly-grid', onOpen);
  }, []);

  React.useEffect(() => {
    if (!showHourlyGrid) {
      setHourlyVisibleCount(0);
      return;
    }
    const total = filteredResidents.length;
    if (total <= 0) return;
    let count = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      count = Math.min(total, count + 2);
      setHourlyVisibleCount(count);
      if (count < total) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return () => {
      cancelled = true;
    };
  }, [showHourlyGrid, filteredResidents.length]);
  const showDetailedCareColumns = false;
  const scrollTableX = React.useCallback((delta) => {
    const el = tableScrollRef.current;
    if (!el) return;
    el.scrollLeft += delta;
  }, []);
  const keepTableScrollPosition = React.useCallback((fn) => {
    const el = tableScrollRef.current;
    const prevTop = el?.scrollTop ?? 0;
    const prevLeft = el?.scrollLeft ?? 0;
    fn();
    requestAnimationFrame(() => {
      if (!tableScrollRef.current) return;
      tableScrollRef.current.scrollTop = prevTop;
      tableScrollRef.current.scrollLeft = prevLeft;
    });
  }, []);
  const flashSaved = React.useCallback((id) => {
    const rid = String(id ?? '').trim();
    if (!rid) return;
    setSavedFlashById((prev) => ({ ...prev, [rid]: true }));
    window.setTimeout(() => {
      setSavedFlashById((prev) => {
        if (!prev[rid]) return prev;
        return { ...prev, [rid]: false };
      });
    }, 1200);
  }, []);
  const scrollToMealInputs = React.useCallback(() => {
    const scroller = tableScrollRef.current;
    const mealHeader = mealInputHeaderRef.current;
    if (!scroller || !mealHeader) return;
    const targetLeft = Math.max(0, mealHeader.offsetLeft - 160);
    scroller.scrollTo({ left: targetLeft, behavior: 'smooth' });
  }, []);

  const [orderDetail, setOrderDetail] = useState(/** @type {null | 'regular' | 'mousse'} */ (null));

  const mealOrderCounts = useMemo(
    () =>
      countMealOrdersForDay(
        filteredResidents,
        bulkDraft,
        bulkGlobalMealSlot,
        bulkMealSummaryByResident,
        residentNameWithoutSama
      ),
    [filteredResidents, bulkDraft, bulkGlobalMealSlot, bulkMealSummaryByResident, residentNameWithoutSama]
  );

  return (
    <div className="min-w-0 pb-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-base font-black text-emerald-800">
          <Table2 className="h-4 w-4 shrink-0" aria-hidden />
          バイタル・体重（月1回）・巡視・排尿・排便・食事（朝昼夜）・エンシュア・ソリタ・間食など・経管メニュー・水分・内服を一覧から
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-mono font-bold text-slate-600">
            {String(import.meta.env.VITE_APP_BUILD_ID ?? 'dev')}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => scrollTableX(-420)}
            className="rounded-lg border border-slate-400 bg-white px-2.5 py-1.5 text-sm font-black text-slate-700 hover:bg-slate-50"
            title="一覧を左へスクロール"
          >
            ← 左へ
          </button>
          <button
            type="button"
            onClick={() => scrollTableX(420)}
            className="rounded-lg border border-slate-400 bg-white px-2.5 py-1.5 text-sm font-black text-slate-700 hover:bg-slate-50"
            title="一覧を右へスクロール"
          >
            右へ →
          </button>
          <button
            type="button"
            onClick={() => setBulkPatrolForAllVisible(true)}
            className="rounded-lg border border-cyan-600 bg-cyan-50 px-3 py-1.5 text-sm font-black text-cyan-900 hover:bg-cyan-100"
          >
            巡視を全員ON
          </button>
          <button
            type="button"
            onClick={() => setBulkPatrolForAllVisible(false)}
            className="rounded-lg border border-slate-500 bg-slate-50 px-3 py-1.5 text-sm font-black text-slate-700 hover:bg-slate-100"
          >
            巡視を全員OFF
          </button>
          <button
            type="button"
            onClick={() => fillPastHourlyPatrolForAllVisible()}
            className="rounded-lg border border-cyan-700 bg-cyan-600 px-3 py-1.5 text-sm font-black text-white hover:bg-cyan-500"
            title="対象日の過去時間（現在時刻まで）の巡視を全員分まとめてON"
          >
            巡視し忘れ分を一括ON
          </button>
          <button
            type="button"
            onClick={() => {
              if (showHourlyGrid) setShowHourlyGrid(false);
              else startHourlyTransition(() => setShowHourlyGrid(true));
            }}
            className={`rounded-lg border px-3 py-1.5 text-sm font-black ${
              showHourlyGrid
                ? 'border-sky-800 bg-sky-700 text-white hover:bg-sky-600'
                : 'border-sky-500 bg-sky-50 text-sky-900 hover:bg-sky-100'
            }`}
            title="初期表示を軽くするため24時間表は閉じています。排泄入力時に開いてください。"
          >
            {showHourlyGrid ? '24時間表を閉じる' : '24時間表を開く'}
          </button>
        </div>
      </div>
      <div className="sticky bottom-2 z-20 mb-2 flex justify-end">
        <div className="flex flex-col gap-1 rounded-xl border-2 border-emerald-300 bg-white/95 px-2 py-2 shadow-lg backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => keepTableScrollPosition(saveBulkAllWithInput)}
              className="rounded-xl border-2 border-emerald-600 bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-500 sm:text-sm"
              title="入力がある行だけ、バイタル・食事・排泄・巡視などをまとめて保存"
            >
              一括保存（入力ありのみ）
            </button>
            <button
              type="button"
              onClick={() => keepTableScrollPosition(saveBulkVitalsOnly)}
              className="rounded-xl border-2 border-rose-500 bg-rose-50 px-3 py-2 text-xs font-black text-rose-900 hover:bg-rose-100 sm:text-sm"
              title="バイタル列（体温/血圧/脈拍/SpO2/体重/手書きメモ）だけ保存。巡視・食事・排泄は触りません"
            >
              一括保存（バイタルのみ）
            </button>
          </div>
          <p className="px-1 text-[10px] font-bold leading-snug text-slate-500">
            他PCへ反映するには「保存」が必要です（入力だけでは同期されません）。クラウド同期ONなら保存後、約1分以内に他PCへ届きます。
          </p>
        </div>
      </div>
      <p className="mb-2 text-sm font-bold leading-snug text-slate-500">
        下の表では<strong>摂取割（主食・副食）</strong>を行ごとに入力します（食事形態はカードの個別指示で設定）。<strong>食(計上)</strong>列は、保存で食事メモ（最大1回／水分のみのときは除く）の目安です。<strong>発注集計</strong>は朝・昼・夜の合計です。24時間表は保存後も修正できます。同じ時間に複数回ある場合はセル右の「＋」で追加、「－」で最後の1件を削除できます。
        <strong className="text-slate-700"> 24時間行</strong>は紙の様式に近い巡視・尿・便のマスです（対象日は下で指定）。<strong>エンシュア等</strong>・<strong>ソリタ</strong>は割合を選ぶと食事メモに残ります（例: エンシュア1/2 ソリタ1/3）。
        <strong className="text-slate-700"> 間食・補助</strong>はパン・バナナなど自由に書け、食事メモの末尾に「／」で連結されます。<strong className="text-slate-700"> 経管メニュー</strong>は上の<strong className="text-slate-700">朝・昼・夜</strong>に合わせて記録され、保存後は左の食事列の<strong className="text-slate-700">朝／昼／夕</strong>行に表示されます（1日2〜3回は区分を切り替えてそれぞれ保存）。
        <span className="ml-1 text-slate-700">横移動は上の「← 左へ / 右へ →」か、Shift+ホイールでも可能です。</span>
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border-2 border-orange-300 bg-gradient-to-r from-orange-50 to-amber-50 px-3 py-2.5 shadow-sm">
        <span className="text-sm font-black text-orange-950 sm:text-base">今回の食事区分（全員共通）</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="食事区分 朝昼夜">
          {['朝', '昼', '夜'].map((slot) => {
            const on = bulkGlobalMealSlot === slot;
            return (
              <button
                key={slot}
                type="button"
                onClick={() => {
                  onBulkGlobalMealSlotChange(slot);
                  setOrderDetail(null);
                  requestAnimationFrame(() => scrollToMealInputs());
                }}
                className={`min-w-[3.5rem] rounded-xl border-2 px-4 py-2 text-sm font-black transition sm:min-w-[4rem] sm:px-5 sm:text-base ${
                  on
                    ? 'border-orange-600 bg-orange-500 text-white shadow-md ring-2 ring-orange-400/80'
                    : 'border-orange-200 bg-white text-orange-900 hover:border-orange-400 hover:bg-orange-100/80'
                }`}
              >
                {slot}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto" role="group" aria-label="食事発注集計">
          <span className="text-xs font-black text-orange-900">発注（{bulkGlobalMealSlot || '—'}）</span>
          {[
            { key: 'regular', label: '普通食（1日）', count: mealOrderCounts.regular.length, cls: 'border-emerald-600 bg-emerald-50 text-emerald-950 hover:bg-emerald-100' },
            { key: 'mousse', label: 'ムース（1日）', count: mealOrderCounts.mousse.length, cls: 'border-pink-600 bg-pink-50 text-pink-950 hover:bg-pink-100' },
          ].map(({ key, label, count, cls }) => {
            const active = orderDetail === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setOrderDetail((prev) => (prev === key ? null : /** @type {'regular'|'mousse'} */ (key)))}
                className={`rounded-xl border-2 px-3 py-2 text-xs font-black transition sm:text-sm ${cls} ${
                  active ? 'ring-2 ring-orange-400 shadow-md' : ''
                }`}
                title={`${label}の人数と内訳を表示（主食普通食／副食ムース）`}
              >
                {label} <span className="font-mono text-base">{count}</span>名
              </button>
            );
          })}
        </div>
      </div>
      {orderDetail ? (
        <div className="mb-3 rounded-xl border-2 border-orange-200 bg-white px-3 py-2 shadow-sm">
          <p className="mb-1 text-xs font-black text-orange-950">
            {orderDetail === 'regular' ? '普通食（主食）' : 'ムース（副食）'} — {bulkGlobalMealSlot} の内訳（0割は除く）
          </p>
          <p className="text-sm font-bold leading-relaxed text-slate-800">
            {(orderDetail === 'regular' ? mealOrderCounts.regular : mealOrderCounts.mousse).length === 0
              ? '該当者なし（食事形態を選ぶか、保存済みデータを確認してください）'
              : (orderDetail === 'regular' ? mealOrderCounts.regular : mealOrderCounts.mousse)
                  .map((p) => `${p.room ? `${p.room} ` : ''}${p.name}`)
                  .join('、')}
          </p>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border-2 border-cyan-300 bg-gradient-to-r from-cyan-50 to-sky-50 px-3 py-2.5 shadow-sm">
        <label className="flex flex-wrap items-center gap-2 text-sm font-black text-cyan-950 sm:text-base">
          24時間表・時間別ログの日付
          <input
            type="date"
            value={bulkSheetDate}
            onChange={(e) => onBulkSheetDateChange(e.target.value)}
            className="rounded-xl border-2 border-cyan-500 bg-white px-2 py-1.5 font-mono text-sm font-bold text-cyan-950 shadow-inner"
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: '今日', delta: 0 },
            { label: '昨日', delta: -1 },
            { label: '一昨日', delta: -2 },
          ].map(({ label, delta }) => {
            const ymd = addDaysYmd(localYmdNow(), delta);
            const active = String(bulkSheetDate ?? '').slice(0, 10) === ymd;
            return (
              <button
                key={label}
                type="button"
                onClick={() => onBulkSheetDateChange(ymd)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-black transition ${
                  active
                    ? 'border-cyan-700 bg-cyan-600 text-white shadow'
                    : 'border-cyan-300 bg-white text-cyan-900 hover:bg-cyan-100'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="max-w-xl text-xs font-bold leading-snug text-cyan-900 sm:text-sm">
          日付は<strong>日本時間の暦日</strong>で集計します。<strong>今日</strong>の食事は<strong>朝・昼・夜</strong>の区分を合わせると入力欄に反映されます（care-input からの同期含む）。<strong>24時間表</strong>は重さ対策のため初期は閉じています（「24時間表を開く」または「↑排泄表へ」）。
        </p>
      </div>
      <div
        ref={tableScrollRef}
        onFocusCapture={() => onTableEditingChange?.(true)}
        onBlurCapture={(e) => {
          const root = tableScrollRef.current;
          if (!root) return;
          const next = e.relatedTarget;
          if (next && root.contains(next)) return;
          onTableEditingChange?.(false);
        }}
        onWheel={(e) => {
          if (!e.shiftKey) return;
          const el = tableScrollRef.current;
          if (!el) return;
          // Shift+ホイールを横スクロールとして扱う（入力中でも横移動しやすくする）
          const dx = Number(e.deltaY || e.deltaX || 0);
          if (!Number.isFinite(dx) || dx === 0) return;
          el.scrollLeft += dx;
          e.preventDefault();
        }}
        className="max-h-[min(70vh,720px)] overflow-auto rounded-xl border border-slate-200 shadow-inner"
      >
        <table className="w-full min-w-[3000px] border-collapse text-left text-sm sm:text-base">
          <thead className="sticky top-0 z-10 bg-slate-100 text-sm font-black uppercase text-slate-700 sm:text-sm">
            <tr>
              <th className="sticky left-0 z-30 border border-slate-200 bg-slate-100 px-0.5 py-1 text-slate-800 shadow-[1px_0_0_0_rgba(226,232,240,1)]">
                氏名
              </th>
              <th className="border border-slate-200 px-0.5 py-1">部屋</th>
              <th className="border border-slate-200 bg-emerald-50/70 px-0.5 py-1 whitespace-nowrap text-emerald-900" title="名簿の病名・主疾患列">
                病名
              </th>
              <th className="border border-slate-200 bg-rose-50/70 px-0.5 py-1 whitespace-nowrap text-rose-900">最新バイタル</th>
              <th className="border border-slate-200 bg-orange-50/70 px-0.5 py-1 whitespace-nowrap text-orange-900">食事</th>
              <th className="border border-slate-200 bg-sky-50/70 px-0.5 py-1 whitespace-nowrap text-sky-900">水分ml</th>
              <th className="border border-slate-200 bg-violet-50/70 px-0.5 py-1 whitespace-nowrap text-violet-900">内服</th>
              <th className="border border-slate-200 bg-sky-50/70 px-0.5 py-1 whitespace-nowrap text-sky-900" title="排尿回数と一日の尿量合計（ml）">
                尿回数<span className="block text-[9px] font-bold normal-case">／日計ml</span>
              </th>
              <th className="border border-slate-200 bg-amber-50/70 px-0.5 py-1 whitespace-nowrap text-amber-900">便回数</th>
              <th
                className="border border-slate-200 bg-emerald-50/70 px-0.5 py-1 whitespace-nowrap text-emerald-900"
                title="care-input「様子」タブの日中・夜勤メモ"
              >
                様子<span className="block text-[9px] font-bold normal-case">日中／夜勤</span>
              </th>
              <th className="border border-slate-200 bg-slate-50 px-0 py-0 text-center align-bottom">
                <div className="min-w-[28.5rem] px-0.5 py-1">
                  <p className="mb-0.5 text-[10px] font-black normal-case text-slate-800">
                    24時間（巡視・尿・便）0:00–23:00
                  </p>
                  <table className="w-full border-collapse text-[9px] font-black normal-case">
                    <thead>
                      <tr>
                        <th className="w-7 border border-slate-300 bg-white p-0" aria-hidden />
                        {HOURS_24.map((h) => (
                          <th key={h} className="border border-slate-300 bg-white px-0 py-0.5 text-center font-mono">
                            {String(h).padStart(2, '0')}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  </table>
                </div>
              </th>
              <th className="border border-slate-200 px-0.5 py-1">体温</th>
              <th className="border border-slate-200 px-0.5 py-1">上</th>
              <th className="border border-slate-200 px-0.5 py-1">下</th>
              <th className="border border-slate-200 px-0.5 py-1">脈</th>
              <th className="border border-slate-200 px-0.5 py-1">SpO2</th>
              <th className="border border-slate-200 px-0.5 py-1 whitespace-nowrap text-teal-900" title="月1回の体重測定">
                体重kg<span className="block text-[9px] font-bold normal-case">月1回</span>
              </th>
              {showDetailedCareColumns ? (
                <>
                  <th className="border border-slate-200 px-0.5 py-1">巡</th>
                  <th className="border border-slate-200 px-0.5 py-1">巡視(3h)</th>
                  <th className="border border-slate-200 px-0.5 py-1">排尿量</th>
                  <th
                    className="border border-slate-200 px-0.5 py-1 whitespace-nowrap text-sky-900"
                    title="トイレ誘導を実施したらチェック（6時間アラートの基準を更新）"
                  >
                    誘導
                  </th>
                  <th className="border border-slate-200 px-0.5 py-1">性状</th>
                  <th className="border border-slate-200 px-0.5 py-1">排便量</th>
                </>
              ) : null}
              <th
                ref={mealInputHeaderRef}
                className="border border-slate-200 bg-orange-50 px-0.5 py-1 whitespace-nowrap text-orange-950"
                title="上の「朝・昼・夜」が保存時に入ります"
              >
                主食割<span className="block text-[9px] font-bold normal-case">（区分は上）</span>
              </th>
              <th className="border border-slate-200 px-0.5 py-1">副食割</th>
              <th className="border border-slate-200 bg-sky-50/70 px-0.5 py-1 whitespace-nowrap text-sky-900">水分ml</th>
              <th className="border border-slate-200 bg-violet-50/70 px-0.5 py-1 whitespace-nowrap text-violet-900">内服</th>
              <th
                className="border border-slate-200 bg-violet-50 px-0.5 py-1 whitespace-nowrap text-violet-950"
                title="経口栄養（例: エンシュア）摂取割合"
              >
                エンシュア等
              </th>
              <th
                className="border border-slate-200 bg-teal-50 px-0.5 py-1 whitespace-nowrap text-teal-950"
                title="ソリタ（経口補助栄養）の摂取割合。食事メモに残ります"
              >
                ソリタ<span className="block text-[9px] font-bold normal-case">割合</span>
              </th>
              <th
                className="border border-slate-200 bg-amber-50 px-0.5 py-1 whitespace-nowrap text-amber-950"
                title="間食・補助食・おやつなど。食事メモに連結して保存されます"
              >
                間食・補助<span className="block text-[9px] font-bold normal-case">パン・バナナ等</span>
              </th>
              <th
                className="border border-slate-200 bg-violet-950/10 px-0.5 py-1 whitespace-nowrap text-violet-950"
                title="経管栄養の内容。保存すると「経管」ログとして残ります（製剤・量・本剤/水分など）"
              >
                経管メニュー<span className="block text-[9px] font-bold normal-case">実施／未実施</span>
              </th>
              <th
                className="border border-slate-200 bg-orange-50/60 px-0.5 py-1 text-center text-orange-950"
                title="保存で食事メモに計上する目安（1回を上限）。水分だけのときは食事回数には含まず、水分扱いになります"
              >
                食<span className="block text-[9px] font-bold normal-case">(計上)</span>
              </th>
              <th className="border border-slate-200 px-0.5 py-1"> </th>
            </tr>
          </thead>
          <tbody>
            {filteredResidents.map((res, rowIndex) => {
              const id = String(res.id);
              const nm = residentNameWithoutSama(res.name);
              const diseaseLabel = residentDiseaseLabel(res);
              const row = { ...DEFAULT_ROW, ...bulkDraft[id] };
              const pa = splitPatrolDateTimeLocal(row.patrolAt);
              const mealKind = getQuickCareMealEventKind(row, bulkGlobalMealSlot);
              const hourlySaved = hourlySavedByResident[id] ?? emptySavedHourly();
              const hu = ensureHour24Str(row.hourUrine);
              const hs = ensureHour24Str(row.hourStool);
              const urineDetail = bulkUrineDetailByResident[id] ?? { hourly: { codes: [], mls: [] }, totalMl: 0 };
              const urineSavedCodes = urineDetail.hourly?.codes ?? [];
              const urineSavedMls = urineDetail.hourly?.mls ?? [];
              const dayUrineMl = Number(urineDetail.totalMl ?? 0) || 0;
              let urineCount = countHourlyUrineEntries(hu, urineSavedCodes, hourlySaved.urine);
              if (String(row.urineVolume ?? '').trim()) urineCount++;
              let stoolCount = countHourlyStoolEntries(hs);
              if (
                stoolCount === 0 &&
                (String(row.stoolVolume ?? '').trim() || String(row.stoolCharacter ?? '').trim())
              ) {
                stoolCount += 1;
              }
              const latestVital = Report.getLatestVitalMetaForResidentDay(
                id,
                bulkSheetDate,
                Report.careEventResidentContext(res)
              );
              const vitalSavedLabel = fmtVitalFrontLabelFromMeta(latestVital.meta);
              const vitalMeasuredAt = fmtMeasuredAtJa(latestVital.measuredAt);
              const vitalDraftLabel = [
                String(row.temp ?? '').trim() ? `${String(row.temp).trim()}℃` : '',
                String(row.bpU ?? '').trim() || String(row.bpL ?? '').trim()
                  ? `${String(row.bpU ?? '').trim() || '-'} / ${String(row.bpL ?? '').trim() || '-'}`
                  : '',
                String(row.pulse ?? '').trim() ? `P${String(row.pulse).trim()}` : '',
                String(row.spo2 ?? '').trim() ? `SpO2 ${String(row.spo2).trim()}` : '',
              ]
                .filter(Boolean)
                .join(' ・ ');
              const vitalFrontLabel = vitalDraftLabel || vitalSavedLabel;
              const mealSlotLabel = String(row.mealSlot ?? '').trim() || String(bulkGlobalMealSlot ?? '').trim();
              const staplePart = [String(row.mealStapleForm ?? '').trim(), String(row.mealStaple ?? '').trim()]
                .filter(Boolean)
                .join('');
              const sidePart = [String(row.mealSideForm ?? '').trim(), String(row.mealSide ?? '').trim()]
                .filter(Boolean)
                .join('');
              const mealMainLabel = [
                staplePart ? `主${staplePart}` : '',
                sidePart ? `副${sidePart}` : '',
              ]
                .filter(Boolean)
                .join(' ');
              const mealFallback = String(row.mealAmount ?? '').trim();
              const ensureLabel = String(row.ensurePortion ?? '').trim() ? `エンシュア${String(row.ensurePortion).trim()}` : '';
              const solitaLabel = String(row.solitaPortion ?? '').trim() ? `ソリタ${String(row.solitaPortion).trim()}` : '';
              const extrasLabel = String(row.mealExtras ?? '').trim();
              const draftMealLabel = [mealMainLabel || mealFallback, ensureLabel, solitaLabel, extrasLabel]
                .filter(Boolean)
                .join(' ');
              const savedMealSlots = bulkMealSummaryByResident[id] ?? {};
              const mealFrontBySlot = {
                朝: String(savedMealSlots['朝'] ?? '').trim() || '—',
                昼: String(savedMealSlots['昼'] ?? '').trim() || '—',
                夜: String(savedMealSlots['夜'] ?? '').trim() || '—',
              };
              const draftMealPreview =
                mealSlotLabel && draftMealLabel ? `入力中 ${mealSlotLabel}:${draftMealLabel}` : '';

              return (
                <tr key={id} className="odd:bg-white even:bg-slate-50/50">
                  <td className="sticky left-0 z-20 border border-slate-200 px-1 py-1 font-bold text-slate-900 shadow-[1px_0_0_0_rgba(226,232,240,1)] group-odd:bg-white group-even:bg-slate-50/50">
                    {nm}
                  </td>
                  <td className="border border-slate-200 px-1 py-1 text-center font-mono">{String(res.room ?? '')}</td>
                  <td
                    className="max-w-[8rem] border border-slate-200 bg-emerald-50/40 px-1 py-1 text-[10px] font-bold leading-snug text-emerald-950 sm:text-xs"
                    title={diseaseLabel || '名簿に病名なし'}
                  >
                    <span className="line-clamp-3">{diseaseLabel || '—'}</span>
                  </td>
                  <td className="border border-slate-200 bg-rose-50/50 px-1 py-1 text-[10px] font-bold text-rose-900 sm:text-xs">
                    <div className="leading-snug">
                      <div className="line-clamp-2">{vitalFrontLabel || '—'}</div>
                      {vitalMeasuredAt ? (
                        <div className="mt-0.5 text-[9px] font-black text-rose-700/90">{vitalMeasuredAt}</div>
                      ) : null}
                    </div>
                  </td>
                  <td className="border border-slate-200 bg-orange-50/50 px-1 py-1 text-[10px] font-bold text-orange-900 sm:text-xs">
                    <div className="space-y-0.5 leading-snug">
                      {(
                        [
                          ['朝', mealFrontBySlot.朝],
                          ['昼', mealFrontBySlot.昼],
                          ['夕', mealFrontBySlot.夜],
                        ]
                      ).map(([label, text]) => {
                        const short = shortMealSlotLabel(text);
                        const isEnteral = /（実施）|（未実施）|ラコール|エンシュア|経管/u.test(String(text));
                        if (short === '—') return null;
                        return (
                          <p key={label} className={`truncate ${isEnteral ? 'text-violet-900' : ''}`}>
                            <span className="mr-1 inline-block min-w-[1.4rem] rounded bg-white/80 px-1 text-center">{label}</span>
                            {short}
                          </p>
                        );
                      })}
                      {draftMealPreview ? <p className="mt-1 border-t border-orange-200 pt-0.5 text-[9px] text-orange-700">{draftMealPreview}</p> : null}
                    </div>
                  </td>
                  <td className="border border-slate-200 bg-sky-50/50 px-1 py-1 text-center font-mono text-[11px] font-bold text-sky-900 sm:text-xs">
                    {String(row.waterMl ?? '').trim() || '—'}
                  </td>
                  <td className="border border-slate-200 bg-violet-50/50 px-1 py-1 text-center text-[10px] font-bold text-violet-900 sm:text-xs">
                    {row.medicationTaken === 'yes' ? '済' : row.medicationTaken === 'no' ? '未' : '—'}
                  </td>
                  <td className="border border-slate-200 bg-sky-50/50 px-1 py-1 text-center font-mono text-[11px] font-bold text-sky-900 sm:text-xs">
                    <div>{urineCount}</div>
                    {dayUrineMl > 0 ? <div className="text-[9px] font-black text-sky-700">{dayUrineMl}ml</div> : null}
                  </td>
                  <td className="border border-slate-200 bg-amber-50/50 px-1 py-1 text-center font-mono text-[11px] font-bold text-amber-900 sm:text-xs">
                    {stoolCount}
                  </td>
                  <td className="min-w-[9rem] max-w-[12rem] border border-slate-200 bg-emerald-50/30 px-1 py-1 text-[10px] font-bold leading-snug text-emerald-950 sm:text-xs">
                    {(() => {
                      const note = bulkDayNightNoteByResident[id];
                      const dayNote = String(note?.dayNote ?? '').trim();
                      const nightNote = String(note?.nightNote ?? '').trim();
                      if (!dayNote && !nightNote) return <span className="text-slate-400">—</span>;
                      return (
                        <div className="space-y-0.5">
                          {dayNote ? (
                            <p className="whitespace-pre-wrap break-words">
                              <span className="mr-1 inline-block rounded bg-amber-200/70 px-1 text-[9px] text-amber-900">日中</span>
                              {dayNote}
                            </p>
                          ) : null}
                          {nightNote ? (
                            <p className="whitespace-pre-wrap break-words">
                              <span className="mr-1 inline-block rounded bg-indigo-200/70 px-1 text-[9px] text-indigo-900">夜勤</span>
                              {nightNote}
                            </p>
                          ) : null}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="border border-slate-200 bg-slate-50/40 p-0 align-top">
                    {showHourlyGrid && rowIndex < hourlyVisibleCount ? (
                      <HourGrid
                        id={id}
                        nm={nm}
                        hourPatrol={row.hourPatrol}
                        hourUrine={row.hourUrine}
                        hourUrineMl={row.hourUrineMl}
                        hourStool={row.hourStool}
                        hourlySaved={hourlySaved}
                        patchBulkRow={patchBulkRow}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startHourlyTransition(() => setShowHourlyGrid(true))}
                        className="flex min-h-[3rem] w-full min-w-[6rem] flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-black text-slate-700 hover:bg-sky-50"
                        title="24時間表（巡視・尿・便）を開く"
                      >
                        {showHourlyGrid && rowIndex >= hourlyVisibleCount ? (
                          <span className="text-slate-400">読込中…</span>
                        ) : (
                          <>
                            <span>24h表を開く</span>
                            <span className="font-mono text-[9px] font-bold text-sky-800">
                              尿{urineCount} 便{stoolCount}
                            </span>
                          </>
                        )}
                      </button>
                    )}
                  </td>
                  <td className="border border-slate-200 p-0">
                    <input
                      value={row.temp}
                      onChange={(e) => patchBulkRow(id, { temp: e.target.value })}
                      inputMode="decimal"
                      className="w-full min-w-[2.75rem] bg-transparent px-1 py-1.5 font-mono text-sm font-bold sm:text-base"
                      aria-label={`${nm} 体温`}
                    />
                  </td>
                  <td className="border border-slate-200 p-0">
                    <input
                      value={row.bpU}
                      onChange={(e) => patchBulkRow(id, { bpU: e.target.value })}
                      inputMode="numeric"
                      className="w-full min-w-[2.25rem] bg-transparent px-1 py-1.5 font-mono text-sm sm:text-base"
                      aria-label={`${nm} 血圧上`}
                    />
                  </td>
                  <td className="border border-slate-200 p-0">
                    <input
                      value={row.bpL}
                      onChange={(e) => patchBulkRow(id, { bpL: e.target.value })}
                      inputMode="numeric"
                      className="w-full min-w-[2.25rem] bg-transparent px-1 py-1.5 font-mono text-sm sm:text-base"
                      aria-label={`${nm} 血圧下`}
                    />
                  </td>
                  <td className="border border-slate-200 p-0">
                    <input
                      value={row.pulse}
                      onChange={(e) => patchBulkRow(id, { pulse: e.target.value })}
                      inputMode="numeric"
                      className="w-full min-w-[2rem] bg-transparent px-1 py-1.5 font-mono text-sm sm:text-base"
                      aria-label={`${nm} 脈`}
                    />
                  </td>
                  <td className="border border-slate-200 p-0">
                    <input
                      value={row.spo2}
                      onChange={(e) => patchBulkRow(id, { spo2: e.target.value })}
                      inputMode="numeric"
                      className="w-full min-w-[2.5rem] bg-transparent px-1 py-1.5 font-mono text-sm sm:text-base"
                      aria-label={`${nm} SpO2`}
                    />
                  </td>
                  <td className="border border-slate-200 bg-teal-50/40 p-0">
                    <div className="flex items-center gap-1">
                      <input
                        value={row.weight}
                        onChange={(e) => patchBulkRow(id, { weight: e.target.value })}
                        inputMode="decimal"
                        placeholder="kg"
                        className="w-full min-w-[2.25rem] bg-transparent px-1 py-1.5 font-mono text-sm font-bold text-teal-950 sm:text-base"
                        aria-label={`${nm} 体重（月1回）`}
                      />
                      {geminiApiKey ? (
                        <button
                          type="button"
                          onClick={() => setVoiceTarget({ id, name: nm })}
                          className="rounded border border-blue-300 bg-blue-50 px-1 py-1 text-blue-700 hover:bg-blue-100"
                          title="音声でバイタル・食事入力"
                        >
                          <Mic className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setHandTarget({ id, name: nm })}
                        className="rounded border border-violet-300 bg-violet-50 px-1 py-1 text-violet-700 hover:bg-violet-100"
                        title="手書きメモ"
                      >
                        <PenLine className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                  {showDetailedCareColumns ? (
                    <>
                      <td className="border border-slate-200 px-0.5 py-0 text-center">
                        <input
                          type="checkbox"
                          checked={row.patrol}
                          onChange={(e) => patchBulkRow(id, { patrol: e.target.checked })}
                          className="h-5 w-5 accent-cyan-600 sm:h-5 sm:w-5"
                          aria-label={`${nm} 巡視`}
                        />
                      </td>
                      <td className="border border-slate-200 p-0.5 align-top">
                        <div className="flex min-w-[8.5rem] flex-col gap-0.5">
                          <input
                            type="date"
                            value={pa.date}
                            onChange={(e) =>
                              patchBulkRow(id, { patrolAt: joinPatrolDateTimeLocal(e.target.value, pa.hour) })
                            }
                            className="w-full bg-white px-1 py-1 font-mono text-[11px] font-bold sm:text-xs"
                            aria-label={`${nm} 巡視の日付`}
                          />
                          <select
                            value={pa.hour}
                            onChange={(e) =>
                              patchBulkRow(id, {
                                patrolAt: joinPatrolDateTimeLocal(pa.date, Number(e.target.value)),
                              })
                            }
                            className="w-full bg-white px-1 py-1 text-[11px] font-bold sm:text-xs"
                            aria-label={`${nm} 巡視時刻（3時間おき）`}
                          >
                            {PATROL_SLOT_HOURS.map((h) => (
                              <option key={h} value={h}>
                                {String(h).padStart(2, '0')}:00
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="border border-slate-200 p-0">
                        <input
                          value={row.urineVolume}
                          onChange={(e) => patchBulkRow(id, { urineVolume: e.target.value })}
                          placeholder="ml等"
                          className="w-full min-w-[3rem] bg-transparent px-1 py-1.5 text-sm sm:text-base"
                          aria-label={`${nm} 排尿量`}
                        />
                      </td>
                      <td className="border border-slate-200 bg-sky-50/50 px-0.5 py-0 text-center">
                        <input
                          type="checkbox"
                          checked={Boolean(row.toiletGuidance)}
                          onChange={(e) => patchBulkRow(id, { toiletGuidance: e.target.checked })}
                          className="h-5 w-5 accent-sky-700 sm:h-5 sm:w-5"
                          title="トイレ誘導"
                          aria-label={`${nm} トイレ誘導`}
                        />
                      </td>
                      <td className="border border-slate-200 p-0">
                        <select
                          value={row.stoolCharacter}
                          onChange={(e) => patchBulkRow(id, { stoolCharacter: e.target.value })}
                          className="w-full min-w-[4rem] bg-white px-1 py-1.5 text-sm font-bold sm:text-base"
                          aria-label={`${nm} 排便性状`}
                        >
                          {STOOL_CHARACTER_OPTIONS.map((opt) => (
                            <option key={opt || 'empty'} value={opt}>
                              {opt || '—'}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="border border-slate-200 p-0">
                        <select
                          value={row.stoolVolume}
                          onChange={(e) => patchBulkRow(id, { stoolVolume: e.target.value })}
                          className="w-full min-w-[2.75rem] bg-white px-1 py-1.5 text-sm font-bold sm:text-base"
                          aria-label={`${nm} 排便量`}
                        >
                          {STOOL_VOLUME_OPTIONS.map((opt) => (
                            <option key={opt || 'empty'} value={opt}>
                              {opt || '—'}
                            </option>
                          ))}
                        </select>
                      </td>
                    </>
                  ) : null}
                  <td className="border border-slate-200 bg-orange-50/30 p-0">
                    <select
                      value={row.mealStaple}
                      onChange={(e) => patchBulkRow(id, { mealStaple: e.target.value })}
                      className="w-full min-w-[3.25rem] bg-white px-1 py-1.5 text-sm font-bold sm:text-base"
                      aria-label={`${nm} 主食割`}
                    >
                      {MEAL_WARI_OPTIONS.map((opt) => (
                        <option key={opt || 'st-empty'} value={opt}>
                          {opt || '—'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-slate-200 p-0">
                    <select
                      value={row.mealSide}
                      onChange={(e) => patchBulkRow(id, { mealSide: e.target.value })}
                      className="w-full min-w-[3.25rem] bg-white px-1 py-1.5 text-sm font-bold sm:text-base"
                      aria-label={`${nm} 副食割`}
                    >
                      {MEAL_WARI_OPTIONS.map((opt) => (
                        <option key={`${opt}-side`} value={opt}>
                          {opt || '—'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-slate-200 bg-sky-50/40 p-0">
                    <select
                      value={String(row.waterMl ?? '')}
                      onChange={(e) => patchBulkRow(id, { waterMl: e.target.value })}
                      className="w-full min-w-[3rem] bg-white px-1 py-1.5 font-mono text-sm font-bold sm:text-base"
                      aria-label={`${nm} 水分量`}
                    >
                      {WATER_ML_50_OPTIONS.map((opt) => (
                        <option key={opt.value || 'w-empty'} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-slate-200 bg-violet-50/40 px-0.5 py-0 text-center">
                    <input
                      type="checkbox"
                      checked={row.medicationTaken === 'yes'}
                      onChange={(e) => patchBulkRow(id, { medicationTaken: e.target.checked ? 'yes' : '' })}
                      className="h-5 w-5 accent-violet-700 sm:h-5 sm:w-5"
                      title="内服（飲了）"
                      aria-label={`${nm} 内服`}
                    />
                  </td>
                  <td className="border border-slate-200 bg-violet-50/50 p-0">
                    <select
                      value={String(row.ensurePortion ?? '')}
                      onChange={(e) => patchBulkRow(id, { ensurePortion: e.target.value })}
                      className="w-full min-w-[4.5rem] bg-white px-1 py-1.5 text-xs font-bold text-violet-950 sm:text-sm"
                      aria-label={`${nm} エンシュア等の摂取量`}
                    >
                      {ENSURE_PORTION_OPTIONS.map((opt) => (
                        <option key={opt || 'ens-empty'} value={opt}>
                          {opt === '' ? '—' : opt === '1缶' ? '1缶（全量）' : `${opt} 相当`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-slate-200 bg-teal-50/50 p-0">
                    <select
                      value={String(row.solitaPortion ?? '')}
                      onChange={(e) => patchBulkRow(id, { solitaPortion: e.target.value })}
                      className="w-full min-w-[4.5rem] bg-white px-1 py-1.5 text-xs font-bold text-teal-950 sm:text-sm"
                      aria-label={`${nm} ソリタの摂取量`}
                    >
                      {ENSURE_PORTION_OPTIONS.map((opt) => (
                        <option key={opt || 'sol-empty'} value={opt}>
                          {opt === '' ? '—' : opt === '1缶' ? '1缶（全量）' : `${opt} 相当`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-slate-200 bg-amber-50/50 p-0 align-top">
                    <input
                      value={String(row.mealExtras ?? '')}
                      onChange={(e) => patchBulkRow(id, { mealExtras: e.target.value })}
                      placeholder="例: パン半分、バナナ🍌"
                      className="w-full min-w-[7rem] bg-transparent px-1 py-1.5 text-xs font-bold text-amber-950 placeholder:font-normal placeholder:text-amber-600/80 sm:min-w-[9rem] sm:text-sm"
                      aria-label={`${nm} 間食・補助食メモ`}
                    />
                  </td>
                  <td className="border border-slate-200 bg-violet-950/5 p-1 align-top">
                    {(() => {
                      const plan =
                        String(row.enteralMenuPlan ?? '').trim() ||
                        String(row.enteralMenu ?? '').trim();
                      const med = String(row.enteralMenuMed ?? '').trim();
                      const st = String(row.enteralStatus ?? '').trim();
                      if (!plan) {
                        return (
                          <p className="px-0.5 py-1 text-[10px] font-bold leading-snug text-violet-500">
                            「経管栄養メニュー一覧」で表を更新
                          </p>
                        );
                      }
                      return (
                        <div className="flex min-w-[7rem] flex-col gap-1 sm:min-w-[9rem]">
                          <p className="text-[10px] font-bold leading-snug text-violet-950 sm:text-xs">{plan}</p>
                          {med ? (
                            <p className="text-[9px] font-bold text-violet-800">
                              薬: <span className="font-black">{med}</span>
                            </p>
                          ) : null}
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                patchBulkRow(id, {
                                  enteralStatus: st === 'done' ? '' : 'done',
                                  mealSlot: bulkGlobalMealSlot,
                                })
                              }
                              className={`rounded-lg border-2 px-2 py-1 text-[10px] font-black sm:text-xs ${
                                st === 'done'
                                  ? 'border-violet-800 bg-violet-700 text-white'
                                  : 'border-violet-300 bg-white text-violet-900 hover:bg-violet-50'
                              }`}
                              aria-pressed={st === 'done'}
                              aria-label={`${nm} 経管 実施`}
                            >
                              実施
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                patchBulkRow(id, {
                                  enteralStatus: st === 'not_done' ? '' : 'not_done',
                                  mealSlot: bulkGlobalMealSlot,
                                })
                              }
                              className={`rounded-lg border-2 px-2 py-1 text-[10px] font-black sm:text-xs ${
                                st === 'not_done'
                                  ? 'border-slate-600 bg-slate-600 text-white'
                                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                              }`}
                              aria-pressed={st === 'not_done'}
                              aria-label={`${nm} 経管 未実施`}
                            >
                              未実施
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="border border-slate-200 bg-orange-50/30 px-1 py-0.5 text-center font-mono text-sm sm:text-base">
                    {mealKind === 'meal' ? (
                      <span className="font-black text-orange-800">1</span>
                    ) : mealKind === 'fluid_intake' ? (
                      <span className="whitespace-nowrap text-xs font-bold text-sky-800">水分</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="border border-slate-200 px-0.5 py-0.5 text-center">
                    <button
                      type="button"
                      disabled={!bulkRowHasInput(row)}
                      onClick={() =>
                        keepTableScrollPosition(() => {
                          saveBulkRow(res);
                          flashSaved(id);
                        })
                      }
                      className={`rounded px-3 py-1.5 text-sm font-black text-white disabled:opacity-40 sm:text-base ${
                        savedFlashById[id] ? 'bg-emerald-400 ring-2 ring-emerald-300' : 'bg-emerald-600'
                      }`}
                    >
                      {savedFlashById[id] ? '保存済み' : '保存'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {voiceTarget.id ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-3">
          <div className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-black text-slate-900">{voiceTarget.name} 音声入力</p>
              <button
                type="button"
                onClick={() => setVoiceTarget({ id: '', name: '' })}
                className="rounded border border-slate-300 px-2 py-1 text-xs font-bold"
              >
                閉じる
              </button>
            </div>
            <VoiceCareInput
              apiKey={geminiApiKey}
              onPatch={(extracted) => {
                const patch = mapVoiceCareExtractToBulkRowPatch(extracted);
                patchBulkRow(voiceTarget.id, patch);
              }}
            />
          </div>
        </div>
      ) : null}
      <VitalHandwritingModal
        open={Boolean(handTarget.id)}
        residentName={handTarget.name}
        initialDataUrl={handTarget.id ? String((bulkDraft[handTarget.id] ?? {}).vitalHandwritingDataUrl ?? '') : ''}
        onClose={() => setHandTarget({ id: '', name: '' })}
        onConfirm={(dataUrl) => {
          if (!handTarget.id) return;
          patchBulkRow(handTarget.id, { vitalHandwritingDataUrl: dataUrl });
        }}
      />
    </div>
  );
}
