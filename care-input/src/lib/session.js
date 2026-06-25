/** ログインセッション（職員）の保持。記録の入力者名にも使う。 */

const KEY = 'care_input_session_v1';

/** @typedef {{ token?: string; mode?: 'shared'|'staff'; expiresAt: number; staff: { id: string; staffCode: string; displayName: string; isAdmin: boolean } }} Session */

/** @returns {Session | null} */
export function getSession() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // 職員コード方式は token 必須、共有PW方式（mode:'shared'）は token なし。
    if (!s?.staff) return null;
    if (s.mode !== 'shared' && !s.token) return null;
    if (Number(s.expiresAt ?? 0) < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

/** @param {Session} session */
export function setSession(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
