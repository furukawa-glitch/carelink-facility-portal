import { defaultEnteralMenuFromResident } from './residentDetailSeed.js';

const LS_KEY = 'carelink_os_enteral_nutrition_menu_v1';

export const ENTERAL_MEDICATION_OPTIONS = Object.freeze(['', '〇', '×']);

/**
 * @typedef {{ id: string; label: string; color: string }} EnteralColorDef
 */

/** 用紙どおりの初期色（施設で名称・色を変更可能） */
export const DEFAULT_ENTERAL_COLOR_LEGEND = Object.freeze([
  { id: 'long', label: 'ロング', color: '#93c5fd' },
  { id: 'short', label: 'ショート', color: '#fde047' },
  { id: 'am', label: '朝日勤', color: '#f9a8d4' },
  { id: 'pm', label: '夕日勤', color: '#fdba74' },
]);

const LEGACY_SHIFT_TO_COLOR = Object.freeze({
  day: 'am',
  night: 'pm',
  short: 'short',
});

/** @param {unknown} raw */
export function normalizeEnteralColorLegend(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '').trim() || `c_${out.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = String(item.label ?? '').trim() || '担当';
    let color = String(item.color ?? '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#ffffff';
    out.push({ id, label, color });
  }
  return out.length ? out : [...DEFAULT_ENTERAL_COLOR_LEGEND];
}

/** @param {EnteralColorDef[]} legend @param {string} colorId */
export function getEnteralColorDef(legend, colorId) {
  const id = String(colorId ?? '').trim();
  if (!id) return null;
  return normalizeEnteralColorLegend(legend).find((c) => c.id === id) ?? null;
}

/** @param {EnteralColorDef[]} legend @param {string} colorId */
export function enteralSlotBackgroundColor(legend, colorId) {
  return getEnteralColorDef(legend, colorId)?.color ?? '#ffffff';
}

/** @param {EnteralColorDef[]} legend */
export function formatEnteralColorLegendNote(legend) {
  return normalizeEnteralColorLegend(legend)
    .map((c) => `${c.label}`)
    .join('　');
}

export function newEnteralColorId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

/** @param {string} raw */
export function parseEnteralTimeFromText(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{1,2})[：:](\d{2})/.exec(s);
  if (!m) return { time: '', rest: s };
  const hh = String(Math.min(23, Math.max(0, Number(m[1])))).padStart(2, '0');
  const mm = String(Math.min(59, Math.max(0, Number(m[2])))).padStart(2, '0');
  const time = `${hh}:${mm}`;
  const rest = s.slice(m[0].length).trim();
  return { time, rest };
}

/** @param {EnteralMenuSlot | null | undefined} slot */
export function formatEnteralSlotLine(slot) {
  const s = slot && typeof slot === 'object' ? slot : {};
  const time = String(s.time ?? '').trim();
  const content = String(s.content ?? '').trim();
  if (time && content) return `${time} ${content}`;
  return time || content;
}

/** @param {string} med */
export function normalizeEnteralMedication(med) {
  const s = String(med ?? '').trim();
  if (!s || s === '—' || s === '-') return '';
  if (/日水|水のみ/u.test(s)) return '';
  if (/^[○◯〇]$/.test(s.replace(/\s/g, ''))) return '〇';
  if (/^[×✕✖]$/.test(s.replace(/\s/g, ''))) return '×';
  return ENTERAL_MEDICATION_OPTIONS.includes(s) ? s : '';
}

/**
 * @typedef {{
 *   content: string;
 *   medication: string;
 *   time?: string;
 *   colorId?: string;
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
 *   enteralTarget?: boolean;
 *   // 名簿の経管対象・メニューあり（印刷は enteralTarget で絞る）
 * }} EnteralMenuRow
 */

/**
 * @typedef {{
 *   updatedYmd: string;
 *   footerNote: string;
 *   legendNote: string;
 *   colorLegend?: EnteralColorDef[];
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
  return { content: '', medication: '', time: '', colorId: '' };
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
  let time = String(s.time ?? '').trim();
  let content = String(s.content ?? '').trim();
  if (!time && content) {
    const parsed = parseEnteralTimeFromText(content);
    if (parsed.time) {
      time = parsed.time;
      content = parsed.rest;
    }
  }
  let colorId = String(s.colorId ?? '').trim();
  if (!colorId) {
    const shiftRaw = String(s.shift ?? '').trim();
    colorId = LEGACY_SHIFT_TO_COLOR[shiftRaw] || '';
  }
  return {
    content,
    medication: normalizeEnteralMedication(s.medication),
    time,
    colorId,
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
  const parts = [row.morning, row.noon, row.evening]
    .map((slot) => formatEnteralSlotLine(slot))
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
    const slot = normalizeSlot(row[sk]);
    return {
      content: formatEnteralSlotLine(slot),
      medication: slot.medication,
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
  const target = saved?.enteralTarget !== undefined ? saved.enteralTarget !== false : isEnteral;
  base.enteralTarget = target;
  base.included = saved?.included !== undefined ? saved.included !== false : isEnteral;
  return base;
}

/** 印刷・HTML出力用: 経管対象者のみ */
export function filterEnteralMenuPrintRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (typeof row?.enteralTarget === 'boolean') return row.enteralTarget;
    const hasContent = ['morning', 'noon', 'evening'].some((k) =>
      String(row?.[k]?.content ?? '').trim()
    );
    const hasNote = String(row?.note ?? '').trim();
    return hasContent || hasNote;
  });
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
  let rows = list.map((res) => {
    const row = enteralMenuRowFromResident(res, byId.get(String(res.id)), fk);
    return { ...row, enteralTarget: Boolean(row.enteralTarget) };
  });
  if (enteralOnly) {
    rows = rows.filter((r) => r.enteralTarget);
  } else {
    rows = rows.map((r) => ({ ...r, included: true }));
  }
  for (const s of saved) {
    const id = String(s.residentId ?? '').trim();
    if (!id || rows.some((r) => r.residentId === id)) continue;
    const extra = normalizeRow(s, { id, name: s.name, room: s.room });
    extra.enteralTarget =
      typeof s.enteralTarget === 'boolean'
        ? s.enteralTarget
        : filterEnteralMenuPrintRows([extra]).length > 0;
    rows.push(extra);
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
      legendNote: formatEnteralColorLegendNote(DEFAULT_ENTERAL_COLOR_LEGEND),
      colorLegend: [...DEFAULT_ENTERAL_COLOR_LEGEND],
      rows: [],
    };
  }
  const colorLegend = normalizeEnteralColorLegend(rec.colorLegend);
  return {
    updatedYmd: String(rec.updatedYmd ?? currentYmd()).slice(0, 10) || currentYmd(),
    footerNote: String(rec.footerNote ?? '').trim(),
    legendNote: String(rec.legendNote ?? formatEnteralColorLegendNote(colorLegend)).trim(),
    colorLegend,
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
    colorLegend: normalizeEnteralColorLegend(draft.colorLegend),
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
function printCellStyle(legend, colorId) {
  const id = String(colorId ?? '').trim();
  if (!id) return '';
  const bg = enteralSlotBackgroundColor(legend, id);
  return `background-color:${bg};-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;`;
}

function printSlotTd(slot, legend) {
  const label = getEnteralColorDef(legend, slot?.colorId)?.label ?? '';
  const tag = label ? ` <span style="font-size:9pt;color:#111;font-weight:700">[${escHtml(label)}]</span>` : '';
  const cls = slot?.colorId ? ' class="slot-fill"' : '';
  const style = printCellStyle(legend, slot?.colorId);
  return `<td${cls}${style ? ` style="${style}"` : ''}>${escHtml(formatEnteralSlotLine(slot))}${tag}</td>`;
}

function printMedTd(slot, legend) {
  const style = printCellStyle(legend, slot?.colorId);
  const cls = `class="med${slot?.colorId ? ' med-fill slot-fill' : ''}"`;
  return `<td ${cls}${style ? ` style="${style}"` : ''}>${escHtml(slot.medication || '—')}</td>`;
}

export function buildEnteralMenuHtml(facilityLabel, draft) {
  const rows = filterEnteralMenuPrintRows(draft.rows);
  const legend = normalizeEnteralColorLegend(draft.colorLegend);
  const updated = formatYmdSlashed(draft.updatedYmd) || formatYmdSlashed(currentYmd());
  const bodyRows = rows
    .map(
      (r) => `<tr>
  <td class="name">${escHtml(r.name)}</td>
  ${printSlotTd(r.morning, legend)}
  ${printMedTd(r.morning, legend)}
  ${printSlotTd(r.noon, legend)}
  ${printMedTd(r.noon, legend)}
  ${printSlotTd(r.evening, legend)}
  ${printMedTd(r.evening, legend)}
</tr>`
    )
    .join('\n');

  const colorLegendHtml = legend
    .map(
      (c) =>
        `<span class="legend-swatch" style="display:inline-block;margin-right:12px;padding:2px 8px;background-color:${escHtml(c.color)};border:1px solid #333;-webkit-print-color-adjust:exact;print-color-adjust:exact">${escHtml(c.label)}</span>`
    )
    .join('');

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
  th { background-color: #f3f4f6; font-size: 10pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td.name { width: 9em; font-weight: 700; white-space: nowrap; }
  td.med { width: 2.5em; text-align: center; font-weight: 700; }
  td.slot-fill, td.med-fill, .legend-swatch {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
  col.c-menu { width: 22%; }
  col.c-med { width: 3%; }
  .legend { margin-top: 10px; font-size: 10pt; line-height: 1.5; }
  .footer { margin-top: 8px; font-size: 10pt; line-height: 1.55; white-space: pre-wrap; }
  @media print {
    .no-print { display: none; }
    body, table, tr, td, th, .legend-swatch {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
  }
</style>
</head>
<body>
<h1>【経管栄養メニュー】</h1>
<p class="meta">${escHtml(facilityLabel)}　${escHtml(updated)}　更新　（経管対象 ${rows.length} 名）</p>
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
${colorLegendHtml ? `<p class="legend">${colorLegendHtml}</p>` : ''}
${draft.legendNote ? `<p class="legend">${escHtml(draft.legendNote)}</p>` : ''}
${footer ? `<div class="footer">${footer.replace(/\n/g, '<br/>')}</div>` : ''}
<p class="no-print" style="margin-top:16px;font-size:10pt;color:#333;line-height:1.5;">印刷ダイアログで「PDFに保存」もできます。<br/>色が白抜けする場合: 「その他の設定」→ <strong>背景を印刷する</strong>（背景のグラフィック）をオンにしてください。</p>
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
