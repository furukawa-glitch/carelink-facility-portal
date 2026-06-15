# ブレインエナジー用 Vercel プロジェクト — セットアップ手順

**現状:** ブレインエナジー専用の Vercel プロジェクトは **未作成** です。  
ケアサポート用（`carelink-facility-portal.vercel.app`）と **同じ Git リポジトリ・main ブランチ** を接続し、**環境変数だけ差し替え**ます。

コードを `main` に push すると **両方の Vercel が自動デプロイ** されます（共通コード・会社別データ）。

---

## 1. Vercel で新プロジェクトを作る（10分）

1. [vercel.com](https://vercel.com) → **Add New… → Project**
2. GitHub リポジトリ **`carelink-facility-portal`**（または `CareLink_AI` のうち facility-portal を含むリポ）を選択
3. **Root Directory** → `facility-portal` に設定（重要）
4. Framework: **Vite**（自動検出でOK）
5. プロジェクト名の例: `carelink-brain-energy` または `aozora-facility-portal`
6. **Environment Variables はいったん空で Deploy** してもよいが、本番運用前に下記 §2 をすべて入れる
7. デプロイ成功後、URL 例: `https://carelink-brain-energy.vercel.app`  
   → 必要ならカスタムドメイン（`nursing-aozora.com` 配下など）を **Settings → Domains** で追加

---

## 2. 環境変数コピー用リスト

### 手順

1. Vercel → **既存プロジェクト（ケアサポート）** → Settings → Environment Variables
2. 下表の「ケアサポートからコピー」列が **コピー** のものは **同じ値** をブレインエナジー側にも貼る（API キー共有でよいもの）
3. **新規** のものはブレインエナジー専用の値を入れる（**絶対にケアサポートと同じにしない**もの）
4. Environment は **Production**（必要なら Preview / Development も同様）
5. 保存後 **Redeploy**

### 凡例

| 記号 | 意味 |
|------|------|
| **新規** | ブレインエナジー専用。ケアサポートの値をそのまま使わない |
| **コピー** | 既存 Vercel と同じ値でよい（Gemini / Sheets API キー等） |
| **要確認** | 青空系のブック・GAS・Notion があるか確認してから設定 |
| **任意** | 使わない機能なら未設定でよい |

---

### A. テナント分離（必須・新規）

| 変数名 | ブレインエナジー側の値 | ケアサポートから |
|--------|------------------------|------------------|
| `VITE_CARELINK_LEDGER_COMPANY_TAG` | `ブレインエナジー` | **新規**（ケアサポートは `ケアサポート`） |
| `VITE_CARELINK_ORGANIZATION_ID` | Supabase `organizations` に **ブレインエナジー用に新規作成した UUID** | **新規** |
| `CARELINK_ORGANIZATION_ID` | 上と同じ UUID | **新規** |
| `VITE_CARE_SYNC_SECRET` | 新しい長いランダム文字列 | **新規** |
| `CARE_SYNC_SECRET` | 上と同じ | **新規** |

表示施設: **青空一宮・青空起** のみ（コード側で `ledgerCompanyTag` により自動フィルタ）。

---

### B. Supabase（必須）

| 変数名 | ブレインエナジー側 | ケアサポートから |
|--------|-------------------|------------------|
| `VITE_SUPABASE_URL` | 同じ Supabase プロジェクト URL でよい | **コピー**（1プロジェクト多テナント） |
| `VITE_SUPABASE_ANON_KEY` | 同上 | **コピー** |
| `SUPABASE_SERVICE_ROLE_KEY` | 同上 | **コピー** |

**Supabase でやること（Dashboard → SQL Editor）:**

```sql
-- ブレインエナジー組織を追加（UUID は Vercel の VITE_CARELINK_ORGANIZATION_ID と一致させる）
insert into public.organizations (id, name, slug)
values (
  'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',  -- 新規 UUID（gen_random_uuid() でも可）
  'ブレインエナジー',
  'brain-energy'
)
on conflict (id) do nothing;
```

マイグレーション未適用なら `supabase/migrations/` の SQL を先に実行（`care_events`, `residents` の `legacy_row_key` 等）。

---

### C. 利用者名簿スプレッドシート（必須・要確認）

| 変数名 | ブレインエナジー側 | ケアサポートから |
|--------|-------------------|------------------|
| `VITE_GOOGLE_SHEET_ID` | 青空一宮・青空起のタブがある **同じ名簿ブック** なら同じ ID | **要確認**（多くの場合 **コピー** で同じブック） |
| `VITE_GOOGLE_SHEET_GID` | 先頭タブの gid（全タブ読む実装なら任意） | **要確認** |
| `VITE_GOOGLE_SHEETS_API_KEY` | Sheets 読取キー | **コピー** |
| `VITE_RESIDENTS_SOURCE` | 空（ハイブリッド）または `sheet_only` | **コピー** または未設定 |

名簿ブックが **ケアサポートと共通** でも、`VITE_CARELINK_LEDGER_COMPANY_TAG=ブレインエナジー` により **青空2施設だけ** 読み込み・表示されます。

---

### D. 生活記録・クラウド同期の有効化

| 変数名 | 備考 | ケアサポートから |
|--------|------|------------------|
| `VITE_CARE_CLOUD_SYNC` | 未設定で自動ON（`0` でのみ停止） | **コピー** |
| 上記 A + B が揃えば同期可能 | | |

---

### E. AI・共通 API（推奨）

| 変数名 | ケアサポートから |
|--------|------------------|
| `VITE_GEMINI_API_KEY` | **コピー** |

---

### F. ヒヤリハット・事故台帳（要確認）

| 変数名 | ブレインエナジー側 | ケアサポートから |
|--------|-------------------|------------------|
| `VITE_NEAR_MISS_APPS_SCRIPT_URL` | ブレインエナジー用 GAS Web アプリ URL | **新規**（別 GAS 推奨） |
| `NEAR_MISS_APP_SECRET` | GAS 内 `APP_SECRET` と一致 | **新規** |
| `VITE_AWARENESS_SPREADSHEET_ID` | 周知・台帳シート ID | **要確認** |
| `VITE_NEAR_MISS_LEDGER_SPREADSHEET_ID` | レガシー名 | **要確認** |

台帳を **会社別シート** に分ける場合は ID を新規。共通ブックならカテゴリ列に `ブレインエナジー` が付くので **コピー** も可。

---

### G. Notion・外部リンク（任意）

| 変数名 | 備考 | ケアサポートから |
|--------|------|------------------|
| `VITE_NOTION_INTEGRATION_TOKEN` | 青空用 Notion があれば | **要確認** |
| `VITE_NOTION_NEW_RESIDENTS_DATABASE_ID` | 同上 | **要確認** |
| `VITE_LINK_LINE_DEFAULT` | 青空起 LINE 等 | **要確認**（`facilityIntegrations.js` の `起.line` も参照） |
| `VITE_LINK_KAIPOKE_DEFAULT` / `VITE_LINK_MCS_DEFAULT` | 会社ポータル URL | **要確認** |

施設別 URL は `src/config/facilityIntegrations.js` の `起`・`一宮` を編集（リポジトリ共通・全デプロイに反映）。

---

### H. 経営・HR・売上（任意・多くはケアサポート専用）

| 変数名 | ブレインエナジー |
|--------|------------------|
| `VITE_DEPARTMENT_SALES_SHEET_ID` | 使わなければ未設定 |
| `VITE_MANAGEMENT_SPREADSHEET_ID` | 同上 |
| `VITE_HR_SPREADSHEET_ID` | 青空のシフトを使うなら要確認 |
| `VITE_ENTERAL_MENU_SPREADSHEET_ID` | 経管メニューを使うなら |
| `VITE_CHIONJI_SCHEDULE_SPREADSHEET_ID` | 千音寺専用 → **不要** |
| `VITE_HOME_VISIT_NOTE_AISAI_SPREADSHEET_ID` | 愛西往診 → **不要** |

---

### I. 施設ポータルパスワード（任意）

| 変数名 | 備考 |
|--------|------|
| `VITE_FACILITY_PORTAL_PASSWORD` | 青空現場用に別パスワード推奨 |

---

## 3. デプロイ後チェックリスト

- [ ] 画面右下ビルド ID が最新コミット（`03fc482` 以降: 名簿 typo 修正 + 施設フィルタ）
- [ ] 施設タブが **青空一宮・青空起** の **2件のみ**
- [ ] 「更新」で名簿が読める（`loadResidentsFromSheetSeedOnly` エラーが出ない）
- [ ] **名簿管理** → スプレッドシートから取り込み（初回1回）
- [ ] クラウド同期が青 **ON**（503 でなければ OK）
- [ ] ケアサポート側 Vercel は `VITE_CARELINK_LEDGER_COMPANY_TAG=ケアサポート` を設定（未設定だと全6施設表示のまま）

---

## 4. ケアサポート側 Vercel にも入れること（まだなら）

既存プロジェクトに以下を追加して **Redeploy**:

```
VITE_CARELINK_LEDGER_COMPANY_TAG=ケアサポート
```

これで千音寺・北名古屋・愛西・中川の4施設だけ表示されます。

---

## 5. 運用イメージ（7月オープンまで）

```
GitHub main ──push──┬──► Vercel ケアサポート（tag=ケアサポート）
                    └──► Vercel ブレインエナジー（tag=ブレインエナジー）
                              │
                    同じ Supabase（organization_id でデータ分離）
```

機能修正は **リポジトリ1本** → 両社に反映。  
データ（生活記録・名簿）は **organization_id** で完全分離。

---

## 参照

- 汎用チェックリスト: `VERCEL_NEW_TENANT_CHECKLIST.md`
- 環境変数一覧: `.env.example`
- クラウド同期: `CLOUD_SYNC_SETUP.md`
