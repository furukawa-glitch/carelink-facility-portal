import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, Trash2 } from 'lucide-react';
import { getStaffProfile, saveStaffProfile } from '../services/NearMissLedgerService.js';
import { CARELINK_FACILITIES, getShiftDepartmentsForLinkKey } from '../config/carelinkFacilities.js';
import {
  WEEK_JA,
  importShiftPreferencesFromHrSpreadsheet,
  CHIONJI_NIGHT_SHIFT_FULL_JA,
  CHIONJI_NIGHT_SHIFT_SHORT_JA,
  CHIONJI_NURSE_DEPARTMENT,
  CHIONJI_CARE_DEPARTMENT,
  KITANAGOYA_NIGHT_SHIFT_FULL_JA,
  KITANAGOYA_NIGHT_SHIFT_SHORT_JA,
  KITANAGOYA_NURSE_DEPARTMENT,
  KITANAGOYA_CARE_DEPARTMENT,
  KITANAGOYA_PAID_CARE_DEPARTMENT,
  AISAI_DAY_SERVICE_DEPARTMENT,
  AISAI_HOME_CARE_DEPARTMENT,
  AISAI_PAID_CARE_DEPARTMENT,
  AISAI_NURSING_DEPARTMENT,
  NAKAGAWA_KUMASAN_DEPARTMENT,
  isNursingShortNightDepartment,
  buildDraftTable,
  buildMonthlyAutoTable,
  buildMonthlyRosterFromTable,
  buildRosterFormHtml,
  buildScheduleCsv,
  buildScheduleHtml,
  deletePreference,
  findPreferenceByStaffAndFacility,
  formatYmd,
  loadPreferences,
  mon0FromDate,
  normalizeOffHopeYmdList,
  normalizePreference,
  normalizeRequestedShiftByYmd,
  mondayOfWeekContaining,
  newPreferenceId,
  parseYmd,
  summarizeMonthlyWorkStats,
  summarizePreference,
  summarizeYearlyWorkStats,
  upsertPreference,
} from '../services/ShiftScheduleService.js';
import { importShiftRowsFromFile } from '../services/ShiftImportService.js';

const SHEETS_API_KEY = String(import.meta.env.VITE_GOOGLE_SHEETS_API_KEY ?? '').trim();

/** スタッフ入力では施設固有の部署のみ（汎用ラベルは管理者向け一覧用） */
const GENERIC_SHIFT_DEPTS = new Set(['デイ', '訪問介護', '訪問看護', '有料']);
const STAFF_REQUEST_SHIFT_OPTIONS = Object.freeze([
  { value: '休希望', label: '休み' },
  { value: '夜勤入り希望', label: '夜勤入り' },
  { value: '明け希望', label: '明け' },
  { value: '年休希望', label: '有給' },
  { value: '日勤希望', label: '日勤' },
  { value: '早番希望', label: '早番' },
]);

/** @param {string} linkKey */
function getStaffShiftDepartmentsForLinkKey(linkKey) {
  return getShiftDepartmentsForLinkKey(linkKey).filter((d) => !GENERIC_SHIFT_DEPTS.has(d));
}

/** @typedef {'night_count' | 'day_count' | 'off_count' | 'paid_leave_count' | 'part_time' | 'free_text'} WorkMode */

/**
 * @param {{ onBack: () => void; staffMode?: boolean }} props
 * staffMode: スタッフ本人が希望を入力（職員プロフィールと紐づけ）。管理者の勤務表と同じデータに保存されます。
 */
export function ShiftSchedulePage({ onBack, staffMode = false }) {
  const [facilityLinkKey, setFacilityLinkKey] = useState(() => {
    const def = CARELINK_FACILITIES[0]?.linkKey ?? '';
    if (!staffMode) return def;
    const lk = getStaffProfile()?.lastFacilityLinkKey;
    return lk && CARELINK_FACILITIES.some((f) => f.linkKey === lk) ? lk : def;
  });
  const [weekMondayYmd, setWeekMondayYmd] = useState(() => formatYmd(mondayOfWeekContaining(new Date())));
  const [monthYm, setMonthYm] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  const [staffName, setStaffName] = useState('');
  const [ngWeekdayMon0, setNgWeekdayMon0] = useState([]);
  /** @type {[WorkMode, React.Dispatch<React.SetStateAction<WorkMode>>]} */
  const [mode, setMode] = useState(/** @type {WorkMode} */ ('night_count'));
  const [nightCount, setNightCount] = useState(8);
  /** 千音寺看護師・北名古屋看護: ショート夜の月回数（帳票は S または 準） */
  const [shortNightCount, setShortNightCount] = useState(0);
  /** 夜勤・ショート夜勤の自動割当に含める */
  const [canNightShift, setCanNightShift] = useState(true);
  const [dayCount, setDayCount] = useState(10);
  const [offCount, setOffCount] = useState(8);
  const [paidLeaveCount, setPaidLeaveCount] = useState(1);
  const [partTimeStart, setPartTimeStart] = useState('09:00');
  const [partTimeEnd, setPartTimeEnd] = useState('16:00');
  const [partScope, setPartScope] = useState(/** @type {'weekdays' | 'all_except_ng'} */ ('weekdays'));
  const [preferredShiftText, setPreferredShiftText] = useState('');
  const [note, setNote] = useState('');
  const [department, setDepartment] = useState(() => {
    const lk = CARELINK_FACILITIES[0]?.linkKey ?? '';
    const opts = getShiftDepartmentsForLinkKey(lk);
    const list = staffMode ? getStaffShiftDepartmentsForLinkKey(lk) : opts;
    return list[0] ?? '';
  });
  const [editingId, setEditingId] = useState(null);
  /** スタッフ入力: 休み希望の暦日（YYYY-MM-DD）。管理者登録では未使用 */
  const [offHopeYmdList, setOffHopeYmdList] = useState([]);
  const [requestedShiftByYmd, setRequestedShiftByYmd] = useState({});
  const [selectedStaffRequestKind, setSelectedStaffRequestKind] = useState('休希望');
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [hrSeedBusy, setHrSeedBusy] = useState(false);
  const [hrSeedMessage, setHrSeedMessage] = useState('');

  const shiftDeptOptions = useMemo(() => {
    const all = [...getShiftDepartmentsForLinkKey(facilityLinkKey)];
    if (!staffMode) return all;
    return all.filter((d) => !GENERIC_SHIFT_DEPTS.has(d));
  }, [facilityLinkKey, staffMode]);

  useEffect(() => {
    if (!staffMode) return;
    if (shiftDeptOptions.length === 0) {
      if (department !== '') setDepartment('');
      return;
    }
    if (!shiftDeptOptions.includes(department)) {
      setDepartment(shiftDeptOptions[0] ?? '');
    }
  }, [staffMode, facilityLinkKey, shiftDeptOptions, department]);

  const staffMonthDayCells = useMemo(() => {
    const [y, m] = monthYm.split('-').map(Number);
    if (!y || !m) return [];
    const days = new Date(y, m, 0).getDate();
    /** @type {{ ymd: string; mon0: number; weekdayJa: string; d: number }[]} */
    const out = [];
    for (let d = 1; d <= days; d++) {
      const dt = new Date(y, m - 1, d);
      const mon0 = mon0FromDate(dt);
      out.push({
        ymd: formatYmd(dt),
        mon0,
        weekdayJa: WEEK_JA[mon0],
        d,
      });
    }
    return out;
  }, [monthYm]);

  const [prefs, setPrefs] = useState(() => loadPreferences());

  const isKumasanGh =
    facilityLinkKey === '中川本館' && department === NAKAGAWA_KUMASAN_DEPARTMENT;

  /** 中川本館・グループハウスくまさんのシフト登録済み氏名（プルダウン用） */
  const kumasanGhNameOptions = useMemo(() => {
    if (!isKumasanGh) return [];
    const names = new Set();
    for (const p of prefs) {
      if (p.facilityLinkKey !== '中川本館') continue;
      if (String(p.department ?? '').trim() !== NAKAGAWA_KUMASAN_DEPARTMENT) continue;
      const n = String(p.staffName ?? '').trim();
      if (n) names.add(n);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [prefs, isKumasanGh]);

  const refresh = useCallback(() => {
    setPrefs(loadPreferences());
  }, []);

  const facilityLabel = useMemo(() => {
    const f = CARELINK_FACILITIES.find((x) => x.linkKey === facilityLinkKey);
    return f?.tabLabel ?? facilityLinkKey;
  }, [facilityLinkKey]);

  const prefsForFacility = useMemo(() => {
    const list = prefs.filter((p) => p.facilityLinkKey === facilityLinkKey);
    if (!staffMode) return list;
    const sid = getStaffProfile()?.staffId;
    if (!sid) return [];
    return list.filter((p) => String(p.staffId ?? '') === sid);
  }, [prefs, facilityLinkKey, staffMode]);

  const monthlyDraftFull = useMemo(
    () => buildMonthlyAutoTable(monthYm, facilityLinkKey),
    [monthYm, facilityLinkKey, prefs]
  );

  const monthlyDraft = useMemo(() => {
    if (!staffMode) return monthlyDraftFull;
    const sid = getStaffProfile()?.staffId;
    if (!sid) return { ...monthlyDraftFull, rows: [] };
    return {
      ...monthlyDraftFull,
      rows: monthlyDraftFull.rows.filter((r) => r.staffId === sid),
    };
  }, [monthYm, facilityLinkKey, prefs, staffMode, monthlyDraftFull]);

  const rosterTableFull = useMemo(
    () => buildMonthlyRosterFromTable(monthlyDraftFull),
    [monthYm, facilityLinkKey, prefs]
  );

  const rosterTable = useMemo(() => {
    if (!staffMode) return rosterTableFull;
    const sid = getStaffProfile()?.staffId;
    if (!sid) return { ...rosterTableFull, rows: [], footerDayNurse: rosterTableFull.dayLabels.map(() => 0) };
    const fr = rosterTableFull.rows.filter((r) => r.staffId === sid);
    const footerDayNurse = rosterTableFull.dayLabels.map((_, di) =>
      fr.reduce((acc, row) => acc + (row.rosterCells[di] === '日' ? 1 : 0), 0)
    );
    return { ...rosterTableFull, rows: fr, footerDayNurse };
  }, [rosterTableFull, staffMode]);

  const weekDraftFull = useMemo(
    () => buildDraftTable(weekMondayYmd, facilityLinkKey),
    [weekMondayYmd, facilityLinkKey, prefs]
  );

  const weekDraft = useMemo(() => {
    if (!staffMode) return weekDraftFull;
    const sid = getStaffProfile()?.staffId;
    if (!sid) return { ...weekDraftFull, rows: [] };
    return {
      ...weekDraftFull,
      rows: weekDraftFull.rows.filter((r) => r.staffId === sid),
    };
  }, [weekMondayYmd, facilityLinkKey, prefs, staffMode, weekDraftFull]);

  const monthlyWorkStatsFull = useMemo(() => summarizeMonthlyWorkStats(monthlyDraftFull), [monthlyDraftFull]);
  const monthlyWorkStats = useMemo(() => {
    if (!staffMode) return monthlyWorkStatsFull;
    const sid = getStaffProfile()?.staffId;
    if (!sid) return { ...monthlyWorkStatsFull, rows: [] };
    return { ...monthlyWorkStatsFull, rows: monthlyWorkStatsFull.rows.filter((r) => String(r.staffId ?? '') === sid) };
  }, [monthlyWorkStatsFull, staffMode]);

  const summaryYear = useMemo(() => monthYm.slice(0, 4), [monthYm]);
  const yearlyWorkStatsFull = useMemo(
    () => summarizeYearlyWorkStats(summaryYear, facilityLinkKey),
    [summaryYear, facilityLinkKey, prefs]
  );
  const yearlyWorkStats = useMemo(() => {
    if (!staffMode) return yearlyWorkStatsFull;
    const sid = getStaffProfile()?.staffId;
    if (!sid) return { ...yearlyWorkStatsFull, rows: [] };
    return { ...yearlyWorkStatsFull, rows: yearlyWorkStatsFull.rows.filter((r) => String(r.staffId ?? '') === sid) };
  }, [yearlyWorkStatsFull, staffMode]);

  useEffect(() => {
    if (!staffMode) return;
    const prof = getStaffProfile();
    if (!prof?.staffId) return;
    const ex = findPreferenceByStaffAndFacility(prof.staffId, facilityLinkKey);
    if (ex) {
      setEditingId(ex.id);
      setStaffName(ex.staffName);
      setNgWeekdayMon0(Array.isArray(ex.ngWeekdayMon0) ? [...ex.ngWeekdayMon0] : []);
      setMode(ex.mode || 'free_text');
      setNightCount(typeof ex.nightCount === 'number' ? ex.nightCount : 8);
      setShortNightCount(typeof ex.shortNightCount === 'number' ? ex.shortNightCount : 0);
      setCanNightShift(ex.canNightShift !== false);
      setDayCount(typeof ex.dayCount === 'number' ? ex.dayCount : 10);
      setOffCount(typeof ex.offCount === 'number' ? ex.offCount : 8);
      setPaidLeaveCount(typeof ex.paidLeaveCount === 'number' ? ex.paidLeaveCount : 1);
      setPartTimeStart(typeof ex.partTimeStart === 'string' ? ex.partTimeStart : '09:00');
      setPartTimeEnd(typeof ex.partTimeEnd === 'string' ? ex.partTimeEnd : '16:00');
      setPartScope(ex.partScope === 'all_except_ng' ? 'all_except_ng' : 'weekdays');
      setPreferredShiftText(ex.preferredShiftText || '');
      setNote(ex.note || '');
      setOffHopeYmdList(normalizeOffHopeYmdList(ex.offHopeYmdList));
      setRequestedShiftByYmd(normalizeRequestedShiftByYmd(ex.requestedShiftByYmd));
      setDepartment(
        ex.department && getStaffShiftDepartmentsForLinkKey(facilityLinkKey).includes(String(ex.department))
          ? String(ex.department)
          : getStaffShiftDepartmentsForLinkKey(facilityLinkKey)[0] ?? ''
      );
    } else {
      setEditingId(null);
      setStaffName(prof.displayName?.trim() || '');
      setNgWeekdayMon0([]);
      setOffHopeYmdList([]);
      setRequestedShiftByYmd({});
      setMode('night_count');
      setNightCount(8);
      setShortNightCount(0);
      setCanNightShift(true);
      setDayCount(10);
      setOffCount(8);
      setPaidLeaveCount(1);
      setPartTimeStart('09:00');
      setPartTimeEnd('16:00');
      setPartScope('weekdays');
      setPreferredShiftText('');
      setNote('');
      setDepartment(getStaffShiftDepartmentsForLinkKey(facilityLinkKey)[0] ?? '');
    }
  }, [staffMode, facilityLinkKey]);

  const toggleNg = (idx) => {
    setNgWeekdayMon0((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx].sort((a, b) => a - b)
    );
  };

  const toggleOffHopeYmd = (ymd) => {
    setOffHopeYmdList((prev) => {
      const s = new Set(prev);
      if (s.has(ymd)) s.delete(ymd);
      else s.add(ymd);
      return [...s].sort();
    });
  };

  const toggleRequestedShiftYmd = (ymd) => {
    const kind = selectedStaffRequestKind;
    setRequestedShiftByYmd((prev) => {
      const next = { ...prev };
      if (next[ymd] === kind) delete next[ymd];
      else next[ymd] = kind;
      return next;
    });
    if (kind === '休希望') {
      setOffHopeYmdList((prev) => {
        const s = new Set(prev);
        if (s.has(ymd)) s.delete(ymd);
        else s.add(ymd);
        return [...s].sort();
      });
    }
  };

  /** @param {string} [linkKeyForDept] 施設変更直後など、部署の既定に使う linkKey（省略時は現在の facilityLinkKey） */
  const resetForm = (linkKeyForDept) => {
    const lk = linkKeyForDept ?? facilityLinkKey;
    setStaffName('');
    setNgWeekdayMon0([]);
    setMode('night_count');
    setNightCount(8);
    setShortNightCount(0);
    setCanNightShift(true);
    setDayCount(10);
    setOffCount(8);
    setPaidLeaveCount(1);
    setPartTimeStart('09:00');
    setPartTimeEnd('16:00');
    setPartScope('weekdays');
    setPreferredShiftText('');
    setNote('');
    setOffHopeYmdList([]);
    setRequestedShiftByYmd({});
    setDepartment(getShiftDepartmentsForLinkKey(lk)[0] ?? '');
    setEditingId(null);
  };

  const startEdit = useCallback((p) => {
    if (staffMode) {
      setEditingId(p.id);
      setStaffName(p.staffName);
      const opts = getStaffShiftDepartmentsForLinkKey(facilityLinkKey);
      const d = typeof p.department === 'string' ? p.department.trim() : '';
      setDepartment(d && opts.includes(d) ? d : opts[0] ?? '');
      setOffHopeYmdList(normalizeOffHopeYmdList(p.offHopeYmdList));
      setRequestedShiftByYmd(normalizeRequestedShiftByYmd(p.requestedShiftByYmd));
      return;
    }
    setEditingId(p.id);
    setStaffName(p.staffName);
    const opts = getShiftDepartmentsForLinkKey(facilityLinkKey);
    const d = typeof p.department === 'string' ? p.department.trim() : '';
    setDepartment(d && opts.includes(d) ? d : opts[0] ?? '');
    setNgWeekdayMon0(Array.isArray(p.ngWeekdayMon0) ? [...p.ngWeekdayMon0] : []);
    const m = p.mode || 'free_text';
    setMode(m);
    setNightCount(typeof p.nightCount === 'number' ? p.nightCount : 8);
    setShortNightCount(typeof p.shortNightCount === 'number' ? p.shortNightCount : 0);
    setCanNightShift(p.canNightShift !== false);
    setDayCount(typeof p.dayCount === 'number' ? p.dayCount : 10);
    setOffCount(typeof p.offCount === 'number' ? p.offCount : 8);
    setPaidLeaveCount(typeof p.paidLeaveCount === 'number' ? p.paidLeaveCount : 1);
    setPartTimeStart(typeof p.partTimeStart === 'string' ? p.partTimeStart : '09:00');
    setPartTimeEnd(typeof p.partTimeEnd === 'string' ? p.partTimeEnd : '16:00');
    setPartScope(p.partScope === 'all_except_ng' ? 'all_except_ng' : 'weekdays');
    setPreferredShiftText(p.preferredShiftText || '');
    setNote(p.note || '');
    setOffHopeYmdList(normalizeOffHopeYmdList(p.offHopeYmdList));
    setRequestedShiftByYmd(normalizeRequestedShiftByYmd(p.requestedShiftByYmd));
  }, [facilityLinkKey, staffMode]);

  const applySavedStaffPrefToForm = useCallback(() => {
    const prof = getStaffProfile();
    const ex = findPreferenceByStaffAndFacility(prof?.staffId, facilityLinkKey);
    if (ex) startEdit(ex);
  }, [facilityLinkKey, startEdit]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const name = staffName.trim();
    if (!name || !facilityLinkKey) return;

    const prof = getStaffProfile();
    const prevPref = editingId ? prefs.find((x) => x.id === editingId) : null;

    if (staffMode && !prof?.staffId) {
      window.alert('職員プロフィールを読み取れませんでした。ページを再読み込みするか、利用者記録画面で氏名を登録してください。');
      return;
    }

    if (staffMode && prof?.staffId) {
      const deptOpts = getStaffShiftDepartmentsForLinkKey(facilityLinkKey);
      const deptRaw = department.trim();
      if (deptOpts.length === 0) {
        window.alert('この施設にはスタッフ用の部署が登録されていません。管理者に連絡してください。');
        return;
      }
      const departmentSaved = deptOpts.includes(deptRaw) ? deptRaw : deptOpts[0] ?? '';
      const existing = findPreferenceByStaffAndFacility(prof.staffId, facilityLinkKey);
      const prefId = existing?.id ?? newPreferenceId();
      const merged = {
        ...(existing ? normalizePreference(existing) : normalizePreference({})),
        id: prefId,
        facilityLinkKey,
        staffName: name,
        department: departmentSaved,
        staffId: prof.staffId,
        submittedBy: /** @type {'staff'} */ ('staff'),
        updatedAt: new Date().toISOString(),
        offHopeYmdList: normalizeOffHopeYmdList(offHopeYmdList),
        requestedShiftByYmd: normalizeRequestedShiftByYmd(requestedShiftByYmd),
      };
      merged.preferredShiftText = summarizePreference(merged);
      upsertPreference(merged);
      refresh();
      const cur = getStaffProfile();
      if (cur) {
        saveStaffProfile({
          displayName: name || cur.displayName,
          lastFacilityLinkKey: facilityLinkKey,
          nursingOfficeMode: cur.nursingOfficeMode,
        });
      }
      applySavedStaffPrefToForm();
      return;
    }

    const prefId = editingId ?? newPreferenceId();

    const meta = {
      staffId: prevPref?.staffId,
      submittedBy: prevPref?.staffId ? (prevPref.submittedBy ?? 'staff') : 'manager',
    };

    const deptOpts = getShiftDepartmentsForLinkKey(facilityLinkKey);
    const deptRaw = department.trim();
    const departmentSaved = deptOpts.includes(deptRaw) ? deptRaw : deptOpts[0] ?? '';

    const shortNForSave =
      mode === 'night_count' && canNightShift && isNursingShortNightDepartment(departmentSaved)
        ? Math.max(0, Math.min(31, Number(shortNightCount) || 0))
        : 0;

    const base = {
      id: prefId,
      facilityLinkKey,
      staffName: name,
      department: departmentSaved,
      ngWeekdayMon0: [...ngWeekdayMon0],
      note: note.trim(),
      updatedAt: new Date().toISOString(),
      mode,
      canNightShift: mode === 'night_count' ? canNightShift : true,
      shortNightCount: mode === 'night_count' ? shortNForSave : 0,
      offHopeYmdList: normalizeOffHopeYmdList(prevPref?.offHopeYmdList),
      ...meta,
    };

    if (mode === 'night_count') {
      const n = Math.max(0, Math.min(31, Number(nightCount) || 0));
      const row = { ...base, nightCount: n, mode: 'night_count' };
      upsertPreference({
        ...row,
        preferredShiftText: summarizePreference(row),
      });
    } else if (mode === 'day_count') {
      const n = Math.max(0, Math.min(31, Number(dayCount) || 0));
      const row = { ...base, dayCount: n, mode: 'day_count' };
      upsertPreference({
        ...row,
        preferredShiftText: summarizePreference(row),
      });
    } else if (mode === 'off_count') {
      const n = Math.max(0, Math.min(31, Number(offCount) || 0));
      const row = { ...base, offCount: n, mode: 'off_count' };
      upsertPreference({
        ...row,
        preferredShiftText: summarizePreference(row),
      });
    } else if (mode === 'paid_leave_count') {
      const n = Math.max(0, Math.min(31, Number(paidLeaveCount) || 0));
      const row = { ...base, paidLeaveCount: n, mode: 'paid_leave_count' };
      upsertPreference({
        ...row,
        preferredShiftText: summarizePreference(row),
      });
    } else if (mode === 'part_time') {
      const row = { ...base, partTimeStart, partTimeEnd, partScope, mode: 'part_time' };
      upsertPreference({
        ...row,
        preferredShiftText: summarizePreference(row),
      });
    } else {
      const row = { ...base, preferredShiftText: preferredShiftText.trim(), mode: 'free_text' };
      upsertPreference({
        ...row,
        preferredShiftText: summarizePreference(row),
      });
    }
    refresh();
    if (staffMode) {
      const cur = getStaffProfile();
      if (cur) {
        saveStaffProfile({
          displayName: name || cur.displayName,
          lastFacilityLinkKey: facilityLinkKey,
          nursingOfficeMode: cur.nursingOfficeMode,
        });
      }
      applySavedStaffPrefToForm();
    } else {
      resetForm();
    }
  };

  const handleDelete = (id) => {
    if (!window.confirm('この勤務希望を削除しますか？')) return;
    deletePreference(id);
    refresh();
    if (editingId === id) {
      if (staffMode) {
        const prof = getStaffProfile();
        setEditingId(null);
        setStaffName(prof?.displayName?.trim() || '');
        setNgWeekdayMon0([]);
        setOffHopeYmdList([]);
        setRequestedShiftByYmd({});
        setMode('night_count');
        setNightCount(8);
        setShortNightCount(0);
        setCanNightShift(true);
        setDayCount(10);
      setOffCount(8);
      setPaidLeaveCount(1);
      setPartTimeStart('09:00');
      setPartTimeEnd('16:00');
      setPartScope('weekdays');
      setPreferredShiftText('');
      setNote('');
      setDepartment(getStaffShiftDepartmentsForLinkKey(facilityLinkKey)[0] ?? '');
    } else {
        resetForm();
      }
    }
  };

  const handleImportShiftFiles = async (e) => {
    if (staffMode) return;
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    setImporting(true);
    setImportMessage('');
    try {
      const deptOptions = getShiftDepartmentsForLinkKey(facilityLinkKey).filter((d) => d);
      let imported = 0;
      let warnings = [];
      const cachedPrefs = [...prefs];
      for (const f of files) {
        const { rows, warnings: ws } = await importShiftRowsFromFile(f, {
          departments: deptOptions,
          facilityLinkKey,
        });
        warnings = warnings.concat(ws || []);
        for (const r of rows) {
          const name = String(r.staffName ?? '').trim();
          const dep = String(r.department ?? '').trim();
          if (!name || !dep) continue;
          const existing = cachedPrefs.find(
            (p) =>
              p.facilityLinkKey === facilityLinkKey &&
              String(p.staffName ?? '').trim() === name &&
              String(p.department ?? '').trim() === dep
          );
          const base = normalizePreference(existing || {});
          const mode = r.mode || 'free_text';
          const row = {
            ...base,
            id: existing?.id ?? newPreferenceId(),
            facilityLinkKey,
            staffName: name,
            department: dep,
            mode,
            nightCount: mode === 'night_count' ? Math.max(0, Number(r.nightCount || 0)) : 0,
            shortNightCount: mode === 'night_count' ? Math.max(0, Number(r.shortNightCount || 0)) : 0,
            dayCount: mode === 'day_count' ? Math.max(0, Number(r.dayCount || 0)) : 0,
            offCount: mode === 'off_count' ? Math.max(0, Number(r.offCount || 0)) : 0,
            paidLeaveCount: mode === 'paid_leave_count' ? Math.max(0, Number(r.paidLeaveCount || 0)) : 0,
            note: String(r.note || '').trim(),
            submittedBy: 'manager',
            updatedAt: new Date().toISOString(),
          };
          upsertPreference({
            ...row,
            preferredShiftText: summarizePreference(row),
          });
          if (existing) {
            const idx = cachedPrefs.findIndex((p) => p.id === existing.id);
            if (idx >= 0) cachedPrefs[idx] = row;
          } else {
            cachedPrefs.push(row);
          }
          imported += 1;
        }
      }
      refresh();
      const warnText = warnings.length ? `（注意: ${warnings[0]}）` : '';
      setImportMessage(`取込完了: ${imported}件 ${warnText}`);
    } catch (err) {
      setImportMessage(`取込に失敗しました: ${String(err?.message || err)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleImportFromHrSheet = async () => {
    if (staffMode) return;
    if (!SHEETS_API_KEY) {
      setHrSeedMessage('VITE_GOOGLE_SHEETS_API_KEY が .env に必要です。');
      return;
    }
    setHrSeedBusy(true);
    setHrSeedMessage('');
    try {
      const r = await importShiftPreferencesFromHrSpreadsheet(SHEETS_API_KEY, {});
      refresh();
      const warnPreview = r.warnings?.length ? ` — ${r.warnings.slice(0, 2).join(' ')}` : '';
      setHrSeedMessage(
        `「${r.sheetTitle}」から ${r.imported} 名を登録（スキップ ${r.skipped}）。施設タブを切り替えると各施設の行が表示されます。${warnPreview}`
      );
    } catch (e) {
      setHrSeedMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setHrSeedBusy(false);
    }
  };

  const openPrintMonth = () => {
    const html = buildScheduleHtml(monthlyDraft, facilityLabel);
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
  };

  const downloadHtmlMonth = () => {
    const html = buildScheduleHtml(monthlyDraft, facilityLabel);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `勤務表_月次_${facilityLabel}_${monthYm}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadCsvMonth = () => {
    const csv = buildScheduleCsv(monthlyDraft);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `勤務表_月次_${facilityLabel}_${monthYm}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openPrintRoster = () => {
    const html = buildRosterFormHtml(rosterTable, facilityLabel);
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
  };

  const downloadRosterHtml = () => {
    const html = buildRosterFormHtml(rosterTable, facilityLabel);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `勤務表_帳票風_${facilityLabel}_${monthYm}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openPrintWeek = () => {
    const html = buildScheduleHtml(weekDraft, facilityLabel);
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
  };

  const downloadHtmlWeek = () => {
    const html = buildScheduleHtml(weekDraft, facilityLabel);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `勤務表_週_${facilityLabel}_${weekMondayYmd}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadCsvWeek = () => {
    const csv = buildScheduleCsv(weekDraft);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `勤務表_週_${facilityLabel}_${weekMondayYmd}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const monthColCount = 3 + monthlyDraft.dayLabels.length + 2;
  const weekColCount = 3 + weekDraft.dayLabels.length + 2;
  const formatHours = (hours) => {
    const totalMin = Math.round(Number(hours || 0) * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}時間${String(m).padStart(2, '0')}分`;
  };

  return (
    <div className="min-h-[100dvh] w-full bg-slate-50 font-sans font-bold">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <ChevronLeft size={18} />
            ポータルに戻る
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <CalendarDays className="h-8 w-8 shrink-0 text-teal-600" />
            <div className="min-w-0">
              <h1 className="text-lg text-slate-800 sm:text-xl">
                {staffMode ? '休み希望の入力（現場スタッフ）' : '勤務表・勤務体制（管理者）'}
              </h1>
              <p className="text-xs font-bold text-slate-500">
                {staffMode
                  ? '休み希望に加えて、夜勤入り・明け・有給・日勤・早番も日ごとに選んで登録できます。管理者が入力した月回数などは消さず、選んだ日だけ希望として月次・帳票に反映されます。'
                  : '各スタッフの勤務体制を登録し、月次・帳票を作成します。現場スタッフの希望は「勤務希望を入力」から登録された内容が反映されます。'}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 pb-24">
        <section className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-black text-slate-600">対象施設</h2>
          <select
            value={facilityLinkKey}
            onChange={(e) => {
              const v = e.target.value;
              setFacilityLinkKey(v);
              if (!staffMode) resetForm(v);
              else {
                const opts = getStaffShiftDepartmentsForLinkKey(v);
                setDepartment(opts[0] ?? '');
              }
            }}
            className="w-full rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-bold text-slate-800 outline-none focus:border-teal-400"
          >
            {CARELINK_FACILITIES.map((f) => (
              <option key={f.linkKey} value={f.linkKey}>
                {f.tabLabel}
              </option>
            ))}
          </select>
          <div className="mt-4">
            <label className="mb-1 block text-xs text-slate-500">部署（職種）</label>
            <select
              value={shiftDeptOptions.includes(department) ? department : shiftDeptOptions[0] ?? ''}
              onChange={(e) => setDepartment(e.target.value)}
              disabled={staffMode && shiftDeptOptions.length === 0}
              className="w-full rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-bold text-slate-800 outline-none focus:border-teal-400 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              {shiftDeptOptions.length === 0 && staffMode ? (
                <option value="">（スタッフ用部署なし）</option>
              ) : (
                shiftDeptOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))
              )}
            </select>
            {staffMode && shiftDeptOptions.length === 0 ? (
              <p className="mt-2 text-xs font-bold text-amber-800">
                この施設のスタッフ用部署（施設名付きの職種）がまだありません。管理者に連絡してください。
              </p>
            ) : null}
            {!staffMode ? (
              <>
                {facilityLinkKey === '千音寺' && department === CHIONJI_CARE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/90 px-3 py-2 text-xs font-bold text-emerald-950">
                <p className="mb-1 font-black">千音寺介護（訪問介護ケアサポートのExcelに近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>
                    <strong>★</strong>付きの<strong>早・日・日A～D・夜A/B</strong>、<strong>明</strong>、<strong>×</strong>、<strong>有</strong>、公休・夜・日・遅・早の集計列、下段の<strong>日勤（9～18時）人数・昼食数・夜勤（16～10時）人数・夕食数</strong>、食事なしリストの凡例などは、<strong>自由記入</strong>と<strong>備考</strong>でシートに合わせて書けます。
                  </li>
                  <li>
                    夜勤モードの<strong>自動割当</strong>は簡易の<strong>夜→翌明</strong>のみです（Excel の A/B 区分は備考で）。ショート夜<strong>S</strong>は<strong>千音寺看護師</strong>の部署のみです。
                  </li>
                  <li className="text-emerald-900/90">夜勤ブロックの目安: {CHIONJI_NIGHT_SHIFT_FULL_JA}</li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '千音寺' && department === CHIONJI_NURSE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50/90 px-3 py-2 text-xs font-bold text-violet-950">
                <p className="mb-1 font-black">千音寺看護師の勤務時間（自動割当・帳票の目安）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>{CHIONJI_NIGHT_SHIFT_FULL_JA}</li>
                  <li>{CHIONJI_NIGHT_SHIFT_SHORT_JA}（勤務表の記号は S）</li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '北名古屋' && department === KITANAGOYA_CARE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-cyan-200 bg-cyan-50/90 px-3 py-2 text-xs font-bold text-cyan-950">
                <p className="mb-1 font-black">北名古屋介護（訪問介護ケアサポートのExcelに近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>
                    <strong>日</strong>・<strong>早</strong>、<strong>★日A/B</strong>、<strong>夜A/B</strong>・<strong>明A/B</strong>、<strong>BA～BG</strong>、<strong>×</strong>・<strong>有</strong>、パートの時間帯（15-19 など）、右端の<strong>週休・夜・日・遅・早</strong>、下段の<strong>日勤人数・昼食数・夜勤（16～10）・夕食数</strong>、★食事なしの凡例や<strong>千音寺へルプ</strong>は、<strong>自由記入</strong>と<strong>備考</strong>で再現できます。
                  </li>
                  <li>
                    夜勤モードの<strong>夜→翌明</strong>は簡易の帳票表示です（シートの夜A/B と異なる場合は備考で）。ショート夜<strong>準</strong>の入力は<strong>北名古屋看護</strong>の部署のみです。
                  </li>
                  <li className="text-cyan-900/90">通常夜の目安: {KITANAGOYA_NIGHT_SHIFT_FULL_JA}</li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '北名古屋' && department === KITANAGOYA_NURSE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/90 px-3 py-2 text-xs font-bold text-sky-950">
                <p className="mb-1 font-black">北名古屋看護の勤務時間（訪問看護ケアサポートのExcelに合わせる目安）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>{KITANAGOYA_NIGHT_SHIFT_FULL_JA}</li>
                  <li>{KITANAGOYA_NIGHT_SHIFT_SHORT_JA}</li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '北名古屋' && department === KITANAGOYA_PAID_CARE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/90 px-3 py-2 text-xs font-bold text-rose-950">
                <p className="mb-1 font-black">北名古屋有料（有料ホームのExcel勤務表に近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>
                    セルは<strong>日</strong>・<strong>早</strong>・<strong>×</strong>・<strong>有</strong>に加え、<strong>6-15</strong>・<strong>9-18</strong>・<strong>9.5-14</strong>・<strong>14-18</strong> など<strong>時間帯の直接記入</strong>。上段の<strong>行事・予定</strong>、右の<strong>出勤・休み・有給・食事</strong>集計、下段の<strong>早番（6～9）・昼番（10～14）・遅番（15～18）</strong>の担当表・<strong>有料食事数</strong>行は、<strong>自由記入</strong>と<strong>備考</strong>で再現できます。
                  </li>
                  <li>職種（施設長・事務・厨房など）は<strong>備考</strong>に書くと分かりやすいです。</li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '愛西' && department === AISAI_DAY_SERVICE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/90 px-3 py-2 text-xs font-bold text-amber-950">
                <p className="mb-1 font-black">愛西デイサービス（キリンデイサービス等のExcelに近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>セルに「8・7・5」などの<strong>稼働時間</strong>、「×」休、「有」有給を書く形式は、<strong>自由記入</strong>の勤務形態や<strong>備考</strong>で再現できます。</li>
                  <li>夜勤の<strong>自動割当</strong>（夜・明・準）は、看護向けの部署（北名古屋看護・千音寺看護師・愛西看護）で利用してください。</li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '愛西' && department === AISAI_HOME_CARE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-teal-200 bg-teal-50/90 px-3 py-2 text-xs font-bold text-teal-950">
                <p className="mb-1 font-black">愛西訪問介護（Excelの訪問介護勤務表に近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>
                    上段の<strong>日勤・夜勤人数</strong>、セルの<strong>A～D（夜勤枠）</strong>、<strong>早</strong>、<strong>E</strong>、<strong>明</strong>、<strong>×</strong>、<strong>有</strong>、<strong>有料①②</strong>などは、本アプリの<strong>自由記入</strong>と<strong>備考</strong>でExcelに合わせて書き写せます。
                  </li>
                  <li>
                    雇用区分（<strong>正</strong>／<strong>P</strong>／<strong>パ</strong>）は、Excel の左列に相当するメモを<strong>備考</strong>に書くと分かりやすいです（氏名欄は氏名のみ推奨）。
                  </li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '愛西' && department === AISAI_PAID_CARE_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/90 px-3 py-2 text-xs font-bold text-rose-950">
                <p className="mb-1 font-black">愛西有料（Excelの有料勤務表に近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>
                    セルの<strong>8・6・5・4</strong>（時間数）、<strong>夜</strong>、<strong>×</strong>（休）、<strong>有</strong>（有給）、日程行のイベント名などは、<strong>自由記入</strong>と<strong>備考</strong>で再現できます。
                  </li>
                  <li>
                    氏名に「9-16」「10-16」のように<strong>勤務時間帯</strong>を付けたい場合は、氏名欄にそのまま入れても、<strong>備考</strong>に分けて書いても構いません。
                  </li>
                </ul>
              </div>
            ) : null}
            {facilityLinkKey === '愛西' && department === AISAI_NURSING_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50/90 px-3 py-2 text-xs font-bold text-violet-950">
                <p className="mb-1 font-black">愛西看護（訪問看護ケアサポートのExcelに近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>
                    セルは<strong>日</strong>（日勤）、<strong>夜</strong>・翌日<strong>明</strong>（夜勤明け）、<strong>×</strong>（公休）、<strong>有</strong>（有給）など。帳票の<strong>看護日勤</strong>行（「日」の人数）や<strong>週休</strong>列（×・有の件数・公休10日の目安など）は、<strong>自由記入</strong>と<strong>備考</strong>で補ってください。
                  </li>
                  <li>
                    夜勤の<strong>自動割当</strong>（夜・明・準）は北名古屋看護と同じ時間帯です（下記）。職種・リーダー番号は<strong>備考</strong>に書くと分かりやすいです。
                  </li>
                  <li>{KITANAGOYA_NIGHT_SHIFT_FULL_JA}</li>
                  <li>{KITANAGOYA_NIGHT_SHIFT_SHORT_JA}</li>
                </ul>
              </div>
            ) : null}
                {facilityLinkKey === '中川本館' && department === NAKAGAWA_KUMASAN_DEPARTMENT ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/90 px-3 py-2 text-xs font-bold text-amber-950">
                <p className="mb-1 font-black">グループハウスくまさん（中川シフト・Googleシートに近い運用）</p>
                <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                  <li>
                    シフトパターンの<strong>×</strong>、<strong>有休</strong>（有8 など）、<strong>看日</strong>、<strong>8</strong>・<strong>早</strong>、<strong>夜A</strong>・<strong>夜B</strong>・<strong>明</strong>、<strong>7.5</strong>・<strong>7①②</strong>・<strong>6.5</strong>・<strong>6①②</strong>・<strong>5.5①②</strong>・<strong>5①②</strong>・<strong>4A</strong>/<strong>4P</strong> などは、<strong>自由記入</strong>と<strong>備考</strong>で再現できます。
                  </li>
                  <li>
                    右端の<strong>公休・夜・日・有休・休日出勤</strong>の集計、<strong>千音寺</strong>など他拠点出勤のメモ、<strong>ヘルプ</strong>行は同様に備考で補ってください。
                  </li>
                  <li>
                    夜勤モードの<strong>自動「夜→翌明」</strong>は帳票上の簡易表示です（シートの夜A 16～0／明 0～10 などと異なる場合は備考で）。
                  </li>
                </ul>
              </div>
            ) : null}
              </>
            ) : (
              <p className="mt-3 text-xs font-bold text-slate-500">
                下のフォームで、<strong>休み・夜勤入り・明け・有給・日勤・早番</strong>の希望を日ごとに選んで登録してください。
              </p>
            )}
          </div>
        </section>

        <section className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-black text-slate-600">
            {staffMode ? '休み希望の日' : 'スタッフの勤務体制を登録'}
            {editingId ? <span className="text-teal-700">（編集中）</span> : null}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            {staffMode ? (
              <div className="space-y-5">
                <div>
                  <label className="mb-1 block text-xs text-slate-500">
                    {isKumasanGh ? 'お名前（シフト名簿から選択）' : 'お名前'}
                  </label>
                  {isKumasanGh ? (
                    kumasanGhNameOptions.length === 0 ? (
                      <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-normal text-amber-900">
                        グループハウスくまさんのシフトに登録された名前がありません。管理者に名簿登録を依頼してください。
                      </p>
                    ) : (
                      <>
                        <select
                          value={kumasanGhNameOptions.includes(staffName.trim()) ? staffName : ''}
                          onChange={(e) => setStaffName(e.target.value)}
                          required
                          className="w-full rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-bold text-slate-800 outline-none focus:border-teal-400"
                        >
                          <option value="">選択してください</option>
                          {kumasanGhNameOptions.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-[11px] font-normal text-slate-500">
                          プルダウンは、中川本館・グループハウスくまさんとして登録済みの氏名です。
                        </p>
                      </>
                    )
                  ) : (
                    <>
                      <input
                        type="text"
                        value={staffName}
                        onChange={(e) => setStaffName(e.target.value)}
                        readOnly={Boolean(getStaffProfile()?.displayName?.trim())}
                        className="w-full rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400 read-only:bg-slate-50"
                      />
                      <p className="mt-1 text-[11px] font-normal text-slate-500">
                        利用者記録で登録した氏名がある場合は変更できません。
                      </p>
                    </>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-500">希望の対象月</label>
                  <input
                    type="month"
                    value={monthYm}
                    onChange={(e) => setMonthYm(e.target.value)}
                    className="max-w-xs rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                  />
                </div>
                <div>
                  <p className="mb-2 text-xs text-slate-500">入れたい希望を選んでから日付をタップしてください</p>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {STAFF_REQUEST_SHIFT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setSelectedStaffRequestKind(opt.value)}
                        className={`rounded-xl px-3 py-2 text-sm ${
                          selectedStaffRequestKind === opt.value
                            ? 'bg-teal-600 text-white'
                            : 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {staffMonthDayCells.map(({ ymd, weekdayJa, d, mon0 }) => (
                      <button
                        key={ymd}
                        type="button"
                        onClick={() => toggleRequestedShiftYmd(ymd)}
                        className={`min-w-[3.5rem] rounded-xl px-2 py-2 text-center transition ${
                          requestedShiftByYmd[ymd]
                            ? 'bg-rose-200 text-rose-900 ring-2 ring-rose-400'
                            : mon0 >= 5
                              ? 'bg-slate-100 text-slate-600'
                              : 'bg-white text-slate-700 ring-1 ring-slate-200'
                        }`}
                      >
                        <span className="block text-base font-black leading-none">{d}</span>
                        <span className="text-[10px] font-normal">{weekdayJa}</span>
                        {requestedShiftByYmd[ymd] ? (
                          <span className="mt-1 block text-[10px] font-bold leading-tight">
                            {STAFF_REQUEST_SHIFT_OPTIONS.find((opt) => opt.value === requestedShiftByYmd[ymd])?.label ?? '希望'}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] font-normal text-slate-500">
                    選んだ日は、下の月次表と帳票で希望として表示されます。もう一度タップすると解除できます。別の月は「希望の対象月」を変えてから登録できます。
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={shiftDeptOptions.length === 0}
                  title={shiftDeptOptions.length === 0 ? '部署を選べないため登録できません' : undefined}
                  className="rounded-2xl bg-teal-600 px-6 py-3 text-white shadow-md hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  登録する
                </button>
              </div>
            ) : (
              <>
            <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
              <p className="mb-2 text-xs font-bold text-sky-900">
                勤務表（Excel/CSV）から全部署を一括登録
              </p>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                multiple
                onChange={handleImportShiftFiles}
                disabled={importing}
                className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-sky-600 file:px-3 file:py-2 file:text-white hover:file:bg-sky-700 disabled:opacity-60"
              />
              <p className="mt-2 text-[11px] font-normal text-slate-600">
                シート名に部署名（例: 愛西デイサービス、北名古屋介護）を含めると自動判定します。
              </p>
              {importMessage ? <p className="mt-2 text-xs font-bold text-slate-700">{importMessage}</p> : null}
              <div className="mt-3 rounded-xl border border-sky-200/80 bg-white/80 p-3">
                <p className="mb-2 text-xs font-bold text-sky-900">求人スプレッドシート（VITE_HR_SPREADSHEET_ID）から氏名・部署を取り込み</p>
                <p className="mb-2 text-[11px] leading-relaxed text-slate-600">
                  周知名簿用の求人シートと同じブックを読みます。施設列・タグ列で施設に振り分けたうえで、
                  <strong>タグに勤務表と同じ部署名</strong>（例: 千音寺介護、#愛西デイサービス）を含めてください。
                  その施設の部署候補が1つだけのときは、タグに部署名がなくても取り込めます。
                </p>
                <button
                  type="button"
                  disabled={hrSeedBusy || !SHEETS_API_KEY}
                  onClick={() => void handleImportFromHrSheet()}
                  className="rounded-xl bg-sky-700 px-4 py-2 text-sm font-black text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {hrSeedBusy ? '取り込み中…' : '求人シートから勤務希望へ反映'}
                </button>
                {!SHEETS_API_KEY ? (
                  <p className="mt-2 text-[10px] font-bold text-amber-800">VITE_GOOGLE_SHEETS_API_KEY 未設定のため利用できません。</p>
                ) : null}
                {hrSeedMessage ? (
                  <p className="mt-2 text-[11px] font-bold text-slate-800 whitespace-pre-wrap">{hrSeedMessage}</p>
                ) : null}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">
                スタッフ名
                {isKumasanGh ? (
                  <span className="ml-1 font-normal text-slate-400">
                    （グループハウスくまさんの登録済み氏名から選択、または新規入力）
                  </span>
                ) : null}
              </label>
              {isKumasanGh ? (
                kumasanGhNameOptions.length === 0 ? (
                  <>
                    <input
                      type="text"
                      value={staffName}
                      onChange={(e) => setStaffName(e.target.value)}
                      placeholder="例: 山田 太郎（初回登録後、プルダウンに追加されます）"
                      className="w-full rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                      autoComplete="name"
                    />
                    <p className="mt-1 text-[11px] font-normal text-slate-500">
                      まだ名簿がありません。1人目の氏名を入力して登録すると、次回からプルダウンで選べます。
                    </p>
                  </>
                ) : (
                  <>
                    <select
                      value={
                        kumasanGhNameOptions.includes(staffName.trim())
                          ? staffName
                          : staffName.trim()
                            ? '__new__'
                            : ''
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '__new__') setStaffName('');
                        else setStaffName(v);
                      }}
                      className="w-full rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-base font-bold text-slate-800 outline-none focus:border-teal-400"
                    >
                      <option value="">選択してください</option>
                      {kumasanGhNameOptions.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                      <option value="__new__">（新規・名前を入力）</option>
                    </select>
                    {(!kumasanGhNameOptions.includes(staffName.trim()) || staffName === '') && (
                      <input
                        type="text"
                        value={staffName}
                        onChange={(e) => setStaffName(e.target.value)}
                        placeholder="新しい氏名を入力"
                        className="mt-2 w-full rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                        autoComplete="name"
                      />
                    )}
                    <p className="mt-1 text-[11px] font-normal text-slate-500">
                      プルダウンは、中川本館・グループハウスくまさんとして既に登録されている氏名です。
                    </p>
                  </>
                )
              ) : (
                <input
                  type="text"
                  value={staffName}
                  onChange={(e) => setStaffName(e.target.value)}
                  placeholder="例: Aさん"
                  className="w-full rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                  autoComplete="name"
                />
              )}
            </div>

            <div>
              <p className="mb-2 text-xs text-slate-500">勤務形態（どれか1つ）</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {[
                  { id: 'night_count', label: '夜勤（月の回数）' },
                  { id: 'day_count', label: '日勤（月の回数）' },
                  { id: 'off_count', label: '休みのみ（月の日数）' },
                  { id: 'paid_leave_count', label: '年休（月の日数）' },
                  { id: 'part_time', label: 'パート（時間帯）' },
                  { id: 'free_text', label: '自由記入のみ' },
                ].map((opt) => (
                  <label
                    key={opt.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-xl border-2 px-3 py-2 text-sm ${
                      mode === opt.id ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="workMode"
                      checked={mode === opt.id}
                      onChange={() => setMode(/** @type {WorkMode} */ (opt.id))}
                      className="h-4 w-4"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            {mode === 'night_count' ? (
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-white bg-white px-3 py-3 shadow-sm">
                  <input
                    type="checkbox"
                    checked={canNightShift}
                    onChange={(e) => setCanNightShift(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-teal-600"
                  />
                  <span className="text-sm font-bold text-slate-800">
                    夜勤・ショート夜勤（S）の<strong>自動割当</strong>に含める
                    <span className="mt-0.5 block text-xs font-normal text-slate-500">
                      外すとこの職員には夜・Sを入れません（日勤のみの登録など）。
                    </span>
                  </span>
                </label>
                <div>
                  <label className="mb-1 block text-xs text-slate-500">
                    通常夜勤（1ヶ月あたりの回数）
                    {facilityLinkKey === '千音寺' ? (
                      <span className="mt-0.5 block font-normal text-slate-500">{CHIONJI_NIGHT_SHIFT_FULL_JA}</span>
                    ) : null}
                    {facilityLinkKey === '北名古屋' ? (
                      <span className="mt-0.5 block font-normal text-slate-500">{KITANAGOYA_NIGHT_SHIFT_FULL_JA}</span>
                    ) : null}
                    {facilityLinkKey === '愛西' && department === AISAI_NURSING_DEPARTMENT ? (
                      <span className="mt-0.5 block font-normal text-slate-500">{KITANAGOYA_NIGHT_SHIFT_FULL_JA}</span>
                    ) : null}
                    {facilityLinkKey === '中川本館' && department === NAKAGAWA_KUMASAN_DEPARTMENT ? (
                      <span className="mt-0.5 block font-normal text-slate-500">
                        中川シフトの夜A/B・明はシートの時間帯（例: 夜A 16～0、明 0～10）。帳票の簡易「夜」ブロックの目安:{' '}
                        {CHIONJI_NIGHT_SHIFT_FULL_JA}
                      </span>
                    ) : null}
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={31}
                    disabled={!canNightShift}
                    value={nightCount}
                    onChange={(e) => setNightCount(Number(e.target.value))}
                    className="w-full max-w-xs rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400 disabled:opacity-50"
                  />
                </div>
                {isNursingShortNightDepartment(department) ? (
                  <div>
                    <label className="mb-1 block text-xs text-slate-500">
                      {department === CHIONJI_NURSE_DEPARTMENT
                        ? 'ショート夜勤 S（1ヶ月あたりの回数）'
                        : 'ショート夜勤 準（1ヶ月あたりの回数）'}
                      <span className="mt-0.5 block font-normal text-slate-500">
                        {department === CHIONJI_NURSE_DEPARTMENT
                          ? CHIONJI_NIGHT_SHIFT_SHORT_JA
                          : KITANAGOYA_NIGHT_SHIFT_SHORT_JA}
                      </span>
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={31}
                      disabled={!canNightShift}
                      value={shortNightCount}
                      onChange={(e) => setShortNightCount(Number(e.target.value))}
                      className="w-full max-w-xs rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400 disabled:opacity-50"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {mode === 'day_count' ? (
              <div>
                <label className="mb-1 block text-xs text-slate-500">日勤（1ヶ月あたりの回数）</label>
                <input
                  type="number"
                  min={0}
                  max={31}
                  value={dayCount}
                  onChange={(e) => setDayCount(Number(e.target.value))}
                  className="w-full max-w-xs rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                />
              </div>
            ) : null}

            {mode === 'off_count' ? (
              <div>
                <label className="mb-1 block text-xs text-slate-500">休み（1ヶ月あたりの日数）</label>
                <p className="mb-2 text-[11px] font-normal text-slate-500">
                  下の「勤務不可の曜日」以外の日から、休みにしたい日数を均等に割り当てます。
                </p>
                <input
                  type="number"
                  min={0}
                  max={31}
                  value={offCount}
                  onChange={(e) => setOffCount(Number(e.target.value))}
                  className="w-full max-w-xs rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                />
              </div>
            ) : null}

            {mode === 'paid_leave_count' ? (
              <div>
                <label className="mb-1 block text-xs text-slate-500">年休（1ヶ月あたりの日数）</label>
                <p className="mb-2 text-[11px] font-normal text-slate-500">
                  下の「勤務不可の曜日」以外の日から、年休にしたい日数を均等に割り当てます。
                </p>
                <input
                  type="number"
                  min={0}
                  max={31}
                  value={paidLeaveCount}
                  onChange={(e) => setPaidLeaveCount(Number(e.target.value))}
                  className="w-full max-w-xs rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                />
              </div>
            ) : null}

            {mode === 'part_time' ? (
              <div className="space-y-3 rounded-2xl border border-slate-100 bg-slate-50/80 p-4">
                <p className="text-xs text-slate-600">勤務時間（例: 9時～16時）</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="time"
                    value={partTimeStart}
                    onChange={(e) => setPartTimeStart(e.target.value)}
                    className="rounded-xl border-2 border-slate-200 px-3 py-2 font-bold"
                  />
                  <span className="text-slate-400">～</span>
                  <input
                    type="time"
                    value={partTimeEnd}
                    onChange={(e) => setPartTimeEnd(e.target.value)}
                    className="rounded-xl border-2 border-slate-200 px-3 py-2 font-bold"
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      checked={partScope === 'weekdays'}
                      onChange={() => setPartScope('weekdays')}
                    />
                    平日のみ（月～金）
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      checked={partScope === 'all_except_ng'}
                      onChange={() => setPartScope('all_except_ng')}
                    />
                    土日も可（NGの曜日・日だけ除く）
                  </label>
                </div>
              </div>
            ) : null}

            {mode === 'free_text' ? (
              <div>
                <label className="mb-1 block text-xs text-slate-500">希望の書き方（自動割当なし・要約用）</label>
                <input
                  type="text"
                  value={preferredShiftText}
                  onChange={(e) => setPreferredShiftText(e.target.value)}
                  placeholder="例: 遅番中心、週3日まで など"
                  className="w-full rounded-2xl border-2 border-slate-200 px-4 py-3 font-bold outline-none focus:border-teal-400"
                />
              </div>
            ) : null}

            <div>
              <p className="mb-2 text-xs text-slate-500">勤務不可（希望）の曜日（その週のパターン）</p>
              <div className="flex flex-wrap gap-2">
                {WEEK_JA.map((label, idx) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleNg(idx)}
                    className={`rounded-xl px-3 py-2 text-sm ${
                      ngWeekdayMon0.includes(idx)
                        ? 'bg-rose-100 text-rose-800 ring-2 ring-rose-300'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">備考</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="w-full rounded-2xl border-2 border-slate-200 px-4 py-3 text-sm font-bold outline-none focus:border-teal-400"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className="rounded-2xl bg-teal-600 px-6 py-3 text-white shadow-md hover:bg-teal-700"
              >
                {editingId ? '更新する' : '登録する'}
              </button>
              {editingId ? (
                <button type="button" onClick={resetForm} className="rounded-2xl border border-slate-200 px-6 py-3">
                  キャンセル
                </button>
              ) : null}
            </div>
              </>
            )}
          </form>
        </section>

        <section className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-black text-slate-600">
            {staffMode ? `あなたの登録（${facilityLabel}）` : `登録済み（${facilityLabel}）`}
          </h2>
          {prefsForFacility.length === 0 ? (
            <p className="text-sm text-slate-500">まだありません。上のフォームから登録してください。</p>
          ) : (
            <ul className="space-y-2">
              {prefsForFacility.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-100 bg-slate-50/80 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-black text-slate-800">
                      {p.staffName}
                      {!staffMode && (p.submittedBy === 'staff' || p.staffId) ? (
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-black text-teal-800">
                          スタッフ入力
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs font-normal text-slate-600">{summarizePreference(p)}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      className="rounded-xl bg-white px-3 py-2 text-xs text-teal-700 ring-1 ring-teal-200 hover:bg-teal-50"
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id)}
                      className="rounded-xl p-2 text-rose-600 hover:bg-rose-50"
                      aria-label="削除"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[2rem] border border-teal-100 bg-white p-6 shadow-sm ring-1 ring-teal-100">
          <h2 className="mb-2 text-base font-black text-slate-800">
            {staffMode ? '希望の反映イメージ（自分のみ）' : '月次勤務表（自動）'}
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            {staffMode
              ? 'あなたの希望の見え方の参考です。カレンダーで選んだ日は「休（希望）」、管理者が登録した内容と重なる場合はその日が休希望で上書きされます。確定の勤務表は管理者が作成します。'
              : '登録した勤務形態に従い、その月のカレンダーへ割り当てます。休希望は「休（希望）」、有休は「年休」で表示します。'}
          </p>
          <div className="mb-4 flex flex-wrap items-end gap-4">
            <div>
              <label className="mb-1 block text-xs text-slate-500">対象の月</label>
              <input
                type="month"
                value={monthYm}
                onChange={(e) => setMonthYm(e.target.value)}
                className="rounded-2xl border-2 border-slate-200 px-4 py-2 font-bold outline-none focus:border-teal-400"
              />
            </div>
          </div>

          {!staffMode ? (
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openPrintMonth}
                className="rounded-2xl bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-900"
              >
                印刷・プレビュー
              </button>
              <button
                type="button"
                onClick={downloadHtmlMonth}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50"
              >
                HTMLで保存
              </button>
              <button
                type="button"
                onClick={downloadCsvMonth}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50"
              >
                CSV
              </button>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[720px] border-collapse text-[11px]">
              <thead>
                <tr className="bg-slate-100">
                  <th className="sticky left-0 z-10 min-w-[5rem] border border-slate-200 bg-slate-100 px-1 py-1 text-left">
                    スタッフ
                  </th>
                  <th className="sticky left-[5rem] z-10 min-w-[3.25rem] border border-slate-200 bg-slate-100 px-1 py-1 text-left">
                    部署
                  </th>
                  {monthlyDraft.dayLabels.map((d) => (
                    <th key={d.ymd} className="border border-slate-200 px-0.5 py-1 text-center font-normal">
                      <span className="block text-[10px] text-slate-500">{d.weekdayJa}</span>
                      {d.md}
                    </th>
                  ))}
                  <th className="border border-slate-200 px-1 py-1 text-left">要約</th>
                  <th className="border border-slate-200 px-1 py-1 text-left">備考</th>
                </tr>
              </thead>
              <tbody>
                {monthlyDraft.rows.length === 0 ? (
                  <tr>
                    <td colSpan={monthColCount} className="border border-slate-200 px-4 py-8 text-center text-slate-500">
                      この施設に勤務希望がありません。先に登録してください。
                    </td>
                  </tr>
                ) : (
                  monthlyDraft.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="sticky left-0 z-10 border border-slate-200 bg-white px-1 py-1 font-black">{r.staffName}</td>
                      <td className="sticky left-[5rem] z-10 border border-slate-200 bg-white px-1 py-1 text-[10px] font-normal text-slate-700">
                        {r.department || '—'}
                      </td>
                      {r.cells.map((c, i) => (
                        <td
                          key={i}
                          className={`border border-slate-200 px-0.5 py-1 text-center leading-tight ${
                            c === '休（希望）'
                              ? 'bg-rose-50 text-rose-800'
                              : c === '年休'
                                ? 'bg-emerald-50 text-emerald-800'
                              : (c || '').startsWith('パート')
                                ? 'bg-sky-50 text-sky-900'
                                : c === '夜勤'
                                  ? 'bg-indigo-50 text-indigo-900'
                                  : c === 'ショート夜勤'
                                    ? 'bg-violet-100 text-violet-900'
                                  : c === '日勤'
                                    ? 'bg-amber-50 text-amber-900'
                                    : ''
                          }`}
                        >
                          {c || '—'}
                        </td>
                      ))}
                      <td className="border border-slate-200 px-1 py-1 text-[10px] font-normal leading-tight">{r.preferredShiftText}</td>
                      <td className="border border-slate-200 px-1 py-1 text-[10px] font-normal">{r.note}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {!staffMode ? (
        <>
        <section className="rounded-[2rem] border border-amber-100 bg-white p-6 shadow-sm ring-1 ring-amber-100">
          <h2 className="mb-2 text-base font-black text-slate-800">
            {`月次集計（${monthYm}）`}
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            休日日数は「総日数 - 勤務日数」で概算しています。労働時間は日勤8時間、夜勤15時間（17時～翌9時・休憩1時間想定）、ショート夜勤8時間（21～6時・休憩1時間想定）、パートは入力時間帯で計算します。
          </p>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="bg-amber-50">
                  <th className="border border-slate-200 px-2 py-2 text-left">スタッフ</th>
                  <th className="border border-slate-200 px-2 py-2 text-left">部署</th>
                  <th className="border border-slate-200 px-2 py-2">暦日</th>
                  <th className="border border-slate-200 px-2 py-2">休日日数</th>
                  <th className="border border-slate-200 px-2 py-2">労働日数</th>
                  <th className="border border-slate-200 px-2 py-2">年休日数</th>
                  <th className="border border-slate-200 px-2 py-2">労働時間</th>
                  <th className="border border-slate-200 px-2 py-2">週平均</th>
                </tr>
              </thead>
              <tbody>
                {monthlyWorkStats.rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="border border-slate-200 px-4 py-6 text-center text-slate-500">
                      集計する勤務希望がありません。
                    </td>
                  </tr>
                ) : (
                  monthlyWorkStats.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="border border-slate-200 px-2 py-2 font-black">{r.staffName}</td>
                      <td className="border border-slate-200 px-2 py-2 text-xs text-slate-700">{r.department || '—'}</td>
                      <td className="border border-slate-200 px-2 py-2 text-center">{r.totalDays}</td>
                      <td className="border border-slate-200 px-2 py-2 text-center">{r.holidayDays}</td>
                      <td className="border border-slate-200 px-2 py-2 text-center">{r.workDays}</td>
                      <td className="border border-slate-200 px-2 py-2 text-center text-emerald-700">{r.paidLeaveDays}</td>
                      <td className="border border-slate-200 px-2 py-2 text-center">{formatHours(r.workHours)}</td>
                      <td className="border border-slate-200 px-2 py-2 text-center">{formatHours(r.weeklyAverageHours)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[2rem] border border-sky-100 bg-white p-6 shadow-sm ring-1 ring-sky-100">
          <h2 className="mb-2 text-base font-black text-slate-800">
            {`${summaryYear}年の年間集計`}
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            月ごとの日数と、年合計の休日日数・労働日数・年休日数・労働時間・週平均労働時間を表示します。
          </p>
          <div className="space-y-4">
            {yearlyWorkStats.rows.length === 0 ? (
              <div className="rounded-xl border border-slate-200 px-4 py-6 text-center text-slate-500">
                年間集計の対象データがありません。
              </div>
            ) : (
              yearlyWorkStats.rows.map((r) => (
                <div key={r.id} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-base font-black text-slate-900">{r.staffName}</div>
                      <div className="text-xs text-slate-500">{r.department || '—'}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                      <div className="rounded-xl bg-white px-3 py-2 text-center shadow-sm">
                        <div className="text-slate-500">年休</div>
                        <div className="font-black text-emerald-700">{r.annualPaidLeaveDays}日</div>
                      </div>
                      <div className="rounded-xl bg-white px-3 py-2 text-center shadow-sm">
                        <div className="text-slate-500">休日</div>
                        <div className="font-black">{r.annualHolidayDays}日</div>
                      </div>
                      <div className="rounded-xl bg-white px-3 py-2 text-center shadow-sm">
                        <div className="text-slate-500">労働日</div>
                        <div className="font-black">{r.annualWorkDays}日</div>
                      </div>
                      <div className="rounded-xl bg-white px-3 py-2 text-center shadow-sm">
                        <div className="text-slate-500">年間労働時間</div>
                        <div className="font-black">{formatHours(r.annualWorkHours)}</div>
                      </div>
                      <div className="rounded-xl bg-white px-3 py-2 text-center shadow-sm">
                        <div className="text-slate-500">週平均</div>
                        <div className="font-black">{formatHours(r.annualWeeklyAverageHours)}</div>
                      </div>
                    </div>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                    <table className="w-full min-w-[900px] border-collapse text-xs">
                      <thead>
                        <tr className="bg-sky-50">
                          <th className="border border-slate-200 px-2 py-2">月</th>
                          <th className="border border-slate-200 px-2 py-2">暦日</th>
                          <th className="border border-slate-200 px-2 py-2">休日日数</th>
                          <th className="border border-slate-200 px-2 py-2">労働日数</th>
                          <th className="border border-slate-200 px-2 py-2">年休日数</th>
                          <th className="border border-slate-200 px-2 py-2">労働時間</th>
                          <th className="border border-slate-200 px-2 py-2">週平均</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.monthly.map((m) => (
                          <tr key={m.month}>
                            <td className="border border-slate-200 px-2 py-2 text-center">{m.month}</td>
                            <td className="border border-slate-200 px-2 py-2 text-center">{m.calendarDays}</td>
                            <td className="border border-slate-200 px-2 py-2 text-center">{m.holidayDays}</td>
                            <td className="border border-slate-200 px-2 py-2 text-center">{m.workDays}</td>
                            <td className="border border-slate-200 px-2 py-2 text-center text-emerald-700">{m.paidLeaveDays}</td>
                            <td className="border border-slate-200 px-2 py-2 text-center">{formatHours(m.workHours)}</td>
                            <td className="border border-slate-200 px-2 py-2 text-center">{formatHours(m.weeklyAverageHours)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
        </>
        ) : null}

        <section className="rounded-[2rem] border border-indigo-100 bg-white p-6 shadow-sm ring-1 ring-indigo-100">
          <h2 className="mb-2 text-base font-black text-slate-800">
            {staffMode ? '帳票の見え方（自分の行のみ・参考）' : '帳票風（横型・記号）'}
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            {staffMode
              ? '管理者が作成する帳票のイメージです。×＝休希望（あなたが選んだ日も含みます）、有＝年休、日＝日勤／パート、夜・明＝夜勤明け。'
              : '横型の帳票イメージです。×＝休希望、有＝年休、日＝日勤／パート、夜と翌日の明＝夜勤明け（簡易）。職種列には登録した部署が入ります。愛西は「愛西デイサービス」等を選び Excel の記号は自由記入・備考で。北名古屋は「北名古屋介護」で訪問介護ケアサポートの記号を、「北名古屋有料」で有料ホームの時間帯・行事・早昼遅番を備考で。中川本館は「グループハウスくまさん」で夜A/B・明・看日・数値パターン・千音寺などを備考で寄せられます。'}
          </p>
          {!staffMode ? (
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openPrintRoster}
                className="rounded-2xl bg-indigo-700 px-4 py-2 text-sm text-white hover:bg-indigo-800"
              >
                帳票風を印刷
              </button>
              <button
                type="button"
                onClick={downloadRosterHtml}
                className="rounded-2xl border border-indigo-200 bg-white px-4 py-2 text-sm hover:bg-indigo-50"
              >
                帳票風HTMLで保存
              </button>
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[900px] border-collapse text-[10px]">
              <thead>
                <tr className="bg-slate-200">
                  <th className="border border-slate-300 px-1 py-1">職種</th>
                  <th className="border border-slate-300 px-1 py-1 text-left">氏名</th>
                  {rosterTable.dayLabels.map((d, i) => (
                    <th
                      key={d.ymd}
                      className={`border border-slate-300 px-0.5 py-1 font-normal ${
                        d.mon0 === 6 ? 'bg-rose-100' : d.mon0 === 5 ? 'bg-sky-100' : ''
                      }`}
                    >
                      <span className="block text-[9px]">{i + 1}</span>
                      <span className="text-slate-600">{d.weekdayJa}</span>
                    </th>
                  ))}
                  <th className="border border-slate-300 px-1 py-1">週休</th>
                </tr>
              </thead>
              <tbody>
                {rosterTable.rows.length === 0 ? (
                  <tr>
                    <td colSpan={rosterTable.dayLabels.length + 3} className="border border-slate-200 px-4 py-6 text-center text-slate-500">
                      表示する行がありません。
                    </td>
                  </tr>
                ) : (
                  rosterTable.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="border border-slate-200 bg-slate-50 px-1 text-center text-[9px]">{r.department || '—'}</td>
                      <td className="border border-slate-200 px-1 py-0.5 text-left font-black">{r.staffName}</td>
                      {r.rosterCells.map((c, i) => {
                        const mon0 = rosterTable.dayLabels[i].mon0;
                        const sun = mon0 === 6;
                        const sat = mon0 === 5;
                        return (
                          <td
                            key={i}
                            className={`border border-slate-200 px-0.5 py-0.5 text-center ${
                              c === '夜' || c === '明'
                                ? 'bg-yellow-100'
                                : c === '×'
                                  ? 'text-slate-500'
                                  : c === '有'
                                    ? 'bg-emerald-50 text-emerald-800'
                                  : c === '日' && (sat || sun)
                                    ? 'bg-sky-50'
                                    : sun
                                      ? 'bg-rose-50/80'
                                      : sat
                                        ? 'bg-sky-50/50'
                                        : ''
                            }`}
                          >
                            {c || ' '}
                          </td>
                        );
                      })}
                      <td className="border border-slate-200 bg-slate-100 px-1 text-center font-black">{r.weekOffTotal}</td>
                    </tr>
                  ))
                )}
                {rosterTable.rows.length > 0 ? (
                  <tr>
                    <td className="border border-slate-200 bg-indigo-100 px-1 py-1 text-left text-[9px] font-black" colSpan={2}>
                      看護日勤（日）
                    </td>
                    {rosterTable.footerDayNurse.map((n, i) => {
                      const mon0 = rosterTable.dayLabels[i].mon0;
                      return (
                        <td
                          key={i}
                          className={`border border-slate-200 bg-indigo-100 px-0.5 py-1 text-center font-black ${
                            mon0 === 6 ? 'bg-rose-100' : mon0 === 5 ? 'bg-sky-100' : ''
                          }`}
                        >
                          {n}
                        </td>
                      );
                    })}
                    <td className="border border-slate-200 bg-indigo-100">—</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {!staffMode ? (
        <section className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
          <h2 className="mb-2 text-sm font-black text-slate-600">週だけ確認</h2>
          <p className="mb-4 text-xs text-slate-500">月次と同じ割当のうち、1週間分だけ表示します。</p>
          <div className="mb-4 flex flex-wrap items-end gap-4">
            <div>
              <label className="mb-1 block text-xs text-slate-500">週の月曜日</label>
              <input
                type="date"
                value={weekMondayYmd}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const mon = mondayOfWeekContaining(parseYmd(v));
                  setWeekMondayYmd(formatYmd(mon));
                }}
                className="rounded-2xl border-2 border-slate-200 px-4 py-2 font-bold outline-none focus:border-teal-400"
              />
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={openPrintWeek}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50"
            >
              印刷・プレビュー（週）
            </button>
            <button type="button" onClick={downloadHtmlWeek} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50">
              HTML（週）
            </button>
            <button type="button" onClick={downloadCsvWeek} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50">
              CSV（週）
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="bg-slate-100">
                  <th className="border border-slate-200 px-2 py-2 text-left">スタッフ</th>
                  <th className="border border-slate-200 px-2 py-2 text-left">部署</th>
                  {weekDraft.dayLabels.map((d) => (
                    <th key={d.ymd} className="border border-slate-200 px-1 py-2 text-center text-xs">
                      {d.ja}
                      <br />
                      <span className="font-normal text-slate-500">{d.md}</span>
                    </th>
                  ))}
                  <th className="border border-slate-200 px-2 py-2 text-left">要約</th>
                  <th className="border border-slate-200 px-2 py-2 text-left">備考</th>
                </tr>
              </thead>
              <tbody>
                {weekDraft.rows.length === 0 ? (
                  <tr>
                    <td colSpan={weekColCount} className="border border-slate-200 px-4 py-8 text-center text-slate-500">
                      この施設に勤務希望がありません。
                    </td>
                  </tr>
                ) : (
                  weekDraft.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="border border-slate-200 px-2 py-2 font-black">{r.staffName}</td>
                      <td className="border border-slate-200 px-2 py-2 text-xs font-normal text-slate-700">{r.department || '—'}</td>
                      {r.cells.map((c, i) => (
                        <td
                          key={i}
                          className={`border border-slate-200 px-1 py-2 text-center text-xs ${
                            c === '休（希望）'
                              ? 'bg-rose-50 text-rose-800'
                              : (c || '').startsWith('パート')
                                ? 'bg-sky-50'
                                : c === '夜勤'
                                  ? 'bg-indigo-50'
                                  : c === '日勤'
                                    ? 'bg-amber-50'
                                    : ''
                          }`}
                        >
                          {c || '—'}
                        </td>
                      ))}
                      <td className="border border-slate-200 px-2 py-2 text-xs font-normal">{r.preferredShiftText}</td>
                      <td className="border border-slate-200 px-2 py-2 text-xs font-normal">{r.note}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
        ) : null}
      </main>
    </div>
  );
}
