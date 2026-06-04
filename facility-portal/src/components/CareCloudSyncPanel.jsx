import React, { useCallback, useEffect, useState } from 'react';
import { Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react';
import { syncCareEventsNow } from '../lib/careEventsAutoSync.js';
import { getCareCloudSyncStatus } from '../lib/careEventsSupabaseSync.js';
import { CARE_EVENTS_SYNC_EVENT } from '../lib/careEventsRealtimeSync.js';

/**
 * @param {{ onSyncApplied?: () => void }} props
 */
export function CareCloudSyncPanel({ onSyncApplied }) {
  const [status, setStatus] = useState(() => getCareCloudSyncStatus());
  const [busy, setBusy] = useState(false);
  const [lastMsg, setLastMsg] = useState('');

  const refreshStatus = useCallback(() => setStatus(getCareCloudSyncStatus()), []);

  const applyResult = useCallback(
    (label, result) => {
      const pulled = Number(result?.pulled ?? 0);
      const merged = Number(result?.merged ?? 0);
      const upserted = Number(result?.upserted ?? 0);
      if (result?.skipped) {
        setLastMsg('クラウド同期は無効です（この端末のみ保存）。');
      } else if (merged > 0 || pulled > 0) {
        setLastMsg(`${label}: ${merged}件反映（クラウド ${pulled}件）`);
        onSyncApplied?.();
      } else if (upserted > 0) {
        setLastMsg(`${label}: ${upserted}件をクラウドへ反映しました`);
        onSyncApplied?.();
      } else {
        setLastMsg(`${label}: 最新の状態です`);
      }
      refreshStatus();
    },
    [onSyncApplied, refreshStatus]
  );

  const syncNowManual = useCallback(async () => {
    setBusy(true);
    setLastMsg('');
    try {
      const result = await syncCareEventsNow();
      applyResult('手動同期', result);
    } catch (e) {
      setLastMsg(e instanceof Error ? e.message : '同期に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [applyResult]);

  useEffect(() => {
    refreshStatus();
    const onSync = (ev) => {
      const d = ev?.detail;
      if (Number(d?.merged ?? 0) > 0) {
        setLastMsg(`自動同期: ${Number(d?.merged ?? 0)}件を反映しました`);
        onSyncApplied?.();
      } else if (Number(d?.upserted ?? 0) > 0 && d?.bootstrap) {
        setLastMsg(`初回送信: ${Number(d?.upserted ?? 0)}件をクラウドへ載せました`);
        onSyncApplied?.();
      } else if (Number(d?.upserted ?? 0) > 0) {
        setLastMsg(`自動送信: ${Number(d?.upserted ?? 0)}件`);
      }
    };
    window.addEventListener(CARE_EVENTS_SYNC_EVENT, onSync);
    return () => window.removeEventListener(CARE_EVENTS_SYNC_EVENT, onSync);
  }, [onSyncApplied, refreshStatus]);

  const warn = !status.configured;

  return (
    <div
      className={`mt-2 rounded-xl border-2 px-3 py-2.5 shadow-sm ${
        warn ? 'border-amber-400 bg-amber-50' : 'border-sky-400 bg-sky-50'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-black text-slate-900">
            {warn ? <CloudOff className="h-4 w-4 shrink-0 text-amber-700" aria-hidden /> : <Cloud className="h-4 w-4 shrink-0 text-sky-700" aria-hidden />}
            {status.label}
          </p>
          <p className="mt-0.5 text-xs font-bold leading-snug text-slate-700">{status.hint}</p>
          {lastMsg ? <p className="mt-1 text-xs font-bold text-slate-600">{lastMsg}</p> : null}
        </div>
        {status.configured ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void syncNowManual()}
            className="inline-flex items-center gap-1 rounded-lg border-2 border-sky-600 bg-white px-2.5 py-1.5 text-xs font-black text-sky-900 hover:bg-sky-100 disabled:opacity-60"
            title="通常は自動同期のため不要です"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            今すぐ同期
          </button>
        ) : null}
      </div>
    </div>
  );
}
