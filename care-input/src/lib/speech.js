/**
 * 音声入力ユーティリティ。
 * - Web Speech API（Chrome / Edge）で音声認識。lang を切り替えて日本語/英語に対応。
 * - 英語→日本語の翻訳は Chrome 内蔵の Translator API（オンデバイス・APIキー不要）を利用。
 *   未対応ブラウザでは null を返すので、呼び出し側で英語のまま保存するなどフォールバックする。
 */

export function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isSpeechRecognitionSupported() {
  return !!getSpeechRecognitionCtor();
}

/**
 * @param {string} lang 例: 'ja-JP' / 'en-US'
 * @param {{ onResult: (text: string) => void; onError?: (msg: string) => void; onEnd?: () => void }} handlers
 */
export function createRecognizer(lang, handlers) {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    handlers.onError?.('このブラウザでは音声認識に対応していません（Chrome / Edge を推奨）。');
    return { start: () => {}, stop: () => {}, abort: () => {} };
  }

  const rec = new Ctor();
  rec.lang = lang || 'ja-JP';
  rec.interimResults = false;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onresult = (ev) => {
    const text = ev.results[0]?.[0]?.transcript?.trim() || '';
    if (text) handlers.onResult(text);
  };
  rec.onend = () => handlers.onEnd?.();
  rec.onerror = (ev) => {
    const map = {
      'not-allowed': 'マイクの使用が許可されていません。',
      'no-speech': '音声が検出されませんでした。',
      network: 'ネットワークエラーです。',
      aborted: '',
    };
    const msg = map[ev.error] ?? `音声認識エラー: ${ev.error}`;
    if (msg) handlers.onError?.(msg);
  };

  return {
    start: () => {
      try {
        rec.start();
      } catch {
        handlers.onError?.('音声認識を開始できませんでした。');
      }
    },
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    },
    abort: () => {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * テキストを翻訳する。Chrome 内蔵 Translator API（オンデバイス）を使用。
 * @param {string} text
 * @param {string} source 例: 'en'
 * @param {string} target 例: 'ja'
 * @returns {Promise<string | null>} 翻訳結果。未対応・失敗時は null
 */
export async function translateText(text, source, target) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const g = typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null;
  if (!g) return null;
  try {
    // 新仕様: self.Translator
    if (typeof g.Translator?.create === 'function') {
      if (typeof g.Translator.availability === 'function') {
        const avail = await g.Translator.availability({ sourceLanguage: source, targetLanguage: target });
        if (avail === 'unavailable') return null;
      }
      const tr = await g.Translator.create({ sourceLanguage: source, targetLanguage: target });
      const out = await tr.translate(t);
      return String(out ?? '').trim() || null;
    }
    // 旧仕様: window.translation.createTranslator
    if (typeof g.translation?.createTranslator === 'function') {
      const tr = await g.translation.createTranslator({ sourceLanguage: source, targetLanguage: target });
      const out = await tr.translate(t);
      return String(out ?? '').trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

export function isTranslateSupported() {
  const g = typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null;
  if (!g) return false;
  return typeof g.Translator?.create === 'function' || typeof g.translation?.createTranslator === 'function';
}
