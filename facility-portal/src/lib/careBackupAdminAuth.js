/** バックアップ・SSD・復元 UI の管理者 PIN（現場スタッフには非公開） */
export const VITE_BACKUP_ADMIN_PASSWORD = String(
  import.meta.env.VITE_BACKUP_ADMIN_PASSWORD ?? '',
).trim();

/** Vercel / .env に PIN が設定済みか */
export function isBackupAdminPasswordConfigured() {
  return Boolean(VITE_BACKUP_ADMIN_PASSWORD);
}

/** バックアップ操作 UI は常にロック（PIN 解除後のみ操作可） */
export function isBackupAdminLockEnabled() {
  return true;
}

/**
 * @param {string} draft
 * @returns {boolean}
 */
export function verifyBackupAdminPassword(draft) {
  if (!isBackupAdminPasswordConfigured()) return false;
  return String(draft ?? '').trim() === VITE_BACKUP_ADMIN_PASSWORD;
}
