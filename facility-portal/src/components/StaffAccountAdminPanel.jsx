import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, RefreshCw, UserPlus, Users } from 'lucide-react';
import {
  getStaffSession,
  isStaffAdmin,
  staffAuthAdminRequest,
} from '../lib/staffSessionAuth.js';

/**
 * 管理者: 職員コード・氏名・パスワードの発行（ふれあいの里 / ケアリンク向け）
 */
export function StaffAccountAdminPanel() {
  const [rows, setRows] = useState(/** @type {Record<string, unknown>[]} */ ([]));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newAdmin, setNewAdmin] = useState(false);

  const [resetId, setResetId] = useState('');
  const [resetPassword, setResetPassword] = useState('');

  const session = getStaffSession();
  const canManage = isStaffAdmin();

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    setErr('');
    try {
      const data = await staffAuthAdminRequest('list');
      setRows(Array.isArray(data.staff) ? data.staff : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '一覧の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const createAccount = async (e) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await staffAuthAdminRequest('create', {
        staffCode: newCode.trim().replace(/\s+/g, ''),
        displayName: newName.trim(),
        password: newPassword,
        isAdmin: newAdmin,
      });
      setMsg(`職員「${newName.trim()}」（コード ${newCode.trim()}）を登録しました。`);
      setNewCode('');
      setNewName('');
      setNewPassword('');
      setNewAdmin(false);
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '登録に失敗しました。');
    }
  };

  const resetPw = async (e) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await staffAuthAdminRequest('reset_password', {
        staffAccountId: resetId,
        password: resetPassword,
      });
      setMsg('パスワードを再発行しました。');
      setResetPassword('');
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '再発行に失敗しました。');
    }
  };

  const toggleActive = async (id, active) => {
    setErr('');
    setMsg('');
    try {
      await staffAuthAdminRequest('set_active', { staffAccountId: id, active });
      setMsg(active ? 'アカウントを有効にしました。' : 'アカウントを停止しました。');
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '更新に失敗しました。');
    }
  };

  if (!session) {
    return (
      <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
        職員ログイン後に利用できます。
      </p>
    );
  }

  if (!canManage) {
    return (
      <p className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700">
        ログイン中: {session.displayName || '—'}（コード {session.staffCode}）
        <br />
        職員の追加・パスワード発行は管理者アカウントのみ可能です。
      </p>
    );
  }

  return (
    <div className="space-y-6 rounded-3xl border-2 border-indigo-100 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-lg font-black text-indigo-950">
          <Users className="h-5 w-5" aria-hidden />
          職員アカウント管理
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-black text-indigo-900 disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          更新
        </button>
      </div>

      {err ? (
        <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700" role="alert">
          {err}
        </p>
      ) : null}
      {msg ? (
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">{msg}</p>
      ) : null}

      <form onSubmit={createAccount} className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4">
        <p className="mb-3 flex items-center gap-1.5 text-sm font-black text-emerald-900">
          <UserPlus className="h-4 w-4" aria-hidden />
          新規職員を登録（パスワード発行）
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs font-bold text-slate-700">
            職員コード
            <input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold"
              placeholder="例: 1001"
              required
            />
          </label>
          <label className="block text-xs font-bold text-slate-700">
            氏名（記録に表示）
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold"
              placeholder="例: 山田 花子"
              required
            />
          </label>
          <label className="block text-xs font-bold text-slate-700 sm:col-span-2">
            初期パスワード（4文字以上）
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold"
              autoComplete="new-password"
              required
              minLength={4}
            />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs font-bold text-slate-700">
          <input type="checkbox" checked={newAdmin} onChange={(e) => setNewAdmin(e.target.checked)} />
          管理者（職員の追加・パスワード再発行が可能）
        </label>
        <button
          type="submit"
          className="mt-4 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white hover:bg-emerald-500"
        >
          登録する
        </button>
      </form>

      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="min-w-full text-left text-xs font-bold">
          <thead className="bg-slate-100 text-slate-600">
            <tr>
              <th className="px-3 py-2">コード</th>
              <th className="px-3 py-2">氏名</th>
              <th className="px-3 py-2">権限</th>
              <th className="px-3 py-2">状態</th>
              <th className="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const id = String(r.id ?? '');
              return (
                <tr key={id} className="border-t border-slate-100">
                  <td className="px-3 py-2 tabular-nums">{String(r.staffCode ?? '')}</td>
                  <td className="px-3 py-2">{String(r.displayName ?? '')}</td>
                  <td className="px-3 py-2">{r.isAdmin ? '管理者' : '一般'}</td>
                  <td className="px-3 py-2">{r.active ? '有効' : '停止'}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setResetId(id);
                        setResetPassword('');
                      }}
                      className="mr-2 text-indigo-700 underline"
                    >
                      PW再発行
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleActive(id, !r.active)}
                      className="text-slate-600 underline"
                    >
                      {r.active ? '停止' : '有効化'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !loading ? (
          <p className="px-3 py-4 text-center text-xs text-slate-500">職員がまだ登録されていません。</p>
        ) : null}
      </div>

      {resetId ? (
        <form onSubmit={resetPw} className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-black text-indigo-900">
            <KeyRound className="h-4 w-4" aria-hidden />
            パスワード再発行
          </p>
          <label className="block text-xs font-bold text-slate-700">
            新しいパスワード
            <input
              type="text"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold"
              minLength={4}
              required
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button type="submit" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-black text-white">
              再発行
            </button>
            <button
              type="button"
              onClick={() => setResetId('')}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700"
            >
              キャンセル
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
