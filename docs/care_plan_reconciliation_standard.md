# CareLink 標準 — 居宅ケアプラン × 訪問看護計画書 照合・SOAP 計画更新フラグ

## 1. 目的

- **居宅サービス計画書**（ケアプラン）と、当社が作成する**訪問看護計画書**の記載を突き合わせ、**矛盾・反映漏れの候補**を機械的に警告する。
- 日次 **SOAP** から **状態変化・区分変更** 等を検知したら、**即座に「計画書更新の必要あり」** フラグを立てる（CareLink 標準運用）。

**正本**は常に紙・公式システム上の原本および**ケアマネ・看護の判断**である。本ツールは**取りこぼし防止のセーフティネット**であり、誤検知・見逃しがあり得る。

## 2. データの置き場（個人情報）

| 種別 | 推奨パス | Git |
|------|----------|-----|
| 居宅計画テキスト（OCR または手入力） | `data/patients/{patient_id}/plans/home_care_plan.txt` | 含めない |
| 訪問看護計画テキスト | `data/patients/{patient_id}/plans/visit_nursing_plan.txt` | 含めない |
| スキャン画像 | `data/patients/{patient_id}/plans/home_care_plan_sources/` 等 | 含めない |

雛形の説明は `data/patients/_template/plans/README.md` を参照。

## 3. 画像・テキストの読み込み

1. **テキスト**  
   - PDF は一旦テキスト抽出して `.txt` / `.md` にする（事業所の許可されたツールを使用）。
2. **画像（スキャン・写真）**  
   - `python operations/care_plan_reconciler.py ocr --image 入力.png --out home_care_plan.txt`  
   - 要: **Tesseract-OCR**（日本語）＋ `pip install pillow pytesseract`  
   - OCR 結果は**必ず人が校正**してから照合に回す。

## 4. 照合の意味（「一文字でも」について）

帳票様式・改行・全角半角の差により、**生バイトの完全一致は実務上とらない**。  
代わりに CareLink では次を**標準**とする。

1. **Unicode 正規化（NFKC）** 後の部分一致  
2. **居宅側に立つ重要語**が訪問看護計画に無い場合の **漏れ警告**（`config/care_plan_sync.yaml` の `home_must_reflect_in_visit`）  
3. **両立しにくい記述の組**の **矛盾警告**（`contradiction_pairs`）  
4. **居宅本文の「長い行」**が訪問看護側に類似文として見つからない場合の **警告**（`line_similarity`、ノイズになり得るため閾値調整可）

さらに厳密な diff が必要な場合は、正規化後テキストを別ツールで比較する。

## 5. SOAP → 計画書更新フラグ

`config/care_plan_sync.yaml` の `soap_plan_update_triggers` に列挙した語が SOAP に含まれると、

- `rule_id: plan_revision_required`
- **計画書更新の必要あり**

を発報する。

**監査エンジン統合**:

```bash
python operations/audit_check_engine.py --text soap.md --soap-plan-update-check
```

JSON 出力では `plan_update_required` フィールドも参照できる。

## 6. コマンド一覧

```bash
# 任意パスの2ファイルを照合
python operations/care_plan_reconciler.py compare --home 居宅.txt --visit 看護計画.txt

# 患者フォルダ既定名
python operations/care_plan_reconciler.py patient --patient P000001

# SOAP のみ更新フラグ
python operations/care_plan_reconciler.py soap-flag --text soap.md --json
```

## 7. 改訂

| 版 | 日付 | 内容 |
|----|------|------|
| 0.1 | 2026-04-11 | 初版（CareLink 標準ルール化） |
