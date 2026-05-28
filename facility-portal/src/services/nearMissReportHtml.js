/**
 * ヒヤリハット(気づき)報告書 — ユーザー指定 HTML テンプレート（構造・スタイルは変更しない）
 * 未入力項目は「特になし」を差し込む
 */

export const NEAR_MISS_CATEGORY_LABELS = Object.freeze([
  '転倒',
  '転落',
  '衝突',
  '誤嚥/誤飲',
  '異食',
  '誤薬',
  '暴行',
  '自虐行為',
  '器物破損',
  '離棟/徘徊',
  '紛失/盗難',
  '車両事故',
]);

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(s) {
  return escapeHtml(s).replace(/\n/g, '<br/>');
}

function tokunashi(s) {
  const t = String(s ?? '').trim();
  return t ? escapeHtml(t) : '特になし';
}

function parseYmdPart(v) {
  const n = parseInt(String(v ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function formatSubmitDateSpan(draft) {
  const y = parseYmdPart(draft.submitYear);
  const m = parseYmdPart(draft.submitMonth);
  const d = parseYmdPart(draft.submitDay);
  if (!y || !m || !d) return '特になし';
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '特になし';
  const reiwaStart = new Date(2019, 4, 1);
  if (dt < reiwaStart) {
    return `西暦　${escapeHtml(String(y))}　年　${escapeHtml(String(m).padStart(2, '0'))}　月　${escapeHtml(String(d).padStart(2, '0'))}　日`;
  }
  const reiwaNum = y - 2018;
  return `令和　${escapeHtml(String(reiwaNum))}　年　${escapeHtml(String(m).padStart(2, '0'))}　月　${escapeHtml(String(d).padStart(2, '0'))}　日`;
}

/** 発生日＋発生時間を1セルに（テンプレの「発生時間」欄。日付は任意） */
function formatOccurDateTimeCell(draft) {
  const y = parseYmdPart(draft.occurYear);
  const mo = parseYmdPart(draft.occurMonth);
  const d = parseYmdPart(draft.occurDay);
  let datePart = '';
  if (y && mo && d) {
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
      datePart = `${escapeHtml(String(y))}年${escapeHtml(String(mo))}月${escapeHtml(String(d))}日　`;
    }
  }
  const ap = String(draft.occurAmPm ?? '').trim();
  const h = String(draft.occurHour ?? '').trim();
  const mi = String(draft.occurMinute ?? '').trim();
  const hasTime = Boolean(ap || h || mi);
  if (!datePart && !hasTime) return '特になし';
  const apPart = ap || '午前 ・ 午後';
  const timePart = hasTime
    ? `${escapeHtml(apPart)}　${escapeHtml(h || '　')}　時　${escapeHtml(mi || '　')}　分頃`
    : '';
  return `${datePart}${timePart}`.trim();
}

function categoryChecked(selected, label) {
  const set = new Set((selected ?? []).map((x) => String(x).trim()));
  return set.has(label) ? ' checked' : '';
}

function categoryOtherChecked(draft) {
  const sel = new Set((Array.isArray(draft.categories) ? draft.categories : []).map((x) => String(x).trim()));
  if (sel.has('その他')) return ' checked';
  if (String(draft.categoryOther ?? '').trim()) return ' checked';
  return '';
}

function categoryGridHtml(draft) {
  const sel = Array.isArray(draft.categories) ? draft.categories : [];
  const c = (label) => categoryChecked(sel, label);
  const co = categoryOtherChecked(draft);
  return `
            <div class="category-item"><input type="checkbox"${c('転倒')}>転倒</div>
            <div class="category-item"><input type="checkbox"${c('転落')}>転落</div>
            <div class="category-item"><input type="checkbox"${c('衝突')}>衝突</div>
            <div class="category-item"><input type="checkbox"${c('誤嚥/誤飲')}>誤嚥/誤飲</div>
            <div class="category-item"><input type="checkbox"${c('異食')}>異食</div>
            <div class="category-item"><input type="checkbox"${c('誤薬')}>誤薬</div>
            <div class="category-item"><input type="checkbox"${c('暴行')}>暴行</div>
            <div class="category-item"><input type="checkbox"${c('自虐行為')}>自虐行為</div>
            <div class="category-item"><input type="checkbox"${c('器物破損')}>器物破損</div>
            <div class="category-item"><input type="checkbox"${c('離棟/徘徊')}>離棟/徘徊</div>
            <div class="category-item"><input type="checkbox"${c('紛失/盗難')}>紛失/盗難</div>
            <div class="category-item"><input type="checkbox"${c('車両事故')}>車両事故</div>
            <div class="category-item" style="grid-column: span 3;">
                <input type="checkbox"${co}>その他(<span contenteditable="true" style="border-bottom: 1px solid #999; min-width: 150px; display: inline-block;">${String(
                  draft.categoryOther ?? ''
                ).trim()
                  ? escapeHtml(String(draft.categoryOther).trim())
                  : '特になし'}</span>)
            </div>`;
}

function section1Inner(draft) {
  const sit = String(draft.situationContent ?? '').trim() || '特になし';
  const aft = String(draft.afterReportContent ?? '').trim() || '特になし';
  return `【状況】\n\n${sit}\n\n【対応】\n\n${aft}`;
}

function section2Inner(draft) {
  const body = String(draft.causeAndMeasures ?? '').trim() || '特になし';
  return `【原因と今後の対策】\n\n${body}`;
}

/**
 * @param {Record<string, unknown>} draft
 * @param {{ preview?: boolean }} [opts] preview 時はフッターボタンを非表示
 */
export function buildNearMissReportHtml(draft, opts = {}) {
  const d = draft ?? {};
  const preview = Boolean(opts.preview);
  const bodyClass = preview ? ' class="print-style nm-preview-hide-controls"' : '';

  const resident = String(d.residentName ?? '').trim();
  const residentCell = resident ? `${escapeHtml(resident)}　様` : '特になし';

  const section1 = nl2br(section1Inner(d));
  const section2 = nl2br(section2Inner(d));

  return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ヒヤリハット(気づき)報告書</title>
    <style>
        /* A4サイズ印刷設定 */
        @page {
            size: A4;
            margin: 0;
        }

        :root {
            --primary: #2c3e50;
            --secondary: #34495e;
            --border: #bdc3c7;
            --bg-light: #f8f9fa;
        }

        /* 画面表示用基本スタイル */
        html, body {
            margin: 0;
            padding: 0;
            background-color: #f0f2f5;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
        }

        body {
            font-family: "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif;
            color: #333;
            line-height: 1.5;
        }

        .page {
            width: 210mm;
            min-height: 297mm;
            margin: 20px auto;
            padding: 15mm;
            background: white;
            box-shadow: 0 0 15px rgba(0,0,0,0.1);
            box-sizing: border-box;
            position: relative;
        }

        /* ヘッダー */
        .header-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-bottom: 10px;
            border-bottom: 2px solid var(--primary);
            padding-bottom: 5px;
        }

        .title-area h1 {
            margin: 0;
            font-size: 20px;
            color: var(--primary);
            letter-spacing: 1px;
        }

        .ver { font-size: 10px; color: #666; margin-left: 10px; }

        .submission-info {
            text-align: right;
            font-size: 13px;
        }

        /* テーブル */
        .info-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 15px;
        }

        .info-table td {
            border: 1px solid var(--border);
            padding: 8px 12px;
            font-size: 13px;
        }

        .label {
            background-color: var(--bg-light);
            font-weight: bold;
            width: 14%;
        }

        /* 区分 */
        .category-container {
            border: 1px solid var(--border);
            padding: 10px;
            margin-bottom: 20px;
        }

        .category-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 6px;
            font-size: 12px;
        }

        .category-item {
            display: flex;
            align-items: center;
        }

        .category-item input { margin-right: 6px; }

        /* 見出し */
        h2 {
            font-size: 15px;
            background: var(--primary);
            color: white;
            padding: 6px 12px;
            margin: 20px 0 10px 0;
            border-radius: 2px;
        }

        /* 入力エリア */
        .editable-area {
            min-height: 180px;
            border: 1px solid var(--border);
            padding: 15px;
            font-size: 14px;
            white-space: pre-wrap;
            outline: none;
            line-height: 1.8;
        }

        /* 操作ボタン */
        .controls {
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 1000;
            display: flex;
            gap: 15px;
        }

        .btn-print {
            background: #27ae60;
            color: white;
            border: none;
            padding: 15px 40px;
            font-size: 16px;
            font-weight: bold;
            border-radius: 50px;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        }

        .btn-copy {
            background: #3498db;
            color: white;
            border: none;
            padding: 15px 40px;
            font-size: 16px;
            font-weight: bold;
            border-radius: 50px;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        }

        /* 印刷用CSS（新ウィンドウでも適用される） */
        .print-style {
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
        }

        @media print {
            .no-print { display: none !important; }
            body { background: white !important; }
            .page {
                margin: 0 !important;
                box-shadow: none !important;
                width: 100% !important;
                border: none !important;
            }
        }

        .nm-preview-hide-controls .controls { display: none !important; }
    </style>
</head>
<body${bodyClass}>

<div class="page" id="report-content">
    <div class="header-top">
        <div class="title-area">
            <h1>ヒヤリハット(気づき)報告書 <span class="ver">ver.1.2</span></h1>
        </div>
        <div class="submission-info">
            提出日：<span contenteditable="true">${formatSubmitDateSpan(d)}</span>
        </div>
    </div>

    <table class="info-table">
        <tr>
            <td class="label">報告者</td>
            <td contenteditable="true">${tokunashi(d.reporterName)}</td>
            <td class="label">所属事業所</td>
            <td contenteditable="true" style="width: 35%;">${tokunashi(d.reporterDept)}</td>
        </tr>
        <tr>
            <td class="label">利用者名</td>
            <td contenteditable="true">${residentCell}</td>
            <td class="label">発生時間</td>
            <td contenteditable="true">${formatOccurDateTimeCell(d)}</td>
        </tr>
        <tr>
            <td class="label">発生場所</td>
            <td colspan="3" contenteditable="true">${tokunashi(d.occurPlace)}</td>
        </tr>
    </table>

    <div class="category-container">
        <div style="font-size: 12px; font-weight: bold; margin-bottom: 8px;">【区分】</div>
        <div class="category-grid">${categoryGridHtml(d)}
        </div>
    </div>

    <h2>1. 成果・気付き（ヒヤリハット詳細・対応）</h2>
    <div class="editable-area" contenteditable="true">${section1}</div>

    <h2>2. 課題・共有事項（再発防止策）</h2>
    <div class="editable-area" contenteditable="true" style="min-height: 250px;">${section2}</div>
</div>

<div class="controls no-print">
    <button class="btn-print" id="print-button">📄 PDF保存・印刷</button>
    <button class="btn-copy" id="copy-button">📋 内容をコピー</button>
</div>

<script>
    document.getElementById('print-button').addEventListener('click', function() {
        window.print();
    });
    document.getElementById('copy-button').addEventListener('click', function() {
        const area = document.getElementById('report-content');
        const selection = window.getSelection();
        const range = document.createRange();
        selection.removeAllRanges();
        range.selectNodeContents(area);
        selection.addRange(range);
        const btn = document.getElementById('copy-button');
        const originalText = "📋 内容をコピー";
        try {
            const successful = document.execCommand('copy');
            if (successful) {
                btn.innerText = "✅ コピー完了！";
                btn.style.background = "#27ae60";
                setTimeout(function() {
                    btn.innerText = originalText;
                    btn.style.background = "#3498db";
                    selection.removeAllRanges();
                }, 2000);
            } else {
                throw new Error();
            }
        } catch (err) {
            btn.innerText = "⚠️ そのまま Ctrl+C を押して下さい";
            btn.style.background = "#e67e22";
            setTimeout(function() {
                btn.innerText = originalText;
                btn.style.background = "#3498db";
            }, 4000);
        }
    });
</script>

</body>
</html>`;
}
