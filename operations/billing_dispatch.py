#!/usr/bin/env python3
"""
カイポケ一括請求PDFの利用者別分割、LINE登録者リストとの仕分け、送信ログ、失敗時Slack通知。

前提:
  - pip install -r integrations/requirements-billing.txt
  - Slack: integrations/SLACK_SETUP.md（SLACK_WEBHOOK_URL）
  - LINE: LINE_CHANNEL_ACCESS_TOKEN（長期トークン）。Channel Secret では push できない。
  - 拠点で絞る: --office 北名古屋（line_users.csv の office 列と照合）

使用例:
  python operations/billing_dispatch.py run --input data/billing/inbox/bulk.pdf \\
      --line-csv data/billing/line_users.csv --work-dir data/billing/work/run1 \\
      --office 北名古屋
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import re
import shutil
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[1]


def _load_slack_notify():
    path = ROOT / "integrations" / "slack_notification.py"
    spec = importlib.util.spec_from_file_location("slack_notification", path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def normalize_key(s: str) -> str:
    t = unicodedata.normalize("NFKC", s)
    t = re.sub(r"\s+", "", t)
    return t.strip()


def extract_patient_name(page_text: str) -> str | None:
    """PDF1ページのテキストから利用者名らしき文字列を推定。"""
    if not page_text:
        return None
    lines = page_text.replace("\r", "\n").split("\n")
    blob = "\n".join(lines[:40])

    patterns = [
        re.compile(r"利用者\s*名?\s*[:：]\s*(.+?)(?:\n|$)"),
        re.compile(r"ご利用者\s*[:：]\s*(.+?)(?:\n|$)"),
        re.compile(r"利用者\s*[:：]\s*(.+?)(?:\n|$)"),
        re.compile(r"([一-龥々ヶ・　\s]{2,30})\s*様"),
    ]
    for pat in patterns:
        m = pat.search(blob)
        if m:
            raw = m.group(1).strip()
            raw = re.split(r"[\n\r]", raw)[0].strip()
            raw = re.sub(r"\s*様\s*$", "", raw)
            if len(raw) >= 2:
                return raw
    return None


def safe_filename(name: str) -> str:
    n = normalize_key(name)
    n = re.sub(r'[\\/:*?"<>|]', "_", n)
    return n[:120] or "unknown"


def split_pdf_by_patient(
    input_pdf: Path,
    split_dir: Path,
) -> list[tuple[str, Path]]:
    """
    連続ページで同一利用者名とみなしてマージ。名前不明のページは直前のグループに吸収、なければ unknown_N。
    戻り値: (表示名, 出力PDFパス) のリスト
    """
    reader = PdfReader(str(input_pdf))
    n_pages = len(reader.pages)
    page_names: list[str | None] = []
    for i in range(n_pages):
        try:
            txt = reader.pages[i].extract_text() or ""
        except Exception:
            txt = ""
        page_names.append(extract_patient_name(txt))

    groups: list[tuple[str, list[int]]] = []
    current_label: str | None = None
    current_indices: list[int] = []

    def flush() -> None:
        nonlocal current_label, current_indices
        if not current_indices:
            return
        label = current_label or f"unknown_{current_indices[0]}"
        groups.append((label, current_indices[:]))
        current_indices = []
        current_label = None

    for i, name in enumerate(page_names):
        if name:
            norm = name.strip()
            if current_label is not None and normalize_key(norm) == normalize_key(current_label):
                current_indices.append(i)
            else:
                flush()
                current_label = norm
                current_indices = [i]
        else:
            if current_indices:
                current_indices.append(i)
            else:
                flush()
                current_label = None
                current_indices = [i]

    flush()

    split_dir.mkdir(parents=True, exist_ok=True)
    out: list[tuple[str, Path]] = []
    used_names: dict[str, int] = {}

    for label, indices in groups:
        writer = PdfWriter()
        for idx in indices:
            writer.add_page(reader.pages[idx])
        base = safe_filename(label)
        cnt = used_names.get(base, 0)
        used_names[base] = cnt + 1
        fname = f"{base}.pdf" if cnt == 0 else f"{base}_{cnt + 1}.pdf"
        out_path = split_dir / fname
        with out_path.open("wb") as f:
            writer.write(f)
        out.append((label, out_path))

    return out


def office_matches(office_filter: str | None, office_cell: str) -> bool:
    """--office 指定時のみ、その拠点の行を LINE 対象にする。"""
    if not office_filter or not office_filter.strip():
        return True
    f = normalize_key(office_filter.strip())
    c = normalize_key((office_cell or "").strip())
    if not c:
        return False
    return f == c or f in c or c in f


def load_line_users_csv(path: Path, office_filter: str | None = None) -> dict[str, str]:
    """normalize_key(patient_name) -> line_user_id。office 列で拠点フィルタ可。"""
    out: dict[str, str] = {}
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            pname = (row.get("patient_name") or "").strip()
            uid = (row.get("line_user_id") or "").strip()
            off = (row.get("office") or row.get("site") or row.get("拠点") or "").strip()
            if not pname or not uid:
                continue
            if not office_matches(office_filter, off):
                continue
            key = normalize_key(pname)
            if key in out:
                # 重複は後勝ち（ログで気づけるよう stderr に一度）
                pass
            out[key] = uid
    return out


def line_push_text(user_id: str, text: str, token: str) -> tuple[bool, str]:
    url = "https://api.line.me/v2/bot/message/push"
    body = json.dumps(
        {"to": user_id, "messages": [{"type": "text", "text": text}]},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
            if resp.status == 200:
                return True, "ok"
            return False, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code}: {err}"
    except OSError as e:
        return False, str(e)


def append_log(log_path: Path, record: dict[str, Any]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record.setdefault("ts", datetime.now(timezone.utc).isoformat())
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def cmd_split(args: argparse.Namespace) -> int:
    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    split_dir = work / "split"
    items = split_pdf_by_patient(Path(args.input), split_dir)
    print(f"分割完了: {len(items)} 件 → {split_dir}")
    for label, p in items:
        print(f"  {label} -> {p.name}")
    return 0


def cmd_dispatch(args: argparse.Namespace) -> int:
    slack = None if args.no_slack else _load_slack_notify()
    work = Path(args.work_dir)
    split_dir = work / "split"
    line_dir = work / "line"
    mail_dir = work / "mail"
    log_path = work / "logs" / "dispatch.jsonl"

    line_dir.mkdir(parents=True, exist_ok=True)
    mail_dir.mkdir(parents=True, exist_ok=True)

    office_f = getattr(args, "office", None) or None
    line_map = load_line_users_csv(Path(args.line_csv), office_filter=office_f)
    if office_f:
        print(f"[filter] LINE対象拠点: {office_f}（該当行のみ line_user 登録）", file=sys.stderr)
    token = (args.line_token or __import__("os").environ.get("LINE_CHANNEL_ACCESS_TOKEN") or "").strip()
    template = (
        args.line_message
        or __import__("os").environ.get("LINE_BILLING_MESSAGE")
        or "【CareLink】請求書を発行しました。詳細は事業所からのご案内をご確認ください。利用者: {name}"
    )

    errors: list[str] = []
    pdfs = sorted(split_dir.glob("*.pdf"))
    if not pdfs:
        msg = f"split に PDF がありません: {split_dir}"
        print(msg, file=sys.stderr)
        if slack:
            slack.notify_error(msg, context="billing_dispatch")
        return 2

    for pdf in pdfs:
        # ファイル名は分割時の safe 名 — 再照合用に1ページ目から名前抽出
        reader = PdfReader(str(pdf))
        t0 = ""
        try:
            t0 = reader.pages[0].extract_text() or ""
        except Exception:
            pass
        display_name = extract_patient_name(t0) or pdf.stem.replace("_", " ")
        key = normalize_key(display_name)
        line_uid = line_map.get(key)
        method = "mail"
        line_ok: bool | None = None
        line_detail = ""

        if line_uid:
            method = "line"
            dest = line_dir / pdf.name
            shutil.copy2(pdf, dest)
            if args.dry_run:
                line_detail = "dry_run"
            elif token:
                text = template.format(name=display_name)
                line_ok, line_detail = line_push_text(line_uid, text, token)
                if not line_ok:
                    errors.append(f"LINE失敗 {display_name}: {line_detail}")
            else:
                line_detail = "no_LINE_CHANNEL_ACCESS_TOKEN（PDFのみline/へ）"
        else:
            dest = mail_dir / pdf.name
            shutil.copy2(pdf, dest)

        rec = {
            "patient_display": display_name,
            "patient_key": key,
            "pdf": str(pdf.name),
            "method": method,
            "line_user_id": line_uid if line_uid else None,
            "line_api_ok": line_ok,
            "line_detail": line_detail,
            "dest": str(dest),
            "office_filter": office_f,
        }
        append_log(log_path, rec)
        print(f"{method}\t{display_name}\t{pdf.name}")

    if errors and slack:
        slack.notify_error("請求仕分けでエラー:\n" + "\n".join(errors[:20]), context="billing_dispatch")

    return 1 if errors else 0


def cmd_run(args: argparse.Namespace) -> int:
    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    split_pdf_by_patient(Path(args.input), work / "split")
    return cmd_dispatch(args)


def main() -> int:
    p = argparse.ArgumentParser(description="請求PDF分割・LINE/郵送仕分け・ログ・Slack")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--work-dir", type=str, required=True)

    s = sub.add_parser("split", parents=[common])
    s.add_argument("--input", type=str, required=True)
    s.set_defaults(func=cmd_split)

    d = sub.add_parser("dispatch", parents=[common])
    d.add_argument("--line-csv", type=str, required=True)
    d.add_argument("--dry-run", action="store_true")
    d.add_argument("--no-slack", action="store_true", help="Slack通知しない")
    d.add_argument("--line-token", type=str, default="", help="LINE_CHANNEL_ACCESS_TOKEN の上書き")
    d.add_argument(
        "--line-message",
        type=str,
        default="",
        help="LINEテキスト（{name}）。未指定は環境変数 LINE_BILLING_MESSAGE",
    )
    d.add_argument(
        "--office",
        type=str,
        default="",
        help="LINE登録者をこの拠点のみに限定（CSVの office / site / 拠点 列と照合）。例: 北名古屋",
    )
    d.set_defaults(func=cmd_dispatch)

    r = sub.add_parser("run", parents=[common])
    r.add_argument("--input", type=str, required=True)
    r.add_argument("--line-csv", type=str, required=True)
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--no-slack", action="store_true")
    r.add_argument("--line-token", type=str, default="")
    r.add_argument("--line-message", type=str, default="")
    r.add_argument("--office", type=str, default="", help="北名古屋 等。LINE対象を拠点で絞る")
    r.set_defaults(func=cmd_run)

    args = p.parse_args()
    # argparse は default="" のため、空文字を None に（フィルタ無効）
    for attr in ("office",):
        if hasattr(args, attr) and getattr(args, attr) == "":
            setattr(args, attr, None)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
