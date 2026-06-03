const MODEL = 'gemini-2.5-flash';

function stripJsonFence(text) {
  const t = String(text ?? '').trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/im.exec(t);
  return m ? m[1].trim() : t;
}

/**
 * クリニックの「訪問カレンダー」PDF を Gemini で構造化
 * @param {string} apiKey
 * @param {string} pdfBase64 Data URL または base64
 * @param {{ facilityLabel?: string; yearMonth?: string }} [context]
 * @returns {Promise<{ clinicName: string; yearMonth: string; days: { date: string; doctor: string; visitType: string; patientNames: string[] }[] }>}
 */
export async function fetchHomeVisitCalendarFromPdf(apiKey, pdfBase64, context = {}) {
  if (!apiKey?.trim()) throw new Error('VITE_GEMINI_API_KEY が必要です');
  let b64 = String(pdfBase64 ?? '').trim();
  if (b64.includes(',')) b64 = String(b64.split(',').pop() ?? '').trim();
  b64 = b64.replace(/\s/g, '');
  if (!b64) throw new Error('PDFのデータが空です');

  const fac = String(context.facilityLabel ?? '').trim();
  const ymHint = String(context.yearMonth ?? '').trim();

  const prompt = `添付PDFは在宅クリニック等から施設に渡される「訪問カレンダー」「往診予定表」です。
表形式の各日付セルから、往診（定期診察・精神科往診など）がある日だけを抽出し、JSONオブジェクト1つだけ返してください（説明文・Markdown禁止）。

【施設名（参考）】${fac || '—'}
【対象月のヒント】${ymHint || 'PDF表題から推定'}

出力スキーマ:
{
  "clinicName": "クリニック名（例: たなか在宅クリニック）",
  "yearMonth": "YYYY-MM（表の月。令和表記は西暦に変換）",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "doctor": "担当医（例: 柿本Dr。複数いる場合は / で連結）",
      "visitType": "定期診察 | 精神科往診 等",
      "patientNames": ["利用者氏名（様は除く）", "..."]
    }
  ]
}

ルール:
- 往診対象者が1名もいない日は days に含めない。
- patientNames は「〇〇様」の「様」を除いた氏名のみ。カンマ・改行で区切られた名前をすべて配列に。
- 日付はセル左上の 4/7 火 等から西暦 YYYY-MM-DD に。年は表題の月・yearMonth と整合させる。
- 読み取れない名前は推測で補完しない。確信が持てる名前だけ。
- 表全体に該当がなければ days は空配列。`;

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
    generationConfig: { temperature: 0.1, maxOutputTokens: 16384, responseMimeType: 'application/json' },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
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
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    throw new Error('往診カレンダーのJSON解析に失敗しました');
  }
  const clinicName = String(parsed?.clinicName ?? '').trim();
  const yearMonth = String(parsed?.yearMonth ?? ymHint ?? '').trim();
  const rawDays = Array.isArray(parsed?.days) ? parsed.days : [];
  /** @type {{ date: string; doctor: string; visitType: string; patientNames: string[] }[]} */
  const days = [];
  for (const d of rawDays) {
    const date = String(d?.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const patientNames = (Array.isArray(d?.patientNames) ? d.patientNames : [])
      .map((n) => String(n ?? '').replace(/様\s*$/u, '').trim())
      .filter(Boolean);
    if (!patientNames.length) continue;
    days.push({
      date,
      doctor: String(d?.doctor ?? '').trim(),
      visitType: String(d?.visitType ?? '往診').trim() || '往診',
      patientNames: Array.from(new Set(patientNames)),
    });
  }
  return { clinicName, yearMonth, days };
}

/** @param {File} file */
export function readPdfFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('PDFの読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });
}
