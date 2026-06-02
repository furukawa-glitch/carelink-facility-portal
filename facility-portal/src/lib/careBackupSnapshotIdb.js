/**
 * ブラウザ内の日次バックアップスナップショット（SSD 障害時の第2保管先）
 */

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

/** 5年超のスナップショットも削除しない（データ内に保持） */
export async function pruneOldBackupSnapshots() {
  return 0;
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
