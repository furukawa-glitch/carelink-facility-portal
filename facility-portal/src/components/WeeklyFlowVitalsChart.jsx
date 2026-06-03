import React, { useMemo } from 'react';

/**
 * @param {{ points: { kind: string; x: number; y: number }[]; dayCount: number; showTemp?: boolean; showPulse?: boolean; showBp?: boolean }} props
 */
export function WeeklyFlowVitalsChart({ points, dayCount, showTemp = true, showPulse = true, showBp = true }) {
  const paths = useMemo(() => {
    const w = 560;
    const h = 120;
    const padL = 36;
    const padR = 8;
    const padT = 8;
    const padB = 18;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const xMax = Math.max(1, dayCount - 0.01);

    const scaleX = (x) => padL + (x / xMax) * plotW;

    const byKind = (kind) => points.filter((p) => p.kind === kind);
    const tempPts = byKind('temp');
    const pulsePts = byKind('pulse');
    const bpPts = byKind('bp_sys');

    const line = (pts, yMin, yMax) => {
      if (!pts.length) return '';
      const range = yMax - yMin || 1;
      return pts
        .sort((a, b) => a.x - b.x)
        .map((p, i) => {
          const px = scaleX(p.x);
          const py = padT + plotH - ((p.y - yMin) / range) * plotH;
          return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
        })
        .join(' ');
    };

    return {
      w,
      h,
      padL,
      tempPath: showTemp ? line(tempPts, 35, 40) : '',
      pulsePath: showPulse ? line(pulsePts, 40, 120) : '',
      bpPath: showBp ? line(bpPts, 80, 200) : '',
      tempDots: tempPts.map((p) => ({ cx: scaleX(p.x), cy: padT + plotH - ((p.y - 35) / 5) * plotH })),
    };
  }, [points, dayCount, showTemp, showPulse, showBp]);

  if (!points.length) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-xs font-bold text-slate-500">
        この期間のバイタル記録がありません
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${paths.w} ${paths.h}`} className="w-full min-w-[320px] max-h-32 text-[10px]">
        <text x="4" y="12" fill="#dc2626" fontSize="9" fontWeight="700">
          T℃
        </text>
        <text x="4" y="24" fill="#2563eb" fontSize="9" fontWeight="700">
          P
        </text>
        <text x="4" y="36" fill="#059669" fontSize="9" fontWeight="700">
          BP上
        </text>
        {paths.tempPath ? <path d={paths.tempPath} fill="none" stroke="#dc2626" strokeWidth="2" /> : null}
        {paths.pulsePath ? <path d={paths.pulsePath} fill="none" stroke="#2563eb" strokeWidth="1.5" opacity="0.85" /> : null}
        {paths.bpPath ? <path d={paths.bpPath} fill="none" stroke="#059669" strokeWidth="1.5" opacity="0.85" /> : null}
        {showTemp
          ? paths.tempDots.map((d, i) => (
              <circle key={`t-${i}`} cx={d.cx} cy={d.cy} r="3" fill="#dc2626" />
            ))
          : null}
      </svg>
      <div className="mt-1 flex justify-between px-1 text-[9px] font-bold text-slate-500">
        <span>赤=体温</span>
        <span>青=脈拍</span>
        <span>緑=収縮期BP</span>
      </div>
    </div>
  );
}
