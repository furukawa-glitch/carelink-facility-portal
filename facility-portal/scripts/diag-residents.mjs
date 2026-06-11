/**
 * 名簿タブごとの読込診断（node scripts/diag-residents.mjs）
 * Vercel プロキシ経由（APIキー不要）
 */
import { createServer } from 'vite';

const PROXY = 'https://carelink-facility-portal.vercel.app/api/sheets-proxy';
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('sheets.googleapis.com')) {
    const u = new URL(url);
    return nativeFetch(`${PROXY}${u.pathname}${u.search}`, init);
  }
  return nativeFetch(input, init);
};

const vite = await createServer({
  configFile: 'vite.config.js',
  server: { middlewareMode: true },
  mode: 'production',
});

const mod = await vite.ssrLoadModule('/src/services/GoogleSheetService.js');
const { CARELINK_FACILITIES, residentBelongsToFacilityTab } = await vite.ssrLoadModule(
  '/src/config/carelinkFacilities.js'
);

const residents = await mod.fetchResidentsAllTabs('via-proxy');
const sources = new Set(residents.map((r) => String(r.sourceSheetTitle ?? '').trim()).filter(Boolean));
console.log('total parsed', residents.length, 'unique sources', sources.size);

for (const def of CARELINK_FACILITIES) {
  const matched = residents.filter((r) => residentBelongsToFacilityTab(r, def.sheetTitle));
  const bySource = residents.filter((r) => String(r.sourceSheetTitle) === def.sheetTitle);
  console.log(`\n--- ${def.tabLabel}`);
  console.log('bySource', bySource.length, 'matched', matched.length);
  if (bySource.length !== matched.length) {
    console.log(
      'facility col samples',
      bySource.slice(0, 4).map((r) => `${r.name}=>${r.facility}`).join(' | ')
    );
  }
  console.log('sample', matched.slice(0, 6).map((r) => `${r.room}:${r.name}`).join(' | '));
}

await vite.close();
