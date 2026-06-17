import React, { useState } from 'react';
import { Loader2, Lock, UserCircle2 } from 'lucide-react';
import { loginStaff, STAFF_IDLE_LOCK_MS } from '../lib/staffSessionAuth.js';

/**
 * カイポケ型ログイン（職員コード + パスワード）
 * @param {{ onSuccess: () => void }} props
 */
export function StaffLoginScreen({ onSuccess }) {
  const [staffCode, setStaffCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e?.preventDefault?.();
    const code = staffCode.trim().replace(/\s+/g, '');
    if (!code || !password) {
      setErr('職員コードとパスワードを入力してください。');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await loginStaff(code, password);
      setStaffCode('');
      setPassword('');
      onSuccess();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'ログインに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center bg-slate-50 px-4 py-12 pb-20 font-sans font-bold">
      <div className="mb-8 w-full max-w-md text-center">
        <div className="mb-4 inline-block rounded-2xl bg-slate-800 p-4 shadow-lg">
          <UserCircle2 size={40} className="text-sky-300" aria-hidden />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-800 sm:text-3xl">職員ログイン</h1>
        <p className="mt-2 text-xs font-bold uppercase tracking-widest text-slate-400">CareLink Facility Portal</p>
      </div>
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-3xl border-2 border-slate-200 bg-white p-6 shadow-lg"
      >
        <p className="mb-4 text-left text-sm font-bold text-slate-700">
          職員コードとパスワードを入力してください（カイポケと同様）
        </p>
        <label className="mb-3 block text-left">
          <span className="mb-1.5 block text-xs font-black text-slate-600">職員コード</span>
          <input
            type="text"
            inputMode="numeric"
            name="staff-code"
            value={staffCode}
            onChange={(e) => {
              setStaffCode(e.target.value);
              if (err) setErr('');
            }}
            className="w-full rounded-2xl border-2 border-slate-200 bg-slate-50/80 px-4 py-3.5 text-base font-bold text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            autoComplete="username"
            autoFocus
            disabled={busy}
          />
        </label>
        <label className="block text-left">
          <span className="mb-1.5 block text-xs font-black text-slate-600">パスワード</span>
          <input
            type="password"
            name="staff-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (err) setErr('');
            }}
            className="w-full rounded-2xl border-2 border-slate-200 bg-slate-50/80 px-4 py-3.5 text-base font-bold text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            autoComplete="current-password"
            disabled={busy}
          />
        </label>
        {err ? (
          <p className="mt-2 text-sm font-bold text-rose-600" role="alert">
            {err}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 text-center text-base font-black text-white shadow-md transition hover:bg-blue-500 active:scale-[0.99] disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Lock className="h-5 w-5" aria-hidden />}
          ログイン
        </button>
      </form>
      <p className="mt-6 max-w-md text-center text-xs font-bold leading-relaxed text-slate-500">
        {Math.round(STAFF_IDLE_LOCK_MS / 60_000)}分間操作がないと自動的にログアウトします。パスワードは施設管理者にお問い合わせください。
      </p>
    </div>
  );
}
