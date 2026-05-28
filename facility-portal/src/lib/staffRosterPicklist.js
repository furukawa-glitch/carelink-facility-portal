import { linkKeyFromTabLabelOrAlias } from '../config/carelinkFacilities.js';
import { getEffectiveStaffRosterForFacility } from '../services/NearMissLedgerService.js';

function normCompact(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s/g, '');
}

/**
 * 部署名のゆらぎ（訪看/訪問看護、訪介/訪問介護、デイ/デイサービス等）を吸収
 * @param {string} s
 */
function deptAliasSet(s) {
  const base = normCompact(s);
  if (!base) return new Set();
  /** @type {Set<string>} */
  const out = new Set([base]);
  if (base.includes('訪問看護') || base.includes('訪看') || base.includes('看護')) {
    out.add('訪問看護');
    out.add('訪看');
    out.add('看護');
  }
  if (base.includes('訪問介護') || base.includes('訪介') || base.includes('介護')) {
    out.add('訪問介護');
    out.add('訪介');
    out.add('介護');
  }
  if (base.includes('デイサービス') || base.includes('デイ')) {
    out.add('デイサービス');
    out.add('デイ');
  }
  if (base.includes('有料')) out.add('有料');
  return out;
}

/**
 * HR タグ由来の部署名と、報告書の「所属」プルダウン値が一致するか（部分一致を許容）
 * @param {string} rowDept 名簿行の department（空ならフィルタしない）
 * @param {string} reporterDept 報告の所属（空なら全員）
 */
export function rosterDepartmentMatchesReporterDept(rowDept, reporterDept) {
  const want = String(reporterDept ?? '').trim();
  const have = String(rowDept ?? '').trim();
  if (!want) return true;
  if (!have) return true;
  if (have === want) return true;
  const h = normCompact(have);
  const w = normCompact(want);
  if (h.includes(w) || w.includes(h)) return true;
  const hs = deptAliasSet(h);
  const ws = deptAliasSet(w);
  for (const a of ws) {
    for (const b of hs) {
      if (!a || !b) continue;
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

/**
 * 施設タブ名・報告の所属に合うスタッフ氏名（重複除去・五十音順）
 * @param {string} facilityTabLabel RecordPage の tabLabel 等
 * @param {string} reporterDept 部署プルダウン値または手入力
 * @returns {string[]}
 */
export function getReporterStaffNameOptionsForFacilityDept(facilityTabLabel, reporterDept) {
  const lk = linkKeyFromTabLabelOrAlias(facilityTabLabel);
  if (!lk) return [];
  const rows = getEffectiveStaffRosterForFacility(lk);
  const dept = String(reporterDept ?? '').trim();
  let filtered = dept
    ? rows.filter((r) => rosterDepartmentMatchesReporterDept(String(r?.department ?? ''), dept))
    : rows;
  // 部署の表記ゆれや列崩れで 0 件になった場合は、施設全体の候補を表示して入力不能を避ける
  if (dept && filtered.length === 0) filtered = rows;
  const names = [...new Set(filtered.map((r) => String(r?.name ?? '').trim()).filter(Boolean))];
  names.sort((a, b) => a.localeCompare(b, 'ja'));
  return names;
}
