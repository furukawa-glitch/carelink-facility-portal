import { createClient } from '@supabase/supabase-js';

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let browserClient = null;

/**
 * ブラウザ用の Supabase クライアント（シングルトン）。
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が無いときは null。
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
export function getSupabaseBrowserClient() {
  const url = String(import.meta.env.VITE_SUPABASE_URL ?? '').trim();
  const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  if (!url || !anonKey) return null;
  if (!browserClient) {
    browserClient = createClient(url, anonKey);
  }
  return browserClient;
}
