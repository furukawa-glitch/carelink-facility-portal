import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Report from './services/ReportService.js';
import { countPendingAllFacilities, getStaffProfile } from './services/NearMissLedgerService.js';
import {
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Thermometer,
  Droplets,
  Heart,
  Utensils,
  Activity,
  CupSoda,
  Pill,
  Eye,
  ShieldAlert,
  Brain,
  History,
  Download,
  Wind,
  Megaphone,
  Scale,
  CheckSquare,
  Square,
  Check,
  Moon,
  Sun,
  RefreshCw,
  Baby,
  Image,
  Settings,
  Loader2,
  Search,
  CalendarDays,
  UserCircle2,
  ClipboardList,
  FileSpreadsheet,
  FileText,
  Stethoscope,
  Lock,
} from 'lucide-react';
import { VoiceCareInput } from './components/VoiceCareInput.jsx';
import { ResidentAdministrativeModals } from './components/ResidentAdministrativeModals.jsx';
import { RecordPage } from './pages/RecordPage.jsx';
import { NotionNewResidentsPage } from './pages/NotionNewResidentsPage.jsx';
import { SettingsPage } from './pages/SettingsPage.jsx';
import { ShiftSchedulePage } from './pages/ShiftSchedulePage.jsx';
import { FacilityStatsPage } from './pages/FacilityStatsPage.jsx';
import { CARELINK_FACILITIES } from './config/carelinkFacilities.js';
import { fetchResidentsFromSheet } from './services/GoogleSheetService.js';
import { vitalStateFromSaved, careStateFromTodayEvents } from './lib/residentDetailSeed.js';
import { WATER_ML_50_OPTIONS } from './lib/careQuickCareFields.js';
import { WeeklyFlowSheet } from './components/WeeklyFlowSheet.jsx';

/** 施設向けの画面ロック。未設定のときはロックなし。設定時は全画面の前にパスワード必須。 */
const VITE_FACILITY_PORTAL_PASSWORD = String(
  import.meta.env.VITE_FACILITY_PORTAL_PASSWORD ?? '',
).trim();
const PORTAL_RELOCK_AFTER_HIDDEN_MS = 90_000;

const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY ?? '';

function localYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function localDateTimeToIso(ymd, hm) {
  const y = String(ymd ?? '').trim();
  const h = String(hm ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(y) || !/^\d{2}:\d{2}$/.test(h)) return '';
  const d = new Date(`${y}T${h}:00`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

/**
 * @param {{ onBack: () => void; residents: Record<string, unknown>[]; apiKey: string }} props
 */
function MonthlyReportManager({ onBack, residents, apiKey }) {
  const [reportMonth, setReportMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [draftMap, setDraftMap] = useState(
    /** @type {Record<string, { monthlyCondition: string; futureCarePoints: string; directorMessage: string }>} */ ({})
  );
  /** 月次HTML用：利用者×月 ごとの施設写真（data URL、端末上のみ・HTMLに埋め込み） */
  const [monthlyReportPhotos, setMonthlyReportPhotos] = useState(/** @type {Record<string, string[]>} */ ({}));
  const [monthlyVisualOpts, setMonthlyVisualOpts] = useState(
    /** @type {Record<string, { facilityLabel: string; seasonArtMode: 'auto'|'none'|'spring'|'summer'|'autumn'|'winter' }>} */ ({})
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState('');

  const draftKey = (id) => `${String(id)}|${reportMonth}`;

  const MAX_MONTHLY_PHOTOS = 4;
  const MAX_MONTHLY_PHOTO_BYTES = 1.5 * 1024 * 1024;

  const onMonthlyPhotosPick = useCallback(
    (residentId, fileList) => {
      if (!fileList || fileList.length === 0) return;
      const k = `${String(residentId)}|${reportMonth}`;
      for (const f of Array.from(fileList)) {
        if (f.size > MAX_MONTHLY_PHOTO_BYTES && f.type?.startsWith('image/')) {
          alert(
            `「${f.name}」は 1.5MB 超のためスキップします。圧縮版の画像を選ぶか、別ツールで縮小してください。`
          );
        }
      }
      const addFiles = Array.from(fileList)
        .filter((f) => f.type && String(f.type).startsWith('image/') && f.size <= MAX_MONTHLY_PHOTO_BYTES);
      if (addFiles.length === 0) return;
      void (async () => {
        const urls = /** @type {string[]} */ ([]);
        for (const file of addFiles) {
          if (urls.length >= MAX_MONTHLY_PHOTOS) break;
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result ?? ''));
            fr.onerror = () => reject(new Error('read'));
            fr.readAsDataURL(file);
          });
          if (String(dataUrl).startsWith('data:image/')) urls.push(dataUrl);
        }
        if (urls.length === 0) return;
        setMonthlyReportPhotos((p) => {
          const cur = p[k] ?? [];
          return { ...p, [k]: [...cur, ...urls].slice(0, MAX_MONTHLY_PHOTOS) };
        });
      })();
    },
    [reportMonth]
  );

  const clearMonthlyPhoto = useCallback((residentId, index) => {
    const k = draftKey(residentId);
    setMonthlyReportPhotos((prev) => {
      const cur = prev[k] ?? [];
      const next = cur.filter((_, i) => i !== index);
      if (next.length === 0) {
        const { [k]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [k]: next };
    });
  }, [reportMonth]);

  const getVisualOpts = useCallback(
    (res) => {
      const k = draftKey(res.id);
      const cur = monthlyVisualOpts[k];
      if (cur) return cur;
      return {
        facilityLabel: String(res.facility ?? res.sourceSheetTitle ?? '').trim(),
        seasonArtMode: /** @type {'auto'} */ ('auto'),
      };
    },
    [monthlyVisualOpts, reportMonth]
  );

  const setVisualField = useCallback(
    (id, field, value) => {
      const k = draftKey(id);
      setMonthlyVisualOpts((prev) => {
        const base = prev[k] ?? {
          facilityLabel: '',
          seasonArtMode: /** @type {'auto'} */ ('auto'),
        };
        return { ...prev, [k]: { ...base, [field]: value } };
      });
    },
    [reportMonth]
  );

  const setDraftField = (id, field, value) => {
    const k = draftKey(id);
    setDraftMap((prev) => {
      const cur = prev[k] ?? {
        monthlyCondition: '',
        futureCarePoints: '',
        directorMessage: '',
      };
      return { ...prev, [k]: { ...cur, [field]: value } };
    });
  };

  const getDraft = (id) => {
    const k = draftKey(id);
    return (
      draftMap[k] ?? {
        monthlyCondition: '',
        futureCarePoints: '',
        directorMessage: '',
      }
    );
  };

  const runAiForResident = async (res) => {
    if (!apiKey?.trim()) {
      alert('VITE_GEMINI_API_KEY を .env に設定し、開発サーバーを再起動してください。');
      return;
    }
    setRowBusyId(String(res.id));
    try {
      const out = await Report.fetchMonthlyResidentFamilyReportAi(apiKey, res, reportMonth);
      const k = draftKey(res.id);
      setDraftMap((prev) => ({ ...prev, [k]: { ...out } }));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'AI生成に失敗しました');
    } finally {
      setRowBusyId('');
    }
  };

  const runBulkAi = async () => {
    if (!apiKey?.trim()) {
      alert('VITE_GEMINI_API_KEY を .env に設定し、開発サーバーを再起動してください。');
      return;
    }
    if (!residents.length) return;
    setBulkBusy(true);
    try {
      for (const res of residents) {
        const out = await Report.fetchMonthlyResidentFamilyReportAi(apiKey, res, reportMonth);
        const k = draftKey(res.id);
        setDraftMap((prev) => ({ ...prev, [k]: { ...out } }));
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'AI一括生成に失敗しました');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-32 font-sans font-bold">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white p-6 font-bold">
        <button type="button" onClick={onBack} className="text-slate-400 font-bold">
          <ChevronLeft size={24} />
        </button>
        <h2 className="text-xl font-bold">月間報告 一括作成</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            対象月
            <input
              type="month"
              value={reportMonth}
              onChange={(e) => setReportMonth(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-bold"
            />
          </label>
          <button
            type="button"
            disabled={bulkBusy || !residents.length}
            onClick={() => void runBulkAi()}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs text-white shadow-lg disabled:opacity-50"
          >
            {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
            AI一括生成
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 p-6 font-bold">
        {!apiKey?.trim() && (
          <p className="rounded-2xl bg-amber-50 px-4 py-3 text-xs font-bold text-amber-900">
            Google AI の API キーを <code className="rounded bg-white px-1">facility-portal/.env</code> に{' '}
            <code className="rounded bg-white px-1">VITE_GEMINI_API_KEY=...</code> として設定すると、1か月の記録から AI
            が文案を作成します。
          </p>
        )}
        <p className="text-xs font-bold text-slate-500">
          参照データはこのブラウザに保存されたクイック記録・巡視・食事・排泄・バイタルログです。記録が少ない月は AI
          も一般論になりやすいので、必ず内容を確認・編集してください。報告書（HTML）は家族・ケアマネ向けの文言と季節の装飾付きです。施設で撮影した写真を足すと、より喜ばれやすくなります（最大4枚・各1.5MB以下。端末上のみ保持し、HTMLに埋め込みます）。
        </p>
        {residents.map((res) => {
          const d = getDraft(res.id);
          const visual = getVisualOpts(res);
          const rowBusy = rowBusyId === String(res.id);
          return (
            <div
              key={res.id}
              className="flex flex-col gap-6 rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm lg:flex-row lg:gap-8"
            >
              <div className="lg:w-1/4">
                <h3 className="text-lg font-bold">{String(res.name)} 様</h3>
                <p className="text-xs text-slate-400">居室 {String(res.room ?? '—')}</p>
                <button
                  type="button"
                  disabled={rowBusy || bulkBusy}
                  onClick={() => void runAiForResident(res)}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-xs text-white disabled:opacity-50"
                >
                  {rowBusy ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
                  この方をAI生成
                </button>
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">この1か月のようす（家族・ケアマネ向け）</span>
                  <textarea
                    value={d.monthlyCondition}
                    onChange={(e) => setDraftField(res.id, 'monthlyCondition', e.target.value)}
                    rows={5}
                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-bold outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">今後一緒に大切にしたいこと</span>
                  <textarea
                    value={d.futureCarePoints}
                    onChange={(e) => setDraftField(res.id, 'futureCarePoints', e.target.value)}
                    rows={4}
                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-bold outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">施設からのひとこと</span>
                  <textarea
                    value={d.directorMessage}
                    onChange={(e) => setDraftField(res.id, 'directorMessage', e.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-bold outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50/40 p-3">
                  <p className="mb-2 text-xs font-bold text-violet-900">見た目（施設名・季節イラスト）</p>
                  <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-bold text-slate-700">報告書に表示する施設名</span>
                      <input
                        value={visual.facilityLabel}
                        onChange={(e) => setVisualField(res.id, 'facilityLabel', e.target.value)}
                        placeholder="例: 北名古屋施設"
                        className="rounded-lg border border-violet-200 bg-white px-2 py-1.5 text-xs font-bold"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-bold text-slate-700">季節イラスト</span>
                      <select
                        value={visual.seasonArtMode}
                        onChange={(e) => setVisualField(res.id, 'seasonArtMode', e.target.value)}
                        className="rounded-lg border border-violet-200 bg-white px-2 py-1.5 text-xs font-bold"
                      >
                        <option value="auto">自動（対象月に合わせる）</option>
                        <option value="spring">春（桜）</option>
                        <option value="summer">夏</option>
                        <option value="autumn">秋</option>
                        <option value="winter">冬</option>
                        <option value="none">なし</option>
                      </select>
                    </label>
                  </div>
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-violet-900">
                    <Image className="h-4 w-4 shrink-0" aria-hidden />
                    施設の写真（任意・HTMLに同梱）
                  </p>
                  <p className="mb-2 text-[11px] font-bold leading-snug text-slate-600">
                    行事・食事会・普段の様子など。個人情報に配慮のうえ、JPG/PNG 最大4枚。ページを再読み込みすると消えます。
                  </p>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="mb-2 block w-full text-xs font-bold file:mr-2 file:rounded-lg file:border-0 file:bg-violet-200 file:px-3 file:py-1.5"
                    onChange={(e) => onMonthlyPhotosPick(res.id, e.target.files)}
                  />
                  {(() => {
                    const pics = monthlyReportPhotos[draftKey(res.id)] ?? [];
                    if (pics.length === 0) return null;
                    return (
                      <div className="flex flex-wrap gap-2">
                        {pics.map((src, i) => (
                          <div key={i} className="group relative h-20 w-20 overflow-hidden rounded-xl border-2 border-white shadow">
                            <img src={src} alt="" className="h-full w-full object-cover" />
                            <button
                              type="button"
                              onClick={() => clearMonthlyPhoto(res.id, i)}
                              className="absolute right-0.5 top-0.5 rounded bg-rose-600/90 px-1.5 py-0.5 text-[9px] font-black text-white opacity-90 hover:opacity-100"
                            >
                              削除
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      const hasPh = (monthlyReportPhotos[draftKey(res.id)] ?? []).length > 0;
                      const txt = [
                        `【${reportMonth} 月次ご報告】`,
                        `${String(res.name)} 様`,
                        `1か月の状態: ${String(d.monthlyCondition || '（未記入）')}`,
                        `今後のケア: ${String(d.futureCarePoints || '（未記入）')}`,
                        `施設から: ${String(d.directorMessage || '（未記入）')}`,
                        hasPh ? '（施設の写真は「報告書作成（HTML）」版に同梱できます）' : '',
                      ]
                        .filter(Boolean)
                        .join('\n');
                      const u = `https://line.me/R/msg/text/?${encodeURIComponent(txt)}`;
                      window.open(u, '_blank', 'noopener,noreferrer');
                    }}
                    className="rounded-xl bg-emerald-500 px-4 py-2 text-xs text-white"
                  >
                    LINE送信
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const html = Report.buildMonthlyFamilyReportHtml(res, reportMonth, d, {
                        photoDataUrls: monthlyReportPhotos[draftKey(res.id)] ?? [],
                        facilityLabel: visual.facilityLabel || String(res.facility ?? res.sourceSheetTitle ?? ''),
                        seasonArtMode: visual.seasonArtMode,
                        photoCaption: '施設での様子',
                      });
                      Report.downloadSummaryHtml(
                        `月次ご報告_${String(res.name).replace(/\s/g, '_')}_${reportMonth}.html`,
                        html
                      );
                    }}
                    className="rounded-xl bg-slate-800 px-4 py-2 text-xs text-white"
                  >
                    報告書作成（HTML）
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {!residents.length && (
          <p className="text-center text-sm text-slate-500">名簿がまだありません。一覧から戻って同期してください。</p>
        )}
      </main>
    </div>
  );
}

/**
 * 全画面共通の認証。sessionStorage には保持しない（ページ更新で再入力・他者の悪用を抑止）。
 * @param {{ onSuccess: () => void }} props
 */
function PortalAuthScreen({ onSuccess }) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');

  const submit = (e) => {
    e?.preventDefault?.();
    if (draft.trim() === VITE_FACILITY_PORTAL_PASSWORD) {
      setErr('');
      setDraft('');
      onSuccess();
    } else {
      setErr('パスワードが違います。');
    }
  };

  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center bg-slate-50 px-4 py-12 pb-20 font-sans font-bold">
      <div className="mb-8 w-full max-w-md text-center">
        <div className="mb-4 inline-block rounded-2xl bg-slate-800 p-4 shadow-lg">
          <Lock size={40} className="text-amber-300" aria-hidden />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-800 sm:text-3xl">介護・看護統合システム</h1>
        <p className="mt-2 text-xs font-bold uppercase tracking-widest text-slate-400">Facility Portal</p>
      </div>
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-3xl border-2 border-slate-200 bg-white p-6 shadow-lg"
      >
        <p className="mb-4 text-left text-sm font-bold text-slate-700">施設用のパスワードを入力してください</p>
        <label className="block text-left">
          <span className="mb-1.5 block text-xs font-black text-slate-600">パスワード</span>
          <input
            type="password"
            name="carelink-portal-password"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (err) setErr('');
            }}
            className="w-full rounded-2xl border-2 border-slate-200 bg-slate-50/80 px-4 py-3.5 text-base font-bold text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            autoComplete="current-password"
            autoFocus
          />
        </label>
        {err ? (
          <p className="mt-2 text-sm font-bold text-rose-600" role="alert">
            {err}
          </p>
        ) : null}
        <button
          type="submit"
          className="mt-5 w-full rounded-2xl bg-blue-600 py-3.5 text-center text-base font-black text-white shadow-md transition hover:bg-blue-500 active:scale-[0.99]"
        >
          続行
        </button>
      </form>
      <p className="mt-6 max-w-md text-center text-xs font-bold leading-relaxed text-slate-500">
        施設の担当者にパスワードを確認してください。ブラウザを更新すると、再度の入力が必要です。
      </p>
    </div>
  );
}

/**
 * App 内で定義すると検索のたびに再マウントされ入力フォーカスが失われるため、トップレベルで定義する。
 * @param {{
 *   portalFacilitySearch: string;
 *   setPortalFacilitySearch: React.Dispatch<React.SetStateAction<string>>;
 *   portalSearchLoading: boolean;
 *   portalFacilitiesFiltered: typeof CARELINK_FACILITIES;
 *   setSelectedPortalSheetTitle: (t: string) => void;
 *   setView: (v: string) => void;
 *   onLockPortal?: (() => void) | undefined;
 * }} props
 */
function FacilityPortalView({
  portalFacilitySearch,
  setPortalFacilitySearch,
  portalSearchLoading,
  portalFacilitiesFiltered,
  setSelectedPortalSheetTitle,
  setView,
  onLockPortal,
}) {
  const staff = getStaffProfile();
  const pending = staff?.staffId ? countPendingAllFacilities(staff.staffId) : 0;
  const searchTrim = portalFacilitySearch.trim();

  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center bg-slate-50 px-4 py-12 pb-16 font-sans font-bold">
      <div className="mb-12 text-center">
        <div className="bg-blue-600 p-4 rounded-2xl inline-block mb-4 shadow-lg">
          <Building2 size={48} className="text-white" />
        </div>
        <h1 className="text-3xl text-slate-800 tracking-tighter font-bold">介護・看護統合システム</h1>
        <p className="text-slate-400 mt-2 font-bold uppercase tracking-widest text-xs">Facility Portal</p>
      </div>
      <div className="mb-6 w-full max-w-4xl rounded-2xl border-2 border-amber-400 bg-gradient-to-r from-amber-50 to-orange-50 px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-amber-950">
          <Megaphone className="h-6 w-6 shrink-0 text-amber-700" />
          <div className="min-w-0 flex-1 text-left">
            <p className="text-sm font-black sm:text-base">ヒヤリハット周知の自動化</p>
            <p className="text-xs font-bold text-amber-900/90">
              施設を選ぶと、未確認の重要周知と「確認しました」記録が使えます。
              {pending > 0 ? (
                <span className="ml-1 font-black text-rose-700">未確認が {pending} 件あります。</span>
              ) : (
                <span className="ml-1 text-amber-800/80">（未確認はありません）</span>
              )}
            </p>
          </div>
        </div>
      </div>
      <div className="mb-4 w-full max-w-4xl">
        <label className="block text-left">
          <span className="mb-1.5 flex items-center gap-2 text-xs font-black text-slate-600">
            <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            事業所名・利用者名で検索（施設 {CARELINK_FACILITIES.length} 件）
          </span>
          <input
            type="text"
            inputMode="search"
            value={portalFacilitySearch}
            onChange={(e) => setPortalFacilitySearch(e.target.value)}
            placeholder="例: 中川、青空、または利用者のお名前…"
            className="w-full rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-bold text-slate-800 shadow-sm outline-none transition placeholder:font-bold placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            lang="ja"
          />
        </label>
        {searchTrim ? (
          <p className="mt-2 text-xs font-bold text-slate-500">
            {portalSearchLoading ? (
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden />
                名簿を照会しています…（利用者名で絞り込み）
              </span>
            ) : portalFacilitiesFiltered.length === 0 ? (
              <span className="text-amber-800">
                該当する施設がありません。事業所名か利用者名を変えてください。
              </span>
            ) : (
              <span>
                {portalFacilitiesFiltered.length} 件を表示（
                <button
                  type="button"
                  className="font-black text-blue-700 underline"
                  onClick={() => setPortalFacilitySearch('')}
                >
                  検索をクリア
                </button>
                ）
              </span>
            )}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-4xl font-bold">
        {portalFacilitiesFiltered.map((f) => (
          <div
            key={f.sheetTitle}
            onClick={() => {
              setSelectedPortalSheetTitle(f.sheetTitle);
              setView('residents_list');
            }}
            className="bg-white p-8 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-xl hover:border-blue-200 transition-all cursor-pointer group"
          >
            <span className="inline-block px-3 py-1 bg-blue-50 text-blue-600 text-[10px] rounded-full mb-4 font-bold">
              施設選択
            </span>
            <h2 className="text-2xl text-slate-800 mb-2 font-bold">{f.tabLabel}</h2>
            <div className="flex items-center gap-2 text-green-500 text-sm font-bold">
              <CheckCircle2 size={16} /> サーバー接続済み
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setView('shift_schedule_staff')}
        className="mt-6 flex w-full max-w-2xl flex-col items-center justify-center gap-1 rounded-[2rem] border-2 border-emerald-200 bg-white px-6 py-5 text-slate-800 shadow-sm transition-all hover:border-emerald-400 hover:shadow-md"
      >
        <div className="flex items-center justify-center gap-3">
          <UserCircle2 size={22} className="shrink-0 text-emerald-600" />
          <span className="text-lg font-bold">勤務希望を入力（現場スタッフ）</span>
        </div>
        <span className="text-center text-xs font-bold text-slate-500">
          勤務体制の登録・全員の勤務表は管理者のみ
        </span>
      </button>
      <button
        type="button"
        onClick={() => setView('shift_schedule')}
        className="mt-6 flex w-full max-w-2xl flex-col items-center justify-center gap-1 rounded-[2rem] border-2 border-teal-200 bg-white px-6 py-5 text-slate-800 shadow-sm transition-all hover:border-teal-400 hover:shadow-md"
      >
        <div className="flex items-center justify-center gap-3">
          <CalendarDays size={22} className="shrink-0 text-teal-600" />
          <span className="text-lg font-bold">勤務表・勤務体制（管理者）</span>
        </div>
        <span className="text-center text-xs font-bold text-slate-500">
          各スタッフの体制を登録し、月次・帳票を作成
        </span>
      </button>
      <button
        type="button"
        onClick={() => setView('facility_stats')}
        className="mt-6 flex w-full max-w-2xl flex-col items-center justify-center gap-1 rounded-[2rem] border-2 border-indigo-200 bg-white px-6 py-5 text-slate-800 shadow-sm transition-all hover:border-indigo-400 hover:shadow-md"
      >
        <div className="flex items-center justify-center gap-3">
          <Building2 size={22} className="shrink-0 text-indigo-600" />
          <span className="text-lg font-bold">施設別 入居・介護度 一括集計</span>
        </div>
        <span className="text-center text-xs font-bold text-slate-500">
          全事業所の在籍・要介護1〜5・男女・入院/退院/退去（状況列ベース）
        </span>
      </button>
      <button
        type="button"
        onClick={() => setView('notion_new_residents')}
        className="mt-6 flex w-full max-w-2xl items-center justify-center gap-3 rounded-[2rem] border-2 border-violet-200 bg-white px-6 py-5 text-slate-800 shadow-sm transition-all hover:border-violet-400 hover:shadow-md"
      >
        <Baby size={22} className="text-violet-600" />
        <span className="text-lg font-bold">新規入居（Notion）</span>
      </button>
      <button
        type="button"
        onClick={() => setView('settings')}
        className="mt-10 flex w-full max-w-2xl items-center justify-center gap-3 rounded-[2rem] border-2 border-indigo-200 bg-white px-6 py-5 text-slate-800 shadow-sm transition-all hover:border-indigo-400 hover:shadow-md"
      >
        <Settings size={22} className="text-indigo-600" />
        <span className="text-lg font-bold">設定・採用司令塔（経営連動）</span>
      </button>
      {onLockPortal ? (
        <button
          type="button"
          onClick={onLockPortal}
          className="mt-4 w-full max-w-2xl rounded-2xl border border-slate-300 bg-white py-2.5 text-center text-xs font-bold text-slate-600 shadow-sm transition hover:border-slate-400 hover:bg-slate-50"
        >
          施設用パスワードの入力を解除（この画面をロック）
        </button>
      ) : null}
    </div>
  );
}

/** 名簿に「様」付きのときの「〇〇様 様」を避ける */
function residentDisplayName(nameRaw) {
  const s = String(nameRaw ?? '')
    .replace(/様\s*$/u, '')
    .trim();
  return s || '—';
}

function NursingDirectivesPanoramaView({
  selectedResident,
  facilityLinkKey,
  nursingList,
  draft,
  setDraft,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  onBack,
  onRegister,
  onRemove,
}) {
  return (
    <div className="min-h-screen bg-slate-50 pb-32 font-sans font-bold">
      <header className="sticky top-0 z-20 border-b border-slate-100 bg-white p-6 font-bold">
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-sm text-blue-600"
          >
            <ChevronLeft size={18} /> 戻る
          </button>
          <h2 className="text-lg font-bold">看護処置・指示</h2>
          <div className="w-10" />
        </div>
        <p className="text-center text-2xl font-bold text-slate-900">
          {residentDisplayName(selectedResident?.name)} <span className="font-bold">様</span>
        </p>
        <p className="mt-2 text-center text-xs leading-snug text-slate-500">
          施設単位で掲示されます（一覧表「本日の重要周知（看護指示）」と同じ保存先）
        </p>
      </header>
      <main className="mx-auto max-w-xl space-y-4 p-6">
        {!facilityLinkKey ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            施設を特定できません。一覧表で事業所を開き、利用者を選び直してください。
          </p>
        ) : (
          <>
            <div className="space-y-3 rounded-[2rem] border border-rose-200 bg-white p-5 shadow-sm">
              {nursingList.length === 0 ? (
                <p className="text-sm font-bold text-rose-700">登録されている処置・指示はありません。</p>
              ) : (
                nursingList.map((d, i) => (
                  <div
                    key={`${String(d.id)}-${i}`}
                    className="flex items-start justify-between gap-2 rounded-xl border-2 border-rose-200 bg-rose-50/80 px-3 py-2.5 text-sm text-rose-950"
                  >
                    <div className="min-w-0">
                      <span className="mr-2 text-xs font-bold text-rose-600">{d.by}</span>
                      {d.text}
                      {d.startDate || d.endDate ? (
                        <div className="mt-1 text-[10px] font-bold text-rose-700">
                          表示: {d.startDate || '—'} 〜 {d.endDate || '未設定'}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemove(d)}
                      className="shrink-0 rounded-lg border border-rose-300 bg-white px-2 py-1 text-xs font-black text-rose-700"
                    >
                      削除
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-3 rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm">
              <label className="block">
                <span className="text-xs font-bold text-slate-600">新規に掲示</span>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="例: 褥瘡ケア／インスリン確認"
                  className="mt-1 w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                />
              </label>
              <div className="flex flex-wrap gap-4">
                <label className="text-xs font-bold text-slate-600">
                  開始
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="mt-1 block rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs font-bold text-slate-600">
                  終了（任意）
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="mt-1 block rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={onRegister}
                className="w-full rounded-2xl bg-rose-600 py-3.5 text-base text-white shadow-md"
              >
                掲示する
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function FacilityHandoverPanoramaView({
  selectedResident,
  facilityTabLabel,
  noticeDraft,
  setNoticeDraft,
  draft,
  setDraft,
  saveStatus,
  onBack,
  onSave,
}) {
  const fac = String(facilityTabLabel ?? '').trim() || '施設';
  const resName = residentDisplayName(selectedResident?.name);
  const room = String(selectedResident?.room ?? '').trim();
  return (
    <div className="min-h-screen bg-slate-50 pb-32 font-sans font-bold">
      <header className="sticky top-0 z-20 border-b border-slate-100 bg-white p-6 font-bold">
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-sm text-blue-600"
          >
            <ChevronLeft size={18} /> 戻る
          </button>
          <h2 className="text-lg font-bold">申し送り（施設共通）</h2>
          <div className="w-10" />
        </div>
        <p className="text-center text-xl font-black text-slate-900">{fac}</p>
        <p className="mt-2 text-center text-xs leading-snug text-slate-500">
          名簿の「申し送り」掲示と同期します（施設単位・このブラウザに保存）。特定の方の内容は本文で氏名・居室が分かるように書いてください。
        </p>
        <div className="mx-auto mt-4 max-w-md rounded-2xl border-2 border-indigo-200 bg-indigo-50/90 p-3 text-left text-xs font-bold leading-snug text-indigo-950">
          <p className="mb-1 text-[11px] font-black text-indigo-900">誰の申し送りか分かるように</p>
          <p>
            この欄は <span className="underline decoration-2">利用者ごとのメモではなく、施設全体の共有掲示</span> です。転倒・家族連絡などは、行の先頭に{' '}
            <span className="whitespace-nowrap rounded bg-white px-1 py-0.5 text-indigo-900 ring-1 ring-indigo-200">氏名（様）・居室</span>{' '}
            を書いてください。
          </p>
          {resName ? (
            <p className="mt-2 border-t border-indigo-200/80 pt-2 text-[11px] font-bold text-indigo-900/90">
              いまメニューから開いている利用者（参考）:{' '}
              <span className="text-indigo-950">{resName} 様</span>
              {room ? <span className="text-indigo-800"> ・ 居室 {room}</span> : null}
            </p>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-xl space-y-4 p-6">
        <div>
          <p className="mb-1 text-sm font-black text-amber-900">本日の周知事項（施設共通）</p>
          <textarea
            value={noticeDraft}
            onChange={(e) => setNoticeDraft(e.target.value)}
            rows={5}
            placeholder="例：感染対策・面会ルール・共通連絡など"
            className="w-full rounded-[1.5rem] border-2 border-amber-200 bg-amber-50/40 p-4 text-sm outline-none focus:ring-2 focus:ring-amber-200"
          />
        </div>
        <div>
          <p className="mb-1 text-sm font-black text-indigo-900">申し送り（施設共通）</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={12}
          placeholder={`例：${resName ? `${resName}様（${room || '居室'}）　` : '山田太郎様（101）　'}19時転倒。頭部打撲。状態注意／夜勤より引き継ぎ…`}
          className="w-full rounded-[2rem] border-2 border-indigo-200 bg-white p-4 text-sm outline-none focus:ring-2 focus:ring-indigo-200"
        />
        </div>
        <button
          type="button"
          onClick={onSave}
          className="w-full rounded-[2rem] bg-indigo-600 py-4 text-lg text-white shadow-xl"
        >
          保存する
        </button>
      </main>
      {saveStatus ? (
        <div className="fixed top-12 left-1/2 z-[100] -translate-x-1/2 rounded-full bg-green-500 px-8 py-3 font-bold text-white shadow-2xl">
          {saveStatus}
        </div>
      ) : null}
    </div>
  );
}

const App = () => {
  const [view, setView] = useState('portal');
  const requirePortalAuth = Boolean(VITE_FACILITY_PORTAL_PASSWORD);
  const [portalAuthUnlocked, setPortalAuthUnlocked] = useState(() => !VITE_FACILITY_PORTAL_PASSWORD);
  const portalAuthUnlockedRef = useRef(portalAuthUnlocked);
  const portalTabHiddenAtRef = useRef(0);
  portalAuthUnlockedRef.current = portalAuthUnlocked;

  const lockPortal = useCallback(() => {
    setPortalAuthUnlocked(false);
    setView('portal');
  }, []);

  const [selectedResident, setSelectedResident] = useState(null);
  const [residentNavList, setResidentNavList] = useState(/** @type {Record<string, unknown>[]} */ ([]));
  const [weeklyFlowOpen, setWeeklyFlowOpen] = useState(false);
  const [residentAdminOverlay, setResidentAdminOverlay] = useState(
    /** @type {null | 'disability' | 'move_log' | 'med' | 'info_provision'} */ (null)
  );
  const [activeDetailTab, setActiveDetailTab] = useState('vital');
  const [activeHistoryTab, setActiveHistoryTab] = useState('day');
  const [activeMealTime, setActiveMealTime] = useState('昼');
  const [saveStatus, setSaveStatus] = useState('');

  const [vitals, setVitals] = useState({
    temp: '36.5',
    spo2: '98',
    pulse: '72',
    bpUpper: '120',
    bpLower: '80',
    weight: '',
  });
  const [todayYmd, setTodayYmd] = useState(() => localYmd());
  const vitalsDayRef = useRef(localYmd());
  const [alertThresholdDraft, setAlertThresholdDraft] = useState({
    tempCMinFever: String(Report.VITAL_THRESHOLDS.tempCMinFever),
    bpSystolicHigh: String(Report.VITAL_THRESHOLDS.bpSystolicHigh),
    bpDiastolicLow: String(Report.VITAL_THRESHOLDS.bpDiastolicLow),
    stoolHoursMax: String(Report.VITAL_THRESHOLDS.stoolHoursMax),
    urineHoursMax: String(Report.VITAL_THRESHOLDS.urineHoursMax),
    patrolIntervalWarnMin: String(Report.VITAL_THRESHOLDS.patrolIntervalWarnMin),
  });
  const [recordDate, setRecordDate] = useState(() => localYmd());
  const [recordTime, setRecordTime] = useState(() => localHm());

  const [mealValue, setMealValue] = useState('10');
  const [isMissedMeal, setIsMissedMeal] = useState(false);
  const [isEnteral, setIsEnteral] = useState(false);
  const [enteralExecuted, setEnteralExecuted] = useState(false);
  const [hydration, setHydration] = useState('150');
  const [hasSupplement, setHasSupplement] = useState(false);
  const [medicationDone, setMedicationDone] = useState(true);

  const [stoolAmount, setStoolAmount] = useState('中等量');
  const [stoolForm, setStoolForm] = useState('普通');
  const [isBalloon, setIsBalloon] = useState(false);
  const [urineMethod, setUrineMethod] = useState('おむつ');
  const [urineLevel, setUrineLevel] = useState('中');
  const [catheterMl, setCatheterMl] = useState('');
  const [balloonAmount, setBalloonAmount] = useState('');

  const [patrolStatus, setPatrolStatus] = useState('就寝中');
  const [patrolActions, setPatrolActions] = useState([]);
  const [patrolNote, setPatrolNote] = useState('');

  const [panoramaNursingDraft, setPanoramaNursingDraft] = useState('');
  const [panoramaNursingStart, setPanoramaNursingStart] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [panoramaNursingEnd, setPanoramaNursingEnd] = useState('');
  const [panoramaNursingRev, setPanoramaNursingRev] = useState(0);
  const [facilityNoticeDraft, setFacilityNoticeDraft] = useState('');
  const [facilityHandoverDraft, setFacilityHandoverDraft] = useState('');

  const [selectedPortalSheetTitle, setSelectedPortalSheetTitle] = useState(CARELINK_FACILITIES[0]?.sheetTitle ?? '');
  /** 施設ポータル：事業所名・利用者名の絞り込み */
  const [portalFacilitySearch, setPortalFacilitySearch] = useState('');
  /** 名簿照会用（検索キーワードありのときに遅延取得） */
  const [portalSearchResidents, setPortalSearchResidents] = useState(
    /** @type {Record<string, unknown>[] | null} */ (null)
  );
  const [portalSearchLoading, setPortalSearchLoading] = useState(false);

  const [residents, setResidents] = useState([]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const ymd = localYmd();
      setTodayYmd((prev) => (prev === ymd ? prev : ymd));
    }, 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!requirePortalAuth) return;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        portalTabHiddenAtRef.current = Date.now();
        return;
      }
      const t0 = portalTabHiddenAtRef.current;
      if (t0 && Date.now() - t0 > PORTAL_RELOCK_AFTER_HIDDEN_MS && portalAuthUnlockedRef.current) {
        setPortalAuthUnlocked(false);
        setView('portal');
      }
      portalTabHiddenAtRef.current = 0;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [requirePortalAuth]);

  useEffect(() => {
    if (vitalsDayRef.current === todayYmd) return;
    vitalsDayRef.current = todayYmd;
    if (!selectedResident) return;
    setVitals({
      temp: '',
      spo2: '',
      pulse: '',
      bpUpper: '',
      bpLower: '',
      weight: '',
    });
    setBalloonAmount('');
  }, [todayYmd, selectedResident]);

  useEffect(() => {
    const raw = portalFacilitySearch.trim();
    if (!raw) {
      setPortalSearchResidents(null);
      setPortalSearchLoading(false);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setPortalSearchLoading(true);
      fetchResidentsFromSheet({ forceRefresh: false })
        .then(({ residents: rows }) => {
          if (!cancelled) setPortalSearchResidents(rows ?? []);
        })
        .catch(() => {
          if (!cancelled) setPortalSearchResidents(null);
        })
        .finally(() => {
          if (!cancelled) setPortalSearchLoading(false);
        });
    }, 380);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [portalFacilitySearch]);

  const portalFacilitiesFiltered = useMemo(() => {
    const raw = portalFacilitySearch.trim();
    if (!raw) return [...CARELINK_FACILITIES];
    const norm = (s) =>
      String(s ?? '')
        .normalize('NFKC')
        .toLowerCase();
    const needle = norm(raw);
    const facilityMatch = (f) => {
      const blob = norm(
        [f.tabLabel, f.sheetTitle, f.linkKey, f.emergencyFacilityName].filter(Boolean).join(' ')
      );
      return blob.includes(needle);
    };
    const residentNameMatch = (nameRaw) => {
      const name = norm(String(nameRaw ?? '').replace(/様\s*$/u, ''));
      return name.includes(needle);
    };
    const sheetForResident = (r) => {
      const sheet = String(r.facility ?? r.sourceSheetTitle ?? '')
        .trim();
      const hit = CARELINK_FACILITIES.find(
        (ff) => ff.sheetTitle === sheet || ff.tabLabel === sheet
      );
      return hit?.sheetTitle ?? '';
    };

    const matched = new Set();
    for (const f of CARELINK_FACILITIES) {
      if (facilityMatch(f)) matched.add(f.sheetTitle);
    }
    if (portalSearchResidents && portalSearchResidents.length) {
      for (const r of portalSearchResidents) {
        if (!residentNameMatch(r.name)) continue;
        const st = sheetForResident(r);
        if (st) matched.add(st);
      }
    }
    return CARELINK_FACILITIES.filter((f) => matched.has(f.sheetTitle));
  }, [portalFacilitySearch, portalSearchResidents]);

  const panoramaFacilityLinkKey = useMemo(
    () => Report.nursingFacilityLinkKeyFromContext(selectedResident ?? {}, selectedPortalSheetTitle),
    [selectedResident, selectedPortalSheetTitle]
  );
  const panoramaFacilityTabLabel = useMemo(() => {
    const lk = String(panoramaFacilityLinkKey ?? '').trim();
    if (!lk) return '';
    return CARELINK_FACILITIES.find((f) => f.linkKey === lk)?.tabLabel || lk;
  }, [panoramaFacilityLinkKey]);
  const panoramaNursingList = useMemo(
    () => (panoramaFacilityLinkKey ? Report.getNursingDirectives(panoramaFacilityLinkKey) : []),
    [panoramaFacilityLinkKey, panoramaNursingRev]
  );

  const applyResidentDetailState = useCallback((res, ymd = localYmd()) => {
    const id = String(res?.id ?? '').trim();
    const vitalsLoaded = vitalStateFromSaved(res, ymd);
    setVitals(
      vitalsLoaded ?? {
        temp: '',
        spo2: '',
        pulse: '',
        bpUpper: '',
        bpLower: '',
        weight: res?.weight != null && res.weight !== '' ? String(res.weight) : '',
      }
    );

    const care = careStateFromTodayEvents(id, ymd);
    setMealValue(care.mealValue);
    setIsMissedMeal(care.isMissedMeal);
    setHydration(care.hydration || '150');
    setMedicationDone(care.medicationDone);
    setActiveMealTime(care.activeMealTime);
    setEnteralExecuted(care.enteralExecuted);
    setIsEnteral(Boolean(res?.isEnteral) || care.enteralExecuted);
    setIsBalloon(care.isBalloon || Boolean(res?.isBalloon));
    setBalloonAmount(care.balloonAmount);
    setUrineMethod(care.urineMethod);
    setUrineLevel(care.urineLevel);
    setCatheterMl('');
    if (care.stoolAmount) setStoolAmount(care.stoolAmount);
    if (care.stoolForm) setStoolForm(care.stoolForm);
  }, []);

  useEffect(() => {
    if (!selectedResident) return;
    if (view !== 'detail' && view !== 'action_selection') return;
    applyResidentDetailState(selectedResident, recordDate);
  }, [recordDate, selectedResident, view, applyResidentDetailState]);

  const handleResidentClick = useCallback(
    (res, navList) => {
      setResidentAdminOverlay(null);
      setSelectedResident(res);
      if (Array.isArray(navList) && navList.length > 0) setResidentNavList(navList);
      applyResidentDetailState(res);
      const th = Report.resolveAlertThresholdsForResident(String(res?.id ?? ''));
      setAlertThresholdDraft({
        tempCMinFever: String(th.tempCMinFever),
        bpSystolicHigh: String(th.bpSystolicHigh),
        bpDiastolicLow: String(th.bpDiastolicLow),
        stoolHoursMax: String(th.stoolHoursMax),
        urineHoursMax: String(th.urineHoursMax),
        patrolIntervalWarnMin: String(th.patrolIntervalWarnMin),
      });
      setRecordDate(localYmd());
      setRecordTime(localHm());
      setView('action_selection');
    },
    [applyResidentDetailState]
  );

  const navigateResident = useCallback(
    (delta) => {
      if (!selectedResident || !residentNavList.length) return;
      const curId = String(selectedResident.id ?? '');
      const idx = residentNavList.findIndex((r) => String(r.id) === curId);
      if (idx < 0) return;
      const next = residentNavList[idx + delta];
      if (!next) return;
      setSelectedResident(next);
      applyResidentDetailState(next);
    },
    [selectedResident, residentNavList, applyResidentDetailState]
  );

  const residentNavIndex = useMemo(() => {
    if (!selectedResident || !residentNavList.length) return -1;
    return residentNavList.findIndex((r) => String(r.id) === String(selectedResident.id));
  }, [selectedResident, residentNavList]);

  const saveResidentAlertThresholds = useCallback(() => {
    const id = String(selectedResident?.id ?? '').trim();
    if (!id) return;
    Report.setResidentAlertThresholds(id, {
      tempCMinFever: Number(alertThresholdDraft.tempCMinFever),
      bpSystolicHigh: Number(alertThresholdDraft.bpSystolicHigh),
      bpDiastolicLow: Number(alertThresholdDraft.bpDiastolicLow),
      stoolHoursMax: Number(alertThresholdDraft.stoolHoursMax),
      urineHoursMax: Number(alertThresholdDraft.urineHoursMax),
      patrolIntervalWarnMin: Number(alertThresholdDraft.patrolIntervalWarnMin),
    });
    setSaveStatus('個別アラート基準を保存しました');
    setTimeout(() => setSaveStatus(''), 1200);
  }, [selectedResident, alertThresholdDraft]);

  const handleSave = (msg = '記録を保存しました') => {
    setSaveStatus(msg);
    setTimeout(() => {
      setSaveStatus('');
      setView('residents_list');
    }, 1000);
  };

  const togglePatrolAction = (action) => {
    setPatrolActions((prev) =>
      prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action]
    );
  };

  const registerNursingPanorama = () => {
    const lk = panoramaFacilityLinkKey;
    if (!lk) {
      alert('施設を特定できません。一覧表から利用者を選び直してください。');
      return;
    }
    if (
      Report.addNursingDirective(lk, panoramaNursingDraft, '看護', {
        startDate: panoramaNursingStart,
        endDate: panoramaNursingEnd,
      })
    ) {
      setPanoramaNursingDraft('');
      const d = new Date();
      setPanoramaNursingStart(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      );
      setPanoramaNursingEnd('');
      setPanoramaNursingRev((n) => n + 1);
    }
  };

  const removeNursingPanorama = (d) => {
    const lk = panoramaFacilityLinkKey;
    if (!lk) return;
    if (Report.removeNursingDirective(lk, String(d?.id ?? ''), String(d?.ts ?? ''))) {
      setPanoramaNursingRev((n) => n + 1);
    }
  };

  const saveFacilityHandoverPanorama = () => {
    const lk = panoramaFacilityLinkKey;
    if (!lk) {
      alert('施設を特定できません。一覧表から利用者を選び直してください。');
      return;
    }
    Report.setFacilityNotice(lk, facilityNoticeDraft);
    Report.setFacilityHandoverNote(lk, facilityHandoverDraft);
    setSaveStatus('周知事項・申し送りを保存しました');
    setTimeout(() => setSaveStatus(''), 1600);
  };

  const handleVoiceCarePatch = useCallback(({ vitals: vIn, meal: mIn }) => {
    const vitalKeys = ['temp', 'spo2', 'pulse', 'bpUpper', 'bpLower', 'weight'];
    const vSrc = vIn && typeof vIn === 'object' ? vIn : {};
    const vPatch = {};
    for (const k of vitalKeys) {
      const val = vSrc[k];
      if (val != null && String(val).trim() !== '') vPatch[k] = String(val).trim();
    }
    if (Object.keys(vPatch).length) setVitals((prev) => ({ ...prev, ...vPatch }));

    if (!mIn || typeof mIn !== 'object') return;

    const mt = mIn.mealTime;
    if (typeof mt === 'string' && ['朝', '昼', '夕', 'おやつ'].includes(mt)) {
      setActiveMealTime(mt);
    }

    const mv = mIn.mealValue;
    if (mv != null) {
      const s = String(mv).trim();
      if (/^(10|[0-9])$/.test(s)) setMealValue(s);
    }

    if (typeof mIn.isMissedMeal === 'boolean') setIsMissedMeal(mIn.isMissedMeal);

    if (mIn.hydration != null && String(mIn.hydration).trim() !== '') {
      const n = String(mIn.hydration).replace(/\D/g, '');
      if (n) setHydration(n);
    }

    if (typeof mIn.hasSupplement === 'boolean') setHasSupplement(mIn.hasSupplement);
    if (typeof mIn.medicationDone === 'boolean') setMedicationDone(mIn.medicationDone);
    if (typeof mIn.enteralExecuted === 'boolean') setEnteralExecuted(mIn.enteralExecuted);
  }, []);

  const saveDetailCareLog = useCallback(() => {
    if (!selectedResident) return;
    const facSheet = String(
      selectedResident.sourceSheetTitle || selectedResident.facility || selectedPortalSheetTitle || ''
    ).trim();
    const id = String(selectedResident.id);
    const name = String(selectedResident.name ?? '');
    const targetTs = localDateTimeToIso(recordDate, recordTime);
    if (!targetTs) {
      alert('記録日時（日付・時間）を正しく入力してください。');
      return;
    }
    Report.removeCareEventsByResidentAtMinute(id, targetTs, [
      'vital_snapshot',
      'meal',
      'enteral',
      'excretion',
    ]);
    Report.logVitalSnapshot(id, name, facSheet, {
      temp: vitals.temp,
      spo2: vitals.spo2,
      pulse: vitals.pulse,
      bpUpper: vitals.bpUpper,
      bpLower: vitals.bpLower,
      weight: vitals.weight,
    }, targetTs);
    Report.setResidentVitalSnapshot(id, {
      temp: vitals.temp,
      spo2: vitals.spo2,
      pulse: vitals.pulse,
      bpUpper: vitals.bpUpper,
      bpLower: vitals.bpLower,
      weight: vitals.weight,
    });
    if (!isMissedMeal) {
      Report.logCareEvent({
        type: 'meal',
        ts: targetTs,
        residentId: id,
        residentName: name,
        facilitySheetTitle: facSheet,
        meta: {
          mealTime: activeMealTime,
          mealValue,
          hydration,
          hasSupplement,
          medicationDone,
        },
      });
    }
    if (isEnteral && enteralExecuted) {
      Report.logCareEvent({
        type: 'enteral',
        ts: targetTs,
        residentId: id,
        residentName: name,
        facilitySheetTitle: facSheet,
        meta: { note: '経管栄養実施（管理料算定用）' },
      });
    }
    Report.logCareEvent({
      type: 'excretion',
      ts: targetTs,
      residentId: id,
      residentName: name,
      facilitySheetTitle: facSheet,
      meta: {
        stoolAmount,
        stoolForm,
        urineLevel: isBalloon
          ? `バルーン 1日Total(23時締め) ${balloonAmount || '記録なし'}ml`
          : urineMethod === 'カテ'
            ? `カテ ${catheterMl || '—'}ml`
            : `${urineMethod} ${urineLevel}`,
        ...(urineMethod === 'カテ' && catheterMl ? { urineVolume: catheterMl, catheterMl } : {}),
      },
    });
    Report.recordStoolForIntervalAlert(id, { stoolAmount, stoolCharacter: stoolForm });
    Report.setLastUrineNow(id);
  }, [
    selectedResident,
    selectedPortalSheetTitle,
    isMissedMeal,
    activeMealTime,
    mealValue,
    hydration,
    hasSupplement,
    medicationDone,
    isEnteral,
    enteralExecuted,
    vitals,
    stoolAmount,
    stoolForm,
    urineMethod,
    urineLevel,
    catheterMl,
    isBalloon,
    balloonAmount,
    recordDate,
    recordTime,
  ]);

  const deleteDetailCareLogAtSelectedTime = useCallback(() => {
    if (!selectedResident) return;
    const id = String(selectedResident.id ?? '');
    const targetTs = localDateTimeToIso(recordDate, recordTime);
    if (!targetTs) {
      alert('記録日時（日付・時間）を正しく入力してください。');
      return;
    }
    const removed = Report.removeCareEventsByResidentAtMinute(id, targetTs, [
      'vital_snapshot',
      'meal',
      'enteral',
      'excretion',
    ]);
    if (removed > 0) {
      handleSave('指定日時の記録を削除しました');
    } else {
      alert('指定日時の記録は見つかりませんでした。');
    }
  }, [selectedResident, recordDate, recordTime]);

  const ActionSelection = () => (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 font-sans font-bold">
      <div className="w-full max-w-md bg-white p-10 rounded-[4rem] shadow-2xl border border-slate-100 text-center font-bold">
        <button
          type="button"
          onClick={() => setView('residents_list')}
          aria-label="利用者一覧に戻る"
          className="mb-8 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-slate-400 bg-white px-4 py-4 text-base font-black text-slate-900 shadow-md transition-all hover:border-blue-500 hover:bg-blue-50 hover:text-blue-950 active:scale-[0.99]"
        >
          <ChevronLeft size={22} className="shrink-0 text-blue-700" strokeWidth={2.5} aria-hidden />
          一覧に戻る
        </button>
        <div className="mb-10 font-bold">
          <div className="mb-1 flex items-center justify-center gap-2 text-sm font-black tracking-wide text-slate-700">
            <button
              type="button"
              disabled={residentNavIndex <= 0}
              onClick={() => navigateResident(-1)}
              className="rounded-xl border-2 border-slate-300 bg-white p-2 text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="前の利用者"
            >
              <ChevronLeft size={20} />
            </button>
            <span>
              居室 <span className="tabular-nums text-slate-900">{selectedResident?.room ?? '—'}</span>
            </span>
            <button
              type="button"
              disabled={residentNavIndex < 0 || residentNavIndex >= residentNavList.length - 1}
              onClick={() => navigateResident(1)}
              className="rounded-xl border-2 border-slate-300 bg-white p-2 text-slate-700 transition hover:border-blue-400 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="次の利用者"
            >
              <ChevronRight size={20} />
            </button>
          </div>
          <h2 className="text-3xl text-slate-800 tracking-tight font-bold">
            {residentDisplayName(selectedResident?.name)} <span className="font-bold">様</span>
          </h2>
        </div>
        <div className="grid gap-4 font-bold">
          <button
            type="button"
            onClick={() => setView('patrol')}
            className="group p-6 bg-slate-900 text-white rounded-[2rem] flex flex-col items-center gap-2 shadow-xl active:scale-95 transition-all font-bold"
          >
            <ShieldAlert size={28} className="text-amber-400" />
            <span className="text-xl tracking-tight italic font-bold">巡視・安否確認記録</span>
          </button>
          <button
            type="button"
            onClick={() => setView('detail')}
            className="group p-6 bg-blue-600 text-white rounded-[2rem] flex flex-col items-center gap-2 shadow-xl active:scale-95 transition-all font-bold"
          >
            <Utensils size={28} />
            <span className="text-xl tracking-tight italic font-bold">生活・バイタル・排泄</span>
          </button>
          <button
            type="button"
            onClick={() => setView('nursing_directives')}
            className="group flex flex-col items-center gap-2 rounded-[2rem] bg-rose-600 p-6 text-white shadow-xl transition-all active:scale-95 font-bold"
          >
            <Stethoscope size={28} />
            <span className="text-xl font-bold italic tracking-tight">看護処置・指示</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setFacilityNoticeDraft(
                panoramaFacilityLinkKey ? Report.getFacilityNotice(panoramaFacilityLinkKey) : ''
              );
              setFacilityHandoverDraft(
                panoramaFacilityLinkKey ? Report.getFacilityHandoverNote(panoramaFacilityLinkKey) : ''
              );
              setView('facility_handover');
            }}
            className="group flex flex-col items-center gap-2 rounded-[2rem] bg-indigo-600 p-6 text-white shadow-xl transition-all active:scale-95 font-bold"
          >
            <ClipboardList size={28} />
            <span className="text-xl font-bold italic tracking-tight">申し送り</span>
          </button>
          <p className="text-center text-[11px] font-bold leading-snug text-slate-500">
            次の4つは必要なときだけ。一覧のカードからは外しています。
          </p>
          <button
            type="button"
            onClick={() => setResidentAdminOverlay('disability')}
            className="group flex flex-col items-center gap-2 rounded-[2rem] border-2 border-violet-400 bg-violet-50 p-5 text-violet-950 shadow-md transition-all active:scale-95 font-bold"
          >
            <FileSpreadsheet size={26} className="text-violet-700" />
            <span className="text-base font-black italic tracking-tight">障害福祉サービス進捗</span>
          </button>
          <button
            type="button"
            onClick={() => setResidentAdminOverlay('move_log')}
            className="group flex flex-col items-center gap-2 rounded-[2rem] border-2 border-teal-500 bg-teal-50 p-5 text-teal-950 shadow-md transition-all active:scale-95 font-bold"
          >
            <ClipboardList size={26} className="text-teal-700" />
            <span className="text-base font-black italic tracking-tight">入院・入居・退院記録</span>
          </button>
          <button
            type="button"
            onClick={() => setResidentAdminOverlay('info_provision')}
            className="group flex flex-col items-center gap-2 rounded-[2rem] border-2 border-violet-600 bg-white p-5 text-violet-900 shadow-md transition-all active:scale-95 font-bold"
          >
            <FileText size={26} className="text-violet-600" />
            <span className="text-base font-black italic tracking-tight">情報提供書</span>
          </button>
          <button
            type="button"
            onClick={() => setResidentAdminOverlay('med')}
            className="group flex flex-col items-center gap-2 rounded-[2rem] border-2 border-indigo-500 bg-indigo-50 p-5 text-indigo-950 shadow-md transition-all active:scale-95 font-bold"
          >
            <Pill size={26} className="text-indigo-700" />
            <span className="text-base font-black italic tracking-tight">薬情報（薬局PDF）</span>
          </button>
          <button
            type="button"
            onClick={() => setView('history_detailed')}
            className="group p-6 bg-white border-2 border-slate-100 text-slate-700 rounded-[2rem] flex flex-col items-center gap-2 shadow-sm active:scale-95 transition-all font-bold"
          >
            <History size={28} className="text-blue-500" />
            <span className="text-xl tracking-tight italic font-bold">詳細履歴・過去推移</span>
          </button>
        </div>
      </div>
    </div>
  );

  const PatrolView = () => (
    <div className="min-h-screen bg-slate-50 font-sans font-bold pb-32">
      <header className="p-6 bg-white border-b border-slate-100 sticky top-0 z-20 font-bold">
        <div className="flex items-center justify-between mb-4">
          <button
            type="button"
            onClick={() => setView('action_selection')}
            className="text-blue-600 text-sm flex items-center gap-1"
          >
            <ChevronLeft size={18} /> 戻る
          </button>
          <h2 className="text-lg font-bold">巡視記録</h2>
          <div className="w-10" />
        </div>
        <div className="text-center">
          <h3 className="text-2xl text-slate-900 font-bold">
            {residentDisplayName(selectedResident?.name)} <span className="font-bold">様</span>
          </h3>
          <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-1">
            Last Patrol: {selectedResident?.lastPatrol}
          </p>
        </div>
      </header>

      <main className="p-6 space-y-6 max-w-xl mx-auto">
        <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
          <span className="text-[10px] text-slate-400 uppercase font-bold mb-4 block">1. 安否・覚醒状態</span>
          <div className="grid grid-cols-3 gap-3">
            {[
              { id: '就寝中', icon: Moon, color: 'text-indigo-500', bg: 'bg-indigo-50' },
              { id: '覚醒', icon: Sun, color: 'text-orange-500', bg: 'bg-orange-50' },
              { id: '離床', icon: Activity, color: 'text-emerald-500', bg: 'bg-emerald-50' },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setPatrolStatus(s.id)}
                className={`flex flex-col items-center gap-2 p-4 rounded-2xl border transition-all ${
                  patrolStatus === s.id
                    ? 'bg-slate-900 text-white border-slate-900 shadow-lg'
                    : 'bg-slate-50 border-slate-100 text-slate-400'
                }`}
              >
                <s.icon size={20} className={patrolStatus === s.id ? 'text-white' : s.color} />
                <span className="text-xs font-bold">{s.id}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
          <span className="text-[10px] text-slate-400 uppercase font-bold mb-4 block">2. 実施ケア（複数選択可）</span>
          <div className="grid grid-cols-2 gap-3">
            {[
              { id: '体位変換', icon: RefreshCw },
              { id: 'オムツ交換', icon: Baby },
              { id: '水分補給', icon: CupSoda },
              { id: '訪室のみ', icon: Eye },
            ].map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => togglePatrolAction(a.id)}
                className={`flex items-center gap-3 p-4 rounded-2xl border transition-all ${
                  patrolActions.includes(a.id)
                    ? 'bg-blue-600 text-white border-blue-600 shadow-md'
                    : 'bg-slate-50 border-slate-100 text-slate-400'
                }`}
              >
                <a.icon size={18} />
                <span className="text-xs font-bold">{a.id}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
          <span className="text-[10px] text-slate-400 uppercase font-bold mb-4 block text-center">
            特記事項・申し送り
          </span>
          <textarea
            value={patrolNote}
            onChange={(e) => setPatrolNote(e.target.value)}
            placeholder="異常なし、あるいは気になる点があれば入力してください"
            className="w-full h-24 bg-slate-50 border-none rounded-2xl p-4 text-sm outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>

        <div className="fixed bottom-0 left-0 right-0 p-6 bg-white/80 backdrop-blur-md border-t border-slate-100 z-30">
          <button
            type="button"
            onClick={() => handleSave('巡視記録を保存しました')}
            className="w-full max-w-xl mx-auto block py-5 bg-slate-900 text-white font-bold rounded-[2rem] shadow-xl text-lg active:scale-95 transition-all"
          >
            巡視完了として保存
          </button>
        </div>
      </main>
    </div>
  );

  const HistoryDetailed = () => (
    <div className="min-h-screen bg-slate-50 font-sans font-bold pb-12">
      <header className="p-6 bg-white border-b border-slate-100 sticky top-0 z-20 flex justify-between items-center font-bold">
        <button
          type="button"
          onClick={() => setView('action_selection')}
          className="text-blue-600 text-sm flex items-center gap-1 font-bold"
        >
          <ChevronLeft size={18} /> 戻る
        </button>
        <h2 className="text-lg font-bold">
          {residentDisplayName(selectedResident?.name)} 様 経過レポート
        </h2>
        <div className="w-10" />
      </header>
      <div className="p-4 flex bg-white border-b border-slate-100 sticky top-[73px] z-20 font-bold">
        <div className="flex w-full bg-slate-100 p-1 rounded-xl font-bold">
          <button
            type="button"
            onClick={() => setActiveHistoryTab('day')}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
              activeHistoryTab === 'day' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400'
            }`}
          >
            今日
          </button>
          <button
            type="button"
            onClick={() => setActiveHistoryTab('week')}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
              activeHistoryTab === 'week' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400'
            }`}
          >
            1週間推移
          </button>
        </div>
      </div>
      <main className="p-6 max-w-4xl mx-auto space-y-6 font-bold">
        {activeHistoryTab === 'day' && (
          <div className="bg-white p-8 rounded-[3rem] shadow-sm border border-slate-100 font-bold">
            <h3 className="text-sm font-bold text-slate-800 mb-8 flex items-center gap-2 font-bold">
              <Clock className="text-blue-500" /> タイムラインログ
            </h3>
            <div className="relative border-l-2 border-slate-100 ml-4 space-y-10 pb-6 font-bold">
              {[
                { t: '13:00', l: '巡視記録', s: 'done', d: '覚醒：水分補給', type: 'patrol' },
                { t: '12:45', l: '食事記録', s: 'done', d: '昼食 10割 / 水分 150ml', type: 'care' },
                { t: '10:00', l: '巡視記録', s: 'done', d: '就寝中：訪室のみ', type: 'patrol' },
                { t: '09:00', l: 'バイタル', s: 'done', d: '36.5℃ / SPO2 98%', type: 'medical' },
              ].map((log, i) => (
                <div key={i} className="relative pl-10 font-bold">
                  <div
                    className={`absolute -left-[11px] top-1 w-5 h-5 rounded-full border-2 border-white shadow-sm flex items-center justify-center ${
                      log.type === 'patrol' ? 'bg-slate-800' : 'bg-blue-500'
                    }`}
                  >
                    {log.type === 'patrol' ? (
                      <ShieldAlert size={10} className="text-white" />
                    ) : (
                      <Check size={10} className="text-white" />
                    )}
                  </div>
                  <div className="text-xs text-slate-400 font-bold mb-1 font-bold">{log.t}</div>
                  <div className="text-base font-bold font-bold">{log.l}</div>
                  <div className="text-[10px] text-slate-500 font-bold italic">{log.d}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {activeHistoryTab === 'week' && (
          <div className="bg-white p-8 rounded-[3rem] shadow-sm border border-slate-100 text-sm text-slate-500 text-center">
            1週間推移（デモ：データ連携後に表示）
          </div>
        )}
        <button
          type="button"
          className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2"
        >
          <Download size={18} /> PDF出力
        </button>
      </main>
    </div>
  );

  const Detail = () => (
    <div className="min-h-screen bg-slate-50 font-sans font-bold pb-32">
      <header className="p-6 bg-white border-b border-slate-100 sticky top-0 z-20 font-bold">
        <div className="flex items-center justify-between mb-4 font-bold">
          <button
            type="button"
            onClick={() => setView('action_selection')}
            className="text-blue-600 text-sm flex items-center gap-1 font-bold"
          >
            <ChevronLeft size={18} /> 戻る
          </button>
          <div className="text-center font-bold">
            <div className="text-xs text-slate-800 uppercase font-bold tracking-widest">生活記録入力</div>
          </div>
          <div className="w-10" />
        </div>
        <div className="px-2 font-bold">
          <h2 className="text-2xl text-slate-900 tracking-tight font-bold font-bold">
            {residentDisplayName(selectedResident?.name)} <span className="font-bold">様</span>
          </h2>
          <div className="flex gap-2 mt-2 font-bold font-bold items-center flex-wrap">
            <button
              type="button"
              disabled={residentNavIndex <= 0}
              onClick={() => navigateResident(-1)}
              className="rounded-lg border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-30"
              aria-label="前の利用者"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="bg-blue-50 text-blue-600 text-[10px] px-2 py-1 rounded-lg border border-blue-100 uppercase font-bold">
              Room {selectedResident?.room}
            </span>
            <button
              type="button"
              disabled={residentNavIndex < 0 || residentNavIndex >= residentNavList.length - 1}
              onClick={() => navigateResident(1)}
              className="rounded-lg border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-30"
              aria-label="次の利用者"
            >
              <ChevronRight size={18} />
            </button>
            <button
              type="button"
              onClick={() => setWeeklyFlowOpen(true)}
              className="ml-auto rounded-lg border border-teal-300 bg-teal-50 px-2 py-1 text-[10px] font-black text-teal-800 hover:bg-teal-100"
            >
              1週間フローシート
            </button>
            <span className="bg-slate-100 text-slate-500 text-[10px] px-2 py-1 rounded-lg border border-slate-200 font-bold uppercase tracking-widest">
              体重: {selectedResident?.weight}kg
            </span>
          </div>
        </div>
      </header>

      <div className="p-4 flex bg-white sticky top-[104px] z-20 border-b border-slate-100 font-bold">
        <div className="flex w-full bg-slate-100 p-1 rounded-xl font-bold">
          <button
            type="button"
            onClick={() => setActiveDetailTab('vital')}
            className={`flex-1 py-2.5 text-xs font-bold rounded-lg transition-all ${
              activeDetailTab === 'vital' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 font-bold'
            }`}
          >
            バイタル
          </button>
          <button
            type="button"
            onClick={() => setActiveDetailTab('meal')}
            className={`flex-1 py-2.5 text-xs font-bold rounded-lg transition-all ${
              activeDetailTab === 'meal' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 font-bold'
            }`}
          >
            食事・水分・内服
          </button>
          <button
            type="button"
            onClick={() => setActiveDetailTab('excretion')}
            className={`flex-1 py-2.5 text-xs font-bold rounded-lg transition-all ${
              activeDetailTab === 'excretion' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 font-bold'
            }`}
          >
            排泄
          </button>
        </div>
      </div>

      <main className="p-6 space-y-6 max-w-3xl mx-auto font-bold font-bold">
        <VoiceCareInput apiKey={GEMINI_KEY} onPatch={handleVoiceCarePatch} />
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <p className="mb-2 text-[11px] font-bold text-slate-600">記録日時（後で入力・修正用）</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={recordDate}
              onChange={(e) => setRecordDate(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-bold"
            />
            <input
              type="time"
              value={recordTime}
              onChange={(e) => setRecordTime(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-bold"
            />
            <button
              type="button"
              onClick={deleteDetailCareLogAtSelectedTime}
              className="ml-auto rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700 hover:bg-rose-100"
            >
              この日時の保存を削除
            </button>
          </div>
          <p className="mt-2 text-[10px] font-bold leading-relaxed text-slate-600">
            <strong className="text-slate-800">修正方法:</strong>{' '}
            ① 間違えた日時を上の欄に合わせる → ②「この日時の保存を削除」で取り消し、または正しい値を入れて再保存（上書き）。
            一覧表の入力は「生活・バイタル・排泄」画面とは別保存です。一覧表で直す場合は対象日を合わせて一覧表から再入力してください。
          </p>
        </div>
        {!GEMINI_KEY && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-[11px] font-bold text-amber-800">
            Google AI Studio の API キーを <code className="rounded bg-white px-1">facility-portal/.env</code> に{' '}
            <code className="rounded bg-white px-1">VITE_GEMINI_API_KEY=...</code> として保存し、開発サーバーを再起動してください。
          </p>
        )}
        {activeDetailTab === 'vital' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 font-bold">
              {[
                { key: 'temp', l: '体温', u: '℃', i: Thermometer, s: '0.1' },
                { key: 'spo2', l: 'SPO2', u: '%', i: Droplets, s: '1' },
                { key: 'pulse', l: '脈拍', u: 'bpm', i: Activity, s: '1' },
                { key: 'bpUpper', l: '血圧(上)', u: '', i: Heart, s: '1' },
                { key: 'bpLower', l: '血圧(下)', u: '', i: Heart, s: '1' },
                { key: 'weight', l: '体重', u: 'kg', i: Scale, s: '0.1', note: '月1回測定' },
              ].map((v) => (
                <div
                  key={v.key}
                  className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm focus-within:ring-2 focus-within:ring-blue-400 transition-all font-bold"
                >
                  <div
                    className={`flex items-center gap-2 text-slate-400 font-bold font-bold ${v.note ? 'mb-1' : 'mb-4'}`}
                  >
                    <v.i size={14} /> <span className="text-[10px] uppercase font-bold">{v.l}</span>
                  </div>
                  {v.note ? (
                    <p className="mb-3 text-[10px] font-bold text-sky-600">{v.note}</p>
                  ) : null}
                  <div className="flex items-baseline justify-end gap-1 font-bold">
                    <input
                      type="text"
                      inputMode={v.s === '0.1' ? 'decimal' : 'numeric'}
                      value={vitals[v.key]}
                      onChange={(e) => setVitals((prev) => ({ ...prev, [v.key]: e.target.value }))}
                      className="w-full text-right text-3xl font-bold text-slate-800 bg-transparent outline-none font-bold"
                    />
                    <span className="text-xs text-slate-400 font-bold">{v.u}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-3xl border border-violet-200 bg-violet-50/70 p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm font-black text-violet-900">個別アラート基準（この利用者だけ）</p>
                <button
                  type="button"
                  onClick={saveResidentAlertThresholds}
                  className="rounded-lg border border-violet-500 bg-violet-600 px-3 py-1.5 text-xs font-black text-white hover:bg-violet-500"
                >
                  基準を保存
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[
                  ['tempCMinFever', '発熱しきい値(℃)'],
                  ['bpSystolicHigh', '血圧上 上限'],
                  ['bpDiastolicLow', '血圧下 下限'],
                  ['stoolHoursMax', '排便アラート(h)'],
                  ['urineHoursMax', '排尿アラート(h)'],
                  ['patrolIntervalWarnMin', '巡視警告(分)'],
                ].map(([k, label]) => (
                  <label key={k} className="flex flex-col gap-1">
                    <span className="text-[10px] font-bold text-violet-900">{label}</span>
                    <input
                      type="text"
                      inputMode={k === 'tempCMinFever' ? 'decimal' : 'numeric'}
                      value={alertThresholdDraft[k] ?? ''}
                      onChange={(e) => setAlertThresholdDraft((prev) => ({ ...prev, [k]: e.target.value }))}
                      className="rounded-lg border border-violet-200 bg-white px-2 py-1.5 text-sm font-bold text-slate-900"
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[10px] font-bold text-violet-800">
                例: 普段から低血圧の方は「血圧下 下限」を個別に下げてください。
              </p>
            </div>
          </div>
        )}

        {activeDetailTab === 'meal' && (
          <div className="space-y-6 animate-in fade-in duration-300 font-bold">
            <div className="flex gap-2 p-1 bg-slate-200 rounded-xl font-bold">
              {['朝', '昼', '夕', 'おやつ'].map((time) => (
                <button
                  key={time}
                  type="button"
                  onClick={() => setActiveMealTime(time)}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                    activeMealTime === time ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 font-bold'
                  }`}
                >
                  {time}
                </button>
              ))}
            </div>
            <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm space-y-6 font-bold">
              <div className="flex justify-between items-center font-bold">
                <div className="text-[10px] text-slate-400 font-bold uppercase flex items-center gap-2 font-bold">
                  <Utensils size={14} className="text-orange-500" /> 食事量
                </div>
                <button
                  type="button"
                  onClick={() => setIsMissedMeal(!isMissedMeal)}
                  className={`px-4 py-1.5 rounded-full text-[10px] font-bold border ${
                    isMissedMeal ? 'bg-slate-800 text-white' : 'bg-slate-50 text-slate-400 font-bold'
                  }`}
                >
                  欠食登録
                </button>
              </div>
              {!isMissedMeal ? (
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 font-bold">
                  {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setMealValue(opt)}
                      className={`py-3 rounded-xl font-bold text-sm border transition-all ${
                        mealValue === opt ? 'bg-orange-500 text-white shadow-lg' : 'bg-slate-50 text-slate-400 font-bold'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="bg-slate-50 p-6 rounded-2xl text-center text-slate-400 border border-dashed font-bold font-bold">
                  欠食として記録（請求外）
                </div>
              )}

              <div className="pt-4 border-t border-slate-50 space-y-4 font-bold">
                <div className="flex items-center justify-between font-bold">
                  <span className="text-[10px] text-slate-400 font-bold uppercase font-bold">経管栄養の実施</span>
                  <button
                    type="button"
                    onClick={() => setIsEnteral(!isEnteral)}
                    className={`px-4 py-1 rounded-full text-[10px] font-bold border ${
                      isEnteral ? 'bg-amber-100 text-amber-700' : 'bg-slate-50 text-slate-400 font-bold'
                    }`}
                  >
                    {isEnteral ? '設定あり' : '設定なし'}
                  </button>
                </div>
                {isEnteral && (
                  <button
                    type="button"
                    onClick={() => setEnteralExecuted(!enteralExecuted)}
                    className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all ${
                      enteralExecuted
                        ? 'bg-green-500 text-white shadow-lg'
                        : 'bg-amber-500 text-white shadow-lg shadow-amber-200 font-bold'
                    }`}
                  >
                    {enteralExecuted ? <CheckSquare size={24} /> : <Square size={24} />} 経管栄養 実施チェック
                  </button>
                )}
              </div>
            </div>
            <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm space-y-4 font-bold">
              <div className="flex justify-between items-center font-bold">
                <div className="text-[10px] text-slate-400 font-bold uppercase flex items-center gap-2 font-bold">
                  <CupSoda size={14} className="text-blue-500" /> 水分 / 補助食
                </div>
                <button
                  type="button"
                  onClick={() => setHasSupplement(!hasSupplement)}
                  className={`px-3 py-1 rounded-full text-[9px] font-bold border ${
                    hasSupplement ? 'bg-purple-100 text-purple-600 shadow-sm' : 'bg-slate-50 text-slate-400 font-bold'
                  }`}
                >
                  補助食有
                </button>
              </div>
              <select
                value={hydration}
                onChange={(e) => setHydration(e.target.value)}
                className="w-full bg-slate-50 border-none rounded-2xl p-4 text-2xl font-bold focus:ring-2 focus:ring-blue-100 outline-none font-bold"
              >
                {WATER_ML_50_OPTIONS.map((opt) => (
                  <option key={opt.value || 'empty'} value={opt.value}>
                    {opt.label === '—' ? '選択（50ml刻み）' : opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex items-center justify-between font-bold">
              <div className="text-[10px] text-slate-400 font-bold uppercase flex items-center gap-2 font-bold">
                <Pill size={14} className="text-purple-500" /> 内服確認
              </div>
              <div className="flex gap-2 font-bold">
                <button
                  type="button"
                  onClick={() => setMedicationDone(true)}
                  className={`px-8 py-3 rounded-xl font-bold text-sm transition-all ${
                    medicationDone ? 'bg-purple-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400 font-bold'
                  }`}
                >
                  済
                </button>
                <button
                  type="button"
                  onClick={() => setMedicationDone(false)}
                  className={`px-8 py-3 rounded-xl font-bold text-sm transition-all ${
                    !medicationDone ? 'bg-red-500 text-white shadow-lg' : 'bg-slate-100 text-slate-400 font-bold'
                  }`}
                >
                  未
                </button>
              </div>
            </div>
          </div>
        )}

        {activeDetailTab === 'excretion' && (
          <div className="space-y-6 animate-in fade-in duration-300 font-bold">
            <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm space-y-4 font-bold">
              <div className="flex justify-between items-center font-bold font-bold">
                <div className="text-[10px] text-slate-400 font-bold uppercase flex items-center gap-2 font-bold">
                  <Activity size={14} className="text-blue-500" /> 排尿管理
                </div>
                <button
                  type="button"
                  onClick={() => setIsBalloon(!isBalloon)}
                  className={`px-4 py-1.5 rounded-full text-[10px] font-bold border transition-all ${
                    isBalloon ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-400 font-bold'
                  }`}
                >
                  バルーン有
                </button>
              </div>
              {isBalloon ? (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold text-blue-700">
                    バルーンは1日Total量を入力（23時締め）
                  </p>
                  <div className="flex gap-3 items-center font-bold">
                    <input
                      type="number"
                      value={balloonAmount}
                      onChange={(e) => setBalloonAmount(e.target.value)}
                      placeholder="1日Total量 (ml) / 23時締め"
                      className="flex-1 bg-slate-50 border-none rounded-2xl p-4 text-xl font-bold"
                    />
                    <span className="text-slate-400 font-bold">ml</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    {['おむつ', 'トイレ', 'カテ'].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setUrineMethod(m)}
                        className={`py-3 rounded-xl font-bold text-sm border transition-all ${
                          urineMethod === m ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-50 text-slate-500'
                        }`}
                      >
                        {urineMethod === m ? '✓ ' : ''}
                        {m}
                      </button>
                    ))}
                  </div>
                  {urineMethod === 'カテ' ? (
                    <div className="flex gap-3 items-center font-bold">
                      <input
                        type="number"
                        inputMode="numeric"
                        value={catheterMl}
                        onChange={(e) => setCatheterMl(e.target.value)}
                        placeholder="尿量 (ml)"
                        className="flex-1 bg-slate-50 border-none rounded-2xl p-4 text-xl font-bold"
                      />
                      <span className="text-slate-400 font-bold">ml</span>
                    </div>
                  ) : (
                  <div className="grid grid-cols-3 gap-2 font-bold">
                    {['多', '中', '小'].map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setUrineLevel(lvl)}
                        className={`py-4 rounded-xl font-bold text-sm border transition-all ${
                          urineLevel === lvl ? 'bg-blue-500 text-white shadow-lg' : 'bg-slate-50 text-slate-400 font-bold'
                        }`}
                      >
                        {urineLevel === lvl ? '✓ ' : ''}
                        {lvl}
                      </button>
                    ))}
                  </div>
                  )}
                </div>
              )}
            </div>
            <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm space-y-4 font-bold">
              <div className="flex justify-between items-center font-bold font-bold">
                <div className="text-[10px] text-slate-400 font-bold uppercase flex items-center gap-2 font-bold">
                  <Wind size={14} className="text-amber-600" /> 排便管理
                </div>
              </div>
              <div className="space-y-4 font-bold">
                <div className="grid grid-cols-3 gap-2 font-bold">
                  {['少量', '中等量', '多量'].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setStoolAmount(amt)}
                      className={`py-3 rounded-xl font-bold text-xs border transition-all ${
                        stoolAmount === amt ? 'bg-amber-500 text-white shadow-md' : 'bg-slate-50 text-slate-400 font-bold'
                      }`}
                    >
                      {amt}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-5 gap-2 font-bold font-bold">
                  {['硬', '普', '軟', '泥', '水'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStoolForm(s)}
                      className={`py-2 rounded-lg text-[10px] font-bold border ${
                        stoolForm === s ? 'bg-amber-600 text-white' : 'bg-slate-50 text-slate-400 font-bold'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="fixed bottom-0 left-0 right-0 p-6 bg-white/80 backdrop-blur-md border-t border-slate-100 z-30 font-bold">
          <button
            type="button"
            onClick={() => {
              saveDetailCareLog();
              handleSave();
            }}
            className="w-full max-w-xl mx-auto block py-5 bg-blue-600 text-white font-bold rounded-[2rem] shadow-xl text-lg font-bold"
          >
            記録を保存して戻る
          </button>
        </div>
      </main>
      {saveStatus && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 bg-green-500 text-white px-8 py-3 rounded-full font-bold shadow-2xl z-[100] animate-in fade-in zoom-in">
          {saveStatus}
        </div>
      )}
      {weeklyFlowOpen && selectedResident ? (
        <WeeklyFlowSheet resident={selectedResident} onClose={() => setWeeklyFlowOpen(false)} />
      ) : null}
    </div>
  );

  if (requirePortalAuth && !portalAuthUnlocked) {
    return <PortalAuthScreen onSuccess={() => setPortalAuthUnlocked(true)} />;
  }

  const lockProp = requirePortalAuth ? lockPortal : undefined;

  const main = (() => {
    switch (view) {
      case 'portal':
        return (
          <FacilityPortalView
            portalFacilitySearch={portalFacilitySearch}
            setPortalFacilitySearch={setPortalFacilitySearch}
            portalSearchLoading={portalSearchLoading}
            portalFacilitiesFiltered={portalFacilitiesFiltered}
            setSelectedPortalSheetTitle={setSelectedPortalSheetTitle}
            setView={setView}
            onLockPortal={lockProp}
          />
        );
      case 'residents_list':
        return (
          <RecordPage
            onSelectResident={handleResidentClick}
            onBack={() => setView('portal')}
            onOpenMonthlyReport={() => setView('monthly_report_manager')}
            onOpenNotionNewResidents={() => setView('notion_new_residents')}
            onResidentsSync={setResidents}
            initialSheetTitle={selectedPortalSheetTitle}
          />
        );
      case 'action_selection':
        return <ActionSelection />;
      case 'detail':
        return <Detail />;
      case 'patrol':
        return <PatrolView />;
      case 'history_detailed':
        return <HistoryDetailed />;
      case 'nursing_directives':
        return (
          <NursingDirectivesPanoramaView
            selectedResident={selectedResident}
            facilityLinkKey={panoramaFacilityLinkKey}
            nursingList={panoramaNursingList}
            draft={panoramaNursingDraft}
            setDraft={setPanoramaNursingDraft}
            startDate={panoramaNursingStart}
            setStartDate={setPanoramaNursingStart}
            endDate={panoramaNursingEnd}
            setEndDate={setPanoramaNursingEnd}
            onBack={() => setView('action_selection')}
            onRegister={registerNursingPanorama}
            onRemove={removeNursingPanorama}
          />
        );
      case 'facility_handover':
        return (
          <FacilityHandoverPanoramaView
            selectedResident={selectedResident}
            facilityTabLabel={panoramaFacilityTabLabel}
            noticeDraft={facilityNoticeDraft}
            setNoticeDraft={setFacilityNoticeDraft}
            draft={facilityHandoverDraft}
            setDraft={setFacilityHandoverDraft}
            saveStatus={saveStatus}
            onBack={() => setView('action_selection')}
            onSave={saveFacilityHandoverPanorama}
          />
        );
      case 'monthly_report_manager':
        return (
          <MonthlyReportManager
            onBack={() => setView('residents_list')}
            residents={residents}
            apiKey={GEMINI_KEY}
          />
        );
      case 'facility_stats':
        return <FacilityStatsPage onBack={() => setView('portal')} />;
      case 'notion_new_residents':
        return <NotionNewResidentsPage onBack={() => setView('portal')} />;
      case 'settings':
        return <SettingsPage onBack={() => setView('portal')} />;
      case 'shift_schedule':
        return <ShiftSchedulePage onBack={() => setView('portal')} />;
      case 'shift_schedule_staff':
        return <ShiftSchedulePage onBack={() => setView('portal')} staffMode />;
      default:
        return (
          <FacilityPortalView
            portalFacilitySearch={portalFacilitySearch}
            setPortalFacilitySearch={setPortalFacilitySearch}
            portalSearchLoading={portalSearchLoading}
            portalFacilitiesFiltered={portalFacilitiesFiltered}
            setSelectedPortalSheetTitle={setSelectedPortalSheetTitle}
            setView={setView}
            onLockPortal={lockProp}
          />
        );
    }
  })();

  return (
    <>
      {main}
      {residentAdminOverlay && selectedResident ? (
        <ResidentAdministrativeModals
          overlay={residentAdminOverlay}
          onClose={() => setResidentAdminOverlay(null)}
          resident={selectedResident}
          portalSheetTitle={selectedPortalSheetTitle}
          residents={residents}
          geminiKey={GEMINI_KEY}
        />
      ) : null}
      {requirePortalAuth && portalAuthUnlocked ? (
        <button
          type="button"
          onClick={lockPortal}
          className="fixed bottom-4 right-4 z-[300] max-w-[min(12rem,calc(100vw-2rem))] rounded-2xl border-2 border-slate-400 bg-white/95 px-3 py-2.5 text-center text-[11px] font-black leading-tight text-slate-800 shadow-lg backdrop-blur-sm transition hover:border-slate-600 hover:bg-slate-50"
        >
          画面をロック
        </button>
      ) : null}
    </>
  );
};

export default App;
