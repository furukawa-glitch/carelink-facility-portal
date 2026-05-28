"""
カイポケ・MCS 向け Selenium クローラーの共通ランタイム（設計・骨子）。

方針（ローカル PC → 将来 VPS 24h）:
  - URL・認証情報は**環境変数または .env（Git 禁止）**のみ。コードにハードコードしない。
  - ブラウザ: ローカルは headed デバッグ可、VPS は CHROME_HEADLESS=1 + 公式 Chrome/Chromium。
  - セッション: user-data-dir を永続ボリュームにマウントすればログイン状態を維持しやすい。

環境変数（例）:
  CARELINK_BROWSER       chromium | chrome | firefox（既定 chromium）
  CHROME_HEADLESS        1 で headless
  CHROME_USER_DATA_DIR   プロファイル永続化パス（VPSでは Docker volume 推奨）
  KAIPOKE_LOGIN_URL      ログインページ URL（テナントごと）
  MCS_LOGIN_URL
  # パスワードは環境変数に載せるより、初回のみ手動ログイン＋storage 保存を推奨

実装時は integrations/kaipoke_crawler.py, integrations/mcs_crawler.py 等に分割し、
本モジュールから get_driver() を import して共通化する。

依存（未インストールでも本ファイルの import は可能）::
  pip install selenium webdriver-manager
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def env_bool(key: str, default: bool = False) -> bool:
    v = os.environ.get(key, "").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return default


def get_chrome_options():
    """Selenium 4 Chrome Options（headless・ユーザデータdir）。"""
    try:
        from selenium.webdriver.chrome.options import Options
    except ImportError as e:
        raise RuntimeError(
            "selenium が未インストールです: pip install selenium webdriver-manager"
        ) from e

    opts = Options()
    if env_bool("CHROME_HEADLESS"):
        opts.add_argument("--headless=new")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1400,900")
    opts.add_argument("--lang=ja-JP")

    ud = os.environ.get("CHROME_USER_DATA_DIR", "").strip()
    if ud:
        Path(ud).mkdir(parents=True, exist_ok=True)
        opts.add_argument(f"--user-data-dir={ud}")

    return opts


def create_chrome_driver():
    """Chrome WebDriver を生成（webdriver-manager でドライバ自動解決）。"""
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.service import Service
        from webdriver_manager.chrome import ChromeDriverManager
    except ImportError as e:
        raise RuntimeError(
            "selenium / webdriver-manager が必要です: pip install selenium webdriver-manager"
        ) from e

    service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=get_chrome_options())


__all__ = ["env_bool", "get_chrome_options", "create_chrome_driver"]
