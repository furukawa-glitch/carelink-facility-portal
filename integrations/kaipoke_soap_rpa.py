#!/usr/bin/env python3
"""
カイポケ 看護／介護記録画面：観察記録へ SOAP を自動入力する RPA（Playwright）。

画面解析（複数スクリーンショットの合意）
----------------------------------------
対象URLの例: ``https://r.kaipoke.biz/bizhnc/careRecordAdd/index/`` （環境により
``bizhc`` 等パスが異なる場合あり）

1. 左サイドバーで「観察記録」を押す
   - 記録書Ⅱ・新規作成では、初期表示が「訪問概要」など別タブのことがある。
     その場合は必ず「観察記録」をクリックして、本文入力ブロックを表示する。
   - すでに「観察記録」が選択済みで大きな自由記述欄が見えていれば
     ``--skip-nav-click`` でナビ操作を省略できる。

2. 入力枠（推奨）
   - メイン領域の見出し「観察記録」直下の、大きな複数行テキストエリア。
   - システムに S/O/A/P の独立欄が無いため、
     ``[S]… [O]… [A]… [P]…`` など1本のテキストに連結して入力する。

   補足（別画面での差分）:
   - 「バイタルサイン」選択時、数値欄の下に大きな空欄がある画面があるが、
     これはバイタル付近のメモ用で、SOAP 本体は「観察記録」欄に寄せるのが無難。
   - 「管理・指導」はチェック＋短い1行枠が主で、長文 SOAP の主フィールドではない。
   - 「リハビリテーション」下にも複数行枠があるが、リハ用メモ想定。SOAP 全体は観察記録へ。

3. 保存
   - 画面下部の「登録する」（オレンジ／黄色系）をクリックして確定。
   - 「戻る」「直近の記録をコピー」「印刷する」は SOAP 投入の必須操作ではない。

注意: ログイン・利用者選択・帳票メニュー（個別帳票→看護記録書II 等）は環境依存。
本スクリプトは「記録フォームが表示された URL」からの操作を想定する。
利用規約・セキュリティポリシーを確認のうえ利用すること。

使い方（例）::
    pip install -r integrations/requirements-kaipoke-rpa.txt
    playwright install chromium
    # 一度手動ログインして storage state を保存（推奨）
    python integrations/kaipoke_soap_rpa.py --start-url "https://..." --soap-file draft.txt --storage-state kaipoke_state.json
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


def _read_soap_text(path: Path | None, inline: str | None) -> str:
    if inline is not None:
        return inline
    if path is None:
        raise SystemExit("--soap-file または --soap-text のどちらかを指定してください。")
    raw = path.read_text(encoding="utf-8-sig")
    return raw.strip("\ufeff").rstrip()


def _click_sidebar_label(page, label: str) -> bool:
    """左ナビ相当の「label」テキストをクリック。見つからなければ False。"""
    pattern = re.compile(rf"^\s*{re.escape(label)}\s*$")
    candidates = [
        lambda: page.get_by_role("link", name=pattern),
        lambda: page.get_by_role("button", name=re.compile(re.escape(label))),
        lambda: page.get_by_role("tab", name=re.compile(re.escape(label))),
        lambda: page.get_by_role("menuitem", name=re.compile(re.escape(label))),
        lambda: page.locator("a,button,[role='button']").filter(has_text=pattern),
        lambda: page.locator("aside").get_by_text(label, exact=True),
        lambda: page.locator("nav").get_by_text(label, exact=True),
    ]
    for factory in candidates:
        try:
            loc = factory()
            if loc.count() == 0:
                continue
            target = loc.first
            if target.is_visible(timeout=500):
                target.scroll_into_view_if_needed(timeout=3000)
                target.click(timeout=5000)
                page.wait_for_timeout(400)
                return True
        except (PlaywrightError, PlaywrightTimeoutError):
            continue
    return False


def _click_observation_nav(page) -> bool:
    return _click_sidebar_label(page, "観察記録")


def _find_observation_textarea(page):
    """「観察記録」見出しに近い textarea を優先。複数ある場合は最も広い入力欄を選ぶ。"""
    # 見出し直後の textarea（一般的なパターン）
    xpath_after_heading = (
        "(//*[self::h1 or self::h2 or self::h3 or self::h4 or self::div or self::span]"
        "[contains(normalize-space(.),'観察記録')])[1]/following::textarea[1]"
    )
    loc = page.locator(f"xpath={xpath_after_heading}")
    if loc.count() > 0 and loc.first.is_visible(timeout=800):
        return loc.first

    # ラベル「観察記録」に紐づく textarea（フォーム実装次第）
    try:
        by_label = page.get_by_label(re.compile(r"観察記録"))
        if by_label.count() > 0:
            el = by_label.first
            if el.evaluate("e => e.tagName === 'TEXTAREA'"):
                return el
    except PlaywrightError:
        pass

    all_ta = page.locator("textarea:visible")
    n = all_ta.count()
    if n == 1:
        return all_ta.first
    if n == 0:
        return None

    # 複数: 面積最大を選ぶ（観察記録がメインの大きい枠である想定）
    best = None
    best_area = -1
    for i in range(n):
        ta = all_ta.nth(i)
        try:
            box = ta.bounding_box()
            if not box:
                continue
            area = box["width"] * box["height"]
            if area > best_area:
                best_area = area
                best = ta
        except PlaywrightError:
            continue
    return best


def _click_register(page) -> None:
    reg = page.get_by_role("button", name=re.compile(r"登録する"))
    if reg.count() == 0:
        reg = page.get_by_role("link", name=re.compile(r"登録する"))
    if reg.count() == 0:
        raise SystemExit("「登録する」ボタンが見つかりません。セレクタの調整が必要です。")
    btn = reg.last
    btn.scroll_into_view_if_needed(timeout=10000)
    btn.click(timeout=15000)


def run(
    start_url: str,
    soap: str,
    *,
    headed: bool,
    storage_state: Path | None,
    skip_nav_click: bool,
    no_submit: bool,
    slow_mo_ms: int,
    pause: bool,
) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed, slow_mo=slow_mo_ms)
        context_kwargs: dict = {}
        if storage_state and storage_state.is_file():
            context_kwargs["storage_state"] = str(storage_state)
        context = browser.new_context(**context_kwargs)
        page = context.new_page()
        page.goto(start_url, wait_until="domcontentloaded", timeout=60000)

        if pause:
            page.pause()

        if not skip_nav_click:
            _click_observation_nav(page)

        textarea = _find_observation_textarea(page)
        if textarea is None:
            raise SystemExit(
                "観察記録用の textarea が特定できませんでした。"
                " --pause で DevTools 付きのウィンドウを止め、DOM を確認してセレクタを調整してください。"
            )

        textarea.click(timeout=10000)
        textarea.fill(soap)

        if no_submit:
            print("入力のみ完了（--no-submit）。ブラウザを手で確認してください。")
            if pause:
                page.pause()
            context.close()
            browser.close()
            return

        _click_register(page)
        print("「登録する」をクリックしました。確認ダイアログやエラー表示がないか画面で確認してください。")

        if pause:
            page.pause()
        context.close()
        browser.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="カイポケ 観察記録へ SOAP を入力（Playwright RPA）")
    parser.add_argument(
        "--start-url",
        required=True,
        help="記録フォームが開いた状態のURL（ログイン済みセッションまたは --storage-state 併用）",
    )
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--soap-file", type=Path, help="SOAP 全文（UTF-8）のファイルパス")
    g.add_argument("--soap-text", help="コマンドライン直指定（短いテスト用）")
    parser.add_argument(
        "--headless",
        action="store_true",
        help="ブラウザを非表示で実行（既定は表示。デバッグ時は表示のまま推奨）",
    )
    parser.add_argument("--storage-state", type=Path, help="Playwright storage state JSON（ログイン維持）")
    parser.add_argument(
        "--skip-nav-click",
        action="store_true",
        help="左サイドの「観察記録」クリックを省略（既に該当ブロック表示中）",
    )
    parser.add_argument("--no-submit", action="store_true", help="入力のみ行い登録しない")
    parser.add_argument("--slow-mo", type=int, default=0, metavar="MS", help="操作間隔ミリ秒（デバッグ用）")
    parser.add_argument("--pause", action="store_true", help="Playwright Inspector で一時停止")
    args = parser.parse_args(argv)

    soap = _read_soap_text(args.soap_file, args.soap_text)
    if not soap.strip():
        print("SOAP が空です。", file=sys.stderr)
        return 2

    run(
        args.start_url,
        soap,
        headed=not args.headless,
        storage_state=args.storage_state,
        skip_nav_click=args.skip_nav_click,
        no_submit=args.no_submit,
        slow_mo_ms=args.slow_mo,
        pause=args.pause,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
