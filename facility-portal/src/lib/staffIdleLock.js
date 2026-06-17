import { useEffect, useRef } from 'react';
import { STAFF_IDLE_LOCK_MS } from './staffSessionAuth.js';

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll', 'pointerdown'];

/**
 * 無操作でロック（カイポケ型の自動ログオフ）
 * @param {boolean} enabled
 * @param {() => void} onLock
 */
export function useStaffIdleLock(enabled, onLock) {
  const onLockRef = useRef(onLock);
  const timerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  onLockRef.current = onLock;

  useEffect(() => {
    if (!enabled) return undefined;

    const reset = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        onLockRef.current?.();
      }, STAFF_IDLE_LOCK_MS);
    };

    const onActivity = () => reset();

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reset();
    });

    reset();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
    };
  }, [enabled]);
}
