import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Download, Loader2, Plus, RefreshCw, Table2, Trash2 } from 'lucide-react';
import { CARELINK_FACILITIES, licensedBedsForLinkKey } from '../config/carelinkFacilities.js';
import { fetchResidentsStatsByFacility } from '../services/GoogleSheetService.js';
import {
  getFacilityStatsSnapshot,
  saveFacilityStatsSnapshot,
} from '../services/facilityStatsSnapshotService.js';
import {
  addMoveInOutLog,
  aggregateMoveInOutByFacility,
  listMoveInOutLogsFiltered,
  moveInOutLogsToCsv,
  removeMoveInOutLog,
} from '../services/moveInOutLogService.js';

const SHEETS_KEY = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '';

function ymNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ymdToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 在籍数に対する当月登録入居の割合（%）。在籍が0のときは「—」 */
function formatMoveInRate(moveIn, active) {
  const a = Number(active);
  if (!Number.isFinite(a) || a <= 0) return '—';
  const mi = Number(moveIn);
  if (!Number.isFinite(mi) || mi < 0) return '—';
  const pct = (mi / a) * 100;
  if (!Number.isFinite(pct)) return '—';
  return `${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`;
}

function logKindLabel(kind) {
  if (kind === 'move_out') return '退去';
  if (kind === 'hospital') return '入院';
  return '入居';
}

function logGenderLabel(gender) {
  if (gender === 'female') return '女性';
  if (gender === 'male') return '男性';
  return '—';
}

/** @param {string} [reason] */
function moveOutReasonLabel(reason) {
  if (reason === 'after_hospital') return '入院して退去';
  if (reason === 'death') return '死亡退去';
  if (reason === 'transfer_facility') return '他施設へ移動';
  return '—';
}

/** 事業ブロック（親会社・ブランド単位。必要に応じて編集） */
const BUSINESS_GROUP = Object.freeze({
  中川本館: 'Careサポート',
  愛西: 'Careサポート',
  北名古屋: 'Careサポート',
  千音寺: 'Careサポート',
  中村: 'Careサポート',
  起: '青空',
  一宮: '青空',
});

/** @param {Record<string, number>[]} list */
function sumStats(list) {
  const z = {
    dataRows: 0,
    active: 0,
    careNeed1: 0,
    careNeed2: 0,
    careNeed3: 0,
    careNeed4: 0,
    careNeed5: 0,
    careSupport1: 0,
    careSupport2: 0,
    careOther: 0,
    male: 0,
    female: 0,
    genderUnknown: 0,
    inactiveTotal: 0,
    statusHospital: 0,
    statusDischargeHospital: 0,
    statusMoveOut: 0,
    statusMoveInPipeline: 0,
    statusOtherInactive: 0,
  };
  for (const s of list) {
    for (const k of Object.keys(z)) {
      z[k] += s[k] ?? 0;
    }
  }
  return z;
}

function statsToCsvRows(facilities, fetchedAt, yearMonth) {
  const agg = aggregateMoveInOutByFacility(yearMonth);
  const aggByKey = new Map(agg.map((r) => [r.linkKey, r]));
  const head = [
    '事業ブロック',
    '施設キー',
    '表示名',
    '定員_床',
    '在籍率_対定員',
    '対象月_登録入居',
    '対象月_登録入院',
    '対象月_登録退去',
    '月次比率_登録入居÷在籍',
    '名簿行数',
    '入居中(在籍)',
    '要介護1',
    '要介護2',
    '要介護3',
    '要介護4',
    '要介護5',
    '要支援1',
    '要支援2',
    '介護その他',
    '男性',
    '女性',
    '性別不明',
    '非在籍計',
    '状況:入院系',
    '状況:退院表記',
    '状況:退去等',
    '状況:入居予定・見学等',
    '状況:その他非在籍',
  ];
  const lines = [head.join(',')];
  for (const s of facilities) {
    const biz = BUSINESS_GROUP[s.linkKey] ?? '—';
    const app = aggByKey.get(s.linkKey);
    const mi = app?.moveIn ?? 0;
    const mo = app?.moveOut ?? 0;
    const hi = app?.hospital ?? 0;
    const beds = licensedBedsForLinkKey(s.linkKey);
    const occ = formatMoveInRate(s.active, beds ?? 0);
    const rate = formatMoveInRate(mi, s.active);
    lines.push(
      [
        `"${biz}"`,
        `"${s.linkKey}"`,
        `"${s.tabLabel}"`,
        beds ?? '',
        `"${beds ? occ : '—'}"`,
        mi,
        hi,
        mo,
        `"${rate}"`,
        s.dataRows,
        s.active,
        s.careNeed1,
        s.careNeed2,
        s.careNeed3,
        s.careNeed4,
        s.careNeed5,
        s.careSupport1,
        s.careSupport2,
        s.careOther,
        s.male,
        s.female,
        s.genderUnknown,
        s.inactiveTotal,
        s.statusHospital,
        s.statusDischargeHospital,
        s.statusMoveOut,
        s.statusMoveInPipeline,
        s.statusOtherInactive,
      ].join(',')
    );
  }
  lines.push(`"取得日時","${fetchedAt}"`);
  return lines.join('\r\n');
}

/**
 * @param {{ onBack: () => void }} props
 */
export function FacilityStatsPage({ onBack }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [payload, setPayload] = useState(
    /** @type {{ facilities: any[]; fetchedAt: string; viewMonth?: string } | null} */ (null)
  );
  const [logRev, setLogRev] = useState(0);
  /** 名簿一括表の表示月＋登録ログの集計月（同一） */
  const [statsViewMonth, setStatsViewMonth] = useState(ymNow);
  const [formFacility, setFormFacility] = useState(() => CARELINK_FACILITIES[0]?.linkKey ?? '');
  const [formKind, setFormKind] = useState(/** @type {'move_in' | 'move_out' | 'hospital'} */ ('move_in'));
  const [formDate, setFormDate] = useState(ymdToday);
  const [formName, setFormName] = useState('');
  const [formGender, setFormGender] = useState(/** @type {'' | 'male' | 'female'} */ (''));
  const [formMoveOutReason, setFormMoveOutReason] = useState(
    /** @type {'' | 'after_hospital' | 'death' | 'transfer_facility'} */ ('')
  );
  const [formNote, setFormNote] = useState('');

  const fetchAndSaveForViewMonth = useCallback(async () => {
    const key = String(SHEETS_KEY ?? '').trim();
    if (!key) return;
    setLoading(true);
    setErr('');
    try {
      const data = await fetchResidentsStatsByFacility(key);
      saveFacilityStatsSnapshot(statsViewMonth, data);
      setPayload({
        facilities: data.facilities,
        fetchedAt: data.fetchedAt,
        viewMonth: statsViewMonth,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '取得に失敗しました');
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [statsViewMonth]);

  useEffect(() => {
    const key = String(SHEETS_KEY ?? '').trim();
    if (!key) {
      setPayload(null);
      setErr('');
      return;
    }
    const snap = getFacilityStatsSnapshot(statsViewMonth);
    if (snap) {
      setPayload({
        facilities: snap.facilities,
        fetchedAt: snap.fetchedAt,
        viewMonth: snap.yearMonth,
      });
      setErr('');
      return;
    }
    if (statsViewMonth === ymNow()) {
      void fetchAndSaveForViewMonth();
    } else {
      setPayload(null);
      setErr('');
    }
  }, [statsViewMonth, fetchAndSaveForViewMonth]);

  const byBusiness = useMemo(() => {
    if (!payload?.facilities?.length) return [];
    const map = new Map();
    for (const s of payload.facilities) {
      const g = BUSINESS_GROUP[s.linkKey] ?? 'その他';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(s);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja'));
  }, [payload]);

  const grand = useMemo(() => (payload?.facilities ? sumStats(payload.facilities) : null), [payload]);

  /** 定員が設定されている施設のみで、在籍合計／定員合計（合計行の在籍率用） */
  const licensedGrand = useMemo(() => {
    if (!payload?.facilities?.length) return { bedsSum: 0, activeSum: 0 };
    let bedsSum = 0;
    let activeSum = 0;
    for (const s of payload.facilities) {
      const b = licensedBedsForLinkKey(s.linkKey);
      if (b) {
        bedsSum += b;
        activeSum += s.active;
      }
    }
    return { bedsSum, activeSum };
  }, [payload]);

  /** 名簿なしでも表示できる定員の合計（config のみ） */
  const totalLicensedBedsConfigured = useMemo(
    () => CARELINK_FACILITIES.reduce((sum, f) => sum + (licensedBedsForLinkKey(f.linkKey) ?? 0), 0),
    []
  );

  const appByKey = useMemo(() => {
    const rows = aggregateMoveInOutByFacility(statsViewMonth);
    const m = new Map();
    for (const r of rows) m.set(r.linkKey, r);
    return m;
  }, [statsViewMonth, logRev]);

  const recentLogs = useMemo(() => listMoveInOutLogsFiltered(statsViewMonth, 80), [statsViewMonth, logRev]);

  const appGrand = useMemo(() => {
    let mi = 0;
    let mo = 0;
    let hi = 0;
    for (const r of aggregateMoveInOutByFacility(statsViewMonth)) {
      mi += r.moveIn;
      mo += r.moveOut;
      hi += r.hospital;
    }
    return { moveIn: mi, moveOut: mo, hospital: hi };
  }, [statsViewMonth, logRev]);

  const registrationOnlyRows = useMemo(() => aggregateMoveInOutByFacility(statsViewMonth), [statsViewMonth, logRev]);

  const submitMoveLog = (e) => {
    e.preventDefault();
    const lk = String(formFacility ?? '').trim();
    if (!lk) {
      alert('施設を選んでください');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(formDate ?? '').trim())) {
      alert('発生日を YYYY-MM-DD で入力してください');
      return;
    }
    if (formKind === 'move_out' && !formMoveOutReason) {
      alert('退去の場合は「退去の種類」を選んでください（入院して退去／死亡退去／他施設へ移動）');
      return;
    }
    const def = CARELINK_FACILITIES.find((f) => f.linkKey === lk);
    addMoveInOutLog({
      facilityLinkKey: lk,
      tabLabel: def?.tabLabel ?? lk,
      kind: formKind,
      eventDate: formDate.trim(),
      residentName: formName,
      gender: formGender,
      moveOutReason: formKind === 'move_out' ? formMoveOutReason : '',
      note: formNote,
    });
    setLogRev((x) => x + 1);
    setFormName('');
    setFormGender('');
    setFormMoveOutReason('');
    setFormNote('');
  };

  const downloadCsv = () => {
    if (!payload?.facilities) return;
    const csv = statsToCsvRows(payload.facilities, payload.fetchedAt, statsViewMonth);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const vm = payload.viewMonth ?? statsViewMonth;
    a.download = `施設別入居集計_${vm}_${payload.fetchedAt.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadMoveLogCsv = () => {
    const csv = moveInOutLogsToCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `登録ログ_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const th = 'border border-slate-200 bg-slate-100 px-2 py-2 text-left text-[10px] font-black text-slate-800 sm:text-xs';
  const td = 'border border-slate-100 px-2 py-1.5 text-[10px] font-bold text-slate-800 sm:text-xs';

  const pastMonthMissingRoster =
    Boolean(
      String(SHEETS_KEY ?? '').trim() &&
        !loading &&
        !payload?.facilities?.length &&
        statsViewMonth !== ymNow() &&
        !getFacilityStatsSnapshot(statsViewMonth)
    );

  return (
    <div className="min-h-screen bg-slate-50 pb-24 font-sans">
      <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"
            aria-label="戻る"
          >
            <ChevronLeft size={22} />
          </button>
          <div className="flex items-center gap-2">
            <Table2 className="h-6 w-6 text-indigo-600" aria-hidden />
            <div>
              <h1 className="text-base font-black text-slate-900 sm:text-lg">施設別 入居・介護度・性別 一括集計</h1>
              <p className="text-[10px] font-bold text-slate-500 sm:text-xs">
                下のフォームで<strong>入居・退去・入院</strong>を登録できます（この端末に保存）。Google 名簿は API
                キーがあるとき取得します（在籍・定員ベースの在籍率に利用）。
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading || !String(SHEETS_KEY ?? '').trim()}
            onClick={() => void fetchAndSaveForViewMonth()}
            className="inline-flex items-center gap-1 rounded-xl border-2 border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-800 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            再取得
          </button>
          <button
            type="button"
            disabled={!payload?.facilities?.length}
            onClick={downloadCsv}
            className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-black text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            名簿CSV
          </button>
          <button
            type="button"
            onClick={downloadMoveLogCsv}
            className="inline-flex items-center gap-1 rounded-xl border-2 border-emerald-500 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-900 hover:bg-emerald-100"
          >
            <Download className="h-4 w-4" />
            登録ログCSV
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-6 p-4">
        <section className="rounded-2xl border-2 border-emerald-300 bg-gradient-to-br from-emerald-50/90 to-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-1 text-sm font-black text-emerald-950 sm:text-base">入居・退去・入院の登録（このサイト）</h2>
          <p className="mb-4 text-[10px] font-bold leading-relaxed text-emerald-900/90 sm:text-xs">
            発生日・施設・入居・退去・<strong>入院</strong>
            を記録します。<strong>退去</strong>のときは「入院して退去／死亡退去／他施設へ移動」から必ず選びます。性別は任意。データはこのブラウザに保存され、名簿とは自動連携しません（CSV
            でバックアップ可能）。
          </p>
          <form
            onSubmit={submitMoveLog}
            className="mb-6 flex flex-col gap-3 rounded-xl border border-emerald-200 bg-white/90 p-3 sm:flex-row sm:flex-wrap sm:items-end"
          >
            <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-[10px] font-black text-slate-700 sm:text-xs">
              施設
              <select
                value={formFacility}
                onChange={(e) => setFormFacility(e.target.value)}
                className="rounded-lg border-2 border-slate-200 px-2 py-2 text-sm font-bold text-slate-900"
              >
                {CARELINK_FACILITIES.map((f) => (
                  <option key={f.linkKey} value={f.linkKey}>
                    {f.tabLabel}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1 text-[10px] font-black text-slate-700 sm:text-xs">
              区分
              <div className="flex gap-2">
                <label className="inline-flex items-center gap-1.5 rounded-lg border-2 border-slate-200 bg-white px-3 py-2 text-xs font-black">
                  <input
                    type="radio"
                    name="mkind"
                    checked={formKind === 'move_in'}
                    onChange={() => {
                      setFormKind('move_in');
                      setFormMoveOutReason('');
                    }}
                  />
                  入居
                </label>
                <label className="inline-flex items-center gap-1.5 rounded-lg border-2 border-slate-200 bg-white px-3 py-2 text-xs font-black">
                  <input
                    type="radio"
                    name="mkind"
                    checked={formKind === 'move_out'}
                    onChange={() => setFormKind('move_out')}
                  />
                  退去
                </label>
                <label className="inline-flex items-center gap-1.5 rounded-lg border-2 border-slate-200 bg-white px-3 py-2 text-xs font-black">
                  <input
                    type="radio"
                    name="mkind"
                    checked={formKind === 'hospital'}
                    onChange={() => {
                      setFormKind('hospital');
                      setFormMoveOutReason('');
                    }}
                  />
                  入院
                </label>
              </div>
            </div>
            {formKind === 'move_out' ? (
              <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-[10px] font-black text-slate-700 sm:text-xs">
                退去の種類
                <select
                  value={formMoveOutReason}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFormMoveOutReason(
                      v === 'after_hospital' || v === 'death' || v === 'transfer_facility' ? v : ''
                    );
                  }}
                  className="rounded-lg border-2 border-slate-200 px-2 py-2 text-sm font-bold text-slate-900"
                  required
                >
                  <option value="">選んでください</option>
                  <option value="after_hospital">入院して退去</option>
                  <option value="death">死亡退去</option>
                  <option value="transfer_facility">他施設へ移動</option>
                </select>
              </label>
            ) : null}
            <label className="flex min-w-[9rem] flex-col gap-1 text-[10px] font-black text-slate-700 sm:text-xs">
              発生日
              <input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                className="rounded-lg border-2 border-slate-200 px-2 py-2 text-sm font-bold"
                required
              />
            </label>
            <label className="flex min-w-[8rem] flex-1 flex-col gap-1 text-[10px] font-black text-slate-700 sm:text-xs">
              利用者名（任意）
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="山田 花子"
                className="rounded-lg border-2 border-slate-200 px-2 py-2 text-sm font-bold"
                autoComplete="off"
              />
            </label>
            <label className="flex min-w-[6.5rem] flex-col gap-1 text-[10px] font-black text-slate-700 sm:text-xs">
              性別（任意）
              <select
                value={formGender}
                onChange={(e) => {
                  const v = e.target.value;
                  setFormGender(v === 'male' ? 'male' : v === 'female' ? 'female' : '');
                }}
                className="rounded-lg border-2 border-slate-200 px-2 py-2 text-sm font-bold text-slate-900"
              >
                <option value="">指定なし</option>
                <option value="male">男性</option>
                <option value="female">女性</option>
              </select>
            </label>
            <label className="flex min-w-[12rem] flex-[2] flex-col gap-1 text-[10px] font-black text-slate-700 sm:text-xs">
              メモ（任意）
              <input
                type="text"
                value={formNote}
                onChange={(e) => setFormNote(e.target.value)}
                placeholder="居室・経路など"
                className="rounded-lg border-2 border-slate-200 px-2 py-2 text-sm font-bold"
              />
            </label>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white shadow-sm hover:bg-emerald-500"
            >
              <Plus className="h-4 w-4" />
              登録
            </button>
          </form>

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[10px] font-black text-slate-700 sm:text-xs">
              表示月（名簿スナップショット＋登録ログ）
              <input
                type="month"
                value={statsViewMonth}
                onChange={(e) => setStatsViewMonth(e.target.value)}
                className="rounded-lg border-2 border-slate-200 px-2 py-1.5 text-sm font-bold"
              />
            </label>
            <span className="max-w-xl text-[10px] font-bold leading-relaxed text-slate-500">
              名簿の一括表は<strong>この月として保存したデータ</strong>を表示します（先月の在籍・何床かは、月末頃に表示月をその月にして
              <strong>再取得</strong>すると保存されます。Google から過去月を直接は取れません）。登録の入居・退去・入院も同じ月で絞り込みます。
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-emerald-200 bg-white/80">
            <table className="w-full min-w-[720px] border-collapse text-xs">
              <thead>
                <tr className="bg-emerald-100/80">
                  <th className="border border-emerald-200 px-2 py-2 text-left font-black text-emerald-950">発生日</th>
                  <th className="border border-emerald-200 px-2 py-2 text-left font-black text-emerald-950">施設</th>
                  <th className="border border-emerald-200 px-2 py-2 text-left font-black text-emerald-950">区分</th>
                  <th className="border border-emerald-200 px-2 py-2 text-left font-black text-emerald-950">退去種別</th>
                  <th className="border border-emerald-200 px-2 py-2 text-left font-black text-emerald-950">利用者名</th>
                  <th className="border border-emerald-200 px-2 py-2 text-left font-black text-emerald-950">性別</th>
                  <th className="border border-emerald-200 px-2 py-2 text-left font-black text-emerald-950">メモ</th>
                  <th className="border border-emerald-200 px-2 py-2 text-center font-black text-emerald-950">操作</th>
                </tr>
              </thead>
              <tbody>
                {recentLogs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="border border-emerald-100 px-3 py-6 text-center font-bold text-slate-500">
                      この月の登録はまだありません。
                    </td>
                  </tr>
                ) : (
                  recentLogs.map((row) => (
                    <tr key={row.id} className="hover:bg-emerald-50/50">
                      <td className="border border-emerald-100 px-2 py-1.5 font-bold text-slate-800">{row.eventDate}</td>
                      <td className="border border-emerald-100 px-2 py-1.5 font-bold text-slate-800">{row.tabLabel}</td>
                      <td className="border border-emerald-100 px-2 py-1.5 font-bold text-slate-800">
                        {logKindLabel(row.kind)}
                      </td>
                      <td className="border border-emerald-100 px-2 py-1.5 text-[11px] font-bold text-slate-800">
                        {row.kind === 'move_out' ? moveOutReasonLabel(row.moveOutReason) : '—'}
                      </td>
                      <td className="border border-emerald-100 px-2 py-1.5 font-bold text-slate-800">
                        {row.residentName || '—'}
                      </td>
                      <td className="border border-emerald-100 px-2 py-1.5 font-bold text-slate-800">
                        {logGenderLabel(row.gender)}
                      </td>
                      <td className="border border-emerald-100 px-2 py-1.5 text-[11px] font-bold text-slate-600">
                        {row.note || '—'}
                      </td>
                      <td className="border border-emerald-100 px-1 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm('この行を削除しますか？')) return;
                            removeMoveInOutLog(row.id);
                            setLogRev((x) => x + 1);
                          }}
                          className="inline-flex items-center gap-0.5 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] font-black text-rose-800 hover:bg-rose-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          削除
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {!SHEETS_KEY?.trim() ? (
          <p className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-950">
            <code className="rounded bg-white px-1">VITE_GOOGLE_SHEETS_API_KEY</code>{' '}
            が無いため、下の<strong> Google 名簿</strong>の表は取得できません。上の登録と「施設別（サイト登録のみ）」表は利用できます（在籍率は名簿未取得のため「—」）。
          </p>
        ) : null}

        {pastMonthMissingRoster ? (
          <p className="rounded-2xl border-2 border-sky-300 bg-sky-50 px-4 py-3 text-sm font-bold leading-relaxed text-sky-950">
            <strong>{statsViewMonth}</strong> の名簿スナップショットは、このブラウザにまだありません。先月の在籍・床数をあとから見るには、
            <strong>当月末などに「表示月」をその月に合わせてから「再取得」</strong>
            を押し、取得結果をこの端末に保存してください（Google スプレッドシートの API では過去月の名簿を直接は取れません）。
          </p>
        ) : null}

        {!loading && !payload?.facilities?.length ? (
          <section className="overflow-x-auto rounded-2xl border-2 border-emerald-200 bg-white p-4 shadow-sm">
            <h2 className="mb-2 text-sm font-black text-slate-800">
              施設別（対象月 {statsViewMonth}・サイト登録のみ）
            </h2>
            <p className="mb-3 text-[10px] font-bold text-slate-500 sm:text-xs">
              名簿を取得できると、下の「一括集計」表で<strong>定員・在籍率・月次比率</strong>を施設ごとに表示できます。
            </p>
            <table className="w-full min-w-[520px] border-collapse text-xs">
              <thead>
                <tr>
                  <th className={th}>施設</th>
                  <th className={th}>定員</th>
                  <th className={th}>在籍率</th>
                  <th className={th}>登録入院</th>
                  <th className={th}>登録入居</th>
                  <th className={th}>登録退去</th>
                </tr>
              </thead>
              <tbody>
                {registrationOnlyRows.map((r) => (
                  <tr key={r.linkKey} className="hover:bg-slate-50/80">
                    <td className={td}>{r.tabLabel}</td>
                    <td className={td}>
                      {licensedBedsForLinkKey(r.linkKey) ?? '—'}
                    </td>
                    <td className={td}>—</td>
                    <td className={td}>{r.hospital}</td>
                    <td className={td}>{r.moveIn}</td>
                    <td className={td}>{r.moveOut}</td>
                  </tr>
                ))}
                <tr className="bg-indigo-50 font-black">
                  <td className={td}>合計</td>
                  <td className={td}>{totalLicensedBedsConfigured > 0 ? totalLicensedBedsConfigured : '—'}</td>
                  <td className={td}>—</td>
                  <td className={td}>{appGrand.hospital}</td>
                  <td className={td}>{appGrand.moveIn}</td>
                  <td className={td}>{appGrand.moveOut}</td>
                </tr>
              </tbody>
            </table>
          </section>
        ) : null}

        {err ? (
          <p className="rounded-2xl border-2 border-rose-300 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-900">{err}</p>
        ) : null}

        {loading && !payload ? (
          <p className="flex items-center gap-2 text-sm font-bold text-slate-600">
            <Loader2 className="h-5 w-5 animate-spin" /> 全施設タブを読み込み中…
          </p>
        ) : null}

        {payload?.fetchedAt ? (
          <p className="text-xs font-bold text-slate-500">
            名簿表示月: <strong className="text-slate-800">{payload.viewMonth ?? statsViewMonth}</strong> ／ 保存・取得:{' '}
            {payload.fetchedAt.replace('T', ' ').slice(0, 19)}
            {payload.viewMonth && payload.viewMonth !== ymNow() ? (
              <span className="ml-1 text-sky-800">（保存済みスナップショット）</span>
            ) : null}
          </p>
        ) : null}

        {byBusiness.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-black text-slate-800">事業ブロック別サマリー</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {byBusiness.map(([groupName, facs]) => {
                const t = sumStats(facs);
                return (
                  <div
                    key={groupName}
                    className="rounded-2xl border-2 border-indigo-200 bg-gradient-to-br from-white to-indigo-50/50 p-4 shadow-sm"
                  >
                    <h3 className="mb-2 text-base font-black text-indigo-950">{groupName}</h3>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs font-bold text-slate-700">
                      <dt>在籍</dt>
                      <dd className="text-right">{t.active} 名</dd>
                      <dt>非在籍行</dt>
                      <dd className="text-right">{t.inactiveTotal} 件</dd>
                      <dt>男 / 女</dt>
                      <dd className="text-right">
                        {t.male} / {t.female}
                      </dd>
                      <dt>要介護1〜5</dt>
                      <dd className="text-right">
                        {t.careNeed1 + t.careNeed2 + t.careNeed3 + t.careNeed4 + t.careNeed5} 名
                      </dd>
                    </dl>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {grand ? (
          <section className="rounded-2xl border-2 border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-2 text-sm font-black text-slate-800">全施設合計</h2>
            <p className="text-xs font-bold text-slate-600">
              在籍合計 <strong className="text-slate-900">{grand.active}</strong> 名 ／ 名簿データ行{' '}
              <strong>{grand.dataRows}</strong> ／ 非在籍行 <strong>{grand.inactiveTotal}</strong> ／ 男性{' '}
              <strong>{grand.male}</strong> ・ 女性 <strong>{grand.female}</strong> ・ 性別不明{' '}
              <strong>{grand.genderUnknown}</strong>
            </p>
            <p className="mt-2 text-xs font-bold text-emerald-900">
              対象月 <strong>{statsViewMonth}</strong> のサイト登録: 入居 <strong>{appGrand.moveIn}</strong> 件 ／ 入院{' '}
              <strong>{appGrand.hospital}</strong> 件 ／ 退去 <strong>{appGrand.moveOut}</strong> 件 ／ 月次比率（登録入居÷在籍）{' '}
              <strong>{formatMoveInRate(appGrand.moveIn, grand.active)}</strong>
              {licensedGrand.bedsSum > 0 ? (
                <>
                  {' '}
                  ／ 定員合計（設定） <strong>{licensedGrand.bedsSum}</strong> 床 ／ 在籍率（対定員）{' '}
                  <strong>{formatMoveInRate(licensedGrand.activeSum, licensedGrand.bedsSum)}</strong>
                </>
              ) : null}
            </p>
          </section>
        ) : null}

        {payload?.facilities?.length ? (
          <section className="overflow-x-auto rounded-2xl border-2 border-slate-200 bg-white shadow-sm">
            <h2 className="border-b border-slate-100 px-3 py-2 text-sm font-black text-slate-800">
              名簿一括集計（<span className="text-indigo-700">{payload.viewMonth ?? statsViewMonth}</span> 時点の保存データ）
            </h2>
            <table className="min-w-[1420px] w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>事業</th>
                  <th className={th}>施設</th>
                  <th className={th}>定員</th>
                  <th className={th}>在籍率</th>
                  <th className={th}>月次比率</th>
                  <th className={th}>登録入院</th>
                  <th className={th}>登録入居</th>
                  <th className={th}>登録退去</th>
                  <th className={th}>行数</th>
                  <th className={th}>在籍</th>
                  <th className={th}>介1</th>
                  <th className={th}>介2</th>
                  <th className={th}>介3</th>
                  <th className={th}>介4</th>
                  <th className={th}>介5</th>
                  <th className={th}>支1</th>
                  <th className={th}>支2</th>
                  <th className={th}>男</th>
                  <th className={th}>女</th>
                  <th className={th}>非在籍</th>
                  <th className={th}>入院</th>
                  <th className={th}>退院</th>
                  <th className={th}>退去等</th>
                  <th className={th}>入居予定等</th>
                </tr>
              </thead>
              <tbody>
                {payload.facilities.map((s) => (
                  <tr key={s.sheetTitle} className="hover:bg-slate-50/80">
                    <td className={td}>{BUSINESS_GROUP[s.linkKey] ?? '—'}</td>
                    <td className={td}>{s.tabLabel}</td>
                    <td className={td}>{licensedBedsForLinkKey(s.linkKey) ?? '—'}</td>
                    <td className={td}>{formatMoveInRate(s.active, licensedBedsForLinkKey(s.linkKey) ?? 0)}</td>
                    <td className={td}>
                      {formatMoveInRate(appByKey.get(s.linkKey)?.moveIn ?? 0, s.active)}
                    </td>
                    <td className={td}>{appByKey.get(s.linkKey)?.hospital ?? 0}</td>
                    <td className={td}>{appByKey.get(s.linkKey)?.moveIn ?? 0}</td>
                    <td className={td}>{appByKey.get(s.linkKey)?.moveOut ?? 0}</td>
                    <td className={td}>{s.dataRows}</td>
                    <td className={td}>{s.active}</td>
                    <td className={td}>{s.careNeed1}</td>
                    <td className={td}>{s.careNeed2}</td>
                    <td className={td}>{s.careNeed3}</td>
                    <td className={td}>{s.careNeed4}</td>
                    <td className={td}>{s.careNeed5}</td>
                    <td className={td}>{s.careSupport1}</td>
                    <td className={td}>{s.careSupport2}</td>
                    <td className={td}>{s.male}</td>
                    <td className={td}>{s.female}</td>
                    <td className={td}>{s.inactiveTotal}</td>
                    <td className={td}>{s.statusHospital}</td>
                    <td className={td}>{s.statusDischargeHospital}</td>
                    <td className={td}>{s.statusMoveOut}</td>
                    <td className={td}>{s.statusMoveInPipeline}</td>
                  </tr>
                ))}
                {grand ? (
                  <tr className="bg-indigo-50 font-black">
                    <td className={td} colSpan={2}>
                      合計
                    </td>
                    <td className={td}>{licensedGrand.bedsSum > 0 ? licensedGrand.bedsSum : '—'}</td>
                    <td className={td}>
                      {licensedGrand.bedsSum > 0
                        ? formatMoveInRate(licensedGrand.activeSum, licensedGrand.bedsSum)
                        : '—'}
                    </td>
                    <td className={td}>{formatMoveInRate(appGrand.moveIn, grand.active)}</td>
                    <td className={td}>{appGrand.hospital}</td>
                    <td className={td}>{appGrand.moveIn}</td>
                    <td className={td}>{appGrand.moveOut}</td>
                    <td className={td}>{grand.dataRows}</td>
                    <td className={td}>{grand.active}</td>
                    <td className={td}>{grand.careNeed1}</td>
                    <td className={td}>{grand.careNeed2}</td>
                    <td className={td}>{grand.careNeed3}</td>
                    <td className={td}>{grand.careNeed4}</td>
                    <td className={td}>{grand.careNeed5}</td>
                    <td className={td}>{grand.careSupport1}</td>
                    <td className={td}>{grand.careSupport2}</td>
                    <td className={td}>{grand.male}</td>
                    <td className={td}>{grand.female}</td>
                    <td className={td}>{grand.inactiveTotal}</td>
                    <td className={td}>{grand.statusHospital}</td>
                    <td className={td}>{grand.statusDischargeHospital}</td>
                    <td className={td}>{grand.statusMoveOut}</td>
                    <td className={td}>{grand.statusMoveInPipeline}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <p className="border-t border-slate-100 px-3 py-2 text-[10px] font-bold leading-relaxed text-slate-500">
              ※<strong>定員</strong>は満床時の床数（設定）。<strong>在籍率</strong>は「名簿の在籍 ÷ 定員」。<strong>月次比率</strong>は「表示月の登録入居 ÷ 在籍」です。
              名簿の数値は<strong>上の「表示月」で選んだ月に再取得したとき</strong>のコピーです。<strong>登録入院／登録入居／登録退去</strong>は同じ表示月のフォーム件数。右の<strong>入院・退院・退去等</strong>は名簿<strong>状況</strong>列の推定で、登録入院とは別です。中村は定員未設定です。要介護・性別は在籍行のみカウントです。
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
