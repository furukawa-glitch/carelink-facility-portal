import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, Loader2, Printer, Sparkles, X } from 'lucide-react';
import { getAccidentDeptOptions } from '../config/accidentDeptConfig.js';
import * as Report from '../services/ReportService.js';

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function countRows(map, order) {
  const seen = new Set();
  const rows = [];
  for (const k of order) {
    const n = map[k];
    if (n > 0) {
      rows.push({ key: k, count: n });
      seen.add(k);
    }
  }
  for (const [k, n] of Object.entries(map)) {
    if (!seen.has(k) && n > 0) rows.push({ key: k, count: n });
  }
  return rows;
}

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   geminiKey: string;
 *   defaultTabLabel: string;
 *   facilityDefs: { tabLabel: string; sheetTitle: string }[];
 * }} props
 */
export function AccidentMonthlyAnalysisModal({ open, onClose, geminiKey, defaultTabLabel, facilityDefs }) {
  const [yearMonth, setYearMonth] = useState(currentYearMonth);
  const [facilityFilter, setFacilityFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [assessment, setAssessment] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setYearMonth(currentYearMonth());
    setFacilityFilter(String(defaultTabLabel ?? '').trim());
    setDepartmentFilter('');
    setAssessment('');
  }, [open, defaultTabLabel]);

  const deptOptions = useMemo(
    () => (facilityFilter ? getAccidentDeptOptions(facilityFilter) : []),
    [facilityFilter]
  );

  const agg = useMemo(
    () =>
      Report.aggregateAccidentMonthlySummary(yearMonth, {
        facilityLabel: facilityFilter,
        department: departmentFilter,
      }),
    [yearMonth, facilityFilter, departmentFilter]
  );

  const typeRows = useMemo(() => countRows(agg.byType, Report.ACCIDENT_TYPE_ORDER), [agg.byType]);
  const slotRows = useMemo(() => countRows(agg.bySlot, Report.ACCIDENT_SLOT_ORDER), [agg.bySlot]);

  const runAssessment = useCallback(async () => {
    setAiBusy(true);
    try {
      const text = await Report.fetchAccidentMonthlyAssessmentAi(geminiKey, agg);
      setAssessment(text);
    } catch (e) {
      setAssessment(`（生成エラー）${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAiBusy(false);
    }
  }, [geminiKey, agg]);

  const printHtml = useCallback(() => {
    const html = Report.buildAccidentMonthlyAnalysisHtml(agg, assessment);
    Report.openPrintableSummary(html);
  }, [agg, assessment]);

  const downloadCsv = useCallback(() => {
    const csv = Report.buildAccidentMonthlyCsv(agg);
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `事故月次_${yearMonth}_${facilityFilter || '全施設'}_${departmentFilter || '全部署'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [agg, yearMonth, facilityFilter, departmentFilter]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-3xl border-4 border-indigo-900/40 bg-white p-5 shadow-2xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xl font-black text-slate-800">
            <BarChart3 className="h-7 w-7 text-indigo-600" />
            事故報告 月次分析
          </h3>
          <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="閉じる">
            <X className="h-6 w-6" />
          </button>
        </div>

        <p className="mb-4 text-sm text-slate-600">
          「事故報告書」画面の<strong>月次分析用に保存</strong>した記録を、施設・部署・月で絞り込み、種類別・時間帯別に集計します。データはこのブラウザの localStorage に保存されます。
        </p>

        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-600">対象月</span>
            <input
              type="month"
              value={yearMonth}
              onChange={(e) => setYearMonth(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-600">施設</span>
            <select
              value={facilityFilter}
              onChange={(e) => {
                setFacilityFilter(e.target.value);
                setDepartmentFilter('');
              }}
              className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
            >
              <option value="">全施設</option>
              {facilityDefs.map((f) => (
                <option key={f.sheetTitle} value={f.tabLabel}>
                  {f.tabLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2 lg:col-span-2">
            <span className="text-xs font-bold text-slate-600">部署（施設を選ぶと候補表示）</span>
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
            >
              <option value="">全部署</option>
              {deptOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mb-2 text-sm font-bold text-slate-700">
          該当件数: <span className="text-indigo-600">{agg.total}</span> 件
        </div>

        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border-2 border-slate-200 p-3">
            <h4 className="mb-2 text-sm font-black text-slate-800">事故の種類別</h4>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-1 pr-2">種類</th>
                  <th className="py-1 text-right">件数</th>
                </tr>
              </thead>
              <tbody>
                {typeRows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="py-3 text-slate-500">
                      該当なし
                    </td>
                  </tr>
                ) : (
                  typeRows.map((r) => (
                    <tr key={r.key} className="border-b border-slate-100">
                      <td className="py-1.5 font-bold text-slate-800">{r.key}</td>
                      <td className="py-1.5 text-right tabular-nums font-bold text-indigo-700">{r.count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="rounded-2xl border-2 border-slate-200 p-3">
            <h4 className="mb-2 text-sm font-black text-slate-800">発生時間帯別</h4>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-1 pr-2">時間帯</th>
                  <th className="py-1 text-right">件数</th>
                </tr>
              </thead>
              <tbody>
                {slotRows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="py-3 text-slate-500">
                      該当なし
                    </td>
                  </tr>
                ) : (
                  slotRows.map((r) => (
                    <tr key={r.key} className="border-b border-slate-100">
                      <td className="py-1.5 font-bold text-slate-800">{r.key}</td>
                      <td className="py-1.5 text-right tabular-nums font-bold text-indigo-700">{r.count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <label className="mb-3 flex flex-col gap-1">
          <span className="text-xs font-bold text-slate-600">アセスメント（AI生成・編集可）</span>
          <textarea
            value={assessment}
            onChange={(e) => setAssessment(e.target.value)}
            rows={10}
            placeholder="「アセスメント生成」を押すと Gemini が文案を作成します。未設定時は定型文のみです。"
            className="rounded-xl border-2 border-slate-300 px-3 py-2 text-sm leading-relaxed"
          />
        </label>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            disabled={aiBusy || agg.total === 0}
            onClick={() => void runAssessment()}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 text-sm font-black text-white hover:bg-violet-500 disabled:opacity-50 sm:flex-none sm:px-6"
          >
            {aiBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
            アセスメント生成
          </button>
          <button
            type="button"
            disabled={agg.total === 0}
            onClick={printHtml}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-50 sm:flex-none sm:px-6"
          >
            <Printer className="h-5 w-5" />
            印刷・PDF
          </button>
          <button
            type="button"
            disabled={agg.total === 0}
            onClick={downloadCsv}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-slate-400 py-3 text-sm font-black text-slate-800 hover:bg-slate-50 disabled:opacity-50 sm:flex-none sm:px-6"
          >
            <Download className="h-5 w-5" />
            CSV
          </button>
        </div>

        {!geminiKey && (
          <p className="mt-3 text-xs text-amber-700">VITE_GEMINI_API_KEY があると AI アセスメントが利用できます。</p>
        )}
      </div>
    </div>
  );
}
