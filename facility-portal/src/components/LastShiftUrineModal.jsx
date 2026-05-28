import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Droplets, Printer, X } from 'lucide-react';
import { filterResidentsForNamePicker } from '../services/GoogleSheetService.js';
import * as Report from '../services/ReportService.js';

function ymdHmDefaults() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return { recordDate: `${y}-${m}-${day}`, recordTime: `${hh}:${mm}` };
}

function emptyDraft(facilityLabel) {
  const { recordDate, recordTime } = ymdHmDefaults();
  return {
    facilityLabel: String(facilityLabel ?? '').trim(),
    recordDate,
    recordTime,
    shiftKind: '夜勤',
    residentName: '',
    room: '',
    urineMl: '',
    appearance: '',
    catheterNote: '',
    note: '',
    recorderName: '',
  };
}

const SHIFT_OPTIONS = ['日勤', '夜勤', '準夜', '明け', 'その他'];

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   facilityLabel: string;
 *   facilitySheetTitle: string;
 *   residents: Record<string, unknown>[];
 * }} props
 */
export function LastShiftUrineModal({ open, onClose, facilityLabel, facilitySheetTitle, residents }) {
  const [draft, setDraft] = useState(() => emptyDraft(facilityLabel));
  const [pickId, setPickId] = useState('');
  const [logExcretion, setLogExcretion] = useState(false);

  const pickerResidents = useMemo(() => filterResidentsForNamePicker(residents), [residents]);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft(facilityLabel));
    setPickId('');
    setLogExcretion(false);
  }, [open, facilityLabel]);

  useEffect(() => {
    if (!pickId) return;
    if (!pickerResidents.some((r) => String(r.id) === pickId)) setPickId('');
  }, [pickId, pickerResidents]);

  const applyResident = useCallback(
    (id) => {
      const r = residents.find((x) => String(x.id) === String(id));
      if (!r) return;
      const name = String(r.name ?? '')
        .replace(/様\s*$/u, '')
        .trim();
      setDraft((p) => ({
        ...p,
        residentName: name,
        room: String(r.room ?? '').trim(),
      }));
    },
    [residents]
  );

  const previewHtml = useMemo(() => Report.buildLastShiftUrineFormHtml(draft), [draft]);

  const doPrint = useCallback(() => {
    const html = Report.buildLastShiftUrineFormHtml(draft);
    if (logExcretion && pickId) {
      const r = residents.find((x) => String(x.id) === String(pickId));
      const u = String(draft.urineMl ?? '').trim();
      if (r && u) {
        const id = String(r.id);
        const name = String(r.name ?? '');
        const fac = String(facilitySheetTitle ?? '').trim();
        Report.logCareEvent({
          type: 'excretion',
          residentId: id,
          residentName: name,
          facilitySheetTitle: fac,
          meta: {
            urineVolume: u,
            note: `最終勤務尿（${String(draft.shiftKind ?? '').trim() || '勤務'}）`,
          },
        });
      }
    }
    Report.openPrintableSummary(html);
  }, [draft, logExcretion, pickId, residents, facilitySheetTitle]);

  const doDownload = useCallback(() => {
    const html = Report.buildLastShiftUrineFormHtml(draft);
    const safeName = String(draft.residentName ?? '利用者')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 40);
    Report.downloadSummaryHtml(`最終勤務尿_${safeName}_${draft.recordDate || '日付'}.html`, html);
  }, [draft]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[140] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="last-shift-urine-title"
        className="flex max-h-[min(92dvh,900px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-teal-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Droplets className="h-6 w-6 shrink-0 text-teal-700" aria-hidden />
            <h2 id="last-shift-urine-title" className="truncate text-lg font-black text-teal-950">
              最終勤務尿（作成・印刷）
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-500 hover:bg-white/80"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">事業所</span>
              <input
                value={draft.facilityLabel}
                onChange={(e) => setDraft((p) => ({ ...p, facilityLabel: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">記録日</span>
              <input
                type="date"
                value={draft.recordDate}
                onChange={(e) => setDraft((p) => ({ ...p, recordDate: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">記録時刻</span>
              <input
                type="time"
                value={draft.recordTime}
                onChange={(e) => setDraft((p) => ({ ...p, recordTime: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">勤務帯</span>
              <select
                value={draft.shiftKind}
                onChange={(e) => setDraft((p) => ({ ...p, shiftKind: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              >
                {SHIFT_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">利用者（名簿から）</span>
              <select
                value={pickId}
                onChange={(e) => {
                  const id = e.target.value;
                  setPickId(id);
                  if (id) applyResident(id);
                }}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              >
                <option value="">— 選択（任意）—</option>
                {pickerResidents.map((r) => (
                  <option key={String(r.id)} value={String(r.id)}>
                    {String(r.name ?? '')} {r.room != null && r.room !== '' ? `（${r.room}）` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">利用者氏名</span>
              <input
                value={draft.residentName}
                onChange={(e) => setDraft((p) => ({ ...p, residentName: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
                placeholder="手入力可"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">居室</span>
              <input
                value={draft.room}
                onChange={(e) => setDraft((p) => ({ ...p, room: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">排尿量</span>
              <input
                value={draft.urineMl}
                onChange={(e) => setDraft((p) => ({ ...p, urineMl: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
                placeholder="例: 200ml、目測 中 など"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">性状・色など</span>
              <textarea
                value={draft.appearance}
                onChange={(e) => setDraft((p) => ({ ...p, appearance: e.target.value }))}
                rows={2}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">カテーテル・バルーン等</span>
              <textarea
                value={draft.catheterNote}
                onChange={(e) => setDraft((p) => ({ ...p, catheterNote: e.target.value }))}
                rows={2}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">特記事項</span>
              <textarea
                value={draft.note}
                onChange={(e) => setDraft((p) => ({ ...p, note: e.target.value }))}
                rows={2}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">記録者</span>
              <input
                value={draft.recorderName}
                onChange={(e) => setDraft((p) => ({ ...p, recorderName: e.target.value }))}
                className="rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex cursor-pointer items-center gap-2 sm:col-span-2">
              <input
                type="checkbox"
                checked={logExcretion}
                onChange={(e) => setLogExcretion(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="text-xs font-bold text-slate-700">
                印刷時に、名簿から利用者を選び排尿量が入っている場合はクイック記録（排泄ログ）にも残す
              </span>
            </label>
          </div>

          <div className="border-t border-slate-100 px-4 pb-4">
            <p className="mb-2 text-[10px] font-bold text-slate-500">プレビュー</p>
            <iframe title="最終勤務尿プレビュー" className="h-64 w-full rounded-xl border border-slate-200 bg-white" srcDoc={previewHtml} />
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border-2 border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700"
          >
            閉じる
          </button>
          <button
            type="button"
            onClick={doDownload}
            className="flex items-center gap-2 rounded-xl border-2 border-teal-600 bg-white px-4 py-2 text-sm font-bold text-teal-800"
          >
            <Download className="h-4 w-4" />
            HTML保存
          </button>
          <button
            type="button"
            onClick={doPrint}
            className="flex items-center gap-2 rounded-xl bg-teal-700 px-4 py-2 text-sm font-bold text-white shadow-md"
          >
            <Printer className="h-4 w-4" />
            印刷
          </button>
        </footer>
      </div>
    </div>
  );
}
