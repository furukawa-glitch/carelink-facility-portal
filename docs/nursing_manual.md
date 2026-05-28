# CareLink 看護・監査 統合マニュアル（`nursing_manual.md`）

**NotebookLM 等で追加生成した本文**を、**「§9 NotebookLM 追記欄」**に随時追記していく。  
機械チェックの**実体ルール**はリポジトリ内の **`config/audit_rules.yaml`** と同期させる（本書と YAML の矛盾がないようにする）。

---

## 1. このマニュアルの位置づけ

- CareLink の **汎用チェックエンジン**（`operations/audit_check_engine.py`）が参照する**人間可読版の正本**である。
- 詳細な処置別キーワード・聞き返しは `docs/visit_nursing_ai_audit_manual_r8.md`、臨床マスタは `docs/nursing_master_guideline.md`、文体は `docs/carelink_nursing_record_styleguide.md` と**併用**する。
- **最高執行基準**の運用は `Instructions.md` **§5.0**（監査マニュアル＋利用者別過去SOAP）。

---

## 2. 全記録共通（加算・監査で問われやすい観点）

| ID（YAML） | 内容 |
|------------|------|
| `visit_time_documented` | **訪問開始・終了**（または「訪問時」に紐づく時系列）の言及 |
| `medication_or_residual` | **服薬状況・残薬**（未確認ならその旨） |
| `assessment_not_vague_only` | **A** が「変わりなし」等**のみ**で終わらない |
| `plan_review_mention` | **計画の継続・見直し**に触れる（P または A） |

---

## 3. 条件付きルール（処置が「ある」と判定されたとき）

| ID | 発火条件（要約） | 追加で求める言及 |
|----|------------------|------------------|
| `enteral_fixation_memory` | 経管・NG・胃ろう・チューブ | メモリ／固定／挿入／cm |
| `enteral_formula_rate` | 経管・NG・胃ろう | mL／栄養／注入／速度 |
| `suction_context` | 吸引 | 痰・性状・量のいずれか |
| `pressure_redness_compare` | 褥瘡・発赤・創・ドレッシング | 前回比または変化なしの明示 |
| `eol_breathing_family` | 看取・終末期・ターミナル | 呼吸・家族対応のいずれか |

※ 判定の詳細キーワードは **`config/audit_rules.yaml`** を参照。

---

## 4. 利用者プロフィールとの照合（指示漏れ・矛盾）

- 各利用者の **`data/patients/{patient_id}/profile.yaml`** の `standing_orders_keywords` と本文を照合し、**該当曜日・頻度**のロジックは今後 `audit_check_engine.py` で拡張する。
- `face_sheet` の ADL・装着器具と**矛盾語**は `visit_nursing_ai_audit_manual_r8.md` **§5.2** に準拠。
- **訪問看護計画書の目標**の正本は帳票PDF。月次の**計画達成ドラフト**は `profile.yaml` の `care_plan_nursing.goals`（`keywords` 付き）と SOAP を `operations/monthly_clinical_automation.py plan` で照合する（**A/B/C はキーワード比率の機械下書き**であり、帳票記載の正は看護師判断）。

---

## 5. 告示・改定との関係

- 本マニュアル・YAML は**たたき台**。**算定可否の最終判断は告示・事業所**。

---

## 6. 関連ファイル

| パス | 用途 |
|------|------|
| `config/audit_rules.yaml` | エンジン用ルール |
| `config/care_plan_sync.yaml` | **居宅ケアプラン×訪問看護計画**照合・SOAP計画更新トリガー（`Instructions.md` **§5.6**） |
| `operations/audit_check_engine.py` | チェック実行（要: `pip install pyyaml`）。`--soap-plan-update-check` で計画更新フラグ |
| `operations/care_plan_reconciler.py` | 計画書テキスト照合・OCR 補助 |
| `docs/care_plan_reconciliation_standard.md` | 上記の運用標準（正本の定義・限界） |
| `data/patients/` | 利用者プロフィール（個人情報は Git 外） |

---

## 7. 一括夜間処理

設計は **`docs/batch_overnight_pipeline.md`**、入口は **`data/inbox_daily/`**。

---

## 8. 改訂履歴

| 版 | 日付 | 内容 |
|----|------|------|
| 0.1 | 2026-04-11 | 初版：統合マニュアル＋YAML連動 |

---

## 9. NotebookLM 追記欄

*（ここに NotebookLM 出力を貼り付け、必要に応じて `config/audit_rules.yaml` にルール ID を追加する）*
