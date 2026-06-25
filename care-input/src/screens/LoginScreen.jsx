import React, { useState } from 'react';
import { LogIn, Loader2 } from 'lucide-react';
import { login } from '../lib/api.js';

/** @param {{ onLoggedIn: (session: object) => void }} props */
export function LoginScreen({ onLoggedIn }) {
  const [staffCode, setStaffCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await login(staffCode, password);
      onLoggedIn(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow">
        <h1 className="text-center text-2xl font-black text-teal-700">ケア入力</h1>
        <p className="mt-1 text-center text-sm text-slate-500">職員コードでログイン</p>

        <label className="mt-6 block text-sm font-bold text-slate-600">職員コード</label>
        <input
          value={staffCode}
          onChange={(e) => setStaffCode(e.target.value)}
          inputMode="numeric"
          autoComplete="username"
          className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg"
          placeholder="例: 1001"
        />

        <label className="mt-4 block text-sm font-bold text-slate-600">パスワード</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg"
          placeholder="パスワード"
        />

        {error && (
          <div className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-4 text-lg font-black text-white disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
          ログイン
        </button>
      </form>
    </div>
  );
}
