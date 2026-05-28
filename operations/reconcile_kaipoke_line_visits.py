"""
カイポケ訪問CSV（1行1訪問）とライン表（1行1訪問想定）を、スタッフ・利用者・開始／終了時刻で突き合わせる。
既存の reconcile_four_sources.py は「日付＋スタッフ」の日次集約のため、訪問単位の差分は出ません。

出力: data/reports/reconcile_visits_*.xlsx（原本は読み取りのみ）

例::
  python operations/reconcile_kaipoke_line_visits.py ^
    --kaipoke data/attendance_inbox/訪問スケジュール_202603.csv ^
    --kaipoke-year-month 202603 ^
    --line data/attendance_inbox/ライン訪問_202603.xlsx ^
    --line-sheet ライン表 ^
    --line-alias "利用者氏名:利用者名,出勤時刻:開始予定,退勤時刻:終了予定"
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import pandas as pd

# operations 直下をパスに入れ、reconcile_four_sources の正規化を再利用
_OPS = Path(__file__).resolve().parent
if str(_OPS) not in sys.path:
    sys.path.insert(0, str(_OPS))

from reconcile_four_sources import (  # noqa: E402
    _combine_date_and_time,
    _parse_date_series,
    _rename_aliases,
    normalize_staff_name,
    parse_alias_arg,
)


COL_DATE = "日付"
COL_STAFF = "スタッフ氏名"
COL_PATIENT = "利用者氏名"
COL_START = "出勤時刻"
COL_END = "退勤時刻"


def normalize_patient_name(s: object) -> str:
    if s is None or (isinstance(s, float) and pd.isna(s)):
        return ""
    t = str(s).replace("\u3000", " ").strip()
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"様\s*$", "", t).strip()
    return t


def _read_table(path: Path, *, sheet: str | int | None, encoding: str) -> pd.DataFrame:
    if path.suffix.lower() == ".csv":
        return pd.read_csv(path, encoding=encoding)
    return pd.read_excel(path, sheet_name=sheet if sheet is not None else 0, engine="openpyxl")


def load_kaipoke_visits_raw(
    path: Path,
    *,
    year_month: str,
    encoding: str,
    staff_col: str,
    day_col: str,
    start_col: str,
    end_col: str,
    patient_col: str | None,
) -> pd.DataFrame:
    if not re.fullmatch(r"\d{6}", year_month):
        raise ValueError("kaipoke-year-month は YYYYMM（例: 202603）")
    y = int(year_month[:4])
    mo = int(year_month[4:6])
    df = pd.read_csv(path, encoding=encoding)
    need = [staff_col, day_col, start_col, end_col]
    if patient_col:
        need.append(patient_col)
    for c in need:
        if c not in df.columns:
            raise ValueError(f"カイポケCSV: 列がありません: {c}. 列一覧: {list(df.columns)}")
    raw = df.copy()
    raw["_day"] = pd.to_numeric(raw[day_col], errors="coerce")
    raw = raw.dropna(subset=["_day"])
    raw["_date"] = pd.to_datetime(
        {"year": y, "month": mo, "day": raw["_day"].astype(int)}, errors="coerce"
    ).dt.normalize()
    raw = raw.dropna(subset=["_date"])
    raw[COL_DATE] = raw["_date"]
    raw[COL_STAFF] = raw[staff_col]
    raw[COL_START] = raw[start_col]
    raw[COL_END] = raw[end_col]
    if patient_col:
        raw[COL_PATIENT] = raw[patient_col]
    else:
        raw[COL_PATIENT] = ""
    raw["_staff_n"] = raw[COL_STAFF].map(normalize_staff_name)
    raw["_patient_n"] = raw[COL_PATIENT].map(normalize_patient_name)
    raw = raw[raw["_staff_n"] != ""]
    raw["_start_dt"] = _combine_date_and_time(raw["_date"], raw[COL_START])
    raw["_end_dt"] = _combine_date_and_time(raw["_date"], raw[COL_END])
    return raw


def load_line_visits(
    path: Path,
    *,
    sheet: str | int | None,
    aliases: dict[str, str],
    encoding: str,
    patient_optional: bool,
) -> pd.DataFrame:
    df = _read_table(path, sheet=sheet, encoding=encoding)
    df = _rename_aliases(df, aliases)
    need = [COL_DATE, COL_STAFF, COL_START, COL_END]
    if not patient_optional:
        need.append(COL_PATIENT)
    miss = [c for c in need if c not in df.columns]
    if miss:
        raise ValueError(f"ライン表: 必須列がありません {miss}. 列一覧: {list(df.columns)}")
    out = df.copy()
    out["_date"] = _parse_date_series(out[COL_DATE])
    out[COL_DATE] = out["_date"]
    out["_staff_n"] = out[COL_STAFF].map(normalize_staff_name)
    if COL_PATIENT in out.columns:
        out["_patient_n"] = out[COL_PATIENT].map(normalize_patient_name)
    else:
        out["_patient_n"] = ""
    out = out[out["_staff_n"] != ""]
    out["_start_dt"] = _combine_date_and_time(out["_date"], out[COL_START])
    out["_end_dt"] = _combine_date_and_time(out["_date"], out[COL_END])
    return out


def _delta_seconds(a: object, b: object) -> float | None:
    if pd.isna(a) or pd.isna(b):
        return None
    return abs((pd.Timestamp(a) - pd.Timestamp(b)).total_seconds())


@dataclass
class VisitMatch:
    kaipoke_row: int
    line_row: int
    note: str


def match_visit_blocks(
    kp: pd.DataFrame,
    ln: pd.DataFrame,
    *,
    threshold_seconds: float,
    allow_patient_mismatch_if_blank: bool,
) -> tuple[list[VisitMatch], list[int], list[int]]:
    """同一日・同一スタッフ内で、開始時刻が近く利用者が一致する行同士を貪欲に対応付け。"""
    kp_used: set[int] = set()
    ln_used: set[int] = set()
    matches: list[VisitMatch] = []

    kp_idx = kp.index.tolist()
    ln_idx = ln.index.tolist()

    groups_kp: dict[tuple[pd.Timestamp, str], list[int]] = {}
    for i in kp_idx:
        key = (pd.Timestamp(kp.loc[i, "_date"]).normalize(), str(kp.loc[i, "_staff_n"]))
        groups_kp.setdefault(key, []).append(i)

    groups_ln: dict[tuple[pd.Timestamp, str], list[int]] = {}
    for j in ln_idx:
        key = (pd.Timestamp(ln.loc[j, "_date"]).normalize(), str(ln.loc[j, "_staff_n"]))
        groups_ln.setdefault(key, []).append(j)

    all_keys = sorted(set(groups_kp) | set(groups_ln), key=lambda x: (x[0], x[1]))

    for key in all_keys:
        ki = sorted(groups_kp.get(key, []), key=lambda ix: kp.loc[ix, "_start_dt"])
        lj = sorted(groups_ln.get(key, []), key=lambda ix: ln.loc[ix, "_start_dt"])
        for i in ki:
            best_j: int | None = None
            best_score: float | None = None
            kp_s = kp.loc[i, "_start_dt"]
            kp_pat = str(kp.loc[i, "_patient_n"])
            if pd.isna(kp_s):
                continue
            for j in lj:
                if j in ln_used:
                    continue
                ls = ln.loc[j, "_start_dt"]
                if pd.isna(ls):
                    continue
                ln_pat = str(ln.loc[j, "_patient_n"])
                if kp_pat and ln_pat and kp_pat != ln_pat:
                    continue
                if (not kp_pat or not ln_pat) and kp_pat != ln_pat:
                    if not allow_patient_mismatch_if_blank:
                        continue
                ds = _delta_seconds(kp_s, ls)
                if ds is None:
                    continue
                if ds > threshold_seconds * 3:
                    continue
                if best_score is None or ds < best_score:
                    best_score = ds
                    best_j = j
            if best_j is not None:
                note_parts = []
                ln_pat = str(ln.loc[best_j, "_patient_n"])
                kp_pat = str(kp.loc[i, "_patient_n"])
                if (kp_pat or ln_pat) and kp_pat != ln_pat:
                    note_parts.append("利用者名の表記差または片側欠損")
                if best_score is not None and best_score >= threshold_seconds:
                    note_parts.append(f"開始時刻差{best_score:.0f}秒")
                de = _delta_seconds(kp.loc[i, "_end_dt"], ln.loc[best_j, "_end_dt"])
                if de is not None and de >= threshold_seconds:
                    note_parts.append(f"終了時刻差{de:.0f}秒")
                matches.append(
                    VisitMatch(
                        kaipoke_row=int(i),
                        line_row=int(best_j),
                        note="; ".join(note_parts) if note_parts else "一致範囲内",
                    )
                )
                kp_used.add(i)
                ln_used.add(best_j)

    kp_unmatched = [int(i) for i in kp_idx if i not in kp_used]
    ln_unmatched = [int(j) for j in ln_idx if j not in ln_used]
    return matches, kp_unmatched, ln_unmatched


def main() -> None:
    ap = argparse.ArgumentParser(
        description="カイポケ訪問CSVとライン表を訪問単位（スタッフ・利用者・時刻）で照合"
    )
    ap.add_argument("--kaipoke", type=Path, required=True)
    ap.add_argument("--kaipoke-year-month", required=True, help="YYYYMM")
    ap.add_argument("--line", type=Path, required=True)
    ap.add_argument("--line-sheet", default=0, help="シート名または0始まり番号")
    ap.add_argument("--encoding", default="utf-8")
    ap.add_argument("--kaipoke-staff-col", default="職員名１")
    ap.add_argument("--kaipoke-day-col", default="日付")
    ap.add_argument("--kaipoke-start-col", default="開始時間")
    ap.add_argument("--kaipoke-end-col", default="終了時間")
    ap.add_argument(
        "--kaipoke-patient-col",
        default="利用者名",
        help="無効にするには空文字",
    )
    ap.add_argument("--line-alias", default="", help="列名エイリアス 例: 利用者氏名:利用者名,出勤時刻:開始")
    ap.add_argument(
        "--line-patient-optional",
        action="store_true",
        help="ライン表に利用者列が無い／空のみのとき、スタッフ＋開始時刻のみで対応付け",
    )
    ap.add_argument(
        "--allow-blank-patient-match",
        action="store_true",
        help="片方だけ利用者名がある行同士でも対応付けを試みる（誤結合に注意）",
    )
    ap.add_argument(
        "--threshold-seconds",
        type=float,
        default=120.0,
        help="同一訪問とみなす開始時刻の最大ズレ（秒）。終了警告はこの閾値を使用",
    )
    ap.add_argument("--output", type=Path, default=None)
    args = ap.parse_args()

    ks = args.line_sheet
    try:
        ks = int(ks)  # type: ignore[assignment]
    except (TypeError, ValueError):
        pass

    patient_col = (args.kaipoke_patient_col or "").strip() or None
    kp = load_kaipoke_visits_raw(
        args.kaipoke,
        year_month=args.kaipoke_year_month,
        encoding=args.encoding,
        staff_col=args.kaipoke_staff_col,
        day_col=args.kaipoke_day_col,
        start_col=args.kaipoke_start_col,
        end_col=args.kaipoke_end_col,
        patient_col=patient_col,
    )
    ln = load_line_visits(
        args.line,
        sheet=ks,
        aliases=parse_alias_arg(args.line_alias),
        encoding=args.encoding,
        patient_optional=args.line_patient_optional,
    )

    matches, kp_miss, ln_miss = match_visit_blocks(
        kp,
        ln,
        threshold_seconds=args.threshold_seconds,
        allow_patient_mismatch_if_blank=args.allow_blank_patient_match,
    )

    rows_matched = []
    for m in matches:
        i, j = m.kaipoke_row, m.line_row
        rows_matched.append(
            {
                "照合結果": m.note,
                "日付": pd.Timestamp(kp.loc[i, "_date"]).strftime("%Y-%m-%d"),
                "スタッフ_カイポケ": kp.loc[i, COL_STAFF],
                "スタッフ_ライン": ln.loc[j, COL_STAFF],
                "利用者_カイポケ": kp.loc[i, COL_PATIENT] if COL_PATIENT in kp.columns else "",
                "利用者_ライン": ln.loc[j, COL_PATIENT] if COL_PATIENT in ln.columns else "",
                "開始_カイポケ": kp.loc[i, "_start_dt"],
                "開始_ライン": ln.loc[j, "_start_dt"],
                "終了_カイポケ": kp.loc[i, "_end_dt"],
                "終了_ライン": ln.loc[j, "_end_dt"],
                "開始差秒": _delta_seconds(kp.loc[i, "_start_dt"], ln.loc[j, "_start_dt"]),
                "終了差秒": _delta_seconds(kp.loc[i, "_end_dt"], ln.loc[j, "_end_dt"]),
            }
        )

    rows_kp_only = []
    for i in kp_miss:
        rows_kp_only.append(
            {
                "種別": "カイポケのみ（ライン表に対応行なし）",
                "日付": pd.Timestamp(kp.loc[i, "_date"]).strftime("%Y-%m-%d"),
                "スタッフ": kp.loc[i, COL_STAFF],
                "利用者": kp.loc[i, COL_PATIENT] if COL_PATIENT in kp.columns else "",
                "開始": kp.loc[i, "_start_dt"],
                "終了": kp.loc[i, "_end_dt"],
            }
        )

    rows_ln_only = []
    for j in ln_miss:
        rows_ln_only.append(
            {
                "種別": "ライン表のみ（カイポケに対応行なし）",
                "日付": pd.Timestamp(ln.loc[j, "_date"]).strftime("%Y-%m-%d"),
                "スタッフ": ln.loc[j, COL_STAFF],
                "利用者": ln.loc[j, COL_PATIENT] if COL_PATIENT in ln.columns else "",
                "開始": ln.loc[j, "_start_dt"],
                "終了": ln.loc[j, "_end_dt"],
            }
        )

    findings = []
    for r in rows_matched:
        if r["照合結果"] != "一致範囲内":
            findings.append({**r, "種別": "時刻または利用者の差異"})
    findings.extend(rows_kp_only)
    findings.extend(rows_ln_only)

    findings_df = pd.DataFrame(findings)
    matched_df = pd.DataFrame(rows_matched)
    kp_only_df = pd.DataFrame(rows_kp_only)
    ln_only_df = pd.DataFrame(rows_ln_only)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = args.output or (Path("data/reports") / f"reconcile_visits_{ts}.xlsx")
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "生成日時": datetime.now().isoformat(timespec="seconds"),
        "閾値秒_対応付け": str(args.threshold_seconds),
        "カイポケ": str(args.kaipoke.resolve()),
        "ライン表": str(args.line.resolve()),
        "kaipoke_year_month": args.kaipoke_year_month,
        "原本変更": "なし",
    }
    summary = pd.DataFrame(
        [
            {"項目": "カイポケ訪問行数", "値": len(kp)},
            {"項目": "ライン表行数", "値": len(ln)},
            {"項目": "対応付け成功", "値": len(matches)},
            {"項目": "カイポケのみ", "値": len(kp_miss)},
            {"項目": "ラインのみ", "値": len(ln_miss)},
            {"項目": "一致範囲内以外の対応行", "値": sum(1 for m in matches if m.note != "一致範囲内")},
        ]
    )
    with pd.ExcelWriter(out, engine="openpyxl") as w:
        pd.DataFrame([meta]).T.reset_index().rename(columns={"index": "項目", 0: "値"}).to_excel(
            w, sheet_name="メタ", index=False
        )
        summary.to_excel(w, sheet_name="サマリー", index=False)
        matched_df.to_excel(w, sheet_name="対応付け一覧", index=False)
        if not findings_df.empty:
            findings_df.to_excel(w, sheet_name="差異・欠落", index=False)
        else:
            pd.DataFrame([{"メッセージ": "差異・欠落なし（対応付け一覧を参照）"}]).to_excel(
                w, sheet_name="差異・欠落", index=False
            )
        kp_only_df.to_excel(w, sheet_name="カイポケのみ", index=False)
        ln_only_df.to_excel(w, sheet_name="ライン表のみ", index=False)

    print(f"訪問単位照合完了: {out.resolve()}")
    print(
        f"  カイポケ行={len(kp)} ライン行={len(ln)} 対応付け={len(matches)} "
        f"カイポケのみ={len(kp_miss)} ラインのみ={len(ln_miss)}"
    )


if __name__ == "__main__":
    main()
