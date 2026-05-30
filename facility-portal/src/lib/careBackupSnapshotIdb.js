/**
 * ブラウザ内の日次バックアップスナップショット（SSD 障害時の第2保管先）
 */
import { CARE_RECORD_RETENTION_YEARS } from './careRecordRetention.js';

const DB_NAME = 'carelink_backup_snapshots_v1';
const DB_VERSION = 1;
const STORE = 'daily';

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'backupYmd' });
        os.createIndex('exportedAt', 'exportedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/**
 * @param {string} backupYmd YYYY-MM-DD（バックアップ対象日・日本時間）
 * @param {object} payload
 */
export async function saveDailyBackupSnapshot(backupYmd, payload) {
  const db = await openDb();
  const row = {
    backupYmd,
    exportedAt: new Date().toISOString(),
    payload,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {string} backupYmd */
export async function loadDailyBackupSnapshot(backupYmd) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(backupYmd);
      req.onsuccess = () => resolve(req.result?.payload ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** 保存義務期間を超えたスナップショットを削除 */
export async function pruneOldBackupSnapshots() {
  const cutoff = Date.now() - CARE_RECORD_RETENTION_YEARS * 365.25 * 24 * 60 * 60 * 1000;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      const req = os.openCursor();
      let removed = 0;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const row = cur.value;
        const t = new Date(row?.exportedAt ?? 0).getTime();
        if (Number.isFinite(t) && t < cutoff) {
          cur.delete();
          removed += 1;
        }
        cur.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}

/** @returns {Promise<{ backupYmd: string; exportedAt: string }[]>} */
export async function listBackupSnapshotDates() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? req.result : [];
        resolve(
          rows
            .map((r) => ({ backupYmd: String(r.backupYmd ?? ''), exportedAt: String(r.exportedAt ?? '') }))
            .sort((a, b) => b.backupYmd.localeCompare(a.backupYmd))
        );
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
