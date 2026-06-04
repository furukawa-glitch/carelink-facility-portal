/**
 * @param {ReturnType<import('../services/ReportService.js').evaluateResidentMonitor>} ev
 * @param {{ hasAlert?: boolean }} [ded]
 */
export function monitorAlertShort(ev, ded) {
  if (ev.level === 'critical') {
    const f = ev.vitalFlags?.[0];
    if (f?.code === 'fever') return '発熱';
    if (f?.code === 'bp_sys_high') return '血圧↑';
    if (f?.code === 'bp_dia_low') return '血圧↓';
    if (ev.stoolBad) return '排便';
    if (ev.urineBad) return '排尿';
    return '異常';
  }
  if (ev.level === 'warn') {
    if (ev.patrolBad) return '巡視';
    return '注意';
  }
  if (ded?.hasAlert) return '要確認';
  return '';
}

/**
 * カード表示用の1行アラート（長文・減算説明は出さない）
 * @param {ReturnType<import('../services/ReportService.js').evaluateResidentMonitor>} rawEv
 * @param {{ hasAlert?: boolean }} ded
 */
export function formatCardMonitorAlertLine(rawEv, ded) {
  const parts = [];
  if (rawEv.vitalBad && rawEv.vitalFlags?.length) {
    const l = String(rawEv.vitalFlags[0]?.label ?? '').trim();
    parts.push(l.length > 20 ? l.split('（')[0].trim() : l);
  }
  if (rawEv.stoolBad && rawEv.stoolHours != null) {
    parts.push(`排便${Math.round(rawEv.stoolHours)}h`);
  }
  if (rawEv.urineBad && rawEv.urineHours != null) {
    parts.push(`排尿${Math.round(rawEv.urineHours)}h`);
  }
  if (rawEv.patrolBad && rawEv.level === 'warn') {
    parts.push('巡視間隔');
  }
  if (ded?.hasAlert && !parts.length) {
    parts.push(monitorAlertShort(rawEv, ded) || '要確認');
  }
  if (!parts.length) {
    const s = monitorAlertShort(rawEv, ded);
    if (s) parts.push(s);
  }
  return parts.filter(Boolean).join(' · ');
}
