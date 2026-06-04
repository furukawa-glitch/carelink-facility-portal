import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, FileSpreadsheet, Loader2, Printer, RefreshCw, Save, Utensils, X } from 'lucide-react';
import {
  ENTERAL_MEDICATION_OPTIONS,
  ENTERAL_SHIFT_OPTIONS,
  currentYmd,
  downloadEnteralMenuHtml,
  enteralShiftCellClass,
  loadEnteralMenuDraft,
  mergeEnteralMenuRows,
  openEnteralMenuPrint,
  parseEnteralTimeFromText,
  saveEnteralMenuDraft,
} from '../lib/enteralNutritionMenu.js';
import { importEnteralMenuFromSheet } from '../lib/enteralNutritionMenuSheetImport.js';

const INPUT_CLASS =
  'w-full rounded border-2 border-slate-300 bg-white px-1.5 py-1.5 text-sm font-bold text-slate-900 placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-400';

const MEAL_SLOTS = [
  { key: 'morning', label: '朝', headerBg: 'bg-pink-100' },
  { key: 'noon', label: '昼', headerBg: 'bg-orange-100' },
  { key: 'evening', label: '夕', headerBg: 'bg-indigo-100' },
];

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   facilityLabel: string;
 *   facilityLinkKey?: string;
 *   sheetsApiKey?: string;
 *   onImported?: () => void;
 *   residents: Record<string, unknown>[];
 * }} props
 */
export function EnteralNutritionMenuModal({
  open,
  onClose,
  facilityLabel,
  facilityLinkKey = '',
  sheetsApiKey = '',
  onImported,
  residents,
}) {
  const [updatedYmd, setUpdatedYmd] = useState(() => currentYmd());
  const [footerNote, setFooterNote] = useState('');
  const [legendNote, setLegendNote] = useState('ロング　ショート　ピンク：日勤　オレンジ：夜勤　黄：ショート');
  const [enteralOnly, setEnteralOnly] = useState(false);
  const [rows, setRows] = useState(/** @type {import('../lib/enteralNutritionMenu.js').EnteralMenuRow[]} */ ([]));
  const [sheetImporting, setSheetImporting] = useState(false);
  const [saveState, setSaveState] = useState(/** @type {'saved' | 'dirty' | 'saving'} */ ('saved'));
  const [saveHint, setSaveHint] = useState('');
  const saveTimerRef = useRef(0);

  const roster = useMemo(() => (Array.isArray(residents) ? residents : []), [residents]);

  const draft = useMemo(
    () => ({ updatedYmd, footerNote, legendNote, rows }),
    [updatedYmd, footerNote, legendNote, rows]
  );

  const persistDraft = useCallback(
    (opts = {}) => {
      const silent = opts.silent === true;
      if (!silent) setSaveState('saving');
      saveEnteralMenuDraft(facilityLinkKey, draft);
      if (!silent) {
        setSaveState('saved');
        setSaveHint(`保存しました ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`);
      } else {
        setSaveState('saved');
      }
      onImported?.();
    },
    [draft, facilityLinkKey, onImported]
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

  const initRows = useCallback(() => {
    const loaded = loadEnteralMenuDraft(facilityLinkKey);
    setUpdatedYmd(String(loaded.updatedYmd ?? currentYmd()).slice(0, 10));
    setFooterNote(String(loaded.footerNote ?? ''));
    setLegendNote(String(loaded.legendNote ?? ''));
    setRows(mergeEnteralMenuRows(roster, loaded.rows, { enteralOnly, facilityLinkKey }));
    setSaveState('saved');
    setSaveHint('');
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
      persistDraft();
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
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  const patchRow = (residentId, patch) => {
    const id = String(residentId ?? '').trim();
    setRows((prev) => prev.map((r) => (r.residentId === id ? { ...r, ...patch } : r)));
    markDirty();
  };

  const patchSlot = (residentId, slotKey, patch) => {
    const id = String(residentId ?? '').trim();
    setRows((prev) =>
      prev.map((r) =>
        r.residentId === id ? { ...r, [slotKey]: { ...r[slotKey], ...patch } } : r
      )
    );
    markDirty();
  };

  const onSlotContentBlur = (residentId, slotKey, raw) => {
    const { time, rest } = parseEnteralTimeFromText(raw);
    if (!time) return;
    patchSlot(residentId, slotKey, { content: rest, time });
  };

  const visibleRows = useMemo(() => rows.filter((r) => r.included !== false), [rows]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enteral-menu-title"
    >
      <div className="flex max-h-[94vh] w-full max-w-[96rem] flex-col overflow-hidden rounded-2xl border-2 border-violet-300 bg-white shadow-2xl">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-violet-100 bg-violet-50 px-3 py-3 sm:px-4">
          <div>
            <h2 id="enteral-menu-title" className="flex items-center gap-2 text-base font-black text-violet-950 sm:text-lg">
              <Utensils className="h-5 w-5 text-violet-700" aria-hidden />
              経管栄養メニュー一覧
            </h2>
            <p className="mt-0.5 text-xs font-bold text-violet-950">
              {facilityLabel} ／ 取込・手入力 → <strong>保存</strong> で一括表・他PCへ反映
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
          <label className="text-xs font-black text-slate-800">
            更新日
            <input
              type="date"
              value={updatedYmd}
              onChange={(e) => {
                setUpdatedYmd(e.target.value || currentYmd());
                markDirty();
              }}
              className="mt-0.5 block rounded-lg border-2 border-violet-300 px-2 py-1.5 text-sm font-bold text-slate-900"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs font-black text-slate-800">
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
            onClick={() => persistDraft()}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-sky-700 bg-sky-600 px-4 py-2 text-sm font-black text-white shadow hover:bg-sky-500"
          >
            {saveState === 'saving' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : saveState === 'saved' ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            保存
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
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-400 bg-white px-3 py-2 text-xs font-black text-slate-900 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" aria-hidden />
            HTML保存
          </button>
          {saveHint ? (
            <span
              className={`text-xs font-black ${saveState === 'dirty' ? 'text-amber-800' : 'text-emerald-800'}`}
            >
              {saveHint}
            </span>
          ) : null}
        </div>

        <div className="shrink-0 flex flex-wrap gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] font-black text-slate-800 sm:px-4">
          <span>勤務の色:</span>
          <span className="rounded border border-pink-300 bg-pink-100 px-2 py-0.5">ピンク＝日勤</span>
          <span className="rounded border border-indigo-400 bg-indigo-200 px-2 py-0.5">青紫＝夜勤</span>
          <span className="rounded border border-amber-400 bg-amber-100 px-2 py-0.5">黄＝ショート</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2 sm:px-3">
          <table className="w-full min-w-[960px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-violet-200 text-slate-900">
              <tr>
                <th rowSpan={2} className="border border-violet-300 px-1 py-1 text-left">
                  氏名
                </th>
                <th rowSpan={2} className="border border-violet-300 px-1 py-1 text-left">
                  居室
                </th>
                {MEAL_SLOTS.map((slot) => (
                  <th
                    key={slot.key}
                    colSpan={4}
                    className={`border border-violet-300 px-1 py-1 ${slot.headerBg}`}
                  >
                    {slot.label}
                  </th>
                ))}
                <th rowSpan={2} className="border border-violet-300 px-1 py-1 text-left">
                  個別メモ
                </th>
              </tr>
              <tr>
                {MEAL_SLOTS.map((slot) => (
                  <React.Fragment key={`${slot.key}-sub`}>
                    <th className={`border border-violet-300 px-1 py-0.5 text-[10px] ${slot.headerBg}`}>
                      時刻
                    </th>
                    <th className={`border border-violet-300 px-1 py-0.5 text-[10px] ${slot.headerBg}`}>
                      内容
                    </th>
                    <th className={`border border-violet-300 px-1 py-0.5 text-[10px] ${slot.headerBg}`}>
                      薬
                    </th>
                    <th className={`border border-violet-300 px-1 py-0.5 text-[10px] ${slot.headerBg}`}>
                      勤務
                    </th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={14} className="border border-slate-300 px-3 py-8 text-center font-bold text-slate-700">
                    経管対象の利用者がいません。名簿の「経管栄養」列を確認するか、上のチェックを外して全員表示してください。
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <tr key={row.residentId} className="odd:bg-white even:bg-violet-50/40">
                    <td className="border border-slate-300 px-1 py-1 font-black whitespace-nowrap text-slate-900">
                      {row.name}
                    </td>
                    <td className="border border-slate-300 px-1 py-1 text-center font-mono font-bold text-slate-900">
                      {row.room || '—'}
                    </td>
                    {MEAL_SLOTS.map((meal) => {
                      const slotKey = meal.key;
                      const slot = row[slotKey];
                      const shiftClass = enteralShiftCellClass(slot.shift);
                      return (
                        <React.Fragment key={`${row.residentId}-${slotKey}`}>
                          <td className={`border border-slate-300 p-0 ${shiftClass}`}>
                            <input
                              type="time"
                              value={slot.time || ''}
                              onChange={(e) => patchSlot(row.residentId, slotKey, { time: e.target.value })}
                              className={`${INPUT_CLASS} min-w-[5.5rem] border-0 bg-transparent`}
                              title="実施時刻"
                            />
                          </td>
                          <td className={`border border-slate-300 p-0 ${shiftClass}`}>
                            <input
                              value={slot.content}
                              onChange={(e) => patchSlot(row.residentId, slotKey, { content: e.target.value })}
                              onBlur={(e) => onSlotContentBlur(row.residentId, slotKey, e.target.value)}
                              placeholder="ラコール400ml 白湯100ml"
                              className={`${INPUT_CLASS} min-w-[9rem] border-0`}
                            />
                          </td>
                          <td className={`border border-slate-300 p-0 ${shiftClass}`}>
                            <select
                              value={slot.medication}
                              onChange={(e) =>
                                patchSlot(row.residentId, slotKey, { medication: e.target.value })
                              }
                              className={`${INPUT_CLASS} border-0 text-center`}
                            >
                              {ENTERAL_MEDICATION_OPTIONS.map((opt) => (
                                <option key={opt || 'empty'} value={opt}>
                                  {opt || '—'}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className={`border border-slate-300 p-0 ${shiftClass}`}>
                            <select
                              value={slot.shift || ''}
                              onChange={(e) => patchSlot(row.residentId, slotKey, { shift: e.target.value })}
                              className={`${INPUT_CLASS} min-w-[4.5rem] border-0 font-black`}
                              title="日勤・夜勤・ショート"
                            >
                              {ENTERAL_SHIFT_OPTIONS.map((opt) => (
                                <option key={opt.value || 'none'} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </React.Fragment>
                      );
                    })}
                    <td className="border border-slate-300 p-0">
                      <input
                        value={row.note}
                        onChange={(e) => patchRow(row.residentId, { note: e.target.value })}
                        placeholder="例: 水曜VDS時…"
                        className={`${INPUT_CLASS} min-w-[7rem]`}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="shrink-0 space-y-2 border-t border-slate-200 bg-slate-50 px-3 py-3 sm:px-4">
          <label className="block text-xs font-black text-slate-800">
            凡例（用紙下部）
            <input
              value={legendNote}
              onChange={(e) => {
                setLegendNote(e.target.value);
                markDirty();
              }}
              className="mt-0.5 w-full rounded-lg border-2 border-slate-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
            />
          </label>
          <label className="block text-xs font-black text-slate-800">
            施設共通メモ（※で始まる注意書きなど）
            <textarea
              value={footerNote}
              onChange={(e) => {
                setFooterNote(e.target.value);
                markDirty();
              }}
              rows={2}
              placeholder="例: ※竹村綾美様：水曜・日曜日VDS時麻子仁丸1.5包"
              className="mt-0.5 w-full rounded-lg border-2 border-slate-300 bg-white px-2 py-1.5 text-sm font-bold leading-relaxed text-slate-900 placeholder:text-slate-500"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-700">
              {visibleRows.length} 名表示中。クラウド同期ON時は保存後に他PCへ共有されます。
            </p>
            <button
              type="button"
              onClick={() => persistDraft()}
              className="inline-flex items-center gap-1.5 rounded-xl border-2 border-sky-700 bg-sky-600 px-4 py-2 text-sm font-black text-white hover:bg-sky-500"
            >
              <Save className="h-4 w-4" aria-hidden />
              保存して閉じる前に確認
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
