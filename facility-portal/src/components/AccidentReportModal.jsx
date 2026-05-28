import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ambulance, ChevronDown, ChevronUp, Download, Loader2, Mic, MicOff, Printer, Save, Trash2, Wand2, X } from 'lucide-react';
import { getAccidentDeptOptions } from '../config/accidentDeptConfig.js';
import {
  ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS,
  getAccidentMedicalDraftPatch,
  isAccidentKitanagoyaFacility,
} from '../config/accidentMedicalConfig.js';
import { getReporterStaffNameOptionsForFacilityDept } from '../lib/staffRosterPicklist.js';
import { filterResidentsForNamePicker } from '../services/GoogleSheetService.js';
import * as NearMissLedger from '../services/NearMissLedgerService.js';
import * as Report from '../services/ReportService.js';

function emptyDraft() {
  const d = new Date();
  const y = d.getFullYear();
  const era2 = String(y % 100).padStart(2, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return {
    reportYear2: era2,
    reportMonth: m,
    reportDay: day,
    reporterName: '',
    reporterJob: '',
    reporterDept: '',
    occurYear2: era2,
    occurMonth: m,
    occurDay: day,
    occurDayNote: '',
    occurAmPm: '',
    occurHour: '',
    occurMinute: '',
    occurPlace: '',
    residentName: '',
    genderAge: '（ 男 ・ 女 ）　 歳',
    accidentTypeDetail: '',
    situation: '',
    response: '',
    familyReportMonth: '',
    familyReportDay: '',
    causes: '',
    improvements: '',
    injuryAssessment: '',
    supervisorOpinion: '',
    reviewNeeded: '',
    otherNotes: '',
    medicalInstitutionName: '',
    medicalInstitutionCode: '',
    medicalInstitutionAddress: '',
    medicalInstitutionTel: '',
    aiMemo: '',
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
export function AccidentReportModal({ open, onClose, geminiKey, facilityLabel, residents }) {
  const formatRosterSyncError = useCallback((e) => {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    const lower = String(msg).toLowerCase();
    if (lower.includes('operation is not supported for this document') || lower.includes('not supported for this document')) {
      return 'この職員名簿は API で直接読めない形式です。Googleスプレッドシートとして保存し直したIDに変更してください。';
    }
    if (lower.includes('permission') || lower.includes('forbidden')) {
      return '職員名簿シートへの閲覧権限がありません。共有設定またはAPIキー制限を確認してください。';
    }
    if (lower.includes('not found')) {
      return '職員名簿シートが見つかりません。シートID/GIDの設定を確認してください。';
    }
    return msg || '職員名簿の同期に失敗しました';
  }, []);

  const normalizeName = useCallback((s) => String(s ?? '').trim().replace(/\s+/g, ''), []);
  const pickRosterMatchedName = useCallback(
    (rawName, options) => {
      const base = String(rawName ?? '').trim();
      if (!base) return '';
      if (!Array.isArray(options) || !options.length) return base;
      if (options.includes(base)) return base;
      const n = normalizeName(base);
      const hit = options.find((o) => normalizeName(o) === n);
      return hit || '';
    },
    [normalizeName]
  );

  const [draft, setDraft] = useState(emptyDraft);
  const [pickId, setPickId] = useState('');
  const [busy, setBusy] = useState(false);
  const [showManualFields, setShowManualFields] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState('');
  const [deptChoice, setDeptChoice] = useState('');
  const [voiceMemo, setVoiceMemo] = useState('');
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [aiBuilt, setAiBuilt] = useState(false);
  const [rosterSyncRev, setRosterSyncRev] = useState(0);
  const [rosterSyncTried, setRosterSyncTried] = useState(false);
  const [rosterSyncBusy, setRosterSyncBusy] = useState(false);
  const [rosterSyncError, setRosterSyncError] = useState('');
  const canvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null));
  const drawing = useRef(false);
  const last = useRef(/** @type {{ x: number; y: number } | null} */ (null));
  const voiceRef = useRef(/** @type {SpeechRecognition | null} */ (null));
  const voiceKeepAliveRef = useRef(false);
  const voiceRestartTimerRef = useRef(/** @type {number | null} */ (null));
  const voiceLastErrorRef = useRef('');
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  /** ユーザーが「話す」を ON にしている間 true（API の end で勝手に OFF にしない） */
  const voiceActiveRef = useRef(false);
  /** stop や再開で古い onend を無効化 */
  const voiceSessionRef = useRef(0);
  const [saveFlash, setSaveFlash] = useState(false);
  const [eraserOn, setEraserOn] = useState(false);
  const [kitanagoyaMedicalKey, setKitanagoyaMedicalKey] = useState(
    () => ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS[0]?.key ?? ''
  );

  const deptKey = String(facilityLabel ?? '').trim();
  const isKitanagoya = isAccidentKitanagoyaFacility(deptKey);
  const deptOptions = useMemo(() => getAccidentDeptOptions(deptKey), [deptKey]);
  const activeReporterDept = useMemo(() => {
    if (deptChoice === '__manual__') return String(draft.reporterDept ?? '').trim();
    if (deptChoice) return String(deptChoice).trim();
    return String(draft.reporterDept ?? '').trim();
  }, [deptChoice, draft.reporterDept]);
  const staffNameOptions = useMemo(
    () => (open ? getReporterStaffNameOptionsForFacilityDept(deptKey, activeReporterDept) : []),
    [open, deptKey, activeReporterDept, rosterSyncRev]
  );
  const pickerResidents = useMemo(() => filterResidentsForNamePicker(residents), [residents]);
  const savedAccidentEntries = useMemo(() => {
    const list = Report.getAccidentReports();
    return list
      .filter((row) => String(row?.facilityLabel ?? '').trim() === deptKey)
      .slice(0, 40);
  }, [deptKey, open]);

  const pickedResident = useMemo(
    () => pickerResidents.find((x) => String(x.id) === pickId) ?? null,
    [pickerResidents, pickId]
  );

  useEffect(() => {
    if (!pickId) return;
    if (!pickerResidents.some((r) => String(r.id) === pickId)) setPickId('');
  }, [pickId, pickerResidents]);

  useEffect(() => {
    if (!open) return;
    const base = emptyDraft();
    const firstK = ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS[0]?.key ?? '';
    setKitanagoyaMedicalKey(firstK);
    const med = isKitanagoya
      ? getAccidentMedicalDraftPatch(deptKey, firstK)
      : getAccidentMedicalDraftPatch(deptKey);
    setDraft({ ...base, ...med });
    setDeptChoice('');
    setPickId('');
    setVoiceMemo('');
    setVoiceListening(false);
    setVoiceInterim('');
    setShowTranscript(false);
    setAiBuilt(false);
    setShowManualFields(false);
    setEditingEntryId('');
    setRosterSyncTried(false);
    setRosterSyncBusy(false);
    setRosterSyncError('');
  }, [open, facilityLabel, deptKey, isKitanagoya]);

  const syncRosterNow = useCallback(async () => {
    const sheetsKey = String(import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '').trim();
    if (!sheetsKey) {
      setRosterSyncError('VITE_GOOGLE_SHEETS_API_KEY が未設定です');
      return false;
    }
    setRosterSyncBusy(true);
    setRosterSyncError('');
    try {
      await NearMissLedger.syncStaffRosterFromHrSheetAndStore(sheetsKey);
      return true;
    } catch (e) {
      setRosterSyncError(formatRosterSyncError(e));
      return false;
    } finally {
      setRosterSyncBusy(false);
      setRosterSyncRev((n) => n + 1);
    }
  }, [formatRosterSyncError]);

  useEffect(() => {
    if (!open) return;
    if (staffNameOptions.length > 0) return;
    if (rosterSyncTried) return;
    const sheetsKey = String(import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '').trim();
    if (!sheetsKey) return;
    setRosterSyncTried(true);
    void (async () => {
      if (rosterSyncBusy) return;
      await syncRosterNow();
    })();
  }, [open, staffNameOptions.length, rosterSyncTried, rosterSyncBusy, syncRosterNow]);

  useEffect(() => {
    if (!open) return;
    if (!deptOptions.length) {
      setDeptChoice('');
      return;
    }
    setDeptChoice(deptOptions[0]);
    setDraft((p) => ({ ...p, reporterDept: deptOptions[0] }));
  }, [open, deptKey, deptOptions]);

  useEffect(() => {
    if (!pickId || !pickedResident) {
      setDraft((p) => ({ ...p, residentName: '' }));
      return;
    }
    let name = String(pickedResident.name ?? '').trim().replace(/様\s*$/u, '').trim();
    setDraft((p) => ({ ...p, residentName: name }));
  }, [pickId, pickedResident]);

  useEffect(() => {
    if (!pickedResident) return;
    const birth = String(pickedResident.birthDateLabel ?? '').trim();
    const age = String(pickedResident.ageLabel ?? '').trim();
    const g = String(pickedResident.genderLabel ?? '').trim();
    const genderAge = g || age ? `（ ${g || '—'} ） ${age || '—'} 歳` : '';
    const contact = Report.getEmergencyContact(String(pickedResident.id ?? ''));
    const contactLine = `【緊急連絡先】${String(contact?.name ?? '（未登録）')} / ${String(contact?.relation ?? '—')} / ${String(contact?.tel ?? '—')}`;
    setDraft((p) => ({
      ...p,
      genderAge: genderAge || p.genderAge,
      otherNotes: p.otherNotes && p.otherNotes.includes('【緊急連絡先】') ? p.otherNotes : `${contactLine}${p.otherNotes ? `\n${p.otherNotes}` : ''}`,
      occurYear2: p.occurYear2,
      reportYear2: p.reportYear2,
      // 生年月日は現行帳票の専用欄がないため otherNotes へ追記（印刷には反映）
      aiMemo: p.aiMemo,
      situation: p.situation,
      response: p.response,
      causes: p.causes,
      improvements: p.improvements,
      injuryAssessment: p.injuryAssessment,
      supervisorOpinion: p.supervisorOpinion,
      reviewNeeded: p.reviewNeeded,
      reporterName: p.reporterName,
      reporterJob: p.reporterJob,
      reporterDept: p.reporterDept,
      residentName: p.residentName,
      accidentTypeDetail: p.accidentTypeDetail,
      occurPlace: p.occurPlace,
      occurAmPm: p.occurAmPm,
      occurHour: p.occurHour,
      occurMinute: p.occurMinute,
      occurMonth: p.occurMonth,
      occurDay: p.occurDay,
      submitMonth: p.submitMonth,
      submitDay: p.submitDay,
      familyReportMonth: p.familyReportMonth,
      familyReportDay: p.familyReportDay,
      medicalInstitutionName: p.medicalInstitutionName,
      medicalInstitutionCode: p.medicalInstitutionCode,
      medicalInstitutionAddress: p.medicalInstitutionAddress,
      medicalInstitutionTel: p.medicalInstitutionTel,
      ...(birth && !p.otherNotes?.includes('生年月日') ? { otherNotes: `${birth ? `【生年月日】${birth}\n` : ''}${contactLine}${p.otherNotes ? `\n${p.otherNotes}` : ''}` } : {}),
    }));
  }, [pickedResident]);

  useEffect(() => {
    // 所属を変えたとき、名簿候補外の氏名はクリアして誤保存を防ぐ
    if (!staffNameOptions.length) return;
    const cur = String(draft.reporterName ?? '').trim();
    if (!cur) return;
    if (!staffNameOptions.includes(cur)) {
      setDraft((p) => ({ ...p, reporterName: '' }));
    }
  }, [staffNameOptions, draft.reporterName]);

  useEffect(() => {
    // ログイン職員名（周知プロフィール）を、候補にある場合は初期値として反映
    if (!staffNameOptions.length) return;
    const cur = String(draft.reporterName ?? '').trim();
    if (cur) return;
    const profileName = String(NearMissLedger.getStaffProfile()?.displayName ?? '').trim();
    const matched = pickRosterMatchedName(profileName, staffNameOptions);
    if (matched) {
      setDraft((p) => ({ ...p, reporterName: matched }));
    }
  }, [staffNameOptions, draft.reporterName, pickRosterMatchedName]);

  useEffect(() => {
    if (!open) return;
    return () => {
      try {
        voiceRef.current?.stop();
      } catch {
        // noop
      }
    };
  }, [open]);

  const initCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    if (open) {
      const t = requestAnimationFrame(() => initCanvas());
      return () => cancelAnimationFrame(t);
    }
  }, [open, initCanvas]);

  const getPos = useCallback((e) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const scaleX = c.width / rect.width;
    const scaleY = c.height / rect.height;
    return { x: (cx - rect.left) * scaleX, y: (cy - rect.top) * scaleY };
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      e.preventDefault();
      drawing.current = true;
      last.current = getPos(e);
    },
    [getPos]
  );

  const onPointerMove = useCallback(
    (e) => {
      if (!drawing.current || !last.current) return;
      e.preventDefault();
      const c = canvasRef.current;
      const ctx = c?.getContext('2d');
      if (!ctx) return;
      const p = getPos(e);
      ctx.globalCompositeOperation = eraserOn ? 'destination-out' : 'source-over';
      ctx.lineWidth = eraserOn ? 16 : 2;
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last.current = p;
    },
    [getPos, eraserOn]
  );

  const endStroke = useCallback(() => {
    drawing.current = false;
    last.current = null;
  }, []);

  const sketchDataUrl = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return null;
    try {
      return c.toDataURL('image/png');
    } catch {
      return null;
    }
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
            setVoiceMemo((prev) => (prev ? `${prev}\n${t}` : t));
          } else {
            interim += r[0].transcript;
          }
        }
        setVoiceInterim(interim.trim());
      };
      rec.onerror = (ev) => {
        const code = String(ev?.error ?? '');
        voiceLastErrorRef.current = code;
        // 権限/デバイス系エラーは再開させず明示停止
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
        // no-speech は無音なので素早く再開、aborted は少し待って再開
        const delay = voiceLastErrorRef.current === 'aborted' ? 450 : 220;
        voiceLastErrorRef.current = '';
        // セッションが途切れても短時間で自動再開
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
  }, [voiceListening, stopVoice]);

  const reporterDeptPreset = useMemo(() => {
    if (deptChoice === '__manual__') return String(draft.reporterDept ?? '').trim();
    return deptChoice || String(draft.reporterDept ?? '').trim();
  }, [deptChoice, draft.reporterDept]);

  const runVoiceAi = useCallback(async () => {
    if (!geminiKey?.trim()) {
      alert('VITE_GEMINI_API_KEY が未設定です');
      return;
    }
    if (!pickId) {
      alert('先に利用者を選んでください');
      return;
    }
    if (!reporterDeptPreset) {
      alert('所属（部署）を選んでください');
      return;
    }
    const text = String(voiceMemo ?? '').trim();
    if (!text) {
      alert('「話す」ボタンで、状況とスタッフ名などを音声で話してください');
      return;
    }
    stopVoice();
    setBusy(true);
    try {
      const patch = await Report.fetchAccidentReportFromVoiceMemo(geminiKey, text, {
        facilityLabel: deptKey,
        residentName: String(pickedResident?.name ?? '')
          .trim()
          .replace(/様\s*$/u, '')
          .trim(),
        room: String(pickedResident?.room ?? ''),
        reporterDeptPreset,
      });
      const med = getAccidentMedicalDraftPatch(deptKey, isKitanagoya ? kitanagoyaMedicalKey : undefined);
      setDraft((prev) => ({
        ...prev,
        ...patch,
        reporterName:
          pickRosterMatchedName(patch.reporterName, staffNameOptions) ||
          pickRosterMatchedName(prev.reporterName, staffNameOptions) ||
          pickRosterMatchedName(NearMissLedger.getStaffProfile()?.displayName, staffNameOptions) ||
          prev.reporterName,
        injuryAssessment: String(patch.injuryAssessment ?? '').trim()
          ? String(patch.injuryAssessment).trim()
          : prev.injuryAssessment,
        ...med,
        aiMemo: '',
      }));
      setAiBuilt(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'AI作成に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [
    geminiKey,
    pickId,
    reporterDeptPreset,
    voiceMemo,
    stopVoice,
    deptKey,
    pickedResident,
    isKitanagoya,
    kitanagoyaMedicalKey,
  ]);

  const importMemoFile = useCallback((file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const t = String(r.result ?? '').trim();
      if (!t) {
        alert('ファイルからテキストが抽出できませんでした');
        return;
      }
      const clipped = t.slice(0, 12000);
      setVoiceMemo((prev) => (prev ? `${prev}\n${clipped}` : clipped));
      setShowTranscript(true);
    };
    r.onerror = () => alert('ファイル読み込みに失敗しました');
    r.readAsText(file);
  }, []);

  const printReport = useCallback(() => {
    const url = sketchDataUrl();
    const html = Report.buildAccidentReportHtml(draft, url);
    Report.openPrintableSummary(html);
  }, [draft, sketchDataUrl]);

  const downloadReport = useCallback(() => {
    const url = sketchDataUrl();
    const html = Report.buildAccidentReportHtml(draft, url);
    Report.downloadSummaryHtml(`事故報告書_${draft.residentName || '未記入'}.html`, html);
  }, [draft, sketchDataUrl]);

  const saveToMonthlyLog = useCallback(async () => {
    const dept = String(draft.reporterDept ?? '').trim();
    if (!dept) {
      alert('所属（部署）を選んでください');
      return;
    }
    const hasReportBody =
      aiBuilt ||
      String(draft.situation ?? '').trim() ||
      String(draft.injuryAssessment ?? '').trim() ||
      String(draft.response ?? '').trim() ||
      String(draft.causes ?? '').trim() ||
      String(draft.improvements ?? '').trim();
    if (!hasReportBody) {
      alert('先に「AIで報告書を作成」するか、状況・アセスメント・対応など本文を入力してください');
      return;
    }
    const { aiMemo: _m, upperLimbComment: _u, ...draftForStore } = draft;
    const entry = editingEntryId
      ? Report.updateAccidentReport(editingEntryId, {
          facilityLabel: deptKey,
          department: dept,
          residentId: pickId,
          draft: draftForStore,
        })
      : Report.saveAccidentReport({
          facilityLabel: deptKey,
          department: dept,
          residentId: pickId,
          draft: draftForStore,
        });
    if (entry) {
      try {
        const { sheetResult: ledgerResult } = await NearMissLedger.appendNoticeFromSavedAccidentReport({
          id: entry.id,
          savedAt: entry.savedAt,
          facilityLabel: deptKey,
          draft: entry.draft,
        });
        const accidentResult = await NearMissLedger.appendAccidentReportToSpreadsheet(entry);
        const lines = [];
        if (ledgerResult?.skipped || ledgerResult?.ok === false) {
          lines.push(
            `「報告」シート: ${ledgerResult?.skipped ? String(ledgerResult.reason) : NearMissLedger.formatNearMissGasWriteError(ledgerResult?.error)}`
          );
        }
        if (accidentResult?.skipped || accidentResult?.ok === false) {
          lines.push(
            `「事故報告データ」シート: ${accidentResult?.skipped ? String(accidentResult.reason) : NearMissLedger.formatNearMissGasWriteError(accidentResult?.error)}`
          );
        }
        if (lines.length) {
          alert(`ログは端末に保存しましたが、次の追記に失敗しました。\n${lines.join('\n')}`);
        }
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    }
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 1500);
  }, [draft, deptKey, pickId, aiBuilt, editingEntryId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-3xl border-4 border-slate-700 bg-white p-5 shadow-2xl sm:max-w-xl">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-lg font-black text-slate-800 sm:text-xl">
            <Ambulance className="h-6 w-6 shrink-0 text-slate-700 sm:h-7 sm:w-7" />
            事故報告書
          </h3>
          <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="閉じる">
            <X className="h-6 w-6" />
          </button>
        </div>

        <p className="mb-4 rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold leading-relaxed text-slate-700">
          音声入力でも手入力でも作成できます。AI作成後の内容も修正可能です。確認は<span className="text-slate-900">印刷</span>で行ってください。
        </p>

        <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-violet-900">保存済み事故報を読み込んで修正</span>
            <select
              value={editingEntryId}
              onChange={(e) => {
                const id = e.target.value;
                setEditingEntryId(id);
                if (!id) return;
                const row = savedAccidentEntries.find((x) => String(x?.id ?? '') === id);
                if (!row) return;
                const loadedRaw = row?.draft && typeof row.draft === 'object' ? row.draft : {};
                const { upperLimbComment: _drop, ...loaded } = loadedRaw;
                const med = getAccidentMedicalDraftPatch(
                  String(row.facilityLabel ?? deptKey),
                  isKitanagoya ? kitanagoyaMedicalKey : undefined
                );
                setDraft((prev) => ({ ...prev, ...loaded, ...med, aiMemo: String(loaded.aiMemo ?? '') }));
                setPickId(String(row.residentId ?? ''));
                setShowManualFields(true);
              }}
              className="rounded-lg border border-violet-300 bg-white px-2 py-2 text-sm font-bold"
            >
              <option value="">新規作成</option>
              {savedAccidentEntries.map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row?.draft?.residentName ?? '利用者未設定')} / {String(row.department ?? '部署未設定')} / {String(row.savedAt ?? '').slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[11px] text-violet-900/80">
            読み込み後に編集して「{editingEntryId ? '保存内容を上書き' : '月次分析用に保存'}」で保存できます。
          </p>
        </div>

        <div className="mb-4 space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-600">利用者</span>
            <select
              value={pickId}
              onChange={(e) => setPickId(e.target.value)}
              className="rounded-xl border-2 border-slate-300 px-3 py-3 text-base font-bold"
            >
              <option value="">— 選んでください —</option>
              {pickerResidents.map((r) => (
                <option key={String(r.id)} value={String(r.id)}>
                  {String(r.name)} 様 {String(r.room)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-600">所属（部署）</span>
            <select
              value={deptChoice}
              onChange={(e) => {
                const v = e.target.value;
                setDeptChoice(v);
                setDraft((p) => ({ ...p, reporterDept: v === '__manual__' ? p.reporterDept : v }));
              }}
              className="rounded-xl border-2 border-slate-300 px-3 py-3 text-base font-bold"
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
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">所属（手入力）</span>
              <input
                value={draft.reporterDept}
                onChange={(e) => setDraft((p) => ({ ...p, reporterDept: e.target.value }))}
                className="rounded-xl border-2 border-slate-300 px-3 py-2.5 text-base font-bold"
                placeholder="例: 訪問介護"
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-600">
              報告者氏名
              <button
                type="button"
                onClick={() => void syncRosterNow()}
                disabled={rosterSyncBusy}
                className="ml-2 inline-flex items-center rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {rosterSyncBusy ? '同期中' : '再同期'}
              </button>
              {staffNameOptions.length > 0 ? (
                <span className="ml-1 text-[11px] font-bold text-emerald-700">
                  （職員名簿と連動: {staffNameOptions.length} 名）
                </span>
              ) : (
                <span className="ml-1 text-[10px] font-normal text-slate-500">
                  候補を自動同期中です。出ない場合は周知パネルで名簿同期してください
                </span>
              )}
            </span>
            {!staffNameOptions.length && rosterSyncError ? (
              <span className="text-[10px] font-bold text-rose-700">
                同期エラー: {rosterSyncError}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void syncRosterNow()}
              disabled={rosterSyncBusy}
              className="self-start rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {rosterSyncBusy ? '職員名簿を同期中...' : '職員名簿を再同期'}
            </button>
            {staffNameOptions.length > 0 ? (
              <select
                value={staffNameOptions.includes(String(draft.reporterName ?? '').trim()) ? draft.reporterName : ''}
                onChange={(e) => setDraft((p) => ({ ...p, reporterName: e.target.value }))}
                className="rounded-xl border-2 border-slate-300 px-3 py-2.5 text-base font-bold"
              >
                <option value="">— 職員名簿から選択 —</option>
                {staffNameOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={draft.reporterName}
                onChange={(e) => setDraft((p) => ({ ...p, reporterName: e.target.value }))}
                placeholder="名簿未同期のため手入力"
                className="rounded-xl border-2 border-slate-300 px-3 py-2.5 text-base font-bold"
                autoComplete="off"
              />
            )}
          </label>

          <div className="rounded-xl border-2 border-sky-200 bg-sky-50/80 p-3">
            <span className="text-xs font-bold text-sky-900">医療機関情報（報告書・カイポケ連携用）</span>
            {isKitanagoya ? (
              <label className="mt-2 flex flex-col gap-1">
                <span className="text-[11px] font-bold text-sky-800">医療機関を選択（北名古屋のみ）</span>
                <select
                  value={kitanagoyaMedicalKey}
                  onChange={(e) => {
                    const v = e.target.value;
                    setKitanagoyaMedicalKey(v);
                    setDraft((p) => ({ ...p, ...getAccidentMedicalDraftPatch(deptKey, v) }));
                  }}
                  className="rounded-xl border-2 border-sky-300 bg-white px-3 py-2.5 text-sm font-bold"
                >
                  {ACCIDENT_KITANAGOYA_MEDICAL_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.medicalInstitutionName}
                      {o.medicalInstitutionCode ? `（${o.medicalInstitutionCode}）` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="mt-2 text-sm font-bold text-sky-950">
                この施設は「たなか在宅クリニック」に統一されています（変更不可）。
              </p>
            )}
            <dl className="mt-2 space-y-1 text-[11px] font-bold text-slate-700">
              <div>
                <dt className="inline text-slate-500">名称: </dt>
                <dd className="inline">{draft.medicalInstitutionName || '—'}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">コード: </dt>
                <dd className="inline">{draft.medicalInstitutionCode || '—'}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">住所: </dt>
                <dd className="inline">{draft.medicalInstitutionAddress || '—'}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">電話: </dt>
                <dd className="inline">{draft.medicalInstitutionTel || '—'}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="mb-4 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4">
          <p className="mb-3 text-center text-sm font-black text-amber-950">
            報告者名・日時・場所・どうなったか・どう対応したかを、話すように説明してください
          </p>
          <button
            type="button"
            onClick={() => toggleVoice()}
            className={`flex w-full items-center justify-center gap-3 rounded-2xl py-5 text-lg font-black text-white shadow-lg ${
              voiceListening ? 'bg-rose-600 hover:bg-rose-500' : 'bg-amber-600 hover:bg-amber-500'
            }`}
          >
            {voiceListening ? (
              <>
                <MicOff className="h-8 w-8" />
                話すのを止める
              </>
            ) : (
              <>
                <Mic className="h-8 w-8" />
                話す
              </>
            )}
          </button>
          {voiceListening && (
            <p className="mt-3 text-center text-sm font-bold text-amber-900">聞き取り中… 終わったら「話すのを止める」</p>
          )}
          {voiceInterim ? (
            <p className="mt-2 line-clamp-3 text-center text-xs text-amber-800/90">{voiceInterim}</p>
          ) : null}
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            className="mt-3 flex w-full items-center justify-center gap-1 text-xs font-bold text-amber-900 underline-offset-2 hover:underline"
          >
            {showTranscript ? (
              <>
                <ChevronUp className="h-4 w-4" />
                話した内容を隠す
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                話した内容を表示（確認用）
              </>
            )}
          </button>
          {showTranscript ? (
            <textarea
              value={voiceMemo}
              onChange={(e) => setVoiceMemo(e.target.value)}
              className="mt-2 max-h-32 w-full resize-none rounded-lg border border-amber-200 bg-white/90 px-2 py-2 text-xs text-slate-700"
            />
          ) : null}
          <div className="mt-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.csv,.log,.json,.pdf"
              className="hidden"
              onChange={(e) => importMemoFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs font-bold text-amber-900"
            >
              記録ファイルを取り込む（テキスト/PDF）
            </button>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-black text-slate-800">略図（任意）</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setEraserOn((v) => !v)}
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-bold ${eraserOn ? 'border-amber-500 bg-amber-100 text-amber-900' : 'border-slate-300 bg-white text-slate-700'}`}
              >
                消しゴム
              </button>
              <button
                type="button"
                onClick={initCanvas}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                クリア
              </button>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            width={900}
            height={340}
            className="w-full max-w-full cursor-crosshair touch-none rounded-lg border-2 border-dashed border-slate-400 bg-[#fafafa]"
            onMouseDown={onPointerDown}
            onMouseMove={onPointerMove}
            onMouseUp={endStroke}
            onMouseLeave={endStroke}
            onTouchStart={onPointerDown}
            onTouchMove={onPointerMove}
            onTouchEnd={endStroke}
          />
        </div>

        <div className="mb-4 rounded-xl border-2 border-teal-200 bg-teal-50/90 p-3">
          <p className="mb-1 text-xs font-black text-teal-950">アセスメント（手入力・追記）</p>
          <p className="mb-3 text-[11px] font-bold leading-snug text-teal-900/90">
            初回は空でも構いません。AI作成のあとでも追記できます。印刷・HTML保存・月次保存に反映されます。
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-700">アセスメント（意識・バイタル・傷害部位・皮膚・疼痛 等）</span>
            <textarea
              rows={4}
              value={draft.injuryAssessment}
              onChange={(e) => setDraft((p) => ({ ...p, injuryAssessment: e.target.value }))}
              className="w-full rounded-lg border-2 border-teal-200 bg-white px-2 py-2 text-sm font-bold text-slate-800"
              placeholder="例: 意識清明、血圧 128/76、右肘擦過傷 1cm など"
            />
          </label>
        </div>

        <button
          type="button"
          onClick={() => setShowManualFields((v) => !v)}
          className="mb-3 flex w-full items-center justify-center gap-1 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100"
        >
          {showManualFields ? (
            <>
              <ChevronUp className="h-4 w-4" />
              手入力項目を閉じる
            </>
          ) : (
            <>
              <ChevronDown className="h-4 w-4" />
              手入力項目を開く（AI後の修正にも使えます）
            </>
          )}
        </button>

        {showManualFields ? (
          <div className="mb-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-700">発生場所</span>
              <input
                value={draft.occurPlace}
                onChange={(e) => setDraft((p) => ({ ...p, occurPlace: e.target.value }))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-700">事故の種類・内容</span>
              <textarea
                rows={3}
                value={draft.accidentTypeDetail}
                onChange={(e) => setDraft((p) => ({ ...p, accidentTypeDetail: e.target.value }))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-700">状況</span>
              <textarea
                rows={3}
                value={draft.situation}
                onChange={(e) => setDraft((p) => ({ ...p, situation: e.target.value }))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-700">対応</span>
              <textarea
                rows={3}
                value={draft.response}
                onChange={(e) => setDraft((p) => ({ ...p, response: e.target.value }))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-700">原因</span>
              <textarea
                rows={2}
                value={draft.causes}
                onChange={(e) => setDraft((p) => ({ ...p, causes: e.target.value }))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-700">再発防止策</span>
              <textarea
                rows={2}
                value={draft.improvements}
                onChange={(e) => setDraft((p) => ({ ...p, improvements: e.target.value }))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-bold"
              />
            </label>
          </div>
        ) : null}

        <button
          type="button"
          disabled={busy || !geminiKey?.trim()}
          onClick={() => void runVoiceAi()}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-700 py-4 text-base font-black text-white shadow-lg hover:bg-violet-600 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Wand2 className="h-6 w-6" />}
          AIで報告書を作成
        </button>

        {aiBuilt ? (
          <p className="mb-4 text-center text-sm font-bold text-emerald-800">作成しました。下の「印刷」で書式を確認してください。</p>
        ) : (
          <p className="mb-4 text-center text-xs text-slate-500">表の中身は画面に出しません（印刷・保存で確認）</p>
        )}

        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={saveToMonthlyLog}
            className={`flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-black ${
              saveFlash ? 'bg-emerald-500 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-500'
            }`}
          >
            <Save className="h-5 w-5" />
            {saveFlash ? '保存しました' : editingEntryId ? '保存内容を上書き' : '月次分析用に保存'}
          </button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={printReport}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3.5 text-sm font-black text-white"
          >
            <Printer className="h-5 w-5" />
            印刷で開く
          </button>
          <button
            type="button"
            onClick={downloadReport}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-slate-400 py-3.5 text-sm font-black text-slate-800"
          >
            <Download className="h-5 w-5" />
            HTML保存
          </button>
        </div>

        {!geminiKey?.trim() && (
          <p className="mt-3 text-center text-xs text-amber-700">VITE_GEMINI_API_KEY がないと AI 作成は使えません。</p>
        )}
      </div>
    </div>
  );
}
