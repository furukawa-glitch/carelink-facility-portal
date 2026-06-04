import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Plus, Trash2, X } from 'lucide-react';
import {
  addResidentDailyPlan,
  currentYmd,
  getResidentDailyPlans,
  removeResidentDailyPlan,
} from '../lib/residentDailySchedule.js';

const PLAN_TYPES = ['その他', 'デイ', '入浴', '受診', '外出', 'リハ', '面会', '食事'];

function addDaysYmd(ymd, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return currentYmd();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const [viewYmd, setViewYmd] = useState(currentYmd());
  const [draftTime, setDraftTime] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftType, setDraftType] = useState('その他');
  const [rev, setRev] = useState(0);

  const todayYmd = currentYmd();

  const reload = useCallback(() => setRev((n) => n + 1), []);

  const plans = useMemo(() => {
    void rev;
    return getResidentDailyPlans(facilityLinkKey, residentId, viewYmd, String(resident?.name ?? ''));
  }, [facilityLinkKey, residentId, viewYmd, resident?.name, rev]);

  useEffect(() => {
    if (!open) return;
    setViewYmd(currentYmd());
    setDraftTime('');
    setDraftTitle('');
    setDraftType('その他');
    reload();
  }, [open, residentId, reload]);

  if (!open || !residentId) return null;

  const nm = residentNameFmt(resident?.name);

  const handleAdd = () => {
    const title = String(draftTitle ?? '').trim();
    if (!title) return;
    addResidentDailyPlan(facilityLinkKey, residentId, viewYmd, {
      time: String(draftTime ?? '').trim(),
      title,
      type: draftType,
    });
    setDraftTitle('');
    setDraftTime('');
    reload();
    onSaved?.();
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-end justify-center bg-black/55 p-2 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border-2 border-violet-400 bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-violet-100 bg-violet-50 px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black text-violet-950 sm:text-lg">
              <CalendarClock className="h-5 w-5 text-violet-700" aria-hidden />
              利用者の予定
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
          <label className="text-xs font-bold text-slate-700">
            表示する日
            <input
              type="date"
              value={viewYmd}
              min={todayYmd}
              onChange={(e) => setViewYmd(e.target.value || todayYmd)}
              className="mt-0.5 block w-full rounded-lg border-2 border-violet-200 px-2 py-1.5 font-mono text-sm font-bold"
            />
          </label>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[
              { label: '今日', ymd: todayYmd },
              { label: '明日', ymd: addDaysYmd(todayYmd, 1) },
              { label: '+3日', ymd: addDaysYmd(todayYmd, 3) },
            ].map(({ label, ymd }) => (
              <button
                key={label}
                type="button"
                onClick={() => setViewYmd(ymd)}
                className={`rounded-lg border px-2 py-0.5 text-xs font-black ${
                  viewYmd === ymd
                    ? 'border-violet-600 bg-violet-600 text-white'
                    : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {plans.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm font-bold text-slate-500">
              この日の予定はまだありません。下の欄から追加するか、施設の「お予定表を更新」でスプレッドシートから取り込んでください。
            </p>
          ) : (
            <ul className="space-y-2">
              {plans.map((p) => (
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
                      {p.type}
                      {p.source === 'facility_sheet' ? ' ・表から取込' : ' ・アプリ入力'}
                    </p>
                  </div>
                  {p.source === 'app' ? (
                    <button
                      type="button"
                      onClick={() => {
                        removeResidentDailyPlan(facilityLinkKey, residentId, viewYmd, p.id);
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
        </div>

        <div className="shrink-0 border-t border-slate-100 bg-slate-50 px-4 py-3">
          <p className="mb-2 text-xs font-black text-slate-700">予定を追加（アプリ入力・今後の日付も可）</p>
          <div className="grid grid-cols-[4.5rem_1fr] gap-2">
            <input
              type="time"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-2 text-sm font-mono font-bold"
              placeholder="時刻"
            />
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="例: デイ送迎 9:00、入浴、受診"
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
              onClick={handleAdd}
              className="inline-flex items-center gap-1 rounded-xl border-2 border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-black text-white hover:bg-violet-500"
            >
              <Plus className="h-4 w-4" aria-hidden />
              追加
            </button>
          </div>
          <p className="mt-2 text-[10px] font-bold leading-snug text-slate-500">
            スプレッドシートから取り込んだ予定は削除できません（表を直して「お予定表を更新」）。アプリで追加した予定だけゴミ箱で削除できます。
          </p>
        </div>
      </div>
    </div>
  );
}
