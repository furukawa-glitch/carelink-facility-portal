import React, { useMemo } from 'react';
import * as Report from '../services/ReportService.js';
import { X, Printer } from 'lucide-react';

function localYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysYmd(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return localYmd(d);
}

/**
 * @param {{ resident: Record<string, unknown>; onClose: () => void }} props
 */
export function WeeklyFlowSheet({ resident, onClose }) {
  const id = String(resident?.id ?? '');
  const name = String(resident?.name ?? '').replace(/様\s*$/u, '');

  const { days, rows } = useMemo(() => {
    const end = localYmd();
    const dayList = [];
    for (let i = 6; i >= 0; i -= 1) dayList.push(addDaysYmd(end, -i));

    /** @type {{ label: string; get: (events: ReturnType<typeof Report.getCareEventsForResidentDay>) => string }[]} */
    const defs = [
      {
        label: '体温',
        get: (evs) => {
          const v = evs.filter((e) => e.type === 'vital_snapshot').at(-1)?.meta?.temp;
          return v != null ? `${v}℃` : '';
        },
      },
      {
        label: 'BP',
        get: (evs) => {
          const m = evs.filter((e) => e.type === 'vital_snapshot').at(-1)?.meta;
          if (!m) return '';
          const u = m.bpUpper ?? '';
          const l = m.bpLower ?? '';
          return u || l ? `${u}/${l}` : '';
        },
      },
      {
        label: 'P',
        get: (evs) => {
          const v = evs.filter((e) => e.type === 'vital_snapshot').at(-1)?.meta?.pulse;
          return v != null ? String(v) : '';
        },
      },
      {
        label: 'SpO2',
        get: (evs) => {
          const v = evs.filter((e) => e.type === 'vital_snapshot').at(-1)?.meta?.spo2;
          return v != null ? `${v}%` : '';
        },
      },
      {
        label: '食事',
        get: (evs) =>
          evs
            .filter((e) => e.type === 'meal')
            .map((e) => {
              const m = e.meta ?? {};
              const slot = m.mealSlot || m.mealTime || '';
              const amt = m.mealAmount || m.mealValue || '';
              return [slot, amt].filter(Boolean).join(' ');
            })
            .join(' / '),
      },
      {
        label: '水分ml',
        get: (evs) => {
          let ml = '';
          for (const e of evs) {
            if (e.type === 'meal' && e.meta?.waterMl) ml = String(e.meta.waterMl);
            if (e.type === 'fluid_intake' && e.meta?.waterMl) ml = String(e.meta.waterMl);
          }
          return ml;
        },
      },
      {
        label: '尿',
        get: (evs) =>
          String(evs.filter((e) => e.type === 'excretion' || e.type === 'hourly_excretion').length),
      },
      {
        label: '便',
        get: (evs) =>
          String(
            evs.filter(
              (e) =>
                (e.type === 'excretion' || e.type === 'hourly_excretion') &&
                (e.meta?.stoolVolume || e.meta?.stoolCharacter)
            ).length
          ),
      },
    ];

    const built = defs.map((def) => ({
      label: def.label,
      cells: dayList.map((ymd) => def.get(Report.getCareEventsForResidentDay(id, ymd))),
    }));

    return { days: dayList, rows: built };
  }, [id]);

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <div>
            <h3 className="text-lg font-black text-slate-900">{name} 様 — 1週間フローシート</h3>
            <p className="text-[11px] font-bold text-slate-500">この端末に保存された記録（直近7日）</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-black text-slate-700 hover:bg-slate-50"
            >
              <Printer size={14} /> 印刷
            </button>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="閉じる">
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="bg-slate-100">
                <th className="border border-slate-300 px-2 py-1 text-left font-black">項目</th>
                {days.map((d) => (
                  <th key={d} className="border border-slate-300 px-2 py-1 text-center font-black text-xs">
                    {d.slice(5).replace('-', '/')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="border border-slate-300 bg-slate-50 px-2 py-1 font-black whitespace-nowrap">{row.label}</td>
                  {row.cells.map((cell, i) => (
                    <td key={`${row.label}-${days[i]}`} className="border border-slate-300 px-2 py-1 text-center text-xs font-bold">
                      {cell || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
