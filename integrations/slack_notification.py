#!/usr/bin/env python3
"""
CareLink — Slack 通知エンジン（エラー・完了報告など）

ローカル / 将来の VPS 共通のため、**環境変数のみ**で設定する（12-factor）。

認証方式（どちらか一方）:
  A) Incoming Webhook … SLACK_WEBHOOK_URL のみ（追加 pip 不要）
  B) Bot Token … SLACK_BOT_TOKEN + SLACK_CHANNEL_ID（要: pip install slack-sdk）

環境変数:
  SLACK_ENABLED     0/false/no で送信しない（dry-run 相当）
  SLACK_WEBHOOK_URL Incoming Webhook URL
  SLACK_BOT_TOKEN   xoxb-...（chat:write スコープ）
  SLACK_CHANNEL_ID  C01234567 またはチャンネル名（Web API 時）

テスト送信::
  set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
  python integrations/slack_notification.py --test

  # または Bot
  set SLACK_BOT_TOKEN=xoxb-...
  set SLACK_CHANNEL_ID=C...
  python integrations/slack_notification.py --test
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


def _truthy(name: str, default: bool = True) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if v in ("0", "false", "no", "off", "disabled"):
        return False
    if v in ("1", "true", "yes", "on", "enabled"):
        return True
    return default


@dataclass
class SlackNotifyResult:
    ok: bool
    mode: str
    detail: str


def _post_webhook(url: str, payload: dict[str, Any], timeout: int = 30) -> SlackNotifyResult:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status != 200:
                return SlackNotifyResult(False, "webhook", f"HTTP {resp.status}: {body}")
            # Webhook は ok なら "ok" が返ることが多い
            return SlackNotifyResult(True, "webhook", body or "ok")
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        return SlackNotifyResult(False, "webhook", f"HTTP {e.code}: {err}")
    except OSError as e:
        return SlackNotifyResult(False, "webhook", str(e))


def _post_web_api(token: str, channel: str, text: str, timeout: int = 30) -> SlackNotifyResult:
    try:
        from slack_sdk import WebClient  # type: ignore
        from slack_sdk.errors import SlackApiError  # type: ignore
    except ImportError:
        return SlackNotifyResult(
            False,
            "web_api",
            "slack-sdk が未インストールです: pip install -r integrations/requirements-slack.txt",
        )
    client = WebClient(token=token, timeout=timeout)
    try:
        r = client.chat_postMessage(channel=channel, text=text)
        if r["ok"]:
            return SlackNotifyResult(True, "web_api", f"ts={r.get('ts')}")
        return SlackNotifyResult(False, "web_api", str(r))
    except SlackApiError as e:
        return SlackNotifyResult(False, "web_api", str(e.response))


def notify_slack(
    text: str,
    *,
    prefix: str | None = None,
    channel: str | None = None,
) -> SlackNotifyResult:
    """
    単一メッセージを Slack へ送信。失敗時も例外にせず SlackNotifyResult を返す（バッチ向け）。
    """
    if not _truthy("SLACK_ENABLED", default=True):
        return SlackNotifyResult(True, "disabled", "SLACK_ENABLED でオフ")

    body = f"{prefix}\n{text}" if prefix else text
    wh = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if wh:
        # Webhook: text または attachments 風に blocks は省略可
        return _post_webhook(wh, {"text": body})

    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    ch = (channel or os.environ.get("SLACK_CHANNEL_ID", "")).strip()
    if token and ch:
        return _post_web_api(token, ch, body)

    return SlackNotifyResult(
        False,
        "none",
        "SLACK_WEBHOOK_URL または (SLACK_BOT_TOKEN + SLACK_CHANNEL_ID) を設定してください。",
    )


def notify_error(message: str, *, context: str | None = None) -> SlackNotifyResult:
    prefix = ":x: *CareLink エラー*"
    if context:
        prefix += f" `{context}`"
    return notify_slack(message, prefix=prefix)


def notify_success(message: str, *, context: str | None = None) -> SlackNotifyResult:
    prefix = ":white_check_mark: *CareLink 完了*"
    if context:
        prefix += f" `{context}`"
    return notify_slack(message, prefix=prefix)


def _build_test_message() -> str:
    host = socket.gethostname()
    return (
        "CareLink テスト通知です。\n"
        f"• ホスト: `{host}`\n"
        "• 本番ジョブからは `notify_error` / `notify_success` を呼び出してください。"
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Slack 通知エンジン（CareLink）")
    p.add_argument("--test", action="store_true", help="テストメッセージを1通送信")
    p.add_argument("--text", type=str, default="", help="任意の本文を送信（--test より優先）")
    p.add_argument("--error", action="store_true", help="エラー体裁で送る（--text と併用）")
    args = p.parse_args(argv)

    if args.text:
        if args.error:
            r = notify_error(args.text, context="cli")
        else:
            r = notify_slack(args.text)
    elif args.test:
        r = notify_slack(_build_test_message(), prefix=":rocket: *CareLink 接続テスト*")
    else:
        p.print_help()
        print("\n例: python integrations/slack_notification.py --test", file=sys.stderr)
        return 2

    print(f"mode={r.mode} ok={r.ok}")
    print(r.detail)
    return 0 if r.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
