/**
 * 職員ログイン（カイポケ型）— クライアントセッション
 * ふれあいの里（VITE_STAFF_LOGIN_ENABLED=1）専用。
 */

import { saveStaffProfile } from '../services/NearMissLedgerService.js';

const SESSION_KEY = 'carelink_staff_session_v1';

export const VITE_STAFF_LOGIN_ENABLED = String(import.meta.env.VITE_STAFF_LOGIN_ENABLED ?? '').trim() === '1';

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
export const STAFF_IDLE_LOCK_MS = (() => {
  const n = Number(import.meta.env.VITE_STAFF_IDLE_LOCK_MS ?? DEFAULT_IDLE_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_IDLE_MS;
})();

const ORG_ID = String(import.meta.env.VITE_CARELINK_ORGANIZATION_ID ?? '').trim();

/** @returns {boolean} */
export function isStaffLoginEnabled() {
  return VITE_STAFF_LOGIN_ENABLED;
}

/**
 * @typedef {{ token: string; staffAccountId: string; staffCode: string; displayName: string; isAdmin: boolean; expiresAt: number }} StaffSession
 */

/** @returns {StaffSession | null} */
export function getStaffSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const expiresAt = Number(o.expiresAt ?? 0);
    if (!expiresAt || expiresAt < Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    const token = String(o.token ?? '').trim();
    const staffAccountId = String(o.staffAccountId ?? '').trim();
    if (!token || !staffAccountId) return null;
    return {
      token,
      staffAccountId,
      staffCode: String(o.staffCode ?? '').trim(),
      displayName: String(o.displayName ?? '').trim(),
      isAdmin: Boolean(o.isAdmin),
      expiresAt,
    };
  } catch {
    return null;
  }
}

/** @param {StaffSession} session */
export function saveStaffSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  saveStaffProfile({
    displayName: session.displayName,
    staffId: session.staffAccountId,
  });
}

export function clearStaffSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

/**
 * @param {string} staffCode
 * @param {string} password
 */
export async function loginStaff(staffCode, password) {
  const res = await fetch('/api/staff-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'login',
      organizationId: ORG_ID || undefined,
      staffCode,
      password,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    throw new Error(String(data?.error ?? 'ログインに失敗しました。'));
  }
  /** @type {StaffSession} */
  const session = {
    token: String(data.token ?? ''),
    staffAccountId: String(data.staff?.id ?? ''),
    staffCode: String(data.staff?.staffCode ?? staffCode),
    displayName: String(data.staff?.displayName ?? ''),
    isAdmin: Boolean(data.staff?.isAdmin),
    expiresAt: Number(data.expiresAt ?? 0),
  };
  saveStaffSession(session);
  return session;
}

/** @param {string} token */
export async function validateStaffSession(token) {
  const res = await fetch('/api/staff-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'validate', sessionToken: token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok || !data?.valid) return false;
  const cur = getStaffSession();
  if (cur && data.staff) {
    saveStaffSession({
      ...cur,
      displayName: String(data.staff.displayName ?? cur.displayName),
      isAdmin: Boolean(data.staff.isAdmin),
    });
  }
  return true;
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} payload
 */
export async function staffAuthAdminRequest(action, payload = {}) {
  const session = getStaffSession();
  if (!session?.token) {
    throw new Error('ログインしてください。');
  }
  const res = await fetch('/api/staff-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      sessionToken: session.token,
      organizationId: ORG_ID || undefined,
      ...payload,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    throw new Error(String(data?.error ?? '操作に失敗しました。'));
  }
  return data;
}

/** @returns {boolean} */
export function isStaffAdmin() {
  return Boolean(getStaffSession()?.isAdmin);
}
