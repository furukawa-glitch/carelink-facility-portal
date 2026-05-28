# Slack 通知を「実際に飛ばす」までの手順（CareLink）

CareLink から Slack へ通知するには **Incoming Webhook**（手早い）か **Bot Token**（高機能）のどちらかを使います。まずは **Webhook** を推奨します。

---

## A. Incoming Webhook（推奨・まずはこれ）

### ステップ 1 — Slack API にログイン

ブラウザで [https://api.slack.com/apps](https://api.slack.com/apps) を開き、御社ワークスペースの Slack アカウントでログインします。

### ステップ 2 — アプリを新規作成

1. **Create New App** をクリック  
2. **From scratch** を選択  
3. **App Name**: 例 `CareLink Notify`  
4. **Pick a workspace**: 通知を出したいワークスペース  
5. **Create App**

### ステップ 3 — Incoming Webhooks を ON

1. 左メニュー **Incoming Webhooks**  
2. **Activate Incoming Webhooks** を **On**

### ステップ 4 — チャンネルを選んで URL を発行

1. 画面下部 **Add New Webhook to Workspace**  
2. 投稿先チャンネル（例 `#carelink-billing`）を選択 → **許可**  
3. 表示された **Webhook URL**（`https://hooks.slack.com/services/...`）を **コピー**  
   - **この URL は秘密情報です**（Git・チャットへの貼り付けは避ける）

### ステップ 5 — 「URL をどこに入れるか」（ここで迷いやすい）

**入れていい場所は次の2つだけです。**

| 場所 | 正しい？ |
|------|----------|
| ブラウザのアドレスバー | ×（検索や別ページに飛ぶだけ） |
| PowerShell で **URL だけ** Enter | ×（「コマンドがない」エラー） |
| **PowerShell の行全体** `$env:SLACK_WEBHOOK_URL = "..."` | ○ |
| Windows の「環境変数」画面の **変数値** | ○（恒久的） |

**PowerShell での正しい形（1行・そのままコピペして `"` の中だけ差し替え）**

1. **PowerShell を開く**（青い画面。コマンドプロンプトでも可だが手順は PowerShell 基準）
2. 次の **丸ごと1行** を入力する。  
   - 行の先頭は **必ず `$`**  
   - URL は **ダブルクォート `"` の中だけ**（`https://` が2回続かないように Slack から **1本だけ**コピー）

```powershell
$env:SLACK_WEBHOOK_URL = "ここにSlackからコピーしたURLを1本だけ貼る"
```

3. Enter を押す。**エラーが出なければ**そのウィンドウでは設定済み。
4. 続けて **別の行で** 次を実行:

```powershell
cd "c:\Users\houka\OneDrive\デスクトップ\CareLink_AI"
python integrations/slack_notification.py --test
```

`python` でエラーなら `py` を試す:

```powershell
py integrations/slack_notification.py --test
```

成功すると `mode=webhook ok=True` とチャンネルにテスト投稿が届きます。

### Node.js command prompt / コマンドプロンプト（cmd）の場合

タブ名が **「Node.js command prompt」** のときは **PowerShell ではありません**。次の書き方にしてください。

1. **環境変数**（`=` の前後にスペースを入れない。URL に **&** が含まれる場合は後述）

```cmd
set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/Txxxx/Bxxxx/xxxxxxxx
```

2. **フォルダ移動**（日本語パスはダブルクォートで囲む）

```cmd
cd /d "c:\Users\houka\OneDrive\デスクトップ\CareLink_AI"
```

3. **テスト**

```cmd
python integrations\slack_notification.py --test
```

`python` が無ければ `py integrations\slack_notification.py --test`。

**よくあるエラー**

- **URL だけ貼って Enter** → 「コマンドレットとして認識されません」→ 上の **`$env:SLACK_WEBHOOK_URL = "..."` 形式**にする  
- **`https://hooks.slack.com/services/` が2回**出ている → Slack でコピーし直し、**1回だけ**にする  
- **`python` が無い** → `py` に変えるか Python をインストール

**恒久的（ユーザー環境変数）**

1. Windows 検索で「環境変数」→ **システム環境変数の編集**  
2. **環境変数** → ユーザー環境変数で **新規**  
3. 変数名: `SLACK_WEBHOOK_URL`  
4. 変数値: Webhook URL  
5. OK → **新しいターミナル** を開き直してから `python integrations/slack_notification.py --test`

### ステップ 6 — 通知を止めたいとき

```powershell
$env:SLACK_ENABLED = "0"
```

またはユーザー環境変数に `SLACK_ENABLED` = `0` を追加。

---

## B. Bot Token（任意）

`pip install -r integrations/requirements-slack.txt` のうえ、Bot に `chat:write` を付与し、チャンネルに Bot を招待します。

```powershell
$env:SLACK_BOT_TOKEN = "xoxb-..."
$env:SLACK_CHANNEL_ID = "C0123456789"
python integrations/slack_notification.py --test
```

---

## トラブルシュート

| 現象 | 確認 |
|------|------|
| `mode=none ok=False` | `SLACK_WEBHOOK_URL` がそのシェルで見えているか `echo $env:SLACK_WEBHOOK_URL` |
| HTTP 404 | URL のコピペミス（末尾欠け等） |
| 投稿されない | Webhook 作成時に選んだチャンネル・プライベートチャンネルは Bot/アプリの招待が要る場合あり |

公式: [Sending messages using incoming webhooks](https://api.slack.com/messaging/webhooks)

---

## Jグランツの新着をSlack通知する（介護向け）

JグランツMCPとあわせて、補助金の新着をSlackへ自動通知できます。

### 1) まず手動テスト（送信せず本文確認）

```powershell
cd "c:\Users\houka\OneDrive\デスクトップ\CareLink_AI"
python integrations/jgrants_slack_watcher.py --dry-run
```

### 2) 実送信

`SLACK_WEBHOOK_URL`（または Bot Token 方式）が設定済みの状態で:

```powershell
cd "c:\Users\houka\OneDrive\デスクトップ\CareLink_AI"
python integrations/jgrants_slack_watcher.py
```

### 3) よく使う環境変数（任意）

- `JGRANTS_KEYWORDS`  
  例: `介護,介護施設,サービス継続,介護 ICT,介護 生産性向上`
- `JGRANTS_TARGET_AREA`  
  例: `愛知県`（未指定なら全国）
- `JGRANTS_ACCEPTANCE_ONLY`  
  `1` で募集中のみ（既定）
- `JGRANTS_WATCHER_STATE`  
  既通知IDを保存するJSONパス（未指定なら `integrations/jgrants_watcher_state.json`）

### 4) 定期実行（Windows タスクスケジューラ）

1. タスクスケジューラで「基本タスクの作成」
2. 実行プログラム: `python`
3. 引数: `integrations/jgrants_slack_watcher.py`
4. 開始フォルダ: `c:\Users\houka\OneDrive\デスクトップ\CareLink_AI`
5. 毎朝（例: 8:00）で設定

※ 初回のみ大量通知を避けたい場合は、最初に `--dry-run` を1回実行して確認してください。

---

## Slackから質問して回答させる（JグランツQ&Aボット）

Webhook通知とは別に、**Bot Token + App Token** が必要です（Socket Mode）。

### 1) Slack App 設定

1. Slack App を開く（既存 `CareLink Notify` でOK）
2. **OAuth & Permissions** で Bot Token Scope を追加
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
3. **Socket Mode** を ON にして App Token（`xapp-...`）を発行
4. ワークスペースに再インストールし、対象チャンネルへBotを招待

### 2) ローカル環境変数

```powershell
$env:SLACK_BOT_TOKEN = "xoxb-..."
$env:SLACK_APP_TOKEN = "xapp-..."
```

恒久化する場合:

```powershell
setx SLACK_BOT_TOKEN "xoxb-..."
setx SLACK_APP_TOKEN "xapp-..."
```

### 3) 依存インストールと起動

```powershell
cd "c:\Users\houka\OneDrive\デスクトップ\CareLink_AI"
pip install -r integrations/requirements-slack.txt
py integrations/slack_jgrants_qa_bot.py
```

### 4) Slackでの使い方

- `@CareLink 介護報酬改定 愛知県`
- `@CareLink 介護 物価高騰 福岡県`
- `補助金 介護 ICT`

Botは募集中（acceptance=1）を検索し、上位候補を返します。

### 5) 反応しないとき（まずここ）

- **`chat:write` が Bot に付いていないと、返信できません。**  
  OAuth スコープに `chat:write` を追加し、**必ず再インストール（Reinstall）** してから新しい `xoxb` を `.env` / 環境変数に反映してください。
- デバッグ起動で確認: `py integrations/slack_jgrants_qa_bot.py --debug`  
  ログの `auth.test` 応答に `chat:write` が含まれているか確認してください。
