const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars';

function toDateYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimeFromIso(iso) {
  const d = new Date(String(iso ?? ''));
  if (!Number.isFinite(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** LINE 面会予約・Google 予約枠などのタイトルから「今週の予定」の種別を推定 */
export function classifyCalendarEventPlanType(title, description = '') {
  const blob = `${String(title ?? '')} ${String(description ?? '')}`;
  if (/面会|来訪|見学|面談|訪問者|お見舞|面接/i.test(blob)) return '面会';
  if (/受診|通院|病院|診察/i.test(blob)) return '受診';
  if (/外泊|入院|退院/i.test(blob)) return '外泊';
  if (/外出|お出かけ/i.test(blob)) return '外出';
  if (/LINE|予約|予定|面会予約/i.test(blob)) return '面会';
  return '予定';
}

/**
 * Google Calendar から指定日数の予定を取得（公開/閲覧可能カレンダー向け）
 * @param {{ apiKey: string; calendarId: string; days?: number }} p
 */
export async function fetchFacilityCalendarEvents(p) {
  const key = String(p?.apiKey ?? '').trim();
  const calendarId = String(p?.calendarId ?? '').trim();
  const days = Math.max(1, Math.min(31, Number(p?.days ?? 7) || 7));
  if (!key || !calendarId) return [];

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  const url =
    `${GOOGLE_CALENDAR_API}/${encodeURIComponent(calendarId)}/events` +
    `?key=${encodeURIComponent(key)}` +
    `&singleEvents=true&orderBy=startTime` +
    `&timeMin=${encodeURIComponent(start.toISOString())}` +
    `&timeMax=${encodeURIComponent(end.toISOString())}`;

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return [];
  const items = Array.isArray(data?.items) ? data.items : [];

  return items
    .map((it) => {
      const startDateTime = String(it?.start?.dateTime ?? '').trim();
      const startDate = String(it?.start?.date ?? '').trim();
      const ymd = startDate || (startDateTime ? toDateYmd(new Date(startDateTime)) : '');
      if (!ymd) return null;
      const time = startDate ? '' : formatTimeFromIso(startDateTime);
      const title = String(it?.summary ?? '').trim() || '予定';
      const description = String(it?.description ?? '').trim();
      return {
        id: String(it?.id ?? `${ymd}-${title}`),
        ymd,
        time,
        title,
        description,
        type: classifyCalendarEventPlanType(title, description),
        source: 'google_calendar',
      };
    })
    .filter(Boolean);
}
