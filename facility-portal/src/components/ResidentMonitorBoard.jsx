import React, { useMemo, useState } from 'react';
import { AlertCircle, LayoutGrid } from 'lucide-react';
import * as Report from '../services/ReportService.js';
/**
 * @param {ReturnType<typeof Report.evaluateResidentMonitor>} ev
 * @param {{ hasAlert?: boolean }} ded
 */
function monitorAlertShort(ev, ded) {
  if (ev.level === 'critical') {
    const f = ev.vitalFlags?.[0];
    if (f?.code === 'fever') return '発熱';
    if (f?.code === 'bp_sys_high') return '血圧↑';
    if (f?.code === 'bp_dia_low') return '血圧↓';
    if (ev.stoolBad) return '排便';
    if (ev.urineBad) return '排尿';
    return '異常';
  }
  if (ev.level === 'warn') {
    if (ev.patrolBad) return '巡視';
    return '注意';
  }
  if (ded?.hasAlert) return '要確認';
  return '';
}

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @param {'room' | 'kana'} sortMode
 */
function compareResidents(a, b, sortMode) {
  if (sortMode === 'kana') {
    const ka = String(a.kana ?? a.nameKana ?? a.name ?? '');
    const kb = String(b.kana ?? b.nameKana ?? b.name ?? '');
    return ka.localeCompare(kb, 'ja');
  }
  const ra = String(a.room ?? '').trim();
  const rb = String(b.room ?? '').trim();
  const na = Number(ra.replace(/\D/g, ''));
  const nb = Number(rb.replace(/\D/g, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return ra.localeCompare(rb, 'ja', { numeric: true });
}

/**
 * @param {'critical' | 'warn' | 'ok'} level
 */
function levelRank(level) {
  if (level === 'critical') return 0;
  if (level === 'warn') return 1;
  return 2;
}

/**
 * @param {{
 *   residents: Record<string, unknown>[];
 *   residentNameWithoutSama: (nameRaw: unknown) => string;
 *   residentSortMode: 'room' | 'kana';
 *   onSelectResident: (res: Record<string, unknown>, list: Record<string, unknown>[]) => void;
 *   monitorRev?: number;
 *   stayStatusRev?: number;
 * }} props
 */
export function ResidentMonitorBoard({
  residents,
  residentNameWithoutSama,
  residentSortMode,
  onSelectResident,
  monitorRev = 0,
  stayStatusRev = 0,
}) {
  void monitorRev;
  void stayStatusRev;
  const [alarmsOnly, setAlarmsOnly] = useState(false);

  const rows = useMemo(() => {
    const list = Array.isArray(residents) ? residents : [];
    const out = list.map((res) => {
      const id = String(res.id ?? '');
      const rawEv = Report.evaluateResidentMonitor(res, { ignoreMute: true });
      const muted = Report.isResidentMonitorAlertMuted(id);
      const ev = muted ? Report.evaluateResidentMonitor(res) : rawEv;
      const ded = Report.evaluateReimbursementDeductionAlerts(res, ev);
      const displayLevel =
        rawEv.level === 'critical' || rawEv.level === 'warn' || ded.hasAlert
          ? rawEv.level === 'critical'
            ? 'critical'
            : 'warn'
          : ev.level;
      const stayStatus = Report.getResidentStayStatus(id);
      const hospitalized = Boolean(stayStatus?.hospitalized);
      return {
        res,
        id,
        room: String(res.room ?? '—').trim() || '—',
        name: residentNameWithoutSama(res.name),
        ev,
        rawEv,
        ded,
        muted,
        displayLevel,
        alertShort: monitorAlertShort(rawEv, ded),
        hospitalized,
        stayStatus,
      };
    });
    out.sort((a, b) => {
      const dr = levelRank(a.displayLevel) - levelRank(b.displayLevel);
      if (dr !== 0) return dr;
      return compareResidents(a.res, b.res, residentSortMode);
    });
    return out;
  }, [residents, residentNameWithoutSama, residentSortMode, monitorRev, stayStatusRev]);

  const counts = useMemo(() => {
    let critical = 0;
    let warn = 0;
    let ok = 0;
    for (const r of rows) {
      if (r.displayLevel === 'critical') critical += 1;
      else if (r.displayLevel === 'warn') warn += 1;
      else ok += 1;
    }
    return { critical, warn, ok, total: rows.length };
  }, [rows]);

  const visible = alarmsOnly ? rows.filter((r) => r.displayLevel !== 'ok') : rows;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border-2 border-slate-400 bg-slate-200/80 shadow-inner">
      <div className="sticky top-0 z-10 shrink-0 border-b-2 border-slate-400 bg-slate-900 px-2 py-2 text-white sm:px-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <LayoutGrid className="h-5 w-5 shrink-0 text-cyan-300" aria-hidden />
            <span className="text-sm font-black sm:text-base">アラーム一覧（1画面）</span>
            <span className="text-[10px] font-bold text-slate-300 sm:text-xs">
              全 {counts.total} 名
              {alarmsOnly ? ` / 表示 ${visible.length}` : ''}
            </span>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] font-black">
            <input
              type="checkbox"
              checked={alarmsOnly}
              onChange={(e) => setAlarmsOnly(e.target.checked)}
              className="h-3.5 w-3.5 rounded"
            />
            アラームのみ
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-black sm:text-xs">
          <span className="rounded-md bg-red-600 px-2 py-0.5 text-white">
            緊急 {counts.critical}
          </span>
          <span className="rounded-md bg-amber-400 px-2 py-0.5 text-amber-950">
            注意 {counts.warn}
          </span>
          <span className="rounded-md bg-slate-600 px-2 py-0.5 text-slate-100">
            平常 {counts.ok}
          </span>
        </div>
        <p className="mt-1.5 text-[10px] font-bold leading-snug text-slate-400">
          赤＝バイタル異常・排便/排尿の長時間空白。黄＝巡視間隔など。タップで詳細（カード表示と同じメニュー）。名簿が多い施設向けのコンパクト表示です。
        </p>
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto p-1 sm:p-1.5"
        style={{ maxHeight: 'min(78vh, calc(100dvh - 11rem))' }}
      >
        {visible.length === 0 ? (
          <p className="rounded-xl bg-white px-4 py-8 text-center text-sm font-bold text-slate-600">
            {alarmsOnly ? '現在、アラーム対象の利用者はいません。' : '表示する利用者がいません。'}
          </p>
        ) : (
          <div
            className="grid gap-0.5 sm:gap-1"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(4.5rem, 1fr))',
              gridAutoRows: 'minmax(3.1rem, auto)',
            }}
          >
            {visible.map((row) => {
              const critical = row.displayLevel === 'critical';
              const warn = row.displayLevel === 'warn';
              return (
                <button
                  key={row.id}
                  type="button"
                  title={
                    row.muted
                      ? `${row.name} 様 — アラーム一時停止中（実際は${row.rawEv.level}）`
                      : `${row.name} 様 ${row.room} — ${row.alertShort || '平常'}`
                  }
                  onClick={() => onSelectResident(row.res, residents)}
                  className={`flex min-h-[3.1rem] flex-col items-stretch justify-center rounded border px-0.5 py-0.5 text-left shadow-sm transition hover:ring-2 hover:ring-cyan-400 ${
                    critical
                      ? 'animate-carelink-blink border-red-900 bg-red-600 text-white'
                      : warn
                        ? 'border-amber-600 bg-amber-300 text-amber-950'
                        : row.hospitalized
                          ? 'border-violet-400 bg-violet-100 text-violet-950'
                          : 'border-slate-300 bg-white text-slate-800'
                  } ${row.muted && (row.rawEv.level === 'critical' || row.rawEv.level === 'warn') ? 'ring-2 ring-red-400 ring-offset-1' : ''}`}
                >
                  <span
                    className={`truncate text-center font-mono text-[9px] font-black leading-none ${
                      critical ? 'text-red-100' : 'text-slate-500'
                    }`}
                  >
                    {row.room}
                  </span>
                  <span className="truncate text-center text-[10px] font-black leading-tight sm:text-[11px]">
                    {row.name}
                  </span>
                  {row.alertShort ? (
                    <span
                      className={`truncate text-center text-[8px] font-black leading-none sm:text-[9px] ${
                        critical ? 'text-white' : warn ? 'text-amber-900' : 'text-slate-600'
                      }`}
                    >
                      {row.muted ? `(${row.alertShort})` : row.alertShort}
                    </span>
                  ) : row.hospitalized ? (
                    <span className="truncate text-center text-[8px] font-black text-violet-800">入院</span>
                  ) : null}
                  {critical && !row.muted ? (
                    <AlertCircle className="mx-auto mt-0.5 h-3 w-3 shrink-0 opacity-90" aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
