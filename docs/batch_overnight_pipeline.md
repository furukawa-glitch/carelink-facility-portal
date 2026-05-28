# 夜間一括処理パイプライン設計（録音→SOAP→カイポケ取込）

## 目的

スタッフが **`data/inbox_daily/`** に置いた「今日の全記録」を、**一晩で**次まで自動処理する設計とする。

1. 文字起こし（STT）
2. **二重ゲート**（`Instructions.md` §5.0）  
   - ① `nursing_manual.md` / `audit_rules.yaml` ＋関連マニュアル  
   - ② `data/patients/{id}/` のプロフィール・参照SOAP
3. SOAP 下書き生成（テンプレ `templates/soap_note_skeleton_visit_nursing_carelink.md`）
4. 人間レビュー用レポート（`data/reports/`）
5. **カイポケ用取込**（CSV または API）— 列定義は `integrations/kaipoke_import_spec.md`（今後作成）に従う

## コンポーネント

| 段階 | コンポーネント | 備考 |
|------|----------------|------|
| 取込 | `data/inbox_daily/` + `.meta.json` | 命名規則は README |
| STT | 外部サービスまたはローカルモデル | 個人情報の DPA 必須 |
| チェック | `operations/audit_check_engine.py` | ルール拡張は YAML |
| 生成 | LLM / ルールベース（将来統合） | 捏造禁止は Instructions §5 |
| 出力 | `data/reports/batch_{date}/` | Git 非掲載推奨 |
| カイポケ | `operations/export_kaipoke_batch.py`（骨子） | 仕様確定後に実装 |

## ジョブ制御

- **キュー**: フォルダ監視、または `manifest.json` に一覧。
- **失敗**: 患者ID不明・プロファイル欠落は**エラーログ**に隔離し、朝に一覧化。
- **再実行**: 同一 `{patient_id}__{date}__*` は idempotent に上書き or バージョン番号。

## セキュリティ

- バッチサーバは**暗号化ディスク**、アクセスは**職種・最小権限**。
- ログに**全文カルテを残さない**（ルール ID とファイル名のみ）。

## 改訂履歴

| 版 | 日付 | 内容 |
|----|------|------|
| 0.1 | 2026-04-11 | 初版設計 |
