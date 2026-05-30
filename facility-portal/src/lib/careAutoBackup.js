/**
 * 23:59（日本時間）自動バックアップ + SSD 二重保存
 */
import { buildCareDataBackupPayload } from './careDataBackup.js';
import {
  isFileSystemAccessSupported,
  loadBackupDirectoryHandle,
  writeBlobToDirectory,
} from './careBackupDirIdb.js';
import { pruneOldBackupSnapshots, saveDailyBackupSnapshot } from './careBackupSnapshotIdb.js';

const LS_LAST_AUTO = 'carelink_os_last_auto_backup_ymd_v1';
const LS_AUTO_LOG = 'carelink_os_auto_backup_log_v1';

/** @returns {{ ymd: string; hour: number; minute: number; second: number }} */
export function tokyoNowParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    hour: parseInt(get('hour'), 10) || 0,
    minute: parseInt(get('minute'), 10) || 0,
    second: parseInt(get('second'), 10) || 0,
  };
}

function addDaysYmd(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00+09:00`);
  d.setDate(d.getDate() + delta);
  const p = tokyoNowParts(d);
  return p.ymd;
}

export function isNightShiftCorrectionWindow() {
  const { hour } = tokyoNowParts();
  return hour >= 0 && hour < 8;
}

/** 夜勤が前日分を修正するときの対象日（0:00–7:59 は前日） */
export function suggestedBulkInputYmdForNow() {
  const { ymd, hour } = tokyoNowParts();
  if (hour >= 0 && hour < 8) return addDaysYmd(ymd, -1);
  return ymd;
}

function readLastAutoYmd() {
  try {
    return String(localStorage.getItem(LS_LAST_AUTO) ?? '').trim();
  } catch {
    return '';
  }
}

function writeLastAutoYmd(ymd) {
  try {
    localStorage.setItem(LS_LAST_AUTO, ymd);
  } catch {
    // ignore
  }
}

function appendAutoLog(entry) {
  try {
    const raw = localStorage.getItem(LS_AUTO_LOG);
    const list = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(list) ? list : [];
    next.unshift(entry);
    localStorage.setItem(LS_AUTO_LOG, JSON.stringify(next.slice(0, 60)));
  } catch {
    // ignore
  }
}

export function readAutoBackupLog() {
  try {
    const raw = localStorage.getItem(LS_AUTO_LOG);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} facilityLabel
 * @param {'manual' | 'auto2359'} trigger
 */
export async function runCareBackupToAllTargets(facilityLabel = '', trigger = 'manual') {
  const { payload, stats } = buildCareDataBackupPayload();
  const { ymd, hour, minute } = tokyoNowParts();
  const safeFac = String(facilityLabel ?? '')
    .trim()
    .replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]+/gu, '_')
    .slice(0, 24);
  const dailyName = `carelink${safeFac ? `-${safeFac}` : ''}-${ymd.replace(/-/g, '')}-2359.json`;
  const latestName = `carelink${safeFac ? `-${safeFac}` : ''}-latest.json`;
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });

  /** @type {string[]} */
  const writtenTo = [];

  await saveDailyBackupSnapshot(ymd, payload);
  writtenTo.push('ブラウザ内スナップショット');
  void pruneOldBackupSnapshots();

  if (isFileSystemAccessSupported()) {
    for (const slot of /** @type {const} */ (['primary', 'secondary'])) {
      const dir = await loadBackupDirectoryHandle(slot);
      if (!dir) continue;
      try {
        await writeBlobToDirectory(dir, dailyName, blob);
        await writeBlobToDirectory(dir, latestName, blob);
        writtenTo.push(slot === 'primary' ? 'SSD①' : 'SSD②');
      } catch (e) {
        writtenTo.push(`${slot === 'primary' ? 'SSD①' : 'SSD②'}:失敗(${e instanceof Error ? e.message : 'error'})`);
      }
    }
  }

  if (trigger === 'auto2359') writeLastAutoYmd(ymd);

  const entry = {
    at: new Date().toISOString(),
    trigger,
    backupYmd: ymd,
    timeLabel: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} JST`,
    files: [dailyName, latestName],
    writtenTo,
    stats,
  };
  appendAutoLog(entry);
  return entry;
}

/** 23:59 JST に1日1回実行 */
export function shouldRunAutoBackup2359Now() {
  const { ymd, hour, minute } = tokyoNowParts();
  if (hour !== 23 || minute !== 59) return false;
  return readLastAutoYmd() !== ymd;
}

/**
 * @param {() => void | Promise<void>} onBackup
 * @returns {() => void}
 */
export function startAutoBackup2359Scheduler(onBackup) {
  const tick = () => {
    if (shouldRunAutoBackup2359Now()) {
      void Promise.resolve(onBackup()).catch(() => {});
    }
  };
  tick();
  const id = window.setInterval(tick, 15_000);
  return () => window.clearInterval(id);
}
