import React from 'react';
import { RefreshCw } from 'lucide-react';
import { reloadForNewAppBuild } from '../lib/appBuildUpdate.js';

/**
 * @param {{ visible: boolean }} props
 */
export function AppBuildUpdateBanner({ visible }) {
  if (!visible) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-[500] flex items-center justify-center gap-3 border-b-2 border-sky-500 bg-sky-600 px-4 py-2.5 text-center text-sm font-black text-white shadow-lg"
      role="status"
    >
      <span>新しいバージョンがあります</span>
      <button
        type="button"
        onClick={() => reloadForNewAppBuild()}
        className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-1.5 text-xs font-black text-sky-800 shadow"
      >
        <RefreshCw size={14} aria-hidden />
        最新版を読み込む
      </button>
    </div>
  );
}
