/**
 * Notion の利用者DB（新規入居・指示書等）から主治医情報を氏名照合で取得
 */

import {
  fetchNotionDatabaseById,
  fetchNotionDatabasePropertyNames,
  hasNotionNewResidentsConfig,
  hasNotionResidentInstructionsConfig,
} from './notionNewResidentsService.js';
import { personNameMatchKey, normalizePersonNameForMatch } from '../lib/residentNameMatch.js';

const DOCTOR_FIELD_KEYS = Object.freeze([
  '主治医',
  '主治医氏名',
  '主治医名',
  '担当医',
  '担当医師',
  'かかりつけ医',
  '在宅医',
  '在宅医師',
  '医師名',
  '医師',
]);

const AGENCY_FIELD_KEYS = Object.freeze([
  '医療機関',
  '医療機関名',
  'クリニック',
  'クリニック名',
  'かかりつけ医療機関',
  '病院名',
  '病院',
  '診療所',
]);

const ADDRESS_FIELD_KEYS = Object.freeze([
  '医療機関住所',
  'クリニック住所',
  '医療機関所在地',
]);

/** @param {string[]} propNames @param {readonly string[]} keys */
function dbHasPropertyLike(propNames, keys) {
  return propNames.some((prop) => keys.some((k) => prop === k || prop.includes(k)));
}

/** @param {Record<string, string>} fields @param {string[]} keys */
function pickField(fields, keys) {
  for (const k of keys) {
    const v = String(fields[k] ?? '').trim();
    if (v) return v;
  }
  for (const [prop, val] of Object.entries(fields)) {
    const v = String(val ?? '').trim();
    if (!v) continue;
    for (const k of keys) {
      if (prop.includes(k)) return v;
    }
  }
  return '';
}

/**
 * @param {{ name: string; fields: Record<string, string> }[]} rows
 * @param {string} residentName
 */
function findNotionRowByResidentName(rows, residentName) {
  const targetKey = personNameMatchKey(residentName);
  if (!targetKey) return null;
  for (const row of rows) {
    const rowKey = personNameMatchKey(row.name);
    if (!rowKey) continue;
    if (rowKey === targetKey) return row;
    if (rowKey.includes(targetKey) || targetKey.includes(rowKey)) return row;
  }
  return null;
}

/**
 * @param {string} notionName
 * @param {string[]} filledFieldNames
 * @param {string[]} dbPropNames
 */
function buildEmptyDoctorFieldsMessage(notionName, filledFieldNames, dbPropNames) {
  const hasDoctorCol = dbHasPropertyLike(dbPropNames, DOCTOR_FIELD_KEYS);
  const hasAgencyCol = dbHasPropertyLike(dbPropNames, AGENCY_FIELD_KEYS);
  const lines = [`Notionで「${notionName}」は見つかりましたが、主治医・医療機関を読み取れません。`];
  if (!hasDoctorCol || !hasAgencyCol) {
    lines.push('Notion DB に次の列を追加してください（種類は「テキスト」）：');
    if (!hasDoctorCol) lines.push('・主治医');
    if (!hasAgencyCol) lines.push('・医療機関名');
    if (!dbHasPropertyLike(dbPropNames, ADDRESS_FIELD_KEYS)) lines.push('・医療機関住所（任意）');
    lines.push('追加後、各入居者ページに値を入力してください。');
  } else {
    lines.push('「主治医」「医療機関名」列はありますが、未入力です。Notionで該当欄に入力してください。');
  }
  if (filledFieldNames.length) {
    lines.push(`（この方で入力済みの列: ${filledFieldNames.join('、')}）`);
  }
  return lines.join(' ');
}

/**
 * @param {string} residentName
 * @returns {Promise<
 *   | { ok: true; primaryDoctor: string; medicalAgency: string; medicalAddress: string; notionUrl: string; sourceDb: string; notionName: string }
 *   | { ok: false; reason: 'not_configured' | 'not_found' | 'empty_fields' | 'api_error'; message: string; notionName?: string; notionUrl?: string; fieldNames?: string[] }
 * >}
 */
export async function lookupResidentDoctorFromNotion(residentName) {
  const name = String(residentName ?? '').trim();
  if (!name) {
    return { ok: false, reason: 'not_found', message: '利用者名が空です。' };
  }

  /** @type {string[]} */
  const dbIds = [];
  const instructionsId = String(import.meta.env.VITE_NOTION_RESIDENT_INSTRUCTIONS_DATABASE_ID ?? '').trim();
  const newResidentsId = String(import.meta.env.VITE_NOTION_NEW_RESIDENTS_DATABASE_ID ?? '').trim();
  if (instructionsId) dbIds.push(instructionsId);
  if (newResidentsId && newResidentsId !== instructionsId) dbIds.push(newResidentsId);
  if (!dbIds.length) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'VITE_NOTION_NEW_RESIDENTS_DATABASE_ID が未設定です。Vercel で設定後、再デプロイしてください。',
    };
  }

  /** @type {string} */
  let lastApiError = '';
  for (const dbId of dbIds) {
    try {
      const [{ rows }, dbPropNames] = await Promise.all([
        fetchNotionDatabaseById(dbId),
        fetchNotionDatabasePropertyNames(dbId).catch(() => []),
      ]);
      const hit = findNotionRowByResidentName(rows, name);
      if (!hit) continue;
      const primaryDoctor = pickField(hit.fields, [...DOCTOR_FIELD_KEYS]);
      const medicalAgency = pickField(hit.fields, [...AGENCY_FIELD_KEYS]);
      const medicalAddress = pickField(hit.fields, [...ADDRESS_FIELD_KEYS]);
      if (!primaryDoctor && !medicalAgency && !medicalAddress) {
        const fieldNames = Object.entries(hit.fields)
          .filter(([, v]) => String(v ?? '').trim())
          .map(([k]) => k)
          .slice(0, 16);
        return {
          ok: false,
          reason: 'empty_fields',
          message: buildEmptyDoctorFieldsMessage(hit.name, fieldNames, dbPropNames),
          notionName: hit.name,
          notionUrl: String(hit.url ?? ''),
          fieldNames,
        };
      }
      return {
        ok: true,
        primaryDoctor,
        medicalAgency,
        medicalAddress,
        notionUrl: String(hit.url ?? ''),
        sourceDb: dbId,
        notionName: hit.name,
      };
    } catch (e) {
      lastApiError = e instanceof Error ? e.message : 'Notion API エラー';
    }
  }

  const norm = normalizePersonNameForMatch(name);
  return {
    ok: false,
    reason: lastApiError ? 'api_error' : 'not_found',
    message: lastApiError
      ? `Notion API エラー: ${lastApiError}（トークン・DB接続・再デプロイを確認）`
      : `Notion DB に「${norm || name}」が見つかりません。タイトル列の氏名が名簿と一致しているか確認してください。`,
  };
}

export function hasNotionDoctorLookupConfig() {
  return hasNotionResidentInstructionsConfig() || hasNotionNewResidentsConfig();
}
