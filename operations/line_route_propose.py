#!/usr/bin/env python3
"""
訪問予定と座標・スキルを照合し、担当者別の訪問順（ライン表）を貪欲法で提案する。

厳密なVRP最適化ではなく、移動距離（球面距離）の局所改善用のたたき台。
出力はカイポケ連携用中間形式に近い JSON/CSV へ拡張可能。

使用例:
  python operations/line_route_propose.py ^
    --visits data/schedule/_template/visits_day_example.csv ^
    --locations data/schedule/_template/locations_example.yaml ^
    --roster data/staff/_template/staff_roster.yaml.example ^
    --date 2026-04-07
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Any

import yaml


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_visits_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def staff_skills_map(roster_doc: dict[str, Any]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for s in roster_doc.get("staff") or []:
        sid = str(s.get("staff_id") or "")
        skills = s.get("skills") or []
        out[sid] = set(str(x) for x in skills)
    return out


def greedy_order(
    visits: list[dict[str, Any]],
    locs: dict[str, Any],
    office: dict[str, float],
) -> tuple[list[dict[str, Any]], float]:
    """visit dicts に patient_lat, patient_lon を付与済みとする。"""
    if not visits:
        return [], 0.0
    remaining = visits[:]
    olat, olon = office["lat"], office["lon"]
    ordered: list[dict[str, Any]] = []
    total_km = 0.0
    cur_lat, cur_lon = olat, olon

    while remaining:
        best_i = 0
        best_d = float("inf")
        for i, v in enumerate(remaining):
            d = haversine_km(cur_lat, cur_lon, v["patient_lat"], v["patient_lon"])
            if d < best_d:
                best_d = d
                best_i = i
        nxt = remaining.pop(best_i)
        total_km += best_d
        ordered.append(nxt)
        cur_lat, cur_lon = nxt["patient_lat"], nxt["patient_lon"]

    total_km += haversine_km(cur_lat, cur_lon, olat, olon)
    return ordered, total_km


def main() -> int:
    p = argparse.ArgumentParser(description="訪問ライン（順路）提案")
    p.add_argument("--visits", type=Path, required=True)
    p.add_argument("--locations", type=Path, required=True)
    p.add_argument("--roster", type=Path, required=True, help="スキル照合用 staff_roster.yaml")
    p.add_argument("--date", type=str, required=True)
    p.add_argument("--out", type=Path, help="JSON 出力先")
    args = p.parse_args()

    loc_doc = load_yaml(args.locations)
    office = loc_doc.get("office") or {}
    if "lat" not in office or "lon" not in office:
        print("locations.yaml に office.lat / office.lon が必要です。", file=sys.stderr)
        return 2

    patients = loc_doc.get("patients") or {}
    roster = load_yaml(args.roster)
    skills_map = staff_skills_map(roster)

    raw_visits = load_visits_csv(args.visits)
    day_visits = [v for v in raw_visits if (v.get("date") or "").strip() == args.date]

    enriched: list[dict[str, Any]] = []
    skill_issues: list[str] = []

    for v in day_visits:
        pid = (v.get("patient_id") or "").strip()
        sid = (v.get("staff_id") or "").strip()
        if not sid:
            continue
        req = (v.get("required_skill") or "").strip()
        pt = patients.get(pid)
        if not pt:
            print(f"[SKIP] 座標なし patient_id={pid}", file=sys.stderr)
            continue
        st_sk = skills_map.get(sid, set())
        if req and req not in st_sk:
            skill_issues.append(
                f"visit {v.get('visit_id')}: staff {sid} に skill '{req}' なし"
            )
        enriched.append(
            {
                **v,
                "patient_lat": float(pt["lat"]),
                "patient_lon": float(pt["lon"]),
            }
        )

    by_staff: dict[str, list[dict[str, Any]]] = {}
    for v in enriched:
        sid = v["staff_id"]
        by_staff.setdefault(sid, []).append(v)

    proposal: dict[str, Any] = {
        "date": args.date,
        "lines": [],
        "skill_warnings": skill_issues,
    }

    for sid, lst in sorted(by_staff.items()):
        # 時刻でソートしてから貪欲（時間窓の粗い尊重）
        def sort_key(x: dict[str, Any]) -> str:
            return x.get("start_time") or "99:99"

        lst_sorted = sorted(lst, key=sort_key)
        ordered, km = greedy_order(lst_sorted, patients, office)
        proposal["lines"].append(
            {
                "staff_id": sid,
                "visit_order": [x.get("visit_id") for x in ordered],
                "ordered_visits": ordered,
                "approx_route_km": round(km, 3),
            }
        )

    text = json.dumps(proposal, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"保存: {args.out}")
    else:
        print(text)

    for s in skill_issues:
        print(f"[SKILL] {s}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
