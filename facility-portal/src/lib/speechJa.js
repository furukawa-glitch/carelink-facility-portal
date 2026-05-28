/** @returns {typeof window.SpeechRecognition | null} */
export function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isSpeechRecognitionSupported() {
  return !!getSpeechRecognitionCtor();
}

/**
 * @param {{ onResult: (text: string) => void; onError?: (message: string) => void }} handlers
 */
export function createJaRecognizer(handlers) {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    handlers.onError?.('このブラウザでは音声認識に対応していません（Chrome / Edge を推奨）。');
    return { start: () => {}, stop: () => {}, abort: () => {} };
  }

  const rec = new Ctor();
  rec.lang = 'ja-JP';
  rec.interimResults = false;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onresult = (ev) => {
    const text = ev.results[0]?.[0]?.transcript?.trim() || '';
    if (text) handlers.onResult(text);
  };

  rec.onerror = (ev) => {
    const map = {
      'not-allowed': 'マイクの使用が許可されていません。',
      'no-speech': '音声が検出されませんでした。',
      'network': 'ネットワークエラーです。',
      'aborted': '',
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
