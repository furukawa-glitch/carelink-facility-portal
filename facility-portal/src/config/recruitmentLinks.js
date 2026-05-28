/**
 * 施設別の AirWORK / タイミー 掲載ページ（ベースURL）。空のときはデモ用検索へ。
 * ここに直書きするか、.env の VITE_RECRUITMENT_JSON を {"愛西":{"airwork":"...","timy":"..."}} 形式で指定。
 */

import { CARELINK_FACILITIES } from './carelinkFacilities.js';

/** 設定画面「採用ステータス」に出す拠点（linkKey と carelinkFacilities 一致） */
export const RECRUITMENT_STATUS_LINK_KEYS = Object.freeze(['愛西', '北名古屋', '千音寺', '起', '一宮']);

/** 職種ごとの行（介護・看護・一般） */
export const RECRUITMENT_ROLE_OPTIONS = Object.freeze(['介護職', '看護職', '一般職']);

/** @param {string} linkKey @param {string} role */
export function recruitmentRowKey(linkKey, role) {
  return `${String(linkKey)}::${String(role)}`;
}

/** 採用テーブル用の施設一覧（上記キー順） */
export function getRecruitmentStatusFacilities() {
  const map = new Map(CARELINK_FACILITIES.map((f) => [f.linkKey, f]));
  return RECRUITMENT_STATUS_LINK_KEYS.map((k) => map.get(k)).filter(Boolean);
}

function parseRecruitmentJson() {
  const raw = import.meta.env.VITE_RECRUITMENT_JSON;
  if (!raw || !String(raw).trim()) return {};
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

const FROM_ENV = parseRecruitmentJson();

/** @type {Record<string, { airwork?: string; timy?: string }>} コード側デフォルト（必要に応じ追記） */
export const FACILITY_RECRUITMENT_URLS = {
  ...FROM_ENV,
};

/**
 * @param {'airwork'|'timy'} portal
 * @param {string} linkKey
 * @param {{ role?: string; hourly?: string; headcount?: string }} q
 */
export function buildRecruitmentJumpUrl(portal, linkKey, q) {
  const pack = FACILITY_RECRUITMENT_URLS[linkKey] || {};
  const base = portal === 'airwork' ? pack.airwork : pack.timy;
  if (!base || !String(base).trim()) {
    const demo = new URL('https://www.google.com/search');
    demo.searchParams.set(
      'q',
      `介護施設 求人 ${linkKey} ${portal === 'airwork' ? 'AirWORK' : 'タイミー'} ${q.role ?? ''} 時給${q.hourly ?? ''} 募集${q.headcount ?? ''}名`
    );
    return demo.toString();
  }
  try {
    const u = new URL(base);
    if (q.role) u.searchParams.set('job', q.role);
    if (q.hourly) u.searchParams.set('wage', q.hourly);
    if (q.headcount) u.searchParams.set('need', q.headcount);
    return u.toString();
  } catch {
    return base;
  }
}
