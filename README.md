# 市外局番クイズ

市外局番の頭3桁（0AB）を見て、そのエリアを日本地図から選ぶクイズ。10問1セット。
スマホ（縦並び）と PC（地図＋サイドパネル）でレイアウトが切り替わる。

## 遊び方

1. 表示された市外局番（例: `045`）のエリアを地図でタップ
2. 「これで決定！」で回答
3. 回答後はほかのエリアをタップすると、その局番とエリアが見られる
4. 10問終わったら結果表示。間違えた局番だけ復習もできる

地図に地名は出さない。背景タイルは使わず、海は背景色、陸はエリアの塗り、県境は点線（行政区域データから生成）で描いている。

### 苦手克服モード

- 一度でも間違えた局番は「苦手」になり、**2回連続で正解すると克服**
- 苦手克服モードでは、苦手な局番を正解率が低いものほど出やすくして出題。10問に足りない分はまだ出題されていない局番で埋める
- 成績はブラウザ（localStorage）に保存。スタート画面の「成績をリセット」で消せる
- 自己ベストはふつうモードの成績だけを記録

### 閲覧モード

- スタート画面の「市外局番を見る（閲覧モード）」から入る
- 地図上に全エリアの局番を表示（ズームが足りなくて入りきらない小さいエリアは、拡大すると出てくる）
- エリアをタップするか、一覧・検索（局番 / 都道府県 / 市名。例: `45`、`札幌`）から選ぶと、そのエリアの市町村と自分の成績が見られる

## エリアの作り方

- 総務省「市外局番の一覧」（令和8年3月1日現在）の各番号区画を、市外局番の先頭3桁（`03` `04` `06` の2桁局番はそのまま）でまとめて **60エリア** にしている
- 市区町村（政令市は区）単位で割り当て。1つの市町村が複数の局番にまたがる場合は、その市町村の大部分が属する局番に寄せている
- そのため `098`（沖縄＋宮崎・鹿児島の一部）のように飛び地になるエリアもある
- 北方領土は局番が設定されていないため地図に含めていない

## 構成

```
index.html / style.css / app.js   静的サイト本体（Leaflet + topojson-client を CDN から読み込み）
data/areas.js                     生成済みのエリア境界(TopoJSON)とメタ情報
tools/                            データ生成スクリプト
```

## データの再生成

```bash
cd tools
npm install
mkdir -p raw out
curl -L https://www.soumu.go.jp/main_content/000141817.pdf -o raw/list.pdf
curl -L https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/topojson/s0010/N03-21_210101.json -o raw/muni.topo.json
node pdf2txt.mjs          # PDF -> 位置付きテキスト
node build-assign.mjs     # 番号区画を市区町村に割り当て
node -e 'const a=require("./out/assign.json");require("fs").writeFileSync("out/assign.csv","N03_007,ab\n"+Object.entries(a).map(([k,v])=>k+","+v).join("\n"))'
npx mapshaper -i raw/muni.topo.json name=muni -join out/assign.csv keys=N03_007,N03_007 string-fields=N03_007,ab -filter "ab != null" -dissolve ab + name=areas -dissolve N03_001 target=muni + name=prefs -innerlines target=prefs + name=preflines -simplify 40% keep-shapes target=* -o ../data/areas.topo.json format=topojson quantization=20000 target=areas,preflines
node build-meta.mjs       # data/areas.js を出力
```

## 出典

- 市外局番: [総務省「市外局番の一覧」](https://www.soumu.go.jp/main_sosiki/joho_tsusin/top/tel_number/shigai_list.html)
- 行政区域: 国土数値情報（行政区域データ）N03、簡略化版は [smartnews-smri/japan-topography](https://github.com/smartnews-smri/japan-topography)
