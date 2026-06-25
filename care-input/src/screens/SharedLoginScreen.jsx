import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { CARE_INPUT_PASSWORD } from '../config.js';

const NAME_KEY = 'care_input_recorder_name';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** @param {{ onLoggedIn: (session: object) => void }} props */
export function SharedLoginScreen({ onLoggedIn }) {
  const [password, setPassword] = useState('');
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [error, setError] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (password !== CARE_INPUT_PASSWORD) {
      setError('パスワードが違います。');
      return;
    }
    const displayName = name.trim();
    try {
      if (displayName) localStorage.setItem(NAME_KEY, displayName);
    } catch {
      /* ignore */
    }
    onLoggedIn({
      mode: 'shared',
      expiresAt: Date.now() + SESSION_TTL_MS,
      staff: { id: '', staffCode: '', displayName, isAdmin: false },
    });
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow">
        <h1 className="text-center text-2xl font-black text-teal-700">ケア入力</h1>
        <p className="mt-1 text-center text-sm text-slate-500">共有パスワードでログイン</p>

        <label className="mt-6 block text-sm font-bold text-slate-600">パスワード</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg"
          placeholder="施設の共有パスワード"
        />

        <label className="mt-4 block text-sm font-bold text-slate-600">
          記録者名（任意・この端末に記憶）
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg"
          placeholder="例: 山田"
        />

        {error && (
          <div className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-4 text-lg font-black text-white"
        >
          <LogIn className="h-5 w-5" />
          ログイン
        </button>
      </form>
    </div>
  );
}
