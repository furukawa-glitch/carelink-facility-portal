import React, { useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, Printer, X } from 'lucide-react';
import * as Report from '../services/ReportService.js';

/** ローカル日付 → YYYY-MM-DD */
function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 期間（開始〜終了）と利用者を指定して、ケアの生記録を
 * 印刷用HTML（PDF化可）／CSV（1行1記録）で出力するモーダル。
 *
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   residents: Array<Record<string, unknown>>;
 *   facilitySheetTitle: string;
 * }} props
 */
export function PeriodRecordExportModal({ open, onClose, residents, facilitySheetTitle }) {
  const roster = useMemo(() => (Array.isArray(residents) ? residents : []), [residents]);

  const [startYmd, setStartYmd] = useState(() => {
    const now = new Date();
    return localYmd(new Date(now.getFullYear(), now.getMonth(), 1));
  });
  const [endYmd, setEndYmd] = useState(() => localYmd(new Date()));
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
    if (open) setSelectedIds(new Set(roster.map((r) => String(r?.id ?? '')).filter(Boolean)));
  }, [open, roster]);

  if (!open) return null;

  const allSelected = roster.length > 0 && selectedIds.size === roster.length;
  const rangeInvalid = startYmd > endYmd;
  const chosen = roster.filter((r) => selectedIds.has(String(r?.id ?? '')));
  const canExport = !rangeInvalid && chosen.length > 0;

  const toggle = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setAll = (on) =>
    setSelectedIds(on ? new Set(roster.map((r) => String(r?.id ?? '')).filter(Boolean)) : new Set());

  const exportHtml = () => {
    if (!canExport) return;
    Report.downloadPeriodRecordHtml(facilitySheetTitle, startYmd, endYmd, chosen);
  };
  const exportCsv = () => {
    if (!canExport) return;
    Report.downloadPeriodRecordCsv(facilitySheetTitle, startYmd, endYmd, chosen);
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <h2 className="text-base font-black text-slate-800 sm:text-lg">期間記録の出力（監査用）</h2>
            <p className="text-[11px] font-bold text-slate-500 sm:text-xs">
              期間と利用者を指定して、記録をそのまま日別・時系列で出力します。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-bold text-slate-600">開始日</span>
              <input
                type="date"
                value={startYmd}
                max={endYmd}
                onChange={(e) => setStartYmd(e.target.value)}
                className="mt-1 w-full rounded-lg border-2 border-slate-300 px-2 py-2 text-sm font-bold text-slate-900 focus:border-teal-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600">終了日</span>
              <input
                type="date"
                value={endYmd}
                min={startYmd}
                onChange={(e) => setEndYmd(e.target.value)}
                className="mt-1 w-full rounded-lg border-2 border-slate-300 px-2 py-2 text-sm font-bold text-slate-900 focus:border-teal-500 focus:outline-none"
              />
            </label>
          </div>
          {rangeInvalid && (
            <p className="mt-1 text-xs font-bold text-rose-600">開始日は終了日より前にしてください。</p>
          )}

          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-600">対象の利用者（{chosen.length}/{roster.length}名）</span>
            <div className="flex gap-1 text-xs font-black">
              <button
                type="button"
                onClick={() => setAll(true)}
                className="rounded-md bg-slate-100 px-2 py-1 text-slate-700 hover:bg-slate-200"
              >
                全選択
              </button>
              <button
                type="button"
                onClick={() => setAll(false)}
                className="rounded-md bg-slate-100 px-2 py-1 text-slate-700 hover:bg-slate-200"
              >
                全解除
              </button>
            </div>
          </div>

          <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-200">
            {roster.length === 0 ? (
              <p className="px-3 py-4 text-sm font-bold text-slate-400">利用者がいません。</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {roster.map((r) => {
                  const id = String(r?.id ?? '');
                  const name = String(r?.name ?? r?.residentName ?? '').trim() || '（氏名未登録）';
                  const room = String(r?.room ?? '').trim();
                  return (
                    <li key={id}>
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(id)}
                          onChange={() => toggle(id)}
                          className="h-4 w-4 accent-teal-600"
                        />
                        <span className="text-sm font-bold text-slate-800">{name}</span>
                        {room && <span className="text-xs font-bold text-slate-400">居室 {room}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            ・<b>印刷／PDF</b>: 開いたHTMLの上部「印刷／PDF保存」ボタン（またはCtrl+P）でPDFに保存できます。<br />
            ・<b>CSV</b>: 1行に1記録（日付・時刻・利用者・種別・内容・記録者）。Excelで確認・集計できます。
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          {!allSelected && (
            <span className="mr-auto text-xs font-bold text-amber-600">一部の利用者のみ選択中</span>
          )}
          <button
            type="button"
            onClick={exportCsv}
            disabled={!canExport}
            className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-sm font-black text-white hover:bg-amber-500 disabled:opacity-40"
          >
            <FileSpreadsheet className="h-4 w-4" />
            CSV出力
          </button>
          <button
            type="button"
            onClick={exportHtml}
            disabled={!canExport}
            className="flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-sm font-black text-white hover:bg-teal-600 disabled:opacity-40"
          >
            <Printer className="h-4 w-4" />
            印刷／PDF用HTML
          </button>
        </div>
      </div>
    </div>
  );
}

export default PeriodRecordExportModal;
