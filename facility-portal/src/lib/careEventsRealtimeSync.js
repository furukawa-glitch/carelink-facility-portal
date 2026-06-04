/**
 * Supabase Realtime（broadcast）で他PCの保存を検知し pull する。
 * VITE_CARE_CLOUD_SYNC=1 + VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY が必要。
 */

import { getSupabaseBrowserClient } from './supabaseClient.js';
import { pullAllCloudDataAndApply } from './cloudDataSync.js';
import { isCareCloudSyncConfigured } from './careEventsSupabaseSync.js';

export const CARE_EVENTS_SYNC_EVENT = 'carelink-care-events-sync';

const PULL_DEBOUNCE_MS = 500;

/** @param {string} orgId */
export function careEventsRealtimeChannelName(orgId) {
  return `carelink-sync:${String(orgId ?? '').trim()}`;
}

function organizationId() {
  return String(import.meta.env.VITE_CARELINK_ORGANIZATION_ID ?? '').trim();
}

let pullTimer = 0;
let pulling = false;

/**
 * @param {(result: { merged?: number; pulled?: number }) => void} [onApplied]
 */
async function pullAndNotify(onApplied) {
  if (pulling) return;
  pulling = true;
  try {
    const result = await pullAllCloudDataAndApply();
    const merged = Number(result?.merged ?? 0);
    const storesMerged = Number(result?.storesMerged ?? 0);
    if (typeof window !== 'undefined' && (merged > 0 || storesMerged > 0 || Number(result?.pulled ?? 0) > 0)) {
      window.dispatchEvent(new CustomEvent(CARE_EVENTS_SYNC_EVENT, { detail: result }));
    }
    if (merged > 0 || storesMerged > 0) onApplied?.(result);
  } catch {
    // クラウド未設定・一時失敗時は黙って継続
  } finally {
    pulling = false;
  }
}

/**
 * @param {(result: { merged?: number; pulled?: number }) => void} [onApplied]
 */
function schedulePull(onApplied) {
  if (pullTimer) window.clearTimeout(pullTimer);
  pullTimer = window.setTimeout(() => {
    pullTimer = 0;
    void pullAndNotify(onApplied);
  }, PULL_DEBOUNCE_MS);
}

/**
 * Realtime 購読を開始。戻り値は cleanup。
 * @param {(result: { merged?: number; pulled?: number }) => void} [onApplied]
 */
export function startCareEventsRealtimeSync(onApplied) {
  if (!isCareCloudSyncConfigured()) return () => {};
  const orgId = organizationId();
  const supabase = getSupabaseBrowserClient();
  if (!orgId || !supabase) return () => {};

  const channel = supabase.channel(careEventsRealtimeChannelName(orgId), {
    config: { broadcast: { self: false } },
  });

  channel.on('broadcast', { event: 'events_updated' }, () => {
    schedulePull(onApplied);
  });

  channel.subscribe();

  return () => {
    if (pullTimer) {
      window.clearTimeout(pullTimer);
      pullTimer = 0;
    }
    void supabase.removeChannel(channel);
  };
}
