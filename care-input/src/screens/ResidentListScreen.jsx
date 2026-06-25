import React, { useMemo, useState } from 'react';
import { Loader2, Search, ChevronRight } from 'lucide-react';

/**
 * @param {{
 *   residents: { id: string; name: string; kana: string; room: string; isEnteral?: boolean }[];
 *   loading: boolean;
 *   onReload: () => void;
 *   onSelect: (resident: object) => void;
 * }} props
 */
export function ResidentListScreen({ residents, loading, onSelect }) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim();
    if (!needle) return residents;
    return residents.filter(
      (r) =>
        r.name.includes(needle) ||
        r.kana.includes(needle) ||
        String(r.room).includes(needle)
    );
  }, [residents, q]);

  return (
    <div>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="名前・居室で検索"
          className="w-full rounded-xl border border-slate-300 py-3 pl-10 pr-4 text-lg"
        />
      </div>

      {loading && residents.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-12 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> 名簿を読み込み中…
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-slate-500">
          利用者が見つかりません。
          <br />
          名簿が空の場合は、閲覧用アプリの「名簿管理」でクラウドへ取り込んでください。
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <li key={r.id || r.name}>
              <button
                type="button"
                onClick={() => onSelect(r)}
                className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left shadow-sm active:bg-slate-50"
              >
                {r.room && (
                  <span className="min-w-[3rem] rounded-lg bg-slate-100 px-2 py-1 text-center text-sm font-bold text-slate-600">
                    {r.room}
                  </span>
                )}
                <span className="flex-1 text-xl font-black text-slate-800">
                  {r.name}
                  {r.isEnteral && (
                    <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-bold text-violet-700">
                      経管
                    </span>
                  )}
                </span>
                <ChevronRight className="h-6 w-6 text-slate-400" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
