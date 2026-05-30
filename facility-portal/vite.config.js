import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sheetProxy = {
  '/spreadsheet-export': {
    target: 'https://docs.google.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/spreadsheet-export/, ''),
  },
};

/**
 * npm run dev / vite preview: 本番と同じ `/api/near-miss-gas` を提供（GAS へのシークレットはサーバー側のみ）
 * @param {import('vite').ViteDevServer['middlewares']} stack
 * @param {Record<string, string>} env
 */
function installNearMissGasProxy(stack, env) {
  stack.use(async (req, res, next) => {
    const pathname = req.url?.split('?')[0];
    if (pathname !== '/api/near-miss-gas' || req.method !== 'POST') {
      return next();
    }
    const gasUrl = String(env.VITE_NEAR_MISS_APPS_SCRIPT_URL ?? env.NEAR_MISS_APPS_SCRIPT_URL ?? '').trim();
    const secret = String(
      env.NEAR_MISS_APP_SECRET ?? env.VITE_NEAR_MISS_APP_SECRET ?? ''
    ).trim();
    if (!gasUrl || !secret) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          ok: false,
          error:
            'GAS proxy: .env に VITE_NEAR_MISS_APPS_SCRIPT_URL と NEAR_MISS_APP_SECRET（または VITE_NEAR_MISS_APP_SECRET）を設定してください。',
        })
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
      return;
    }
    const { action, ...rest } = payload;
    if (!action || typeof action !== 'string') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'Missing action' }));
      return;
    }
    try {
      const gasRes = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, action, ...rest }),
      });
      const text = await gasRes.text();
      res.statusCode = gasRes.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
  });
}

export default defineConfig(({ mode }) => {
  const parentDir = path.join(__dirname, '..');
  const env = { ...loadEnv(mode, parentDir, ''), ...loadEnv(mode, __dirname, '') };
  const notionToken = env.VITE_NOTION_INTEGRATION_TOKEN || '';
  const notionProxy = notionToken
    ? {
        '/notion-api': {
          target: 'https://api.notion.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/notion-api/, '/v1'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${notionToken}`);
              proxyReq.setHeader('Notion-Version', '2022-06-28');
            });
          },
        },
      }
    : {};

  /** 親（CareLink_AI/.env）と facility-portal/.env* をマージ。Notion トークンはプロキシのみ（バンドルに含めない） */
  const define = Object.fromEntries(
    Object.keys(env)
      .filter((k) => k.startsWith('VITE_') && k !== 'VITE_NOTION_INTEGRATION_TOKEN')
      .map((k) => [`import.meta.env.${k}`, JSON.stringify(env[k] ?? '')])
  );
  /** GAS URL: Vercel では VITE_ を付けない運用（NEAR_MISS_APPS_SCRIPT_URL のみ）でもクライアントが中継先を知れるようにする */
  const nearMissGasUrl = String(
    env.VITE_NEAR_MISS_APPS_SCRIPT_URL || env.NEAR_MISS_APPS_SCRIPT_URL || ''
  ).trim();
  define['import.meta.env.VITE_NEAR_MISS_APPS_SCRIPT_URL'] = JSON.stringify(nearMissGasUrl);

  /** 施設ロック用パスワード: 親 .env 等で VITE_ を付け忘れた FACILITY_PORTAL_PASSWORD も参照（値は同様にクライアントに埋め込まれる） */
  const facilityPortalPassword = String(
    env.VITE_FACILITY_PORTAL_PASSWORD || env.FACILITY_PORTAL_PASSWORD || '',
  ).trim();
  define['import.meta.env.VITE_FACILITY_PORTAL_PASSWORD'] = JSON.stringify(facilityPortalPassword);

  /** バックアップ・SSD・復元 UI の管理者 PIN（現場共有パスワードとは別） */
  const backupAdminPassword = String(
    env.VITE_BACKUP_ADMIN_PASSWORD || env.BACKUP_ADMIN_PASSWORD || '',
  ).trim();
  define['import.meta.env.VITE_BACKUP_ADMIN_PASSWORD'] = JSON.stringify(backupAdminPassword);

  return {
    define,
    envDir: __dirname,
    plugins: [
      react(),
      {
        name: 'near-miss-gas-proxy',
        enforce: 'pre',
        configureServer(server) {
          installNearMissGasProxy(server.middlewares, env);
        },
        configurePreviewServer(server) {
          installNearMissGasProxy(server.middlewares, env);
        },
      },
    ],
    server: { proxy: { ...sheetProxy, ...notionProxy } },
    preview: { proxy: { ...sheetProxy, ...notionProxy } },
  };
});
