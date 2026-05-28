import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, FileUp, Loader2, Sparkles, Trash2, X } from 'lucide-react';
import * as Report from '../services/ReportService.js';
import {
  PDF_DOC_KIND,
  createResidentDocObjectUrl,
  getResidentDocRecord,
  listResidentDocSummaries,
  putResidentInfoProvisionFromDataUrl,
  putResidentDocFromDataUrl,
} from '../lib/residentInfoProvisionIdb.js';

const MAX_PDF_BYTES = 4 * 1024 * 1024;

/**
 * @param {Record<string, string>} fields
 * @returns {Record<string, string>}
 */
function buildEmergencyPatchFromExtract(fields) {
  /** @type {Record<string, string>} */
  const patch = {};
  for (const k of Report.INFO_PROVISION_EMERGENCY_KEYS) {
    const v = String(fields[k] ?? '').trim();
    if (v) patch[k] = v;
  }
  const extraBlocks = [];
  for (const [title, key] of [
    ['【アレルギー・禁忌】', 'allergiesAndContraindications'],
    ['【病名要約】', 'diseaseNameSummary'],
    ['【服薬要約】', 'medicationSummary'],
  ]) {
    const t = String(fields[key] ?? '').trim();
    if (t) extraBlocks.push(`${title}\n${t}`);
  }
  const optKeys = [
    'heightWeightOptional',
    'adlIadlSummary',
    'tubeTracheostomyOptional',
    'infectionPrecautionsOptional',
    'familyWishesOptional',
  ];
  const optLines = optKeys.map((k) => String(fields[k] ?? '').trim()).filter(Boolean);
  if (optLines.length) extraBlocks.push(optLines.join('\n'));
  if (extraBlocks.length) {
    const add = extraBlocks.join('\n\n');
    const cur = String(patch.other ?? '').trim();
    patch.other = cur ? `${cur}\n\n${add}` : add;
  }
  const staffAtt = String(fields.nurseAndCareAttentionSummary ?? '').trim();
  if (staffAtt) {
    const block = `【看護・介護で注意（情報提供の要約）】\n${staffAtt}`;
    const cur = String(patch.other ?? '').trim();
    patch.other = cur ? `${cur}\n\n${block}` : block;
  }
  return patch;
}

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   geminiKey: string;
 *   facilityLabel: string;
 *   residents: Record<string, unknown>[];
 *   residentNameWithoutSama: (nameRaw: unknown) => string;
 *   onApplied: (payload: {
 *     residentId: string;
 *     emergencyPatch: Record<string, string>;
 *     contact: { name: string; tel: string; relation: string } | null;
 *   }) => void;
 *   initialResidentId?: string | null;
 *   initialActiveTab?: 'import' | 'view' | null;
 * }} props
 */
export function ResidentInfoProvisionModal({
  open,
  onClose,
  geminiKey,
  facilityLabel,
  residents,
  residentNameWithoutSama,
  onApplied,
  initialResidentId = null,
  initialActiveTab = null,
}) {
  const [activeTab, setActiveTab] = useState(/** @type {'import' | 'view'} */ ('import'));
  const [importDocKind, setImportDocKind] = useState(/** @type {'info' | 'nurse'} */ ('info'));
  const [viewDocKind, setViewDocKind] = useState(/** @type {'info' | 'nurse'} */ ('info'));
  const [docInIdb, setDocInIdb] = useState(
    /** @type {{ hasInfo: boolean; hasNurse: boolean; infoFile: null | { sourceFileName: string; updatedAt: string }; nurseFile: null | { sourceFileName: string; updatedAt: string } }} */ ({
      hasInfo: false,
      hasNurse: false,
      infoFile: null,
      nurseFile: null,
    })
  );
  const [pickId, setPickId] = useState('');
  const [viewId, setViewId] = useState('');
  const [fileName, setFileName] = useState('');
  const [pdfBase64, setPdfBase64] = useState('');
  const [busy, setBusy] = useState(false);
  /** @type {[Record<string, string> | null, React.Dispatch<React.SetStateAction<Record<string, string> | null>>]} */
  const [preview, setPreview] = useState(/** @type {Record<string, string> | null} */ (null));
  /** PDF表示用 object URL */
  const [viewPdfObjectUrl, setViewPdfObjectUrl] = useState(/** @type {string | null} */ (null));
  const [viewTick, setViewTick] = useState(0);

  const pickerResidents = useMemo(() => residents ?? [], [residents]);
  const picked = useMemo(
    () => pickerResidents.find((r) => String(r.id) === pickId) ?? null,
    [pickerResidents, pickId]
  );

  useEffect(() => {
    if (!open) return;
    const firstId = String(pickerResidents[0]?.id ?? '');
    const want = String(initialResidentId ?? '').trim();
    const ids = new Set(pickerResidents.map((r) => String(r.id)));
    const chosen = want && ids.has(want) ? want : firstId;
    setActiveTab(initialActiveTab === 'view' ? 'view' : 'import');
    setImportDocKind('info');
    setViewDocKind('info');
    setPickId(chosen);
    setViewId(chosen);
    setFileName('');
    setPdfBase64('');
    setPreview(null);
    setBusy(false);
    setDocInIdb({ hasInfo: false, hasNurse: false, infoFile: null, nurseFile: null });
  }, [open, pickerResidents, initialResidentId, initialActiveTab]);

  useEffect(() => {
    if (!open) {
      setViewPdfObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open || activeTab !== 'view' || !viewId) {
      setViewPdfObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    const idbK = viewDocKind === 'nurse' ? PDF_DOC_KIND.NURSE : PDF_DOC_KIND.INFO;
    let cancelled = false;
    (async () => {
      const url = await createResidentDocObjectUrl(viewId, idbK);
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      setViewPdfObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab, viewId, viewDocKind, viewTick]);

  const viewIdForDocListRef = useRef('');

  useEffect(() => {
    if (!open) {
      viewIdForDocListRef.current = '';
    }
  }, [open]);

  useEffect(() => {
    if (!open || activeTab !== 'view' || !viewId) {
      return;
    }
    const isNewResident = viewIdForDocListRef.current !== viewId;
    viewIdForDocListRef.current = viewId;
    let cancelled = false;
    (async () => {
      const sum = await listResidentDocSummaries(viewId);
      if (cancelled) return;
      const infoR = sum.find((s) => s.docKind === PDF_DOC_KIND.INFO) ?? null;
      const nurR = sum.find((s) => s.docKind === PDF_DOC_KIND.NURSE) ?? null;
      setDocInIdb({
        hasInfo: Boolean(infoR),
        hasNurse: Boolean(nurR),
        infoFile: infoR
          ? { sourceFileName: infoR.sourceFileName, updatedAt: infoR.updatedAt }
          : null,
        nurseFile: nurR
          ? { sourceFileName: nurR.sourceFileName, updatedAt: nurR.updatedAt }
          : null,
      });
      if (isNewResident) {
        const ls = Report.getResidentInfoProvisionExtract(viewId);
        const f = ls?.fields && typeof ls.fields === 'object' ? ls.fields : {};
        const hasInfoAny =
          !!ls &&
          (Object.keys(f).some((k) => String(f[k] ?? '').trim()) || Boolean(ls.hasPdf));
        if (!hasInfoAny && nurR) {
          setViewDocKind('nurse');
        } else {
          setViewDocKind('info');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab, viewId, viewTick]);

  const onPickFile = useCallback((file) => {
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') {
      alert('PDF ファイルを選んでください');
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      alert(`PDF は ${Math.floor(MAX_PDF_BYTES / (1024 * 1024))}MB 以下にしてください（API制限のため）`);
      return;
    }
    setFileName(file.name);
    setPreview(null);
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result ?? '');
      setPdfBase64(s);
    };
    fr.onerror = () => {
      alert('ファイルの読み込みに失敗しました');
      setFileName('');
      setPdfBase64('');
    };
    fr.readAsDataURL(file);
  }, []);

  const runSaveNursePdfOnly = useCallback(async () => {
    if (!pickId) {
      alert('利用者を選んでください');
      return;
    }
    if (!pdfBase64) {
      alert('PDF を選択してください');
      return;
    }
    setBusy(true);
    try {
      await putResidentDocFromDataUrl(
        pickId,
        pdfBase64,
        fileName || 'nurse-record.pdf',
        PDF_DOC_KIND.NURSE
      );
      setViewTick((n) => n + 1);
      alert('看護等の PDF を端末に保存しました。「保存を見る」で確認できます。');
    } catch (e) {
      alert(
        e instanceof Error
          ? e.message
          : '看護文書 PDF の保存に失敗しました。ストレージの空きを確認するか、ブラウザのサイトデータ設定をご確認ください。'
      );
    } finally {
      setBusy(false);
    }
  }, [pickId, pdfBase64, fileName]);

  const runExtract = useCallback(async () => {
    if (!geminiKey?.trim()) {
      alert('VITE_GEMINI_API_KEY を .env に設定してください');
      return;
    }
    if (!pickId) {
      alert('利用者を選んでください');
      return;
    }
    if (!pdfBase64) {
      alert('PDF を選択してください');
      return;
    }
    setBusy(true);
    try {
      const ctx = {
        residentName: picked ? residentNameWithoutSama(picked.name) : '',
        room: picked ? String(picked.room ?? '') : '',
        facilityLabel: String(facilityLabel ?? '').trim(),
      };
      const out = await Report.fetchJohoteikyoFromPdf(geminiKey, pdfBase64, ctx);
      setPreview(out);
      let pdfOk = true;
      try {
        await putResidentInfoProvisionFromDataUrl(pickId, pdfBase64, fileName || 'document.pdf');
      } catch {
        pdfOk = false;
        alert('AIの結果は保存済みですが、PDF ファイルの保存（端末内）に失敗しました。ストレージの空きを確認するか、ブラウザのサイトデータ設定をご確認ください。');
      }
      Report.setResidentInfoProvisionExtract(pickId, {
        sourceFileName: fileName,
        fields: out,
        hasPdf: pdfOk,
      });
      setViewTick((n) => n + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, [geminiKey, pickId, pdfBase64, picked, fileName, facilityLabel, residentNameWithoutSama]);

  const viewRecord = useMemo(
    () => (viewId ? Report.getResidentInfoProvisionExtract(viewId) : null),
    [viewId, viewTick, open, activeTab]
  );

  const viewHasAnyData = useMemo(() => {
    const f = viewRecord?.fields && typeof viewRecord.fields === 'object' ? viewRecord.fields : {};
    const hasInfoLs =
      !!viewRecord &&
      (Object.keys(f).some((k) => String(f[k] ?? '').trim()) || Boolean(viewRecord.hasPdf));
    return hasInfoLs || docInIdb.hasInfo || docInIdb.hasNurse;
  }, [viewRecord, docInIdb.hasInfo, docInIdb.hasNurse]);

  const applyToEmergency = useCallback(() => {
    if (!pickId || !preview) {
      alert('先に AI で読み取ってください');
      return;
    }
    const emergencyPatch = buildEmergencyPatchFromExtract(preview);
    const n = String(preview.emergencyContactName ?? '').trim();
    const contact = n
      ? {
          name: n,
          tel: String(preview.emergencyContactTel ?? '').trim() || '—',
          relation: String(preview.emergencyContactRelation ?? '').trim() || '—',
        }
      : null;
    onApplied({ residentId: pickId, emergencyPatch, contact });
  }, [pickId, preview, onApplied]);

  const onDeleteView = useCallback(async () => {
    if (!viewId) return;
    if (
      !window.confirm(
        'この利用者の保存データ（情報提供の AI 抽出・全 PDF バイナリ）を端末から消します。よろしいですか？'
      )
    ) {
      return;
    }
    await Report.deleteResidentInfoProvisionCompletely(viewId);
    setViewTick((n) => n + 1);
  }, [viewId]);

  const onDownloadViewPdf = useCallback(() => {
    if (!viewPdfObjectUrl || !viewId) return;
    (async () => {
      const idbK = viewDocKind === 'nurse' ? PDF_DOC_KIND.NURSE : PDF_DOC_KIND.INFO;
      const fromIdb = await getResidentDocRecord(viewId, idbK);
      const r = viewRecord;
      const defName =
        viewDocKind === 'nurse' ? 'nurse-record.pdf' : 'info-provision.pdf';
      const raw =
        viewDocKind === 'info'
          ? String(r?.sourceFileName ?? fromIdb?.sourceFileName ?? defName)
          : String(fromIdb?.sourceFileName ?? r?.sourceFileName ?? defName);
      const name = raw.replace(/[\\/:*?"<>|]/g, '_') || defName;
      const a = document.createElement('a');
      a.href = viewPdfObjectUrl;
      a.download = name;
      a.click();
    })();
  }, [viewPdfObjectUrl, viewId, viewRecord, viewDocKind]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[205] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl border-4 border-violet-600 bg-white p-5 shadow-2xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-lg font-black text-violet-900 sm:text-xl">
            <FileUp className="h-6 w-6 shrink-0" />
            利用者別文書（PDF）
          </h3>
          <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="閉じる">
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="mb-4 flex gap-1 rounded-2xl border border-violet-200 bg-violet-100/50 p-1">
          <button
            type="button"
            onClick={() => setActiveTab('import')}
            className={`flex-1 rounded-xl py-2.5 text-sm font-black sm:text-base ${
              activeTab === 'import' ? 'bg-white text-violet-900 shadow' : 'text-violet-800 hover:bg-white/60'
            }`}
          >
            PDF を取り込む
          </button>
          <button
            type="button"
            onClick={() => {
              if (pickId) setViewId(pickId);
              setActiveTab('view');
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-black sm:text-base ${
              activeTab === 'view' ? 'bg-white text-violet-900 shadow' : 'text-violet-800 hover:bg-white/60'
            }`}
          >
            <Eye className="h-4 w-4" />
            保存を見る
          </button>
        </div>

        {activeTab === 'import' ? (
          <>
            <div className="mb-3 flex gap-1 rounded-2xl border border-violet-200 bg-violet-50/80 p-1">
              <button
                type="button"
                onClick={() => {
                  setImportDocKind('info');
                  setPreview(null);
                }}
                className={`flex-1 rounded-xl py-2 text-sm font-black ${
                  importDocKind === 'info' ? 'bg-white text-violet-900 shadow' : 'text-violet-800'
                }`}
              >
                情報提供・退院等
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportDocKind('nurse');
                  setPreview(null);
                }}
                className={`flex-1 rounded-xl py-2 text-sm font-black ${
                  importDocKind === 'nurse' ? 'bg-white text-violet-900 shadow' : 'text-violet-800'
                }`}
              >
                看護・他職の記録
              </button>
            </div>

            {importDocKind === 'info' ? (
              <p className="mb-4 rounded-xl bg-violet-50 px-3 py-2 text-sm font-bold leading-relaxed text-violet-950">
                退院サマリー・情報提供書の <strong>PDF</strong> を選び、AI が読み取り、<strong>この端末に利用者別で保存</strong>
                します。救急サマリー用の反映は任意です。内容の誤りに注意し、医療判断の代替ではありません。
              </p>
            ) : (
              <p className="mb-4 rounded-xl bg-sky-50 px-3 py-2 text-sm font-bold leading-relaxed text-sky-950">
                看護・リハ等の <strong>記録文書（PDF）</strong> を取り込み、<strong>同じ画面の「保存を見る」から閲覧</strong>
                できるように端末内に残します。AI
                読み取りは行いません（要約はありません）。同一利用者の情報提供書の保存と切り分け可能です。
              </p>
            )}

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
                      {residentNameWithoutSama(r.name)} 様 {String(r.room ?? '')}
                    </option>
                  ))}
                </select>
              </label>

              <div className="rounded-xl border-2 border-dashed border-violet-300 bg-violet-50/50 p-4">
                <label
                  htmlFor="carelink-info-provision-pdf"
                  className="flex cursor-pointer flex-col items-center gap-2"
                >
                  <span className="text-sm font-black text-violet-900">PDF を選択（最大約 4MB）</span>
                  <input
                    id="carelink-info-provision-pdf"
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                  />
                  <span className="pointer-events-none rounded-xl bg-violet-600 px-4 py-2 text-sm font-black text-white">
                    ファイルを選ぶ
                  </span>
                  {fileName ? <span className="text-xs font-bold text-slate-700">{fileName}</span> : null}
                </label>
              </div>

              {importDocKind === 'info' ? (
                <button
                  type="button"
                  disabled={busy || !pdfBase64 || !pickId || !geminiKey?.trim()}
                  onClick={() => void runExtract()}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-700 py-4 text-base font-black text-white shadow-lg disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
                  {busy ? '読み取り＆保存中…' : 'AI で読み取って保存'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || !pdfBase64 || !pickId}
                  onClick={() => void runSaveNursePdfOnly()}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-700 py-4 text-base font-black text-white shadow-lg disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileUp className="h-5 w-5" />}
                  {busy ? '保存中…' : '看護等 PDF を端末に保存'}
                </button>
              )}
            </div>

            {importDocKind === 'info' && preview ? (
              <div className="mb-4 space-y-3">
                {String(preview.nurseAndCareAttentionSummary ?? '').trim() ? (
                  <div className="rounded-2xl border-2 border-amber-400/80 bg-gradient-to-br from-amber-50 to-orange-50/90 p-4 shadow-sm">
                    <p className="mb-2 flex items-center gap-2 text-sm font-black text-amber-950">
                      <Sparkles className="h-4 w-4 shrink-0 text-amber-700" />
                      看護・介護で注意（AI 要約）
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm font-bold leading-relaxed text-amber-950">
                      {String(preview.nurseAndCareAttentionSummary).trim()}
                    </p>
                    <p className="mt-2 text-[10px] font-bold leading-tight text-amber-900/80">
                      文書内容の抜要約です。原本・医師の指示を優先し、誤りの可能性に留意してください。
                    </p>
                  </div>
                ) : null}
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="mb-2 text-xs font-black text-slate-700">読み取り結果（全項目・抜粋）</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] font-bold leading-snug text-slate-800">
                    {JSON.stringify(preview, null, 1).slice(0, 4000)}
                    {JSON.stringify(preview, null, 1).length > 4000 ? '\n…' : ''}
                  </pre>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={importDocKind !== 'info' || !preview || !pickId}
                onClick={applyToEmergency}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-rose-600 py-3.5 text-sm font-black text-white disabled:opacity-40"
              >
                救急サマリー欄に反映して開く
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex flex-1 items-center justify-center rounded-2xl border-2 border-slate-300 py-3.5 text-sm font-black text-slate-700"
              >
                閉じる
              </button>
            </div>
            {importDocKind === 'info' && !geminiKey?.trim() ? (
              <p className="mt-3 text-center text-xs font-bold text-amber-700">
                VITE_GEMINI_API_KEY がないと情報提供の AI 読み取りは使えません。看護文書の「PDF のみ保存」は使用できます。
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="mb-3 text-sm font-bold text-slate-600">
              利用者を選び、<strong>情報提供</strong>と<strong>看護等の文書</strong>を切り替えて表示します。元の
              PDF は端末内に保持され、別端末では共有されません。情報提供については AI 抽出の文字データも表示します。
            </p>
            <label className="mb-3 flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">利用者</span>
              <select
                value={viewId}
                onChange={(e) => {
                  setViewId(e.target.value);
                }}
                className="rounded-xl border-2 border-slate-300 px-3 py-3 text-base font-bold"
              >
                {pickerResidents.map((r) => (
                  <option key={String(r.id)} value={String(r.id)}>
                    {residentNameWithoutSama(r.name)} 様 {String(r.room ?? '')}
                  </option>
                ))}
              </select>
            </label>

            {!viewHasAnyData ? (
              <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-bold text-amber-950">
                この利用者の保存データはまだありません。「PDF を取り込む」タブで取り込んでください。
              </p>
            ) : (
              <div className="space-y-3">
                <div className="mb-1 flex flex-wrap gap-1 rounded-2xl border border-slate-200 bg-slate-100/90 p-1">
                  <button
                    type="button"
                    onClick={() => setViewDocKind('info')}
                    className={`min-w-0 flex-1 rounded-xl py-2.5 text-xs font-black sm:text-sm ${
                      viewDocKind === 'info' ? 'bg-white text-slate-900 shadow' : 'text-slate-600'
                    }`}
                  >
                    情報提供・退院
                    {docInIdb.hasInfo || viewRecord ? <span className="ml-1 text-emerald-600">●</span> : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewDocKind('nurse')}
                    className={`min-w-0 flex-1 rounded-xl py-2.5 text-xs font-black sm:text-sm ${
                      viewDocKind === 'nurse' ? 'bg-white text-slate-900 shadow' : 'text-slate-600'
                    }`}
                  >
                    看護・他職
                    {docInIdb.hasNurse ? <span className="ml-1 text-sky-600">●</span> : null}
                  </button>
                </div>

                {viewDocKind === 'info' ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700">
                    <span>
                      ファイル: {String(viewRecord?.sourceFileName ?? docInIdb.infoFile?.sourceFileName ?? '—')}{' '}
                      {viewRecord?.hasPdf || docInIdb.hasInfo ? (
                        <span className="text-emerald-700">（PDF 保存あり）</span>
                      ) : (
                        <span className="text-amber-800">（PDF 未保存・抽出のみ）</span>
                      )}
                    </span>
                    {viewRecord?.extractedAt || docInIdb.infoFile?.updatedAt ? (
                      <span className="text-xs text-slate-500">
                        更新:{' '}
                        {new Date(
                          String(viewRecord?.extractedAt ?? docInIdb.infoFile?.updatedAt ?? '')
                        ).toLocaleString('ja-JP')}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50/80 px-3 py-2 text-sm font-bold text-slate-800">
                    <span>
                      看護等 PDF: {String(docInIdb.nurseFile?.sourceFileName ?? '—')}{' '}
                      {docInIdb.hasNurse ? (
                        <span className="text-sky-800">（保存あり）</span>
                      ) : (
                        <span className="text-amber-800">（未保存）</span>
                      )}
                    </span>
                    {docInIdb.nurseFile?.updatedAt ? (
                      <span className="text-xs text-slate-500">
                        更新: {new Date(String(docInIdb.nurseFile.updatedAt)).toLocaleString('ja-JP')}
                      </span>
                    ) : null}
                  </div>
                )}

                {viewDocKind === 'info' && !docInIdb.hasInfo && !viewRecord ? (
                  <p className="rounded-xl border border-amber-200 bg-amber-50/90 p-3 text-sm font-bold text-amber-950">
                    この種別のテキスト抽出はまだありません。「PDF を取り込む」で情報提供を取り込んでください。
                  </p>
                ) : null}
                {viewDocKind === 'nurse' && !docInIdb.hasNurse ? (
                  <p className="rounded-xl border border-amber-200 bg-amber-50/90 p-3 text-sm font-bold text-amber-950">
                    看護等の PDF はまだ保存されていません。取り込みタブの「看護・他職の記録」から保存できます。
                  </p>
                ) : null}

                {viewDocKind === 'info' && (viewRecord || docInIdb.hasInfo) ? (
                  viewPdfObjectUrl ? (
                    <div className="overflow-hidden rounded-2xl border-2 border-slate-200 bg-slate-100">
                      <div className="max-h-[min(55vh,520px)] min-h-[200px] w-full">
                        <iframe
                          title="情報提供書 PDF"
                          src={viewPdfObjectUrl}
                          className="h-[min(55vh,520px)] w-full border-0"
                        />
                      </div>
                    </div>
                  ) : docInIdb.hasInfo || viewRecord?.hasPdf ? (
                    <p className="text-sm font-bold text-amber-800">
                      PDF の表示用データを開けませんでした。下の「抽出データ」のみ表示します。
                    </p>
                  ) : null
                ) : null}

                {viewDocKind === 'nurse' && docInIdb.hasNurse ? (
                  viewPdfObjectUrl ? (
                    <div className="overflow-hidden rounded-2xl border-2 border-sky-200 bg-slate-100">
                      <div className="max-h-[min(55vh,520px)] min-h-[200px] w-full">
                        <iframe
                          title="看護・他職の文書 PDF"
                          src={viewPdfObjectUrl}
                          className="h-[min(55vh,520px)] w-full border-0"
                        />
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm font-bold text-amber-800">PDF を開けませんでした。再読み込みするか、取り込み直しをお試しください。</p>
                  )
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {viewPdfObjectUrl &&
                  ((viewDocKind === 'info' && (viewRecord || docInIdb.hasInfo)) ||
                    (viewDocKind === 'nurse' && docInIdb.hasNurse)) ? (
                    <button
                      type="button"
                      onClick={onDownloadViewPdf}
                      className="inline-flex items-center gap-2 rounded-xl border-2 border-slate-400 bg-white px-4 py-2.5 text-sm font-black text-slate-800"
                    >
                      <Download className="h-4 w-4" />
                      PDFをダウンロード
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void onDeleteView()}
                    className="inline-flex items-center gap-2 rounded-xl border-2 border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-black text-rose-800"
                  >
                    <Trash2 className="h-4 w-4" />
                    この利用者のデータを削除
                  </button>
                </div>

                {viewDocKind === 'info' && viewRecord ? (
                  <div className="space-y-3">
                    {String(viewRecord?.fields?.nurseAndCareAttentionSummary ?? '').trim() ? (
                      <div className="rounded-2xl border-2 border-amber-400/80 bg-gradient-to-br from-amber-50 to-orange-50/90 p-4 shadow-sm">
                        <p className="mb-2 flex items-center gap-2 text-sm font-black text-amber-950">
                          <Sparkles className="h-4 w-4 shrink-0 text-amber-700" />
                          看護・介護で注意（AI 要約・保存済み）
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm font-bold leading-relaxed text-amber-950">
                          {String(viewRecord.fields.nurseAndCareAttentionSummary).trim()}
                        </p>
                        <p className="mt-2 text-[10px] font-bold leading-tight text-amber-900/80">
                          文書内容の抜要約です。原本・医師の指示を優先し、誤りの可能性に留意してください。
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <p className="mb-2 text-xs font-black text-slate-700">AI 抽出データ（保存済み・全項目）</p>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-white p-3 text-[11px] font-bold leading-relaxed text-slate-800">
                        {JSON.stringify(viewRecord?.fields ?? {}, null, 1).slice(0, 8000)}
                        {JSON.stringify(viewRecord?.fields ?? {}, null, 1).length > 8000 ? '\n…' : ''}
                      </pre>
                    </div>
                  </div>
                ) : null}
                {viewDocKind === 'nurse' && docInIdb.hasNurse ? (
                  <p className="text-xs font-bold text-slate-500">
                    看護等の文書は PDF のみ保存しています。AI による要約・抽出は行っていません。
                  </p>
                ) : null}
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl border-2 border-slate-300 px-6 py-2.5 text-sm font-black text-slate-700"
              >
                閉じる
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
