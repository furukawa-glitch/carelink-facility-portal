/**
 * GET/POST /api/care-sync-status — サーバ側の同期設定が揃っているか（秘密情報は返さない）
 */

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function resolveCareSyncEnv() {
  const supabaseUrl = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
  ).trim();
  const secret = String(process.env.CARE_SYNC_SECRET || process.env.VITE_CARE_SYNC_SECRET || '').trim();
  const defaultOrgId = String(
    process.env.CARELINK_ORGANIZATION_ID || process.env.VITE_CARELINK_ORGANIZATION_ID || ''
  ).trim();
  return { supabaseUrl, serviceKey, secret, defaultOrgId };
}

export default async function handler(req, res) {
  const { supabaseUrl, serviceKey, secret, defaultOrgId } = resolveCareSyncEnv();
  const ready = Boolean(supabaseUrl && serviceKey && secret);
  const missing = [];
  if (!supabaseUrl) missing.push('VITE_SUPABASE_URL（または SUPABASE_URL）');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret) missing.push('CARE_SYNC_SECRET');

  sendJson(res, 200, {
    ok: ready,
    ready,
    hasSupabaseUrl: Boolean(supabaseUrl),
    hasServiceRoleKey: Boolean(serviceKey),
    hasSyncSecret: Boolean(secret),
    hasOrganizationId: Boolean(defaultOrgId),
    missing,
    hint: ready
      ? 'サーバー側の設定は完了しています。ブラウザの VITE_ 変数と再デプロイも確認してください。'
      : `Vercel の Environment Variables に未設定: ${missing.join('、')}。設定後は必ず再デプロイしてください。`,
  });
}
