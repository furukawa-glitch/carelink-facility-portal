# 計画書テキスト置き場（`plans/`）

`data/patients/{patient_id}/plans/` にコピーして使う。**Git には含めない**（親ディレクトリが ignore 対象）。

| ファイル名 | 内容 |
|------------|------|
| `home_care_plan.txt` | 居宅サービス計画書の本文（OCR 校正後または手入力） |
| `visit_nursing_plan.txt` | 訪問看護計画書の本文 |

照合:

```bash
python operations/care_plan_reconciler.py patient --patient {patient_id}
```

画像からテキスト化:

```bash
python operations/care_plan_reconciler.py ocr --image scan.png --out home_care_plan.txt
```

詳細は `docs/care_plan_reconciliation_standard.md`。
