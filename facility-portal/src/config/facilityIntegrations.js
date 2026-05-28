/**
 * 施設ごとの外部アプリ URL・面会予約用 Google カレンダー
 * キーは carelinkFacilities.js の linkKey と完全一致（スペース・表記ゆれ不可）
 *
 * 公式LINE: 各施設の LINE Official Account Manager → 友だち追加 URL を line に貼る。
 * 未設定の施設は VITE_LINK_LINE_DEFAULT（.env）を使います。
 *
 * Google カレンダー（面会予約）:
 * - **施設専用カレンダー**のみ（個人の「私のカレンダー」ID は使わない）
 * - LINE 面会予約と連携している **その施設用**のカレンダー ID（xxxx@group.calendar.google.com）
 * - 設定方法は (1) 下の googleCalendarId に直書き (2) .env の VITE_GOOGLE_CALENDAR_BY_FACILITY JSON
 * - カレンダー共有: 「リンクを知っている全員が閲覧可」（Sheets API キーで読み取り）
 */

/** @type {Record<string, { kaipoke?: string; mcs?: string; line?: string; googleCalendarId?: string }>} */
export const FACILITY_EXTERNAL_LINKS = {
  中川本館: {
    // line: 'https://line.me/R/ti/p/@xxxxxxxx',
    // googleCalendarId: '中川本館・面会予約用@group.calendar.google.com',
  },
  愛西: {
    // googleCalendarId: '愛西・面会予約用@group.calendar.google.com',
  },
  北名古屋: {
    // googleCalendarId: '北名古屋・面会予約用@group.calendar.google.com',
  },
  千音寺: {
    /** LINE 面会予約連携・施設専用（埋め込み URL の src から取得） */
    googleCalendarId:
      '76c28e428c38fe0588a9bca6a73959c40d02160b19d421dcb085be17e43b9bdf@group.calendar.google.com',
  },
  中村: {
    // googleCalendarId: '（中川系で使う場合のみ）',
  },
  起: {
    line: 'https://line.me/R/ti/p/@732wunij',
    // googleCalendarId: '青空起・面会予約用@group.calendar.google.com',
  },
  一宮: {
    // googleCalendarId: '青空一宮・面会予約用@group.calendar.google.com',
  },
};

function firstEnv(...keys) {
  for (const k of keys) {
    const v = import.meta.env[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** @type {Record<string, string> | null} */
let calendarByFacilityCache = null;

/** VITE_GOOGLE_CALENDAR_BY_FACILITY='{"中川本館":"xx@group.calendar.google.com"}' */
function googleCalendarByFacilityFromEnv() {
  if (calendarByFacilityCache) return calendarByFacilityCache;
  const raw = firstEnv('VITE_GOOGLE_CALENDAR_BY_FACILITY');
  if (!raw) {
    calendarByFacilityCache = {};
    return calendarByFacilityCache;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      calendarByFacilityCache = {};
      return calendarByFacilityCache;
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const id = String(v ?? '').trim();
      if (id) out[String(k).trim()] = id;
    }
    calendarByFacilityCache = out;
    return out;
  } catch {
    calendarByFacilityCache = {};
    return calendarByFacilityCache;
  }
}

const DEFAULTS = {
  kaipoke: firstEnv('VITE_LINK_KAIPOKE_DEFAULT'),
  mcs: firstEnv('VITE_LINK_MCS_DEFAULT'),
  line: firstEnv('VITE_LINK_LINE_DEFAULT'),
};

/**
 * @param {string} facilityName
 * @returns {{ kaipoke: string; mcs: string; line: string; label: string }}
 */
export function getExternalLinksForFacility(facilityName) {
  const name = String(facilityName ?? '').trim();
  const ov = name ? FACILITY_EXTERNAL_LINKS[name] : undefined;
  return {
    label: name || '施設未選択',
    kaipoke: ov?.kaipoke?.trim() || DEFAULTS.kaipoke || '#',
    mcs: ov?.mcs?.trim() || DEFAULTS.mcs || '#',
    line: ov?.line?.trim() || DEFAULTS.line || '#',
  };
}

/**
 * @param {string} facilityName
 * @returns {string}
 */
export function getGoogleCalendarIdForFacility(facilityName) {
  const name = String(facilityName ?? '').trim();
  if (!name) return '';
  const ov = FACILITY_EXTERNAL_LINKS[name];
  const perFacility = String(ov?.googleCalendarId ?? '').trim();
  if (perFacility) return perFacility;
  const fromJson = googleCalendarByFacilityFromEnv()[name];
  if (fromJson) return fromJson;
  /** 青空起のみ従来の単独 env（施設専用 ID を入れる。個人カレンダーは不可） */
  if (name === '起') {
    return firstEnv('VITE_GOOGLE_CALENDAR_ID_OKI', 'VITE_GOOGLE_CALENDAR_ID_起');
  }
  return '';
}

/** 面会予約用カレンダーがこの施設に紐づいているか */
export function hasGoogleCalendarForFacility(facilityName) {
  return Boolean(getGoogleCalendarIdForFacility(facilityName));
}
