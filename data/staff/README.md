# スタッフ台帳（`data/staff/`）

**実名・個人を特定する情報は Git に含めない**（`.gitignore` 済み）。  
`_template/` の雛形をコピーして `{事業所コード}/staff_roster.yaml` 等を置く運用を推奨。

## 準備ができたらやること（リスト整理）

1. **`staff_roster.yaml` を作成**（`_template/staff_roster.yaml.example` をコピー）
2. 各スタッフについて次を埋める:
   - `staff_id`（社内コード・カイポケの職員コードと揃えると連携が楽）
   - `employment_type`: `full_time`（常勤）または `part_time`（パート）
   - `weekly_contract_hours`（週の契約時間。常勤は 38.75〜40 等、事業所規程に合わせる）
   - `skills`（訪問看護・リハ・特定疾患など、ライン割当に使うタグ）
3. オプション: **`shifts/`** に日別の予定・実績時間 CSV を置き、日次の常勤換算チェックに使う

FTE 計算・Slack 警告:

```bash
python operations/staff_fte_engine.py --roster data/staff/YOUR_ORG/staff_roster.yaml
python operations/staff_fte_engine.py --roster ... --shifts data/staff/YOUR_ORG/shifts/2026-04-07.csv --slack
```
