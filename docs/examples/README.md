# サンプル・例示データについて

- **実利用者の記録PDF・全文テキストは本リポジトリに含めない**（個人情報・医療情報の保護）。
- オーナーが **Cursor に PDF や録音を添付**したとき、AI はそのセッション内で参照し、**体裁は `docs/carelink_nursing_record_styleguide.md` に合わせる**。
- コードやテスト用には、**架空の利用者**のみの合成例を `docs/examples/` に置く。
- **月次報告書・計画照合のデモ**: `synthetic_patients/ise_2026-04/`（SOAP5件＋`profile.yaml`）。  
  `python operations/monthly_clinical_automation.py all --soap-glob "docs/examples/synthetic_patients/ise_2026-04/2026-04-*.md" --month-label "2026年4月" --profile "docs/examples/synthetic_patients/ise_2026-04/profile.yaml"`
