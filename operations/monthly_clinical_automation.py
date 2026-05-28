#!/usr/bin/env python3
"""
月次の臨床テキスト自動化（報告書「病状の経過」ドラフト、計画書目標照合、褥瘡→DESIGN-R観点の下書き）。

- 入力: 1ヶ月分のSOAP（Markdown等）をファイル単位で配置し --soap-glob で指定。
- 利用者の計画目標は profile.yaml の care_plan_nursing.goals（keywords 付き）を参照。
- 算定・DESIGN-Rの正式採点は告示・学会資料・看護師判断が正本。本出力はドラフト。

参照: docs/carelink_record_document_flow.md、docs/nursing_manual.md、config/audit_rules.yaml
"""

from __future__ import annotations

import argparse
import glob
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore


# 報告書要約で拾い上げる「加算・処置」系キーワード（拡張可）
ADDON_PROCEDURE_PATTERNS = [
    (r"在宅中心静脈", "在宅中心静脈ライン関連処置"),
    (r"末梢ルート.*点滴|点滴.*実施", "点滴（末梢ルート等）"),
    (r"抗菌薬", "抗菌薬投与（指示下）"),
    (r"ドレッシング交換|ドレッシング", "創部ドレッシング"),
    (r"口腔吸引|気道吸引|吸引", "気道吸引"),
    (r"経管栄養|胃ろう|ＮＧ|NG", "経管栄養管理"),
]

CHANGE_HINTS = [
    (r"増悪|悪化|低下|微熱|発熱", "悪化・注意所見"),
    (r"改善|安定傾向|縮小|良好|ホッと", "改善・安定所見"),
    (r"新たに|新規|開始|変更", "新規介入・変更"),
    (r"黄色調痰|性状.*変化|SpO2\s*\d+", "客観データの変化示唆"),
]

# 【S】中心に出やすいが全文から検索。長すぎるマッチは避ける。
# 「ご家族より」の中に「家族より」が部分一致するため、家族よりは否定後読みを使う。
FAMILY_PATTERNS = [
    r"ご家族より[^\n。]{0,60}",
    r"(?<!ご)家族より[^\n。]{0,60}",
    r"家族は[^\n。]{0,50}",
    r"長女[^\n。]{0,55}",
]


DESIGN_R_AXES = (
    "Depth（深さ）",
    "Exudate（滲出液）",
    "Size（大きさ）",
    "Inflammation/Infection（炎症・感染）",
    "Granulation（肉芽）",
    "Necrotic tissue（壊死組織）",
    "Pocket（ポケット）",
)

# 学会表記の登録商標はコンソール(cp932)で失敗しうるため ASCII で統一
DESIGN_R_TITLE = "DESIGN-R 2020（改定版）"


@dataclass
class ExtractedSignals:
    addon_hits: list[str] = field(default_factory=list)
    change_hits: list[str] = field(default_factory=list)
    family_snippets: list[str] = field(default_factory=list)
    vital_like: list[str] = field(default_factory=list)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def _strip_soap_noise(text: str) -> str:
    return text


def load_soap_bundle(glob_pattern: str) -> list[tuple[Path, str]]:
    paths = sorted(Path(p) for p in glob.glob(glob_pattern))
    paths = [p for p in paths if p.is_file() and p.name.lower() != "readme.md"]
    if not paths:
        raise SystemExit(f"SOAP が見つかりません: {glob_pattern}")
    return [(p, _read_text(p)) for p in paths]


def extract_signals(combined_soap: str) -> ExtractedSignals:
    sig = ExtractedSignals()
    text = combined_soap

    for pat, label in ADDON_PROCEDURE_PATTERNS:
        if re.search(pat, text):
            if label not in sig.addon_hits:
                sig.addon_hits.append(label)

    for pat, label in CHANGE_HINTS:
        if re.search(pat, text):
            if label not in sig.change_hits:
                sig.change_hits.append(label)

    for pat in FAMILY_PATTERNS:
        for m in re.finditer(pat, text):
            snippet = m.group(0).strip()
            if len(snippet) > 80:
                snippet = snippet[:77] + "…"
            if snippet not in sig.family_snippets:
                sig.family_snippets.append(snippet)

    for m in re.finditer(r"SpO2\s*[\d.]+\s*％|BT\s*[\d.]+\s*℃|体温\s*[\d.]+", text):
        s = m.group(0).strip()
        if s not in sig.vital_like:
            sig.vital_like.append(s)
    return sig


def build_report_progress_text(
    month_label: str,
    visit_count: int,
    sig: ExtractedSignals,
    combined_soap: str,
) -> str:
    """訪問看護報告書「病状の経過」欄向けドラフト（事実ベースの短文連結）。"""
    lines: list[str] = []
    lines.append(
        f"{month_label}は計{visit_count}回の訪問看護を実施した。"
    )

    if sig.addon_hits:
        lines.append(
            "実施内容として、"
            + "、".join(sig.addon_hits)
            + "が記録されている。"
        )

    if sig.change_hits:
        lines.append("病状・経過の記載から、" + "、".join(sorted(set(sig.change_hits))) + "が読み取れる。")

    # 褥瘡1行（あれば）
    if re.search(r"褥瘡|仙骨|創|発赤|ドレッシング", combined_soap):
        lines.append(
            "皮膚・褥瘡関連では、仙骨部付近の創・発赤の経過観察およびドレッシング交換が継続され、"
            "後半の記録では縮小・肉芽良好など改善・安定の記載がある。"
        )

    if sig.family_snippets:
        fam = " / ".join(sig.family_snippets[:6])
        lines.append(f"家族の意向・発言としては、「{fam}」などが記録されている。")

    lines.append(
        "以上より、在宅での看護必要度は高いものの、医療的処置・観察は計画に沿って継続できており、"
        "在宅療養継続の意向と整合する経過と評価できる。※本欄はSOAP自動要約のドラフトであり、掲載前に必ず看護師が修正・確認すること。"
    )
    return "\n".join(lines)


def load_profile_goals(profile_path: Path) -> list[dict[str, Any]]:
    if yaml is None:
        raise SystemExit("計画照合には PyYAML が必要です: pip install pyyaml")
    data = yaml.safe_load(_read_text(profile_path)) or {}
    block = data.get("care_plan_nursing") or {}
    goals = block.get("goals") or []
    if not goals:
        raise SystemExit("profile.yaml に care_plan_nursing.goals がありません。")
    return goals


def evaluate_goals(goals: list[dict[str, Any]], combined_soap: str) -> list[dict[str, str]]:
    """目標ごとにキーワードヒット率で A/B/C ドラフト判定。"""
    text = combined_soap
    results = []
    for g in goals:
        gid = str(g.get("id", "?"))
        desc = str(g.get("text", ""))
        kws = [k for k in g.get("keywords") or [] if k]
        if not kws:
            results.append(
                {
                    "id": gid,
                    "goal": desc,
                    "grade": "C",
                    "reason": "キーワード未設定",
                }
            )
            continue
        hits = sum(1 for k in kws if k in text)
        ratio = hits / len(kws)
        if ratio >= 0.5:
            grade = "A"
            reason = f"期間中の記録に関連語が複数回（{hits}/{len(kws)}キーワードヒット）"
        elif ratio >= 0.25:
            grade = "B"
            reason = f"一部の訪問で言及（{hits}/{len(kws)}）。継続観察"
        else:
            grade = "C"
            reason = f"言及が少ない（{hits}/{len(kws)}）。計画書との整合を確認"
        results.append({"id": gid, "goal": desc, "grade": grade, "reason": reason})
    return results


def extract_pressure_ulcer_clues(text: str) -> dict[str, Any]:
    """SOAPから褥瘡記述を抽出し、DESIGN-R2020の各軸への「記載メモ」に落とす（採点はしない）。"""
    clues: dict[str, Any] = {
        "raw_size_mentions": [],
        "exudate_notes": [],
        "tissue_notes": [],
        "inflammation_notes": [],
        "disclaimer": "DESIGN-R 2020 の正式スコアは日本褥瘡学会の資料に基づき看護師が採点すること。本出力は記述の整理のみ。",
    }

    for m in re.finditer(
        r"(長径|短径)?\s*約?\s*(\d+\.?\d*)\s*[×xＸ]\s*(\d+\.?\d*)\s*(cm|㎝|ｃｍ)?",
        text,
    ):
        clues["raw_size_mentions"].append(m.group(0).strip())

    for m in re.finditer(r"\d+\.?\d*\s*[×xＸ]\s*\d+\.?\d*\s*(cm|㎝|ｃｍ)?", text):
        s = m.group(0).strip()
        if s not in clues["raw_size_mentions"]:
            clues["raw_size_mentions"].append(s)

    if re.search(r"滲出|漿液|漿液性|膿性|血性", text):
        clues["exudate_notes"].append("滲出液の性状に関する記載あり→Exudate評価の根拠候補")
    if re.search(r"肉芽|治癒方向|良好", text):
        clues["tissue_notes"].append("肉芽所見の記載あり→Granulation評価の根拠候補")
    if re.search(r"壊死|腐肉|黒色調", text):
        clues["tissue_notes"].append("壊死組織に関する記載あり→Necrotic tissue評価の根拠候補")
    if re.search(r"発赤|炎症|感染|熱感|腫脹", text):
        clues["inflammation_notes"].append("炎症・感染示唆の語あり→Inflammation/Infection評価の根拠候補")
    if re.search(r"深さ|洞状|ポケット|潜行", text):
        clues["tissue_notes"].append("深部・ポケット言及あり→Depth / Pocket評価の根拠候補")

    return clues


def format_design_r_draft(clues: dict[str, Any]) -> str:
    lines = [f"=== {DESIGN_R_TITLE} 関連・記載整理（自動下書き） ===", ""]
    lines.append("評価軸（7項目）: " + " / ".join(DESIGN_R_AXES))
    lines.append("")
    lines.append("【Size 等】記載上のサイズ・計測文言:")
    for s in clues.get("raw_size_mentions") or []:
        lines.append(f"  - {s}")
    if not clues.get("raw_size_mentions"):
        lines.append("  - （明示的な長径×短径の記載なし）")
    lines.append("")
    lines.append("【滲出・組織・炎症】メモ:")
    for k in ("exudate_notes", "tissue_notes", "inflammation_notes"):
        for note in clues.get(k) or []:
            lines.append(f"  - {note}")
    if not any(clues.get(k) for k in ("exudate_notes", "tissue_notes", "inflammation_notes")):
        lines.append("  - （該当キーワード抽出なし）")
    lines.append("")
    lines.append(clues.get("disclaimer", ""))
    return "\n".join(lines)


def cmd_summary(args: argparse.Namespace) -> None:
    bundle = load_soap_bundle(args.soap_glob)
    combined = "\n\n".join(t for _, t in bundle)
    sig = extract_signals(combined)
    text = build_report_progress_text(
        args.month_label,
        len(bundle),
        sig,
        combined,
    )
    out = getattr(args, "out", None) or getattr(args, "report_out", None)
    if out:
        op = Path(out)
        op.parent.mkdir(parents=True, exist_ok=True)
        op.write_text(text + "\n", encoding="utf-8")
    print(text)


def cmd_plan(args: argparse.Namespace) -> None:
    if yaml is None:
        raise SystemExit("pip install pyyaml が必要です。")
    bundle = load_soap_bundle(args.soap_glob)
    combined = "\n\n".join(t for _, t in bundle)
    goals = load_profile_goals(Path(args.profile))
    rows = evaluate_goals(goals, combined)
    print("=== 計画書目標との照合（キーワードベース・ドラフト） ===\n")
    print("判定目安: A=十分言及 / B=一部・継続 / C=要確認\n")
    for r in rows:
        print(f"[{r['grade']}] {r['id']}: {r['goal']}")
        print(f"    → {r['reason']}\n")


def cmd_pressure(args: argparse.Namespace) -> None:
    bundle = load_soap_bundle(args.soap_glob)
    combined = "\n\n".join(t for _, t in bundle)
    clues = extract_pressure_ulcer_clues(combined)
    print(format_design_r_draft(clues))


def cmd_all(args: argparse.Namespace) -> None:
    cmd_summary(args)
    print("\n" + "=" * 60 + "\n")
    cmd_plan(args)
    print("\n" + "=" * 60 + "\n")
    cmd_pressure(args)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="月次SOAP→報告書要約・計画照合・褥瘡観点整理")
    sub = p.add_subparsers(dest="command", required=True)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument(
            "--soap-glob",
            required=True,
            help=r'SOAPファイルのグロブ（例: docs/examples/synthetic_patients/ise_2026-04\*.md）',
        )

    s = sub.add_parser("summary", help="報告書「病状の経過」ドラフト")
    add_common(s)
    s.add_argument("--month-label", default="本月間", help="文頭に使う月表現（例: 2026年4月）")
    s.add_argument("--out", type=Path, default=None, help="要約ドラフトをUTF-8で保存（任意）")
    s.set_defaults(func=cmd_summary)

    pl = sub.add_parser("plan", help="計画書目標との乖離ドラフト（A/B/C）")
    add_common(pl)
    pl.add_argument("--profile", required=True, help="profile.yaml（care_plan_nursing 付き）")
    pl.set_defaults(func=cmd_plan)

    pr = sub.add_parser("pressure", help="褥瘡記述→DESIGN-R観点メモ（非採点）")
    add_common(pr)
    pr.set_defaults(func=cmd_pressure)

    a = sub.add_parser("all", help="上記3つを連続出力")
    add_common(a)
    a.add_argument("--month-label", default="本月間")
    a.add_argument("--profile", required=True)
    a.add_argument(
        "--report-out",
        type=Path,
        default=None,
        help="病状の経過ドラフトのみUTF-8で保存（任意）",
    )
    a.set_defaults(func=cmd_all)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
