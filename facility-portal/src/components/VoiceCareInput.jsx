import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Loader2, Square } from 'lucide-react';
import { createJaRecognizer, isSpeechRecognitionSupported } from '../lib/speechJa';
import { extractCareFieldsFromTranscript } from '../lib/geminiCareExtract';

/**
 * @param {{ apiKey: string; onPatch: (p: { vitals: Record<string, string>; meal: Record<string, unknown> }) => void }} props
 */
export function VoiceCareInput({ apiKey, onPatch }) {
  const [phase, setPhase] = useState('idle');
  const [hint, setHint] = useState('');
  const [lastTranscript, setLastTranscript] = useState('');
  const recRef = useRef(null);
  const listeningRef = useRef(false);

  const stopRec = useCallback(() => {
    recRef.current?.stop?.();
    recRef.current?.abort?.();
    recRef.current = null;
    listeningRef.current = false;
  }, []);

  useEffect(() => () => stopRec(), [stopRec]);

  const startListening = useCallback(() => {
    if (!isSpeechRecognitionSupported()) {
      setHint('Chrome または Edge でご利用ください。');
      setPhase('err');
      return;
    }
    if (phase === 'parsing') return;

    if (listeningRef.current) {
      stopRec();
      setPhase('idle');
      setHint('');
      return;
    }

    setHint('');
    listeningRef.current = true;
    setPhase('listening');

    const rec = createJaRecognizer({
      onResult: async (text) => {
        listeningRef.current = false;
        stopRec();
        setLastTranscript(text);
        setPhase('parsing');
        try {
          const extracted = await extractCareFieldsFromTranscript(apiKey, text);
          onPatch(extracted);
          setHint('フォームに反映しました。内容を確認してください。');
          setPhase('idle');
        } catch (e) {
          setHint(e instanceof Error ? e.message : '処理に失敗しました');
          setPhase('err');
        }
      },
      onError: (msg) => {
        listeningRef.current = false;
        stopRec();
        if (msg) {
          setHint(msg);
          setPhase('err');
        } else {
          setPhase('idle');
        }
      },
    });
    recRef.current = rec;
    rec.start();
  }, [apiKey, onPatch, phase, stopRec]);

  const label =
    phase === 'listening' ? '聞き取り中…（タップで中止）' : phase === 'parsing' ? 'AIが入力中…' : '音声でバイタル・食事を入力';

  return (
    <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50/90 to-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={startListening}
          disabled={phase === 'parsing'}
          className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-3 text-xs font-bold text-white shadow-md transition-all active:scale-95 disabled:opacity-60 ${
            phase === 'listening' ? 'bg-rose-500' : 'bg-blue-600'
          }`}
        >
          {phase === 'parsing' ? (
            <Loader2 size={18} className="animate-spin" />
          ) : phase === 'listening' ? (
            <Square size={18} fill="currentColor" />
          ) : (
            <Mic size={18} />
          )}
          {label}
        </button>
        <p className="min-w-0 flex-1 text-[10px] leading-relaxed text-slate-500">
          例：「体温36度8、SpO2 97、血圧128の76、昼食8割、水分200、内服済み」
        </p>
      </div>
      {lastTranscript && (
        <p className="mt-3 rounded-xl bg-white/80 px-3 py-2 text-[11px] text-slate-600">
          <span className="font-bold text-slate-400">認識: </span>
          {lastTranscript}
        </p>
      )}
      {hint && (
        <p
          className={`mt-2 text-[11px] font-bold ${phase === 'err' ? 'text-rose-600' : 'text-emerald-600'}`}
        >
          {hint}
        </p>
      )}
    </div>
  );
}
