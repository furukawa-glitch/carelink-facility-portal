/**
 * 新しい本番デプロイを検知し、現場に Ctrl+F5 を頼まず更新できるようにする。
 */

const CLIENT_BUILD_ID = String(import.meta.env.VITE_APP_BUILD_ID ?? 'dev').trim().slice(0, 7);
const POLL_MS = 5 * 60 * 1000;

function buildIdsDiffer(clientId, serverId) {
  const a = String(clientId ?? '').trim();
  const b = String(serverId ?? '').trim();
  if (!a || !b || a === 'dev' || a === 'local' || b === 'dev' || b === 'local') return false;
  return a !== b;
}

async function fetchServerBuildId() {
  const res = await fetch('/api/build-id', { cache: 'no-store' });
  if (!res.ok) return '';
  const data = await res.json();
  return String(data?.buildId ?? '').trim().slice(0, 7);
}

/**
 * @param {(updateAvailable: boolean) => void} onChange
 * @returns {() => void}
 */
export function startAppBuildUpdateWatcher(onChange) {
  if (import.meta.env.DEV) return () => {};

  let stopped = false;

  const check = async () => {
    if (stopped) return;
    try {
      const serverId = await fetchServerBuildId();
      if (!stopped) onChange(buildIdsDiffer(CLIENT_BUILD_ID, serverId));
    } catch {
      /* オフライン等は無視 */
    }
  };

  void check();
  const timer = window.setInterval(() => void check(), POLL_MS);
  const onVis = () => {
    if (document.visibilityState === 'visible') void check();
  };
  document.addEventListener('visibilitychange', onVis);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVis);
  };
}

export function reloadForNewAppBuild() {
  window.location.reload();
}

export function clientAppBuildId() {
  return CLIENT_BUILD_ID;
}
