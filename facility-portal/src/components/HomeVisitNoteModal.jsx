import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Printer, RefreshCw, Stethoscope, X } from 'lucide-react';
import * as Report from '../services/ReportService.js';
import { homeVisitNoteSheetConfigForLinkKey, homeVisitNoteUsesAisaiLayout } from '../config/homeVisitNoteSpreadsheet.js';
import { fetchHomeVisitNoteSheet } from '../services/HomeVisitNoteSheetService.js';
import {
  applyLatestVitalsToHomeVisitRows,
  buildHomeVisitNoteHtml,
  currentYmd,
  downloadAisaiHomeVisitSheetTsv,
  downloadHomeVisitNoteCsv,
  downloadHomeVisitNoteHtml,
  formatBpSlash,
  homeVisitRowFromResident,
  homeVisitRowsFromSheetMerge,
  loadHomeVisitNoteDraft,
  parseBpSlashInput,
  saveHomeVisitNoteDraft,
  toReiwaDateLabel,
  weekRangeLabelFromEndYmd,
} from '../lib/homeVisitNote.js';

/**
 * @typedef {{
 *   visitDateYmd?: string;
 *   residentIds?: string[];
 *   doctor?: string;
 *   visitType?: string;
 * }} HomeVisitNoteLaunch
 */

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   facilityLabel: string;
 *   facilitySheetTitle: string;
 *   facilityLinkKey?: string;
 *   sheetsApiKey?: string;
 *   residents: Record<string, unknown>[];
 *   nursingOfficeUi?: boolean;
 *   launchContext?: HomeVisitNoteLaunch | null;
 * }} props
 */
export function HomeVisitNoteModal({
  open,
  onClose,
  facilityLabel,
  facilitySheetTitle,
  facilityLinkKey = '',
  sheetsApiKey = '',
  residents,
  nursingOfficeUi = false,
  launchContext = null,
}) {
  const [weekEndYmd, setWeekEndYmd] = useState(currentYmd);
  const [filterMode, setFilterMode] = useState(/** @type {'all' | 'visit_nursing'} */ ('all'));
  const [facilityMemo, setFacilityMemo] = useState('');
  const [rows, setRows] = useState(/** @type {import('../lib/homeVisitNote.js').HomeVisitNoteRow[]} */ ([]));
  const [sheetLoadStatus, setSheetLoadStatus] = useState('');
  const [headerTitle, setHeaderTitle] = useState('往診ノート　《１・３週》　水曜　女性');

  const sheetConfig = useMemo(
    () => homeVisitNoteSheetConfigForLinkKey(facilityLinkKey),
    [facilityLinkKey]
  );
  const aisaiLayout = homeVisitNoteUsesAisaiLayout(sheetConfig);

  const exportOpts = useMemo(
    () => (aisaiLayout ? { layout: 'aisai', headerTitle } : {}),
    [aisaiLayout, headerTitle]
  );

  const roster = useMemo(() => {
    const list = Array.isArray(residents) ? residents : [];
    if (filterMode !== 'visit_nursing' || !nursingOfficeUi) return list;
    return list.filter((r) => Report.residentHasVisitNursingSpecial(r));
  }, [residents, filterMode, nursingOfficeUi]);

  const initRows = useCallback(
    (launch = null) => {
      const fromVisit = launch && typeof launch === 'object';
      let endYmd = currentYmd();

      const draft = !fromVisit ? loadHomeVisitNoteDraft(facilitySheetTitle) : null;
      if (!fromVisit && draft) {
        if (draft.weekEndYmd) endYmd = String(draft.weekEndYmd);
        if (draft.facilityMemo != null) setFacilityMemo(String(draft.facilityMemo));
        if (draft.headerTitle != null) setHeaderTitle(String(draft.headerTitle));
        if (draft.filterMode === 'visit_nursing' || draft.filterMode === 'all') {
          setFilterMode(draft.filterMode);
        }
      } else if (fromVisit) {
        endYmd = String(launch.visitDateYmd ?? '').slice(0, 10) || currentYmd();
        const memoParts = [launch.doctor, launch.visitType].filter(Boolean);
        setFacilityMemo(memoParts.length ? memoParts.join('・') : '');
      }
      setWeekEndYmd(endYmd);

      const visitIdSet = fromVisit
        ? new Set((launch.residentIds ?? []).map((id) => String(id).trim()).filter(Boolean))
        : null;

      const draftRows = !fromVisit && Array.isArray(draft?.rows) ? draft.rows : null;
      const byId = new Map((draftRows ?? []).map((r) => [String(r.residentId), r]));

      let next = roster.map((res) => {
        const id = String(res?.id ?? '').trim();
        if (fromVisit) {
          const included = visitIdSet && visitIdSet.size > 0 ? visitIdSet.has(id) : true;
          return homeVisitRowFromResident(res, { included });
        }
        const saved = byId.get(id);
        if (saved) {
          return {
            ...homeVisitRowFromResident(res, { included: saved.included !== false }),
            ...saved,
            residentId: id,
          };
        }
        return homeVisitRowFromResident(res);
      });
      next = applyLatestVitalsToHomeVisitRows(next, endYmd);
      setRows(next);
    },
    [facilitySheetTitle, roster]
  );

  useEffect(() => {
    if (!open) return;
    initRows(launchContext ?? null);
  }, [open, initRows, filterMode, launchContext]);

  useEffect(() => {
    if (!open || !rows.length) return;
    saveHomeVisitNoteDraft(facilitySheetTitle, {
      weekEndYmd,
      facilityMemo,
      headerTitle,
      filterMode,
      rows,
    });
  }, [open, rows, weekEndYmd, facilityMemo, headerTitle, filterMode, facilitySheetTitle]);

  const patchRow = (residentId, patch) => {
    setRows((prev) =>
      prev.map((r) => (r.residentId === residentId ? { ...r, ...patch } : r))
    );
  };

  const bulkLatestVitals = () => {
    setRows((prev) => applyLatestVitalsToHomeVisitRows(prev, weekEndYmd));
  };

  const loadFromOperationsSheet = async () => {
    if (!sheetConfig) return;
    const key = String(sheetsApiKey ?? '').trim();
    if (!key) {
      alert(
        'Google シートから読み込むには VITE_GOOGLE_SHEETS_API_KEY が必要です。シートを「リンクを知っている全員が閲覧可」にし、API キーに読取権限があるか確認してください。'
      );
      return;
    }
    setSheetLoadStatus('読込中…');
    try {
      const parsed = await fetchHomeVisitNoteSheet(sheetConfig, key);
      if (!parsed.rows.length) {
        throw new Error('氏名列が見つからないか、データ行が空でした。');
      }
      const merged = homeVisitRowsFromSheetMerge(parsed, roster, { includeUnlistedRoster: true });
      setRows(applyLatestVitalsToHomeVisitRows(merged, weekEndYmd));
      if (parsed.headerTitle) setHeaderTitle(parsed.headerTitle);
      else if (parsed.facilityMemo && /往診ノート/u.test(parsed.facilityMemo)) {
        const titlePart = parsed.facilityMemo.split(' / ').find((x) => /往診ノート/u.test(x));
        if (titlePart) setHeaderTitle(titlePart);
      }
      setSheetLoadStatus(`${parsed.rows.length}行をシートから反映しました`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSheetLoadStatus('');
      alert(`往診ノートシートの読込に失敗しました。\n${msg}`);
    }
  };

  const openOperationsSheet = () => {
    if (!sheetConfig?.url) return;
    window.open(sheetConfig.url, '_blank', 'noopener,noreferrer');
  };

  const printNote = () => {
    const w = window.open('', '_blank');
    const htmlOpts = { memo: facilityMemo, ...exportOpts };
    if (!w) {
      downloadHomeVisitNoteHtml(facilityLabel, weekEndYmd, rows, htmlOpts);
      return;
    }
    w.document.write(buildHomeVisitNoteHtml(facilityLabel, weekEndYmd, rows, htmlOpts));
    w.document.close();
    w.focus();
    w.print();
  };

  if (!open) return null;

  const includedCount = rows.filter((r) => r.included && String(r.name).trim()).length;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-visit-note-title"
    >
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border-2 border-slate-300 bg-white shadow-2xl">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-3 sm:px-4">
          <div>
            <h2 id="home-visit-note-title" className="flex items-center gap-2 text-base font-black text-slate-900 sm:text-lg">
              <Stethoscope className="h-5 w-5 text-teal-700" aria-hidden />
              {launchContext ? 'FAX用 往診ノート' : '往診ノート（週次）'}
            </h2>
            {launchContext ? (
              <p className="mt-0.5 text-[11px] font-bold text-violet-800">
                往診予定から起動 — 対象者のみチェック済み・最新バイタル反映済み。印刷してFAX送付できます。
              </p>
            ) : null}
            <p className="mt-0.5 text-xs font-bold text-slate-600">
              {facilityLabel} ／{' '}
              {aisaiLayout ? toReiwaDateLabel(weekEndYmd) : `対象週: ${weekRangeLabelFromEndYmd(weekEndYmd)}`} ／ 出力{' '}
              {includedCount} 名
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-700 hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-slate-100 bg-white px-3 py-2 sm:px-4">
          <label className="text-xs font-bold text-slate-700">
            週の終わり（日）
            <input
              type="date"
              value={weekEndYmd}
              onChange={(e) => setWeekEndYmd(e.target.value)}
              className="mt-0.5 block rounded-lg border-2 border-slate-200 px-2 py-1.5 text-sm font-bold"
            />
          </label>
          {nursingOfficeUi ? (
            <label className="text-xs font-bold text-slate-700">
              対象
              <select
                value={filterMode}
                onChange={(e) => setFilterMode(/** @type {'all' | 'visit_nursing'} */ (e.target.value))}
                className="mt-0.5 block rounded-lg border-2 border-slate-200 px-2 py-1.5 text-sm font-bold"
              >
                <option value="all">全入居者</option>
                <option value="visit_nursing">訪看・特別指示のみ</option>
              </select>
            </label>
          ) : null}
          <button
            type="button"
            onClick={bulkLatestVitals}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-teal-600 bg-teal-600 px-3 py-2 text-xs font-black text-white hover:bg-teal-500"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            週内バイタルを一括反映
          </button>
          {sheetConfig ? (
            <>
              <button
                type="button"
                onClick={loadFromOperationsSheet}
                className="inline-flex items-center gap-1.5 rounded-xl border-2 border-emerald-600 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-900 hover:bg-emerald-100"
              >
                運用シートから読込
              </button>
              <button
                type="button"
                onClick={openOperationsSheet}
                className="inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                運用シートを開く
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={printNote}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-400 bg-white px-3 py-2 text-xs font-black text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-4 w-4" aria-hidden />
            印刷
          </button>
          <button
            type="button"
            onClick={() => downloadHomeVisitNoteHtml(facilityLabel, weekEndYmd, rows, { memo: facilityMemo, ...exportOpts })}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-blue-500 bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-500"
          >
            <Download className="h-4 w-4" aria-hidden />
            HTML保存
          </button>
          <button
            type="button"
            onClick={() => downloadHomeVisitNoteCsv(facilityLabel, weekEndYmd, rows, exportOpts)}
            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
          >
            CSV
          </button>
          {aisaiLayout ? (
            <button
              type="button"
              onClick={() => downloadAisaiHomeVisitSheetTsv(weekEndYmd, rows)}
              className="inline-flex items-center gap-1.5 rounded-xl border-2 border-violet-400 bg-violet-50 px-3 py-2 text-xs font-black text-violet-900 hover:bg-violet-100"
            >
              シート貼付TSV
            </button>
          ) : null}
        </div>

        {aisaiLayout ? (
          <label className="shrink-0 border-b border-slate-100 px-3 py-2 text-xs font-bold text-slate-700 sm:px-4">
            帳票タイトル（《１・３週》水曜　女性 など）
            <input
              type="text"
              value={headerTitle}
              onChange={(e) => setHeaderTitle(e.target.value)}
              className="mt-1 w-full rounded-lg border-2 border-slate-200 px-2 py-1.5 text-sm font-bold"
            />
          </label>
        ) : (
          <label className="shrink-0 border-b border-slate-100 px-3 py-2 text-xs font-bold text-slate-700 sm:px-4">
            施設メモ（往診全体・印刷に載る）
            <input
              type="text"
              value={facilityMemo}
              onChange={(e) => setFacilityMemo(e.target.value)}
              placeholder="例: 往診医 ○○先生、特記事項…"
              className="mt-1 w-full rounded-lg border-2 border-slate-200 px-2 py-1.5 text-sm font-bold"
            />
          </label>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2 sm:px-3">
          <table className="w-full min-w-[720px] border-collapse text-xs font-bold">
            <thead>
              {aisaiLayout ? (
                <tr className="bg-slate-100 text-[10px] text-slate-700">
                  <th className="border border-slate-200 px-1 py-1">出</th>
                  <th className="border border-slate-200 px-2 py-1">氏名</th>
                  <th className="border border-slate-200 px-1 py-1">KT</th>
                  <th className="border border-slate-200 px-1 py-1">P</th>
                  <th className="border border-slate-200 px-1 py-1">BP</th>
                  <th className="border border-slate-200 px-1 py-1">SPO2</th>
                  <th className="border border-slate-200 px-2 py-1">備考（再検など）</th>
                  <th className="border border-slate-200 px-2 py-1">往診時記入欄</th>
                </tr>
              ) : (
                <tr className="bg-slate-100 text-[10px] text-slate-700">
                  <th className="border border-slate-200 px-1 py-1">出</th>
                  <th className="border border-slate-200 px-1 py-1">部屋</th>
                  <th className="border border-slate-200 px-2 py-1">氏名</th>
                  <th className="border border-slate-200 px-1 py-1">体温</th>
                  <th className="border border-slate-200 px-1 py-1">血圧上</th>
                  <th className="border border-slate-200 px-1 py-1">下</th>
                  <th className="border border-slate-200 px-1 py-1">脈</th>
                  <th className="border border-slate-200 px-1 py-1">SpO2</th>
                  <th className="border border-slate-200 px-1 py-1">体重</th>
                  <th className="border border-slate-200 px-2 py-1">往診メモ</th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((row) =>
                aisaiLayout ? (
                  <tr key={row.residentId} className={row.included ? 'bg-white' : 'bg-slate-50 opacity-60'}>
                    <td className="border border-slate-200 px-1 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={row.included}
                        onChange={(e) => patchRow(row.residentId, { included: e.target.checked })}
                        aria-label={`${row.name}を往診ノートに含める`}
                      />
                    </td>
                    <td className="border border-slate-200 px-1 py-1">
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => patchRow(row.residentId, { name: e.target.value })}
                        className="w-full min-w-[6rem] rounded border border-slate-200 px-1 py-0.5 font-bold"
                      />
                    </td>
                    <td className="border border-slate-200 px-0.5 py-1">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={row.temp}
                        onChange={(e) => patchRow(row.residentId, { temp: e.target.value })}
                        placeholder="℃"
                        className="w-12 rounded border border-slate-200 px-1 py-0.5 text-center font-mono text-[11px]"
                      />
                    </td>
                    <td className="border border-slate-200 px-0.5 py-1">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={row.pulse}
                        onChange={(e) => patchRow(row.residentId, { pulse: e.target.value })}
                        className="w-10 rounded border border-slate-200 px-1 py-0.5 text-center font-mono text-[11px]"
                      />
                    </td>
                    <td className="border border-slate-200 px-0.5 py-1">
                      <input
                        type="text"
                        value={formatBpSlash(row)}
                        onChange={(e) => patchRow(row.residentId, parseBpSlashInput(e.target.value))}
                        placeholder="/"
                        className="w-16 rounded border border-slate-200 px-1 py-0.5 text-center font-mono text-[11px]"
                      />
                    </td>
                    <td className="border border-slate-200 px-0.5 py-1">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={row.spo2}
                        onChange={(e) => patchRow(row.residentId, { spo2: e.target.value })}
                        placeholder="%"
                        className="w-10 rounded border border-slate-200 px-1 py-0.5 text-center font-mono text-[11px]"
                      />
                    </td>
                    <td className="border border-slate-200 px-1 py-1">
                      <input
                        type="text"
                        value={row.remark ?? ''}
                        onChange={(e) => patchRow(row.residentId, { remark: e.target.value })}
                        className="w-full min-w-[5rem] rounded border border-slate-200 px-1 py-0.5"
                      />
                    </td>
                    <td className="border border-slate-200 px-1 py-1">
                      <input
                        type="text"
                        value={row.visitEntry ?? row.note ?? ''}
                        onChange={(e) =>
                          patchRow(row.residentId, { visitEntry: e.target.value, note: e.target.value })
                        }
                        className="w-full min-w-[6rem] rounded border border-slate-200 px-1 py-0.5"
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={row.residentId} className={row.included ? 'bg-white' : 'bg-slate-50 opacity-60'}>
                    <td className="border border-slate-200 px-1 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={row.included}
                        onChange={(e) => patchRow(row.residentId, { included: e.target.checked })}
                        aria-label={`${row.name}を往診ノートに含める`}
                      />
                    </td>
                    <td className="border border-slate-200 px-1 py-1 text-center">{row.room || '—'}</td>
                    <td className="border border-slate-200 px-1 py-1">
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => patchRow(row.residentId, { name: e.target.value })}
                        className="w-full min-w-[5rem] rounded border border-slate-200 px-1 py-0.5 font-bold"
                      />
                    </td>
                    {(['temp', 'bpUpper', 'bpLower', 'pulse', 'spo2', 'weight']).map((k) => (
                      <td key={k} className="border border-slate-200 px-0.5 py-1">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row[k]}
                          onChange={(e) => patchRow(row.residentId, { [k]: e.target.value })}
                          className="w-12 rounded border border-slate-200 px-1 py-0.5 text-center font-mono text-[11px] sm:w-14"
                        />
                      </td>
                    ))}
                    <td className="border border-slate-200 px-1 py-1">
                      <input
                        type="text"
                        value={row.note}
                        onChange={(e) => patchRow(row.residentId, { note: e.target.value })}
                        placeholder="往診時の所見"
                        className="w-full min-w-[6rem] rounded border border-slate-200 px-1 py-0.5"
                      />
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
          {!rows.length ? (
            <p className="py-8 text-center text-sm font-bold text-slate-500">名簿に利用者がいません。</p>
          ) : null}
        </div>

        <p className="shrink-0 border-t border-slate-100 px-3 py-2 text-[10px] font-bold leading-snug text-slate-500 sm:px-4">
          「週内バイタル一括反映」は、指定した週（終了日から7日間）の記録を優先して読み込みます。氏名・メモは編集できます。下書きは施設ごとに自動保存されます。
          {aisaiLayout ? (
            <>
              {' '}
              愛西の往診ノート用紙（氏名・KT・P・BP・SPO2・備考・往診時記入欄）に合わせた形式です。「シート貼付TSV」で Google シートの氏名列から貼り付けできます。
            </>
          ) : sheetConfig ? (
            <>
              {' '}
              この施設の運用 Google シート（氏名の並び・上部メモ）と連携できます。
            </>
          ) : null}
          {sheetLoadStatus ? <span className="block text-emerald-700">{sheetLoadStatus}</span> : null}
        </p>
      </div>
    </div>
  );
}
