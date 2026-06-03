import React from 'react';
import { buildResidentStayStatusBadges, normalizeResidentStayStatus } from '../lib/residentStayStatus.js';

/**
 * @param {{
 *   status: unknown;
 *   critical?: boolean;
 *   className?: string;
 *   noteClassName?: string;
 * }} props
 */
export function ResidentStayStatusBadges({ status, critical = false, className = '', noteClassName = '' }) {
  const badges = buildResidentStayStatusBadges(status);
  const note = String(normalizeResidentStayStatus(status)?.note ?? '').trim();
  if (!badges.length && !note) return null;
  return (
    <div className={className}>
      {badges.length ? (
        <div className="flex flex-wrap gap-1">
          {badges.map((b) => (
            <span
              key={b.key}
              className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-black leading-tight sm:text-[11px] ${
                critical ? 'border-white/60 bg-black/30 text-white' : b.className
              }`}
            >
              {b.label}
            </span>
          ))}
        </div>
      ) : null}
      {note ? (
        <p
          className={`mt-1 line-clamp-2 whitespace-pre-wrap text-[10px] font-bold leading-snug sm:text-[11px] ${
            noteClassName || (critical ? 'text-red-50' : 'text-slate-700')
          }`}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}
