# care-input（現場用 入力アプリ）

スマホ／タブレットから **バイタル・食事・水分・巡視・排泄** を素早く入力するための専用アプリです。
入力した記録は `/api/care-sync` 経由で **Supabase（クラウド）に保存**され、閲覧用の
**facility-portal（PC）に自動で反映**されます（起動時・約1分ごと・Realtimeで即時）。

- PC（facility-portal）＝閲覧・帳票専用
- スマホ/タブレット（care-input）＝入力専用
- データは同じ Supabase に集約 → どちらからでも同じ記録が見える

## しくみ（データ連携）

1. ログイン
   - 既定: 職員コード＋個人パスワード（`/api/staff-auth`、facility-portal と同じ `staff_accounts`）
   - `VITE_CARE_INPUT_PASSWORD` を設定した場合: 共有パスワード＋記録者名（端末に記憶）
2. 名簿を取得（`/api/care-sync` の `pull_residents`）
3. 入力 → ケアイベントを送信（`/api/care-sync` の `upsert_events`）
4. facility-portal が `pull_events` で取得し、24時間表・記録に反映

利用者の紐づけは **「氏名 + 施設名」** で照合されるため、端末間で利用者IDが違っても同じ人の記録としてまとまります。

## 必要な環境変数（Vercel）

閲覧用 facility-portal と **同じ値**を設定してください（ここが一致して初めて連携します）。

| 変数 | 用途 | 公開範囲 |
| --- | --- | --- |
| `VITE_CARELINK_ORGANIZATION_ID` | 組織ID（UUID） | クライアント |
| `VITE_CARE_SYNC_SECRET` | 同期シークレット | クライアント |
| `VITE_CARE_INPUT_FACILITY` | 既定施設名（例: `ふれあいの里` / ケアサポートは `中川本館,愛西,北名古屋,千音寺`） | クライアント |
| `VITE_CARE_INPUT_PASSWORD` | 設定すると共有パスワードでログイン（例: ケアサポート）。未設定なら職員コード方式 | クライアント |
| `VITE_SUPABASE_URL` | Supabase URL | クライアント/サーバ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role | **サーバのみ** |
| `CARE_SYNC_SECRET` | 同期シークレット（VITE_ と同じ値） | **サーバのみ** |
| `STAFF_SESSION_SECRET` | ログインのセッション署名鍵（未設定時は `CARE_SYNC_SECRET` を流用） | **サーバのみ** |

`.env.example` をコピーして `.env.local` を作成すると、ローカルでも値を読み込みます
（親フォルダ `CareLink_AI/.env` ともマージされます）。

## ローカル開発

API（`/api/*`）は Vercel のサーバ関数です。ローカルでAPIも動かすには Vercel CLI を使います。

```bash
cd care-input
npm install
# 画面だけ確認（APIは叩けない）:
npm run dev
# APIも含めて動かす:
npx vercel dev
```

## Vercel への新規デプロイ手順

1. Vercel で **New Project** → このリポジトリ（`CareLink_AI`）を選択
2. **Root Directory** を `care-input` に設定
3. Framework は Vite（自動検出）。Build: `vite build` / Output: `dist`
4. 上記の環境変数を **Production / Preview** に登録
5. Deploy
6. スマホで開き、ホーム画面に追加（PWA）。職員コードでログイン

> 同じ Git リポジトリを使うため、コード修正は `git push` で facility-portal と care-input の両方に反映できます（Root Directory が異なるだけ）。

## 送信されるイベント形式（参考）

```js
{
  id: 'ev_...',                  // 端末で一意採番（重複は上書き）
  type: 'vital_snapshot' | 'meal' | 'fluid_intake' | 'patrol' | 'excretion',
  residentId, residentName, facilitySheetTitle,
  ts,                            // 記録時刻（ISO）
  meta: { /* 種類ごと: temp/bpUpper..., hourlyKind:'urine'|'stool', urineCode, stoolVolume... */ }
}
```

## オフライン対応

電波が弱い場所でも入力は失われません。送信に失敗した記録は端末に保存され、
オンライン復帰・画面復帰時に自動再送します（ヘッダーに「未送信 n」と表示）。
