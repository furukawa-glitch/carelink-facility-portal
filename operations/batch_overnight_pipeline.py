"""
夜間一括処理の設計用エントリ（骨子）。
実装: STT → audit_check_engine → SOAP生成 → カイポケCSV は段階的に接続する。

設計書: docs/batch_overnight_pipeline.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from datetime import date

ROOT = Path(__file__).resolve().parents[1]
INBOX = ROOT / "data" / "inbox_daily"


def scan_inbox() -> list[Path]:
    if not INBOX.is_dir():
        return []
    exts = {".txt", ".wav", ".mp3", ".m4a"}
    return sorted(p for p in INBOX.iterdir() if p.suffix.lower() in exts)


def main() -> None:
    p = argparse.ArgumentParser(description="CareLink 夜間バッチ（設計・骨子）")
    p.add_argument("--dry-run", action="store_true", help="インボックス内ファイル一覧のみ表示")
    p.add_argument("--plan", action="store_true", help="処理プランをJSONで出力")
    args = p.parse_args()

    files = scan_inbox()
    plan = {
        "run_date": date.today().isoformat(),
        "inbox_dir": str(INBOX),
        "queued_files": [str(f) for f in files],
        "phases": [
            "1_transcribe",
            "2_dual_gate_audit_and_patient_consistency",
            "3_soap_draft",
            "4_human_report_under_data_reports",
            "5_kaipoke_export_when_spec_ready",
        ],
        "note": "STT/LLM/カイポケは未接続。audit_check_engine.py をフェーズ2の一部として呼び出す。",
    }

    if args.dry_run:
        for f in files:
            print(f)
        return

    if args.plan:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return

    print("使い方: --dry-run または --plan。実処理は未実装。")


if __name__ == "__main__":
    main()
