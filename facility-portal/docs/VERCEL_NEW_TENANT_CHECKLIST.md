# 新規テナント（新しい会社）追加チェックリスト — 方式A（デプロイ分離）

会社ごとに **別の Vercel プロジェクト** を作成し、同じ Git リポジトリを接続して環境変数だけ差し替える手順です。コードは共通のままです。

---

## 1. Vercel 側

- [ ] Vercel で **新しい Project** を作成する（既存プロジェクトの複製でも可）。
- [ ] **Git リポジトリ**とブランチ（本番用ブランチ）を接続する。
- [ ] **Root Directory** を `facility-portal` に設定する（モノレポの場合。既に設定済みならそのまま）。
- [ ] **Framework Preset** が Vite として認識されていることを確認する。
- [ ] 本番ドメイン（カスタムドメイン）を割り当て、DNS を設定する。

---

## 2. 環境変数（この会社用の値）

`facility-portal/.env.example` の **セクション A（テナント固有）** を中心に、Vercel の **Settings → Environment Variables** に登録する。開発用ローカルでは `.env.local` に同様のキーを書く。

### 2.1 必ずこの会社用に揃えるもの（典型）

- [ ] **利用者名簿** — `VITE_GOOGLE_SHEET_ID` / `VITE_GOOGLE_SHEET_GID`（必要なら `VITE_CSV_DEFAULT_SHEET_TITLE`）。
- [ ] **部署別売上・経営シート** — `VITE_DEPARTMENT_SALES_SHEET_ID` 等、運用しているブック ID・タブ。
- [ ] **HR・求人スプレッドシート** — `VITE_HR_SPREADSHEET_ID`（シフト・名簿連携を使う場合）。
- [ ] **ヒヤリ GAS** — `VITE_NEAR_MISS_APPS_SCRIPT_URL`（この会社用にデプロイした Web アプリの URL）。
- [ ] **ヒヤリ中継用シークレット** — 本番では **`NEAR_MISS_APP_SECRET`** を Vercel に設定し、GAS 内の `APP_SECRET` と **完全一致**させる（`api/near-miss-gas.js` が参照）。
- [ ] **周知・台帳用シート** — `VITE_AWARENESS_SPREADSHEET_ID` 等、運用している場合。

### 2.2 機能を使う場合のみ

- [ ] **Notion 新規入居** — `VITE_NOTION_INTEGRATION_TOKEN` / `VITE_NOTION_NEW_RESIDENTS_DATABASE_ID`。
- [ ] **RecordPage のデフォルト外部リンク** — `VITE_LINK_KAIPOKE_DEFAULT` / `VITE_LINK_MCS_DEFAULT` / `VITE_LINK_LINE_DEFAULT`。
- [ ] **採用リンク JSON** — `VITE_RECRUITMENT_JSON`。

### 2.3 共通キーでも会社別キーでもよいもの（セクション B）

- [ ] **`VITE_GEMINI_API_KEY`** — AI 機能有効化に必要。
- [ ] **`VITE_GOOGLE_SHEETS_API_KEY`** — Sheets API 経由の読み取りに必要な画面がある場合。

---

## 3. Google / Notion / GAS 側（権限とデプロイ）

- [ ] **スプレッドシート** — サービス利用に必要な Google アカウント／API キーから、該当ブックが **読める（必要なら書ける）** 状態か確認する。
- [ ] **GAS** — この会社用のスクリプトをデプロイし **Web アプリ** URL を環境変数に反映した。`APP_SECRET` と Vercel の `NEAR_MISS_APP_SECRET` が一致している。
- [ ] **GAS「報告」シートの1行目** — 見出しはアプリと同じ **日本語**にする（`ensureReportHeader_` の配列を `src/config/nearMissLedgerConstants.js` の `REPORT_SHEET_HEADERS` と一致させる。英語の `recordId` 等のままだと表が英語に見える）。既存シートは **1行目だけ手編集**で置き換え可（データ行は触らない）。
- [ ] **Notion** — インテグレーションを対象 DB に **接続**し、データベース ID が正しい。

---

## 4. アプリ内の静的設定（コード・リポジトリ）

環境変数だけでは足りないリンクは `src/config/facilityIntegrations.js` 等で **施設別**に持っている場合があります。

- [ ] 新会社の **施設一覧・外部 URL** を `FACILITY_EXTERNAL_LINKS`（または該当 config）に追加・更新した。
- [ ] 会社ごとに **リポジトリを分けない**運用なら、**全テナントの施設が 1 ファイルに載る**ことになるため、ブランチ戦略・デプロイ先（どの Vercel がどのコミットか）をチームで合意しておく。

---

## 5. ビルド・動作確認

- [ ] Vercel で **デプロイが成功**する。
- [ ] 名簿・売上・ヒヤリ報告（GAS 経由）・Notion など、**実際に使う機能を本番 URL で一通り確認**する。
- [ ] ブラウザの開発者ツールで、想定外の **401 / CORS / GAS unauthorized** が出ていないか確認する（シークレット不一致は再デプロイ後もキャッシュに注意）。

---

## 6. 運用メモ（任意）

- [ ] 社内用に「この Vercel プロジェクト名・ドメイン・担当者・Notion/GAS の所有者」をドキュメント化する。
- [ ] 親フォルダ `CareLink_AI/.env` を併用している場合、**どのマシン／CI で親を読むか**を明文化する（ローカルでは `facility-portal/.env.local` に寄せると分かりやすい）。

---

## 参照

- 環境変数の一覧と説明: `facility-portal/.env.example`
- GAS 中継: `facility-portal/api/near-miss-gas.js`
- 親ディレクトリとの env マージ: `facility-portal/vite.config.js`
