import React from 'react';

/**
 * @param {{ open: boolean; residentName: string; initialDataUrl?: string; heading?: string; onClose: () => void; onConfirm: (dataUrl: string) => void }} props
 */
export function VitalHandwritingModal({
  open,
  residentName,
  initialDataUrl = '',
  heading = '',
  onClose,
  onConfirm,
}) {
  const canvasRef = React.useRef(/** @type {HTMLCanvasElement | null} */ (null));
  const drawingRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!initialDataUrl) return;
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height);
    img.src = initialDataUrl;
  }, [open, initialDataUrl]);

  if (!open) return null;

  /** CSS 表示サイズ → canvas ビットマップ座標（w-full 等で縮小されているとき必須） */
  const pos = (ev) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const t = ev.touches?.[0];
    const cx = 'clientX' in ev && typeof ev.clientX === 'number' ? ev.clientX : t ? t.clientX : 0;
    const cy = 'clientY' in ev && typeof ev.clientY === 'number' ? ev.clientY : t ? t.clientY : 0;
    const mx = cx - rect.left;
    const my = cy - rect.top;
    const sx = c.width / Math.max(rect.width, 1);
    const sy = c.height / Math.max(rect.height, 1);
    return { x: mx * sx, y: my * sy };
  };
  const start = (ev) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    drawingRef.current = true;
    if (typeof ev.pointerId === 'number') {
      try {
        c.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
    const p = pos(ev);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  };
  const move = (ev) => {
    if (!drawingRef.current) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const p = pos(ev);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const end = (ev) => {
    drawingRef.current = false;
    const c = canvasRef.current;
    if (c && typeof ev?.pointerId === 'number') {
      try {
        c.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
  };
  const clear = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
  };
  const save = () => {
    const c = canvasRef.current;
    if (!c) return;
    onConfirm(c.toDataURL('image/jpeg', 0.55));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-3">
      <div className="w-full max-w-[760px] rounded-2xl bg-white p-3 shadow-2xl sm:p-4">
        <p className="mb-2 text-sm font-black text-slate-800">
          {heading || `${residentName} 手書きメモ（バイタル欄）`}
        </p>
        <canvas
          ref={canvasRef}
          width={720}
          height={280}
          className="w-full touch-none rounded-lg border-2 border-slate-300 bg-white"
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            e.preventDefault();
            start(e);
          }}
          onPointerMove={(e) => {
            if (!drawingRef.current) return;
            e.preventDefault();
            move(e);
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            end(e);
          }}
          onPointerCancel={(e) => {
            end(e);
          }}
          onPointerLeave={(e) => {
            if (drawingRef.current) end(e);
          }}
        />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={clear} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-bold">
            消去
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-bold">
            閉じる
          </button>
          <button type="button" onClick={save} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-black text-white">
            反映
          </button>
        </div>
      </div>
    </div>
  );
}
