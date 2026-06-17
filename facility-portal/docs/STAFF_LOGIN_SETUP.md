# 職員ログイン（カイポケ型）— ふれあいの里向け

職員コード + 個人パスワードでログイン。氏名は管理者が登録し、記録・申し送りに自動反映されます。

**対象デプロイのみ:** `VITE_STAFF_LOGIN_ENABLED=1`（ケアサポート・ブレインでは未設定）

---

## 1. Supabase マイグレーション

`supabase/migrations/20260615120000_staff_accounts.sql` を SQL Editor で実行。

---

## 2. Vercel 環境変数（ふれあいの里プロジェクト）

| 変数名 | 値 |
|--------|-----|
| `VITE_STAFF_LOGIN_ENABLED` | `1` |
| `VITE_STAFF_IDLE_LOCK_MS` | `300000`（5分・無操作でログアウト） |
| `STAFF_SESSION_SECRET` | 長いランダム文字列（または `CARE_SYNC_SECRET` と同じでも可） |
| `STAFF_BOOTSTRAP_SECRET` | 初回管理者登録用（一度使ったら削除可） |
| `VITE_CARELINK_ORGANIZATION_ID` | ケアリンク組織 UUID |

**設定しない:** `VITE_FACILITY_PORTAL_PASSWORD`（職員ログインと併用しない）

---

## 3. 初回管理者の作成（1回だけ）

デプロイ後、ターミナルまたは Postman で:

```bash
curl -X POST https://あなたのURL.vercel.app/api/staff-auth \
  -H "Content-Type: application/json" \
  -d '{
    "action": "bootstrap",
    "bootstrapSecret": "VercelのSTAFF_BOOTSTRAP_SECRETと同じ",
    "staffCode": "admin",
    "displayName": "施設 管理者",
    "password": "初回パスワード"
  }'
```

成功したら `STAFF_BOOTSTRAP_SECRET` は Vercel から削除して再デプロイ推奨。

---

## 4. 日常運用

1. 管理者が職員コードでログイン
2. **設定** 画面 → **職員アカウント管理**
3. 職員コード・氏名・初期パスワードを登録 → 職員に伝える
4. 職員はログイン画面でコード + PW を入力

### 自動ログアウト

- **5分間**マウス・キー操作がない → ログアウト
- タブを **90秒以上** 隠す → ログアウト
- 右下 **ログアウト** ボタン

---

## 5. 記録への氏名

ログイン成功時、`display_name` が `staffProfile` に入り、ヒヤリ確認・申し送り等に使われます。

---

## 関連

- `docs/VERCEL_CARELINK_CONSULTING_SETUP.md` — ふれあいの里 Vercel 全体
- `api/staff-auth.js` — サーバ API
