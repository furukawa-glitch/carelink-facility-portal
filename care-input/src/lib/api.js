/** /api/care-sync・/api/staff-auth を叩くクライアント */

import { ORG_ID, SYNC_SECRET } from '../config.js';

/** @param {Record<string, unknown>} body */
export async function postCareSync(body) {
  const res = await fetch('/api/care-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SYNC_SECRET, organizationId: ORG_ID, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(String(json?.error ?? `care-sync HTTP ${res.status}`));
  }
  return json;
}

/** @param {Record<string, unknown>} body */
export async function postStaffAuth(body) {
  const res = await fetch('/api/staff-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId: ORG_ID, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json?.error) {
    throw new Error(`staff-auth HTTP ${res.status}`);
  }
  return json;
}

/**
 * 職員ログイン
 * @param {string} staffCode
 * @param {string} password
 */
export async function login(staffCode, password) {
  const json = await postStaffAuth({ action: 'login', staffCode, password });
  if (!json?.ok) throw new Error(String(json?.error ?? 'ログインに失敗しました。'));
  return { token: String(json.token ?? ''), expiresAt: Number(json.expiresAt ?? 0), staff: json.staff };
}

/** セッショントークンの有効性確認 */
export async function validate(token) {
  const json = await postStaffAuth({ action: 'validate', sessionToken: token });
  return Boolean(json?.ok && json?.valid);
}

/** 名簿取得（Supabase residents） */
export async function pullResidents() {
  const json = await postCareSync({ action: 'pull_residents' });
  return Array.isArray(json?.residents) ? json.residents : [];
}

/** イベント送信（複数可） */
export async function upsertEvents(events) {
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return { ok: true, upserted: 0 };
  return postCareSync({ action: 'upsert_events', events: list });
}

/** 記録取得（訂正用。sinceTs 以降のイベント payload を新しい順で返す） */
export async function pullEvents(sinceTs) {
  const json = await postCareSync({ action: 'pull_events', sinceTs: sinceTs || '', limit: 1000 });
  return Array.isArray(json?.events) ? json.events : [];
}
