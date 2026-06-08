# 複数PCで生活記録・病名を共有する（クラウド同期）

**いま本番（carelink-facility-portal.vercel.app）で同期 API が 503 になる場合、Vercel のサーバ側環境変数が未設定です。**  
この状態では **どのPCでも「今すぐ同期」は動きません**（各PCのブラウザだけに保存されます）。

## 1. 記録画面で確認

記録ページの **「クラウド同期」** ボックスを見てください。

| 表示 | 意味 |
|------|------|
| **クラウド同期: サーバー未設定**（黄色） | Vercel にサーバ用の変数が足りない → 下記 2 を実施 |
| **クラウド同期 ON（全PC共有）**（青） | 設定OK。記録したPCで保存 → 他PCで「今すぐ同期」 |

## 2. Vercel に登録する変数（Production）

Vercel → プロジェクト → **Settings → Environment Variables**  
**Environment: Production** にすべて入れ、**Save 後に Redeploy（再デプロイ）** してください。

### ブラウドに埋め込む（`VITE_` 付き・ビルド時に必要）

| 変数名 | 内容 |
|--------|------|
| `VITE_CARELINK_ORGANIZATION_ID` | Supabase の `organizations` テーブルの UUID |
| `VITE_CARE_SYNC_SECRET` | 任意の長いパスワード（全員同じ値） |
| `VITE_SUPABASE_URL` | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Settings → API → **anon public** |

### サーバだけ（ブラウザに出さない）

| 変数名 | 内容 |
|--------|------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → **service_role** |
| `CARE_SYNC_SECRET` | **`VITE_CARE_SYNC_SECRET` と同じ文字列** |
| `VITE_SUPABASE_URL` | 上と同じ URL（サーバ API も参照） |

任意: `CARELINK_ORGANIZATION_ID`（`VITE_CARELINK_ORGANIZATION_ID` と同じ UUID）

## 3. Supabase

1. マイグレーション適用済みであること（`care_events`, `facility_portal_stores` 等）
2. `organizations` に貴社の行（UUID が `VITE_CARELINK_ORGANIZATION_ID` と一致）

## 4. 黄色表示＋ `Could not find the table 'public.care_events'`（PGRST205）

**意味:** Vercel の環境変数は入っているが、**Supabase に同期用テーブルがまだ無い**状態です。  
アプリの不具合ではなく、**データベースのマイグレーション未実行**です。

**対処（Supabase Dashboard）**

1. [Supabase](https://supabase.com) → 対象プロジェクト → **SQL Editor** → New query
2. リポジトリの次の SQL を **この順に** 実行（`organizations` が既にある場合は 2 と 3 だけで可）  
   - `supabase/migrations/20260530120000_care_events_cloud_sync.sql`  
   - `supabase/migrations/20260603120000_facility_portal_stores.sql`
3. **Table Editor** で `care_events` と `facility_portal_stores` ができたか確認
4. `organizations` に、Vercel の `VITE_CARELINK_ORGANIZATION_ID` と **同じ UUID** の行があるか確認（無ければ追加）
5. 記録画面を **Ctrl+Shift+R** → **「今すぐ同期」**  
   → 青い **「クラウド同期 ON」** になり、送信件数が出ればOK

`residents` だけあって `care_events` が無い、という組み合わせでこのエラーが出ます。

## 5. 「最新の状態です」なのに別PCに反映されない

**古い本番ビルド**では「今すぐ同期」が **クラウドから取るだけ** で、入れたPCのバイタル・生活記録を **まとめて送っていません**。  
そのため両方のPCで「手動同期: 最新の状態です」と出ても、**クラウドが空のまま** になります。

**対処（順番）**

1. **記録・バイタル・傷病CSVを入れたPC** で、修正版デプロイ後に「今すぐ同期」  
   → 「クラウドへ送信しました（記録○件…）」と出るか確認  
2. **別PC** で「今すぐ同期」  
   → 「記録○件反映」と出ればOK  
3. Supabase → **Table Editor → `care_events`** に行が増えているか確認（0件なら送信失敗）

組織ID: Vercel の `VITE_CARELINK_ORGANIZATION_ID` が、Supabase の `organizations` テーブルの **id（UUID）** と完全一致している必要があります。

## 6. 動作確認手順

1. 再デプロイ完了後、記録画面を **Ctrl+Shift+R** で強制リロード
2. 同期ボックスが **青い ON** になるか確認
3. **記録を入れたPC** で「今すぐ同期」→ 送信件数が表示されるか
4. **別PC** で同じ URL を開き「今すぐ同期」→ 記録・病名が反映されるか

## 7. 診断 URL（管理者向け）

ブラウザで開く（JSON が表示されます）:

`https://carelink-facility-portal.vercel.app/api/care-sync-status`

`"ready": true` ならサーバ設定はOK。`missing` に足りない変数名が出ます。
