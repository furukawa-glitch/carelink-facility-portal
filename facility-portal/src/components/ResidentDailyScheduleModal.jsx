import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import {
  addResidentDailyPlan,
  addResidentRecurringPlan,
  currentYmd,
  daysInCalendarMonth,
  getResidentDailyPlans,
  getResidentRecurringPlans,
  removeResidentDailyPlan,
  removeResidentRecurringPlan,
} from '../lib/residentDailySchedule.js';

const PLAN_TYPES = ['その他', 'デイ', '入浴', '受診', '外出', 'リハ', 'マッサージ', '面会', '食事'];
const WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日'];

function monthYmFromYmd(ymd) {
  const s = String(ymd ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(0, 7) : currentYmd().slice(0, 7);
}

function shiftMonthYm(monthYm, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthYm ?? '').trim());
  if (!m) return currentYmd().slice(0, 7);
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function firstWeekdayMon0(monthYm) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthYm ?? '').trim());
  if (!m) return 0;
  return (new Date(Number(m[1]), Number(m[2]) - 1, 1).getDay() + 6) % 7;
}

function planSourceLabel(source) {
  if (source === 'facility_sheet') return '表から取込';
  if (source === 'r8_calendar') return 'R8カレンダー取込';
  if (source === 'app_recurring') return '毎週';
  return 'アプリ入力';
}

function canDeletePlan(source) {
  return source === 'app' || source === 'r8_calendar' || source === 'app_recurring';
}

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   facilityLinkKey: string;
 *   resident: Record<string, unknown>;
 *   residentNameFmt: (name: unknown) => string;
 *   onSaved?: () => void;
 * }} props
 */
export function ResidentDailyScheduleModal({
  open,
  onClose,
  facilityLinkKey,
  resident,
  residentNameFmt,
  onSaved,
}) {
  const residentId = String(resident?.id ?? '').trim();
  const residentName = String(resident?.name ?? '');
  const todayYmd = currentYmd();

  const [viewMonthYm, setViewMonthYm] = useState(monthYmFromYmd(todayYmd));
  const [selectedYmd, setSelectedYmd] = useState(todayYmd);
  const [draftTime, setDraftTime] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftType, setDraftType] = useState('その他');
  const [recWeekdays, setRecWeekdays] = useState(() => [0, 2, 4]);
  const [recTime, setRecTime] = useState('');
  const [recTitle, setRecTitle] = useState('');
  const [recType, setRecType] = useState('その他');
  const [rev, setRev] = useState(0);

  const reload = useCallback(() => setRev((n) => n + 1), []);

  const monthDays = useMemo(() => daysInCalendarMonth(viewMonthYm), [viewMonthYm]);

  const plansByDay = useMemo(() => {
    void rev;
    /** @type {Record<string, ReturnType<typeof getResidentDailyPlans>>} */
    const map = {};
    for (const ymd of monthDays) {
      map[ymd] = getResidentDailyPlans(facilityLinkKey, residentId, ymd, residentName);
    }
    return map;
  }, [facilityLinkKey, residentId, residentName, monthDays, rev]);

  const recurring = useMemo(() => {
    void rev;
    return getResidentRecurringPlans(facilityLinkKey, residentId);
  }, [facilityLinkKey, residentId, rev]);

  const selectedPlans = plansByDay[selectedYmd] ?? [];

  useEffect(() => {
    if (!open) return;
    const m = monthYmFromYmd(todayYmd);
    setViewMonthYm(m);
    setSelectedYmd(todayYmd);
    setDraftTime('');
    setDraftTitle('');
    setDraftType('その他');
    reload();
  }, [open, residentId, todayYmd, reload]);

  useEffect(() => {
    if (!monthDays.includes(selectedYmd) && monthDays.length) {
      setSelectedYmd(monthDays[0]);
    }
  }, [monthDays, selectedYmd]);

  if (!open || !residentId) return null;

  const nm = residentNameFmt(resident?.name);
  const monthLabel = viewMonthYm.replace('-', '年') + '月';
  const leadingBlanks = firstWeekdayMon0(viewMonthYm);

  const handleAddDay = () => {
    const title = String(draftTitle ?? '').trim();
    if (!title) return;
    addResidentDailyPlan(facilityLinkKey, residentId, selectedYmd, {
      time: String(draftTime ?? '').trim(),
      title,
      type: draftType,
    });
    setDraftTitle('');
    setDraftTime('');
    reload();
    onSaved?.();
  };

  const handleAddRecurring = () => {
    const title = String(recTitle ?? '').trim();
    if (!title || !recWeekdays.length) return;
    addResidentRecurringPlan(facilityLinkKey, residentId, {
      weekdaysMon0: recWeekdays,
      time: String(recTime ?? '').trim(),
      title,
      type: recType,
    });
    setRecTitle('');
    setRecTime('');
    reload();
    onSaved?.();
  };

  const toggleRecWeekday = (d) => {
    setRecWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)
    );
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-end justify-center bg-black/55 p-2 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border-2 border-violet-400 bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-violet-100 bg-violet-50 px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black text-violet-950 sm:text-lg">
              <CalendarClock className="h-5 w-5 text-violet-700" aria-hidden />
              利用者の予定（1か月）
            </h2>
            <p className="text-xs font-bold text-violet-900/90">
              {nm} 様 {resident?.room ? `・${String(resident.room)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-violet-200 bg-white p-2 text-violet-800 hover:bg-violet-100"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="shrink-0 border-b border-slate-100 px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setViewMonthYm((m) => shiftMonthYm(m, -1))}
              className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"
              aria-label="前の月"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-sm font-black text-slate-800">{monthLabel}</span>
            <button
              type="button"
              onClick={() => setViewMonthYm((m) => shiftMonthYm(m, 1))}
              className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"
              aria-label="次の月"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-0.5 text-center text-[10px] font-black text-slate-500">
            {WEEKDAY_LABELS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="mt-0.5 grid grid-cols-7 gap-0.5">
            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <span key={`b${i}`} />
            ))}
            {monthDays.map((ymd) => {
              const n = Number(ymd.slice(8, 10));
              const count = (plansByDay[ymd] ?? []).length;
              const isSelected = selectedYmd === ymd;
              const isToday = ymd === todayYmd;
              return (
                <button
                  key={ymd}
                  type="button"
                  onClick={() => setSelectedYmd(ymd)}
                  className={`relative rounded-lg border py-1.5 text-xs font-black ${
                    isSelected
                      ? 'border-violet-600 bg-violet-600 text-white'
                      : isToday
                        ? 'border-violet-300 bg-violet-50 text-violet-900'
                        : 'border-slate-100 bg-white text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  {n}
                  {count > 0 ? (
                    <span
                      className={`absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${
                        isSelected ? 'bg-white' : 'bg-violet-500'
                      }`}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <p className="mb-2 text-xs font-black text-slate-600">
            {selectedYmd.replace(/-/g, '/')} の予定
          </p>
          {selectedPlans.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-sm font-bold text-slate-500">
              この日は予定がありません。下で追加するか、毎週の予定が自動で表示されます。
            </p>
          ) : (
            <ul className="space-y-2">
              {selectedPlans.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start gap-2 rounded-xl border border-violet-100 bg-violet-50/50 px-3 py-2"
                >
                  <span className="w-12 shrink-0 font-mono text-xs font-black text-violet-800">
                    {p.time || '—'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-slate-900">{p.title}</p>
                    <p className="text-[10px] font-bold text-slate-500">
                      {p.type} ・{planSourceLabel(p.source)}
                    </p>
                  </div>
                  {canDeletePlan(p.source) ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (p.source === 'app_recurring') {
                          const baseId = String(p.id).split(':')[1];
                          if (baseId) removeResidentRecurringPlan(facilityLinkKey, residentId, baseId);
                        } else {
                          removeResidentDailyPlan(facilityLinkKey, residentId, selectedYmd, p.id);
                        }
                        reload();
                        onSaved?.();
                      }}
                      className="shrink-0 rounded-lg border border-red-200 bg-white p-1.5 text-red-700 hover:bg-red-50"
                      title="削除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50/60 p-3">
            <p className="text-xs font-black text-teal-900">毎週決まっている予定</p>
            <p className="mt-0.5 text-[10px] font-bold text-teal-800/90">
              選んだ曜日は、この月のカレンダー上の該当日に自動表示されます（今後も同様）。
            </p>
            {recurring.length === 0 ? (
              <p className="mt-2 text-xs font-bold text-slate-500">未登録</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {recurring.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 rounded-lg border border-teal-100 bg-white px-2 py-1.5"
                  >
                    <span className="text-[10px] font-black text-teal-800">
                      {r.weekdaysMon0.map((d) => WEEKDAY_LABELS[d]).join('・')}
                    </span>
                    <span className="font-mono text-xs font-bold text-slate-700">{r.time || '—'}</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-900">
                      {r.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        removeResidentRecurringPlan(facilityLinkKey, residentId, r.id);
                        reload();
                        onSaved?.();
                      }}
                      className="shrink-0 rounded border border-red-200 p-1 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {WEEKDAY_LABELS.map((label, d) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleRecWeekday(d)}
                  className={`rounded-lg border px-2 py-0.5 text-xs font-black ${
                    recWeekdays.includes(d)
                      ? 'border-teal-600 bg-teal-600 text-white'
                      : 'border-slate-200 bg-white text-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-[4rem_1fr] gap-2">
              <input
                type="time"
                value={recTime}
                onChange={(e) => setRecTime(e.target.value)}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono font-bold"
              />
              <input
                value={recTitle}
                onChange={(e) => setRecTitle(e.target.value)}
                placeholder="例: 訪問リハ 10:00、入浴"
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-bold"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                value={recType}
                onChange={(e) => setRecType(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold"
              >
                {PLAN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAddRecurring}
                className="inline-flex items-center gap-1 rounded-xl border-2 border-teal-600 bg-teal-600 px-3 py-1 text-xs font-black text-white hover:bg-teal-500"
              >
                <Plus className="h-4 w-4" />
                毎週を追加
              </button>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-slate-100 bg-slate-50 px-4 py-3">
          <p className="mb-2 text-xs font-black text-slate-700">
            {selectedYmd.replace(/-/g, '/')} に予定を追加（1日だけ）
          </p>
          <div className="grid grid-cols-[4.5rem_1fr] gap-2">
            <input
              type="time"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-2 text-sm font-mono font-bold"
            />
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="例: デイ、入浴、受診、マッサージ"
              className="rounded-lg border border-slate-200 px-2 py-2 text-sm font-bold"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <select
              value={draftType}
              onChange={(e) => setDraftType(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold"
            >
              {PLAN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAddDay}
              className="inline-flex items-center gap-1 rounded-xl border-2 border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-black text-white hover:bg-violet-500"
            >
              <Plus className="h-4 w-4" />
              この日に追加
            </button>
          </div>
          <p className="mt-2 text-[10px] font-bold leading-snug text-slate-500">
            今後はアプリで入力してください。R8カレンダー取込分は削除できます。Googleお予定表からの取込分のみ、表を直して「お予定表を更新」が必要です。
          </p>
        </div>
      </div>
    </div>
  );
}
