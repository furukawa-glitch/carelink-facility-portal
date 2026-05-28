import React, { useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Brain,
  Briefcase,
  ExternalLink,
  Loader2,
  RefreshCw,
  Scale,
  Users,
} from 'lucide-react';
import { CARELINK_FACILITIES } from '../config/carelinkFacilities.js';
import {
  buildRecruitmentJumpUrl,
  getRecruitmentStatusFacilities,
  RECRUITMENT_ROLE_OPTIONS,
  recruitmentRowKey,
} from '../config/recruitmentLinks.js';
import * as Mgmt from '../services/ManagementSheetService.js';

const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY ?? '';

/** @param {string} role */
function defaultHourlyForRole(role) {
  if (role === '看護職') return '1450';
  if (role === '一般職') return '1070';
  return '1100';
}

function initShortfalls() {
  const rows = [];
  for (const f of getRecruitmentStatusFacilities()) {
    for (const role of RECRUITMENT_ROLE_OPTIONS) {
      rows.push([recruitmentRowKey(f.linkKey, role), '0']);
    }
  }
  return Object.fromEntries(rows);
}

function initJobForm() {
  const rows = [];
  for (const f of getRecruitmentStatusFacilities()) {
    for (const role of RECRUITMENT_ROLE_OPTIONS) {
      rows.push([recruitmentRowKey(f.linkKey, role), { hourly: defaultHourlyForRole(role) }]);
    }
  }
  return Object.fromEntries(rows);
}

/**
 * @param {{ onBack: () => void }} props
 */
export function SettingsPage({ onBack }) {
  const [targetPct, setTargetPct] = useState(String(Mgmt.DEFAULT_TARGET_LABOR_RATIO_PCT));
  const [shortfalls, setShortfalls] = useState(initShortfalls);
  const [jobForm, setJobForm] = useState(initJobForm);
  const [parsed, setParsed] = useState(/** @type {ReturnType<typeof Mgmt.parseManagementRows> | null} */ (null));
  const [sheetTitle, setSheetTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const targetNum = useMemo(() => {
    const n = parseFloat(String(targetPct).replace(',', '.'));
    return Number.isFinite(n) ? n : Mgmt.DEFAULT_TARGET_LABOR_RATIO_PCT;
  }, [targetPct]);

  const loadSheet = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const { parsed: p, sheetTitle: st } = await Mgmt.fetchManagementSheetData();
      setParsed(p);
      setSheetTitle(st);
    } catch (e) {
      setParsed(null);
      setErr(e instanceof Error ? e.message : '読み込み失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  const runAi = useCallback(async () => {
    if (!parsed) {
      setErr('先に経営シートを読み込んでください');
      return;
    }
    setAiBusy(true);
    setAiText('');
    try {
      const t = await Mgmt.askAiRecruitmentJudgment(GEMINI_KEY, {
        targetPct: targetNum,
        parsed,
        shortfalls: shortfallsForAi,
      });
      setAiText(t);
    } catch (e) {
      setAiText(e instanceof Error ? e.message : 'AI エラー');
    } finally {
      setAiBusy(false);
    }
  }, [parsed, targetNum, shortfallsForAi]);

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-900">
      <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-xl p-2 hover:bg-slate-100"
            aria-label="戻る"
          >
            <ArrowLeft className="h-6 w-6 text-slate-500" />
          </button>
          <div>
            <h1 className="text-xl font-black tracking-tight">設定・採用司令塔</h1>
            <p className="text-xs font-bold text-slate-500">経営シート連動 / AirWORK・タイミー</p>
          </div>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadSheet()}
          className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          経営データ読込
        </button>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 p-4 pb-16">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-slate-800">
            <Scale className="h-6 w-6 text-amber-600" />
            <h2 className="text-lg font-black">経営ゲート（人件費率）</h2>
          </div>
          <p className="mb-4 text-sm text-slate-600">
            売上・人件費の数値を参照します。ブック ID は{' '}
            <code className="rounded bg-slate-100 px-1">VITE_MANAGEMENT_SPREADSHEET_ID</code> を優先し、未設定なら{' '}
            <code className="rounded bg-slate-100 px-1">VITE_DEPARTMENT_SALES_SHEET_ID</code>（既定は部署別売上と同じ）を使います。先頭タブ以外を読む場合は{' '}
            <code className="rounded bg-slate-100 px-1">VITE_MANAGEMENT_SHEET_GID</code>（数値）を指定してください。
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <label className="block">
              <span className="text-xs font-bold text-slate-500">目標人件費率（%）</span>
              <input
                type="number"
                value={targetPct}
                onChange={(e) => setTargetPct(e.target.value)}
                className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 font-bold"
              />
            </label>
            {sheetTitle && (
              <span className="text-xs font-bold text-emerald-700">
                読込タブ: {sheetTitle}
              </span>
            )}
          </div>
          {err && (
            <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{err}</p>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Users className="h-6 w-6 text-blue-600" />
            <h2 className="text-lg font-black text-slate-800">採用ステータス</h2>
          </div>
          <p className="mb-3 text-xs font-bold text-slate-500">
            対象拠点: 愛西・北名古屋・千音寺・ナーシングホーム青空起・ナーシングホーム青空 ／ 職種: 介護職・看護職・一般職（職種ごとに不足人数・時給・求人リンク）
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-black uppercase text-slate-500">
                  <th className="py-2 pr-3">施設</th>
                  <th className="py-2 pr-3">職種</th>
                  <th className="py-2 pr-3">不足人数</th>
                  <th className="py-2 pr-3">人件費率</th>
                  <th className="py-2 pr-3">求人ゲート</th>
                  <th className="py-2 pr-3">時給目安</th>
                  <th className="py-2">外部求人</th>
                </tr>
              </thead>
              <tbody>
                {getRecruitmentStatusFacilities().flatMap((f) => {
                  const ev = parsed
                    ? Mgmt.evaluateFacilityRecruitment(parsed, f.linkKey, targetNum)
                    : { allowed: false, ratioPct: null, reason: '未読込' };
                  return RECRUITMENT_ROLE_OPTIONS.map((role) => {
                    const rk = recruitmentRowKey(f.linkKey, role);
                    const sf = shortfalls[rk] ?? '0';
                    const jf = jobForm[rk] ?? { hourly: defaultHourlyForRole(role) };
                    const air = buildRecruitmentJumpUrl('airwork', f.linkKey, {
                      role,
                      hourly: jf.hourly,
                      headcount: sf,
                    });
                    const timy = buildRecruitmentJumpUrl('timy', f.linkKey, {
                      role,
                      hourly: jf.hourly,
                      headcount: sf,
                    });
                    return (
                      <tr key={rk} className="border-b border-slate-100">
                        <td className="py-3 pr-3 font-bold">{f.tabLabel}</td>
                        <td className="py-3 pr-3 font-bold text-slate-800">{role}</td>
                        <td className="py-3 pr-3">
                          <input
                            type="number"
                            min={0}
                            value={sf}
                            onChange={(e) =>
                              setShortfalls((prev) => ({ ...prev, [rk]: e.target.value }))
                            }
                            className="w-20 rounded-lg border border-slate-200 px-2 py-1 font-bold"
                          />
                        </td>
                        <td className="py-3 pr-3 font-mono text-xs">
                          {ev.ratioPct != null ? `${ev.ratioPct.toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-3 pr-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-black ${
                              ev.allowed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {ev.allowed ? '掲載可' : '停止'}
                          </span>
                        </td>
                        <td className="py-3 pr-3">
                          <input
                            value={jf.hourly}
                            onChange={(e) =>
                              setJobForm((prev) => ({
                                ...prev,
                                [rk]: { ...jf, hourly: e.target.value },
                              }))
                            }
                            className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-3">
                          <div className="flex flex-wrap gap-1">
                            <a
                              href={ev.allowed ? air : undefined}
                              onClick={(e) => !ev.allowed && e.preventDefault()}
                              className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${
                                ev.allowed
                                  ? 'bg-violet-600 text-white hover:bg-violet-500'
                                  : 'cursor-not-allowed bg-slate-200 text-slate-400'
                              }`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              AirWORK <ExternalLink className="h-3 w-3" />
                            </a>
                            <a
                              href={ev.allowed ? timy : undefined}
                              onClick={(e) => !ev.allowed && e.preventDefault()}
                              className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${
                                ev.allowed
                                  ? 'bg-sky-600 text-white hover:bg-sky-500'
                                  : 'cursor-not-allowed bg-slate-200 text-slate-400'
                              }`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              タイミー <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50/80 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Brain className="h-5 w-5 text-indigo-600" />
              <span className="font-black text-indigo-900">AI 経営判断（AirWORK 掲載の可否）</span>
            </div>
            <button
              type="button"
              disabled={aiBusy || !parsed}
              onClick={() => void runAi()}
              className="w-fit rounded-xl bg-indigo-600 px-5 py-3 text-sm font-black text-white disabled:opacity-50"
            >
              {aiBusy ? <Loader2 className="inline h-4 w-4 animate-spin" /> : <Briefcase className="inline h-4 w-4" />}{' '}
              今、AirWORK に求人を出して良いか診断
            </button>
            {aiText && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-sm font-normal text-slate-800 shadow-inner">
                {aiText}
              </pre>
            )}
            {!GEMINI_KEY && (
              <p className="text-xs text-amber-800">
                VITE_GEMINI_API_KEY があると AI 診断が利用できます。
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
