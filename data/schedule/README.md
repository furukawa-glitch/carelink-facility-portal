# 訪問予定・ライン表（`data/schedule/`）

**利用者住所・氏名等は Git に含めない。** `_template/` の形式でローカル管理する。

## ファイルの役割

| 種類 | 例 | 用途 |
|------|-----|------|
| 訪問予定 CSV | `visits_20260407.csv` | 日付・担当・利用者・時刻・必要スキル |
| 拠点・利用者座標 | `locations.yaml` | 緯度経度（ライン最適化用。正確な住所原文は別管理） |
| 提案出力 | `operations/` が標準出力 or `--out` で保存 | 人間がカイポケ予定に反映 |

## ライン提案の実行例

```bash
python operations/line_route_propose.py ^
  --visits data/schedule/YOUR_ORG/visits_20260407.csv ^
  --locations data/schedule/YOUR_ORG/locations.yaml ^
  --date 2026-04-07
```

## カイポケ連携

中間フォーマットは `integrations/kaipoke_operations_sync.schema.yaml` を正とする。  
取り込み時は列名エイリアスを事業所の CSV に合わせて拡張する。
