/** 情報提供書・看護文書の取込（PDF / 画像） */

export const PROVISION_DOC_MAX_BYTES = 4 * 1024 * 1024;

export const PROVISION_DOC_ACCEPT = Object.freeze(
  'application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/gif,.gif'
);

const MIME_BY_EXT = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
});

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/**
 * @param {string} dataUrl
 */
export function mimeFromDataUrl(dataUrl) {
  const m = /^data:([^;,]+)/i.exec(String(dataUrl ?? '').trim());
  return m ? m[1].trim().toLowerCase() : '';
}

/**
 * @param {string} fileName
 */
export function guessMimeFromFileName(fileName) {
  const ext = String(fileName ?? '')
    .split('.')
    .pop()
    ?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || 'application/pdf';
}

/**
 * @param {string} mime
 */
export function isAllowedProvisionMime(mime) {
  return ALLOWED_MIMES.has(String(mime ?? '').trim().toLowerCase());
}

/**
 * @param {File | null | undefined} file
 * @returns {{ ok: true; mime: string } | { ok: false; message: string }}
 */
export function validateProvisionDocumentFile(file) {
  if (!file) return { ok: false, message: 'ファイルを選んでください' };
  if (file.size > PROVISION_DOC_MAX_BYTES) {
    return {
      ok: false,
      message: `ファイルは ${Math.floor(PROVISION_DOC_MAX_BYTES / (1024 * 1024))}MB 以下にしてください（API制限のため）`,
    };
  }
  let mime = String(file.type ?? '').trim().toLowerCase();
  if (!mime) mime = guessMimeFromFileName(file.name);
  if (!isAllowedProvisionMime(mime)) {
    return {
      ok: false,
      message: 'PDF または画像（JPEG / PNG / WebP / GIF）を選んでください',
    };
  }
  return { ok: true, mime };
}

/**
 * @param {string} mime
 */
export function isProvisionImageMime(mime) {
  return String(mime ?? '').startsWith('image/');
}
