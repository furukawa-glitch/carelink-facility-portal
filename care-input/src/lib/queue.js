/**
 * 送信キュー。オンラインなら即送信、失敗・オフライン時は localStorage に貯めて自動再送。
 * これにより電波の弱い現場でも入力が失われない。
 */

import { upsertEvents } from './api.js';

const KEY = 'care_input_pending_events_v1';
const listeners = new Set();

function readPending() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePending(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn(list.length);
}

export function pendingCount() {
  return readPending().length;
}

/** @param {(count: number) => void} fn */
export function subscribePending(fn) {
  listeners.add(fn);
  fn(pendingCount());
  return () => listeners.delete(fn);
}

let flushing = false;

/**
 * イベントを送信（失敗時はキューに残して後で再送）。
 * @param {Record<string, unknown>[]} events
 * @returns {Promise<{ sent: boolean; queued: number }>}
 */
export async function sendOrQueue(events) {
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return { sent: true, queued: pendingCount() };
  // まず既存キューに積んでから flush（順序維持・取りこぼし防止）
  const pending = readPending();
  pending.push(...list);
  writePending(pending);
  const ok = await flush();
  return { sent: ok, queued: pendingCount() };
}

/** キューを送信。成功した分だけ取り除く。 */
export async function flush() {
  if (flushing) return false;
  if (!navigator.onLine) return false;
  const pending = readPending();
  if (!pending.length) return true;
  flushing = true;
  try {
    await upsertEvents(pending);
    // 送信中に増えた分を考慮して差し引く
    const after = readPending();
    const remaining = after.slice(pending.length);
    writePending(remaining);
    return true;
  } catch {
    return false;
  } finally {
    flushing = false;
  }
}

// オンライン復帰・タブ復帰時に自動再送
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flush());
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush();
  });
}
