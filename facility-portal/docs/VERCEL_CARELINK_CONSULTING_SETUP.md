# ケアリンク介護コンサル用 Vercel プロジェクト — セットアップ手順

**対象:** 合同会社 CareLink（ケアリンク）の介護コンサル 5 拠点向けアプリ。  
**初回施設:** ふれあいの里（有料老人ホーム・2026年7月オープン予定）  
**将来追加:** 泉、ハート津島、小牧、瀬戸（同じ `ledgerCompanyTag=ケアリンク` で 1 デプロイにまとめ可能）

ケアサポート・ブレインエナジーと **同じ Git リポジトリ・main ブランチ** を接続し、**環境変数だけ差し替え**ます。

---

## 1. Vercel で新プロジェクトを作る

1. [vercel.com](https://vercel.com) → **Add New… → Project**
2. GitHub リポジトリ **`CareLink_AI`**（または `carelink-facility-portal`）を選択
3. **Root Directory** → `facility-portal` に設定（重要）
4. Framework: **Vite**
5. プロジェクト名の例: `carelink-consulting` または `fureai-no-sato-portal`
6. デプロイ成功後、URL 例: `https://carelink-consulting.vercel.app`

---

## 2. 環境変数（必須）

### A. テナント分離（新規）

| 変数名 | 値 | 備考 |
|--------|-----|------|
| `VITE_CARELINK_LEDGER_COMPANY_TAG` | `ケアリンク` | **ふれあいの里のみ**表示（将来5拠点追加時も同タグ） |
| `VITE_CARELINK_ORGANIZATION_ID` | Supabase `organizations` に新規作成した UUID | ケアサポート・ブレインと**別** |
| `CARELINK_ORGANIZATION_ID` | 上と同じ UUID | 任意 |
| `VITE_CARE_SYNC_SECRET` | 新しい長いランダム文字列 | 他社と共有しない |
| `CARE_SYNC_SECRET` | 上と同じ | Vercel サーバ用 |

### B. Supabase（ケアサポートからコピー可）

| 変数名 | 備考 |
|--------|------|
| `VITE_SUPABASE_URL` | 同じ Supabase プロジェクトでよい |
| `VITE_SUPABASE_ANON_KEY` | 同上 |
| `SUPABASE_SERVICE_ROLE_KEY` | 同上 |

**Supabase SQL（組織追加）:**

```sql
insert into public.organizations (id, name, slug)
values (
  'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',  -- Vercel の VITE_CARELINK_ORGANIZATION_ID と一致
  'ケアリンク介護コンサル',
  'carelink-consulting'
)
on conflict (id) do nothing;
```

### C. 名簿スプレッドシート

| 変数名 | 備考 |
|--------|------|
| `VITE_GOOGLE_SHEET_ID` | ふれあいの里名簿ブックの ID |
| `VITE_GOOGLE_SHEETS_API_KEY` | Sheets API キー（ケアサポートからコピー可） |
| `VITE_GEMINI_API_KEY` | AI 機能（任意・ケアサポートからコピー可） |

スプレッドシートにタブ **`ふれあいの里：入居者`** を追加（`carelinkFacilities.js` の `sheetTitle` と完全一致）。

### D. 任意

| 変数名 | 備考 |
|--------|------|
| `VITE_FACILITY_PORTAL_PASSWORD` | 現場共有パスワード（**職員ログイン有効時は未設定**） |
| `VITE_STAFF_LOGIN_ENABLED` | **`1`**（職員コードログイン） |
| `VITE_STAFF_IDLE_LOCK_MS` | `300000`（5分無操作でログアウト） |
| `STAFF_SESSION_SECRET` | セッション署名（`CARE_SYNC_SECRET` と同じでも可） |
| `STAFF_BOOTSTRAP_SECRET` | 初回管理者登録用（1回限り） |
| `VITE_NEAR_MISS_APPS_SCRIPT_URL` | ヒヤリ GAS（コンサル用に別デプロイする場合） |
| `VITE_AWARENESS_SPREADSHEET_ID` | 周知・台帳シート |

---

## 3. ふれあいの里の運用メモ

- **看護師常駐なし:** `onSiteNursing: false` により往診カレンダー PDF・訪看特別 UI は自動非表示
- **スタッフプロフィールの「看護事務モード」** も OFF のまま運用
- **定員・住所** が確定したら `carelinkFacilities.js` の `licensedBeds` / `emergencySenderAddress` を追記
- **名簿列** が B 列以外の場合は `nameColumn0Based` を調整

---

## 4. デプロイ後の確認

- [ ] 施設タブに **ふれあいの里** のみ表示される（他社施設が出ない）
- [ ] 「スプレッドシートから取り込み」で名簿が読める
- [ ] 生活記録のクラウド同期（2台の PC でテスト）
- [ ] 往診カレンダー PDF ボタンが **表示されない**
- [ ] 食事・巡視・申し送りが記録できる

---

## 5. 関連ドキュメント

- `docs/FUREAI_NO_SATO_ROADMAP.md` — 機能一覧・フェーズ計画
- `docs/VERCEL_NEW_TENANT_CHECKLIST.md` — 新テナント共通チェックリスト
- `docs/VERCEL_BRAIN_ENERGY_SETUP.md` — ブレインエナジー側の参考例
