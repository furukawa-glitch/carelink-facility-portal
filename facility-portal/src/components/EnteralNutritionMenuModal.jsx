import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, FileSpreadsheet, Loader2, Plus, Printer, RefreshCw, Save, Trash2, Utensils, X } from 'lucide-react';
import {
  DEFAULT_ENTERAL_COLOR_LEGEND,
  ENTERAL_MEDICATION_OPTIONS,
  currentYmd,
  downloadEnteralMenuHtml,
  enteralSlotBackgroundColor,
  formatEnteralColorLegendNote,
  loadEnteralMenuDraft,
  mergeEnteralMenuRows,
  filterEnteralMenuPrintRows,
  newEnteralColorId,
  normalizeEnteralColorLegend,
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
  const [legendNote, setLegendNote] = useState('');
  const [colorLegend, setColorLegend] = useState(() => [...DEFAULT_ENTERAL_COLOR_LEGEND]);
  const [enteralOnly, setEnteralOnly] = useState(false);
  const [rows, setRows] = useState(/** @type {import('../lib/enteralNutritionMenu.js').EnteralMenuRow[]} */ ([]));
  const [sheetImporting, setSheetImporting] = useState(false);
  const [saveState, setSaveState] = useState(/** @type {'saved' | 'dirty' | 'saving'} */ ('saved'));
  const [saveHint, setSaveHint] = useState('');
  const saveTimerRef = useRef(0);

  const roster = useMemo(() => (Array.isArray(residents) ? residents : []), [residents]);

  const draft = useMemo(
    () => ({ updatedYmd, footerNote, legendNote, colorLegend, rows }),
    [updatedYmd, footerNote, legendNote, colorLegend, rows]
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
    const legend = normalizeEnteralColorLegend(loaded.colorLegend);
    setColorLegend(legend);
    setLegendNote(String(loaded.legendNote ?? formatEnteralColorLegendNote(legend)));
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

  const printRowCount = useMemo(() => filterEnteralMenuPrintRows(rows).length, [rows]);
  const visibleRows = useMemo(
    () => (enteralOnly ? rows.filter((r) => r.enteralTarget) : rows.filter((r) => r.included !== false)),
    [rows, enteralOnly]
  );

  const patchColorLegendItem = (id, patch) => {
    setColorLegend((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c))
    );
    markDirty();
  };

  const addColorLegendItem = () => {
    setColorLegend((prev) => [
      ...prev,
      { id: newEnteralColorId(), label: '担当', color: '#e2e8f0' },
    ]);
    markDirty();
  };

  const removeColorLegendItem = (id) => {
    setColorLegend((prev) => (prev.length <= 1 ? prev : prev.filter((c) => c.id !== id)));
    setRows((prev) =>
      prev.map((row) => {
        const patchSlotColor = (slot) =>
          slot?.colorId === id ? { ...slot, colorId: '' } : slot;
        return {
          ...row,
          morning: patchSlotColor(row.morning),
          noon: patchSlotColor(row.noon),
          evening: patchSlotColor(row.evening),
        };
      })
    );
    markDirty();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enteral-menu-title"
    >
      <div className="flex h-[min(96dvh,100vh)] max-h-[96dvh] w-full max-w-[96rem] flex-col overflow-hidden rounded-2xl border-2 border-violet-300 bg-white shadow-2xl">
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

        {/* ズーム時でも入力欄に届くよう、ヘッダー以外は1つの縦スクロール領域にまとめる */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
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
            onClick={() =>
              document.getElementById('enteral-menu-table-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-violet-600 bg-violet-600 px-3 py-2 text-xs font-black text-white hover:bg-violet-500"
          >
            ↓ 入力表へ
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
            title={`経管対象 ${printRowCount} 名のみ印刷（名簿の経管列・メニュー入力あり）`}
          >
            <Printer className="h-4 w-4" aria-hidden />
            印刷（対象{printRowCount}名）
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

        <div className="shrink-0 border-b border-violet-100 bg-violet-50/80 px-3 py-2 sm:px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-black text-violet-950">
              担当の色分け（誰が経管するか）— 色と名前を施設で指定
            </p>
            <button
              type="button"
              onClick={addColorLegendItem}
              className="inline-flex items-center gap-1 rounded-lg border-2 border-violet-500 bg-white px-2 py-1 text-[11px] font-black text-violet-900 hover:bg-violet-100"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              色を追加
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {colorLegend.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-1 rounded-lg border-2 border-slate-300 bg-white px-1.5 py-1 shadow-sm"
              >
                <input
                  type="color"
                  value={c.color}
                  onChange={(e) => patchColorLegendItem(c.id, { color: e.target.value })}
                  className="h-8 w-10 cursor-pointer rounded border border-slate-200"
                  title="セルの色"
                />
                <input
                  value={c.label}
                  onChange={(e) => patchColorLegendItem(c.id, { label: e.target.value })}
                  className="w-24 rounded border border-slate-200 px-1 py-0.5 text-xs font-black text-slate-900"
                  placeholder="例: ロング"
                />
                <button
                  type="button"
                  onClick={() => removeColorLegendItem(c.id)}
                  className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-700"
                  title="この色を削除"
                  disabled={colorLegend.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] font-bold text-slate-600">
            各枠の「担当」で色を選ぶと、用紙と同じ背景色になります（青＝ロング、黄＝ショート等は上で変更可）
          </p>
        </div>

        <div className="overflow-x-auto px-2 py-2 sm:px-3" id="enteral-menu-table-anchor">
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
                      担当
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
                      const slotBg = enteralSlotBackgroundColor(colorLegend, slot.colorId);
                      return (
                        <React.Fragment key={`${row.residentId}-${slotKey}`}>
                          <td className="border border-slate-300 p-0" style={{ backgroundColor: slotBg }}>
                            <input
                              type="time"
                              value={slot.time || ''}
                              onChange={(e) => patchSlot(row.residentId, slotKey, { time: e.target.value })}
                              className={`${INPUT_CLASS} min-w-[5.5rem] border-0 bg-transparent`}
                              title="実施時刻"
                            />
                          </td>
                          <td className="border border-slate-300 p-0" style={{ backgroundColor: slotBg }}>
                            <input
                              value={slot.content}
                              onChange={(e) => patchSlot(row.residentId, slotKey, { content: e.target.value })}
                              onBlur={(e) => onSlotContentBlur(row.residentId, slotKey, e.target.value)}
                              placeholder="ラコール400ml 白湯100ml"
                              className={`${INPUT_CLASS} min-w-[9rem] border-0`}
                            />
                          </td>
                          <td className="border border-slate-300 p-0" style={{ backgroundColor: slotBg }}>
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
                          <td className="border border-slate-300 p-0" style={{ backgroundColor: slotBg }}>
                            <select
                              value={slot.colorId || ''}
                              onChange={(e) => patchSlot(row.residentId, slotKey, { colorId: e.target.value })}
                              className={`${INPUT_CLASS} min-w-[5rem] border-0 font-black`}
                              title="この枠を担当する人・勤務（色）"
                            >
                              <option value="">—</option>
                              {colorLegend.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label}
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
            凡例の補足文（用紙下部・任意）
            <input
              value={legendNote}
              onChange={(e) => {
                setLegendNote(e.target.value);
                markDirty();
              }}
              placeholder={formatEnteralColorLegendNote(colorLegend)}
              className="mt-0.5 w-full rounded-lg border-2 border-slate-300 bg-white px-2 py-1.5 text-sm font-bold text-slate-900 placeholder:text-slate-500"
            />
          </label>
          <p className="text-[10px] font-bold text-slate-600">
            印刷時の色凡例:{' '}
            {colorLegend.map((c) => (
              <span
                key={c.id}
                className="mr-2 inline-block rounded border border-slate-400 px-1.5 py-0.5"
                style={{ backgroundColor: c.color }}
              >
                {c.label}
              </span>
            ))}
          </p>
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
    </div>
  );
}
