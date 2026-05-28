/**
 * Notion「新規入居」データベースの取得（開発時は Vite が /notion-api を api.notion.com にプロキシ）
 * @see https://developers.notion.com/reference/post-database-query
 */

/** @param {Record<string, unknown>} prop */
function extractPropertyValue(prop) {
  if (!prop || typeof prop !== 'object' || !('type' in prop)) return '';
  const t = /** @type {{ type: string }} */ (prop).type;
  switch (t) {
    case 'title':
      return /** @type {{ title?: { plain_text: string }[] }} */ (prop).title?.map((x) => x.plain_text).join('') ?? '';
    case 'rich_text':
      return /** @type {{ rich_text?: { plain_text: string }[] }} */ (prop).rich_text?.map((x) => x.plain_text).join('') ?? '';
    case 'number': {
      const n = /** @type {{ number?: number | null }} */ (prop).number;
      return n != null && !Number.isNaN(n) ? String(n) : '';
    }
    case 'select':
      return /** @type {{ select?: { name?: string } | null }} */ (prop).select?.name ?? '';
    case 'multi_select':
      return (/** @type {{ multi_select?: { name: string }[] }} */ (prop).multi_select ?? [])
        .map((s) => s.name)
        .join('、');
    case 'date': {
      const d = /** @type {{ date?: { start?: string; end?: string | null } | null }} */ (prop).date;
      if (!d?.start) return '';
      const end = d.end && d.end !== d.start ? d.end : '';
      return end ? `${d.start} 〜 ${end}` : d.start;
    }
    case 'checkbox':
      return /** @type {{ checkbox?: boolean }} */ (prop).checkbox ? 'はい' : 'いいえ';
    case 'url':
      return /** @type {{ url?: string | null }} */ (prop).url ?? '';
    case 'email':
      return /** @type {{ email?: string | null }} */ (prop).email ?? '';
    case 'phone_number':
      return /** @type {{ phone_number?: string | null }} */ (prop).phone_number ?? '';
    case 'status':
      return /** @type {{ status?: { name?: string } | null }} */ (prop).status?.name ?? '';
    case 'people':
      return (/** @type {{ people?: { name?: string; id: string }[] }} */ (prop).people ?? [])
        .map((p) => p.name || p.id)
        .join('、');
    case 'formula': {
      const f = /** @type {{ formula?: { type: string; string?: string; number?: number; boolean?: boolean } }} */ (prop).formula;
      if (!f?.type) return '';
      if (f.type === 'string') return f.string ?? '';
      if (f.type === 'number') return f.number != null ? String(f.number) : '';
      if (f.type === 'boolean') return f.boolean ? 'はい' : 'いいえ';
      return '';
    }
    default:
      return '';
  }
}

/**
 * @param {Record<string, unknown>} page Notion page object
 */
export function notionPageToRow(page) {
  const props = /** @type {Record<string, Record<string, unknown>>} */ (page.properties ?? {});
  /** @type {Record<string, string>} */
  const fields = {};
  let name = '';
  for (const [key, val] of Object.entries(props)) {
    const text = extractPropertyValue(val);
    fields[key] = text;
    if (!name && val && typeof val === 'object' && 'type' in val && val.type === 'title' && text) {
      name = text;
    }
  }
  if (!name) {
    const firstTitleKey = Object.keys(props).find((k) => props[k]?.type === 'title');
    if (firstTitleKey) name = fields[firstTitleKey] ?? '';
  }
  return {
    id: String(page.id ?? ''),
    url: String(page.url ?? ''),
    name: name || '（無題）',
    fields,
  };
}

/**
 * プロキシ経由で DB をクエリ（ページ一覧）
 * @returns {Promise<{ rows: ReturnType<typeof notionPageToRow>[]; rawCount: number }>}
 */
export async function fetchNotionNewResidentsDatabase() {
  const dbId = String(import.meta.env.VITE_NOTION_NEW_RESIDENTS_DATABASE_ID ?? '').trim();
  if (!dbId) {
    throw new Error('VITE_NOTION_NEW_RESIDENTS_DATABASE_ID が未設定です');
  }
  const idEnc = encodeURIComponent(dbId.trim());
  const res = await fetch(`/notion-api/databases/${idEnc}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_size: 100,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.code || res.statusText || 'Notion API エラー';
    throw new Error(String(msg));
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const rows = results.map((p) => notionPageToRow(/** @type {Record<string, unknown>} */ (p)));
  return { rows, rawCount: results.length };
}

export function hasNotionNewResidentsConfig() {
  return Boolean(String(import.meta.env.VITE_NOTION_NEW_RESIDENTS_DATABASE_ID ?? '').trim());
}
