import * as Report from '../services/ReportService.js';

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function localYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysYmd(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return localYmd(d);
}

function eventTs(e) {
  if (e?.type === 'vital_snapshot') {
    const m = e.meta && typeof e.meta === 'object' ? e.meta : {};
    for (const key of ['visitAt', 'measuredAt', 'visitStartAt', 'visitStart']) {
      const raw = String(m[key] ?? '').trim();
      if (raw && Number.isFinite(new Date(raw).getTime())) return raw;
    }
  }
  return String(e?.ts ?? '');
}

function formatHm(iso) {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '';
  return `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function sumUrineMl(evs) {
  let sum = 0;
  let any = false;
  for (const e of evs) {
    if (e.type !== 'excretion' && e.type !== 'hourly_excretion') continue;
    const m = e.meta && typeof e.meta === 'object' ? e.meta : {};
    const measured = String(m.measuredUrineMl ?? m.catheterMl ?? '').trim();
    if (/^\d+$/u.test(measured)) {
      sum += parseInt(measured, 10);
      any = true;
      continue;
    }
    const uv = String(m.urineVolume ?? '').trim();
    if (/^\d+$/u.test(uv)) {
      sum += parseInt(uv, 10);
      any = true;
    }
  }
  return any ? sum : null;
}

function stoolSummary(evs) {
  const stools = evs.filter(
    (e) =>
      (e.type === 'excretion' || e.type === 'hourly_excretion') &&
      (e.meta?.stoolVolume || e.meta?.stoolCharacter)
  );
  if (!stools.length) return { count: 0, label: '' };
  const parts = stools.map((e) => {
    const m = e.meta ?? {};
    const v = String(m.stoolVolume ?? '').trim();
    const c = String(m.stoolCharacter ?? '').trim();
    return [v, c].filter(Boolean).join('·');
  });
  return { count: stools.length, label: parts.join(' / ') };
}

/**
 * @param {unknown[]} evs
 * @param {'朝'|'昼'|'夕'} slot
 */
function mealForSlot(evs, slot) {
  const hits = evs.filter((e) => e.type === 'meal' && String(e.meta?.mealSlot ?? e.meta?.mealTime ?? '').includes(slot));
  if (!hits.length) return '';
  return hits
    .map((e) => {
      const m = e.meta ?? {};
      const amt = String(m.mealAmount ?? m.mealValue ?? '').trim();
      const water = String(m.waterMl ?? m.hydration ?? '').trim();
      const med = m.medicationDone ? '服薬' : '';
      return [amt ? `${amt}割` : '', water ? `${water}ml` : '', med].filter(Boolean).join(' ');
    })
    .join(' / ');
}

/**
 * @param {string} residentId
 * @param {Record<string, unknown>} [resident]
 */
export function buildWeeklyFlowSheetModel(residentId, resident = {}) {
  const id = String(residentId ?? '').trim();
  const end = localYmd();
  /** @type {string[]} */
  const days = [];
  for (let i = 6; i >= 0; i -= 1) days.push(addDaysYmd(end, -i));

  const stay = Report.getResidentStayStatus(id);

  /** @type {import('./weeklyFlowSheetData.js').DayColumn[]} */
  const columns = days.map((ymd) => {
    const evs = Report.getCareEventsForResidentDay(id, ymd);
    const vitals = evs
      .filter((e) => e.type === 'vital_snapshot')
      .map((e) => {
        const m = e.meta && typeof e.meta === 'object' ? e.meta : {};
        const ts = eventTs(e);
        return {
          ts,
          hm: formatHm(ts),
          temp: m.temp != null && String(m.temp).trim() !== '' ? String(m.temp) : '',
          bpUpper: m.bpUpper != null ? String(m.bpUpper) : '',
          bpLower: m.bpLower != null ? String(m.bpLower) : '',
          pulse: m.pulse != null ? String(m.pulse) : '',
          spo2: m.spo2 != null ? String(m.spo2) : '',
          weight: m.weight != null ? String(m.weight) : '',
        };
      });
    const urineMl = sumUrineMl(evs);
    const stool = stoolSummary(evs);
    const daySvc = Report.getDayServiceCell(id, ymd);
    const dt = new Date(`${ymd}T12:00:00`);
    const weekday = WEEKDAY_JA[dt.getDay()];

    let statusLabel = '';
    if (stay?.hospitalized && stay.hospitalSince) {
      const start = new Date(`${stay.hospitalSince}T12:00:00`);
      const cur = new Date(`${ymd}T12:00:00`);
      if (cur >= start) {
        const diff = Math.floor((cur - start) / 86400000) + 1;
        statusLabel = `入院${diff}日目`;
      }
    }
    if (stay?.dischargePlannedDate === ymd) statusLabel = statusLabel ? `${statusLabel}・退院予定` : '退院予定';
    if (stay?.moveInPlannedDate === ymd) statusLabel = statusLabel ? `${statusLabel}・入居予定` : '入居予定';

    return {
      ymd,
      label: `${ymd.slice(5).replace('-', '/')}`,
      weekday,
      statusLabel,
      vitals,
      vitalsText: vitals
        .map((v) => {
          const bits = [
            v.hm,
            v.temp ? `${v.temp}℃` : '',
            v.bpUpper || v.bpLower ? `${v.bpUpper}/${v.bpLower}` : '',
            v.pulse ? `P${v.pulse}` : '',
            v.spo2 ? `Sp${v.spo2}` : '',
          ].filter(Boolean);
          return bits.join(' ');
        })
        .join('\n'),
      latestVital: vitals.at(-1) ?? null,
      meals: {
        morning: mealForSlot(evs, '朝'),
        noon: mealForSlot(evs, '昼'),
        evening: mealForSlot(evs, '夕'),
        all: evs
          .filter((e) => e.type === 'meal')
          .map((e) => {
            const m = e.meta ?? {};
            return [m.mealSlot || m.mealTime, m.mealAmount || m.mealValue].filter(Boolean).join(' ');
          })
          .join(' / '),
      },
      waterMl: (() => {
        for (const e of evs) {
          if (e.type === 'meal' && e.meta?.waterMl) return String(e.meta.waterMl);
          if (e.type === 'fluid_intake' && e.meta?.waterMl) return String(e.meta.waterMl);
        }
        return '';
      })(),
      urineMl,
      urineCount: evs.filter((e) => e.type === 'excretion' || e.type === 'hourly_excretion').length,
      stool,
      patrolCount: evs.filter((e) => e.type === 'patrol').length,
      enteralCount: evs.filter((e) => e.type === 'enteral').length,
      dayService:
        daySvc?.kind === 'on_site' ? '併設デイ' : daySvc?.kind === 'external' ? '外部デイ' : '',
      notes: evs
        .map((e) => String(e.meta?.note ?? '').trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' / '),
    };
  });

  /** @type {{ kind: string; x: number; y: number }[]} */
  const chartPoints = [];
  columns.forEach((col, di) => {
    for (const v of col.vitals) {
      const ts = new Date(v.ts);
      const hr = Number.isFinite(ts.getTime()) ? ts.getHours() : 12;
      const x = di + hr / 24;
      const t = parseFloat(String(v.temp ?? '').replace(',', '.'));
      if (Number.isFinite(t)) chartPoints.push({ kind: 'temp', x, y: t });
      const p = parseFloat(String(v.pulse ?? '').replace(',', '.'));
      if (Number.isFinite(p)) chartPoints.push({ kind: 'pulse', x, y: p });
      const sys = parseFloat(String(v.bpUpper ?? '').replace(',', '.'));
      if (Number.isFinite(sys)) chartPoints.push({ kind: 'bp_sys', x, y: sys });
    }
  });

  return {
    residentName: String(resident?.name ?? '').replace(/様\s*$/u, ''),
    room: String(resident?.room ?? '').trim(),
    days,
    columns,
    chartPoints,
    stay,
  };
}

/**
 * @typedef {{
 *   ymd: string;
 *   label: string;
 *   weekday: string;
 *   statusLabel: string;
 *   vitals: { ts: string; hm: string; temp: string; bpUpper: string; bpLower: string; pulse: string; spo2: string; weight: string }[];
 *   vitalsText: string;
 *   latestVital: { temp: string; bpUpper: string; bpLower: string; pulse: string; spo2: string; weight: string } | null;
 *   meals: { morning: string; noon: string; evening: string; all: string };
 *   waterMl: string;
 *   urineMl: number | null;
 *   urineCount: number;
 *   stool: { count: number; label: string };
 *   patrolCount: number;
 *   enteralCount: number;
 *   dayService: string;
 *   notes: string;
 * }} DayColumn
 */
