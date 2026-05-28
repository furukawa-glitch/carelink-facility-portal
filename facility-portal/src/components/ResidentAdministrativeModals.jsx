import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, FileSpreadsheet, Pill, X } from 'lucide-react';
import * as Report from '../services/ReportService.js';
import { facilityDefBySheetTitle } from '../config/carelinkFacilities.js';
import { addMoveInOutLog } from '../services/moveInOutLogService.js';
import { ResidentInfoProvisionModal } from './ResidentInfoProvisionModal.jsx';

function nameNoSama(nameRaw) {
  return String(nameRaw ?? '')
    .replace(/様\s*$/u, '')
    .trim();
}

function todayYmdLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 利用者メニュー（App の action_selection）から開く事務系モーダル
 * @param {{
 *   overlay: null | 'disability' | 'move_log' | 'med' | 'info_provision';
 *   onClose: () => void;
 *   resident: Record<string, unknown> | null;
 *   portalSheetTitle: string;
 *   residents: Record<string, unknown>[];
 *   geminiKey: string;
 * }} props
 */
export function ResidentAdministrativeModals({ overlay, onClose, resident, portalSheetTitle, residents, geminiKey }) {
  const rid = String(resident?.id ?? '').trim();
  const facilityDef = useMemo(() => {
    const st = String(resident?.sourceSheetTitle ?? portalSheetTitle ?? '').trim();
    return facilityDefBySheetTitle(st) || facilityDefBySheetTitle(String(portalSheetTitle ?? '').trim()) || {};
  }, [resident, portalSheetTitle]);
  const facilityLabel = String(facilityDef.tabLabel ?? '').trim();

  const [disDraft, setDisDraft] = useState({
    residentName: '',
    careManagerName: '',
    diagnosisRequestDate: '',
    municipalApplicationDate: '',
    handbookExpectedDate: '',
    categoryApplicationDate: '',
    categoryAssignee: '',
    hoursFinalizationDate: '',
    hoursAssignee: '',
  });

  const [mvDraft, setMvDraft] = useState({
    kind: /** @type {'hospital'|'move_in'|'move_out'} */ ('hospital'),
    eventDate: '',
    residentName: '',
    gender: '',
    moveOutReason: '',
    note: '',
  });

  useEffect(() => {
    if (overlay !== 'disability' || !rid) return;
    const saved = Report.getResidentDisabilityServiceProgress(rid);
    setDisDraft({
      residentName: String(saved?.residentName ?? nameNoSama(resident?.name ?? '')),
      careManagerName: String(saved?.careManagerName ?? ''),
      diagnosisRequestDate: String(saved?.diagnosisRequestDate ?? ''),
      municipalApplicationDate: String(saved?.municipalApplicationDate ?? ''),
      handbookExpectedDate: String(saved?.handbookExpectedDate ?? ''),
      categoryApplicationDate: String(saved?.categoryApplicationDate ?? ''),
      categoryAssignee: String(saved?.categoryAssignee ?? ''),
      hoursFinalizationDate: String(saved?.hoursFinalizationDate ?? ''),
      hoursAssignee: String(saved?.hoursAssignee ?? ''),
    });
  }, [overlay, rid, resident]);

  useEffect(() => {
    if (overlay !== 'move_log' || !rid) return;
    setMvDraft({
      kind: 'hospital',
      eventDate: todayYmdLocal(),
      residentName: nameNoSama(resident?.name ?? ''),
      gender: '',
      moveOutReason: '',
      note: '',
    });
  }, [overlay, rid, resident]);

  const saveDisability = useCallback(() => {
    if (!rid) return;
    Report.setResidentDisabilityServiceProgress(rid, disDraft);
    onClose();
  }, [rid, disDraft, onClose]);

  const saveMoveLog = useCallback(() => {
    const lk = String(facilityDef.linkKey ?? '').trim();
    const tabLabel = String(facilityDef.tabLabel ?? '').trim();
    if (!lk || !tabLabel) {
      alert('施設情報が見つかりません。施設を選び直してからお試しください。');
      return;
    }
    if (!String(mvDraft.eventDate ?? '').trim()) {
      alert('発生日を入力してください。');
      return;
    }
    if (!String(mvDraft.residentName ?? '').trim()) {
      alert('利用者名を入力してください。');
      return;
    }
    if (mvDraft.kind === 'move_out' && !mvDraft.moveOutReason) {
      alert('退院（退去）では種別を選択してください。');
      return;
    }
    addMoveInOutLog({
      facilityLinkKey: lk,
      tabLabel,
      kind: mvDraft.kind,
      eventDate: mvDraft.eventDate,
      residentName: mvDraft.residentName,
      gender: mvDraft.gender,
      moveOutReason: mvDraft.kind === 'move_out' ? mvDraft.moveOutReason : '',
      note: mvDraft.note,
    });
    alert('入院・入居・退院の記録を保存しました。');
    onClose();
  }, [facilityDef, mvDraft, onClose]);

  if (!overlay || !resident || !rid) return null;

  if (overlay === 'info_provision') {
    return (
      <ResidentInfoProvisionModal
        open
        onClose={onClose}
        geminiKey={geminiKey}
        facilityLabel={facilityLabel || '施設'}
        residents={Array.isArray(residents) ? residents : []}
        residentNameWithoutSama={nameNoSama}
        onApplied={() => onClose()}
        initialResidentId={rid}
        initialActiveTab="view"
      />
    );
  }

  if (overlay === 'med') {
    const prof = Report.getResidentMedicationProfile(rid);
    const meds = prof && Array.isArray(prof.medicines) ? prof.medicines : [];
    const dispensedOn = String(prof?.dispensedOn ?? '').trim();
    const sourceFiles = prof && Array.isArray(prof.sourceFiles) ? prof.sourceFiles : [];
    return (
      <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/60 p-4">
        <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-3xl border-4 border-indigo-500 bg-white p-5 shadow-2xl sm:p-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-lg font-black text-indigo-900 sm:text-xl">
              <span className="inline-flex items-center gap-1">
                <Pill className="h-6 w-6 shrink-0" aria-hidden />
                薬情報
              </span>
              <span className="mt-1 block text-xs font-bold text-slate-600">
                {nameNoSama(resident?.name ?? '') || '利用者'} 様
              </span>
            </h3>
            <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="閉じる">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="mb-3 text-[11px] font-bold leading-snug text-slate-600">
            取り込みは Record 画面上部の「薬局PDF」から行います。ここでは保存済みの内容を確認できます。
          </p>
          <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-900">
            <div>調剤日: {dispensedOn || '—'}</div>
            <div className="mt-1">取り込み元PDF: {sourceFiles.join(' / ') || '—'}</div>
          </div>
          {meds.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm font-bold text-slate-700">
              まだデータがありません。利用者一覧に戻り、画面上部の「薬局PDF」からお薬説明書を取り込んでください。
            </p>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-2">
              <ul className="max-h-[52vh] space-y-1.5 overflow-y-auto">
                {meds.map((m, i) => (
                  <li key={`${i}-${m}`} className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-slate-900">
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (overlay === 'disability') {
    return (
      <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/60 p-4">
        <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl border-4 border-violet-500 bg-white p-5 shadow-2xl sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-lg font-black text-violet-800 sm:text-xl">
              <FileSpreadsheet className="h-6 w-6" aria-hidden />
              障害福祉サービス進捗状況
            </h3>
            <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="閉じる">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">① 名前</span>
              <input
                value={disDraft.residentName}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, residentName: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">ケアマネ名</span>
              <input
                value={disDraft.careManagerName}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, careManagerName: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">② 診断書依頼日</span>
              <input
                type="date"
                value={disDraft.diagnosisRequestDate}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, diagnosisRequestDate: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">③ 役所申請日</span>
              <input
                type="date"
                value={disDraft.municipalApplicationDate}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, municipalApplicationDate: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">④ 手帳完成予定日</span>
              <input
                type="date"
                value={disDraft.handbookExpectedDate}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, handbookExpectedDate: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">⑤ 区分申請日</span>
              <input
                type="date"
                value={disDraft.categoryApplicationDate}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, categoryApplicationDate: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">⑤ 担当</span>
              <input
                value={disDraft.categoryAssignee}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, categoryAssignee: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
                placeholder="担当者名"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">⑥ 時間数確定申請日</span>
              <input
                type="date"
                value={disDraft.hoursFinalizationDate}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, hoursFinalizationDate: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">⑥ 担当</span>
              <input
                value={disDraft.hoursAssignee}
                onChange={(e) => setDisDraft((prev) => ({ ...prev, hoursAssignee: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
                placeholder="担当者名"
              />
            </label>
          </div>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl border-2 border-slate-300 py-2 text-sm font-black text-slate-700 hover:bg-slate-100"
            >
              閉じる
            </button>
            <button
              type="button"
              onClick={saveDisability}
              className="flex-1 rounded-xl border-2 border-violet-600 bg-violet-600 py-2 text-sm font-black text-white hover:bg-violet-500"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (overlay === 'move_log') {
    return (
      <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/60 p-4">
        <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border-4 border-teal-500 bg-white p-5 shadow-2xl sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-lg font-black text-teal-800 sm:text-xl">
              <ClipboardList className="h-6 w-6" aria-hidden />
              入院・入居・退院 記録
            </h3>
            <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-slate-100" aria-label="閉じる">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="mb-3 text-xs font-bold text-slate-600">
            対象施設: {facilityLabel || '—'} / 利用者ID: {rid}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">種別</span>
              <select
                value={mvDraft.kind}
                onChange={(e) =>
                  setMvDraft((prev) => ({
                    ...prev,
                    kind: e.target.value === 'move_out' ? 'move_out' : e.target.value === 'move_in' ? 'move_in' : 'hospital',
                    moveOutReason: e.target.value === 'move_out' ? prev.moveOutReason : '',
                  }))
                }
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold"
              >
                <option value="hospital">入院</option>
                <option value="move_in">入居</option>
                <option value="move_out">退院（退去）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">発生日</span>
              <input
                type="date"
                value={mvDraft.eventDate}
                onChange={(e) => setMvDraft((prev) => ({ ...prev, eventDate: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">利用者名</span>
              <input
                value={mvDraft.residentName}
                onChange={(e) => setMvDraft((prev) => ({ ...prev, residentName: e.target.value }))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-600">性別（任意）</span>
              <select
                value={mvDraft.gender}
                onChange={(e) =>
                  setMvDraft((prev) => ({
                    ...prev,
                    gender: e.target.value === 'male' ? 'male' : e.target.value === 'female' ? 'female' : '',
                  }))
                }
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold"
              >
                <option value="">—</option>
                <option value="male">男性</option>
                <option value="female">女性</option>
              </select>
            </label>
            {mvDraft.kind === 'move_out' ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">退院（退去）種別</span>
                <select
                  value={mvDraft.moveOutReason}
                  onChange={(e) =>
                    setMvDraft((prev) => ({
                      ...prev,
                      moveOutReason:
                        e.target.value === 'after_hospital' || e.target.value === 'death' || e.target.value === 'transfer_facility'
                          ? e.target.value
                          : '',
                    }))
                  }
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold"
                >
                  <option value="">選択してください</option>
                  <option value="after_hospital">入院して退去</option>
                  <option value="death">死亡退去</option>
                  <option value="transfer_facility">他施設へ移動</option>
                </select>
              </label>
            ) : (
              <div />
            )}
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-bold text-slate-600">メモ（任意）</span>
              <textarea
                value={mvDraft.note}
                onChange={(e) => setMvDraft((prev) => ({ ...prev, note: e.target.value }))}
                rows={3}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"
                placeholder="例: 〇〇病院へ入院 / 退院後に自宅療養 など"
              />
            </label>
          </div>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl border-2 border-slate-300 py-2 text-sm font-black text-slate-700 hover:bg-slate-100"
            >
              閉じる
            </button>
            <button
              type="button"
              onClick={saveMoveLog}
              className="flex-1 rounded-xl border-2 border-teal-600 bg-teal-600 py-2 text-sm font-black text-white hover:bg-teal-500"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
