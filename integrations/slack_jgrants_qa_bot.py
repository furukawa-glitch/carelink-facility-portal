#!/usr/bin/env python3
"""
Slack上で質問に答える Jグランツ Q&A Bot。

使い方:
  py integrations/slack_jgrants_qa_bot.py
  py integrations/slack_jgrants_qa_bot.py --debug

必要環境変数:
  SLACK_BOT_TOKEN   xoxb-...
  SLACK_APP_TOKEN   xapp-...   (Socket Mode用)

プロジェクト直下の .env に SLACK_* を書いても読み込みます（SLACK は .env を優先）。
"""

from __future__ import annotations

import argparse
import logging
import os
import re
from pathlib import Path
from typing import Any

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from jgrants_slack_watcher import _fetch_subsidies


def load_root_env() -> None:
    """プロジェクト直下 .env を読み込み。SLACK_* はファイルの値を優先。"""
    root = Path(__file__).resolve().parent.parent
    env_path = root / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if not k:
            continue
        if k in ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"):
            os.environ[k] = v
        else:
            os.environ.setdefault(k, v)


def setup_debug_logging() -> None:
    fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    logging.basicConfig(level=logging.DEBUG, format=fmt, force=True)
    for name in (
        "slack_bolt",
        "slack_bolt.app",
        "slack_sdk",
        "slack_sdk.web",
        "slack_sdk.socket_mode",
        "websocket",
        "websockets",
        "urllib3",
        "httpx",
        "asyncio",
    ):
        logging.getLogger(name).setLevel(logging.DEBUG)
    logging.getLogger("carelink.slack_qa").setLevel(logging.DEBUG)


LOG = logging.getLogger("carelink.slack_qa")


def _compact(s: Any) -> str:
    return str(s or "").strip()


def _extract_area(text: str) -> str | None:
    m = re.search(r"(愛知県|東京都|神奈川県|大阪府|福岡県|全国)", text)
    return m.group(1) if m else None


def _extract_keyword(text: str) -> str:
    cleaned = re.sub(r"<@[^>]+>", "", text).strip()
    if not cleaned:
        return "介護"
    for head in ("検索", "探して", "教えて", "補助金"):
        cleaned = cleaned.replace(head, " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "介護"


def _format_answer(keyword: str, area: str | None, rows: list[dict[str, Any]]) -> str:
    target = area or "全国"
    if not rows:
        return (
            f"「{keyword}」（地域: {target}）で募集中は見つかりませんでした。\n"
            "キーワードを広げて再検索しますか？ 例: `介護` / `サービス継続` / `物価高騰`"
        )
    lines = [f"「{keyword}」（地域: {target}）の募集中候補です。"]
    for i, r in enumerate(rows[:5], start=1):
        sid = _compact(r.get("id"))
        title = _compact(r.get("title")) or "（タイトル不明）"
        end = _compact(r.get("acceptance_end_datetime")) or "締切未設定"
        area_txt = _compact(r.get("target_area_search")) or "地域未設定"
        lines.append(f"{i}. {title}")
        lines.append(f"   - 地域: {area_txt}")
        lines.append(f"   - 締切: {end}")
        if sid:
            lines.append(f"   - 詳細: https://www.jgrants-portal.go.jp/grants/view/{sid}")
    return "\n".join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description="Slack Jグランツ Q&A Bot")
    p.add_argument("--debug", action="store_true", help="デバッグログ（Slack / Socket / HTTP 全般）")
    args = p.parse_args()

    if args.debug:
        setup_debug_logging()
        LOG.debug("debug logging enabled")

    load_root_env()

    bot_token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    app_token = os.environ.get("SLACK_APP_TOKEN", "").strip()
    if not bot_token or not app_token:
        print("SLACK_BOT_TOKEN と SLACK_APP_TOKEN を設定してください（.env または環境変数）。", flush=True)
        return 1

    LOG.info(
        "tokens: bot=%s... len=%s | app=%s... len=%s",
        bot_token[:14],
        len(bot_token),
        app_token[:14],
        len(app_token),
    )

    app = App(token=bot_token, logger=LOG if args.debug else None)

    @app.middleware
    def log_incoming_request(logger, body, next):
        if args.debug:
            try:
                keys = list(body.keys()) if isinstance(body, dict) else None
                LOG.debug("event type=%s body_keys=%s", body.get("type") if isinstance(body, dict) else None, keys)
            except Exception as e:
                LOG.debug("middleware log err: %s", e)
        return next()

    @app.event("app_mention")
    def on_mention(event, say, logger):
        logger.info("app_mention event: %s", event)
        text = _compact(event.get("text"))
        keyword = _extract_keyword(text)
        area = _extract_area(text)
        rows = _fetch_subsidies(keyword, acceptance=1, area=area)
        say(_format_answer(keyword, area, rows))

    @app.message(re.compile(r"^(補助金|jgrants|Jグランツ|助成金).*$"))
    def on_message(message, say, logger):
        logger.info("message event: %s", message)
        text = _compact(message.get("text"))
        keyword = _extract_keyword(text)
        area = _extract_area(text)
        rows = _fetch_subsidies(keyword, acceptance=1, area=area)
        say(_format_answer(keyword, area, rows))

    print("Slack JGrants Q&A bot starting (Socket Mode)...", flush=True)
    handler = SocketModeHandler(app, app_token)
    if args.debug:
        LOG.debug("SocketModeHandler created; connecting...")
    handler.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

