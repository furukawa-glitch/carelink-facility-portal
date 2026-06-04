import React, { useCallback, useEffect, useState } from 'react';
import { Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react';
import { syncCareEventsNow } from '../lib/careEventsAutoSync.js';
import { getCareCloudSyncStatus, probeCareCloudSyncServer } from '../lib/careEventsSupabaseSync.js';
import { CARE_EVENTS_SYNC_EVENT } from '../lib/careEventsRealtimeSync.js';

/**
 * @param {{ onSyncApplied?: () => void }} props
 */
export function CareCloudSyncPanel({ onSyncApplied }) {
  const [status, setStatus] = useState(() => getCareCloudSyncStatus());
  const [busy, setBusy] = useState(false);
  const [lastMsg, setLastMsg] = useState('');
  const [serverOk, setServerOk] = useState(/** @type {boolean | null} */ (null));
  const [serverErr, setServerErr] = useState('');
  const [serverMissing, setServerMissing] = useState(/** @type {string[]} */ ([]));

  const refreshStatus = useCallback(() => setStatus(getCareCloudSyncStatus()), []);

  const checkServer = useCallback(async () => {
    if (!getCareCloudSyncStatus().configured) {
      setServerOk(null);
      setServerErr('');
      setServerMissing([]);
      return;
    }
    const probe = await probeCareCloudSyncServer();
    setServerOk(Boolean(probe.ok));
    setServerErr(probe.ok ? '' : String(probe.error ?? 'サーバーに接続できません'));
    setServerMissing(Array.isArray(probe.missing) ? probe.missing : []);
  }, []);

  useEffect(() => {
    refreshStatus();
    void checkServer();
  }, [refreshStatus, checkServer]);

  const applyResult = useCallback(
    (label, result) => {
      if (result?.skipped) {
        setLastMsg('クラウド同期は無効です（この端末のみ保存）。');
        refreshStatus();
        return;
      }

      const pulled = Number(result?.pulled ?? 0);
      const merged = Number(result?.merged ?? 0);
      const storesMerged = Number(result?.storesMerged ?? 0);
      const pushedEvents = Number(result?.pushedEvents ?? 0);
      const pushedStores = Number(result?.pushedStores ?? 0);

      if (merged > 0 || storesMerged > 0 || pulled > 0) {
        const parts = [];
        if (merged > 0 || pulled > 0) parts.push(`記録${merged}件反映（クラウド${pulled}件）`);
        if (storesMerged > 0) parts.push(`病名・予定${storesMerged}件`);
        if (pushedEvents > 0 || pushedStores > 0) {
          parts.push(`送信 記録${pushedEvents}・その他${pushedStores}`);
        }
        setLastMsg(`${label}: ${parts.join(' / ')}`);
        onSyncApplied?.();
      } else if (pushedEvents > 0 || pushedStores > 0) {
        setLastMsg(`${label}: クラウドへ送信しました（記録${pushedEvents}件・病名等${pushedStores}件）`);
        onSyncApplied?.();
      } else if (serverOk === false) {
        setLastMsg(`${label}: 失敗 — サーバー未設定のためクラウドに届いていません（下記の設定を確認）`);
      } else if (Number(result?.localEventCount ?? 0) > 0 && pulled === 0 && merged === 0) {
        setLastMsg(
          `${label}: この端末に記録${Number(result.localEventCount)}件ありますが、クラウドから0件でした。Supabaseに care_events テーブルがあるか・VITE_CARELINK_ORGANIZATION_ID が organizations のIDと一致するかを確認してください。`
        );
        onSyncApplied?.();
      } else {
        setLastMsg(
          `${label}: クラウドに新しい差分はありません。記録・傷病CSVを入れたPCで同期してから、別PCでも押してください。`
        );
        onSyncApplied?.();
      }
      refreshStatus();
      void checkServer();
    },
    [onSyncApplied, refreshStatus, checkServer, serverOk]
  );

  const syncNowManual = useCallback(async () => {
    setBusy(true);
    setLastMsg('同期中…');
    try {
      const probe = await probeCareCloudSyncServer();
      setServerOk(Boolean(probe.ok));
      setServerMissing(Array.isArray(probe.missing) ? probe.missing : []);
      if (!probe.ok) {
        const err = String(
          probe.error ??
            'Vercel に SUPABASE_SERVICE_ROLE_KEY・CARE_SYNC_SECRET・VITE_SUPABASE_URL が未設定です。設定後に再デプロイしてください。'
        );
        setServerErr(err);
        throw new Error(err);
      }
      setServerErr('');
      const result = await syncCareEventsNow(undefined, { fullPush: true });
      applyResult('手動同期', result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '同期に失敗しました';
      setLastMsg(`同期エラー: ${msg}`);
      setServerOk(false);
      setServerErr(msg);
    } finally {
      setBusy(false);
    }
  }, [applyResult]);

  useEffect(() => {
    const onSync = (ev) => {
      const d = ev?.detail;
      if (Number(d?.merged ?? 0) > 0 || Number(d?.storesMerged ?? 0) > 0) {
        const storePart =
          Number(d?.storesMerged ?? 0) > 0 ? `（病名・予定など ${Number(d.storesMerged)}件）` : '';
        setLastMsg(`自動同期: 記録${Number(d?.merged ?? 0)}件を反映${storePart}`);
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
  }, [onSyncApplied]);

  const warnClient = !status.configured;
  const warnServer = status.configured && serverOk === false;
  const ready = status.configured && serverOk === true;

  const headline = warnClient
    ? status.label
    : warnServer
      ? 'クラウド同期: サーバー未設定（全PCで共有できません）'
      : ready
        ? 'クラウド同期 ON（全PCで自動共有）'
        : 'クラウド同期: 接続確認中…';

  return (
    <div
      className={`mt-2 rounded-xl border-2 px-3 py-2.5 shadow-sm ${
        warnClient || warnServer ? 'border-amber-400 bg-amber-50' : 'border-sky-400 bg-sky-50'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-base font-black text-slate-900 sm:text-lg">
            {warnClient || warnServer ? (
              <CloudOff className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
            ) : (
              <Cloud className="h-4 w-4 shrink-0 text-sky-700" aria-hidden />
            )}
            {headline}
          </p>
          <p className="mt-0.5 text-sm font-bold leading-snug text-slate-700">
            {warnServer ? (
              <>
                {serverErr ||
                  'Vercel の Environment Variables にサーバ用の鍵が未設定です。設定後は必ず再デプロイしてください。'}
                {serverMissing.length > 0 ? (
                  <span className="mt-1 block text-xs text-amber-900">
                    不足: {serverMissing.join('、')}
                  </span>
                ) : null}
                <span className="mt-1 block text-xs text-amber-900">
                  手順: facility-portal/docs/CLOUD_SYNC_SETUP.md（Vercel 設定一覧）
                </span>
              </>
            ) : (
              status.hint
            )}
          </p>
          {lastMsg ? <p className="mt-1 text-sm font-bold text-slate-600">{lastMsg}</p> : null}
        </div>
        {status.configured ? (
          <button
            type="button"
            disabled={busy || serverOk === false}
            onClick={() => void syncNowManual()}
            className="inline-flex items-center gap-1 rounded-lg border-2 border-sky-600 bg-white px-2.5 py-1.5 text-xs font-black text-sky-900 hover:bg-sky-100 disabled:opacity-50"
            title={
              serverOk === false
                ? 'サーバー設定後に有効になります'
                : 'この端末の記録・病名をクラウドへ送り、他PCのデータを取り込みます'
            }
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            今すぐ同期
          </button>
        ) : null}
      </div>
    </div>
  );
}
