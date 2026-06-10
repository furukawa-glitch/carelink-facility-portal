import * as Report from '../services/ReportService.js';

const DRAFT_LS = 'carelink_os_home_visit_note_draft_v1';

/** @returns {string} YYYY-MM-DD */
export function currentYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @param {string} ymd */
export function weekRangeLabelFromEndYmd(ymd) {
  const end = new Date(`${ymd}T12:00:00`);
  if (!Number.isFinite(end.getTime())) return ymd;
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  const fmt = (dt) =>
    `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
  return `${fmt(start)} 〜 ${fmt(end)}`;
}

/**
 * @param {Record<string, unknown> | null | undefined} meta
 */
export function vitalFieldsFromMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    temp: m.temp != null ? String(m.temp) : '',
    bpUpper: m.bpUpper != null ? String(m.bpUpper) : '',
    bpLower: m.bpLower != null ? String(m.bpLower) : '',
    pulse: m.pulse != null ? String(m.pulse) : '',
    spo2: m.spo2 != null ? String(m.spo2) : '',
    weight: m.weight != null ? String(m.weight) : '',
  };
}

/**
 * @typedef {{
 *   included: boolean;
 *   residentId: string;
 *   name: string;
 *   room: string;
 *   temp: string;
 *   bpUpper: string;
 *   bpLower: string;
 *   pulse: string;
 *   spo2: string;
 *   weight: string;
 *   measuredAt: string;
 *   remark: string;
 *   visitEntry: string;
 *   note: string;
 * }} HomeVisitNoteRow
 */

/** @param {string} name */
export function formatHomeVisitNameWithSama(name) {
  const n = String(name ?? '').trim();
  if (!n) return '';
  return /様\s*$/u.test(n) ? n : `${n} 様`;
}

/** @param {{ bpUpper?: string; bpLower?: string }} row */
export function formatBpSlash(row) {
  const u = String(row.bpUpper ?? '').trim();
  const l = String(row.bpLower ?? '').trim();
  if (!u && !l) return '';
  return `${u}/${l}`;
}

/** @param {string} raw */
export function parseBpSlashInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { bpUpper: '', bpLower: '' };
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(s);
  if (m) return { bpUpper: m[1], bpLower: m[2] };
  return { bpUpper: s.replace(/[^\d.]/g, ''), bpLower: '' };
}

/** @param {string} ymd YYYY-MM-DD */
export function toReiwaDateLabel(ymd) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(ymd ?? '').trim());
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const reiwa = y - 2018;
  if (reiwa < 1) return `${y} 年 ${mo} 月 ${d} 日`;
  return `R ${reiwa} 年 ${mo} 月 ${d} 日`;
}

/**
 * @param {Record<string, unknown>} res
 * @param {{ included?: boolean }} [opts]
 * @returns {HomeVisitNoteRow}
 */
export function homeVisitRowFromResident(res, opts = {}) {
  const id = String(res?.id ?? '').trim();
  const ctx = Report.careEventResidentContext(res);
  const { meta, measuredAt } = Report.getLatestVitalMetaForResident(id, ctx);
  const v = vitalFieldsFromMeta(meta);
  return {
    included: opts.included !== false,
    residentId: id,
    name: String(res?.name ?? '').trim(),
    room: String(res?.room ?? '').trim(),
    ...v,
    measuredAt: measuredAt || '',
    remark: '',
    visitEntry: '',
    note: '',
  };
}

/** @param {string} ymd */
export function weekStartYmdFromEndYmd(ymd) {
  const end = new Date(`${ymd}T12:00:00`);
  if (!Number.isFinite(end.getTime())) return ymd;
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
}

/**
 * @param {HomeVisitNoteRow[]} rows
 * @param {string} [weekEndYmd]
 * @returns {HomeVisitNoteRow[]}
 */
export function applyLatestVitalsToHomeVisitRows(rows, weekEndYmd = '') {
  const endYmd = String(weekEndYmd ?? '').trim();
  const startYmd = endYmd ? weekStartYmdFromEndYmd(endYmd) : '';
  return rows.map((row) => {
    const ctx = { residentName: row.name, facilitySheetTitle: '' };
    const { meta, measuredAt } =
      endYmd && startYmd
        ? Report.getLatestVitalMetaForResidentInRange(row.residentId, startYmd, endYmd, ctx)
        : Report.getLatestVitalMetaForResident(row.residentId, ctx);
    const v = vitalFieldsFromMeta(meta);
    return { ...row, ...v, measuredAt: measuredAt || row.measuredAt };
  });
}

function normalizeResidentNameForMatch(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s*様\s*$/u, '')
    .replace(/\s+/g, '')
    .replace(/[　]/g, '');
}

/**
 * 運用中シートの氏名順・メモを名簿と突合して往診ノート行へ
 * @param {{ rows?: { name: string; room?: string; note?: string; temp?: string; bpUpper?: string; bpLower?: string; pulse?: string; spo2?: string; weight?: string }[]; facilityMemo?: string }} sheetParsed
 * @param {Record<string, unknown>[]} rosterResidents
 * @param {{ includeUnlistedRoster?: boolean }} [opts]
 * @returns {HomeVisitNoteRow[]}
 */
export function homeVisitRowsFromSheetMerge(sheetParsed, rosterResidents, opts = {}) {
  const roster = Array.isArray(rosterResidents) ? rosterResidents : [];
  const sheetRows = Array.isArray(sheetParsed?.rows) ? sheetParsed.rows : [];
  const norm = normalizeResidentNameForMatch;
  /** @type {HomeVisitNoteRow[]} */
  const out = [];
  const usedIds = new Set();

  for (const sr of sheetRows) {
    const sheetName = String(sr.name ?? '').trim();
    if (!sheetName) continue;
    const hit = roster.find((res) => norm(res.name) === norm(sheetName));
    if (hit) {
      const id = String(hit.id ?? '').trim();
      usedIds.add(id);
      const base = homeVisitRowFromResident(hit);
      out.push({
        ...base,
        name: sheetName || base.name,
        room: String(sr.room ?? '').trim() || base.room,
        remark: String(sr.remark ?? '').trim() || base.remark,
        visitEntry: String(sr.visitEntry ?? sr.note ?? '').trim() || base.visitEntry,
        note: String(sr.visitEntry ?? sr.note ?? '').trim() || base.note,
        temp: String(sr.temp ?? '').trim() || base.temp,
        bpUpper: String(sr.bpUpper ?? '').trim() || base.bpUpper,
        bpLower: String(sr.bpLower ?? '').trim() || base.bpLower,
        pulse: String(sr.pulse ?? '').trim() || base.pulse,
        spo2: String(sr.spo2 ?? '').trim() || base.spo2,
        weight: String(sr.weight ?? '').trim() || base.weight,
      });
    } else {
      out.push({
        included: true,
        residentId: `sheet-${norm(sheetName)}`,
        name: sheetName,
        room: String(sr.room ?? '').trim(),
        temp: String(sr.temp ?? '').trim(),
        bpUpper: String(sr.bpUpper ?? '').trim(),
        bpLower: String(sr.bpLower ?? '').trim(),
        pulse: String(sr.pulse ?? '').trim(),
        spo2: String(sr.spo2 ?? '').trim(),
        weight: String(sr.weight ?? '').trim(),
        measuredAt: '',
        remark: String(sr.remark ?? '').trim(),
        visitEntry: String(sr.visitEntry ?? sr.note ?? '').trim(),
        note: String(sr.visitEntry ?? sr.note ?? '').trim(),
      });
    }
  }

  if (opts.includeUnlistedRoster) {
    for (const res of roster) {
      const id = String(res?.id ?? '').trim();
      if (!id || usedIds.has(id)) continue;
      out.push(homeVisitRowFromResident(res, { included: false }));
    }
  }
  return out;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildAisaiHomeVisitNoteHtml(weekEndYmd, rows, opts = {}) {
  const included = rows.filter((r) => r.included && String(r.name ?? '').trim());
  const headerTitle = String(opts.headerTitle ?? '往診ノート　《１・３週》　水曜　女性').trim();
  const dateLabel = toReiwaDateLabel(weekEndYmd);
  const created = opts.createdAt ?? new Date().toLocaleString('ja-JP');
  const bodyRows = included
    .map(
      (r) => `<tr>
  <td class="name">${escHtml(formatHomeVisitNameWithSama(r.name))}</td>
  <td class="n">${escHtml(r.temp ? `${r.temp}℃` : '')}</td>
  <td class="n">${escHtml(r.pulse)}</td>
  <td class="n">${escHtml(formatBpSlash(r))}</td>
  <td class="n">${escHtml(r.spo2 ? `${r.spo2}%` : '')}</td>
  <td class="remark">${escHtml(r.remark)}</td>
  <td class="visit">${escHtml(r.visitEntry || r.note)}</td>
</tr>`
    )
    .join('\n');

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"/>
<title>${escHtml(headerTitle)} ${dateLabel}</title>
<style>
  body{font-family:"Yu Gothic UI","Meiryo",sans-serif;font-size:13px;color:#111;margin:12mm;}
  table{border-collapse:collapse;width:100%;table-layout:fixed;}
  th,td{border:1px solid #333;padding:5px 6px;vertical-align:middle;font-size:12px;}
  .head td{border:none;padding:2px 4px 8px;vertical-align:bottom;}
  .head .title{font-size:15px;font-weight:bold;}
  .head .date{text-align:right;font-size:14px;white-space:nowrap;}
  th{background:#fff;font-weight:bold;text-align:center;}
  td.name{min-width:9rem;font-weight:bold;}
  td.n{text-align:center;white-space:nowrap;width:4rem;}
  td.remark{width:14%;}
  td.visit{width:38%;min-height:2.5em;white-space:pre-wrap;word-break:break-word;}
  .foot{margin-top:8px;font-size:10px;color:#64748b;}
  @media print{body{margin:8mm;} .noprint{display:none;}}
</style></head><body>
<table>
<tr class="head">
  <td class="title" colspan="5">${escHtml(headerTitle)}</td>
  <td class="date" colspan="2">${escHtml(dateLabel)}</td>
</tr>
<tr>
  <th>氏名</th><th>KT</th><th>P</th><th>BP</th><th>SPO2</th>
  <th colspan="1">備考（再検など）</th><th>往診時記入欄</th>
</tr>
${bodyRows || '<tr><td colspan="7">（対象者なし）</td></tr>'}
</table>
<p class="foot noprint">CareLink 施設ポータルから出力（${escHtml(created)}）／ ${included.length} 名</p>
</body></html>`;
}

/**
 * @param {string} facilityLabel
 * @param {string} weekEndYmd
 * @param {HomeVisitNoteRow[]} rows
 * @param {{ createdAt?: string; memo?: string; layout?: string; headerTitle?: string }} [opts]
 */
export function buildHomeVisitNoteHtml(facilityLabel, weekEndYmd, rows, opts = {}) {
  if (opts.layout === 'aisai') {
    return buildAisaiHomeVisitNoteHtml(weekEndYmd, rows, opts);
  }
  const included = rows.filter((r) => r.included && String(r.name ?? '').trim());
  const weekLabel = weekRangeLabelFromEndYmd(weekEndYmd);
  const created = opts.createdAt ?? new Date().toLocaleString('ja-JP');
  const memo = String(opts.memo ?? '').trim();
  const bodyRows = included
    .map(
      (r, i) => `<tr>
  <td class="c">${i + 1}</td>
  <td>${escHtml(r.room || '—')}</td>
  <td class="name">${escHtml(r.name)} 様</td>
  <td class="n">${escHtml(r.temp)}</td>
  <td class="n">${escHtml(r.bpUpper)}/${escHtml(r.bpLower)}</td>
  <td class="n">${escHtml(r.pulse)}</td>
  <td class="n">${escHtml(r.spo2)}</td>
  <td class="n">${escHtml(r.weight)}</td>
  <td class="memo">${escHtml(r.note)}</td>
</tr>`
    )
    .join('\n');

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"/>
<title>${escHtml(facilityLabel)} 往診ノート ${weekEndYmd}</title>
<style>
  body{font-family:"Yu Gothic UI","Meiryo",sans-serif;font-size:12px;color:#111;margin:16px;}
  h1{font-size:18px;margin:0 0 4px;}
  .sub{font-size:12px;color:#444;margin-bottom:12px;}
  table{border-collapse:collapse;width:100%;}
  th,td{border:1px solid #333;padding:4px 6px;vertical-align:top;}
  th{background:#e2e8f0;font-size:11px;}
  td.c,td.n{text-align:center;white-space:nowrap;}
  td.name{font-weight:bold;min-width:7rem;}
  td.memo{min-width:12rem;white-space:pre-wrap;word-break:break-word;}
  .memo{margin-top:12px;padding:8px;border:1px solid #94a3b8;background:#f8fafc;white-space:pre-wrap;}
  @media print{body{margin:8mm;} .noprint{display:none;}}
</style></head><body>
<h1>${escHtml(facilityLabel)}　往診ノート（週次）</h1>
<p class="sub">対象週: ${escHtml(weekLabel)} ／ 作成: ${escHtml(created)} ／ ${included.length} 名</p>
${memo ? `<div class="memo"><strong>施設メモ</strong><br/>${escHtml(memo)}</div>` : ''}
<table>
<thead><tr>
  <th>No</th><th>部屋</th><th>氏名</th><th>体温</th><th>血圧</th><th>脈</th><th>SpO2</th><th>体重</th><th>往診メモ</th>
</tr></thead>
<tbody>
${bodyRows || '<tr><td colspan="9">（対象者なし）</td></tr>'}
</tbody>
</table>
<p class="noprint" style="margin-top:16px;font-size:11px;color:#64748b;">CareLink 施設ポータルから出力。バイタルは保存済み記録の最新値です。印刷または PDF 保存してください。</p>
</body></html>`;
}

/**
 * @param {string} facilityLabel
 * @param {string} weekEndYmd
 * @param {HomeVisitNoteRow[]} rows
 * @param {{ memo?: string; layout?: string; headerTitle?: string }} [opts]
 */
export function downloadHomeVisitNoteHtml(facilityLabel, weekEndYmd, rows, opts = {}) {
  const html = buildHomeVisitNoteHtml(facilityLabel, weekEndYmd, rows, opts);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = String(facilityLabel).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  a.download = `往診ノート_${safe}_${weekEndYmd.replace(/-/g, '')}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 愛西運用シートへ貼り付けやすい TSV（氏名〜往診時記入欄）
 * @param {string} weekEndYmd
 * @param {HomeVisitNoteRow[]} rows
 */
export function downloadAisaiHomeVisitSheetTsv(weekEndYmd, rows) {
  const included = rows.filter((r) => r.included && String(r.name ?? '').trim());
  const lines = included.map((r) =>
    [
      formatHomeVisitNameWithSama(r.name),
      r.temp,
      r.pulse,
      formatBpSlash(r),
      r.spo2,
      r.remark,
      r.visitEntry || r.note,
    ].join('\t')
  );
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/tab-separated-values;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `往診ノート_貼付_${weekEndYmd.replace(/-/g, '')}.tsv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * @param {string} facilityLabel
 * @param {string} weekEndYmd
 * @param {HomeVisitNoteRow[]} rows
 * @param {{ layout?: string; headerTitle?: string }} [opts]
 */
export function downloadHomeVisitNoteCsv(facilityLabel, weekEndYmd, rows, opts = {}) {
  const q = (v) => {
    const t = String(v ?? '');
    if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const included = rows.filter((r) => r.included && String(r.name ?? '').trim());
  if (opts.layout === 'aisai') {
    const lines = [
      [String(opts.headerTitle ?? '往診ノート'), toReiwaDateLabel(weekEndYmd)].map(q).join(','),
      ['氏名', 'KT', 'P', 'BP', 'SPO2', '備考（再検など）', '往診時記入欄'].map(q).join(','),
    ];
    included.forEach((r) => {
      lines.push(
        [
          formatHomeVisitNameWithSama(r.name),
          r.temp,
          r.pulse,
          formatBpSlash(r),
          r.spo2,
          r.remark,
          r.visitEntry || r.note,
        ]
          .map(q)
          .join(',')
      );
    });
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safe = String(facilityLabel).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    a.download = `往診ノート_${safe}_${weekEndYmd.replace(/-/g, '')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  const lines = [
    ['施設', facilityLabel].map(q).join(','),
    ['対象週終了日', weekEndYmd].map(q).join(','),
    ['No', '部屋', '氏名', '体温', '血圧上', '血圧下', '脈', 'SpO2', '体重', '往診メモ'].map(q).join(','),
  ];
  included.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        r.room,
        r.name,
        r.temp,
        r.bpUpper,
        r.bpLower,
        r.pulse,
        r.spo2,
        r.weight,
        r.note,
      ]
        .map(q)
        .join(',')
    );
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = String(facilityLabel).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  a.download = `往診ノート_${safe}_${weekEndYmd.replace(/-/g, '')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * @param {string} facilitySheetTitle
 * @returns {object | null}
 */
export function loadHomeVisitNoteDraft(facilitySheetTitle) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_LS) || '{}');
    const row = all[String(facilitySheetTitle ?? '').trim()];
    return row && typeof row === 'object' ? row : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} facilitySheetTitle
 * @param {object} draft
 */
export function saveHomeVisitNoteDraft(facilitySheetTitle, draft) {
  try {
    const key = String(facilitySheetTitle ?? '').trim();
    const all = JSON.parse(localStorage.getItem(DRAFT_LS) || '{}');
    all[key] = { ...draft, savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_LS, JSON.stringify(all));
  } catch {
    // ignore quota
  }
}
