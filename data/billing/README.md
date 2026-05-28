# 請求書仕分け（`data/billing/`）

**個人情報・請求内容は Git に含めない**（`.gitignore` 済み）。`_template` の CSV 例のみ追跡。

## 北名古屋から LINE 請求を始める — 準備完了チェックリスト

| # | 担当 | 内容 |
|---|------|------|
| 1 | 現場 | `line_users.csv`（`patient_name`, `line_user_id`, `office`。北名古屋は `office` = `北名古屋`）※雛形: `_template/line_users.example.csv` |
| 2 | 現場 | 一括請求 PDF を `inbox/` に配置 |
| 3 | 共通 | [LINE Developers](https://developers.line.biz/) で **チャネルアクセストークン（長期）** を発行 → 環境変数 `LINE_CHANNEL_ACCESS_TOKEN`（**Channel Secret では送れない**） |
| 4 | 任意 | `SLACK_WEBHOOK_URL`（エラー通知） |
| 5 | 実行 | `operations/billing_dispatch.py run ... --office 北名古屋`（下記コマンド例） |

**利用者リストができたら** このチャットで「北名古屋リストできた」と送ってください。続けて **LINE API 設定とテスト送信** を一緒に進めます。

## フォルダ例（運用で作成）

| パス | 用途 |
|------|------|
| `inbox/` | カイポケから出した一括 PDF を置く |
| `line_users.csv` | LINE 登録者（`line_users.example.csv` をコピーして作成） |
| `work/YYYYMMDD_HHMM/` | 分割・仕分けの作業ディレクトリ（`--work-dir` で指定） |

## 北名古屋だけ LINE 対象にする例

`line_users.csv` に **office**（または **site** / **拠点**）列を付け、北名古屋の行だけ `office` に `北名古屋` と書く。

```powershell
python operations/billing_dispatch.py run `
  --input data/billing/inbox/seikyu_bulk.pdf `
  --line-csv data/billing/line_users.csv `
  --work-dir data/billing/work/20260211_1 `
  --office 北名古屋
```

- **北名古屋かつ LINE 登録あり** → `line/` ＋（トークンがあれば）push  
- **それ以外**（他拠点・LINE未登録）→ すべて `mail/`（郵送用）

## 一括実行（拠点指定なし）

```powershell
pip install -r integrations/requirements-billing.txt
$env:SLACK_WEBHOOK_URL = "https://hooks.slack.com/..."
python operations/billing_dispatch.py run `
  --input data/billing/inbox/seikyu_bulk.pdf `
  --line-csv data/billing/line_users.csv `
  --work-dir data/billing/work/20260211_1
```

- **LINE 登録あり** → `work/.../line/` に PDF + `line/` 向けログ。Messaging API のトークンがあればテキスト通知も送信。  
- **未登録** → `work/.../mail/`（郵送・手配用）。  
- **ログ** → `work/.../logs/dispatch.jsonl`  
- **失敗** → Slack に `notify_error`（Webhook 設定時）。

## LINE について

Messaging API は **PDF を直接添付する標準メッセージタイプがありません**。  
本ツールは **テキスト通知**（テンプレート）と **PDF ファイルの仕分け**までを自動化します。PDF の送付方法は事業所ルール（別送・URL・手動添付等）に合わせてください。

### つなぎ方（画面の Channel Secret について）

- **push 送信に使うのは「チャネルアクセストークン（長期）」**です。管理画面に出ている **Channel Secret だけでは API でメッセージは送れません**。  
- [LINE Developers](https://developers.line.biz/) の該当チャネル → **Messaging API** でトークンを発行し、環境変数に設定します:

```powershell
$env:LINE_CHANNEL_ACCESS_TOKEN = "（長期トークン）"
```

- Webhook に **L-Step（linestep.net 等）** が入っている場合でも、**別途発行したトークンで push は可能**なことが多いです（競合する場合は LINE / L-Step の仕様・契約を確認）。  
- **Channel Secret をチャットや画像で共有した場合は、漏えい扱いで Secret を再発行**してください。リポジトリや CSV に Secret を書かないこと。
