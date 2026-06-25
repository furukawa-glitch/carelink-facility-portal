import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 親フォルダ（CareLink_AI/.env）と care-input/.env* をマージして読み込む。
// 同名キーは care-input 側を優先。
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, '..', '');
  const localEnv = loadEnv(mode, process.cwd(), '');
  const merged = { ...rootEnv, ...localEnv };
  const define = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith('VITE_')) {
      define[`import.meta.env.${key}`] = JSON.stringify(value);
    }
  }
  return {
    plugins: [react()],
    define,
    server: { port: 5174 },
  };
});
