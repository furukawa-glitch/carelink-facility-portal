import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import { buildPersonNameMatchCandidates, normalizePersonNameForMatch } from './residentNameMatch.js';
import { readPdfFileAsDataUrl } from './visitCalendarPdf.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

const GEMINI_MODEL = 'gemini-2.5-flash';

function normalizeLine(s) {
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizePersonName(s) {
  return normalizePersonNameForMatch(String(s ?? '').replace(/様\s*$/u, ''));
}

function stripJsonFence(text) {
  const t = String(text ?? '').trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/im.exec(t);
  return m ? m[1].trim() : t;
}

/** テキスト層がほぼ無いスキャンPDF */
function isLikelyScannedPdf(lines) {
  const joined = lines.join('');
  return lines.length < 8 || joined.length < 80;
}

/**
 * 見出し氏名（カナ + 漢字が混在しうる）から照合しやすい氏名を抽出
 * 例: "ヤマザキエミコ 山崎 恵美子" -> "山崎 恵美子"
 * @param {string} raw
 */
function pickLikelyResidentName(raw) {
  const s = normalizePersonName(raw);
  if (!s) return '';
  const idxKanji = s.search(/[一-龥々]/u);
  if (idxKanji >= 0) {
    return normalizePersonName(s.slice(idxKanji));
  }
  return s;
}

let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker('jpn');
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

/**
 * @param {import('pdfjs-dist/types/src/display/api').PDFDocumentProxy} doc
 * @returns {Promise<string[]>}
 */
async function extractLinesByOcr(doc) {
  const worker = await getOcrWorker();
  /** @type {string[]} */
  const lines = [];
  const targetPages = Math.min(doc.numPages, 3);
  for (let p = 1; p <= targetPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const out = await worker.recognize(canvas);
    const text = String(out?.data?.text ?? '');
    lines.push(
      ...text
        .split(/\r\n|\n|\r/u)
        .map((l) => normalizeLine(l))
        .filter(Boolean)
    );
    canvas.width = 1;
    canvas.height = 1;
  }
  return lines;
}

/**
 * PDF text items を行に整形（Y座標が近いものを同じ行として結合）
 * @param {import('pdfjs-dist/types/src/display/api').TextItem[]} items
 * @returns {string[]}
 */
function groupTextItemsToLines(items) {
  /** @type {{ y: number; bits: { x: number; t: string }[] }[]} */
  const rows = [];
  for (const it of items) {
    const t = normalizeLine(it.str);
    if (!t) continue;
    const x = Number(it.transform?.[4] ?? 0);
    const y = Number(it.transform?.[5] ?? 0);
    const hit = rows.find((r) => Math.abs(r.y - y) <= 4);
    if (hit) {
      hit.bits.push({ x, t });
    } else {
      rows.push({ y, bits: [{ x, t }] });
    }
  }
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) => r.bits.sort((a, b) => a.x - b.x).map((b) => b.t).join(' '))
    .map((l) => normalizeLine(l))
    .filter(Boolean);
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function extractMedicineNameLines(lines) {
  const out = [];
  const skip = /^(名称|効能|効果|用法|用量|服用|副作用|注意|表|裏|【般】|【のみぐすり】|一包化|朝|昼|夕|就寝前|寝る前)$/u;
  for (const line of lines) {
    const l = normalizeLine(line);
    if (!l || l.length > 72) continue;
    if (skip.test(l)) continue;
    if (!/[ぁ-んァ-ヶ一-龥A-Za-zａ-ｚＡ-Ｚ]/u.test(l)) continue;
    if (/様のお薬|お薬説明書|調剤日|ページ|^\d+\s*\/\s*\d+$/u.test(l)) continue;
    const looksLikeDose = /(?:\d+(?:\.\d+)?)\s*(?:mg|ｍｇ|g|Ｇ|μg|ug|mL|ml|％|%|単位|μｇ)/iu.test(l);
    const looksLikeDrugWord =
      /(錠|OD錠|カプセル|散|顆粒|細粒|シロップ|テープ|貼付|坐剤|吸入|点眼|配合|注|ゲル|軟膏|クリーム|内用|外用|液|旋|バイアル|懸濁)/u.test(l);
    const numberedDrug = /^\d{1,2}[.、)）]\s*.+(?:錠|カプセル|散|顆粒|mg|ｍｇ|mL)/iu.test(l);
    if (!(looksLikeDose || looksLikeDrugWord || numberedDrug)) continue;
    out.push(l);
  }
  return Array.from(new Set(out));
}

/**
 * 書式・OCRの揺れに対応した氏名（生文字列）
 * @param {string[]} lines
 */
function extractPatientNameRawFromLines(lines) {
  const nameRegexes = [
    /(.{1,42}?)\s*様\s*の\s*お薬\s*説明書/u,
    /(.{1,42}?)\s*様\s*の\s*お薬の説明書/u,
    /(.{1,42}?)\s*様\s*の\s*おくすり/u,
    /(.{1,42}?)\s*様お薬説明書/u,
    /(.{1,42}?)\s*様\s+お薬説明書/u,
    /(.{1,42}?)\s*さん\s*の\s*お薬\s*説明書/u,
    /(.{2,24}?)\s*様\s*(?:の|$)/u,
    /(?:利用者|患者|ご利用者)(?:氏名|名)[:：\s]*(.{2,24})/u,
  ];
  for (const line of lines) {
    const L = normalizeLine(line);
    if (!L || L.length > 120) continue;
    for (const re of nameRegexes) {
      const m = re.exec(L);
      if (!m?.[1]) continue;
      const raw = normalizeLine(m[1]).replace(/^[のにをは]+/u, '');
      if (raw.length >= 2 && raw.length <= 36 && !/^(調剤|ページ|お薬|説明)/u.test(raw)) return raw;
    }
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const glued = normalizeLine(`${lines[i]}${lines[i + 1]}`);
    if (glued.length > 140) continue;
    for (const re of nameRegexes) {
      const m = re.exec(glued);
      if (!m?.[1]) continue;
      const raw = normalizeLine(m[1]).replace(/^[のにをは]+/u, '');
      if (raw.length >= 2 && raw.length <= 36 && !/^(調剤|ページ)/u.test(raw)) return raw;
    }
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const a = normalizeLine(lines[i]);
    const b = normalizeLine(lines[i + 1]);
    if (/^(利用者氏名|患者氏名|ご利用者様|氏名|お名前)[:：]?$/u.test(a)) {
      const cand = b.replace(/様\s*$/u, '').trim();
      if (cand.length >= 2 && cand.length <= 36 && /[一-龥々ァ-ヶ]/u.test(cand)) return cand;
    }
    const inline = /^(利用者氏名|患者氏名|氏名|お名前)[:：]\s*(.+)$/u.exec(a);
    if (inline?.[2]) {
      const cand = normalizeLine(inline[2]).replace(/様\s*$/u, '').trim();
      if (cand.length >= 2 && cand.length <= 36) return cand;
    }
  }
  return '';
}

/**
 * @param {string[]} lines
 */
function extractDispensedOnFromLines(lines) {
  for (const line of lines) {
    const L = normalizeLine(line);
    const m1 = /調剤日[:：\s]*(\d{4}年\d{1,2}月\d{1,2}日)/u.exec(L);
    if (m1) return m1[1];
    const m2 = /調剤日[:：\s]*(\d{4})[./年](\d{1,2})[./月](\d{1,2})/u.exec(L);
    if (m2) return `${m2[1]}年${Number(m2[2])}月${Number(m2[3])}日`;
  }
  return '';
}

/** @param {string[]} lines */
function augmentLinesForSplitTitles(lines) {
  const norm = lines.map((l) => normalizeLine(l)).filter(Boolean);
  const extra = [];
  for (let i = 0; i < norm.length - 1; i++) {
    extra.push(`${norm[i]}${norm[i + 1]}`);
    extra.push(`${norm[i]} ${norm[i + 1]}`);
  }
  return Array.from(new Set([...norm, ...extra]));
}

/**
 * スキャンPDF向け: Gemini で氏名・薬剤を読み取り
 * @param {string} apiKey
 * @param {File} file
 */
async function fetchPharmacyMedicationFromPdfGemini(apiKey, file) {
  const dataUrl = await readPdfFileAsDataUrl(file);
  let b64 = String(dataUrl ?? '').trim();
  if (b64.includes(',')) b64 = String(b64.split(',').pop() ?? '').trim();
  b64 = b64.replace(/\s/g, '');
  if (!b64) throw new Error('PDFのデータが空です');

  const prompt = `添付は薬局の「お薬説明書」PDFです。利用者1名分として次のJSONオブジェクト1つだけ返してください（説明文・Markdown禁止）。

{
  "patientName": "利用者氏名（様・さんは除く。姓と名の間にスペースがあってもそのまま）",
  "patientNameKana": "フリガナがあれば（なければ空文字）",
  "dispensedOn": "調剤日（例: 2026年6月3日。読めなければ空文字）",
  "medicines": ["薬剤名の行のみの配列"]
}

ルール:
- 表題の「○○様のお薬説明書」から patientName を最優先。
- カナと漢字が並ぶ場合は漢字氏名を patientName、カナを patientNameKana。
- 推測で氏名を補完しない。`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: b64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!res.ok || !text) {
    const msg = data?.error?.message || res.statusText || 'Gemini API エラー';
    throw new Error(msg);
  }
  const parsed = JSON.parse(stripJsonFence(text));
  const patientName = String(parsed?.patientName ?? '').trim();
  const patientNameKana = String(parsed?.patientNameKana ?? '').trim();
  const dispensedOn = String(parsed?.dispensedOn ?? '').trim();
  const medicines = Array.isArray(parsed?.medicines)
    ? parsed.medicines.map((m) => normalizeLine(String(m ?? ''))).filter(Boolean)
    : [];
  const patientNameRaw = [patientNameKana, patientName].filter(Boolean).join(' ').trim() || patientName;
  return { patientName, patientNameRaw, patientNameKana, dispensedOn, medicines };
}

/**
 * @param {File} file
 * @param {{ geminiApiKey?: string }} [options]
 * @returns {Promise<{ patientName: string; patientNameRaw: string; patientNameKana: string; patientNameCandidates: string[]; dispensedOn: string; medicines: string[]; pages: number; fileName: string; source: string; }>}
 */
export async function parsePharmacyMedicationPdf(file, options = {}) {
  const geminiApiKey = String(options?.geminiApiKey ?? '').trim();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  /** @type {string[]} */
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const text = await page.getTextContent();
    const items = /** @type {import('pdfjs-dist/types/src/display/api').TextItem[]} */ (text.items);
    lines.push(...groupTextItemsToLines(items));
  }

  const scanned = isLikelyScannedPdf(lines);
  const linePool = augmentLinesForSplitTitles(lines);
  let patientNameRaw = extractPatientNameRawFromLines(linePool);
  let patientNameKana = '';
  let dispensedOn = extractDispensedOnFromLines(linePool);
  let medicines = extractMedicineNameLines(linePool);
  let source = 'pdf_text';

  const needOcr = scanned || !patientNameRaw || medicines.length === 0;
  if (needOcr) {
    const ocrLines = await extractLinesByOcr(doc);
    const ocrPool = augmentLinesForSplitTitles(ocrLines);
    if (!patientNameRaw) {
      const fromOcr = extractPatientNameRawFromLines(ocrPool);
      if (fromOcr) {
        patientNameRaw = fromOcr;
        source = 'ocr';
      }
    }
    if (!dispensedOn) {
      const d2 = extractDispensedOnFromLines(ocrPool);
      if (d2) dispensedOn = d2;
    }
    const mergedPool = Array.from(new Set([...linePool, ...ocrPool]));
    const ocrMeds = extractMedicineNameLines(mergedPool);
    if (ocrMeds.length) medicines = ocrMeds;
    else if (!medicines.length) medicines = extractMedicineNameLines(ocrPool);
  }

  if (geminiApiKey && (scanned || !patientNameRaw || medicines.length === 0)) {
    try {
      const gem = await fetchPharmacyMedicationFromPdfGemini(geminiApiKey, file);
      if (gem.patientNameRaw) patientNameRaw = gem.patientNameRaw;
      if (gem.patientNameKana) patientNameKana = gem.patientNameKana;
      if (gem.dispensedOn) dispensedOn = gem.dispensedOn;
      if (gem.medicines?.length) medicines = gem.medicines;
      source = 'gemini';
    } catch {
      /* OCR/テキスト結果を維持 */
    }
  }

  const patientName = pickLikelyResidentName(patientNameRaw);
  const patientNameCandidates = buildPersonNameMatchCandidates(
    patientName,
    patientNameRaw,
    patientNameKana,
    pickLikelyResidentName(patientNameRaw.replace(/[ァ-ヶー\s]+/gu, ' ').trim())
  );

  return {
    patientName,
    patientNameRaw,
    patientNameKana,
    patientNameCandidates,
    dispensedOn,
    medicines,
    pages: doc.numPages,
    fileName: String(file?.name ?? ''),
    source,
  };
}
