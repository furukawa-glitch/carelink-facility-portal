"""
勤務表・出勤簿・カイポケ・ライン表の4ソースを突き合わせ、不一致のみ Excel に出力する。
原本は読み取りのみ（上書き・保存しない）。出力先: data/reports/reconcile_*.xlsx

詳細: docs/manuals/four_source_reconciliation.md
"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import pandas as pd

COL_DATE = "日付"
COL_CODE = "スタッフコード"
COL_NAME = "スタッフ氏名"
COL_START = "出勤時刻"
COL_END = "退勤時刻"
COL_STATUS = "出欠"

STANDARD_TIME_COLS = [COL_DATE, COL_CODE, COL_NAME, COL_START, COL_END]


def _rename_aliases(df: pd.DataFrame, aliases: dict[str, str]) -> pd.DataFrame:
    if not aliases:
        return df
    m = {k: v for k, v in aliases.items() if k in df.columns}
    return df.rename(columns=m)


def _parse_date_series(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, errors="coerce").dt.normalize()


def _combine_date_and_time(date_series: pd.Series, time_series: pd.Series) -> pd.Series:
    base = pd.to_datetime(date_series, errors="coerce").dt.normalize()
    parsed = pd.to_datetime(time_series, errors="coerce")
    sec = (
        parsed.dt.hour * 3600
        + parsed.dt.minute * 60
        + parsed.dt.second
        + parsed.dt.microsecond / 1_000_000
    )
    return base + pd.to_timedelta(sec, unit="s")


def normalize_staff_name(s: object) -> str:
    if s is None or (isinstance(s, float) and pd.isna(s)):
        return ""
    t = str(s).replace("\u3000", " ").strip()
    t = re.sub(r"\s+", " ", t)
    return t


def match_key_for_row(
    date_val: object,
    code: object,
    name: object,
    *,
    use_staff_code: bool,
) -> str | None:
    d = pd.to_datetime(date_val, errors="coerce")
    if pd.isna(d):
        return None
    ds = d.strftime("%Y-%m-%d")
    code_s = str(code).strip() if pd.notna(code) and str(code).strip() else ""
    if use_staff_code and code_s:
        return f"{ds}|code:{code_s}"
    nm = normalize_staff_name(name)
    if not nm:
        return None
    return f"{ds}|name:{nm}"


def load_table_excel_csv(
    path: Path,
    *,
    sheet: str | int | None,
    aliases: dict[str, str],
    encoding: str,
    label: str,
) -> pd.DataFrame:
    if path.suffix.lower() in {".csv"}:
        df = pd.read_csv(path, encoding=encoding)
    else:
        df = pd.read_excel(path, sheet_name=sheet if sheet is not None else 0, engine="openpyxl")
    df = _rename_aliases(df, aliases)
    miss = [c for c in STANDARD_TIME_COLS if c not in df.columns]
    if miss:
        raise ValueError(f"{label}: 必須列がありません {miss}. 列一覧: {list(df.columns)}")
    return df


def normalize_time_source(
    df: pd.DataFrame,
    *,
    use_staff_code: bool,
    source_label: str,
) -> pd.DataFrame:
    out = df.copy()
    out["_date"] = _parse_date_series(out[COL_DATE])
    out["_start_dt"] = _combine_date_and_time(out["_date"], out[COL_START])
    out["_end_dt"] = _combine_date_and_time(out["_date"], out[COL_END])
    out["_name_norm"] = out[COL_NAME].map(normalize_staff_name)
    keys = []
    for _, r in out.iterrows():
        keys.append(
            match_key_for_row(
                r[COL_DATE],
                r[COL_CODE],
                r[COL_NAME],
                use_staff_code=use_staff_code,
            )
        )
    out["_match_key"] = keys
    out = out[out["_match_key"].notna() & (out["_name_norm"] != "")]
    out["_source"] = source_label
    if out["_match_key"].duplicated(keep=False).any():
        dup = out.loc[out["_match_key"].duplicated(keep=False), "_match_key"].unique()[:20]
        raise ValueError(
            f"{source_label}: 同一キー（日付+スタッフ）の行が複数あります。先頭例: {list(dup)}"
        )
    return out


def load_line_source(
    path: Path,
    *,
    sheet: str | int | None,
    aliases: dict[str, str],
    encoding: str,
    status_col: str,
    present_values: set[str],
    use_staff_code: bool,
) -> pd.DataFrame:
    if path.suffix.lower() in {".csv"}:
        df = pd.read_csv(path, encoding=encoding)
    else:
        df = pd.read_excel(path, sheet_name=sheet if sheet is not None else 0, engine="openpyxl")
    df = _rename_aliases(df, aliases)
    need = [COL_DATE, COL_NAME, status_col]
    miss = [c for c in need if c not in df.columns]
    if miss:
        raise ValueError(f"ライン表: 必須列がありません {miss}. 列一覧: {list(df.columns)}")
    time_ok = COL_START in df.columns and COL_END in df.columns
    out = df.copy()
    out["_date"] = _parse_date_series(out[COL_DATE])
    if time_ok:
        out["_start_dt"] = _combine_date_and_time(out["_date"], out[COL_START])
        out["_end_dt"] = _combine_date_and_time(out["_date"], out[COL_END])
    else:
        out["_start_dt"] = pd.NaT
        out["_end_dt"] = pd.NaT
    out["_name_norm"] = out[COL_NAME].map(normalize_staff_name)
    st = out[status_col].map(lambda x: str(x).strip() if pd.notna(x) else "")
    out["_line_present"] = st.isin(present_values)
    keys = []
    for _, r in out.iterrows():
        code_cell = r[COL_CODE] if COL_CODE in out.columns else None
        keys.append(
            match_key_for_row(
                r[COL_DATE],
                code_cell,
                r[COL_NAME],
                use_staff_code=use_staff_code,
            )
        )
    out["_match_key"] = keys
    out = out[out["_match_key"].notna() & (out["_name_norm"] != "")]
    out["_source"] = "line"
    if out["_match_key"].duplicated(keep=False).any():
        dup = out.loc[out["_match_key"].duplicated(keep=False), "_match_key"].unique()[:20]
        raise ValueError(f"ライン表: 同一キーの行が複数あります。先頭例: {list(dup)}")
    return out


def load_kaipoke_visit_csv(
    path: Path,
    *,
    year_month: str,
    encoding: str,
    staff_col: str,
    day_col: str,
    start_col: str,
    end_col: str,
    use_staff_code: bool,
) -> pd.DataFrame:
    if not re.fullmatch(r"\d{6}", year_month):
        raise ValueError("kaipoke-year-month は YYYYMM 形式で指定してください（例: 202603）")
    y = int(year_month[:4])
    mo = int(year_month[4:6])
    df = pd.read_csv(path, encoding=encoding)
    for c in (staff_col, day_col, start_col, end_col):
        if c not in df.columns:
            raise ValueError(f"カイポケCSV: 列がありません: {c}. 列一覧: {list(df.columns)}")
    raw = df[[staff_col, day_col, start_col, end_col]].copy()
    raw = raw.rename(
        columns={staff_col: COL_NAME, day_col: "_day", start_col: COL_START, end_col: COL_END}
    )
    raw["_day"] = pd.to_numeric(raw["_day"], errors="coerce")
    raw = raw.dropna(subset=["_day"])
    raw["_date"] = pd.to_datetime(
        {"year": y, "month": mo, "day": raw["_day"].astype(int)}, errors="coerce"
    ).dt.normalize()
    raw = raw.dropna(subset=["_date"])
    raw[COL_DATE] = raw["_date"]
    raw[COL_CODE] = ""
    raw["_start_dt"] = _combine_date_and_time(raw["_date"], raw[COL_START])
    raw["_end_dt"] = _combine_date_and_time(raw["_date"], raw[COL_END])
    raw["_name_norm"] = raw[COL_NAME].map(normalize_staff_name)
    raw = raw[raw["_name_norm"] != ""]

    def _agg(g: pd.DataFrame) -> pd.Series:
        return pd.Series(
            {
                COL_START: g[COL_START].iloc[0],
                COL_END: g[COL_END].iloc[0],
                "_start_dt": g["_start_dt"].min(),
                "_end_dt": g["_end_dt"].max(),
                COL_NAME: g[COL_NAME].iloc[0],
                COL_DATE: g["_date"].iloc[0],
            }
        )

    grp = raw.groupby(["_date", "_name_norm"], as_index=False, sort=False)
    agg_rows = []
    for _, g in grp:
        agg_rows.append(
            {
                COL_DATE: g["_date"].iloc[0],
                COL_CODE: "",
                COL_NAME: g[COL_NAME].iloc[0],
                "_start_dt": g["_start_dt"].min(),
                "_end_dt": g["_end_dt"].max(),
                "_name_norm": g["_name_norm"].iloc[0],
            }
        )
    out = pd.DataFrame(agg_rows)
    keys = []
    for _, r in out.iterrows():
        keys.append(
            match_key_for_row(
                r[COL_DATE],
                None,
                r[COL_NAME],
                use_staff_code=False,
            )
        )
    out["_match_key"] = keys
    out = out[out["_match_key"].notna()]
    out["_source"] = "kaipoke"
    if out["_match_key"].duplicated(keep=False).any():
        dup = out.loc[out["_match_key"].duplicated(keep=False), "_match_key"].unique()[:20]
        raise ValueError(f"カイポケ集約後に重複キーがあります。先頭例: {list(dup)}")
    _ = use_staff_code
    return out


def _delta_seconds(a: object, b: object) -> float | None:
    if pd.isna(a) or pd.isna(b):
        return None
    return abs((pd.Timestamp(a) - pd.Timestamp(b)).total_seconds())


@dataclass
class Finding:
    種別: str
    突合キー: str
    スタッフ氏名: str
    日付: str
    詳細: str
    勤務表_出勤: object = ""
    勤務表_退勤: object = ""
    出勤簿_出勤: object = ""
    出勤簿_退勤: object = ""
    カイポケ_出勤: object = ""
    カイポケ_退勤: object = ""
    ライン_出欠: object = ""
    ライン_出勤: object = ""
    ライン_退勤: object = ""


def _first_date_str(r: pd.Series) -> str:
    for c in ("date_shift", "date_att", "date_kp", "date_line"):
        v = r.get(c)
        if pd.notna(v):
            try:
                return pd.Timestamp(v).strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                return str(v)[:10]
    return ""


def _row_from_merge(r: pd.Series) -> Finding:
    def g(col: str) -> object:
        if col not in r.index:
            return ""
        v = r[col]
        return "" if pd.isna(v) else v

    return Finding(
        種別="",
        突合キー=str(r.get("_match_key", "")),
        スタッフ氏名=str(
            r.get("name_shift")
            or r.get("name_att")
            or r.get("name_kp")
            or r.get("name_line")
            or ""
        ),
        日付=_first_date_str(r),
        詳細="",
        勤務表_出勤=g("shift_s"),
        勤務表_退勤=g("shift_e"),
        出勤簿_出勤=g("att_s"),
        出勤簿_退勤=g("att_e"),
        カイポケ_出勤=g("kp_s"),
        カイポケ_退勤=g("kp_e"),
        ライン_出欠=g("line_status"),
        ライン_出勤=g("line_s"),
        ライン_退勤=g("line_e"),
    )


def run_reconciliation(
    *,
    shift: pd.DataFrame,
    attendance: pd.DataFrame,
    kaipoke: pd.DataFrame,
    line: pd.DataFrame,
    line_status_col: str,
    threshold_seconds: float,
) -> tuple[pd.DataFrame, list[Finding]]:
    findings: list[Finding] = []

    def slim(df: pd.DataFrame, prefix: str) -> pd.DataFrame:
        return df[
            [
                "_match_key",
                "_start_dt",
                "_end_dt",
                "_name_norm",
                "_date",
            ]
        ].rename(
            columns={
                "_start_dt": f"{prefix}_s",
                "_end_dt": f"{prefix}_e",
                "_name_norm": f"name_{prefix}",
                "_date": f"date_{prefix}",
            }
        )

    s = slim(shift, "shift")
    a = slim(attendance, "att")
    k = slim(kaipoke, "kp")
    ln = line[
        ["_match_key", "_start_dt", "_end_dt", "_name_norm", "_date", line_status_col, "_line_present"]
    ].rename(
        columns={
            "_start_dt": "line_s",
            "_end_dt": "line_e",
            "_name_norm": "name_line",
            "_date": "date_line",
            line_status_col: "line_status",
        }
    )

    keys = pd.concat([s["_match_key"], a["_match_key"], k["_match_key"], ln["_match_key"]], ignore_index=True)
    keys = pd.DataFrame({"_match_key": keys.unique()})

    m = keys.merge(s, on="_match_key", how="left")
    m = m.merge(a, on="_match_key", how="left")
    m = m.merge(k, on="_match_key", how="left")
    m = m.merge(ln, on="_match_key", how="left")

    for _, r in m.iterrows():
        key = r["_match_key"]
        has_shift = pd.notna(r.get("shift_s")) or pd.notna(r.get("shift_e"))
        has_att = pd.notna(r.get("att_s")) or pd.notna(r.get("att_e"))
        has_kp = pd.notna(r.get("kp_s")) or pd.notna(r.get("kp_e"))
        has_line_row = pd.notna(r.get("line_status")) or (
            pd.notna(r.get("line_s")) or pd.notna(r.get("line_e"))
        )
        line_present = bool(r.get("_line_present")) if pd.notna(r.get("_line_present")) else False

        if not (has_shift or has_att or has_kp or has_line_row):
            continue

        base = _row_from_merge(r)

        if has_shift and not has_att:
            findings.append(
                Finding(
                    **{
                        **base.__dict__,
                        "種別": "勤務表vs出勤簿",
                        "詳細": "出勤簿に同一キーの行がありません",
                    }
                )
            )
        if has_att and not has_shift:
            findings.append(
                Finding(
                    **{
                        **base.__dict__,
                        "種別": "勤務表vs出勤簿",
                        "詳細": "勤務表に同一キーの行がありません",
                    }
                )
            )

        if has_shift and has_att:
            ds = _delta_seconds(r.get("shift_s"), r.get("att_s"))
            de = _delta_seconds(r.get("shift_e"), r.get("att_e"))
            if ds is not None and ds >= threshold_seconds:
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": "勤務表vs出勤簿",
                            "詳細": f"出勤時刻の差が{threshold_seconds}秒以上（差秒={ds:.0f}）",
                        }
                    )
                )
            if de is not None and de >= threshold_seconds:
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": "勤務表vs出勤簿",
                            "詳細": f"退勤時刻の差が{threshold_seconds}秒以上（差秒={de:.0f}）",
                        }
                    )
                )
            if ds is None and (pd.notna(r.get("shift_s")) ^ pd.notna(r.get("att_s"))):
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": "勤務表vs出勤簿",
                            "詳細": "出勤時刻が片方欠損",
                        }
                    )
                )
            if de is None and (pd.notna(r.get("shift_e")) ^ pd.notna(r.get("att_e"))):
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": "勤務表vs出勤簿",
                            "詳細": "退勤時刻が片方欠損",
                        }
                    )
                )

        for label, other_s, other_e in (
            ("勤務表vsカイポケ", "kp_s", "kp_e"),
            ("出勤簿vsカイポケ", "kp_s", "kp_e"),
        ):
            pfx_s, pfx_e = ("shift_s", "shift_e") if label.startswith("勤務表") else ("att_s", "att_e")
            has_left = pd.notna(r.get(pfx_s)) or pd.notna(r.get(pfx_e))
            if not (has_left and has_kp):
                continue
            ds = _delta_seconds(r.get(pfx_s), r.get(other_s))
            de = _delta_seconds(r.get(pfx_e), r.get(other_e))
            if ds is not None and ds >= threshold_seconds:
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": label,
                            "詳細": f"出勤時刻の差が{threshold_seconds}秒以上（差秒={ds:.0f}）",
                        }
                    )
                )
            if de is not None and de >= threshold_seconds:
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": label,
                            "詳細": f"退勤時刻の差が{threshold_seconds}秒以上（差秒={de:.0f}）",
                        }
                    )
                )
            if ds is None and (pd.notna(r.get(pfx_s)) ^ pd.notna(r.get(other_s))):
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": label,
                            "詳細": "出勤時刻が片方欠損",
                        }
                    )
                )
            if de is None and (pd.notna(r.get(pfx_e)) ^ pd.notna(r.get(other_e))):
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": label,
                            "詳細": "退勤時刻が片方欠損",
                        }
                    )
                )

        if line_present and not has_kp:
            findings.append(
                Finding(
                    **{
                        **base.__dict__,
                        "種別": "ラインvsカイポケ",
                        "詳細": "ライン表が出勤なのに、カイポケ側に実績時刻がありません",
                    }
                )
            )

        if line_present and has_shift:
            ds = _delta_seconds(r.get("line_s"), r.get("shift_s"))
            de = _delta_seconds(r.get("line_e"), r.get("shift_e"))
            if pd.notna(r.get("line_s")) and pd.notna(r.get("shift_s")) and ds is not None and ds >= threshold_seconds:
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": "ラインvs勤務表",
                            "詳細": f"出勤時刻の差が{threshold_seconds}秒以上（差秒={ds:.0f}）",
                        }
                    )
                )
            if pd.notna(r.get("line_e")) and pd.notna(r.get("shift_e")) and de is not None and de >= threshold_seconds:
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": "ラインvs勤務表",
                            "詳細": f"退勤時刻の差が{threshold_seconds}秒以上（差秒={de:.0f}）",
                        }
                    )
                )

        present_sources: list[str] = []
        if has_shift:
            present_sources.append("勤務表")
        if has_att:
            present_sources.append("出勤簿")
        if has_kp:
            present_sources.append("カイポケ")
        if has_line_row:
            present_sources.append("ライン表")
        if len(present_sources) == 1:
            sole = present_sources[0]
            skip = (sole == "勤務表" and not has_att) or (sole == "出勤簿" and not has_shift)
            if not skip:
                findings.append(
                    Finding(
                        **{
                            **base.__dict__,
                            "種別": "他ソース欠落",
                            "詳細": f"4ソースのうち {sole} にのみ行があります",
                        }
                    )
                )

    rep = pd.DataFrame([f.__dict__ for f in findings])
    if rep.empty:
        rep = pd.DataFrame(
            columns=[
                "種別",
                "突合キー",
                "スタッフ氏名",
                "日付",
                "詳細",
                "勤務表_出勤",
                "勤務表_退勤",
                "出勤簿_出勤",
                "出勤簿_退勤",
                "カイポケ_出勤",
                "カイポケ_退勤",
                "ライン_出欠",
                "ライン_出勤",
                "ライン_退勤",
            ]
        )
    return m, findings


def write_report(
    out_path: Path,
    findings: pd.DataFrame,
    merged: pd.DataFrame,
    meta: dict[str, str],
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    summary = (
        findings.groupby("種別").size().reset_index(name="件数")
        if not findings.empty
        else pd.DataFrame(columns=["種別", "件数"])
    )
    with pd.ExcelWriter(out_path, engine="openpyxl") as w:
        pd.DataFrame([meta]).T.reset_index().rename(columns={"index": "項目", 0: "値"}).to_excel(
            w, sheet_name="メタ", index=False
        )
        summary.to_excel(w, sheet_name="サマリー", index=False)
        findings.to_excel(w, sheet_name="不一致一覧", index=False)
        merged_display = merged.copy()
        if len(merged_display) > 50000:
            merged_display = merged_display.head(50000)
            merged_display.to_excel(w, sheet_name="統合ビュー_先頭5万件", index=False)
        else:
            merged_display.to_excel(w, sheet_name="統合ビュー", index=False)


def parse_alias_arg(s: str | None) -> dict[str, str]:
    if not s or not s.strip():
        return {}
    out: dict[str, str] = {}
    for part in s.split(","):
        part = part.strip()
        if not part or ":" not in part:
            continue
        k, v = part.split(":", 1)
        out[k.strip()] = v.strip()
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="4ソース照合→data/reports に Excel 出力（原本は変更しない）")
    p.add_argument("--shift", type=Path, required=True)
    p.add_argument("--attendance", type=Path, required=True)
    p.add_argument("--kaipoke", type=Path, required=True)
    p.add_argument("--line", type=Path, required=True)
    p.add_argument("--shift-sheet", default="勤務データ")
    p.add_argument("--attendance-sheet", default="出勤簿")
    p.add_argument("--line-sheet", default="ライン表")
    p.add_argument("--encoding", default="utf-8")
    p.add_argument("--use-staff-code", action="store_true")
    p.add_argument("--threshold-seconds", type=float, default=60.0)
    p.add_argument(
        "--kaipoke-mode",
        choices=("flat", "visit_csv"),
        default="flat",
        help="flat=一覧CSV/Excel, visit_csv=訪問1行形式を日次集約",
    )
    p.add_argument("--kaipoke-year-month", default="", help="visit_csv 時必須 YYYYMM")
    p.add_argument("--kaipoke-staff-col", default="職員名１")
    p.add_argument("--kaipoke-day-col", default="日付")
    p.add_argument("--kaipoke-start-col", default="開始時間")
    p.add_argument("--kaipoke-end-col", default="終了時間")
    p.add_argument("--kaipoke-sheet", default=0, help="kaipoke が xlsx のときのシート名または0始まり番号")
    p.add_argument("--line-status-col", default="出欠")
    p.add_argument(
        "--line-present-values",
        default="出勤,○,有,出,予定出勤",
        help="カンマ区切り。これに一致したらライン上は出勤扱い",
    )
    p.add_argument("--shift-alias", default="")
    p.add_argument("--attendance-alias", default="")
    p.add_argument("--kaipoke-alias", default="")
    p.add_argument("--line-alias", default="")
    p.add_argument("--output", type=Path, default=None, help="省略時は data/reports/reconcile_日時.xlsx")
    args = p.parse_args()

    if args.use_staff_code and args.kaipoke_mode == "visit_csv":
        raise SystemExit(
            "visit_csv は職員名集約のためコードキーと一致しません。"
            "カイポケを flat（一覧）形式にするか、--use-staff-code を外してください。"
        )

    present_set = {x.strip() for x in args.line_present_values.split(",") if x.strip()}

    shift_df = normalize_time_source(
        load_table_excel_csv(
            args.shift,
            sheet=args.shift_sheet,
            aliases=parse_alias_arg(args.shift_alias),
            encoding=args.encoding,
            label="勤務表",
        ),
        use_staff_code=args.use_staff_code,
        source_label="shift",
    )
    att_df = normalize_time_source(
        load_table_excel_csv(
            args.attendance,
            sheet=args.attendance_sheet,
            aliases=parse_alias_arg(args.attendance_alias),
            encoding=args.encoding,
            label="出勤簿",
        ),
        use_staff_code=args.use_staff_code,
        source_label="attendance",
    )

    if args.kaipoke_mode == "visit_csv":
        if not args.kaipoke_year_month:
            raise SystemExit("visit_csv モードでは --kaipoke-year-month YYYYMM が必須です")
        kp_df = load_kaipoke_visit_csv(
            args.kaipoke,
            year_month=args.kaipoke_year_month,
            encoding=args.encoding,
            staff_col=args.kaipoke_staff_col,
            day_col=args.kaipoke_day_col,
            start_col=args.kaipoke_start_col,
            end_col=args.kaipoke_end_col,
            use_staff_code=args.use_staff_code,
        )
    else:
        ks = args.kaipoke_sheet
        try:
            ks = int(ks)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            pass
        kp_df = normalize_time_source(
            load_table_excel_csv(
                args.kaipoke,
                sheet=ks,
                aliases=parse_alias_arg(args.kaipoke_alias),
                encoding=args.encoding,
                label="カイポケ",
            ),
            use_staff_code=args.use_staff_code,
            source_label="kaipoke",
        )

    line_df = load_line_source(
        args.line,
        sheet=args.line_sheet,
        aliases=parse_alias_arg(args.line_alias),
        encoding=args.encoding,
        status_col=args.line_status_col,
        present_values=present_set,
        use_staff_code=args.use_staff_code,
    )

    merged, findings_list = run_reconciliation(
        shift=shift_df,
        attendance=att_df,
        kaipoke=kp_df,
        line=line_df,
        line_status_col=args.line_status_col,
        threshold_seconds=args.threshold_seconds,
    )
    findings_df = pd.DataFrame([f.__dict__ for f in findings_list])

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = args.output or (Path("data/reports") / f"reconcile_{ts}.xlsx")
    meta = {
        "生成日時": datetime.now().isoformat(timespec="seconds"),
        "閾値秒": str(args.threshold_seconds),
        "勤務表": str(args.shift.resolve()),
        "出勤簿": str(args.attendance.resolve()),
        "カイポケ": str(args.kaipoke.resolve()),
        "ライン表": str(args.line.resolve()),
        "kaipoke_mode": args.kaipoke_mode,
        "use_staff_code": str(args.use_staff_code),
        "原本変更": "なし（読み取りのみ）",
    }
    write_report(out, findings_df, merged, meta)
    print(f"照合完了: {out.resolve()} 件数={len(findings_df)}")


if __name__ == "__main__":
    main()
