import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bath, ChevronLeft, ChevronRight, Loader2, Save, X } from 'lucide-react';
import {
  BATH_KIND_OPTIONS,
  addDaysYmd,
  loadBathScheduleDraft,
  mergeBathScheduleRows,
  mondayOfWeek,
  saveBathScheduleDraft,
  weekYmdsFromMonday,
  weekdayLabelJa,
} from '../lib/bathingSchedule.js';

const INPUT_CLASS =
  'w-full rounded border border-slate-300 bg-white px-1 py-1 text-xs font-bold text-slate-900 placeholder:text-slate-500';

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   facilityLabel: string;
 *   facilityLinkKey?: string;
 *   residents: Record<string, unknown>[];
 *   onSaved?: () => void;
 * }} props
 */
export function BathingScheduleModal({
  open,
  onClose,
  facilityLabel,
  facilityLinkKey = '',
  residents,
  onSaved,
}) {
  const [weekStartYmd, setWeekStartYmd] = useState(() => mondayOfWeek());
  const [rows, setRows] = useState(/** @type {import('../lib/bathingSchedule.js').BathScheduleRow[]} */ ([]));
  const [saveState, setSaveState] = useState(/** @type {'saved' | 'dirty' | 'saving'} */ ('saved'));
  const [saveHint, setSaveHint] = useState('');
  const saveTimerRef = useRef(0);

  const roster = useMemo(() => (Array.isArray(residents) ? residents : []), [residents]);
  const weekYmds = useMemo(() => weekYmdsFromMonday(weekStartYmd), [weekStartYmd]);

  const draft = useMemo(() => ({ weekStartYmd, rows }), [weekStartYmd, rows]);

  const persistDraft = useCallback(
    (opts = {}) => {
      const silent = opts.silent === true;
      if (!silent) setSaveState('saving');
      saveBathScheduleDraft(facilityLinkKey, draft);
      if (!silent) {
        setSaveState('saved');
        setSaveHint(`保存しました ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`);
      } else {
        setSaveState('saved');
      }
      onSaved?.();
    },
    [draft, facilityLinkKey, onSaved]
  );

  const markDirty = useCallback(() => {
    setSaveState('dirty');
    setSaveHint('未保存の変更があります');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = 0;
      persistDraft({ silent: true });
      setSaveHint('自動保存しました');
    }, 2000);
  }, [persistDraft]);

  const loadWeek = useCallback(
    (startYmd) => {
      const start = mondayOfWeek(startYmd);
      const loaded = loadBathScheduleDraft(facilityLinkKey);
      setWeekStartYmd(start);
      if (loaded.weekStartYmd === start) {
        setRows(mergeBathScheduleRows(roster, loaded.rows));
      } else {
        setRows(mergeBathScheduleRows(roster, []));
      }
    },
    [facilityLinkKey, roster]
  );

  const shiftWeek = (delta) => {
    if (saveState === 'dirty') persistDraft({ silent: true });
    loadWeek(addDaysYmd(weekStartYmd, delta));
    setSaveState('saved');
    setSaveHint('');
  };

  useEffect(() => {
    if (!open) return;
    loadWeek(mondayOfWeek());
    setSaveState('saved');
    setSaveHint('');
  }, [open, loadWeek]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  const patchDay = (residentId, ymd, patch) => {
    const id = String(residentId ?? '').trim();
    setRows((prev) =>
      prev.map((r) => {
        if (r.residentId !== id) return r;
        const days = { ...r.days };
        days[ymd] = { ...(days[ymd] ?? { time: '', kind: '', note: '' }), ...patch };
        return { ...r, days };
      })
    );
    markDirty();
  };

  if (!open) return null;

  const weekLabel = `${weekYmds[0]?.slice(5).replace('-', '/')} ～ ${weekYmds[6]?.slice(5).replace('-', '/')}`;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[94vh] w-full max-w-[96rem] flex-col overflow-hidden rounded-2xl border-2 border-cyan-400 bg-white shadow-2xl">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-cyan-100 bg-cyan-50 px-3 py-3 sm:px-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black text-cyan-950 sm:text-lg">
              <Bath className="h-5 w-5 text-cyan-700" aria-hidden />
              入浴予定表（週間）
            </h2>
            <p className="text-xs font-bold text-cyan-900">
              {facilityLabel} ／ 保存するとカードの「本日の予定」にも入浴が表示されます
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-cyan-200 bg-white p-2">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 sm:px-4">
          <button
            type="button"
            onClick={() => shiftWeek(-7)}
            className="rounded-lg border-2 border-slate-300 bg-white p-2"
            title="前の週"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-black text-slate-800">{weekLabel}</span>
          <button
            type="button"
            onClick={() => shiftWeek(7)}
            className="rounded-lg border-2 border-slate-300 bg-white p-2"
            title="次の週"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => loadWeek(mondayOfWeek())}
            className="rounded-lg border-2 border-cyan-500 bg-cyan-50 px-2 py-1 text-xs font-black text-cyan-900"
          >
            今週
          </button>
          <button
            type="button"
            onClick={() => persistDraft()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-xl border-2 border-sky-700 bg-sky-600 px-4 py-2 text-sm font-black text-white"
          >
            {saveState === 'saving' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            保存
          </button>
          {saveHint ? (
            <span className={`text-xs font-black ${saveState === 'dirty' ? 'text-amber-800' : 'text-emerald-800'}`}>
              {saveHint}
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          <table className="w-full min-w-[900px] border-collapse text-xs sm:text-sm">
            <thead className="sticky top-0 z-10 bg-cyan-100">
              <tr>
                <th className="border border-cyan-300 px-1 py-1 text-left">氏名</th>
                <th className="border border-cyan-300 px-1 py-1">居室</th>
                {weekYmds.map((ymd) => (
                  <th key={ymd} className="border border-cyan-300 px-1 py-1 text-center min-w-[7rem]">
                    <div className="font-black">{weekdayLabelJa(ymd)}</div>
                    <div className="text-[10px] font-bold">{ymd.slice(5).replace('-', '/')}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.residentId} className="odd:bg-white even:bg-cyan-50/40">
                  <td className="border border-slate-300 px-1 py-1 font-black whitespace-nowrap text-slate-900">
                    {row.name}
                  </td>
                  <td className="border border-slate-300 px-1 py-1 text-center font-mono font-bold">
                    {row.room || '—'}
                  </td>
                  {weekYmds.map((ymd) => {
                    const day = row.days?.[ymd] ?? { time: '', kind: '', note: '' };
                    return (
                      <td key={ymd} className="border border-slate-300 p-1 align-top">
                        <input
                          type="time"
                          value={day.time || ''}
                          onChange={(e) => patchDay(row.residentId, ymd, { time: e.target.value })}
                          className={`${INPUT_CLASS} mb-0.5`}
                        />
                        <select
                          value={day.kind || ''}
                          onChange={(e) => patchDay(row.residentId, ymd, { kind: e.target.value })}
                          className={`${INPUT_CLASS} mb-0.5`}
                        >
                          {BATH_KIND_OPTIONS.map((k) => (
                            <option key={k || 'none'} value={k}>
                              {k || '—'}
                            </option>
                          ))}
                        </select>
                        <input
                          value={day.note || ''}
                          onChange={(e) => patchDay(row.residentId, ymd, { note: e.target.value })}
                          placeholder="メモ"
                          className={INPUT_CLASS}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-bold text-slate-600">
          種別「×」は入浴お休み。保存後、各利用者カードの本日予定に「入浴」として反映されます（クラウド同期ON時は他PCとも共有）。
        </div>
      </div>
    </div>
  );
}
