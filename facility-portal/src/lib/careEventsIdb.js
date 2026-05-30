/**
 * 生活記録 careEvents の IndexedDB 永続化（localStorage 容量超過対策・5年保管）
 */
import { pruneCareEventsBeyondRetention } from './careRecordRetention.js';

const DB_NAME = 'carelink_care_events_v1';
const DB_VERSION = 1;
const STORE = 'events';

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('ts', 'ts', { unique: false });
        os.createIndex('residentId', 'residentId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/**
 * @param {IDBDatabase} db
 * @param {unknown[]} events
 */
function txPutAll(db, events) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    os.clear();
    for (const ev of events) {
      if (ev && typeof ev === 'object' && ev.id) os.put(ev);
    }
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
  });
}

/** @returns {Promise<unknown[]>} */
export async function idbLoadAllCareEvents() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
    });
  } catch {
    return [];
  }
}

/**
 * @param {unknown[]} events
 */
export async function idbSaveAllCareEvents(events) {
  const pruned = pruneCareEventsBeyondRetention(Array.isArray(events) ? events : []);
  try {
    const db = await openDb();
    await txPutAll(db, pruned);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} event
 */
export async function idbAppendCareEvent(event) {
  if (!event?.id) return false;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(event);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

/** localStorage → IndexedDB 初回移行 */
export async function idbMigrateFromLocalStorage(localEvents) {
  const local = Array.isArray(localEvents) ? localEvents : [];
  if (!local.length) return 0;
  const existing = await idbLoadAllCareEvents();
  if (existing.length > 0) return existing.length;
  await idbSaveAllCareEvents(local);
  return local.length;
}

/**
 * @param {unknown[]} a
 * @param {unknown[]} b
 */
export function mergeCareEventsById(a, b) {
  const map = new Map();
  for (const ev of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!ev || typeof ev !== 'object') continue;
    const id = String(ev.id ?? '');
    if (id) map.set(id, ev);
  }
  return Array.from(map.values()).sort((x, y) => new Date(x.ts) - new Date(y.ts));
}
