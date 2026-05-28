# GitHub × Vercel で「URL を出す」まで（CareLink）

**前提:** AI（Cursor）は **御社の GitHub / Vercel にログインして代行できません。**  
この手順は **オーナーまたは IT 担当がブラウザで操作**します。

このリポジトリは **Python スクリプト中心**です。Vercel では **`public/index.html` を静的ホスト**して **スマホでも開ける URL** を発行します（中身は案内ページのみ）。

---

## 1. GitHub にコードを置く

1. [github.com](https://github.com) にログイン  
2. **New repository** で新規（例: `CareLink_AI`）— **Private** 推奨  
3. PC でリポジトリフォルダで実行（初回）:

```powershell
cd "c:\Users\houka\OneDrive\デスクトップ\CareLink_AI"
git init
git add public/index.html vercel.json docs/DEPLOY_VERCEL.md
git add .
git commit -m "Add static page for Vercel"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/CareLink_AI.git
git push -u origin main
```

※ すでに remote がある場合は `git remote -v` で確認し、**個人情報・`.env`・`data/billing` の実データが push されないか** `.gitignore` を再確認してください。

---

## 2. Vercel でデプロイ

1. [vercel.com](https://vercel.com) にログイン（GitHub アカウント連携が楽）  
2. **Add New… → Project**  
3. **Import** でさきほどの GitHub リポジトリを選択  
4. **Framework Preset:** `Other` または `Vite` ではなく、設定を次のようにする:
   - **Root Directory:** `./`（そのまま）
   - **Build Command:** 空欄（または `echo skip`）
   - **Output Directory:** `public`
5. **Environment Variables:** この静的ページでは **不要**（秘密情報は載せない）  
6. **Deploy** をクリック  

完了後、**Production URL**（例: `https://carelink-xxxxx.vercel.app`）が表示されます。これが **PC・スマホ共通の URL** です。

---

## 3. 画面で迷ったとき

| 見える語 | 意味 |
|----------|------|
| Import Git | GitHub のリポジトリとつなぐ |
| Framework | ここでは **Other** + Output `public` が近い |
| Environment Variables | API キー等（**今回の案内ページでは空で可**） |
| Deploy | 公開して URL を発行 |

---

## 4. よくある誤解

- **この URL だけで請求 PDF や Slack が動くわけではありません。** それらは引き続き **ローカル or 将来のサーバー**で Python を実行します。  
- **Python を Vercel で全部動かす**のは別設計（Serverless 制限・長時間処理の都合）が必要です。

---

## 5. 次の拡張（必要になったら）

- 社内だけ見える **認証付きダッシュボード**（Next.js 等）  
- **API Route** で軽い処理のみクラウド化  

は別タスクとして設計します。
