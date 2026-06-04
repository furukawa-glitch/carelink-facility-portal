import { defaultEnteralMenuFromResident } from './residentDetailSeed.js';

const LS_KEY = 'carelink_os_enteral_nutrition_menu_v1';

export const ENTERAL_MEDICATION_OPTIONS = Object.freeze(['', '〇', '×', '日水のみ']);

/**
 * @typedef {{
 *   content: string;
 *   medication: string;
 * }} EnteralMenuSlot
 */

/**
 * @typedef {{
 *   residentId: string;
 *   name: string;
 *   room: string;
 *   included: boolean;
 *   morning: EnteralMenuSlot;
 *   noon: EnteralMenuSlot;
 *   evening: EnteralMenuSlot;
 *   note: string;
 * }} EnteralMenuRow
 */

/**
 * @typedef {{
 *   updatedYmd: string;
 *   footerNote: string;
 *   legendNote: string;
 *   rows: EnteralMenuRow[];
 * }} EnteralMenuDraft
 */

export function currentYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatYmdSlashed(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return '';
  return `${m[1]}/${m[2]}/${m[3]}`;
}

function emptySlot() {
  return { content: '', medication: '' };
}

function readStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(all) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all && typeof all === 'object' ? all : {}));
  } catch {
    // ignore
  }
}

function normalizeSlot(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const med = String(s.medication ?? '').trim();
  return {
    content: String(s.content ?? '').trim(),
    medication: ENTERAL_MEDICATION_OPTIONS.includes(med) ? med : med.slice(0, 8),
  };
}

function normalizeRow(raw, res) {
  const id = String(raw?.residentId ?? res?.id ?? '').trim();
  const nameRaw = String(raw?.name ?? res?.name ?? '').trim();
  const name = nameRaw.replace(/様\s*$/u, '') ? `${nameRaw.replace(/様\s*$/u, '')} 様` : '—';
  return {
    residentId: id,
    name,
    room: String(raw?.room ?? res?.room ?? '').trim(),
    included: raw?.included !== false,
    morning: normalizeSlot(raw?.morning),
    noon: normalizeSlot(raw?.noon),
    evening: normalizeSlot(raw?.evening),
    note: String(raw?.note ?? '').trim(),
  };
}

/** @param {EnteralMenuRow | null | undefined} row */
export function enteralMenuBulkLineFromRow(row) {
  if (!row) return '';
  const parts = [row.morning?.content, row.noon?.content, row.evening?.content]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  return parts.join(' ／ ');
}

const ENTERAL_SLOT_BY_MEAL = Object.freeze({
  朝: 'morning',
  昼: 'noon',
  夜: 'evening',
  夕: 'evening',
});

/** @param {string} facilityLinkKey @param {string} residentId @param {string} mealSlot */
export function enteralMenuSlotContentForResident(facilityLinkKey, residentId, mealSlot) {
  const draft = loadEnteralMenuDraft(facilityLinkKey);
  const row = (draft.rows ?? []).find((r) => String(r.residentId) === String(residentId));
  if (!row) return { content: '', medication: '' };
  const sk = ENTERAL_SLOT_BY_MEAL[String(mealSlot ?? '').trim()];
  if (sk && row[sk]) {
    return {
      content: String(row[sk].content ?? '').trim(),
      medication: String(row[sk].medication ?? '').trim(),
    };
  }
  return { content: enteralMenuBulkLineFromRow(row), medication: '' };
}

/**
 * 一括表: 表示用メニュー文と薬（朝昼夜の区分に合わせる）
 * @param {Record<string, unknown>} res
 * @param {string} facilityLinkKey
 * @param {string} mealSlot
 */
export function enteralBulkFieldsForResident(res, facilityLinkKey, mealSlot) {
  const id = String(res?.id ?? '');
  const slot = enteralMenuSlotContentForResident(facilityLinkKey, id, mealSlot);
  const plan = slot.content || defaultEnteralMenuForResident(res, facilityLinkKey);
  return { plan, medication: slot.medication };
}

/** @param {string} note */
export function parseEnteralStatusFromLogNote(note) {
  const n = String(note ?? '').trim();
  if (!n) return { plan: '', status: '' };
  if (/（未実施）$/.test(n)) {
    return { plan: n.replace(/（未実施）$/, '').trim(), status: 'not_done' };
  }
  if (/（実施）$/.test(n)) {
    return { plan: n.replace(/（実施）$/, '').trim(), status: 'done' };
  }
  return { plan: n, status: 'done' };
}

/** @param {string} facilityLinkKey @param {string} residentId */
export function enteralMenuBulkDefaultForResident(facilityLinkKey, residentId) {
  const draft = loadEnteralMenuDraft(facilityLinkKey);
  const row = (draft.rows ?? []).find((r) => String(r.residentId) === String(residentId));
  return enteralMenuBulkLineFromRow(row);
}

/** 一括表「経管メニュー」列の初期値（スプレッドシート取込 → 名簿） */
export function defaultEnteralMenuForResident(res, facilityLinkKey = '') {
  const fk = String(facilityLinkKey ?? '').trim();
  const fromMenu = fk ? enteralMenuBulkDefaultForResident(fk, String(res?.id ?? '')) : '';
  return fromMenu || defaultEnteralMenuFromResident(res);
}

/** @param {Record<string, unknown>} res @param {EnteralMenuRow} [saved] @param {string} [facilityLinkKey] */
export function enteralMenuRowFromResident(res, saved, facilityLinkKey = '') {
  const base = normalizeRow(saved ?? {}, res);
  const fromDraft = facilityLinkKey ? enteralMenuBulkDefaultForResident(facilityLinkKey, String(res?.id ?? '')) : '';
  const def = fromDraft || defaultEnteralMenuFromResident(res);
  if (def && !base.morning.content && !base.noon.content && !base.evening.content) {
    base.morning = { ...base.morning, content: def };
  }
  const hasSlotContent = !!(base.morning.content || base.noon.content || base.evening.content);
  const isEnteral = Boolean(res?.isEnteral) || Boolean(def) || hasSlotContent;
  base.included = saved?.included !== undefined ? saved.included !== false : isEnteral;
  return base;
}

/**
 * @param {Record<string, unknown>[]} roster
 * @param {EnteralMenuRow[]} [savedRows]
 * @param {{ enteralOnly?: boolean; facilityLinkKey?: string }} [opts]
 * @returns {EnteralMenuRow[]}
 */
export function mergeEnteralMenuRows(roster, savedRows, opts = {}) {
  const list = Array.isArray(roster) ? roster : [];
  const saved = Array.isArray(savedRows) ? savedRows : [];
  const byId = new Map(saved.map((r) => [String(r.residentId), r]));
  const enteralOnly = opts.enteralOnly !== false;
  const fk = String(opts.facilityLinkKey ?? '').trim();
  let rows = list.map((res) => enteralMenuRowFromResident(res, byId.get(String(res.id)), fk));
  if (enteralOnly) {
    rows = rows.filter((r) => r.included);
  } else {
    rows = rows.map((r) => ({ ...r, included: true }));
  }
  for (const s of saved) {
    const id = String(s.residentId ?? '').trim();
    if (!id || rows.some((r) => r.residentId === id)) continue;
    rows.push(normalizeRow(s, { id, name: s.name, room: s.room }));
  }
  return rows.sort((a, b) => {
    const ra = String(a.room ?? '').trim();
    const rb = String(b.room ?? '').trim();
    if (ra && rb && ra !== rb) return ra.localeCompare(rb, 'ja', { numeric: true });
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ja');
  });
}

/** @param {string} facilityLinkKey */
export function loadEnteralMenuDraft(facilityLinkKey) {
  const k = String(facilityLinkKey ?? '').trim() || '_default';
  const all = readStore();
  const rec = all[k];
  if (!rec || typeof rec !== 'object') {
    return {
      updatedYmd: currentYmd(),
      footerNote: '',
      legendNote: 'ロング　ショート　ピンク：朝日勤　オレンジ：夕日勤',
      rows: [],
    };
  }
  return {
    updatedYmd: String(rec.updatedYmd ?? currentYmd()).slice(0, 10) || currentYmd(),
    footerNote: String(rec.footerNote ?? '').trim(),
    legendNote: String(rec.legendNote ?? 'ロング　ショート　ピンク：朝日勤　オレンジ：夕日勤').trim(),
    rows: Array.isArray(rec.rows) ? rec.rows.map((r) => normalizeRow(r, r)) : [],
  };
}

/** @param {string} facilityLinkKey @param {EnteralMenuDraft} draft */
export function saveEnteralMenuDraft(facilityLinkKey, draft) {
  const k = String(facilityLinkKey ?? '').trim() || '_default';
  const all = readStore();
  all[k] = {
    updatedYmd: String(draft.updatedYmd ?? currentYmd()).slice(0, 10),
    footerNote: String(draft.footerNote ?? '').trim(),
    legendNote: String(draft.legendNote ?? '').trim(),
    rows: Array.isArray(draft.rows) ? draft.rows : [],
    savedAt: new Date().toISOString(),
  };
  writeStore(all);
  void import('./facilityPortalStoreSync.js').then((m) => m.queueEnteralMenuCloudSync(k));
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} facilityLabel
 * @param {EnteralMenuDraft} draft
 */
export function buildEnteralMenuHtml(facilityLabel, draft) {
  const rows = (draft.rows ?? []).filter((r) => r.included !== false);
  const updated = formatYmdSlashed(draft.updatedYmd) || formatYmdSlashed(currentYmd());
  const bodyRows = rows
    .map(
      (r) => `<tr>
  <td class="name">${escHtml(r.name)}</td>
  <td>${escHtml(r.morning.content)}</td>
  <td class="med">${escHtml(r.morning.medication || '—')}</td>
  <td>${escHtml(r.noon.content)}</td>
  <td class="med">${escHtml(r.noon.medication || '—')}</td>
  <td>${escHtml(r.evening.content)}</td>
  <td class="med">${escHtml(r.evening.medication || '—')}</td>
</tr>`
    )
    .join('\n');

  const rowNotes = rows
    .filter((r) => String(r.note ?? '').trim())
    .map((r) => `※${escHtml(String(r.name).replace(/\s*様\s*$/u, ''))}：${escHtml(r.note)}`)
    .join('<br/>');

  const footer = [draft.footerNote, rowNotes].filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<title>${escHtml(facilityLabel)} 経管栄養メニュー</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: "Yu Gothic UI", "Meiryo", sans-serif; font-size: 11pt; color: #111; }
  h1 { font-size: 16pt; margin: 0 0 4px; letter-spacing: 0.05em; }
  .meta { font-size: 11pt; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #333; padding: 4px 6px; vertical-align: top; word-break: break-word; }
  th { background: #f3f4f6; font-size: 10pt; }
  td.name { width: 9em; font-weight: 700; white-space: nowrap; }
  td.med { width: 2.5em; text-align: center; font-weight: 700; }
  col.c-menu { width: 22%; }
  col.c-med { width: 3%; }
  .legend { margin-top: 10px; font-size: 10pt; line-height: 1.5; }
  .footer { margin-top: 8px; font-size: 10pt; line-height: 1.55; white-space: pre-wrap; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
<h1>【経管栄養メニュー】</h1>
<p class="meta">${escHtml(facilityLabel)}　${escHtml(updated)}　更新</p>
<table>
  <colgroup>
    <col class="c-name"/>
    <col class="c-menu"/><col class="c-med"/>
    <col class="c-menu"/><col class="c-med"/>
    <col class="c-menu"/><col class="c-med"/>
  </colgroup>
  <thead>
    <tr>
      <th>氏名</th>
      <th>朝</th><th>薬</th>
      <th>昼</th><th>薬</th>
      <th>夕</th><th>薬</th>
    </tr>
  </thead>
  <tbody>
${bodyRows || '<tr><td colspan="7" style="text-align:center;padding:16px;">経管対象の利用者がいません</td></tr>'}
  </tbody>
</table>
${draft.legendNote ? `<p class="legend">${escHtml(draft.legendNote)}</p>` : ''}
${footer ? `<div class="footer">${footer.replace(/\n/g, '<br/>')}</div>` : ''}
<p class="no-print" style="margin-top:16px;font-size:10pt;color:#666;">印刷ダイアログで「PDFに保存」もできます。</p>
</body>
</html>`;
}

/** @param {string} facilityLabel @param {EnteralMenuDraft} draft */
export function openEnteralMenuPrint(facilityLabel, draft) {
  const html = buildEnteralMenuHtml(facilityLabel, draft);
  const w = window.open('', '_blank');
  if (!w) {
    downloadEnteralMenuHtml(facilityLabel, draft);
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

/** @param {string} facilityLabel @param {EnteralMenuDraft} draft */
export function downloadEnteralMenuHtml(facilityLabel, draft) {
  const html = buildEnteralMenuHtml(facilityLabel, draft);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = String(facilityLabel ?? '施設').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  a.href = url;
  a.download = `経管栄養メニュー_${safe}_${String(draft.updatedYmd ?? '').replace(/-/g, '')}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
