"""
汎用監査・加算漏れチェックエンジン（たたき台）。
ルール: config/audit_rules.yaml（docs/nursing_manual.md と整合）
利用者文脈: data/patients/{id}/profile.yaml（ローカルのみ推奨）

使用例:
  python operations/audit_check_engine.py --text path/to/transcript.txt
  python operations/audit_check_engine.py --text transcript.txt --patient P000001
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RULES = ROOT / "config" / "audit_rules.yaml"
DEFAULT_CARE_PLAN_SYNC = ROOT / "config" / "care_plan_sync.yaml"
PATIENTS_DIR = ROOT / "data" / "patients"

def _load_care_plan_reconciler():
    path = ROOT / "operations" / "care_plan_reconciler.py"
    spec = importlib.util.spec_from_file_location("care_plan_reconciler", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("care_plan_reconciler を読み込めません")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _care_plan_soap_check(text: str, sync_path: Path) -> list[dict[str, Any]]:
    return _load_care_plan_reconciler().run_soap_plan_update_check(text, sync_path)


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def normalize_text(s: str) -> str:
    return s.replace("\u3000", " ").strip()


def text_contains_any(haystack: str, keywords: list[str]) -> bool:
    h = haystack
    return any(k in h for k in keywords)


def run_rules(rules_doc: dict[str, Any], text: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    t = normalize_text(text)
    for rule in rules_doc.get("rules", []):
        rid = rule["id"]
        sev = rule.get("severity", "info")
        applies = rule.get("applies_if_any_keywords")
        if applies and not text_contains_any(t, applies):
            continue

        ok = True
        detail = ""

        if "any_keywords" in rule:
            kws = rule["any_keywords"]
            if not text_contains_any(t, kws):
                ok = False
                detail = f"いずれのキーワードも検出されず: {kws}"

        if ok and "require_any_keywords" in rule:
            kws = rule["require_any_keywords"]
            if not text_contains_any(t, kws):
                ok = False
                detail = f"必須キーワード不足: {kws}"

        if ok and "forbidden_if_only" in rule:
            cfg = rule["forbidden_if_only"]
            if cfg.get("whole_text"):
                for pat in cfg.get("patterns", []):
                    if re.fullmatch(pat, t, flags=re.MULTILINE):
                        ok = False
                        detail = f"画一的な記載パターン: {pat}"
                        break

        if not ok:
            findings.append(
                {
                    "rule_id": rid,
                    "severity": sev,
                    "name": rule.get("name", rid),
                    "detail": detail or rule.get("description", ""),
                }
            )

    # 指示キーワードは「その日の記録に必ず書くべきもの」だけ profile に載せる。
    # 頻度条件（週○回等）は未実装。必要なら --check-standing-orders を付与。
    return findings


def append_standing_order_checks(
    findings: list[dict[str, Any]], text: str, profile: dict[str, Any] | None, enabled: bool
) -> None:
    if not enabled or not profile:
        return
    t = normalize_text(text)
    orders = profile.get("standing_orders_keywords") or []
    for phrase in orders:
        if phrase and phrase not in t:
            findings.append(
                {
                    "rule_id": "standing_order_keyword",
                    "severity": "warning",
                    "name": "指示書キーワード未検出",
                    "detail": f"profile の指示キーワードが本文にありません: {phrase}",
                }
            )


def main() -> None:
    p = argparse.ArgumentParser(description="CareLink 汎用監査チェック（nursing_manual / audit_rules.yaml）")
    p.add_argument("--text", type=Path, required=True, help="チェック対象テキスト（文字起こし・SOAP下書き）")
    p.add_argument("--rules", type=Path, default=DEFAULT_RULES)
    p.add_argument("--patient", type=str, default="", help="data/patients/{id}/profile.yaml を読む")
    p.add_argument(
        "--check-standing-orders",
        action="store_true",
        help="profile.yaml の standing_orders_keywords を本文に全部含むか検査（単純一致）",
    )
    p.add_argument("--json", action="store_true", help="JSON で標準出力")
    p.add_argument(
        "--soap-plan-update-check",
        action="store_true",
        help="CareLink標準: SOAPに状態変化・区分変更等があれば「計画書更新の必要あり」を findings に追加",
    )
    p.add_argument(
        "--care-plan-sync",
        type=Path,
        default=DEFAULT_CARE_PLAN_SYNC,
        help="--soap-plan-update-check 用の設定（既定: config/care_plan_sync.yaml）",
    )
    args = p.parse_args()

    rules_doc = load_yaml(args.rules)
    text = args.text.read_text(encoding="utf-8")
    profile = None
    if args.patient:
        prof_path = PATIENTS_DIR / args.patient / "profile.yaml"
        if prof_path.is_file():
            profile = load_yaml(prof_path)

    findings = run_rules(rules_doc, text)
    append_standing_order_checks(findings, text, profile, args.check_standing_orders)
    if args.soap_plan_update_check:
        findings.extend(_care_plan_soap_check(text, args.care_plan_sync))
    report = {
        "rules_version": rules_doc.get("version"),
        "patient": args.patient or None,
        "findings": findings,
        "pass_all": len(findings) == 0,
        "plan_update_required": any(
            f.get("rule_id") == "plan_revision_required" for f in findings
        ),
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"ルール版: {report['rules_version']} 患者: {report['patient']}")
        if not findings:
            print("指摘なし（設定済みルール範囲）。")
        else:
            for f in findings:
                print(f"[{f['severity']}] {f['rule_id']}: {f['name']} — {f['detail']}")


if __name__ == "__main__":
    main()
