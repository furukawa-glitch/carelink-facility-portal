import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

function normalizeLine(s) {
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizePersonName(s) {
  return normalizeLine(String(s ?? '').replace(/様\s*$/u, ''));
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
 * @param {File} file
 * @returns {Promise<{ patientName: string; patientNameRaw: string; dispensedOn: string; medicines: string[]; pages: number; fileName: string; }>}
 */
export async function parsePharmacyMedicationPdf(file) {
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

  const linePool = augmentLinesForSplitTitles(lines);
  let patientNameRaw = extractPatientNameRawFromLines(linePool);
  let dispensedOn = extractDispensedOnFromLines(linePool);
  let medicines = extractMedicineNameLines(linePool);

  // 画像PDF・欠けたテキスト層は OCR で補完（氏名・薬剤のいずれか欠けるとき）
  if (!patientNameRaw || medicines.length === 0) {
    const ocrLines = await extractLinesByOcr(doc);
    const ocrPool = augmentLinesForSplitTitles(ocrLines);
    if (!patientNameRaw) {
      const fromOcr = extractPatientNameRawFromLines(ocrPool);
      if (fromOcr) patientNameRaw = fromOcr;
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

  return {
    patientName: pickLikelyResidentName(patientNameRaw),
    patientNameRaw,
    dispensedOn,
    medicines,
    pages: doc.numPages,
    fileName: String(file?.name ?? ''),
  };
}
