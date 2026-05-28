import React, { useCallback, useEffect, useState } from 'react';
import { Baby, ChevronLeft, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import {
  fetchNotionNewResidentsDatabase,
  hasNotionNewResidentsConfig,
} from '../services/notionNewResidentsService.js';

/**
 * 営業が Notion に登録した「新規入居」を各部署が参照する画面
 * @param {{ onBack: () => void }} props
 */
export function NotionNewResidentsPage({ onBack }) {
  const [rows, setRows] = useState(
    /** @type {{ id: string; url: string; name: string; fields: Record<string, string> }[]} */ ([])
  );
  const [openId, setOpenId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [meta, setMeta] = useState('');

  const load = useCallback(async () => {
    if (!hasNotionNewResidentsConfig()) {
      setErr('データベース ID が未設定です。.env に VITE_NOTION_NEW_RESIDENTS_DATABASE_ID を追加してください。');
      setRows([]);
      return;
    }
    setLoading(true);
    setErr('');
    try {
      const { rows: list, rawCount } = await fetchNotionNewResidentsDatabase();
      setRows(list);
      setMeta(`${rawCount}件`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
      setMeta('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const configured = hasNotionNewResidentsConfig();

  return (
    <div className="min-h-[100dvh] bg-slate-100 pb-16 font-sans">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-6">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
              aria-label="戻る"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <Baby className="h-7 w-7 shrink-0 text-indigo-600" aria-hidden />
            <div className="min-w-0">
              <h1 className="text-lg font-black text-slate-900 sm:text-xl">新規入居（Notion）</h1>
              <p className="text-[11px] font-bold text-slate-500 sm:text-xs">
                営業が Notion に登録した内容を参照します。{meta ? ` ${meta}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={loading || !configured}
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-xl border-2 border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-black text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            再読込
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        {!configured && (
          <div className="mb-4 rounded-2xl border-2 border-amber-400 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-950">
            <p className="font-black">セットアップが必要です</p>
            <ol className="mt-2 list-inside list-decimal space-y-1 text-xs font-bold leading-relaxed text-amber-900">
              <li>
                Notion で「インテグレーション」を作成し、対象データベースに<strong>接続</strong>してください。
              </li>
              <li>
                リポジトリ直下の <code className="rounded bg-white px-1">.env</code> に{' '}
                <code className="rounded bg-white px-1">VITE_NOTION_INTEGRATION_TOKEN</code> と{' '}
                <code className="rounded bg-white px-1">VITE_NOTION_NEW_RESIDENTS_DATABASE_ID</code>{' '}
                を記載し、<code className="rounded bg-white px-1">npm run dev</code> を再起動してください。
              </li>
            </ol>
          </div>
        )}

        {configured && (
          <p className="mb-4 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600">
            名前は Notion の<strong>タイトル列</strong>から取得します。他の列はデータベースのプロパティ名どおり表示されます。
          </p>
        )}

        {err ? (
          <div className="mb-4 rounded-2xl border-2 border-rose-400 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-900">
            {err}
            <p className="mt-2 text-xs font-bold text-rose-800">
              本番ビルドを静的ホストに載せる場合は、Notion 用のプロキシが別途必要になることがあります（開発時は Vite のプロキシを利用）。
            </p>
          </div>
        ) : null}

        <ul className="space-y-3">
          {rows.map((row) => {
            const expanded = openId === row.id;
            const keys = Object.keys(row.fields ?? {}).filter((k) => row.fields[k] !== '');
            return (
              <li
                key={row.id}
                className="overflow-hidden rounded-2xl border-2 border-slate-200 bg-white shadow-sm"
              >
                <button
                  type="button"
                  onClick={() => setOpenId((id) => (id === row.id ? '' : row.id))}
                  className="flex w-full items-start justify-between gap-3 px-4 py-4 text-left hover:bg-slate-50"
                >
                  <span className="text-base font-black text-slate-900 sm:text-lg">{row.name}</span>
                  <span className="shrink-0 text-xs font-bold text-slate-400">{expanded ? '閉じる' : '詳細'}</span>
                </button>
                {expanded && (
                  <div className="border-t border-slate-100 bg-slate-50/90 px-4 py-3">
                    <dl className="space-y-2 text-sm">
                      {keys.map((k) => (
                        <div key={k} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                          <dt className="font-black text-slate-500">{k}</dt>
                          <dd className="whitespace-pre-wrap font-bold text-slate-800">{row.fields[k]}</dd>
                        </div>
                      ))}
                    </dl>
                    {row.url ? (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-1 text-sm font-black text-indigo-600 hover:underline"
                      >
                        <ExternalLink className="h-4 w-4" />
                        Notion で開く
                      </a>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {!loading && configured && rows.length === 0 && !err && (
          <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm font-bold text-slate-500">
            データがありません。Notion のデータベースにページを追加するか、インテグレーションの共有範囲を確認してください。
          </p>
        )}
      </main>
    </div>
  );
}
