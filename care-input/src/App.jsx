import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LogOut, RefreshCw, WifiOff, CloudUpload } from 'lucide-react';
import { isConfigured, DEFAULT_FACILITY, FACILITIES, BUILD_ID } from './config.js';
import { getSession, setSession, clearSession } from './lib/session.js';
import { pullResidents } from './lib/api.js';
import { flush, pendingCount, subscribePending } from './lib/queue.js';
import { LoginScreen } from './screens/LoginScreen.jsx';
import { ResidentListScreen } from './screens/ResidentListScreen.jsx';
import { InputScreen } from './screens/InputScreen.jsx';

/** pull_residents の行を画面用に正規化 */
function normalizeResident(r) {
  const facility =
    String(r?.facilities?.sheet_title ?? '').trim() ||
    String(r?.source_sheet_title ?? '').trim();
  const tabLabel = String(r?.facilities?.tab_label ?? '').trim() || facility;
  return {
    id: String(r?.id ?? r?.legacy_row_key ?? '').trim(),
    name: String(r?.name ?? '').trim(),
    kana: String(r?.name_kana ?? '').trim(),
    room: String(r?.room ?? '').trim(),
    facility,
    tabLabel,
    isEnteral: Boolean(r?.is_enteral),
  };
}

function facilityMatches(resident, facility) {
  const f = String(facility ?? '').trim();
  if (!f) return true;
  const a = String(resident.facility ?? '');
  const b = String(resident.tabLabel ?? '');
  return a === f || b === f || a.includes(f) || f.includes(a) || b.includes(f) || f.includes(b);
}

export default function App() {
  const [session, setSessionState] = useState(() => getSession());
  const [residents, setResidents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedResident, setSelectedResident] = useState(null);
  const [facility, setFacility] = useState(DEFAULT_FACILITY);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(pendingCount());

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => subscribePending(setPending), []);

  const loadResidents = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const rows = await pullResidents();
      setResidents(rows.map(normalizeResident).filter((r) => r.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (session) void loadResidents();
  }, [session, loadResidents]);

  const handleLoggedIn = useCallback((s) => {
    setSession(s);
    setSessionState(s);
  }, []);

  const handleLogout = useCallback(() => {
    clearSession();
    setSessionState(null);
    setSelectedResident(null);
  }, []);

  const facilityResidents = useMemo(
    () =>
      residents
        .filter((r) => facilityMatches(r, facility))
        .sort((a, b) =>
          new Intl.Collator('ja', { numeric: true, sensitivity: 'base' }).compare(
            a.room || a.kana || a.name,
            b.room || b.kana || b.name
          )
        ),
    [residents, facility]
  );

  if (!isConfigured()) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-md rounded-2xl bg-white p-6 shadow">
          <h1 className="text-xl font-black text-rose-700">設定が未完了です</h1>
          <p className="mt-3 text-slate-700">
            このアプリのビルドに <code>VITE_CARELINK_ORGANIZATION_ID</code> と{' '}
            <code>VITE_CARE_SYNC_SECRET</code> がありません。Vercel の環境変数（閲覧用アプリと同じ値）を設定して再デプロイしてください。
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen onLoggedIn={handleLoggedIn} />;
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-teal-700 px-3 py-2 text-white shadow">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold opacity-90">
            {facility || 'ケア入力'}
          </div>
          <div className="truncate text-xs opacity-80">{session.staff?.displayName} さん</div>
        </div>
        {!online && (
          <span className="flex items-center gap-1 rounded bg-amber-500 px-2 py-1 text-xs font-bold">
            <WifiOff className="h-4 w-4" /> オフライン
          </span>
        )}
        {pending > 0 && (
          <button
            type="button"
            onClick={() => void flush()}
            className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 text-xs font-bold"
            title="未送信の記録を送信"
          >
            <CloudUpload className="h-4 w-4" /> 未送信 {pending}
          </button>
        )}
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-1 rounded bg-white/15 px-2 py-2 text-xs font-bold"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      {FACILITIES.length > 1 && !selectedResident && (
        <div className="flex flex-wrap gap-2 bg-white px-3 py-2">
          {FACILITIES.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFacility(f)}
              className={`rounded-lg border px-3 py-1 text-sm font-bold ${
                facility === f
                  ? 'border-teal-600 bg-teal-600 text-white'
                  : 'border-slate-300 bg-white text-slate-700'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      <main className="flex-1 p-3">
        {error && (
          <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
            {error}
          </div>
        )}
        {selectedResident ? (
          <InputScreen
            resident={selectedResident}
            staffName={session.staff?.displayName ?? ''}
            onBack={() => setSelectedResident(null)}
          />
        ) : (
          <ResidentListScreen
            residents={facilityResidents}
            loading={loading}
            onReload={loadResidents}
            onSelect={setSelectedResident}
          />
        )}
      </main>

      <footer className="px-3 py-2 text-center text-[10px] text-slate-400">
        ケア入力 build {BUILD_ID}
        <button type="button" onClick={() => void loadResidents()} className="ml-2 inline-flex items-center gap-1">
          <RefreshCw className="h-3 w-3" /> 名簿更新
        </button>
      </footer>
    </div>
  );
}
