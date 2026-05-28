# 利用者プロフィール置き場（`data/patients/`）

## 目的

CareLink の AI CEO が**全利用者のフェースシート相当情報・指示書要約**を参照するための**ローカル専用**ストレージ。  
**本名・住所・連絡先など個人情報を含むファイルは Git にコミットしない**（`.gitignore` 済み）。

## フォルダ規則

| パス | 説明 |
|------|------|
| `_template/` | 雛形のみ。**コミット可**。新規利用者作成時にコピーする。 |
| `{patient_id}/` | 利用者ごと。**コミット不可**（例: `P000001`）。英数字IDを推奨。 |
| `{patient_id}/plans/` | **居宅ケアプラン・訪問看護計画**のテキスト（照合用）。`_template/plans/README.md` 参照。 |

各 `{patient_id}/` の推奨構成：

```
{patient_id}/
  profile.yaml          # マスタ（非機密は最小限、機密はローカルのみ）
  face_sheet/           # フェースシートPDFや抜粋テキスト（任意）
  orders/               # MCS・指示書の抜粋やCSV（任意）
  soap_reference/       # 「いつもの状態」参照用の過去SOAP抜粋（任意）
```

- `profile.yaml` のスキーマは `_template/profile.yaml.example` を参照。
- 実ファイルは**オーナーPC・社内NAS**でバックアップする。

## 新規利用者の追加手順

1. `_template` を `{patient_id}` にコピーする。  
2. `profile.yaml` を編集（ID・記載方針は事業所ルールに従う）。  
3. フェースシート・指示書・参照SOAPを必要に応じてサブフォルダへ配置。  
4. 録音チェック時は `--patient {patient_id}` で `audit_check_engine.py` に渡す。

## 伊勢様について

伊勢様は**最初の標準利用者**としてプロファイルをここに置く。**リポジトリには含めない。**
