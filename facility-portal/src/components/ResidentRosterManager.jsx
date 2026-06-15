import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw, Upload, Users, X } from 'lucide-react';
import { CARELINK_FACILITIES } from '../config/carelinkFacilities.js';
import {
  deactivateResidentInCloud,
  importSheetSeedToCloud,
  importSheetSeedToLocal,
  isResidentRosterCloudEnabled,
  pullResidentsFromCloud,
  saveLocalRosterResidents,
  upsertResidentToCloud,
} from '../services/residentRosterService.js';

const EMPTY_FORM = Object.freeze({
  dbId: '',
  legacyRowKey: '',
  name: '',
  nameKana: '',
  room: '',
  sheetStatus: '在籍',
  careLevelLabel: '',
  condition: '',
  homeDoctor: '',
  facility: '',
});

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   selectedSheetTitle?: string;
 *   onRosterChanged?: () => void;
 * }} props
 */
export function ResidentRosterManager({ open, onClose, selectedSheetTitle = '', onRosterChanged }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [rows, setRows] = useState(/** @type {Record<string, unknown>[]} */ ([]));
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [filterFacility, setFilterFacility] = useState(String(selectedSheetTitle ?? '').trim());

  const cloudEnabled = isResidentRosterCloudEnabled();

  const loadRows = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      if (cloudEnabled) {
        const list = await pullResidentsFromCloud({ includeInactive: true });
        setRows(list);
        if (!list.length) {
          setMessage('名簿が空です。「スプレッドシートから取り込み」で既存シートを種にできます。');
        }
        return;
      }
      const { loadResidentsFromRosterMaster } = await import('../services/residentRosterService.js');
      const local = await loadResidentsFromRosterMaster();
      if (local?.residents?.length) {
        setRows(local.residents);
      } else {
        setRows([]);
        setMessage('端末内名簿が空です。スプレッドシートから取り込むか、新規追加してください。');
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '名簿の読込に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [cloudEnabled]);

  useEffect(() => {
    if (!open) return;
    setFilterFacility(String(selectedSheetTitle ?? '').trim());
    void loadRows();
  }, [open, selectedSheetTitle, loadRows]);

  const filtered = useMemo(() => {
    const f = String(filterFacility ?? '').trim();
    if (!f) return rows;
    return rows.filter((r) => String(r.facility ?? r.sourceSheetTitle ?? '').trim() === f);
  }, [rows, filterFacility]);

  const resetForm = useCallback(() => {
    setForm({
      ...EMPTY_FORM,
      facility: String(filterFacility || selectedSheetTitle || CARELINK_FACILITIES[0]?.sheetTitle || ''),
    });
  }, [filterFacility, selectedSheetTitle]);

  const startEdit = useCallback((row) => {
    setForm({
      dbId: String(row.dbId ?? '').trim(),
      legacyRowKey: String(row.legacyRowKey ?? row.id ?? '').trim(),
      name: String(row.name ?? '').trim(),
      nameKana: String(row.nameKana ?? '').trim(),
      room: String(row.room ?? '').trim(),
      sheetStatus: String(row.sheetStatus ?? '在籍').trim() || '在籍',
      careLevelLabel: String(row.careLevelLabel ?? '').trim(),
      condition: String(row.condition ?? '').trim(),
      homeDoctor: String(row.homeDoctor ?? '').trim(),
      facility: String(row.facility ?? row.sourceSheetTitle ?? '').trim(),
    });
  }, []);

  const handleSave = useCallback(async () => {
    const name = String(form.name ?? '').trim();
    const facility = String(form.facility ?? '').trim();
    if (!name || !facility) {
      setMessage('氏名と施設（タブ）は必須です。');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const payload = {
        ...form,
        room: String(form.room ?? '').trim() || '—',
        id: String(form.legacyRowKey ?? form.dbId ?? `${facility}::${form.room}::${name}`),
      };
      if (cloudEnabled) {
        await upsertResidentToCloud(payload);
      } else {
        const next = [...rows.filter((r) => String(r.id) !== String(payload.id))];
        next.push({
          ...payload,
          insuranceCategory: '未設定',
          condition: String(form.condition ?? '').trim() || '—',
        });
        saveLocalRosterResidents(next);
        setRows(next);
      }
      setMessage(`「${name}」を保存しました。`);
      resetForm();
      if (cloudEnabled) await loadRows();
      onRosterChanged?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [cloudEnabled, form, loadRows, onRosterChanged, resetForm, rows]);

  const handleImportSheet = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = cloudEnabled ? await importSheetSeedToCloud() : await importSheetSeedToLocal();
      setMessage(`スプレッドシートから ${result.imported} 名を取り込みました。`);
      await loadRows();
      onRosterChanged?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '取り込みに失敗しました');
    } finally {
      setBusy(false);
    }
  }, [cloudEnabled, loadRows, onRosterChanged]);

  const handleDeactivate = useCallback(
    async (row) => {
      const dbId = String(row.dbId ?? '').trim();
      const name = String(row.name ?? '').trim();
      if (!window.confirm(`${name} 様を退去扱いにしますか？`)) return;
      setBusy(true);
      try {
        if (cloudEnabled && dbId) {
          await deactivateResidentInCloud(dbId);
          await loadRows();
        } else {
          const next = rows.map((r) =>
            String(r.id) === String(row.id) ? { ...r, sheetStatus: '退去' } : r
          );
          saveLocalRosterResidents(next.filter((r) => String(r.sheetStatus ?? '') !== '退去'));
          setRows(next.filter((r) => String(r.sheetStatus ?? '') !== '退去'));
        }
        onRosterChanged?.();
        setMessage(`${name} 様を退去にしました。`);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : '退去処理に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [cloudEnabled, loadRows, onRosterChanged, rows]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:p-6">
      <div className="my-4 w-full max-w-4xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-emerald-700" />
            <h2 className="text-lg font-black text-slate-900">名簿管理（アプリ内）</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-slate-100" aria-label="閉じる">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <p className="text-sm font-bold leading-relaxed text-slate-600">
            スプレッドシートは<strong>最初の取り込み用（種）</strong>です。取り込み後はこの画面で追加・修正してください。
            {cloudEnabled ? (
              <span className="text-emerald-800"> 全PCで共有（Supabase）。</span>
            ) : (
              <span className="text-amber-800">
                {' '}
                クラウド同期未設定のため、この端末のみ保存です。VITE_CARELINK_ORGANIZATION_ID 等を設定すると全PC共有できます。
              </span>
            )}
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleImportSheet()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-600 bg-emerald-600 px-3 py-2 text-sm font-black text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              スプレッドシートから取り込み
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void loadRows()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              再読込
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={resetForm}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-50"
            >
              <Plus className="h-4 w-4" />
              新規
            </button>
            <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
              施設
              <select
                value={filterFacility}
                onChange={(e) => setFilterFacility(e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-bold"
              >
                <option value="">すべて</option>
                {CARELINK_FACILITIES.map((def) => (
                  <option key={def.sheetTitle} value={def.sheetTitle}>
                    {def.tabLabel}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {message ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800">
              {message}
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[420px] text-left text-xs">
                <thead className="bg-slate-100 font-black text-slate-700">
                  <tr>
                    <th className="px-2 py-2">氏名</th>
                    <th className="px-2 py-2">居室</th>
                    <th className="px-2 py-2">状態</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length ? (
                    filtered.map((row) => (
                      <tr key={String(row.id)} className="border-t border-slate-100 odd:bg-white even:bg-slate-50">
                        <td className="px-2 py-2 font-bold">{String(row.name ?? '')}</td>
                        <td className="px-2 py-2">{String(row.room ?? '—')}</td>
                        <td className="px-2 py-2">{String(row.sheetStatus ?? '在籍')}</td>
                        <td className="px-2 py-2 text-right">
                          <button
                            type="button"
                            className="mr-2 font-black text-blue-700 hover:underline"
                            onClick={() => startEdit(row)}
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            className="font-black text-rose-700 hover:underline"
                            onClick={() => void handleDeactivate(row)}
                          >
                            退去
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center font-bold text-slate-500">
                        名簿がありません
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <h3 className="mb-3 text-sm font-black text-slate-800">
                {form.dbId || form.legacyRowKey ? '利用者を編集' : '利用者を追加'}
              </h3>
              <div className="grid gap-2">
                {[
                  ['facility', '施設（シート名）', 'select'],
                  ['name', '氏名', 'text'],
                  ['nameKana', 'フリガナ', 'text'],
                  ['room', '居室', 'text'],
                  ['sheetStatus', '状態', 'select'],
                  ['careLevelLabel', '要介護度', 'text'],
                  ['condition', '病名・状態', 'text'],
                  ['homeDoctor', '在宅医', 'text'],
                ].map(([key, label, kind]) => (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-[11px] font-bold text-slate-600">{label}</span>
                    {kind === 'select' && key === 'facility' ? (
                      <select
                        value={String(form.facility ?? '')}
                        onChange={(e) => setForm((prev) => ({ ...prev, facility: e.target.value }))}
                        className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                      >
                        {CARELINK_FACILITIES.map((def) => (
                          <option key={def.sheetTitle} value={def.sheetTitle}>
                            {def.tabLabel}
                          </option>
                        ))}
                      </select>
                    ) : kind === 'select' ? (
                      <select
                        value={String(form.sheetStatus ?? '在籍')}
                        onChange={(e) => setForm((prev) => ({ ...prev, sheetStatus: e.target.value }))}
                        className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                      >
                        <option value="在籍">在籍</option>
                        <option value="入院">入院</option>
                        <option value="退去">退去</option>
                      </select>
                    ) : (
                      <input
                        value={String(form[key] ?? '')}
                        onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                        className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                      />
                    )}
                  </label>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSave()}
                  className="mt-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-black text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
