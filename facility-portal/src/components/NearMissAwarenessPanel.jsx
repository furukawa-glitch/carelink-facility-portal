import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UserCircle,
} from 'lucide-react';
import { getNoticeAudienceSummaryLabel } from '../config/nearMissAudienceRules.js';
import {
  confirmNotice,
  formatNearMissGasWriteError,
  getActiveNoticesForViewer,
  getArchivedNoticesForFacility,
  getLedgerSpreadsheetId,
  getSyncedRosterPayload,
  getStaffProfile,
  isNearMissGasWriteConfigured,
  refreshLedgerFromSpreadsheet,
  saveStaffProfile,
  syncStaffRosterFromHrSheetAndStore,
  syncStaffRosterFromShiftScheduleAndStore,
} from '../services/NearMissLedgerService.js';

/**
 * Google API の生エラーを運用者向け文言に変換
 * @param {unknown} err
 */
function friendlySheetError(err) {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/caller does not have permission|permission denied|insufficient permissions/i.test(msg)) {
    return 'スプレッドシートの閲覧権限が不足しています。対象シートを「リンクを知っている全員が閲覧可」にするか、APIキーの許可設定（Google Sheets API）を確認してください。';
  }
  if (/requested entity was not found|not found|404/i.test(msg)) {
    return 'スプレッドシートIDまたはシート名が見つかりません。ID・タブ名の設定を確認してください。';
  }
  if (/quota|rate|429|resource_exhausted/i.test(msg)) {
    return 'Google API の利用上限に達しました。しばらく待ってから再度お試しください。';
  }
  return msg || 'スプレッドシートの取得に失敗しました';
}

/**
 * @param {{
 *   sheetsApiKey: string;
 *   facilityLinkKey: string;
 *   facilityTabLabel: string;
 *   onOpenAdmin: () => void;
 *   compact?: boolean;
 * }} props
 */
export function NearMissAwarenessPanel({
  sheetsApiKey,
  facilityLinkKey,
  facilityTabLabel,
  onOpenAdmin,
  compact = false,
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  /** 訪問看護・特別指示の手動登録など看護事務向け UI */
  const [nursingOfficeMode, setNursingOfficeMode] = useState(false);
  const [rev, setRev] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState('');

  const prof = useMemo(() => getStaffProfile(), [rev]);
  const lk = String(facilityLinkKey ?? '').trim();

  useEffect(() => {
    const p = getStaffProfile();
    setProfileName(p?.displayName ?? '');
    setNursingOfficeMode(Boolean(p?.nursingOfficeMode));
  }, [rev]);

  const refreshSheet = useCallback(async () => {
    const key = String(sheetsApiKey ?? '').trim();
    const id = getLedgerSpreadsheetId().trim();
    if (!key || !id) {
      setErr('');
      return;
    }
    setLoading(true);
    setErr('');
    try {
      await refreshLedgerFromSpreadsheet(key);
      setRev((x) => x + 1);
    } catch (e) {
      setErr(friendlySheetError(e));
    } finally {
      setLoading(false);
    }
  }, [sheetsApiKey]);

  useEffect(() => {
    void refreshSheet();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初回のみ自動同期
  }, []);

  /** 1日1回: 環境変数で勤務表優先、なければ求人シートからスタッフ名簿を同期 */
  useEffect(() => {
    const dayKey = `${new Date().getFullYear()}-${new Date().getMonth()}-${new Date().getDate()}`;
    const autoShift = String(import.meta.env.VITE_NEAR_MISS_AUTO_ROSTER_SOURCE ?? '')
      .trim()
      .toLowerCase();
    if (autoShift === 'shift') {
      const last = sessionStorage.getItem('carelink_shift_roster_sync_day');
      if (last === dayKey) return;
      try {
        syncStaffRosterFromShiftScheduleAndStore();
        sessionStorage.setItem('carelink_shift_roster_sync_day', dayKey);
        setRev((x) => x + 1);
      } catch {
        // 勤務表データ未登録時は黙ってスキップ
      }
      return;
    }
    const key = String(sheetsApiKey ?? '').trim();
    if (!key) return;
    const last = sessionStorage.getItem('carelink_hr_roster_sync_day');
    if (last === dayKey) return;
    void (async () => {
      try {
        await syncStaffRosterFromHrSheetAndStore(key);
        sessionStorage.setItem('carelink_hr_roster_sync_day', dayKey);
        setRev((x) => x + 1);
      } catch {
        // キー・シート未整備時は黙ってスキップ
      }
    })();
  }, [sheetsApiKey]);

  const pending = useMemo(() => {
    const p = getStaffProfile();
    if (!p?.staffId || !lk) return [];
    return getActiveNoticesForViewer(lk, p.staffId);
  }, [lk, rev]);

  const archived = useMemo(() => getArchivedNoticesForFacility(lk), [lk, rev]);

  const persistProfile = useCallback(() => {
    saveStaffProfile({ displayName: profileName, lastFacilityLinkKey: lk, nursingOfficeMode });
    setRev((x) => x + 1);
  }, [profileName, lk, nursingOfficeMode]);

  const onConfirm = async (id) => {
    if (!profileName.trim()) {
      alert('スタッフ氏名を入力して「保存」してください');
      return;
    }
    persistProfile();
    setConfirmBusy(String(id));
    try {
      const result = await confirmNotice(id, lk);
      if (result.duplicate) {
        setRev((x) => x + 1);
        return;
      }
      const sr = result.sheetResult;
      if (sr?.skipped) {
        alert(
          `確認はこの端末に記録しましたが、スプレッドシートには追記できません。\n${String(sr.reason || 'GAS URL 未設定')}\n\n対処: .env.local に VITE_NEAR_MISS_APPS_SCRIPT_URL（と開発用の VITE_NEAR_MISS_APP_SECRET）を設定し、npm run dev を再起動してください。本番（Vercel）では同じ変数に加え、シークレットを Environment Variables に設定してください。`
        );
      } else if (sr && !sr.ok) {
        alert(
          `スプレッドシートへの確認ログ追記に失敗しました: ${formatNearMissGasWriteError(sr.error)}\n` +
            'ヒント: .env.local 更新後は npm run dev の再起動が必要です。本番では Vercel の環境変数と /api/near-miss-gas のデプロイを確認し、GAS のデプロイ・シート権限も確認してください。'
        );
      }
      setRev((x) => x + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : '確認の記録に失敗しました');
    } finally {
      setConfirmBusy('');
    }
  };

  const hasSheet = Boolean(sheetsApiKey?.trim() && getLedgerSpreadsheetId().trim());
  const hrSync = getSyncedRosterPayload();
  const pendingHighCount = pending.filter((n) => n.importance === 'high').length;
  const shell = compact
    ? 'shrink-0 rounded-xl border border-amber-500/70 bg-gradient-to-br from-amber-50/95 via-white to-orange-50/80 px-2 py-2 shadow-sm sm:px-3 sm:py-2.5'
    : 'shrink-0 rounded-2xl border-2 border-amber-500/80 bg-gradient-to-br from-amber-50 via-white to-orange-50/90 px-3 py-3 shadow-md sm:px-4 sm:py-4';
  const closedShell = compact
    ? 'shrink-0 rounded-lg border border-amber-300/70 bg-white/95 px-2 py-1.5 shadow-sm'
    : 'shrink-0 rounded-xl border border-amber-300/70 bg-white/95 px-3 py-2 shadow-sm';

  if (!panelOpen) {
    return (
      <section className={closedShell}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex min-w-0 items-center gap-1.5">
            <ShieldAlert className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} shrink-0 text-amber-700`} aria-hidden />
            <p className={`truncate font-bold text-slate-700 ${compact ? 'text-[10px]' : 'text-xs'}`}>
              最新の重要周知（ヒヤリハット）
            </p>
            <span
              className={`inline-flex shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 font-black text-amber-900 ${compact ? 'text-[10px]' : 'text-xs'}`}
            >
              未確認 {pending.length}件
              {pendingHighCount > 0 ? ` / 重要 ${pendingHighCount}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className={`inline-flex items-center gap-1 rounded-lg border-2 border-amber-700 bg-white font-black text-amber-900 hover:bg-amber-50 ${compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]'}`}
            >
              <ChevronDown className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
              周知を開く
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={shell}>
      <div className={`flex flex-wrap items-start justify-between gap-2 ${compact ? 'mb-1.5' : 'mb-2'}`}>
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <ShieldAlert
            className={`shrink-0 text-amber-700 ${compact ? 'h-5 w-5' : 'h-6 w-6 sm:h-7 sm:w-7'}`}
            aria-hidden
          />
          <div className="min-w-0">
            <h2 className={`font-black text-amber-950 ${compact ? 'text-sm sm:text-base' : 'text-base sm:text-lg'}`}>
              最新の重要周知（ヒヤリハット）
            </h2>
            <p className={`font-bold text-amber-900/80 ${compact ? 'text-[10px] leading-snug sm:text-[11px]' : 'text-[11px] sm:text-xs'}`}>
              {facilityTabLabel ? `${facilityTabLabel}：` : ''}
              未確認の周知を上に表示します。内容を読んだら「確認しました」を押してください。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            className={`inline-flex items-center gap-1 rounded-lg border-2 border-amber-700 bg-white font-black text-amber-900 hover:bg-amber-50 ${compact ? 'px-2 py-1 text-[10px] sm:text-[11px]' : 'rounded-xl px-2.5 py-1.5 text-[11px] sm:text-xs'}`}
          >
            <ChevronUp className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            周知を閉じる
          </button>
          <button
            type="button"
            onClick={() => onOpenAdmin()}
            className={`inline-flex items-center gap-1 rounded-lg border-2 border-slate-600 bg-slate-800 font-black text-white hover:bg-slate-700 ${compact ? 'px-2 py-1 text-[10px] sm:text-[11px]' : 'rounded-xl px-2.5 py-1.5 text-[11px] sm:text-xs'}`}
          >
            <LayoutDashboard className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            管理・進捗
          </button>
          <button
            type="button"
            disabled={!hasSheet || loading}
            onClick={() => void refreshSheet()}
            className={`inline-flex items-center gap-1 rounded-lg border-2 border-amber-600 bg-amber-100 font-black text-amber-950 hover:bg-amber-200 disabled:opacity-50 ${compact ? 'px-2 py-1 text-[10px] sm:text-[11px]' : 'rounded-xl px-2.5 py-1.5 text-[11px] sm:text-xs'}`}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />}
            台帳を同期
          </button>
        </div>
      </div>
      <>
          {!hasSheet ? (
            <p
              className={`rounded-lg border border-amber-200 bg-white/80 px-2 py-1.5 font-bold text-amber-900 ${compact ? 'mb-1.5 text-[10px] sm:text-[11px]' : 'mb-2 text-[11px] sm:text-xs'}`}
            >
              `.env` に `VITE_AWARENESS_SPREADSHEET_ID`（周知ログ保存先）と
              `VITE_HR_SPREADSHEET_ID`（求人・入退社名簿）および `VITE_GOOGLE_SHEETS_API_KEY` を設定すると、台帳・スタッフ名簿を同期できます。未設定時は既定 ID
              を使います。未設定時はこの端末の保存のみです。
            </p>
          ) : null}

          {hasSheet && !isNearMissGasWriteConfigured() ? (
            <p
              className={`rounded-lg border border-rose-200 bg-rose-50/90 px-2 py-1.5 font-bold text-rose-900 ${compact ? 'mb-1.5 text-[10px] sm:text-[11px]' : 'mb-2 text-[11px] sm:text-xs'}`}
            >
              ヒヤリの<strong>記入・確認をスプレッドシートに反映</strong>するには、GAS Web アプリの URL（
              <code className="rounded bg-white/80 px-0.5">VITE_NEAR_MISS_APPS_SCRIPT_URL</code>
              ）が必要です。追記は同一オリジンの <code className="rounded bg-white/80 px-0.5">/api/near-miss-gas</code>{' '}
              経由で行います。開発時は <code className="rounded bg-white/80 px-0.5">VITE_NEAR_MISS_APP_SECRET</code>
              、本番（Vercel）では <code className="rounded bg-white/80 px-0.5">NEAR_MISS_APP_SECRET</code> などサーバー環境変数に合言葉を設定してください。未設定のときはブラウザ内のログのみ保存されます。
            </p>
          ) : null}

          {hrSync?.syncedAt ? (
            <p className={`text-[10px] font-bold text-slate-600 ${compact ? 'mb-1 line-clamp-2' : 'mb-2'}`}>
              スタッフ名簿（{hrSync.meta?.source === 'shift_schedule' ? '勤務表' : '求人シート'}）:{' '}
              {String(hrSync.sheetTitle ?? '')} ・ {String(hrSync.syncedAt ?? '').slice(0, 19).replace('T', ' ')} ・{' '}
              {hrSync.meta?.rowCount ?? 0} 名
            </p>
          ) : null}

          {err ? (
            <p
              className={`rounded-lg border border-rose-300 bg-rose-50 px-2 py-1.5 font-bold text-rose-900 ${compact ? 'mb-1.5 text-[10px]' : 'mb-2 text-[11px]'}`}
            >
              {err}
            </p>
          ) : null}

          <div
            className={`flex flex-wrap items-end gap-2 rounded-lg border border-amber-200/90 bg-white/90 ${compact ? 'mb-2 p-1.5' : 'mb-3 p-2'}`}
          >
            <UserCircle className={`shrink-0 text-slate-500 ${compact ? 'h-4 w-4' : 'h-5 w-5'}`} />
            <label className="flex min-w-[10rem] flex-1 flex-col gap-0.5 sm:min-w-[12rem]">
              <span className={`font-bold text-slate-600 ${compact ? 'text-[9px]' : 'text-[10px]'}`}>あなたの氏名（確認記録に使用）</span>
              <input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                onBlur={() => persistProfile()}
                placeholder="例: 山田 花子"
                className={`rounded-lg border border-slate-300 font-bold text-slate-900 ${compact ? 'px-2 py-1 text-xs' : 'px-2 py-1.5 text-sm'}`}
              />
            </label>
            <button
              type="button"
              onClick={() => persistProfile()}
              className={`rounded-lg bg-slate-800 font-black text-white hover:bg-slate-700 ${compact ? 'px-2.5 py-1.5 text-[11px]' : 'px-3 py-2 text-xs'}`}
            >
              保存
            </button>
            {prof?.displayName ? (
              <span className="text-[10px] font-bold text-slate-500">ID: {prof.staffId.slice(0, 8)}…</span>
            ) : null}
          </div>

          {pending.length === 0 ? (
            <p
              className={`rounded-lg border border-emerald-200 bg-emerald-50/90 font-bold text-emerald-900 ${compact ? 'px-2 py-2 text-xs' : 'rounded-xl px-3 py-3 text-sm'}`}
            >
              <CheckCircle2 className={`inline text-emerald-600 ${compact ? 'mb-0 mr-0.5 h-4 w-4' : 'mb-1 h-5 w-5'}`} aria-hidden />{' '}
              未確認のヒヤリ周知はありません（この施設・この端末の確認状況）。
            </p>
          ) : (
            <ul className={`space-y-2 ${compact ? 'max-h-52 overflow-y-auto pr-0.5' : ''}`}>
              {pending.map((n) => (
                <li
                  key={String(n.id)}
                  className={`rounded-xl border-2 px-3 py-2.5 shadow-sm sm:px-4 ${
                    n.importance === 'high'
                      ? 'border-rose-400 bg-rose-50/95'
                      : 'border-amber-200 bg-white'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {n.importance === 'high' ? (
                        <span className="mb-1 inline-flex items-center gap-1 rounded-md bg-rose-600 px-1.5 py-0.5 text-[10px] font-black text-white">
                          <AlertTriangle className="h-3 w-3" />
                          重要
                        </span>
                      ) : null}
                      <p className="text-sm font-black text-slate-900 sm:text-base">{n.title}</p>
                      <p className="mt-1 text-xs font-bold leading-relaxed text-slate-700 sm:text-sm">
                        {n.summary || '（詳細はヒヤリハット報告の保存データを参照）'}
                      </p>
                      {n.categories?.length ? (
                        <p className="mt-1 text-[10px] font-bold text-slate-500">
                          カテゴリ: {n.categories.join('、')}
                        </p>
                      ) : null}
                      {getNoticeAudienceSummaryLabel(n) ? (
                        <p className="mt-1 text-[10px] font-bold text-indigo-900">周知範囲: {getNoticeAudienceSummaryLabel(n)}</p>
                      ) : null}
                      <p className="mt-1 text-[10px] font-bold text-slate-400">
                        {String(n.createdAt ?? '').slice(0, 19).replace('T', ' ')}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={confirmBusy === String(n.id)}
                      onClick={() => onConfirm(n.id)}
                      className="shrink-0 rounded-xl bg-teal-600 px-4 py-2.5 text-xs font-black text-white shadow-md hover:bg-teal-500 disabled:opacity-60 sm:text-sm"
                    >
                      {confirmBusy === String(n.id) ? '記録中…' : '内容を確認しました'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={() => setArchiveOpen((v) => !v)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-slate-100/80 py-2 text-xs font-black text-slate-700 hover:bg-slate-200"
          >
            {archiveOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            過去ログ（全員確認済みでアーカイブ） {archived.length ? `(${archived.length}件)` : ''}
          </button>
          {archiveOpen ? (
            <ul
              className={`mt-2 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white/90 p-2 font-bold text-slate-600 ${compact ? 'max-h-36 text-[10px]' : 'max-h-48 text-xs'}`}
            >
              {archived.length === 0 ? (
                <li className="py-2 text-center text-slate-400">アーカイブはまだありません</li>
              ) : (
                archived.map((n) => (
                  <li key={String(n.id)} className="border-b border-slate-100 py-1 last:border-0">
                    <span className="text-slate-400">{String(n.createdAt ?? '').slice(0, 10)}</span> {n.title}
                  </li>
                ))
              )}
            </ul>
          ) : null}

          <div
            className={`mt-3 border-t border-slate-200 pt-3 ${compact ? 'rounded-lg' : 'rounded-xl'} border border-slate-200/80 bg-slate-50/90 px-2 py-2`}
          >
            <p className={`mb-2 font-black text-slate-700 ${compact ? 'text-[10px]' : 'text-xs'}`}>
              看護事務モード（ヒヤリ周知とは別）
            </p>
            <label
              className={`flex cursor-pointer items-start gap-2 text-left ${compact ? 'text-[10px] sm:text-[11px]' : 'text-[11px] sm:text-xs'}`}
            >
              <input
                type="checkbox"
                checked={nursingOfficeMode}
                onChange={(e) => {
                  const v = e.target.checked;
                  setNursingOfficeMode(v);
                  saveStaffProfile({
                    displayName: profileName,
                    lastFacilityLinkKey: lk,
                    nursingOfficeMode: v,
                  });
                  setRev((x) => x + 1);
                }}
                className="mt-0.5 h-4 w-4 shrink-0 accent-slate-800"
              />
              <span className="font-bold leading-snug text-slate-800">
                <span className="font-black">訪問看護・特別指示用のメニューを表示</span>
                <span className="mt-0.5 block font-bold text-slate-600">
                  ON にした端末の<strong className="font-black">クイック記録</strong>だけに、手動登録と人数集計が出ます。ヒヤリハット・事故の周知表示には影響しません。
                </span>
              </span>
            </label>
          </div>
      </>
    </section>
  );
}
