"""
勤務表（Excel）とカイポケCSVの勤務実績を突き合わせ、
出勤・退勤のいずれかが 1 分以上ずれている行をリストアップする。

前提は docs/manuals/data_preparation.md を参照。
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

# --- 勤務表（Excel） ---
EXCEL_SHEET_NAME = "勤務データ"

# 標準列名（data_preparation.md と一致させる）
COL_DATE = "日付"
COL_STAFF_CODE = "スタッフコード"
COL_STAFF_NAME = "スタッフ氏名"
COL_START = "出勤時刻"
COL_END = "退勤時刻"

STANDARD_COLUMNS = [COL_DATE, COL_STAFF_CODE, COL_STAFF_NAME, COL_START, COL_END]

# カイポケCSVのヘッダーが異なる場合: 実CSVの列名 -> 標準列名
SHIFT_COLUMN_ALIASES: dict[str, str] = {
    # 例: "開始時刻": COL_START,
    # 例: "終了時刻": COL_END,
}
KAIPOKE_COLUMN_ALIASES: dict[str, str] = {
    # 例: "実績開始": COL_START,
}

CSV_ENCODING = "utf-8"

# この秒数以上の差を「ズレあり」とする（60 = 1分）
MISMATCH_THRESHOLD_SECONDS = 60


def _rename_by_aliases(df: pd.DataFrame, aliases: dict[str, str]) -> pd.DataFrame:
    if not aliases:
        return df
    inv = {k: v for k, v in aliases.items() if k in df.columns}
    return df.rename(columns=inv)


def load_shift_excel(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path, sheet_name=EXCEL_SHEET_NAME, engine="openpyxl")
    df = _rename_by_aliases(df, SHIFT_COLUMN_ALIASES)
    _validate_columns(df, "勤務表(Excel)")
    return df


def load_kaipoke_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, encoding=CSV_ENCODING)
    df = _rename_by_aliases(df, KAIPOKE_COLUMN_ALIASES)
    _validate_columns(df, "カイポケ(CSV)")
    return df


def _validate_columns(df: pd.DataFrame, label: str) -> None:
    missing = [c for c in STANDARD_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{label}: 必須列がありません: {missing}. 現在の列: {list(df.columns)}")


def _parse_date_series(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, errors="coerce").dt.normalize()


def _combine_date_and_time(date_series: pd.Series, time_series: pd.Series) -> pd.Series:
    """日付列と時刻列から datetime を組み立てる（Excel の日時型・文字列の混在に対応）。"""
    base = pd.to_datetime(date_series, errors="coerce").dt.normalize()
    parsed = pd.to_datetime(time_series, errors="coerce")
    seconds = (
        parsed.dt.hour * 3600
        + parsed.dt.minute * 60
        + parsed.dt.second
        + parsed.dt.microsecond / 1_000_000
    )
    return base + pd.to_timedelta(seconds, unit="s")


@dataclass
class MismatchRow:
    match_key: str
    kind: str
    shift_time: object
    kaipoke_time: object
    delta_seconds: float


def build_match_key(row: pd.Series, use_code: bool) -> str:
    d = pd.to_datetime(row[COL_DATE], errors="coerce")
    ds = d.strftime("%Y-%m-%d") if pd.notna(d) else str(row[COL_DATE])
    if use_code and pd.notna(row[COL_STAFF_CODE]) and str(row[COL_STAFF_CODE]).strip():
        return f"{ds}|{str(row[COL_STAFF_CODE]).strip()}"
    name = str(row[COL_STAFF_NAME]).strip()
    return f"{ds}|{name}"


def prepare_frame(df: pd.DataFrame, *, use_staff_code: bool) -> pd.DataFrame:
    out = df.copy()
    out["_date"] = _parse_date_series(out[COL_DATE])
    out["_start_dt"] = _combine_date_and_time(out["_date"], out[COL_START])
    out["_end_dt"] = _combine_date_and_time(out["_date"], out[COL_END])
    out["_key"] = out.apply(lambda r: build_match_key(r, use_staff_code), axis=1)
    return out


def compare_shift_vs_kaipoke(
    shift: pd.DataFrame,
    kaipoke: pd.DataFrame,
    *,
    use_staff_code: bool,
    threshold_seconds: float = MISMATCH_THRESHOLD_SECONDS,
) -> tuple[pd.DataFrame, list[MismatchRow]]:
    """
    戻り値: (未マッチ行の情報を含む表, ズレ一覧)
    """
    s = prepare_frame(shift, use_staff_code=use_staff_code)
    k = prepare_frame(kaipoke, use_staff_code=use_staff_code)

    for label, frame in (("勤務表", s), ("カイポケ", k)):
        dup = frame["_key"].duplicated(keep=False)
        if dup.any():
            keys = frame.loc[dup, "_key"].unique()[:10]
            raise ValueError(
                f"{label}: 同一キー（日付+スタッフ）の行が複数あります。"
                f" data_preparation.md の粒度を確認してください。例: {list(keys)}"
            )

    merged = s.merge(
        k,
        on="_key",
        how="outer",
        suffixes=("_shift", "_kp"),
        indicator=True,
    )

    mismatches: list[MismatchRow] = []

    for _, row in merged.iterrows():
        key = row["_key"]
        if row["_merge"] == "left_only":
            mismatches.append(
                MismatchRow(
                    match_key=key,
                    kind="行欠落",
                    shift_time=row.get("_start_dt_shift"),
                    kaipoke_time=None,
                    delta_seconds=float("nan"),
                )
            )
            continue
        if row["_merge"] == "right_only":
            mismatches.append(
                MismatchRow(
                    match_key=key,
                    kind="行欠落(カイポケのみ)",
                    shift_time=None,
                    kaipoke_time=row.get("_start_dt_kp"),
                    delta_seconds=float("nan"),
                )
            )
            continue

        for label, col_s, col_k in (
            ("出勤", "_start_dt_shift", "_start_dt_kp"),
            ("退勤", "_end_dt_shift", "_end_dt_kp"),
        ):
            ts = row[col_s]
            tk = row[col_k]
            if pd.isna(ts) and pd.isna(tk):
                continue
            if pd.isna(ts) or pd.isna(tk):
                mismatches.append(
                    MismatchRow(
                        match_key=key,
                        kind=f"{label}(欠損)",
                        shift_time=ts,
                        kaipoke_time=tk,
                        delta_seconds=float("nan"),
                    )
                )
                continue
            delta = abs((ts - tk).total_seconds())
            if delta >= threshold_seconds:
                mismatches.append(
                    MismatchRow(
                        match_key=key,
                        kind=label,
                        shift_time=ts,
                        kaipoke_time=tk,
                        delta_seconds=delta,
                    )
                )

    return merged, mismatches


def format_report(mismatches: list[MismatchRow], *, threshold_seconds: float) -> str:
    if not mismatches:
        return "差分なし（閾値未満のズレおよび欠落行は検出されませんでした）。"
    lines = [f"要確認リスト（閾値: {threshold_seconds}秒以上）", "-" * 60]
    for m in mismatches:
        lines.append(
            f"キー={m.match_key} | {m.kind} | 勤務表={m.shift_time} | カイポケ={m.kaipoke_time} | 差秒={m.delta_seconds}"
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="勤務表とカイポケCSVの実績照合（雛形）")
    parser.add_argument("--shift", type=Path, required=True, help="勤務表 xlsx のパス")
    parser.add_argument("--kaipoke", type=Path, required=True, help="カイポケ CSV のパス")
    parser.add_argument(
        "--by-name-only",
        action="store_true",
        help="スタッフコードを使わず 日付+氏名 で突合する",
    )
    parser.add_argument(
        "--threshold-seconds",
        type=float,
        default=MISMATCH_THRESHOLD_SECONDS,
        help="この秒数以上の差をズレとみなす（既定: 60）",
    )
    args = parser.parse_args()

    shift_df = load_shift_excel(args.shift)
    kaipoke_df = load_kaipoke_csv(args.kaipoke)

    merged, mismatches = compare_shift_vs_kaipoke(
        shift_df,
        kaipoke_df,
        use_staff_code=not args.by_name_only,
        threshold_seconds=args.threshold_seconds,
    )

    print(format_report(mismatches, threshold_seconds=args.threshold_seconds))
    # 雛形: 必要なら CSV 出力
    # out = Path("attendance_mismatches.csv")
    # pd.DataFrame([vars(m) for m in mismatches]).to_csv(out, index=False, encoding="utf-8-sig")
    # print(f"詳細を {out} に出力しました。")


if __name__ == "__main__":
    main()
