import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, HardDrive, Lock, Moon, Clock } from 'lucide-react';
import { CARE_RECORD_RETENTION_YEARS } from '../lib/careRecordRetention.js';
import {
  isBackupAdminPasswordConfigured,
  verifyBackupAdminPassword,
} from '../lib/careBackupAdminAuth.js';
import {
  downloadCareDataBackupJson,
  importCareDataBackupFromFile,
} from '../lib/careDataBackup.js';
import {
  isNightShiftCorrectionWindow,
  readAutoBackupLog,
  runCareBackupToAllTargets,
  startAutoBackup2359Scheduler,
  suggestedBulkInputYmdForNow,
} from '../lib/careAutoBackup.js';
import {
  isFileSystemAccessSupported,
  loadBackupDirectoryHandle,
  saveBackupDirectoryHandle,
} from '../lib/careBackupDirIdb.js';
import * as Report from '../services/ReportService.js';

const BACKUP_ADMIN_RELOCK_AFTER_HIDDEN_MS = 90_000;

/**
 * @param {{
 *   facilityLabel: string;
 *   retentionSummary: { total: number; oldestYmd: string };
 *   onBackupDone?: () => void;
 *   onOpenBulkForYmd?: (ymd: string) => void;
 * }} props
 */
export function CareAutoBackupPanel({
  facilityLabel,
  retentionSummary,
  onBackupDone,
  onOpenBulkForYmd,
}) {
  const [status, setStatus] = useState('');
  const [autoLog, setAutoLog] = useState(() => readAutoBackupLog());
  const [ssdPrimary, setSsdPrimary] = useState(false);
  const [ssdSecondary, setSsdSecondary] = useState(false);
  const adminPinConfigured = isBackupAdminPasswordConfigured();
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPinDraft, setAdminPinDraft] = useState('');
  const [adminPinErr, setAdminPinErr] = useState('');
  const [showAdminPinForm, setShowAdminPinForm] = useState(false);
  const adminUnlockedRef = useRef(adminUnlocked);
  const adminTabHiddenAtRef = useRef(0);
  adminUnlockedRef.current = adminUnlocked;
  const fsSupported = isFileSystemAccessSupported();
  const nightWindow = isNightShiftCorrectionWindow();
  const suggestYmd = suggestedBulkInputYmdForNow();

  const refreshLog = useCallback(() => setAutoLog(readAutoBackupLog()), []);

  const runBackup = useCallback(
    async (trigger) => {
      try {
        const entry = await runCareBackupToAllTargets(facilityLabel, trigger);
        setStatus(
          `${trigger === 'auto2359' ? '自動' : '手動'}バックアップ完了: ${entry.writtenTo.join(' / ')}（記録 ${entry.stats.careEvents} 件）`
        );
        refreshLog();
        onBackupDone?.();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : 'バックアップ失敗');
      }
    },
    [facilityLabel, onBackupDone, refreshLog]
  );

  useEffect(() => {
    void (async () => {
      if (!fsSupported) return;
      const p = await loadBackupDirectoryHandle('primary');
      const s = await loadBackupDirectoryHandle('secondary');
      setSsdPrimary(Boolean(p));
      setSsdSecondary(Boolean(s));
    })();
  }, [fsSupported]);

  useEffect(() => {
    return startAutoBackup2359Scheduler(() => runBackup('auto2359'));
  }, [runBackup]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        adminTabHiddenAtRef.current = Date.now();
        return;
      }
      const t0 = adminTabHiddenAtRef.current;
      if (t0 && Date.now() - t0 > BACKUP_ADMIN_RELOCK_AFTER_HIDDEN_MS && adminUnlockedRef.current) {
        setAdminUnlocked(false);
        setShowAdminPinForm(false);
        setAdminPinDraft('');
        setAdminPinErr('');
      }
      adminTabHiddenAtRef.current = 0;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const submitAdminPin = (e) => {
    e?.preventDefault?.();
    if (!adminPinConfigured) {
      setAdminPinErr(
        '管理者PINが未設定です。Vercel → Environment Variables に VITE_BACKUP_ADMIN_PASSWORD を追加し、再デプロイしてください。'
      );
      return;
    }
    if (verifyBackupAdminPassword(adminPinDraft)) {
      setAdminUnlocked(true);
      setAdminPinErr('');
      setAdminPinDraft('');
      setShowAdminPinForm(false);
    } else {
      setAdminPinErr('管理者PINが違います。');
    }
  };

  const lockAdminPanel = () => {
    setAdminUnlocked(false);
    setShowAdminPinForm(false);
    setAdminPinDraft('');
    setAdminPinErr('');
  };

  const pickSsdFolder = useCallback(async (slot) => {
    if (!fsSupported) {
      setStatus('このブラウザはSSD直接保存に未対応です（Chrome/Edge をご利用ください）');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'desktop',
      });
      await saveBackupDirectoryHandle(slot, dir);
      if (slot === 'primary') setSsdPrimary(true);
      else setSsdSecondary(true);
      setStatus(`${slot === 'primary' ? 'SSD①' : 'SSD②'}: ${dir.name} を保存先に登録しました`);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setStatus(e instanceof Error ? e.message : 'フォルダ選択に失敗しました');
    }
  }, [fsSupported]);

  const lastAuto = autoLog[0];

  return (
    <div className="mt-2 space-y-2">
      {nightWindow ? (
        <div className="rounded-lg border border-indigo-300 bg-indigo-50 px-2 py-2 text-[10px] font-bold leading-snug text-indigo-950">
          <p className="mb-1 flex items-center gap-1 text-indigo-900">
            <Moon className="h-3.5 w-3.5" aria-hidden />
            夜勤・前日分の入力・修正
          </p>
          <p>
            0時〜8時は「前日」の記録を直す時間帯として想定しています。23:59のバックアップ<strong>後</strong>に修正しても問題ありません（次の23:59バックアップに反映されます）。
          </p>
          {onOpenBulkForYmd ? (
            <button
              type="button"
              onClick={() => onOpenBulkForYmd(suggestYmd)}
              className="mt-2 rounded-lg border-2 border-indigo-500 bg-indigo-600 px-3 py-1.5 text-xs font-black text-white hover:bg-indigo-500"
            >
              前日分（{suggestYmd}）を一覧表で開く
            </button>
          ) : null}
        </div>
      ) : null}

      {!adminUnlocked ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-[10px] font-bold leading-snug text-slate-600">
            生活記録は<strong> 毎日23:59</strong>に自動保存されます（法定{CARE_RECORD_RETENTION_YEARS}年・ブラウザ内＋SSD）。
            {lastAuto ? (
              <span className="ml-1 text-slate-500">
                最終バックアップ: {lastAuto.backupYmd} {lastAuto.timeLabel}
              </span>
            ) : null}
            <br />
            <span className="text-slate-500">SSD・手動バックアップ・復元は管理者のみ操作できます。</span>
          </p>
          {showAdminPinForm ? (
            <form onSubmit={submitAdminPin} className="mt-2 flex flex-wrap items-end gap-2">
              <label className="min-w-[8rem] flex-1 text-left">
                <span className="mb-0.5 block text-[10px] font-black text-slate-600">管理者PIN</span>
                <input
                  type="password"
                  value={adminPinDraft}
                  onChange={(e) => {
                    setAdminPinDraft(e.target.value);
                    if (adminPinErr) setAdminPinErr('');
                  }}
                  className="w-full rounded-lg border-2 border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-800"
                  autoComplete="off"
                  autoFocus
                />
              </label>
              <button
                type="submit"
                className="rounded-lg border-2 border-slate-600 bg-slate-700 px-3 py-1.5 text-xs font-black text-white hover:bg-slate-600"
              >
                解除
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAdminPinForm(false);
                  setAdminPinDraft('');
                  setAdminPinErr('');
                }}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600"
              >
                キャンセル
              </button>
              {adminPinErr ? (
                <p className="w-full text-[10px] font-bold text-rose-600" role="alert">
                  {adminPinErr}
                </p>
              ) : null}
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setShowAdminPinForm(true)}
              className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-400 bg-white px-2.5 py-1 text-[10px] font-black text-slate-700 hover:bg-slate-100"
            >
              <Lock className="h-3 w-3" aria-hidden />
              管理者用（SSD・バックアップ）
            </button>
          )}
        </div>
      ) : (
        <>
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] font-bold leading-snug text-amber-900">
        <strong className="text-amber-950">GitHub には記録は保存されません</strong>（プログラムのソースのみ）。
        生活記録は<strong> ①ブラウザ内 ②接続SSD</strong>の2か所＋毎日
        <strong> 23:59 自動バックアップ</strong>（法定{CARE_RECORD_RETENTION_YEARS}年）。
        現在 <strong>{retentionSummary.total.toLocaleString()} 件</strong>
        {retentionSummary.oldestYmd ? `（最古 ${retentionSummary.oldestYmd}）` : ''}。
      </p>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2 py-2">
        <button
          type="button"
          onClick={lockAdminPanel}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-400 bg-white px-2 py-1 text-[10px] font-black text-slate-600 hover:bg-slate-100"
          title="バックアップ操作をロック"
        >
          <Lock className="h-3 w-3" aria-hidden />
          ロック
        </button>
        <button
          type="button"
          onClick={() => runBackup('manual')}
          className="inline-flex items-center gap-1.5 rounded-lg border-2 border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-black text-white hover:bg-emerald-500"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          今すぐバックアップ
        </button>
        {fsSupported ? (
          <>
            <button
              type="button"
              onClick={() => pickSsdFolder('primary')}
              className="inline-flex items-center gap-1 rounded-lg border-2 border-slate-400 bg-white px-2.5 py-1.5 text-xs font-black text-slate-800 hover:bg-slate-100"
            >
              <HardDrive className="h-3.5 w-3.5" aria-hidden />
              SSD①フォルダ
              {ssdPrimary ? ' ✓' : ''}
            </button>
            <button
              type="button"
              onClick={() => pickSsdFolder('secondary')}
              className="inline-flex items-center gap-1 rounded-lg border-2 border-slate-400 bg-white px-2.5 py-1.5 text-xs font-black text-slate-800 hover:bg-slate-100"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              SSD②フォルダ
              {ssdSecondary ? ' ✓' : ''}
            </button>
          </>
        ) : (
          <span className="text-[10px] font-bold text-slate-500">SSD自動保存: Chrome/Edge 推奨</span>
        )}
        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-600">
          <Clock className="h-3 w-3" aria-hidden />
          毎日 23:59 JST 自動
          {lastAuto ? ` / 最終: ${lastAuto.backupYmd} ${lastAuto.timeLabel}` : ''}
        </span>
        {status ? <span className="text-[10px] font-bold text-emerald-800">{status}</span> : null}
      </div>

      <details className="text-[10px] font-bold text-slate-600">
        <summary className="cursor-pointer text-slate-700">復元・手動JSON・ログ</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => downloadCareDataBackupJson(facilityLabel)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-black"
          >
            PCにダウンロード
          </button>
          <RestoreButtons
            onImport={async (file, mode) => {
              await importCareDataBackupFromFile(file, mode);
              Report.reloadCareEventsFromStorage();
              onBackupDone?.();
              setStatus('復元しました');
            }}
          />
        </div>
        {autoLog.length ? (
          <ul className="mt-2 max-h-24 overflow-auto rounded border border-slate-200 bg-white p-1">
            {autoLog.slice(0, 8).map((e, i) => (
              <li key={`${e.at}-${i}`} className="border-b border-slate-100 py-0.5 last:border-0">
                {e.backupYmd} {e.trigger === 'auto2359' ? '自動' : '手動'} → {e.writtenTo?.join(', ')}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
        </>
      )}
    </div>
  );
}

/** @param {{ onImport: (file: File, mode: 'merge' | 'replace') => Promise<void> }} props */
function RestoreButtons({ onImport }) {
  const inputRef = React.useRef(/** @type {HTMLInputElement | null} */ (null));
  const [mode, setMode] = React.useState(/** @type {'merge' | 'replace'} */ ('merge'));

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMode('merge');
          inputRef.current?.click();
        }}
        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-black"
      >
        復元（追加）
      </button>
      <button
        type="button"
        onClick={() => {
          if (!window.confirm('この端末の記録を上書きします。よろしいですか？')) return;
          setMode('replace');
          inputRef.current?.click();
        }}
        className="rounded-lg border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-black text-rose-900"
      >
        復元（上書き）
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) await onImport(f, mode);
          if (inputRef.current) inputRef.current.value = '';
        }}
      />
    </>
  );
}
