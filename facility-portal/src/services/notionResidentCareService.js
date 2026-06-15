/**
 * Notion の利用者DB（新規入居・指示書等）から主治医情報を氏名照合で取得
 */

import {
  fetchNotionDatabaseById,
  hasNotionNewResidentsConfig,
  hasNotionResidentInstructionsConfig,
} from './notionNewResidentsService.js';
import { personNameMatchKey, normalizePersonNameForMatch } from '../lib/residentNameMatch.js';

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
  const norm = normalizePersonNameForMatch(residentName);
  for (const row of rows) {
    for (const val of Object.values(row.fields ?? {})) {
      const v = normalizePersonNameForMatch(val);
      if (v && v.includes(norm) && norm.length >= 2) return row;
    }
  }
  return null;
}

/**
 * @param {string} residentName
 * @returns {Promise<{ primaryDoctor: string; medicalAgency: string; medicalAddress: string; notionUrl: string; sourceDb: string } | null>}
 */
export async function lookupResidentDoctorFromNotion(residentName) {
  const name = String(residentName ?? '').trim();
  if (!name) return null;

  /** @type {string[]} */
  const dbIds = [];
  const instructionsId = String(import.meta.env.VITE_NOTION_RESIDENT_INSTRUCTIONS_DATABASE_ID ?? '').trim();
  const newResidentsId = String(import.meta.env.VITE_NOTION_NEW_RESIDENTS_DATABASE_ID ?? '').trim();
  if (instructionsId) dbIds.push(instructionsId);
  if (newResidentsId && newResidentsId !== instructionsId) dbIds.push(newResidentsId);
  if (!dbIds.length) return null;

  for (const dbId of dbIds) {
    try {
      const { rows } = await fetchNotionDatabaseById(dbId);
      const hit = findNotionRowByResidentName(rows, name);
      if (!hit) continue;
      const primaryDoctor = pickField(hit.fields, [
        '主治医',
        '主治医氏名',
        '担当医',
        'かかりつけ医',
        '在宅医',
        '医師名',
      ]);
      const medicalAgency = pickField(hit.fields, [
        '医療機関',
        '医療機関名',
        'クリニック',
        'かかりつけ医療機関',
        '病院名',
        '診療所',
      ]);
      const medicalAddress = pickField(hit.fields, [
        '医療機関住所',
        'クリニック住所',
        '住所',
        '医療機関所在地',
      ]);
      if (!primaryDoctor && !medicalAgency && !medicalAddress) continue;
      return {
        primaryDoctor,
        medicalAgency,
        medicalAddress,
        notionUrl: String(hit.url ?? ''),
        sourceDb: dbId,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function hasNotionDoctorLookupConfig() {
  return hasNotionResidentInstructionsConfig() || hasNotionNewResidentsConfig();
}
