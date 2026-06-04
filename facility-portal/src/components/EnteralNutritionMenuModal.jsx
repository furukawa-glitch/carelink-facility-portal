import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Loader2, Printer, RefreshCw, Utensils, X } from 'lucide-react';
import {
  ENTERAL_MEDICATION_OPTIONS,
  currentYmd,
  downloadEnteralMenuHtml,
  loadEnteralMenuDraft,
  mergeEnteralMenuRows,
  openEnteralMenuPrint,
  saveEnteralMenuDraft,
} from '../lib/enteralNutritionMenu.js';
import { importEnteralMenuFromSheet } from '../lib/enteralNutritionMenuSheetImport.js';

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   facilityLabel: string;
 *   facilityLinkKey?: string;
 *   sheetsApiKey?: string;
 *   residents: Record<string, unknown>[];
 * }} props
 */
export function EnteralNutritionMenuModal({
  open,
  onClose,
  facilityLabel,
  facilityLinkKey = '',
  sheetsApiKey = '',
  residents,
}) {
  const [updatedYmd, setUpdatedYmd] = useState(() => currentYmd());
  const [footerNote, setFooterNote] = useState('');
  const [legendNote, setLegendNote] = useState('ロング　ショート　ピンク：朝日勤　オレンジ：夕日勤');
  const [enteralOnly, setEnteralOnly] = useState(true);
  const [rows, setRows] = useState(/** @type {import('../lib/enteralNutritionMenu.js').EnteralMenuRow[]} */ ([]));
  const [sheetImporting, setSheetImporting] = useState(false);

  const roster = useMemo(() => (Array.isArray(residents) ? residents : []), [residents]);

  const initRows = useCallback(() => {
    const draft = loadEnteralMenuDraft(facilityLinkKey);
    setUpdatedYmd(String(draft.updatedYmd ?? currentYmd()).slice(0, 10));
    setFooterNote(String(draft.footerNote ?? ''));
    setLegendNote(String(draft.legendNote ?? ''));
    setRows(mergeEnteralMenuRows(roster, draft.rows, { enteralOnly, facilityLinkKey }));
  }, [facilityLinkKey, roster, enteralOnly]);

  const onImportFromSheet = async () => {
    const key = String(sheetsApiKey ?? '').trim();
    if (!key) {
      alert('VITE_GOOGLE_SHEETS_API_KEY を .env に設定し、開発サーバーを再起動してください。');
      return;
    }
    setSheetImporting(true);
    try {
      const result = await importEnteralMenuFromSheet(facilityLinkKey, key, roster);
      if (!result.ok) {
        alert(result.error ?? '読み込みに失敗しました');
        return;
      }
      initRows();
      const extra =
        result.unmatched > 0 ? `\n名簿と一致しなかった行: ${result.unmatched} 件` : '';
      alert(
        `経管メニュー表を取り込みました。\nシート ${result.sheetNames} 名 → 名簿一致 ${result.matched} 名${extra}\n一括入力の「経管メニュー」列にも反映されます。`
      );
    } finally {
      setSheetImporting(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    initRows();
  }, [open, initRows]);

  useEffect(() => {
    if (!open) return;
    saveEnteralMenuDraft(facilityLinkKey, { updatedYmd, footerNote, legendNote, rows });
  }, [open, facilityLinkKey, updatedYmd, footerNote, legendNote, rows]);

  const patchRow = (residentId, patch) => {
    const id = String(residentId ?? '').trim();
    setRows((prev) => prev.map((r) => (r.residentId === id ? { ...r, ...patch } : r)));
  };

  const patchSlot = (residentId, slotKey, patch) => {
    const id = String(residentId ?? '').trim();
    setRows((prev) =>
      prev.map((r) =>
        r.residentId === id ? { ...r, [slotKey]: { ...r[slotKey], ...patch } } : r
      )
    );
  };

  const draft = useMemo(
    () => ({ updatedYmd, footerNote, legendNote, rows }),
    [updatedYmd, footerNote, legendNote, rows]
  );

  const visibleRows = useMemo(() => rows.filter((r) => r.included !== false), [rows]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enteral-menu-title"
    >
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border-2 border-violet-300 bg-white shadow-2xl">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-violet-100 bg-violet-50 px-3 py-3 sm:px-4">
          <div>
            <h2 id="enteral-menu-title" className="flex items-center gap-2 text-base font-black text-violet-950 sm:text-lg">
              <Utensils className="h-5 w-5 text-violet-700" aria-hidden />
              経管栄養メニュー一覧
            </h2>
            <p className="mt-0.5 text-xs font-bold text-violet-900/80">
              {facilityLabel} ／ Googleの経管メニュー表から取込、または手入力 → 印刷・一括表へ反映
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

        <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-slate-100 bg-white px-3 py-2 sm:px-4">
          <label className="text-xs font-bold text-slate-700">
            更新日
            <input
              type="date"
              value={updatedYmd}
              onChange={(e) => setUpdatedYmd(e.target.value || currentYmd())}
              className="mt-0.5 block rounded-lg border-2 border-violet-200 px-2 py-1.5 text-sm font-bold"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
            <input
              type="checkbox"
              checked={enteralOnly}
              onChange={(e) => {
                setEnteralOnly(e.target.checked);
                setTimeout(() => initRows(), 0);
              }}
              className="h-4 w-4 accent-violet-700"
            />
            名簿の経管対象のみ
          </label>
          <button
            type="button"
            disabled={sheetImporting}
            onClick={() => void onImportFromSheet()}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-emerald-600 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-950 hover:bg-emerald-100 disabled:opacity-60"
          >
            {sheetImporting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
            )}
            経管メニュー表を更新
          </button>
          <button
            type="button"
            onClick={initRows}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-violet-500 bg-violet-50 px-3 py-2 text-xs font-black text-violet-900 hover:bg-violet-100"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            名簿と再同期
          </button>
          <button
            type="button"
            onClick={() => openEnteralMenuPrint(facilityLabel, draft)}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-violet-700 bg-violet-700 px-3 py-2 text-xs font-black text-white hover:bg-violet-600"
          >
            <Printer className="h-4 w-4" aria-hidden />
            印刷（用紙）
          </button>
          <button
            type="button"
            onClick={() => downloadEnteralMenuHtml(facilityLabel, draft)}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-800 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" aria-hidden />
            HTML保存
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2 sm:px-3">
          <table className="w-full min-w-[720px] border-collapse text-xs sm:text-sm">
            <thead className="sticky top-0 z-10 bg-violet-100">
              <tr>
                <th className="border border-violet-200 px-1 py-1.5 text-left">氏名</th>
                <th className="border border-violet-200 px-1 py-1.5 text-left">居室</th>
                <th className="border border-violet-200 bg-amber-50 px-1 py-1.5">朝</th>
                <th className="border border-violet-200 bg-amber-50 px-1 py-1.5 w-12">薬</th>
                <th className="border border-violet-200 bg-orange-50 px-1 py-1.5">昼</th>
                <th className="border border-violet-200 bg-orange-50 px-1 py-1.5 w-12">薬</th>
                <th className="border border-violet-200 bg-indigo-50 px-1 py-1.5">夕</th>
                <th className="border border-violet-200 bg-indigo-50 px-1 py-1.5 w-12">薬</th>
                <th className="border border-violet-200 px-1 py-1.5 text-left">個別メモ</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="border border-slate-200 px-3 py-8 text-center font-bold text-slate-500">
                    経管対象の利用者がいません。名簿の「経管栄養」列を確認するか、上のチェックを外して全員表示してください。
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <tr key={row.residentId} className="odd:bg-white even:bg-violet-50/30">
                    <td className="border border-slate-200 px-1 py-1 font-bold whitespace-nowrap text-slate-900">
                      {row.name}
                    </td>
                    <td className="border border-slate-200 px-1 py-1 font-mono text-center">{row.room || '—'}</td>
                    {(['morning', 'noon', 'evening']).map((slotKey) => (
                      <React.Fragment key={slotKey}>
                        <td className="border border-slate-200 p-0">
                          <input
                            value={row[slotKey].content}
                            onChange={(e) => patchSlot(row.residentId, slotKey, { content: e.target.value })}
                            placeholder="例: 7:55ラコール400ml 白湯100"
                            className="w-full min-w-[8rem] bg-transparent px-1 py-1.5 text-xs font-bold sm:text-sm"
                          />
                        </td>
                        <td className="border border-slate-200 p-0">
                          <select
                            value={row[slotKey].medication}
                            onChange={(e) => patchSlot(row.residentId, slotKey, { medication: e.target.value })}
                            className="w-full bg-white px-0.5 py-1.5 text-center text-xs font-black sm:text-sm"
                          >
                            {ENTERAL_MEDICATION_OPTIONS.map((opt) => (
                              <option key={opt || 'empty'} value={opt}>
                                {opt || '—'}
                              </option>
                            ))}
                          </select>
                        </td>
                      </React.Fragment>
                    ))}
                    <td className="border border-slate-200 p-0">
                      <input
                        value={row.note}
                        onChange={(e) => patchRow(row.residentId, { note: e.target.value })}
                        placeholder="例: 水曜VDS時…"
                        className="w-full min-w-[6rem] bg-transparent px-1 py-1.5 text-xs font-bold"
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="shrink-0 space-y-2 border-t border-slate-100 bg-slate-50 px-3 py-3 sm:px-4">
          <label className="block text-xs font-bold text-slate-700">
            凡例（用紙下部）
            <input
              value={legendNote}
              onChange={(e) => setLegendNote(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-bold"
            />
          </label>
          <label className="block text-xs font-bold text-slate-700">
            施設共通メモ（※で始まる注意書きなど）
            <textarea
              value={footerNote}
              onChange={(e) => setFooterNote(e.target.value)}
              rows={2}
              placeholder="例: ※竹村綾美様：水曜・日曜日VDS時麻子仁丸1.5包"
              className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-bold leading-relaxed"
            />
          </label>
          <p className="text-[10px] font-bold text-slate-500">
            取込・入力は施設ごとに保存され、クラウド同期ON時は他PCとも共有されます（{visibleRows.length} 名表示中）。
          </p>
        </div>
      </div>
    </div>
  );
}
