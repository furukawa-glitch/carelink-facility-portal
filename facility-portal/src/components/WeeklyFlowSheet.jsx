import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Printer, X } from 'lucide-react';
import { buildWeeklyFlowSheetModel } from '../lib/weeklyFlowSheetData.js';
import { WeeklyFlowVitalsChart } from './WeeklyFlowVitalsChart.jsx';

/**
 * @param {{
 *   title: string;
 *   open: boolean;
 *   onToggle: () => void;
 *   children: React.ReactNode;
 *   tone?: 'default' | 'meal';
 * }} props
 */
function FlowSection({ title, open, onToggle, children, tone = 'default' }) {
  const headCls =
    tone === 'meal'
      ? 'bg-pink-100 text-pink-950 border-pink-300'
      : 'bg-slate-200 text-slate-900 border-slate-300';
  return (
    <div className="overflow-hidden rounded-lg border-2 border-slate-300">
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm font-black ${headCls}`}
      >
        <span>{title}</span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open ? <div className="bg-white p-2">{children}</div> : null}
    </div>
  );
}

/**
 * @param {{ resident: Record<string, unknown>; onClose: () => void }} props
 */
export function WeeklyFlowSheet({ resident, onClose }) {
  const model = useMemo(
    () => buildWeeklyFlowSheetModel(String(resident?.id ?? ''), resident),
    [resident]
  );
  const [fontSize, setFontSize] = useState(/** @type {'sm' | 'md' | 'lg'} */ ('md'));
  const [showTemp, setShowTemp] = useState(true);
  const [showPulse, setShowPulse] = useState(true);
  const [showBp, setShowBp] = useState(true);
  const [openSections, setOpenSections] = useState({
    vitals: true,
    inout: true,
    meal: true,
    care: true,
    other: true,
  });

  const textCls =
    fontSize === 'lg' ? 'text-sm' : fontSize === 'sm' ? 'text-[10px]' : 'text-xs';
  const thCls = `${textCls} border border-slate-300 px-1.5 py-1 font-black`;
  const tdCls = `${textCls} border border-slate-300 px-1.5 py-1 text-center font-bold align-top whitespace-pre-wrap`;

  const toggleSection = (key) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const printSheet = () => {
    const prev = document.title;
    document.title = `${model.residentName}様_1週間フロー`;
    window.print();
    document.title = prev;
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4 print:relative print:inset-auto print:bg-white print:p-0">
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl print:max-h-none print:max-w-none print:shadow-none">
        <div className="shrink-0 border-b border-slate-300 bg-slate-800 px-3 py-2 text-white sm:px-4 print:bg-white print:text-black">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-base font-black sm:text-lg">
                {model.residentName} 様 — 1週間フロー
              </h3>
              <p className="text-[10px] font-bold text-slate-300 sm:text-xs print:text-slate-600">
                居室 {model.room || '—'} / 直近7日（この端末の記録）/ {model.days[0]} 〜 {model.days[6]}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 print:hidden">
              <button
                type="button"
                onClick={printSheet}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-500 bg-slate-700 px-2 py-1 text-[11px] font-black hover:bg-slate-600"
              >
                <Printer size={14} /> 印刷
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 hover:bg-slate-700"
                aria-label="閉じる"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 print:hidden">
            <span className="text-[10px] font-bold text-slate-400">表示</span>
            {(['sm', 'md', 'lg']).map((sz) => (
              <button
                key={sz}
                type="button"
                onClick={() => setFontSize(sz)}
                className={`rounded px-2 py-0.5 text-[10px] font-black ${
                  fontSize === sz ? 'bg-cyan-500 text-white' : 'bg-slate-700 text-slate-200'
                }`}
              >
                {sz === 'sm' ? '小' : sz === 'md' ? '中' : '大'}
              </button>
            ))}
            <label className="flex items-center gap-1 text-[10px] font-bold">
              <input type="checkbox" checked={showTemp} onChange={(e) => setShowTemp(e.target.checked)} />
              体温
            </label>
            <label className="flex items-center gap-1 text-[10px] font-bold">
              <input type="checkbox" checked={showPulse} onChange={(e) => setShowPulse(e.target.checked)} />
              脈拍
            </label>
            <label className="flex items-center gap-1 text-[10px] font-bold">
              <input type="checkbox" checked={showBp} onChange={(e) => setShowBp(e.target.checked)} />
              血圧(上)
            </label>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2 sm:p-3">
          <div className="overflow-x-auto">
            <table className={`w-full min-w-[720px] border-collapse ${textCls}`}>
              <thead>
                <tr className="bg-slate-100">
                  <th className={`${thCls} sticky left-0 z-10 bg-slate-100 text-left min-w-[7rem]`}>項目</th>
                  {model.columns.map((col) => (
                    <th key={col.ymd} className={`${thCls} min-w-[5.5rem]`}>
                      <div>{col.label}</div>
                      <div className="font-bold text-slate-500">{col.weekday}</div>
                    </th>
                  ))}
                </tr>
                {model.columns.some((c) => c.statusLabel) ? (
                  <tr className="bg-amber-50">
                    <td className={`${tdCls} sticky left-0 bg-amber-50 text-left font-black`}>状況</td>
                    {model.columns.map((col) => (
                      <td key={`st-${col.ymd}`} className={`${tdCls} text-amber-950`}>
                        {col.statusLabel || '—'}
                      </td>
                    ))}
                  </tr>
                ) : null}
              </thead>
            </table>
          </div>

          <div className="mt-3 space-y-2">
            <FlowSection
              title="バイタル／経過表"
              open={openSections.vitals}
              onToggle={() => toggleSection('vitals')}
            >
              <WeeklyFlowVitalsChart
                points={model.chartPoints}
                dayCount={model.columns.length}
                showTemp={showTemp}
                showPulse={showPulse}
                showBp={showBp}
              />
              <table className={`mt-2 w-full min-w-[720px] border-collapse ${textCls}`}>
                <tbody>
                  {[
                    ['体温', (c) => c.latestVital?.temp ? `${c.latestVital.temp}℃` : c.vitalsText || '—'],
                    ['BP', (c) =>
                      c.latestVital?.bpUpper || c.latestVital?.bpLower
                        ? `${c.latestVital.bpUpper}/${c.latestVital.bpLower}`
                        : '—',
                    ],
                    ['P', (c) => c.latestVital?.pulse || '—'],
                    ['SpO2', (c) => (c.latestVital?.spo2 ? `${c.latestVital.spo2}%` : '—')],
                    ['体重', (c) => (c.latestVital?.weight ? `${c.latestVital.weight}kg` : '—')],
                    ['測定時刻', (c) => c.vitals.map((v) => v.hm).filter(Boolean).join(' / ') || '—'],
                  ].map(([label, fn]) => (
                    <tr key={label}>
                      <td className={`${tdCls} sticky left-0 bg-slate-50 text-left font-black`}>{label}</td>
                      {model.columns.map((col) => (
                        <td key={`${label}-${col.ymd}`} className={tdCls}>
                          {fn(col)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </FlowSection>

            <FlowSection title="IN／OUT" open={openSections.inout} onToggle={() => toggleSection('inout')}>
              <table className={`w-full min-w-[720px] border-collapse ${textCls}`}>
                <tbody>
                  <tr>
                    <td className={`${tdCls} sticky left-0 bg-slate-50 text-left font-black`}>OUT 尿量</td>
                    {model.columns.map((col) => (
                      <td key={`u-${col.ymd}`} className={tdCls}>
                        {col.urineMl != null ? `${col.urineMl}ml` : col.urineCount ? `${col.urineCount}回` : '—'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className={`${tdCls} sticky left-0 bg-slate-50 text-left font-black`}>OUT 便</td>
                    {model.columns.map((col) => (
                      <td key={`s-${col.ymd}`} className={tdCls}>
                        {col.stool.count ? `${col.stool.count}回 ${col.stool.label}`.trim() : '—'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className={`${tdCls} sticky left-0 bg-slate-50 text-left font-black`}>IN 水分</td>
                    {model.columns.map((col) => (
                      <td key={`w-${col.ymd}`} className={tdCls}>
                        {col.waterMl ? `${col.waterMl}ml` : '—'}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </FlowSection>

            <FlowSection
              title="食事"
              open={openSections.meal}
              onToggle={() => toggleSection('meal')}
              tone="meal"
            >
              <table className={`w-full min-w-[720px] border-collapse ${textCls}`}>
                <tbody>
                  {[
                    ['朝食事', (c) => c.meals.morning],
                    ['昼食事', (c) => c.meals.noon],
                    ['夕食事', (c) => c.meals.evening],
                    ['食事まとめ', (c) => c.meals.all],
                  ].map(([label, fn]) => (
                    <tr key={label}>
                      <td
                        className={`${tdCls} sticky left-0 text-left font-black ${
                          label !== '食事まとめ' ? 'bg-pink-50' : 'bg-slate-50'
                        }`}
                      >
                        {label}
                      </td>
                      {model.columns.map((col) => (
                        <td
                          key={`${label}-${col.ymd}`}
                          className={`${tdCls} ${label !== '食事まとめ' ? 'bg-pink-50/50' : ''}`}
                        >
                          {fn(col) || '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </FlowSection>

            <FlowSection title="ケア" open={openSections.care} onToggle={() => toggleSection('care')}>
              <table className={`w-full min-w-[720px] border-collapse ${textCls}`}>
                <tbody>
                  {[
                    ['巡視', (c) => (c.patrolCount ? `${c.patrolCount}回` : '—')],
                    ['経管', (c) => (c.enteralCount ? `${c.enteralCount}回` : '—')],
                    ['デイ', (c) => c.dayService || '—'],
                  ].map(([label, fn]) => (
                    <tr key={label}>
                      <td className={`${tdCls} sticky left-0 bg-slate-50 text-left font-black`}>{label}</td>
                      {model.columns.map((col) => (
                        <td key={`${label}-${col.ymd}`} className={tdCls}>
                          {fn(col)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </FlowSection>

            <FlowSection title="メモ・その他" open={openSections.other} onToggle={() => toggleSection('other')}>
              <table className={`w-full min-w-[720px] border-collapse ${textCls}`}>
                <tbody>
                  <tr>
                    <td className={`${tdCls} sticky left-0 bg-slate-50 text-left font-black`}>記録メモ</td>
                    {model.columns.map((col) => (
                      <td key={`n-${col.ymd}`} className={`${tdCls} text-left`}>
                        {col.notes || '—'}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </FlowSection>
          </div>
        </div>
      </div>
    </div>
  );
}
