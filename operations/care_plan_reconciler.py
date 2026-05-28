#!/usr/bin/env python3
"""
居宅サービス計画書（テキスト／画像OCR）と訪問看護計画書の照合、および
SOAP から「計画書更新の必要あり」フラグを立てる。

CareLink 標準ルールの実装本体。詳細は docs/care_plan_reconciliation_standard.md

使用例:
  python operations/care_plan_reconciler.py compare --home a.txt --visit b.txt
  python operations/care_plan_reconciler.py soap-flag --text soap.md
  python operations/care_plan_reconciler.py ocr --image scan.png --out careplan.txt
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SYNC = ROOT / "config" / "care_plan_sync.yaml"
PATIENTS = ROOT / "data" / "patients"


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def normalize_jp(text: str) -> str:
    t = unicodedata.normalize("NFKC", text)
    t = t.replace("\u3000", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def ocr_image_to_text(image_path: Path, lang: str = "jpn") -> str:
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError as e:
        raise SystemExit(
            "OCR には Python パッケージ pillow, pytesseract と、"
            "システムに Tesseract-OCR（日本語データ）のインストールが必要です。"
        ) from e
    img = Image.open(image_path)
    return pytesseract.image_to_string(img, lang=lang)


def soap_plan_update_findings(soap_text: str, cfg: dict[str, Any]) -> list[dict[str, Any]]:
    block = cfg.get("soap_plan_update_triggers") or {}
    kws = block.get("any_keywords") or []
    sev = block.get("severity", "error")
    t = normalize_jp(soap_text)
    hit = [k for k in kws if k in t]
    if not hit:
        return []
    return [
        {
            "rule_id": "plan_revision_required",
            "severity": sev,
            "name": "計画書更新の必要あり（CareLink標準）",
            "detail": (
                "SOAPに状態変化・区分変更等のトリガー語が検出された: "
                + ", ".join(hit[:12])
                + (" …" if len(hit) > 12 else "")
                + " → 居宅ケアプラン・訪問看護計画書の見直し・同期を確認すること。"
            ),
            "plan_update_required": True,
            "matched_keywords": hit,
        }
    ]


def _as_list(x: Any) -> list[str]:
    if x is None:
        return []
    if isinstance(x, str):
        return [x]
    return [str(i) for i in x]


def check_contradictions(
    home_n: str, visit_n: str, pairs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in pairs:
        pid = p.get("id", "contradiction")
        left = _as_list(p.get("left"))
        right = _as_list(p.get("right"))
        detail = p.get("detail", "")
        l_hit = [x for x in left if x in home_n]
        r_hit = [x for x in right if x in visit_n]
        if l_hit and r_hit:
            out.append(
                {
                    "rule_id": f"care_plan_contradiction_{pid}",
                    "severity": "error",
                    "name": "計画間の矛盾候補",
                    "detail": f"{detail}（居宅側: {l_hit[:3]} / 訪問看護側: {r_hit[:3]}）",
                }
            )
        # 逆方向（看護が左寄り・居宅が右寄りのパターン）
        l2 = [x for x in left if x in visit_n]
        r2 = [x for x in right if x in home_n]
        if l2 and r2:
            out.append(
                {
                    "rule_id": f"care_plan_contradiction_{pid}_rev",
                    "severity": "error",
                    "name": "計画間の矛盾候補（記載方向逆）",
                    "detail": f"{detail}（訪問看護側: {l2[:3]} / 居宅側: {r2[:3]}）",
                }
            )
    return out


def check_must_reflect(home_n: str, visit_n: str, keywords: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for kw in keywords:
        if kw in home_n and kw not in visit_n:
            out.append(
                {
                    "rule_id": "care_plan_omission_visit",
                    "severity": "error",
                    "name": "訪問看護計画書への反映漏れ候補",
                    "detail": f"居宅計画に「{kw}」があるが、訪問看護計画テキストに同一語が見当たらない（正規化後一致）。",
                }
            )
    return out


def check_line_coverage(
    home_raw: str, visit_n: str, line_cfg: dict[str, Any]
) -> list[dict[str, Any]]:
    if not line_cfg.get("enabled"):
        return []
    min_len = int(line_cfg.get("min_home_line_length", 12))
    thresh = float(line_cfg.get("similarity_threshold", 0.62))
    max_lines = int(line_cfg.get("max_home_lines_to_scan", 80))

    home_lines = [
        normalize_jp(L)
        for L in home_raw.splitlines()
        if len(normalize_jp(L)) >= min_len and not re.match(r"^\s*[#＃]", L)
    ]
    findings: list[dict[str, Any]] = []
    for i, hl in enumerate(home_lines[:max_lines]):
        best = 0.0
        for vl in visit_n.split("。"):
            vl = vl.strip()
            if len(vl) < min_len:
                continue
            r = difflib.SequenceMatcher(a=hl, b=vl).ratio()
            if r > best:
                best = r
        if best < thresh:
            snippet = hl[:70] + ("…" if len(hl) > 70 else "")
            findings.append(
                {
                    "rule_id": "care_plan_line_gap",
                    "severity": "warning",
                    "name": "文面一致度が低い居宅計画の行（漏れ・様式差の可能性）",
                    "detail": f"類似度{best:.2f}（閾値{thresh}）行: 「{snippet}」",
                }
            )
    return findings


def compare_plans(home_text: str, visit_text: str, cfg: dict[str, Any]) -> list[dict[str, Any]]:
    home_n = normalize_jp(home_text)
    visit_n = normalize_jp(visit_text)
    findings: list[dict[str, Any]] = []

    must = cfg.get("home_must_reflect_in_visit") or []
    findings.extend(check_must_reflect(home_n, visit_n, must))
    pairs = cfg.get("contradiction_pairs") or []
    findings.extend(check_contradictions(home_n, visit_n, pairs))
    findings.extend(
        check_line_coverage(home_text, visit_n, cfg.get("line_similarity") or {})
    )
    return findings


def cmd_compare(args: argparse.Namespace) -> None:
    cfg = load_yaml(args.config)
    home = load_text(args.home)
    visit = load_text(args.visit)
    findings = compare_plans(home, visit, cfg)
    report = {
        "kind": "care_plan_compare",
        "config_version": cfg.get("version"),
        "findings": findings,
        "pass_all": len(findings) == 0,
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"ケアプラン照合（設定版 {report['config_version']}）")
        if not findings:
            print("指摘なし（設定ルール範囲。人間による最終確認は別）。")
        else:
            for f in findings:
                print(f"[{f['severity']}] {f['rule_id']}: {f['name']}")
                print(f"    {f['detail']}")


def cmd_soap_flag(args: argparse.Namespace) -> None:
    cfg = load_yaml(args.config)
    soap = load_text(args.text)
    findings = soap_plan_update_findings(soap, cfg)
    report = {
        "kind": "soap_plan_update",
        "findings": findings,
        "plan_update_required": any(f.get("plan_update_required") for f in findings),
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        if not findings:
            print("計画書更新フラグ: オフ（SOAP内にトリガー語なし、設定範囲）。")
        else:
            for f in findings:
                print(f"[{f['severity']}] {f['rule_id']}: {f['name']}")
                print(f"    {f['detail']}")


def cmd_ocr(args: argparse.Namespace) -> None:
    text = ocr_image_to_text(args.image, lang=args.lang)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8")
    print(f"OCR結果を保存しました: {args.out}")


def cmd_patient(args: argparse.Namespace) -> None:
    """data/patients/{id}/plans/home_care_plan.txt と visit_nursing_plan.txt を照合。"""
    base = PATIENTS / args.patient / "plans"
    home_p = base / "home_care_plan.txt"
    visit_p = base / "visit_nursing_plan.txt"
    if not home_p.is_file():
        raise SystemExit(f"見つかりません: {home_p}")
    if not visit_p.is_file():
        raise SystemExit(f"見つかりません: {visit_p}")
    args.home = home_p
    args.visit = visit_p
    cmd_compare(args)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="居宅×訪問看護計画の照合・SOAP更新フラグ（CareLink標準）")
    p.add_argument("--config", type=Path, default=DEFAULT_SYNC)
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("compare", help="居宅計画テキストと訪問看護計画テキストを比較")
    c.add_argument("--home", type=Path, required=True)
    c.add_argument("--visit", type=Path, required=True)
    c.add_argument("--json", action="store_true")
    c.set_defaults(func=cmd_compare)

    s = sub.add_parser("soap-flag", help="SOAPから計画書更新トリガーを検出")
    s.add_argument("--text", type=Path, required=True)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_soap_flag)

    o = sub.add_parser("ocr", help="ケアプラン画像をOCRしてテキスト化（要 Tesseract）")
    o.add_argument("--image", type=Path, required=True)
    o.add_argument("--out", type=Path, required=True)
    o.add_argument("--lang", default="jpn")
    o.set_defaults(func=cmd_ocr)

    pt = sub.add_parser("patient", help="data/patients/{id}/plans/ 内の既定ファイル名で照合")
    pt.add_argument("--patient", type=str, required=True, help="patient_id（例 P000001）")
    pt.add_argument("--json", action="store_true")
    pt.set_defaults(func=cmd_patient)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)
    return 0


# 監査エンジンから import して再利用
def run_soap_plan_update_check(soap_text: str, config_path: Path | None = None) -> list[dict[str, Any]]:
    cfg = load_yaml(config_path or DEFAULT_SYNC)
    return soap_plan_update_findings(soap_text, cfg)


if __name__ == "__main__":
    raise SystemExit(main())
