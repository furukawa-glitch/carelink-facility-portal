/**
 * GET /api/build-id — 現在デプロイ中のビルドID（キャッシュ回避用）
 */

export default function handler(req, res) {
  const buildId = String(
    process.env.VERCEL_GIT_COMMIT_SHA || process.env.VITE_APP_BUILD_ID || ''
  )
    .trim()
    .slice(0, 7);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.end(JSON.stringify({ buildId: buildId || 'dev' }));
}
