/** 環境設定（ビルド時に埋め込み）。facility-portal と同じ組織ID・シークレットを使うこと。 */

export const ORG_ID = String(import.meta.env.VITE_CARELINK_ORGANIZATION_ID ?? '').trim();
export const SYNC_SECRET = String(import.meta.env.VITE_CARE_SYNC_SECRET ?? '').trim();
export const BUILD_ID = String(import.meta.env.VITE_APP_BUILD_ID ?? 'local').trim();

/** この入力アプリで記録する施設（先頭が既定）。スプレッドシートのタブ名/施設名に一致させる。 */
export const FACILITIES = String(import.meta.env.VITE_CARE_INPUT_FACILITY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const DEFAULT_FACILITY = FACILITIES[0] ?? '';

/** 設定が揃っているか（揃っていなければ案内を出す） */
export function isConfigured() {
  return Boolean(ORG_ID && SYNC_SECRET);
}
