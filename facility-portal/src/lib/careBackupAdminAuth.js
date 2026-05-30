/** バックアップ・SSD・復元 UI の管理者 PIN（現場スタッフには非公開） */
export const VITE_BACKUP_ADMIN_PASSWORD = String(
  import.meta.env.VITE_BACKUP_ADMIN_PASSWORD ?? '',
).trim();

/** @returns {boolean} */
export function isBackupAdminLockEnabled() {
  return Boolean(VITE_BACKUP_ADMIN_PASSWORD);
}

/**
 * @param {string} draft
 * @returns {boolean}
 */
export function verifyBackupAdminPassword(draft) {
  if (!isBackupAdminLockEnabled()) return true;
  return String(draft ?? '').trim() === VITE_BACKUP_ADMIN_PASSWORD;
}
