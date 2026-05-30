/**
 * File System Access API のフォルダハンドル永続化（SSD 等）
 */
const DB_NAME = 'carelink_backup_dirs_v1';
const DB_VERSION = 1;
const STORE = 'handles';

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/**
 * @param {'primary' | 'secondary'} slot
 * @param {FileSystemDirectoryHandle} handle
 */
export async function saveBackupDirectoryHandle(slot, handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, slot);
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * @param {'primary' | 'secondary'} slot
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
export async function loadBackupDirectoryHandle(slot) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(slot);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} filename
 * @param {Blob} blob
 */
export async function writeBlobToDirectory(dir, filename, blob) {
  const perm = await dir.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('フォルダへの書き込みが許可されていません');
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}
