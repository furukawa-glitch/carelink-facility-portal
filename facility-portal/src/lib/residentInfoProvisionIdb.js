/**
 * 利用者別・PDF 永続化（localStorage 外のバイナリ用）
 * - info_provision: 情報提供書・退院サマリー等（従来）
 * - nurse_record: 看護記録・申し送り等の写し
 *
 * 旧: v1 単一ストア byResidentId は読取時にフォールバックし、書き込み時に docs へ移行して削除
 */

const DB_NAME = 'carelink_info_provision_pdf_v1';
const DB_VERSION = 2;
const LEGACY_STORE = 'byResidentId';
const DOCS_STORE = 'docs';

/** 固定文字列。LS・URL と整合。 */
export const PDF_DOC_KIND = Object.freeze({
  /** 情報提供・退院サマリー等（従来） */
  INFO: 'info_provision',
  /** 看護記録・他職種PDFなど */
  NURSE: 'nurse_record',
});

/** ユーザが選べる全種（将来追加時はここ＋UI） */
export const ALL_PDF_DOC_KINDS = [PDF_DOC_KIND.INFO, PDF_DOC_KIND.NURSE];

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      const oldV = ev.oldVersion || 0;
      // v1 当時: byResidentId のみ
      if (oldV < 1 && !db.objectStoreNames.contains(LEGACY_STORE)) {
        db.createObjectStore(LEGACY_STORE, { keyPath: 'residentId' });
      }
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        db.createObjectStore(DOCS_STORE, { keyPath: ['residentId', 'docKind'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {string} dataUrl
 * @returns {Promise<ArrayBuffer | null>}
 */
async function abFromDataUrl(dataUrl) {
  const s = String(dataUrl ?? '');
  if (!s.startsWith('data:') && !s.includes(',')) return null;
  const res = await fetch(s);
  const ab = await res.arrayBuffer();
  return ab && ab.byteLength ? ab : null;
}

/**
 * 旧 v1: 1利用者1PDF
 * @param {string} residentId
 * @returns {Promise<null | { ab: ArrayBuffer; sourceFileName: string; updatedAt: string; docKind: string }>}
 */
async function getLegacyInfoProvision(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return null;
  const db = await openDb();
  if (!db.objectStoreNames.contains(LEGACY_STORE)) {
    db.close();
    return null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LEGACY_STORE, 'readonly');
    const rq = tx.objectStore(LEGACY_STORE).get(id);
    rq.onsuccess = () => {
      const row = rq.result;
      if (!row?.ab) {
        db.close();
        resolve(null);
        return;
      }
      db.close();
      resolve({
        ab: row.ab,
        sourceFileName: String(row.sourceFileName ?? 'document.pdf'),
        updatedAt: String(row.updatedAt ?? ''),
        docKind: PDF_DOC_KIND.INFO,
      });
    };
    rq.onerror = () => {
      db.close();
      reject(rq.error);
    };
  });
}

/**
 * @param {string} residentId
 */
async function deleteLegacyIfExists(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return;
  const db = await openDb();
  if (!db.objectStoreNames.contains(LEGACY_STORE)) {
    db.close();
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LEGACY_STORE, 'readwrite');
    tx.objectStore(LEGACY_STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * @param {string} residentId
 * @param {string} dataUrl
 * @param {string} sourceFileName
 * @param {string} [docKind=PDF_DOC_KIND.INFO]
 */
export async function putResidentDocFromDataUrl(
  residentId,
  dataUrl,
  sourceFileName,
  docKind = PDF_DOC_KIND.INFO
) {
  const id = String(residentId ?? '').trim();
  if (!id) return false;
  const kind = String(docKind || PDF_DOC_KIND.INFO).trim() || PDF_DOC_KIND.INFO;
  const ab = await abFromDataUrl(dataUrl);
  if (!ab) return false;
  const db = await openDb();
  if (!db.objectStoreNames.contains(DOCS_STORE)) {
    db.close();
    return false;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOCS_STORE, 'readwrite');
    const st = tx.objectStore(DOCS_STORE);
    st.put({
      residentId: id,
      docKind: kind,
      ab,
      sourceFileName: String(sourceFileName ?? 'document.pdf').trim() || 'document.pdf',
      updatedAt: new Date().toISOString(),
    });
    tx.oncomplete = async () => {
      db.close();
      if (kind === PDF_DOC_KIND.INFO) {
        try {
          await deleteLegacyIfExists(id);
        } catch {
          // 旧行が残っていても新 docs が優先される
        }
      }
      resolve(true);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * 互換: 従来の import 名
 * @param {string} residentId
 * @param {string} dataUrl
 * @param {string} sourceFileName
 */
export function putResidentInfoProvisionFromDataUrl(residentId, dataUrl, sourceFileName) {
  return putResidentDocFromDataUrl(residentId, dataUrl, sourceFileName, PDF_DOC_KIND.INFO);
}

/**
 * @param {string} residentId
 * @param {string} docKind
 * @returns {Promise<{ ab: ArrayBuffer; sourceFileName: string; updatedAt: string; docKind: string } | null>}
 */
export async function getResidentDocRecord(residentId, docKind) {
  const id = String(residentId ?? '').trim();
  if (!id) return null;
  const kind = String(docKind || '').trim() || PDF_DOC_KIND.INFO;
  const db = await openDb();
  if (!db.objectStoreNames.contains(DOCS_STORE)) {
    db.close();
    if (kind === PDF_DOC_KIND.INFO) return getLegacyInfoProvision(residentId);
    return null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOCS_STORE, 'readonly');
    const rq = tx.objectStore(DOCS_STORE).get([id, kind]);
    rq.onsuccess = () => {
      const row = rq.result;
      if (row?.ab) {
        db.close();
        resolve({
          ab: row.ab,
          sourceFileName: String(row.sourceFileName ?? 'document.pdf'),
          updatedAt: String(row.updatedAt ?? ''),
          docKind: kind,
        });
        return;
      }
      db.close();
      if (kind === PDF_DOC_KIND.INFO) {
        getLegacyInfoProvision(residentId).then(resolve, reject);
      } else {
        resolve(null);
      }
    };
    rq.onerror = () => {
      db.close();
      reject(rq.error);
    };
  });
}

/**
 * 互換
 * @param {string} residentId
 */
export function getResidentInfoProvisionPdfRecord(residentId) {
  return getResidentDocRecord(residentId, PDF_DOC_KIND.INFO);
}

/**
 * @param {string} residentId
 * @param {string} [docKind=PDF_DOC_KIND.INFO]
 */
export async function createResidentDocObjectUrl(residentId, docKind) {
  const rec = await getResidentDocRecord(residentId, docKind);
  if (!rec?.ab?.byteLength) return null;
  const blob = new Blob([rec.ab], { type: 'application/pdf' });
  return URL.createObjectURL(blob);
}

/**
 * @param {string} residentId
 */
export function createResidentInfoProvisionPdfObjectUrl(residentId) {
  return createResidentDocObjectUrl(residentId, PDF_DOC_KIND.INFO);
}

/**
 * @param {string} residentId
 * @param {string} docKind
 */
export async function deleteResidentDocPdf(residentId, docKind) {
  const id = String(residentId ?? '').trim();
  if (!id) return false;
  const kind = String(docKind || '').trim() || PDF_DOC_KIND.INFO;
  const db = await openDb();
  if (db.objectStoreNames.contains(DOCS_STORE)) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS_STORE, 'readwrite');
      tx.objectStore(DOCS_STORE).delete([id, kind]);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } else {
    db.close();
  }
  if (kind === PDF_DOC_KIND.INFO) {
    try {
      await deleteLegacyIfExists(id);
    } catch {
      // no-op
    }
  }
  return true;
}

/**
 * 互換
 * @param {string} residentId
 */
export function deleteResidentInfoProvisionPdf(residentId) {
  return deleteResidentDocPdf(residentId, PDF_DOC_KIND.INFO);
}

/**
 * 利用者に紐づく全 PDF 行（閲覧タブ用）
 * @param {string} residentId
 * @returns {Promise<{ docKind: string; sourceFileName: string; updatedAt: string; hasBytes: boolean }[]>}
 */
export async function listResidentDocSummaries(residentId) {
  const id = String(residentId ?? '').trim();
  if (!id) return [];
  /** @type {Map<string, { docKind: string; sourceFileName: string; updatedAt: string; hasBytes: boolean }>} */
  const m = new Map();
  for (const k of ALL_PDF_DOC_KINDS) {
    const rec = await getResidentDocRecord(id, k);
    if (rec?.ab?.byteLength) {
      m.set(k, {
        docKind: k,
        sourceFileName: rec.sourceFileName,
        updatedAt: rec.updatedAt,
        hasBytes: true,
      });
    }
  }
  return Array.from(m.values());
}

/**
 * 利用者の全 PDF 削除（看護＋情報提供＋旧v1）
 * @param {string} residentId
 */
export async function deleteAllResidentPdfs(residentId) {
  for (const k of ALL_PDF_DOC_KINDS) {
    try {
      await deleteResidentDocPdf(residentId, k);
    } catch {
      // no-op
    }
  }
  try {
    await deleteLegacyIfExists(String(residentId ?? '').trim());
  } catch {
    // no-op
  }
}
