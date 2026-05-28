import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Download, FileWarning, Loader2, Mic, Printer, Save, Wand2, X } from 'lucide-react';
import { getAccidentDeptOptions } from '../config/accidentDeptConfig.js';
import { getReporterStaffNameOptionsForFacilityDept } from '../lib/staffRosterPicklist.js';
import { filterResidentsForNamePicker } from '../services/GoogleSheetService.js';
import { NEAR_MISS_CATEGORY_LABELS } from '../services/nearMissReportHtml.js';
import * as Report from '../services/ReportService.js';
import * as NearMissLedger from '../services/NearMissLedgerService.js';

/** srcDoc 更新時に iframe が再マウントされ、プレビューが白紙のまま残るのを防ぐ */
function previewSrcDocKey(html) {
  let h = 5381;
  for (let i = 0; i < html.length; i++) h = ((h << 5) + h) ^ html.charCodeAt(i);
  return String(h >>> 0);
}

function emptyDraft() {
  const d = new Date();
  return {
    submitYear: String(d.getFullYear()),
    submitMonth: String(d.getMonth() + 1),
    submitDay: String(d.getDate()),
    reporterName: '',
    reporterDept: '',
    residentName: '',
    occurYear: '',
    occurMonth: '',
    occurDay: '',
    occurAmPm: '',
    occurHour: '',
    occurMinute: '',
    occurPlace: '',
    categories: /** @type {string[]} */ ([]),
    categoryOther: '',
    situationContent: '',
    afterReportContent: '',
    causeAndMeasures: '',
    bulletMemo: '',
  };
}

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   geminiKey: string;
 *   facilityLabel: string;
 *   residents: Record<string, unknown>[];
 * }} props
 */
export function NearMissReportModal({ open, onClose, geminiKey, facilityLabel, residents }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [pickId, setPickId] = useState('');
  const [deptChoice, setDeptChoice] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reflectFlash, setReflectFlash] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const dictationRef = useRef(/** @type {SpeechRecognition | null} */ (null));
  const [dictField, setDictField] = useState('');
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState('');
  const voiceRef = useRef(/** @type {SpeechRecognition | null} */ (null));
  const voiceKeepAliveRef = useRef(false);
  const voiceRestartTimerRef = useRef(/** @type {number | null} */ (null));
  const voiceLastErrorRef = useRef('');

  const speechErrorMessageJa = useCallback((code) => {
    const c = String(code ?? '').trim();
    if (!c) return '音声入力に失敗しました。';
    if (c === 'not-allowed' || c === 'service-not-allowed') {
      return 'マイクの使用が許可されていません。アドレスバーの設定からマイクを許可してください。';
    }
    if (c === 'audio-capture') {
      return 'マイクが見つかりません。マイク接続とブラウザ設定を確認してください。';
    }
    if (c === 'network') {
      return '音声認識の通信に失敗しました。ネットワーク状態を確認してください。';
    }
    if (c === 'no-speech') {
      return '音声が検出されませんでした。マイクに近づいてもう一度お試しください。';
    }
    if (c === 'aborted') {
      return '音声入力が中断されました。';
    }
    return `音声認識エラー: ${c}`;
  }, []);

  const deptKey = String(facilityLabel ?? '').trim();
  const deptOptions = useMemo(() => getAccidentDeptOptions(deptKey), [deptKey]);
  const activeReporterDept = useMemo(() => {
    if (deptChoice === '__manual__') return String(draft.reporterDept ?? '').trim();
    if (deptChoice) return String(deptChoice).trim();
    return String(draft.reporterDept ?? '').trim();
  }, [deptChoice, draft.reporterDept]);
  const staffNameOptions = useMemo(
    () => (open ? getReporterStaffNameOptionsForFacilityDept(deptKey, activeReporterDept) : []),
    [open, deptKey, activeReporterDept]
  );
  const reporterNameListId = useId();
  const pickerResidents = useMemo(() => filterResidentsForNamePicker(residents), [residents]);

  useEffect(() => {
    if (!pickId) return;
    if (!pickerResidents.some((r) => String(r.id) === pickId)) setPickId('');
  }, [pickId, pickerResidents]);

  useEffect(() => {
    if (!open) {
      voiceKeepAliveRef.current = false;
      if (voiceRestartTimerRef.current != null) {
        window.clearTimeout(voiceRestartTimerRef.current);
        voiceRestartTimerRef.current = null;
      }
      try {
        voiceRef.current?.stop();
      } catch {
        // noop
      }
      voiceRef.current = null;
      setVoiceListening(false);
      setVoiceInterim('');
      return;
    }
    setDraft(emptyDraft());
    setDeptChoice('');
    setPickId('');
    setShowAdvanced(false);
    setReflectFlash(false);
    setVoiceListening(false);
    setVoiceInterim('');
  }, [open, facilityLabel]);

  useEffect(() => {
    if (!open) return;
    if (!deptOptions.length) {
      setDeptChoice('');
      return;
    }
    setDeptChoice(deptOptions[0]);
    setDraft((p) => ({ ...p, reporterDept: deptOptions[0] }));
  }, [open, deptKey, deptOptions]);

  const previewHtml = useMemo(
    () => Report.buildNearMissReportHtml(draft, { preview: true }),
    [draft]
  );
  const previewIframeKey = useMemo(() => previewSrcDocKey(previewHtml), [previewHtml]);

  const applyResident = useCallback(
    (id) => {
      const r = residents.find((x) => String(x.id) === String(id));
      if (!r) return;
      setDraft((p) => ({ ...p, residentName: String(r.name ?? '').replace(/様\s*$/, '').trim() }));
    },
    [residents]
  );

  const toggleCategory = useCallback((label) => {
    setDraft((p) => {
      const s = new Set(p.categories ?? []);
      if (s.has(label)) s.delete(label);
      else s.add(label);
      return { ...p, categories: [...s] };
    });
  }, []);

  const stopVoice = useCallback(() => {
    voiceKeepAliveRef.current = false;
    if (voiceRestartTimerRef.current != null) {
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
    try {
      voiceRef.current?.stop();
    } catch {
      // noop
    }
    voiceRef.current = null;
    setVoiceListening(false);
    setVoiceInterim('');
  }, []);

  const startDict = useCallback((fieldKey) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert('このブラウザでは音声入力を利用できません');
      return;
    }
    if (voiceListening) stopVoice();
    try {
      dictationRef.current?.stop();
    } catch {
      // noop
    }
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (ev) => {
      const text = String(ev.results?.[0]?.[0]?.transcript ?? '').trim();
      if (!text) return;
      setDraft((prev) => {
        if (fieldKey === 'bulletMemo') {
          return { ...prev, bulletMemo: prev.bulletMemo ? `${prev.bulletMemo}\n${text}` : text };
        }
        return {
          ...prev,
          [fieldKey]: prev[fieldKey] ? `${prev[fieldKey]}\n${text}` : text,
        };
      });
    };
    rec.onend = () => setDictField('');
    rec.onerror = (ev) => {
      setDictField('');
      const code = String(ev?.error ?? '');
      if (code && code !== 'aborted') {
        alert(speechErrorMessageJa(code));
      }
    };
    dictationRef.current = rec;
    setDictField(fieldKey);
    try {
      rec.start();
    } catch {
      setDictField('');
      alert('音声入力を開始できませんでした。もう一度お試しください。');
    }
  }, [voiceListening, stopVoice, speechErrorMessageJa]);

  const stopDict = useCallback(() => {
    try {
      dictationRef.current?.stop();
    } catch {
      // noop
    }
    setDictField('');
  }, []);

  const toggleVoice = useCallback(() => {
    if (typeof window === 'undefined') return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert('このブラウザは音声入力に対応していません（Chrome 推奨）');
      return;
    }
    if (voiceListening) {
      stopVoice();
      return;
    }
    try {
      voiceRef.current?.stop();
    } catch {
      // noop
    }
    stopDict();
    const startSession = () => {
      const rec = new SR();
      rec.lang = 'ja-JP';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const t = String(r[0]?.transcript ?? '').trim();
          if (!t) continue;
          if (r.isFinal) {
            setDraft((prev) => ({ ...prev, bulletMemo: prev.bulletMemo ? `${prev.bulletMemo}\n${t}` : t }));
          } else {
            interim += r[0].transcript;
          }
        }
        setVoiceInterim(interim.trim());
      };
      rec.onerror = (ev) => {
        const code = String(ev?.error ?? '');
        voiceLastErrorRef.current = code;
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(code)) {
          voiceKeepAliveRef.current = false;
          setVoiceListening(false);
          setVoiceInterim('');
          if (code === 'audio-capture') {
            alert('マイクが見つかりません。マイク接続とブラウザ設定を確認してください。');
          } else {
            alert('マイクの使用が許可されていません。アドレスバーの設定からマイクを許可してください。');
          }
        }
      };
      rec.onend = () => {
        setVoiceInterim('');
        voiceRef.current = null;
        if (!voiceKeepAliveRef.current) {
          setVoiceListening(false);
          return;
        }
        const delay = voiceLastErrorRef.current === 'aborted' ? 450 : 220;
        voiceLastErrorRef.current = '';
        voiceRestartTimerRef.current = window.setTimeout(() => {
          if (!voiceKeepAliveRef.current) return;
          startSession();
        }, delay);
      };
      voiceRef.current = rec;
      try {
        rec.start();
        setVoiceListening(true);
      } catch {
        setVoiceListening(false);
      }
    };
    voiceKeepAliveRef.current = true;
    startSession();
  }, [voiceListening, stopVoice, stopDict]);

  useEffect(() => () => stopVoice(), [stopVoice]);

  const runAi = useCallback(async () => {
    if (voiceListening) stopVoice();
    const memoParts = [String(draft.bulletMemo ?? '').trim(), String(voiceInterim ?? '').trim()].filter(Boolean);
    const memo = memoParts.join('\n').trim();
    if (!memo) {
      alert('箇条書きメモを入力してください');
      return;
    }
    if (memo !== String(draft.bulletMemo ?? '').trim()) {
      setDraft((p) => ({ ...p, bulletMemo: memo }));
    }
    setBusy(true);
    try {
      const noAiKey = !String(geminiKey ?? '').trim();
      const patch = await Report.fetchNearMissReportFromBullets(geminiKey, memo, deptKey);
      if (!patch) return;
      setDraft((p) => ({
        ...p,
        reporterName: patch.reporterName ?? p.reporterName,
        reporterDept: patch.reporterDept || p.reporterDept,
        residentName: patch.residentName ?? p.residentName,
        occurPlace: patch.occurPlace ?? p.occurPlace,
        occurAmPm: patch.occurAmPm ?? p.occurAmPm,
        occurHour: patch.occurHour != null ? String(patch.occurHour) : p.occurHour,
        occurMinute: patch.occurMinute != null ? String(patch.occurMinute) : p.occurMinute,
        occurYear: patch.occurYear != null ? String(patch.occurYear) : p.occurYear,
        occurMonth: patch.occurMonth != null ? String(patch.occurMonth) : p.occurMonth,
        occurDay: patch.occurDay != null ? String(patch.occurDay) : p.occurDay,
        submitYear: String(patch.submitYear ?? p.submitYear),
        submitMonth: String(patch.submitMonth ?? p.submitMonth),
        submitDay: String(patch.submitDay ?? p.submitDay),
        situationContent: patch.situationContent ?? p.situationContent,
        afterReportContent: patch.afterReportContent ?? p.afterReportContent,
        causeAndMeasures: patch.causeAndMeasures ?? p.causeAndMeasures,
        categories: Array.isArray(patch.categories) ? patch.categories : p.categories,
        categoryOther: patch.categoryOther ?? p.categoryOther,
        bulletMemo: p.bulletMemo,
      }));
      setReflectFlash(true);
      setTimeout(() => setReflectFlash(false), 1500);
      if (noAiKey) {
        alert('AIキー未設定のため、簡易反映で作成しました。より精度を上げるには VITE_GEMINI_API_KEY を設定してください。');
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [draft.bulletMemo, voiceInterim, voiceListening, stopVoice, geminiKey, deptKey]);

  const printReport = useCallback(() => {
    Report.openPrintableSummary(Report.buildNearMissReportHtml(draft, { preview: false }));
  }, [draft]);

  const downloadReport = useCallback(() => {
    const html = Report.buildNearMissReportHtml(draft, { preview: false });
    const name = `ヒヤリハット報告_${(draft.reporterName || '未記入').replace(/[\\/:*?"<>|]/g, '_')}.html`;
    Report.downloadSummaryHtml(name, html);
  }, [draft]);

  const saveLog = useCallback(async () => {
    const dept = String(draft.reporterDept ?? '').trim();
    if (!dept) {
      alert('所属（部署）を選ぶか手入力してください');
      return;
    }
    const { bulletMemo: _b, ...rest } = draft;
    const entry = Report.saveNearMissReport({
      facilityLabel: deptKey,
      department: dept,
      residentId: pickId,
      draft: rest,
    });
    if (entry) {
      try {
        const { sheetResult } = await NearMissLedger.appendNoticeFromSavedReport({
          id: entry.id,
          savedAt: entry.savedAt,
          facilityLabel: deptKey,
          draft: entry.draft,
        });
        NearMissLedger.alertIfNearMissYoushiMirrorSkipped(sheetResult);
        if (sheetResult?.skipped) {
          alert(
            `ログは端末に保存しましたが、スプレッドシートに追記できません。\n${String(sheetResult.reason || 'GAS URL 未設定')}`
          );
        } else if (!sheetResult?.ok) {
          alert(
            `スプレッドシート追記に失敗しました: ${NearMissLedger.formatNearMissGasWriteError(sheetResult?.error)}\n` +
              'ヒント: .env.local 更新後は npm run dev の再起動が必要です。本番では Vercel の環境変数と /api/near-miss-gas を確認してください。'
          );
        }
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    }
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 1500);
  }, [draft, deptKey, pickId]);

  if (!open) return null;

  const dictBtn = (key, label) => (
    <button
      type="button"
      onClick={() => (dictField === key ? stopDict() : startDict(key))}
      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold ${
        dictField === key ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
      }`}
    >
      <Mic className="h-3.5 w-3.5" />
      {dictField === key ? '停止' : label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[215] flex items-center justify-center bg-black/60 p-4">
      <datalist id={reporterNameListId}>
        {staffNameOptions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="max-h-[94vh] w-full max-w-6xl overflow-y-auto rounded-3xl border-4 border-teal-800/40 bg-white p-5 shadow-2xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xl font-black text-slate-800">
            <FileWarning className="h-7 w-7 text-teal-700" />
            ヒヤリハット（気づき）報告書
          </h3>
          <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="閉じる">
            <X className="h-6 w-6" />
          </button>
        </div>

        <p className="mb-3 text-sm text-slate-600">
          かんたん入力は「利用者名」「スタッフ名」「音声メモ」だけで使えます。AI が残りの欄を自動作成し、右のプレビューに反映します。
        </p>

        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-xs font-bold text-slate-600">所属（部署）</span>
                <select
                  value={deptChoice}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDeptChoice(v);
                    setDraft((p) => ({ ...p, reporterDept: v === '__manual__' ? p.reporterDept : v }));
                  }}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                >
                  <option value="">— 選択 —</option>
                  {deptOptions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                  <option value="__manual__">手入力</option>
                </select>
              </label>
              {(deptChoice === '__manual__' || !deptOptions.length) && (
                <label className="flex flex-col gap-1 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-600">所属（手入力）</span>
                    {dictBtn('reporterDept', '音声')}
                  </div>
                  <input
                    value={draft.reporterDept}
                    onChange={(e) => setDraft((p) => ({ ...p, reporterDept: e.target.value }))}
                    className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-xs font-bold text-slate-600">利用者（名簿から選択）</span>
                <select
                  value={pickId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setPickId(id);
                    applyResident(id);
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                >
                  <option value="">— 選択 —</option>
                  {pickerResidents.map((r) => (
                    <option key={String(r.id)} value={String(r.id)}>
                      {String(r.name)} 様
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-600">
                    スタッフ名
                    {staffNameOptions.length > 0 ? (
                      <span className="ml-1 text-[10px] font-bold text-emerald-700">（候補 {staffNameOptions.length} 名）</span>
                    ) : null}
                  </span>
                  {dictBtn('reporterName', '音声')}
                </div>
                <input
                  list={reporterNameListId}
                  value={draft.reporterName}
                  onChange={(e) => setDraft((p) => ({ ...p, reporterName: e.target.value }))}
                  placeholder="部署を選ぶと候補が出ます（入力も可）"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                  autoComplete="off"
                />
              </label>
              <div />
            </div>

            <div className="rounded-xl border border-teal-200 bg-teal-50 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-black text-teal-950">箇条書きメモ → AI でテンプレートに流し込み（です・ます調）</span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => toggleVoice()}
                    className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-black text-white ${
                      voiceListening ? 'bg-rose-600 hover:bg-rose-500' : 'bg-amber-600 hover:bg-amber-500'
                    }`}
                  >
                    <Mic className="h-4 w-4" />
                    {voiceListening ? '話すのを止める' : '話す'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runAi()}
                    className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-black text-white disabled:opacity-40 ${
                      reflectFlash ? 'bg-emerald-600' : 'bg-teal-600'
                    }`}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    {reflectFlash ? '反映しました' : '反映'}
                  </button>
                </div>
              </div>
              <textarea
                value={draft.bulletMemo}
                onChange={(e) => setDraft((p) => ({ ...p, bulletMemo: e.target.value }))}
                rows={5}
                placeholder="例：・3/10 14時 デイホール&#10;・田中様、移乗時にバランスを崩す&#10;・スタッフ 山田・佐藤で支えて着席&#10;・ホームに報告済み、見守り強化を共有"
                className="w-full rounded-lg border border-teal-300 bg-white px-2 py-2 text-sm font-bold"
              />
              {voiceListening && (
                <p className="mt-2 text-center text-sm font-bold text-amber-900">聞き取り中… 終わったら「話すのを止める」</p>
              )}
              {voiceInterim ? <p className="mt-1 line-clamp-3 text-center text-xs text-amber-800/90">{voiceInterim}</p> : null}
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100"
            >
              {showAdvanced ? '詳細入力を閉じる（通常は不要）' : '詳細入力を開く（必要なときだけ）'}
            </button>

            {showAdvanced && (
              <>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">提出日（年）</span>
                <input
                  value={draft.submitYear}
                  onChange={(e) => setDraft((p) => ({ ...p, submitYear: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">月</span>
                <input
                  value={draft.submitMonth}
                  onChange={(e) => setDraft((p) => ({ ...p, submitMonth: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">日</span>
                <input
                  value={draft.submitDay}
                  onChange={(e) => setDraft((p) => ({ ...p, submitDay: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-600">報告者</span>
                  {dictBtn('reporterName', '音声')}
                </div>
                <input
                  list={reporterNameListId}
                  value={draft.reporterName}
                  onChange={(e) => setDraft((p) => ({ ...p, reporterName: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                  autoComplete="off"
                />
              </label>
              <div />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-600">利用者名</span>
                  {dictBtn('residentName', '音声')}
                </div>
                <input
                  value={draft.residentName}
                  onChange={(e) => setDraft((p) => ({ ...p, residentName: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
              <label className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-600">発生場所</span>
                  {dictBtn('occurPlace', '音声')}
                </div>
                <input
                  value={draft.occurPlace}
                  onChange={(e) => setDraft((p) => ({ ...p, occurPlace: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-6">
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-bold text-slate-600">発生日（年）</span>
                <input
                  value={draft.occurYear}
                  onChange={(e) => setDraft((p) => ({ ...p, occurYear: e.target.value }))}
                  placeholder="任意"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">月</span>
                <input
                  value={draft.occurMonth}
                  onChange={(e) => setDraft((p) => ({ ...p, occurMonth: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">日</span>
                <input
                  value={draft.occurDay}
                  onChange={(e) => setDraft((p) => ({ ...p, occurDay: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-bold text-slate-600">午前 / 午後</span>
                <select
                  value={draft.occurAmPm}
                  onChange={(e) => setDraft((p) => ({ ...p, occurAmPm: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                >
                  <option value="">—</option>
                  <option value="午前">午前</option>
                  <option value="午後">午後</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">時</span>
                <input
                  value={draft.occurHour}
                  onChange={(e) => setDraft((p) => ({ ...p, occurHour: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">分</span>
                <input
                  value={draft.occurMinute}
                  onChange={(e) => setDraft((p) => ({ ...p, occurMinute: e.target.value }))}
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
                />
              </label>
            </div>

            <div>
              <div className="mb-1 text-xs font-bold text-slate-600">【区分】</div>
              <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
                {NEAR_MISS_CATEGORY_LABELS.map((lab) => (
                  <label key={lab} className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs font-bold shadow-sm">
                    <input
                      type="checkbox"
                      checked={(draft.categories ?? []).includes(lab)}
                      onChange={() => toggleCategory(lab)}
                    />
                    {lab}
                  </label>
                ))}
                <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs font-bold shadow-sm">
                  <input
                    type="checkbox"
                    checked={(draft.categories ?? []).includes('その他') || Boolean(String(draft.categoryOther ?? '').trim())}
                    onChange={() => toggleCategory('その他')}
                  />
                  その他
                </label>
              </div>
              <input
                value={draft.categoryOther}
                onChange={(e) => setDraft((p) => ({ ...p, categoryOther: e.target.value }))}
                placeholder="その他の内容"
                className="mt-2 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
              />
            </div>

            <label className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-600">内容（【状況】）</span>
                {dictBtn('situationContent', '音声')}
              </div>
              <textarea
                value={draft.situationContent}
                onChange={(e) => setDraft((p) => ({ ...p, situationContent: e.target.value }))}
                rows={4}
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-600">報告後の内容（【対応】）</span>
                {dictBtn('afterReportContent', '音声')}
              </div>
              <textarea
                value={draft.afterReportContent}
                onChange={(e) => setDraft((p) => ({ ...p, afterReportContent: e.target.value }))}
                rows={4}
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-600">原因と今後の対策</span>
                {dictBtn('causeAndMeasures', '音声')}
              </div>
              <textarea
                value={draft.causeAndMeasures}
                onChange={(e) => setDraft((p) => ({ ...p, causeAndMeasures: e.target.value }))}
                rows={4}
                className="rounded-lg border border-slate-300 px-2 py-2 text-sm font-bold"
              />
            </label>

            </>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={saveLog}
                className={`flex flex-1 items-center justify-center gap-2 rounded-2xl py-3 text-sm font-black ${
                  saveFlash ? 'bg-emerald-500 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-500'
                }`}
              >
                <Save className="h-5 w-5" />
                {saveFlash ? '保存しました' : 'ログに保存'}
              </button>
              <button
                type="button"
                onClick={printReport}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3 text-sm font-black text-white"
              >
                <Printer className="h-5 w-5" />
                印刷で開く
              </button>
              <button
                type="button"
                onClick={downloadReport}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-slate-400 py-3 text-sm font-black text-slate-800"
              >
                <Download className="h-5 w-5" />
                HTML保存
              </button>
            </div>
            {!geminiKey?.trim() && <p className="text-xs text-amber-700">APIキー未設定時は簡易モードで反映します。</p>}
          </div>

          <div className="flex min-h-[480px] flex-col rounded-2xl border-2 border-slate-300 bg-slate-100 p-2">
            <p className="mb-2 text-center text-xs font-bold text-slate-600">書式プレビュー（テンプレートそのまま）</p>
            <iframe
              key={previewIframeKey}
              title="ヒヤリハット報告プレビュー"
              className="min-h-[560px] w-full flex-1 rounded-lg border border-slate-200 bg-white"
              srcDoc={previewHtml}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
