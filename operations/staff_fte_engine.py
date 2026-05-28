#!/usr/bin/env python3
"""
常勤換算（FTE）計算と、基準未満時の Slack 警告。

- 契約ベース: 各スタッフの週契約時間 / fte_reference_hours_per_week を合算
- 日次シフト（任意）: CSV で date,staff_id,hours を渡し、日ごとに sum(hours)/daily_reference_hours

使用例:
  python operations/staff_fte_engine.py --roster data/staff/_template/staff_roster.yaml.example
  python operations/staff_fte_engine.py --roster ... --shifts data/staff/_template/shifts_day_example.csv --slack
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]


def _load_slack():
    path = ROOT / "integrations" / "slack_notification.py"
    spec = importlib.util.spec_from_file_location("slack_notification", path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_roster(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def fte_per_staff_member(entry: dict[str, Any], ref_hours: float) -> float:
    et = (entry.get("employment_type") or "").strip().lower()
    wh = float(entry.get("weekly_contract_hours") or 0)
    if et == "full_time":
        if wh <= 0:
            wh = ref_hours
        return min(1.0, wh / ref_hours)
    if et == "part_time":
        if wh <= 0:
            return 0.0
        return wh / ref_hours
    return 0.0


def compute_contractual_fte(roster_doc: dict[str, Any]) -> tuple[float, list[dict[str, Any]]]:
    org = roster_doc.get("org") or {}
    ref = float(org.get("fte_reference_hours_per_week") or 40)
    rows = []
    total = 0.0
    for s in roster_doc.get("staff") or []:
        f = fte_per_staff_member(s, ref)
        total += f
        rows.append(
            {
                "staff_id": s.get("staff_id"),
                "employment_type": s.get("employment_type"),
                "weekly_hours": s.get("weekly_contract_hours"),
                "fte": round(f, 4),
            }
        )
    return total, rows


def load_shift_hours_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def daily_fte_from_shifts(
    rows: list[dict[str, str]], daily_ref: float
) -> dict[str, float]:
    """date -> FTE day equivalents."""
    by_date: dict[str, float] = defaultdict(float)
    for r in rows:
        d = (r.get("date") or "").strip()
        try:
            h = float(r.get("hours") or 0)
        except ValueError:
            continue
        if d:
            by_date[d] += h / daily_ref if daily_ref > 0 else 0.0
    return dict(by_date)


def main() -> int:
    p = argparse.ArgumentParser(description="常勤換算（FTE）計算・Slack警告")
    p.add_argument("--roster", type=Path, required=True, help="staff_roster.yaml")
    p.add_argument("--shifts", type=Path, help="日次シフト CSV（date,staff_id,hours）複数可")
    p.add_argument(
        "--slack",
        action="store_true",
        help="基準未満なら Slack notify_error（環境変数未設定時は stderr のみ）",
    )
    p.add_argument("--json", action="store_true", help="要約を JSON で出力")
    args = p.parse_args()

    doc = load_roster(args.roster)
    org = doc.get("org") or {}
    min_c = float(org.get("min_fte_contractual") or 2.5)
    min_d = float(org.get("min_fte_daily_shift") or 2.5)
    daily_ref = float(org.get("daily_reference_hours") or 8)

    total_fte, breakdown = compute_contractual_fte(doc)
    warnings: list[str] = []

    if total_fte < min_c:
        warnings.append(
            f"契約ベース合計FTEが基準未満: {total_fte:.3f} < {min_c}（要: 人員配置の確認）"
        )

    daily_map: dict[str, float] = {}
    if args.shifts:
        rows = load_shift_hours_csv(args.shifts)
        daily_map = daily_fte_from_shifts(rows, daily_ref)
        for d, v in sorted(daily_map.items()):
            if v < min_d:
                warnings.append(
                    f"日次シフト換算が基準未満: {d} → {v:.3f} FTE日換算 < {min_d}"
                )

    if args.json:
        import json

        print(
            json.dumps(
                {
                    "contractual_fte_total": round(total_fte, 4),
                    "min_fte_contractual": min_c,
                    "daily_fte": daily_map,
                    "min_fte_daily_shift": min_d,
                    "warnings": warnings,
                    "breakdown": breakdown,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(f"契約ベース合計 FTE: {total_fte:.3f}（基準 {min_c}）")
        for b in breakdown:
            print(f"  {b['staff_id']}: {b['employment_type']} → FTE {b['fte']}")
        if daily_map:
            print("日次シフト換算（FTE日換算）:")
            for d, v in sorted(daily_map.items()):
                flag = " **要確認**" if v < min_d else ""
                print(f"  {d}: {v:.3f}{flag}")
        for w in warnings:
            print(f"[WARN] {w}", file=sys.stderr)

    if warnings and args.slack:
        slack = _load_slack()
        if slack:
            msg = "\n".join(warnings)
            r = slack.notify_error(msg, context="staff_fte_engine")
            print(f"slack: ok={r.ok} mode={r.mode} {r.detail}", file=sys.stderr)
        else:
            print("[WARN] slack モジュールを読み込めません", file=sys.stderr)

    return 1 if warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())
