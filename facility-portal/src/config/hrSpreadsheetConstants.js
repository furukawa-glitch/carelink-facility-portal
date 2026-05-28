/**
 * 求人・入退社・スタッフ名簿（1 スプレッドシートで運用）
 * 既定: R8.3.25 職員名簿（按分シート例 gid=401741715）。別ブックなら VITE_HR_SPREADSHEET_ID で上書き。
 */

/** @see https://docs.google.com/spreadsheets/d/1yL-9qAxJadWuYvqOTFC8w7eXVHPvTay4/edit?gid=401741715 */
export const DEFAULT_HR_SPREADSHEET_ID = '1yL-9qAxJadWuYvqOTFC8w7eXVHPvTay4';
/** 職員名簿の既定タブ（按分Sheet2） */
export const DEFAULT_HR_STAFF_SHEET_GID = '401741715';

/** @see https://docs.google.com/spreadsheets/d/1iCVPq0-9JeK11mc3-d-YF9nOIAJq12_4A5vtxVnYbjY */
export const DEFAULT_AWARENESS_SPREADSHEET_ID = '1iCVPq0-9JeK11mc3-d-YF9nOIAJq12_4A5vtxVnYbjY';

/** 周知確認ログの追記先（ヒヤリハット/事故を共通管理） */
export const AWARENESS_LOG_SHEET_NAME = '周知確認ログ';

export const AWARENESS_LOG_COLS = Object.freeze([
  '日時',
  '種別',
  'タイトル',
  '名前',
  '部署',
  '施設',
]);
