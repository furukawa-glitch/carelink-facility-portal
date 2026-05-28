#!/usr/bin/env python3
"""
Jグランツ補助金ウォッチャー（CareLink向け）

- Jグランツ公開APIを検索
- 条件に合う「新着IDのみ」をSlackへ通知
- 既通知IDは state ファイルで管理

使い方（まずはテスト）:
  python integrations/jgrants_slack_watcher.py --dry-run
  python integrations/jgrants_slack_watcher.py
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from slack_notification import notify_slack

API_BASE_URL = "https://api.jgrants-portal.go.jp/exp/v1/public/subsidies"
STATE_DEFAULT = Path(__file__).with_name("jgrants_watcher_state.json")


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return [x.strip() for x in raw.split(",") if x.strip()]


def _fetch_subsidies(keyword: str, *, acceptance: int, area: str | None = None) -> list[dict[str, Any]]:
    params = {
        "keyword": keyword,
        "sort": "acceptance_end_datetime",
        "order": "ASC",
        "acceptance": str(acceptance),
    }
    if area:
        params["target_area_search"] = area
    url = f"{API_BASE_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "CareLink-Jgrants-Watcher/1.0"})
    with urllib.request.urlopen(req, timeout=30) as res:
        payload = json.loads(res.read().decode("utf-8", errors="replace"))
    if not isinstance(payload, dict):
        return []
    items = payload.get("result")
    return items if isinstance(items, list) else []


def _load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"seen_ids": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"seen_ids": []}


def _save_state(path: Path, seen_ids: set[str]) -> None:
    body = {
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "seen_ids": sorted(seen_ids),
    }
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")


def _build_message(rows: list[dict[str, Any]]) -> str:
    lines = ["介護系補助金の新着候補を検出しました。"]
    for i, r in enumerate(rows, start=1):
        sid = str(r.get("id", "")).strip()
        title = str(r.get("title", "")).strip() or "（タイトル不明）"
        area = str(r.get("target_area_search", "")).strip() or "地域未設定"
        end = str(r.get("acceptance_end_datetime", "")).strip() or "締切未設定"
        url = f"https://www.jgrants-portal.go.jp/grants/view/{sid}" if sid else ""
        lines.append(f"{i}. {title}")
        lines.append(f"   - 地域: {area}")
        lines.append(f"   - 締切: {end}")
        if url:
            lines.append(f"   - 詳細: {url}")
    return "\n".join(lines)


def run(*, dry_run: bool, reset: bool) -> int:
    keywords = _env_list(
        "JGRANTS_KEYWORDS",
        ["介護", "介護施設", "介護 物価高騰", "サービス継続", "介護 ICT", "介護 生産性向上"],
    )
    area = os.environ.get("JGRANTS_TARGET_AREA", "").strip() or None
    acceptance = 1 if _env_bool("JGRANTS_ACCEPTANCE_ONLY", True) else 0
    state_path = Path(os.environ.get("JGRANTS_WATCHER_STATE", str(STATE_DEFAULT))).expanduser()

    state = {"seen_ids": []} if reset else _load_state(state_path)
    seen_ids = {str(x) for x in state.get("seen_ids", []) if str(x).strip()}

    collected: list[dict[str, Any]] = []
    dedup: set[str] = set()
    for kw in keywords:
        for item in _fetch_subsidies(kw, acceptance=acceptance, area=area):
            sid = str(item.get("id", "")).strip()
            if not sid or sid in dedup:
                continue
            dedup.add(sid)
            collected.append(item)

    # 介護/福祉ワードをタイトルに含む候補を優先
    filtered = [
        x
        for x in collected
        if ("介護" in str(x.get("title", ""))) or ("福祉" in str(x.get("title", "")))
    ]
    candidates = filtered if filtered else collected

    new_rows = [r for r in candidates if str(r.get("id", "")).strip() not in seen_ids]
    if not new_rows:
        print("新着なし（通知対象なし）")
        return 0

    msg = _build_message(new_rows[:8])
    if dry_run:
        print("[dry-run] 以下をSlack送信予定:\n")
        print(msg)
    else:
        r = notify_slack(msg, prefix=":mega: *CareLink 補助金ウォッチ*")
        if not r.ok:
            print(f"Slack送信失敗: {r.mode} {r.detail}")
            return 1
        print(f"Slack送信成功: {r.mode} {r.detail}")

    for row in new_rows:
        sid = str(row.get("id", "")).strip()
        if sid:
            seen_ids.add(sid)
    _save_state(state_path, seen_ids)
    print(f"state更新: {state_path}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Jグランツ新着をSlackへ通知")
    p.add_argument("--dry-run", action="store_true", help="Slackに送らず本文のみ表示")
    p.add_argument("--reset", action="store_true", help="既通知状態を無視して再通知対象にする")
    args = p.parse_args()
    return run(dry_run=args.dry_run, reset=args.reset)


if __name__ == "__main__":
    raise SystemExit(main())

