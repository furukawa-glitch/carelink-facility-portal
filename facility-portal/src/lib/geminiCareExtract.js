const MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `あなたは有料老人ホームの記録入力支援です。スタッフの日本語の発話（文字起こし）から、明示的に言及された項目だけをJSONにします。推測で埋めないでください。言及がなければそのキーは省略してください。

出力スキーマ（省略可能なキーのみ含める）:
{
  "vitals": {
    "temp": "体温℃ 文字列（例 36.5）",
    "spo2": "酸素飽和度 %",
    "pulse": "脈拍 bpm",
    "bpUpper": "収縮期血圧",
    "bpLower": "拡張期血圧",
    "weight": "体重 kg"
  },
  "meal": {
    "mealTime": "朝 | 昼 | 夕 | おやつ のいずれか",
    "mealValue": "0〜10 の文字列（10割=10）",
    "isMissedMeal": true/false（欠食のとき true）,
    "hydration": "水分摂取量 ml の数字だけの文字列",
    "hasSupplement": true/false（補助食あり）,
    "medicationDone": true/false（内服済/飲んだ=true、未/拒否=false）,
    "enteralExecuted": true/false（経管栄養を実施したと言ったとき true）
  }
}

ルール:
- 血圧「128の76」「120/80」→ bpUpper 128, bpLower 76 など。
- 食事「8割」「全量」「10割」→ mealValue は "8","10" 等。
- 水分「200ミリ」「200cc」→ hydration "200"`;

function stripJsonFence(text) {
  const t = text.trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/im.exec(t);
  return m ? m[1].trim() : t;
}

export async function extractCareFieldsFromTranscript(apiKey, transcript) {
  if (!apiKey?.trim()) {
    throw new Error('APIキーが設定されていません。.env に VITE_GEMINI_API_KEY を設定してください。');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `${SYSTEM_PROMPT}\n\n---\n発話:\n${transcript}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || 'Gemini API エラー';
    throw new Error(msg);
  }

  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof raw !== 'string') {
    throw new Error('応答の形式が不正です');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new Error('JSON の解析に失敗しました');
  }

  return {
    vitals: parsed.vitals && typeof parsed.vitals === 'object' ? parsed.vitals : {},
    meal: parsed.meal && typeof parsed.meal === 'object' ? parsed.meal : {},
  };
}
